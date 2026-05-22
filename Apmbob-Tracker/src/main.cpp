#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <TinyGPSPlus.h>

#define WIFI_SSID "ciwak"
#define WIFI_PASS "bentargwcek"

#define MQTT_BROKER "202f37f7e67c4292b30a95877382225e.s1.eu.hivemq.cloud"
#define MQTT_PORT 8883
#define MQTT_USER "kelompok16"
#define MQTT_PASS "Kelompok16"
#define MQTT_TOPIC "apmbob/tracker/gps"

#define GPS_RX 16
#define GPS_TX 17

#define SIM_RX 26
#define SIM_TX 27
#define SIM_RST 14

#define SIM800L_DISABLED

#define RELAY_PIN 25
#define MQTT_TOPIC_ZONE "apmbob/tracker/zone"

#define MAX_SATS 16
#define LINE_BUF 128

struct SatInfo {
  int prn;
  int elev;
  int azim;
  int snr;
};

WiFiClientSecure espClient;
PubSubClient mqttClient(espClient);
TinyGPSPlus gps;

unsigned long lastMqttTry = 0;

// Satelit tracking
SatInfo satList[MAX_SATS];
int satCount = 0;
int gsvTotalMsg = 0;
int gsvMsgNum = 0;
SatInfo gsvAccum[MAX_SATS];
int gsvAccumCount = 0;

// NMEA line buffer
char nmeaBuf[LINE_BUF];
int nmeaIdx = 0;

// Zone / Geo-fence
double zoneCenterLat = 0;
double zoneCenterLng = 0;
float zoneRadius = 50;
bool zoneActive = false;
bool zoneViolated = false;
bool zoneManualMode = false;
unsigned long zoneViolatedAt = 0;

String simAtCmd(const char* cmd, unsigned long timeout, bool echo) {
  Serial1.flush();
  while (Serial1.available()) Serial1.read();
  Serial1.println(cmd);
  String resp = "";
  unsigned long t = millis() + timeout;
  while (millis() < t) {
    while (Serial1.available()) {
      char c = Serial1.read();
      resp += c;
    }
    if (resp.indexOf("OK") >= 0 || resp.indexOf("ERROR") >= 0) break;
  }
  if (echo) {
    Serial.print("  >>> raw: ");
    for (int i = 0; i < resp.length(); i++) {
      char c = resp[i];
      if (c == '\r') Serial.print("\\r");
      else if (c == '\n') Serial.print("\\n");
      else Serial.print(c);
    }
    Serial.println();
  }
  return resp;
}

bool simTestBaud(int baud) {
  Serial1.begin(baud, SERIAL_8N1, SIM_RX, SIM_TX);
  delay(300);
  String r = simAtCmd("AT", 2000, true);
  if (r.indexOf("OK") >= 0) {
    Serial.printf("[SIM800L] Baud OK: %d\n", baud);
    return true;
  }
  Serial1.end();
  return false;
}

void parseGSV(const char* line) {
  // $GPGSV,<total>,<msgNum>,<satInView>,<prn>,<elev>,<azim>,<snr>,...
  if (strncmp(line, "$GPGSV", 6) != 0 && strncmp(line, "$GLGSV", 6) != 0
    && strncmp(line, "$GAGSV", 6) != 0 && strncmp(line, "$BDGSV", 6) != 0) return;

  // Copy biar bisa dimodifikasi
  char buf[LINE_BUF];
  strncpy(buf, line, LINE_BUF - 1);
  buf[LINE_BUF - 1] = '\0';

  // Split by comma
  char* tokens[20];
  int tokCount = 0;
  char* p = buf;
  while (p && tokCount < 20) {
    tokens[tokCount++] = p;
    p = strchr(p, ',');
    if (p) { *p = '\0'; p++; }
  }
  if (tokCount < 5) return;

  int totalMsg = atoi(tokens[1]);
  int msgNum = atoi(tokens[2]);
  int totalSats = atoi(tokens[3]);

  // Reset accumulator kalo ini message pertama
  if (msgNum == 1) {
    gsvAccumCount = 0;
  }
  gsvTotalMsg = totalMsg;
  gsvMsgNum = msgNum;

  // Parse satellite blocks (4 token per sat: PRN, elev, azim, SNR)
    for (int i = 4; i + 3 < tokCount; i += 4) {
    int prn = atoi(tokens[i]);
    int elev = atoi(tokens[i + 1]);
    int azim = atoi(tokens[i + 2]);
    int snr = atoi(tokens[i + 3]);
    if (prn > 0 && gsvAccumCount < MAX_SATS) {
      gsvAccum[gsvAccumCount].prn = prn;
      gsvAccum[gsvAccumCount].elev = elev;
      gsvAccum[gsvAccumCount].azim = azim;
      gsvAccum[gsvAccumCount].snr = snr;
      gsvAccumCount++;
    }
  }

  // Kalo ini message terakhir, copy ke satList
  if (msgNum == totalMsg) {
    satCount = gsvAccumCount;
    for (int i = 0; i < satCount && i < MAX_SATS; i++) {
      satList[i] = gsvAccum[i];
    }
    Serial.printf("[GSV] Complete: %d sats parsed\n", satCount);
  }
}

