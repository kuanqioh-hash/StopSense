#include <Arduino.h>

#if !defined(ARDUINO_ARCH_ESP32)
#error "This experimental occupancy estimate requires an ESP32 hardware UART."
#endif

#ifndef LD2410C_UART_RX_PIN
#define LD2410C_UART_RX_PIN 25
#endif
#ifndef LD2410C_UART_TX_PIN
#define LD2410C_UART_TX_PIN 26
#endif
#ifndef LD2410C_STATUS_LED_PIN
#ifdef LED_BUILTIN
#define LD2410C_STATUS_LED_PIN LED_BUILTIN
#else
#define LD2410C_STATUS_LED_PIN 2
#endif
#endif
#ifndef LD2410C_LED_ACTIVE_LOW
#define LD2410C_LED_ACTIVE_LOW 0
#endif

const uint32_t RADAR_BAUD = 256000;
const unsigned long REPORT_INTERVAL_MS = 5000;
const unsigned long DATA_TIMEOUT_MS = 2000;
const unsigned long LED_STABILITY_MS = 1000;
const uint8_t ACTIVE_GATE_ENERGY_THRESHOLD = 20;
const uint8_t HIGH_GATE_COUNT = 6;
const uint8_t COMMAND_HEADER[] = {0xFD, 0xFC, 0xFB, 0xFA};
const uint8_t COMMAND_END[] = {0x04, 0x03, 0x02, 0x01};
const uint8_t DATA_HEADER[] = {0xF4, 0xF3, 0xF2, 0xF1};
const uint8_t DATA_END[] = {0xF8, 0xF7, 0xF6, 0xF5};
const uint8_t CONFIG_ENABLE_FRAME[] = {
  0xFD, 0xFC, 0xFB, 0xFA, 0x04, 0x00, 0xFF, 0x00, 0x01, 0x00, 0x04, 0x03, 0x02, 0x01
};
const uint8_t ENGINEERING_MODE_FRAME[] = {
  0xFD, 0xFC, 0xFB, 0xFA, 0x02, 0x00, 0x62, 0x00, 0x04, 0x03, 0x02, 0x01
};
const uint8_t END_CONFIG_FRAME[] = {
  0xFD, 0xFC, 0xFB, 0xFA, 0x02, 0x00, 0xFE, 0x00, 0x04, 0x03, 0x02, 0x01
};

HardwareSerial RadarSerial(2);
uint8_t inputBuffer[64];
size_t inputLength = 0;
bool hasEngineeringData = false;
uint8_t currentTargetState = 0;
uint8_t currentActiveGateCount = 0;
unsigned long lastEngineeringDataMs = 0;
unsigned long lastReportMs = 0;
unsigned long ledCandidateSinceMs = 0;
bool statusLedOn = false;
bool ledCandidateOn = false;

bool isFrameEnd(const uint8_t *buffer, size_t offset, const uint8_t *end) {
  for (size_t i = 0; i < 4; ++i) {
    if (buffer[offset + i] != end[i]) return false;
  }
  return true;
}

bool waitForAck(uint16_t command) {
  uint8_t buffer[32];
  size_t used = 0;
  const unsigned long startedAt = millis();

  while (millis() - startedAt < 1500) {
    while (RadarSerial.available()) {
      if (used == sizeof(buffer)) {
        for (size_t i = 1; i < used; ++i) buffer[i - 1] = buffer[i];
        --used;
      }
      buffer[used++] = static_cast<uint8_t>(RadarSerial.read());

      for (size_t start = 0; start + 12 <= used; ++start) {
        bool headerMatches = true;
        for (size_t i = 0; i < sizeof(COMMAND_HEADER); ++i) {
          if (buffer[start + i] != COMMAND_HEADER[i]) headerMatches = false;
        }
        if (!headerMatches) continue;

        const uint16_t dataLength = static_cast<uint16_t>(buffer[start + 4]) |
          (static_cast<uint16_t>(buffer[start + 5]) << 8);
        const size_t frameLength = 4 + 2 + dataLength + 4;
        if (dataLength < 4 || frameLength > sizeof(buffer) || start + frameLength > used) continue;
        const uint16_t responseCommand = command | 0x0100;
        if (buffer[start + 6] != static_cast<uint8_t>(responseCommand & 0xFF) ||
            buffer[start + 7] != static_cast<uint8_t>(responseCommand >> 8)) continue;
        if (!isFrameEnd(buffer, start + frameLength - 4, COMMAND_END)) continue;
        return buffer[start + 8] == 0 && buffer[start + 9] == 0;
      }
    }
    delay(1);
  }
  return false;
}

bool sendCommand(const uint8_t *frame, size_t frameLength, uint16_t command) {
  while (RadarSerial.available()) RadarSerial.read();
  RadarSerial.write(frame, frameLength);
  RadarSerial.flush();
  return waitForAck(command);
}

void discardInput(size_t count) {
  if (count >= inputLength) {
    inputLength = 0;
    return;
  }
  for (size_t i = count; i < inputLength; ++i) inputBuffer[i - count] = inputBuffer[i];
  inputLength -= count;
}

bool hasDataHeader(size_t offset) {
  for (size_t i = 0; i < sizeof(DATA_HEADER); ++i) {
    if (inputBuffer[offset + i] != DATA_HEADER[i]) return false;
  }
  return true;
}

