#if defined(ARDUINO_ARCH_ESP32)
#ifndef LD2410C_OUT_PIN
#define LD2410C_OUT_PIN 27
#endif
#else
#ifndef LD2410C_OUT_PIN
#define LD2410C_OUT_PIN 2
#endif
#endif

#ifndef LD2410C_LED_ACTIVE_LOW
#define LD2410C_LED_ACTIVE_LOW 0
#endif

const unsigned long SERIAL_BAUD = 115200;
const unsigned long REPORT_INTERVAL_MS = 5000;
int lastPresenceState = -1;
unsigned long lastReportMs = 0;
bool hasReported = false;

void setPresenceLed(bool present) {
#if defined(LED_BUILTIN)
  const uint8_t ledLevel = present ? HIGH : LOW;
  digitalWrite(LED_BUILTIN, LD2410C_LED_ACTIVE_LOW ? !ledLevel : ledLevel);
#else
  (void)present;
#endif
}

void setup() {
  pinMode(LD2410C_OUT_PIN, INPUT);
#if defined(LED_BUILTIN)
  pinMode(LED_BUILTIN, OUTPUT);
  setPresenceLed(false);
#endif
  Serial.begin(SERIAL_BAUD);
  delay(250);
  Serial.println("LD2410C monitor ready");
  Serial.print("OUT pin: ");
  Serial.println(LD2410C_OUT_PIN);
}

void loop() {
  const unsigned long now = millis();
  const int presenceState = digitalRead(LD2410C_OUT_PIN) == HIGH ? 1 : 0;
  if (presenceState != lastPresenceState) {
    lastPresenceState = presenceState;
    setPresenceLed(presenceState == 1);
  }

  if (!hasReported || now - lastReportMs >= REPORT_INTERVAL_MS) {
    Serial.println(presenceState ? "LD2410C,PRESENT" : "LD2410C,CLEAR");
    lastReportMs = now;
    hasReported = true;
  }
  delay(50);
}
