/* VERDIX IR-trigger sender example
   Board: ESP32 DevKit
   IR sensor OUT -> GPIO 13 (change to your actual wiring)
   IR sensor VCC -> 3V3 or the voltage required by your module
   IR sensor GND -> ESP32 GND

   This sketch sends an event to your VERDIX backend when the sensor sees an object.
   Most obstacle sensors are active LOW; change SENSOR_ACTIVE_STATE if yours differs.
*/
#include <WiFi.h>
#include <HTTPClient.h>

const char* WIFI_SSID = "YOUR_WIFI_NAME";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* BACKEND_URL = "https://hmmmm-05gi.onrender.com/api/ir-trigger";
const char* IR_TRIGGER_TOKEN = "SET_THE_SAME_TOKEN_IN_RENDER";
const int IR_PIN = 13;
const int SENSOR_ACTIVE_STATE = LOW;
const unsigned long REARM_DELAY_MS = 1800;

bool wasDetected = false;
unsigned long lastSentAt = 0;

void setup() {
  Serial.begin(115200);
  pinMode(IR_PIN, INPUT_PULLUP);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print('.'); }
  Serial.println("\nWi-Fi connected. VERDIX IR trigger ready.");
}

void loop() {
  const bool detected = (digitalRead(IR_PIN) == SENSOR_ACTIVE_STATE);
  const unsigned long now = millis();
  if (detected && !wasDetected && now - lastSentAt >= REARM_DELAY_MS) {
    sendTrigger();
    lastSentAt = now;
  }
  wasDetected = detected;
  delay(40);
}

void sendTrigger() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("IR detected, but Wi-Fi is disconnected.");
    return;
  }
  HTTPClient http;
  http.begin(BACKEND_URL);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-ir-token", IR_TRIGGER_TOKEN);
  const int code = http.POST("{\"detected\":true}");
  Serial.printf("IR trigger response: HTTP %d\n", code);
  if (code > 0) Serial.println(http.getString());
  http.end();
}