void processEngineeringFrame(const uint8_t *payload, size_t length) {
  if (length < 13 || payload[0] != 0x01 || payload[1] != 0xAA) return;

  const uint8_t motionGateCount = payload[11] + 1;
  const uint8_t stationaryGateCount = payload[12] + 1;
  const size_t motionStart = 13;
  const size_t stationaryStart = motionStart + motionGateCount;
  if (motionGateCount > 9 || stationaryGateCount > 9 ||
      stationaryStart + stationaryGateCount > length) return;

  uint8_t activeGates = 0;
  for (uint8_t gate = 0; gate < 9; ++gate) {
    const bool motionActive = gate < motionGateCount &&
      payload[motionStart + gate] >= ACTIVE_GATE_ENERGY_THRESHOLD;
    const bool stationaryActive = gate < stationaryGateCount &&
      payload[stationaryStart + gate] >= ACTIVE_GATE_ENERGY_THRESHOLD;
    if (motionActive || stationaryActive) ++activeGates;
  }

  currentTargetState = payload[2];
  currentActiveGateCount = activeGates;
  lastEngineeringDataMs = millis();
  hasEngineeringData = true;
}

void readRadarFrames() {
  while (RadarSerial.available()) {
    if (inputLength == sizeof(inputBuffer)) discardInput(1);
    inputBuffer[inputLength++] = static_cast<uint8_t>(RadarSerial.read());

    for (;;) {
      size_t headerOffset = 0;
      while (headerOffset + 4 <= inputLength && !hasDataHeader(headerOffset)) ++headerOffset;
      if (headerOffset > 0) discardInput(headerOffset);
      if (inputLength < 6) break;

      const uint16_t payloadLength = static_cast<uint16_t>(inputBuffer[4]) |
        (static_cast<uint16_t>(inputBuffer[5]) << 8);
      const size_t frameLength = 4 + 2 + payloadLength + 4;
      if (payloadLength > sizeof(inputBuffer) - 10) {
        discardInput(1);
        continue;
      }
      if (inputLength < frameLength) break;
      if (isFrameEnd(inputBuffer, frameLength - 4, DATA_END)) {
        processEngineeringFrame(inputBuffer + 6, payloadLength);
        discardInput(frameLength);
      } else {
        discardInput(1);
      }
    }
  }
}

void updateStatusLed() {
  const unsigned long now = millis();
  const bool dataIsFresh = hasEngineeringData && now - lastEngineeringDataMs <= DATA_TIMEOUT_MS;
  const bool requestedLedOn = dataIsFresh && currentTargetState != 0 &&
    currentActiveGateCount >= HIGH_GATE_COUNT;

  if (!dataIsFresh) {
    ledCandidateOn = false;
    ledCandidateSinceMs = now;
    statusLedOn = false;
  } else {
    if (requestedLedOn != ledCandidateOn) {
      ledCandidateOn = requestedLedOn;
      ledCandidateSinceMs = now;
    }
    if (requestedLedOn != statusLedOn && now - ledCandidateSinceMs >= LED_STABILITY_MS) {
      statusLedOn = requestedLedOn;
    }
  }

  const uint8_t ledLevel = (statusLedOn != (LD2410C_LED_ACTIVE_LOW != 0)) ? HIGH : LOW;
  digitalWrite(LD2410C_STATUS_LED_PIN, ledLevel);
}

void reportEstimate() {
  const unsigned long now = millis();
  if (now - lastReportMs < REPORT_INTERVAL_MS) return;
  lastReportMs = now;

  if (!hasEngineeringData || now - lastEngineeringDataMs > DATA_TIMEOUT_MS) {
    Serial.println("LD2410C_ESTIMATE,NO_DATA");
    return;
  }

  if (currentTargetState == 0) {
    Serial.println("LD2410C_ESTIMATE,EMPTY,active_gates=0");
  } else if (currentActiveGateCount >= HIGH_GATE_COUNT) {
    Serial.print("LD2410C_ESTIMATE,HIGH,active_gates=");
    Serial.println(currentActiveGateCount);
  } else {
    Serial.print("LD2410C_ESTIMATE,LOW,active_gates=");
    Serial.println(currentActiveGateCount);
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(LD2410C_STATUS_LED_PIN, OUTPUT);
  updateStatusLed();
  RadarSerial.begin(RADAR_BAUD, SERIAL_8N1, LD2410C_UART_RX_PIN, LD2410C_UART_TX_PIN);
  delay(500);
  Serial.println("Experimental LD2410C occupancy estimate; not a people counter.");

  if (!sendCommand(CONFIG_ENABLE_FRAME, sizeof(CONFIG_ENABLE_FRAME), 0x00FF)) {
    Serial.println("LD2410C_ESTIMATE,NO_DATA (configuration enable failed; check UART wiring and 256000 baud)");
    return;
  }

  const bool engineeringEnabled = sendCommand(
    ENGINEERING_MODE_FRAME, sizeof(ENGINEERING_MODE_FRAME), 0x0062
  );
  const bool configurationEnded = sendCommand(
    END_CONFIG_FRAME, sizeof(END_CONFIG_FRAME), 0x00FE
  );
  if (!engineeringEnabled || !configurationEnded) {
    Serial.println("LD2410C_ESTIMATE,NO_DATA (engineering mode setup failed; check UART wiring)");
    return;
  }

  Serial.print("UART RX GPIO");
  Serial.print(LD2410C_UART_RX_PIN);
  Serial.print(", TX GPIO");
  Serial.println(LD2410C_UART_TX_PIN);
  Serial.println("Heuristic: active target with fewer than 6 active gates is LOW; 6+ is HIGH.");
}

void loop() {
  readRadarFrames();
  updateStatusLed();
  reportEstimate();
  delay(1);
}
