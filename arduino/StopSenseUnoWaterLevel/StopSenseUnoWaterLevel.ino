#include <Adafruit_SHT31.h>
#include <Arduino.h>
#include <Wire.h>
#include <math.h>

const uint8_t LD2410C_OUT_PIN = 2;
const uint8_t SOLAR_VOLTAGE_PIN = A0;
const uint8_t WATER_LEVEL_PIN = A1;
const uint8_t STATUS_LED_PIN = LED_BUILTIN;
const uint8_t SHT31_I2C_ADDRESS = 0x44;
const uint32_t USB_SERIAL_BAUD = 115200;
const unsigned long REPORT_INTERVAL_MS = 5000;

// Calibrate these from the raw water-sensor readings in the Serial Monitor.
const int WATER_LEVEL_EMPTY_ADC = 0;
const int WATER_LEVEL_FULL_ADC = 1023;
const float SOLAR_REFERENCE_VOLTAGE = 5.0;
const float SOLAR_DIVIDER_RATIO = 2.0;

Adafruit_SHT31 sht31;
bool sht31Ready = false;
unsigned long lastReportMs = 0;

int readAverage(uint8_t pin) {
  long total = 0;
  for (uint8_t sample = 0; sample < 10; ++sample) {
    total += analogRead(pin);
    delay(2);
  }
  return static_cast<int>(total / 10);
}

float readWaterLevelPercent() {
  const int raw = readAverage(WATER_LEVEL_PIN);
  Serial.print("Water sensor raw ADC: ");
  Serial.println(raw);

  if (WATER_LEVEL_FULL_ADC == WATER_LEVEL_EMPTY_ADC) return 0.0;
  const long level = map(raw, WATER_LEVEL_EMPTY_ADC, WATER_LEVEL_FULL_ADC, 0, 100);
  return constrain(level, 0, 100);
}

float readSolarVoltage() {
  const int raw = readAverage(SOLAR_VOLTAGE_PIN);
  const float voltageAtPin = raw * (SOLAR_REFERENCE_VOLTAGE / 1023.0);
  return voltageAtPin * SOLAR_DIVIDER_RATIO;
}

void reportTelemetry() {
  const unsigned long now = millis();
  if (now - lastReportMs < REPORT_INTERVAL_MS) return;
  lastReportMs = now;

  const float waterLevelPct = readWaterLevelPercent();
  const float solarVoltage = readSolarVoltage();

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
  Serial.print(digitalRead(LD2410C_OUT_PIN) == HIGH ? "High" : "Low");
  Serial.print(',');
  Serial.println(waterLevelPct, 1);

  Serial.print("Solar Panel Voltage: ");
  Serial.print(solarVoltage, 2);
  Serial.println(" V");
}

void setup() {
  Serial.begin(USB_SERIAL_BAUD);
  pinMode(LD2410C_OUT_PIN, INPUT);
  pinMode(STATUS_LED_PIN, OUTPUT);
  Wire.begin();
  sht31Ready = sht31.begin(SHT31_I2C_ADDRESS);
  delay(500);

  Serial.println("StopSense Uno water-level sketch ready.");
  Serial.println("Serial records: STOPSENSE,temp_c,humidity_pct,crowd_level,water_level_pct");
  Serial.println("Solar voltage is also reported from A0.");
  Serial.print("Water sensor analog pin: A1; calibrate empty/full ADC values (currently ");
  Serial.print(WATER_LEVEL_EMPTY_ADC);
  Serial.print('/');
  Serial.print(WATER_LEVEL_FULL_ADC);
  Serial.println(").");
  if (!sht31Ready) Serial.println("SHT31 not found; will retry on each report.");
}

void loop() {
  const bool presenceDetected = digitalRead(LD2410C_OUT_PIN) == HIGH;
  digitalWrite(STATUS_LED_PIN, presenceDetected ? HIGH : LOW);
  reportTelemetry();
  delay(1);
}
