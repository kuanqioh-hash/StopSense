#include <Arduino.h>

#if !defined(ARDUINO_ARCH_ESP32)
#error "This one-time LD2410C range configurator requires an ESP32 hardware UART."
#endif

#ifndef LD2410C_UART_RX_PIN
#define LD2410C_UART_RX_PIN 25
#endif
#ifndef LD2410C_UART_TX_PIN
#define LD2410C_UART_TX_PIN 26
#endif

const uint32_t RADAR_BAUD = 256000;
const uint8_t FRAME_HEADER[] = {0xFD, 0xFC, 0xFB, 0xFA};
const uint8_t FRAME_END[] = {0x04, 0x03, 0x02, 0x01};
const uint8_t CONFIG_ENABLE_FRAME[] = {
  0xFD, 0xFC, 0xFB, 0xFA, 0x04, 0x00, 0xFF, 0x00, 0x01, 0x00, 0x04, 0x03, 0x02, 0x01
};
const uint8_t READ_PARAMETERS_FRAME[] = {
  0xFD, 0xFC, 0xFB, 0xFA, 0x02, 0x00, 0x61, 0x00, 0x04, 0x03, 0x02, 0x01
};
const uint8_t END_CONFIG_FRAME[] = {
  0xFD, 0xFC, 0xFB, 0xFA, 0x02, 0x00, 0xFE, 0x00, 0x04, 0x03, 0x02, 0x01
};
const uint8_t SET_RANGE_FRAME[] = {
  0xFD, 0xFC, 0xFB, 0xFA, 0x14, 0x00, 0x60, 0x00,
  0x00, 0x00, 0x02, 0x00, 0x00, 0x00,
  0x01, 0x00, 0x02, 0x00, 0x00, 0x00,
  0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x04, 0x03, 0x02, 0x01
};

HardwareSerial RadarSerial(2);

bool waitForAck(uint16_t command, uint8_t *payload, size_t payloadCapacity, size_t &payloadLength) {
  uint8_t buffer[64];
  size_t used = 0;
  const unsigned long startedAt = millis();
  payloadLength = 0;

  while (millis() - startedAt < 1500) {
    while (RadarSerial.available()) {
      if (used == sizeof(buffer)) {
        for (size_t i = 1; i < used; ++i) buffer[i - 1] = buffer[i];
        --used;
      }
      buffer[used++] = static_cast<uint8_t>(RadarSerial.read());

      for (size_t start = 0; start + 10 <= used; ++start) {
        bool headerMatches = true;
        for (size_t i = 0; i < sizeof(FRAME_HEADER); ++i) {
          if (buffer[start + i] != FRAME_HEADER[i]) headerMatches = false;
        }
        if (!headerMatches || start + 8 > used) continue;

        const uint16_t dataLength = static_cast<uint16_t>(buffer[start + 4]) |
          (static_cast<uint16_t>(buffer[start + 5]) << 8);
        const size_t frameLength = 4 + 2 + dataLength + sizeof(FRAME_END);
        if (dataLength < 4 || frameLength > sizeof(buffer) || start + frameLength > used) continue;
        const uint16_t responseCommand = command | 0x0100;
        if (buffer[start + 6] != static_cast<uint8_t>(responseCommand & 0xFF) ||
            buffer[start + 7] != static_cast<uint8_t>(responseCommand >> 8)) continue;

        bool endMatches = true;
        for (size_t i = 0; i < sizeof(FRAME_END); ++i) {
          if (buffer[start + frameLength - sizeof(FRAME_END) + i] != FRAME_END[i]) endMatches = false;
        }
        if (!endMatches) continue;

        payloadLength = dataLength - 2;
        if (payloadLength > payloadCapacity || payloadLength < 2) return false;
        for (size_t i = 0; i < payloadLength; ++i) payload[i] = buffer[start + 8 + i];
        return payload[0] == 0 && payload[1] == 0;
      }
    }
    delay(1);
  }
  return false;
}

bool sendAndCheck(const uint8_t *frame, size_t frameLength, uint16_t command, uint8_t *payload, size_t payloadCapacity, size_t &payloadLength) {
  while (RadarSerial.available()) RadarSerial.read();
  RadarSerial.write(frame, frameLength);
  RadarSerial.flush();
  return waitForAck(command, payload, payloadCapacity, payloadLength);
}

void setup() {
  Serial.begin(115200);
  RadarSerial.begin(RADAR_BAUD, SERIAL_8N1, LD2410C_UART_RX_PIN, LD2410C_UART_TX_PIN);
  delay(500);
  Serial.println("LD2410C range setup: setting motion and stationary limits to 1.5 m.");

  uint8_t response[32];
  size_t responseLength = 0;
  bool configEnabled = sendAndCheck(
    CONFIG_ENABLE_FRAME, sizeof(CONFIG_ENABLE_FRAME), 0x00FF,
    response, sizeof(response), responseLength
  );
  if (!configEnabled) {
    Serial.println("Could not enable configuration. Check power, UART wiring, pins, and 256000 baud.");
    return;
  }

  bool parametersRead = sendAndCheck(
    READ_PARAMETERS_FRAME, sizeof(READ_PARAMETERS_FRAME), 0x0061,
    response, sizeof(response), responseLength
  );
  if (!parametersRead || responseLength < 26) {
    Serial.println("Could not read current settings; range was not changed.");
    sendAndCheck(END_CONFIG_FRAME, sizeof(END_CONFIG_FRAME), 0x00FE, response, sizeof(response), responseLength);
    return;
  }

  const uint16_t noPresenceSeconds = static_cast<uint16_t>(response[24]) |
    (static_cast<uint16_t>(response[25]) << 8);
  uint8_t setRangeFrame[sizeof(SET_RANGE_FRAME)];
  for (size_t i = 0; i < sizeof(SET_RANGE_FRAME); ++i) setRangeFrame[i] = SET_RANGE_FRAME[i];
  setRangeFrame[22] = static_cast<uint8_t>(noPresenceSeconds & 0xFF);
  setRangeFrame[23] = static_cast<uint8_t>((noPresenceSeconds >> 8) & 0xFF);
  setRangeFrame[24] = 0;
  setRangeFrame[25] = 0;

  const bool rangeSet = sendAndCheck(
    setRangeFrame, sizeof(setRangeFrame), 0x0060,
    response, sizeof(response), responseLength
  );
  const bool configEnded = sendAndCheck(
    END_CONFIG_FRAME, sizeof(END_CONFIG_FRAME), 0x00FE,
    response, sizeof(response), responseLength
  );

  if (rangeSet && configEnded) {
    Serial.println("Success: both range limits set to gate 2 (~1.5 m); no-presence delay preserved.");
    Serial.println("This setting is stored in the sensor. Power off, disconnect UART, then upload LD2410C.ino to monitor OUT.");
  } else {
    Serial.println("Range setup was not confirmed. Check UART wiring and rerun this sketch.");
  }
}

void loop() {
  delay(1000);
}
