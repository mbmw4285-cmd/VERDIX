/* VERDIX ESP32 controller
   Board: "ESP32 Dev Module" in Arduino IDE
   Library needed: ESP32Servo (Sketch > Include Library > Manage Libraries)

   WIRING
   IR sensor   OUT -> GPIO 13   | VCC -> 3V3 (or rated supply) | GND -> GND
   Servo 1 (bin carousel) signal -> GPIO 25
   Servo 2 (hopper flap)  signal -> GPIO 26
   Both servos: power from an external regulated supply (NOT the ESP32 pin).
   Both servos: supply GND connected to ESP32 GND (common ground).
   Tip: put a 470-1000 uF capacitor across the servo supply to stop resets.

   HC-SR04 ultrasonic sensor (ONE, mounted at a top corner of the bin, facing down)
   VCC 5V, GND. ECHO outputs 5V, so use a voltage divider (1k + 2k) or level shifter.
        TRIG -> GPIO 32     ECHO -> GPIO 33 (through the divider)

   WHAT IT DOES
   1) IR sensor sees an item -> tells the server -> dashboard captures + classifies.
   2) Every second it asks the server for a confirmed sort command.
   3) On a command: carousel turns to the bin, hopper flap opens, drops, closes.
   4) Every 10 s it measures the bin level and sends % full to the dashboard.
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ESP32Servo.h>

// ---------- EDIT THESE ----------
const char* WIFI_SSID = "Shreyas";
const char* WIFI_PASSWORD = "123456789";
const char* SERVER = "https://hmmmm-05gi.onrender.com";
const char* TOKEN = "SET_THE_SAME_TOKEN_IN_RENDER";   // must equal IR_TRIGGER_TOKEN on Render

const int IR_PIN = 13;
const int SENSOR_ACTIVE_STATE = LOW;   // most IR obstacle modules are active LOW

const int CAROUSEL_PIN = 25;
const int FLAP_PIN = 26;

// Order everywhere below: PLASTIC, METAL, ORGANIC, OTHER
const char* BIN_NAMES[4] = {"PLASTIC", "METAL", "ORGANIC", "OTHER"};
const int CAROUSEL_ANGLE[4] = {0, 60, 120, 180};   // CALIBRATE: angle that puts each bin under the flap
const int FLAP_CLOSED = 0;                          // CALIBRATE
const int FLAP_OPEN = 90;                           // CALIBRATE
const unsigned long CAROUSEL_MOVE_MS = 1500;        // time for the carousel to reach the bin
const unsigned long FLAP_OPEN_MS = 1500;            // how long the flap stays open
const unsigned long FLAP_CLOSE_MS = 700;

const int TRIG_PIN = 32;
const int ECHO_PIN = 33;
const float BIN_EMPTY_CM = 30.0;   // CALIBRATE: sensor-to-bottom distance when bin is empty
const float BIN_FULL_CM = 5.0;     // CALIBRATE: sensor-to-waste distance when bin counts as 100% full
// --------------------------------

const unsigned long REARM_DELAY_MS = 1800;
const unsigned long POLL_INTERVAL_MS = 1000;
const unsigned long LEVEL_INTERVAL_MS = 10000;

Servo carousel, flap;
bool wasDetected = false;
unsigned long lastSentAt = 0, lastPollAt = 0, lastLevelAt = 0;

void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.print("Connecting to Wi-Fi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) { delay(500); Serial.print('.'); }
  Serial.println(WiFi.status() == WL_CONNECTED ? "\nWi-Fi connected." : "\nWi-Fi failed, will retry.");
}

void setup() {
  Serial.begin(115200);
  pinMode(IR_PIN, INPUT_PULLUP);
  pinMode(TRIG_PIN, OUTPUT); pinMode(ECHO_PIN, INPUT); digitalWrite(TRIG_PIN, LOW);
  carousel.setPeriodHertz(50); flap.setPeriodHertz(50);
  carousel.attach(CAROUSEL_PIN, 500, 2400);
  flap.attach(FLAP_PIN, 500, 2400);
  flap.write(FLAP_CLOSED);
  carousel.write(CAROUSEL_ANGLE[0]);
  connectWiFi();
  Serial.println("VERDIX ESP32 ready.");
}

void loop() {
  connectWiFi();

  const bool detected = (digitalRead(IR_PIN) == SENSOR_ACTIVE_STATE);
  if (detected && !wasDetected && millis() - lastSentAt >= REARM_DELAY_MS) {
    sendTrigger();
    lastSentAt = millis();
  }
  wasDetected = detected;

  if (millis() - lastPollAt >= POLL_INTERVAL_MS) {
    lastPollAt = millis();
    pollSortCommand();
  }
  if (millis() - lastLevelAt >= LEVEL_INTERVAL_MS) {
    lastLevelAt = millis();
    sendBinLevels();
  }
  delay(40);
}

void sendTrigger() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure client; client.setInsecure();   // skips certificate check; fine for a prototype
  HTTPClient http; http.setTimeout(8000);
  http.begin(client, String(SERVER) + "/api/ir-trigger");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ir-token", TOKEN);
  int code = http.POST("{\"detected\":true}");
  Serial.printf("IR trigger -> HTTP %d\n", code);
  http.end();
}

void pollSortCommand() {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http; http.setTimeout(8000);
  http.begin(client, String(SERVER) + "/api/sort-command");
  http.addHeader("x-ir-token", TOKEN);
  int code = http.GET();
  if (code == 200) {
    String body = http.getString();
    for (int i = 0; i < 4; i++) {
      if (body.indexOf(BIN_NAMES[i]) >= 0) { sortTo(i); break; }
    }
  } else if (code == 401) {
    Serial.println("Poll rejected (401): token does not match IR_TRIGGER_TOKEN on Render.");
  } else if (code < 0) {
    Serial.printf("Poll failed: %d\n", code);
  }
  http.end();
}

void sortTo(int bin) {
  Serial.printf("Sorting to %s (carousel angle %d)\n", BIN_NAMES[bin], CAROUSEL_ANGLE[bin]);
  flap.write(FLAP_CLOSED);
  carousel.write(CAROUSEL_ANGLE[bin]);
  delay(CAROUSEL_MOVE_MS);
  flap.write(FLAP_OPEN);
  delay(FLAP_OPEN_MS);
  flap.write(FLAP_CLOSED);
  delay(FLAP_CLOSE_MS);
  Serial.println("Sort done.");
  lastLevelAt = millis() - LEVEL_INTERVAL_MS + 3000;   // re-measure the bin ~3 s after a drop
}

// Returns distance in cm, or -1 if no echo.
float readDistanceCm(int trig, int echo) {
  digitalWrite(trig, LOW); delayMicroseconds(3);
  digitalWrite(trig, HIGH); delayMicroseconds(10);
  digitalWrite(trig, LOW);
  unsigned long us = pulseIn(echo, HIGH, 30000UL);
  if (us == 0) return -1;
  return us * 0.0343f / 2.0f;
}

// Median of 3 readings converted to percent full; -1 if the sensor failed.
int readLevelPercent() {
  float v[3]; int n = 0;
  for (int k = 0; k < 3; k++) {
    float d = readDistanceCm(TRIG_PIN, ECHO_PIN);
    if (d > 0) v[n++] = d;
    delay(30);
  }
  if (n == 0) return -1;
  for (int a = 0; a < n - 1; a++) for (int b = a + 1; b < n; b++) if (v[b] < v[a]) { float t = v[a]; v[a] = v[b]; v[b] = t; }
  float med = v[n / 2];
  float pct = (BIN_EMPTY_CM - med) / (BIN_EMPTY_CM - BIN_FULL_CM) * 100.0f;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return (int)(pct + 0.5f);
}

void sendBinLevels() {
  if (WiFi.status() != WL_CONNECTED) return;
  int lvl = readLevelPercent();
  if (lvl < 0) { Serial.println("Bin-level sensor: no echo, skipping."); return; }
  String json = "{\"level\":" + String(lvl) + "}";
  WiFiClientSecure client; client.setInsecure();
  HTTPClient http; http.setTimeout(8000);
  http.begin(client, String(SERVER) + "/api/bin-levels");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ir-token", TOKEN);
  int code = http.POST(json);
  Serial.printf("Level %s -> HTTP %d\n", json.c_str(), code);
  http.end();
}
