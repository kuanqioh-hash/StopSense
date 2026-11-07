#include <Adafruit_SHT31.h>
#include <Arduino.h>
#include <Wire.h>
#include <math.h>

#if !defined(ARDUINO_ARCH_ESP32) && !defined(ARDUINO_ARCH_AVR)
#error "The combined StopSense sensor sketch supports ESP32 or AVR Arduino boards such as Uno."
#endif

#if defined(ARDUINO_ARCH_ESP32)
#ifndef SHT31_SDA_PIN
#define SHT31_SDA_PIN 35
#endif
#ifndef SHT31_SCL_PIN
#define SHT31_SCL_PIN 32
#endif
#ifndef LD2410C_UART_RX_PIN
#define LD2410C_UART_RX_PIN 25
#endif
#ifndef LD2410C_UART_TX_PIN
#define LD2410C_UART_TX_PIN 26
#endif
#else
#ifndef SHT31_SDA_PIN
#define SHT31_SDA_PIN A4
#endif
#ifndef SHT31_SCL_PIN
#define SHT31_SCL_PIN A5
#endif
#ifndef LD2410C_OUT_PIN
#define LD2410C_OUT_PIN 2
#endif
#endif
#ifndef STOPSENSE_STATUS_LED_PIN
#ifdef LED_BUILTIN
#define STOPSENSE_STATUS_LED_PIN LED_BUILTIN
#elif defined(ARDUINO_ARCH_ESP32)
#define STOPSENSE_STATUS_LED_PIN 2
#else
#define STOPSENSE_STATUS_LED_PIN 13
#endif
#endif
#ifndef STOPSENSE_LED_ACTIVE_LOW
#define STOPSENSE_LED_ACTIVE_LOW 0
#endif

const uint8_t SHT31_I2C_ADDRESS = 0x44;
const uint32_t USB_SERIAL_BAUD = 115200;
const unsigned long REPORT_INTERVAL_MS = 5000;

#if defined(ARDUINO_ARCH_ESP32)
const uint32_t RADAR_BAUD = 256000;
const unsigned long RADAR_TIMEOUT_MS = 2000;
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
#endif

Adafruit_SHT31 sht31;
bool sht31Ready = false;
unsigned long lastReportMs = 0;
#if defined(ARDUINO_ARCH_ESP32)
HardwareSerial RadarSerial(2);
uint8_t inputBuffer[64];
size_t inputLength = 0;
bool radarReady = false;
bool hasRadarData = false;
uint8_t targetState = 0;
uint8_t activeGateCount = 0;
unsigned long lastRadarDataMs = 0;
unsigned long ledCandidateSinceMs = 0;
bool statusLedOn = false;
bool ledCandidateOn = false;
#else
bool unoPresence = false;
#endif

#if defined(ARDUINO_ARCH_ESP32)
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

  targetState = payload[2];
  activeGateCount = activeGates;
  lastRadarDataMs = millis();
  hasRadarData = true;
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

bool radarDataIsFresh(unsigned long now) {
  return radarReady && hasRadarData && now - lastRadarDataMs <= RADAR_TIMEOUT_MS;
}

bool radarIsHigh(unsigned long now) {
  return radarDataIsFresh(now) && targetState != 0 && activeGateCount >= HIGH_GATE_COUNT;
}

void updateStatusLed() {
  const unsigned long now = millis();
  const bool dataIsFresh = radarDataIsFresh(now);
  const bool requestedLedOn = radarIsHigh(now);

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

  const uint8_t ledLevel = (statusLedOn != (STOPSENSE_LED_ACTIVE_LOW != 0)) ? HIGH : LOW;
  digitalWrite(STOPSENSE_STATUS_LED_PIN, ledLevel);
}

const char *getCrowdLevel(unsigned long now) {
  if (!radarDataIsFresh(now)) return "Unknown";
  if (targetState == 0) return "Low";
  return activeGateCount >= HIGH_GATE_COUNT ? "High" : "Moderate";
}
#else
void updateStatusLed() {
  const uint8_t ledLevel = unoPresence ? HIGH : LOW;
  digitalWrite(STOPSENSE_STATUS_LED_PIN,
    (ledLevel != (STOPSENSE_LED_ACTIVE_LOW != 0)) ? HIGH : LOW);
}