void buildSatJson(char* buf, int bufSize) {
  int pos = 0;
  pos += snprintf(buf + pos, bufSize - pos, "\"satellites\":[");
  for (int i = 0; i < satCount && i < MAX_SATS && pos < bufSize - 20; i++) {
    if (i > 0) pos += snprintf(buf + pos, bufSize - pos, ",");
    pos += snprintf(buf + pos, bufSize - pos, "{\"p\":%d,\"e\":%d,\"a\":%d,\"s\":%d}",
      satList[i].prn, satList[i].elev, satList[i].azim, satList[i].snr);
  }
  pos += snprintf(buf + pos, bufSize - pos, "]");
}

float haversineDist(double lat1, double lng1, double lat2, double lng2) {
  double dLat = (lat2 - lat1) * DEG_TO_RAD;
  double dLng = (lng2 - lng1) * DEG_TO_RAD;
  double a = sin(dLat / 2) * sin(dLat / 2) +
             cos(lat1 * DEG_TO_RAD) * cos(lat2 * DEG_TO_RAD) *
             sin(dLng / 2) * sin(dLng / 2);
  double c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return 6371000.0 * c;
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
  char buf[256];
  unsigned int copyLen = len < 255 ? len : 255;
  memcpy(buf, payload, copyLen);
  buf[copyLen] = '\0';

  if (strcmp(topic, MQTT_TOPIC_ZONE) != 0) return;

  Serial.printf("[MQTT] Zone config: %s\n", buf);

  if (strstr(buf, "\"set_zone\"")) {
    double lat = 0, lng = 0;
    float rad = 10;
    bool act = false;
    bool manual = false;

    char* p = strstr(buf, "\"centerLat\"");
    if (p) { p = strchr(p, ':'); if (p) lat = atof(p + 1); }
    p = strstr(buf, "\"centerLng\"");
    if (p) { p = strchr(p, ':'); if (p) lng = atof(p + 1); }
    p = strstr(buf, "\"radius\"");
    if (p) { p = strchr(p, ':'); if (p) rad = atof(p + 1); }
    p = strstr(buf, "\"active\"");
    if (p) { p = strchr(p, ':'); if (p) act = (atoi(p + 1) > 0) || strstr(p + 1, "true"); }
    p = strstr(buf, "\"mode\"");
    if (p) { p = strchr(p, ':'); if (p) manual = strstr(p, "\"manual\"") ? true : false; }

    zoneCenterLat = lat;
    zoneCenterLng = lng;
    zoneRadius = rad;
    zoneActive = act;
    zoneManualMode = manual;

    if (!act) {
      zoneViolated = false;
      digitalWrite(RELAY_PIN, LOW);
    }

    Serial.printf("[ZONE] Set: (%.6f,%.6f) r=%.0fm active=%d mode=%s\n",
      zoneCenterLat, zoneCenterLng, zoneRadius, zoneActive, manual ? "manual" : "auto");
  }
  else if (strstr(buf, "\"reset\"")) {
    zoneViolated = false;
    digitalWrite(RELAY_PIN, LOW);
    Serial.println("[ZONE] Reset via MQTT");
  }
}

