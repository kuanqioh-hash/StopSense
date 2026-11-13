
const int solarPin = A0;

const float referenceVoltage = 5.0;
const float dividerRatio = 2.0;

// Adjustable voltage thresholds
const float noOutputThreshold = 0.2;
const float lowOutputThreshold = 1.0;
const float normalOutputThreshold = 2.5;

void setup() {
  Serial.begin(9600);
  Serial.println("Solar Panel Monitoring System");
  Serial.println("--------------------------------");
}

void loop() {

  // Average 10 ADC readings
  long totalReading = 0;

  for (int i = 0; i < 10; i++) {
    totalReading += analogRead(solarPin);
    delay(10);
  }

  float averageReading = totalReading / 10.0;

  // Calculate actual solar panel voltage
  float voltageAtA0 =
    averageReading * (referenceVoltage / 1023.0);

  float solarVoltage =
    voltageAtA0 * dividerRatio;

  // Display voltage
  Serial.print("Solar Panel Voltage: ");
  Serial.print(solarVoltage, 2);
  Serial.println(" V");

  // Detect operating condition
  if (solarVoltage < noOutputThreshold) {

    Serial.println("STATUS: NO OUTPUT DETECTED");

  } 
  else if (solarVoltage < lowOutputThreshold) {

    Serial.println("STATUS: LOW OUTPUT");

  } 
  else if (solarVoltage < normalOutputThreshold) {

    Serial.println("STATUS: GENERATING ELECTRICITY");

  } 
  else {

    Serial.println("STATUS: VOLTAGE NEAR RATED LEVEL");

  }

  Serial.println("--------------------------------");

  delay(1000);
}
