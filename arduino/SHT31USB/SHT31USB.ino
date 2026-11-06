#include <Adafruit_SHT31.h>
#include <Wire.h>

#define SHT31_I2C_ADDRESS 0x44

#if defined(ARDUINO_ARCH_ESP32)
#ifndef SHT31_SDA_PIN
#define SHT31_SDA_PIN 21
#endif
#ifndef SHT31_SCL_PIN
#define SHT31_SCL_PIN 22
#endif
#endif

const unsigned long READ_INTERVAL_MS = 5000;
Adafruit_SHT31 sht31 = Adafruit_SHT31();
unsigned long lastReadMs = 0;
bool sensorReady = false;

void setup() {
  Serial.begin(115200);
#if defined(ARDUINO_ARCH_ESP32)
  Wire.begin(SHT31_SDA_PIN, SHT31_SCL_PIN);
#else
  Wire.begin();
#endif
  sensorReady = sht31.begin(SHT31_I2C_ADDRESS);

  if (!sensorReady) {
    Serial.println("SHT31,ERROR,not_found");
  }
}

void loop() {
  const unsigned long now = millis();
  if (now - lastReadMs < READ_INTERVAL_MS) {
    return;
  }
  lastReadMs = now;

  if (!sensorReady) {
    sensorReady = sht31.begin(SHT31_I2C_ADDRESS);
    if (!sensorReady) {
      Serial.println("SHT31,ERROR,not_found");
      return;
    }
  }

  const float temperatureC = sht31.readTemperature();
  const float humidityPct = sht31.readHumidity();
  if (isnan(temperatureC) || isnan(humidityPct)) {
    Serial.println("SHT31,ERROR,read_failed");
    return;
  }

  Serial.print("SHT31,");
  Serial.print(temperatureC, 2);
  Serial.print(',');
  Serial.println(humidityPct, 2);
}