void setup() {
  Serial.begin(115200);
  delay(2000);

  Serial.println("\n=========================================");
  Serial.println("  Apmbob-Tracker v2.0");
  Serial.println("=========================================\n");

#ifndef SIM800L_DISABLED
  // --- SIM800L ---
  Serial.print("[SIM800L] Reset module...");
  pinMode(SIM_RST, OUTPUT);
  digitalWrite(SIM_RST, LOW);
  delay(500);
  digitalWrite(SIM_RST, HIGH);
  delay(5000);
  Serial.println(" OK");

  Serial.println("[SIM800L] Cek baud 9600...");
  bool simOk = simTestBaud(9600);

  if (!simOk) {
    Serial.println("[SIM800L] Cek baud 115200...");
    simOk = simTestBaud(115200);
  }
  if (!simOk) {
    Serial.println("[SIM800L] Cek baud 57600...");
    simOk = simTestBaud(57600);
  }

  if (simOk) {
    Serial.println("[SIM800L] Module merespons!");
  } else {
    Serial.println("[SIM800L] Tidak ada respons - cek wiring/power");
    Serial.println("[SIM800L] Pastikan 5VIN dapat power 2A dan RX/TX cross-connected");
    Serial.println("[SIM800L] Coba: TX(ESP27) -> RX(SIM), RX(ESP26) -> TX(SIM)");
  }

  if (simOk) {
    Serial.print("[SIM800L] AT+CCID... ");
    String r = simAtCmd("AT+CCID", 3000, true);
    if (r.indexOf("+CCID") >= 0) {
      int start = r.indexOf("+CCID: ");
      int end = r.indexOf("\r", start);
      if (start >= 0 && end > start) {
        String iccid = r.substring(start + 7, end);
        iccid.trim();
        Serial.printf("[SIM800L] SIM TERDETEKSI! ICCID: %s\n", iccid.c_str());
      }
    } else {
      Serial.println("[SIM800L] CME ERROR / SIM tidak terbaca - fallback ke WiFi");
    }

    Serial.print("[SIM800L] AT+CSQ... ");
    simAtCmd("AT+CSQ", 2000, true);
  }
  Serial.println();
#else
  Serial.println("[SIM800L] Disabled via #define");
  Serial.println();
#endif

  // --- Relay GPIO ---
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, LOW);
  Serial.printf("[RELAY] GPIO %d siap (LOW=AMAN)\n", RELAY_PIN);

  // --- WiFi ---
  Serial.printf("[WiFi] Menghubungkan ke %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int n = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++n > 30) break;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Terhubung! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] GAGAL - cek SSID/password");
  }

  // --- MQTT ---
  if (WiFi.status() == WL_CONNECTED) {
    espClient.setInsecure();
    IPAddress ip;
    if (!WiFi.hostByName(MQTT_BROKER, ip)) {
      Serial.printf("\n[MQTT] DNS GAGAL - %s tidak bisa diresolve\n", MQTT_BROKER);
    } else {
      Serial.printf("\n[MQTT] DNS OK -> %s\n", ip.toString().c_str());
      Serial.printf("[MQTT] Konek ke %s:%d (timeout 5s)...", MQTT_BROKER, MQTT_PORT);
      if (espClient.connect(MQTT_BROKER, MQTT_PORT, 5000)) {
        mqttClient.setClient(espClient);
        mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
        mqttClient.setBufferSize(2048);
        if (mqttClient.connect("apmbob-esp32", MQTT_USER, MQTT_PASS)) {
          Serial.println(" OK");
          mqttClient.setCallback(mqttCallback);
          if (mqttClient.subscribe(MQTT_TOPIC_ZONE)) {
            Serial.printf("[MQTT] Subscribe %s OK\n", MQTT_TOPIC_ZONE);
          }
        } else {
          Serial.printf(" MQTT GAGAL (rc=%d)\n", mqttClient.state());
        }
      } else {
        int err = espClient.lastError(NULL, 0);
        Serial.printf(" TLS GAGAL (err=%d)\n", err);
      }
    }
  }

  // --- GPS NEO-6M ---
  Serial.println("\n[GPS] Inisialisasi NEO-6M via Serial2 (GPIO16)...");
  Serial2.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  delay(1000);

  Serial.println("[GPS] Data NMEA (3 baris pertama):");
  int baris = 0;
  String line = "";
  unsigned long t = millis() + 3000;
  while (millis() < t && baris < 3) {
    if (Serial2.available()) {
      char c = Serial2.read();
      line += c;
      if (c == '\n') {
        line.trim();
        if (line.length() > 0 && line.startsWith("$")) {
          Serial.printf("  %s\n", line.c_str());
          baris++;
        }
        line = "";
      }
    }
  }
  if (baris > 0) {
    Serial.println("[GPS] Module berkomunikasi! Menunggu fix...");
    for (unsigned long i = 0; i < 3000; i += 10) {
      while (Serial2.available()) {
        char c = Serial2.read();
        gps.encode(c);
        if (nmeaIdx < LINE_BUF - 1) nmeaBuf[nmeaIdx++] = c;
        if (c == '\n') {
          nmeaBuf[nmeaIdx] = '\0';
          parseGSV(nmeaBuf);
          nmeaIdx = 0;
        }
      }
      delay(10);
    }
    if (gps.location.isValid()) {
      Serial.printf("[GPS] FIX DIDAPAT! Lat: %.6f Lng: %.6f\n",
        gps.location.lat(), gps.location.lng());
    } else {
      Serial.println("[GPS] Belum fix, mencari satellite...");
    }
  } else {
    Serial.println("[GPS] Tidak ada data - cek wiring");
  }

  Serial.println("\n=========================================");
  Serial.println("  SYSTEM READY");
  Serial.println("=========================================\n");
}