const char *getCrowdLevel(unsigned long now) {
  (void)now;
  return unoPresence ? "High" : "Low";
}
#endif

void reportTelemetry() {
  const unsigned long now = millis();
  if (now - lastReportMs < REPORT_INTERVAL_MS) return;
  lastReportMs = now;

  if (!sht31Ready) sht31Ready = sht31.begin(SHT31_I2C_ADDRESS);
  if (!sht31Ready) {
    Serial.println("STOPSENSE,ERROR,sht31_not_found");
    return;
  }

  const float temperatureC = sht31.readTemperature();
  const float humidityPct = sht31.readHumidity();
  if (isnan(temperatureC) || isnan(humidityPct)) {
    Serial.println("STOPSENSE,ERROR,sht31_read_failed");
    sht31Ready = false;
    return;
  }

  Serial.print("STOPSENSE,");
  Serial.print(temperatureC, 2);
  Serial.print(',');
  Serial.print(humidityPct, 2);
  Serial.print(',');
  Serial.println(getCrowdLevel(now));
}

void setup() {
  Serial.begin(USB_SERIAL_BAUD);
  pinMode(STOPSENSE_STATUS_LED_PIN, OUTPUT);
#if defined(ARDUINO_ARCH_ESP32)
  Wire.begin(SHT31_SDA_PIN, SHT31_SCL_PIN);
  RadarSerial.begin(RADAR_BAUD, SERIAL_8N1, LD2410C_UART_RX_PIN, LD2410C_UART_TX_PIN);
#else
  // Uno uses fixed SDA/SCL pins A4/A5; LD2410C presence is read from its digital OUT pin.
  pinMode(LD2410C_OUT_PIN, INPUT);
  Wire.begin();
#endif
  sht31Ready = sht31.begin(SHT31_I2C_ADDRESS);
  delay(500);

  if (!sht31Ready) Serial.println("SHT31 not found; will retry on each report.");

#if defined(ARDUINO_ARCH_ESP32)
  const bool configEnabled = sendCommand(CONFIG_ENABLE_FRAME, sizeof(CONFIG_ENABLE_FRAME), 0x00FF);
  if (configEnabled) {
    const bool engineeringEnabled = sendCommand(
      ENGINEERING_MODE_FRAME, sizeof(ENGINEERING_MODE_FRAME), 0x0062
    );
    const bool configurationEnded = sendCommand(
      END_CONFIG_FRAME, sizeof(END_CONFIG_FRAME), 0x00FE
    );
    radarReady = engineeringEnabled && configurationEnded;
  }

  if (!radarReady) {
    Serial.println("LD2410C UART setup failed; crowd level will be Unknown until reboot and successful setup.");
  }
  Serial.println("StopSense ESP32 ready; serial records: STOPSENSE,temp_c,humidity_pct,crowd_level");
  Serial.print("SHT31 SDA/SCL GPIO: ");
  Serial.print(SHT31_SDA_PIN);
  Serial.print('/');
  Serial.println(SHT31_SCL_PIN);
  Serial.print("LD2410C UART RX/TX GPIO: ");
  Serial.print(LD2410C_UART_RX_PIN);
  Serial.print('/');
  Serial.println(LD2410C_UART_TX_PIN);
#else
  Serial.println("StopSense Uno ready; SHT31 uses I2C on A4/A5.");
  Serial.println("Serial records: STOPSENSE,temp_c,humidity_pct,crowd_level");
  Serial.print("LD2410C OUT pin: ");
  Serial.println(LD2410C_OUT_PIN);
#endif
}

void loop() {
#if defined(ARDUINO_ARCH_ESP32)
  readRadarFrames();
#else
  unoPresence = digitalRead(LD2410C_OUT_PIN) == HIGH;
#endif
  updateStatusLed();
  reportTelemetry();
  delay(1);
}