void loop() {
  // Baca GPS - feed TinyGPSPlus + parse GSV
  while (Serial2.available() > 0) {
    char c = Serial2.read();
    gps.encode(c);
    if (nmeaIdx < LINE_BUF - 1) nmeaBuf[nmeaIdx++] = c;
    if (c == '\n') {
      nmeaBuf[nmeaIdx] = '\0';
      parseGSV(nmeaBuf);
      nmeaIdx = 0;
    }
  }

  // MQTT reconnect
  if (mqttClient.connected()) {
    mqttClient.loop();
  } else if (WiFi.status() == WL_CONNECTED && millis() - lastMqttTry > 10000) {
    lastMqttTry = millis();
    espClient.setInsecure();
    IPAddress ip;
    if (!WiFi.hostByName(MQTT_BROKER, ip)) {
      Serial.printf("[MQTT] DNS GAGAL\n");
    } else if (espClient.connect(MQTT_BROKER, MQTT_PORT, 5000)) {
      mqttClient.setClient(espClient);
      mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
      mqttClient.setBufferSize(2048);
      if (mqttClient.connect("apmbob-esp32", MQTT_USER, MQTT_PASS)) {
        Serial.println("[MQTT] Reconnect OK");
        mqttClient.setCallback(mqttCallback);
        mqttClient.subscribe(MQTT_TOPIC_ZONE);
      }
    }
  }

  // Simpan posisi terakhir
  static float lastLat = 0, lastLng = 0, lastSpd = 0, lastCog = 0;
  static int lastSats = 0;
  static bool pernahFix = false;

  // Kirim tiap 15 detik saat fix, 30 detik saat stale
  static unsigned long lastSend = 0;
  unsigned long interval = pernahFix && !gps.location.isValid() ? 10000 : 5000;
  if (millis() - lastSend < interval) return;
  lastSend = millis();

  if (gps.location.isValid()) {
    lastLat = gps.location.lat();
    lastLng = gps.location.lng();
    lastSpd = gps.speed.kmph();
    lastCog = gps.course.deg();
    lastSats = gps.satellites.value();
    pernahFix = true;

    Serial.printf("[GPS] REAL | Lat: %.6f Lng: %.6f | %.1f km/h | %d sat\n", lastLat, lastLng, lastSpd, lastSats);
    if (satCount > 0) {
      Serial.printf("[SAT] Terlihat: %d satelit\n", satCount);
      for (int i = 0; i < satCount && i < 4; i++) {
        Serial.printf("  PRN:%d elev:%d azim:%d SNR:%d\n", satList[i].prn, satList[i].elev, satList[i].azim, satList[i].snr);
      }
    }

    // Zone logic
    if (zoneActive) {
      float dist = haversineDist(zoneCenterLat, zoneCenterLng, lastLat, lastLng);
      if (dist > zoneRadius) {
        if (!zoneViolated) {
          zoneViolated = true;
          zoneViolatedAt = millis();
          digitalWrite(RELAY_PIN, HIGH);
          Serial.printf("[ZONE] DILANGGAR! Jarak: %.1fm > %.0fm\n", dist, zoneRadius);
        }
      } else {
        if (zoneViolated && !zoneManualMode) {
          zoneViolated = false;
          digitalWrite(RELAY_PIN, LOW);
          Serial.println("[ZONE] Auto reset - kembali ke zona");
        }
      }
    }

    if (mqttClient.connected()) {
      char buf[1024];
      const char* zoneStatus = zoneActive ? (zoneViolated ? "violated" : "safe") : "inactive";
      int pos = snprintf(buf, sizeof(buf),
        "{\"device\":\"apmbob-01\",\"lat\":%.6f,\"lng\":%.6f,\"speed\":%.1f,\"heading\":%.1f,\"sats\":%d,\"mode\":\"gps\","
        "\"zone\":{\"status\":\"%s\",\"active\":%d,\"radius\":%.0f,\"mode\":\"%s\"},",
        lastLat, lastLng, lastSpd, lastCog, lastSats,
        zoneStatus, zoneActive, zoneRadius, zoneManualMode ? "manual" : "auto");
      buildSatJson(buf + pos, sizeof(buf) - pos);
      int len = strlen(buf);
      if (len < (int)sizeof(buf) - 2) {
        buf[len] = '}';
        buf[len + 1] = '\0';
      }
      if (mqttClient.publish(MQTT_TOPIC, buf)) {
        Serial.println("[MQTT] Data terkirim!");
      } else {
        Serial.println("[MQTT] Gagal kirim");
      }
    }
  } else if (pernahFix) {
    Serial.printf("[GPS] STALE | Lat: %.6f Lng: %.6f | SINYAL HILANG! sat terlihat: %d\n", lastLat, lastLng, gps.satellites.value());

    if (mqttClient.connected()) {
      char buf[1024];
      const char* zoneStatus = zoneActive ? (zoneViolated ? "violated" : "safe") : "inactive";
      int pos = snprintf(buf, sizeof(buf),
        "{\"device\":\"apmbob-01\",\"lat\":%.6f,\"lng\":%.6f,\"speed\":%.1f,\"heading\":%.1f,\"sats\":%d,\"mode\":\"gps_stale\","
        "\"zone\":{\"status\":\"%s\",\"active\":%d,\"radius\":%.0f,\"mode\":\"%s\"},",
        lastLat, lastLng, lastSpd, lastCog, lastSats,
        zoneStatus, zoneActive, zoneRadius, zoneManualMode ? "manual" : "auto");
      buildSatJson(buf + pos, sizeof(buf) - pos);
      int len = strlen(buf);
      if (len < (int)sizeof(buf) - 2) {
        buf[len] = '}';
        buf[len + 1] = '\0';
      }
      if (mqttClient.publish(MQTT_TOPIC, buf)) {
        Serial.println("[MQTT] Data stale terkirim!");
      } else {
        Serial.println("[MQTT] Gagal kirim stale");
      }
    }
  } else {
    Serial.printf("[GPS] Mencari satellite... (encoded: %lu)\n", gps.charsProcessed());
    if (gps.satellites.value() > 0) {
      Serial.printf("[GPS] Satelit terlihat: %d\n", gps.satellites.value());
    }
  }
}
