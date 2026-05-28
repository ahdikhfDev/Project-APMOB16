#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <TinyGPSPlus.h>
#include <Preferences.h>

#include "secrets.h"

// --- Konfigurasi ---
#define MQTT_TOPIC "apmbob/tracker/gps"
#define MQTT_TOPIC_ZONE "apmbob/tracker/zone"
#define GPS_RX 16
#define GPS_TX 17
#define RELAY_PIN 25
#define MAX_SATS 16
#define LINE_BUF 128

// Filter GPS biar gak goyang
#define MIN_SATS 6          // Minimal satelit buat fix valid. 4 = 2D (bisa loncat), 6 = 3D stabil
#define HDOP_THRESHOLD 300  // Maksimal HDOP yg ditolerir (dalam centi-HDOP, 300 = 3.0). 
                            // HDOP > 3.0 = geometri satelit jelek, posisi gak akurat
#define MOVE_THRESHOLD_M 5  // Jarak minimal (meter) sebelum publish posisi baru
#define HEARTBEAT_MS 60000  // Force publish tiap 60 detik biar dashboard tau ESP32 masih hidup

struct SatInfo {
  int prn;  // PRN (Pseudo-Random Noise) ID satelit — nomor unik tiap satelit GPS/GLONASS/BeiDou
  int elev; // Elevasi (0-90°) — seberapa tinggi satelit dari horizon. Makin tinggi makin bagus sinyalnya
  int azim; // Azimuth (0-359°) — arah satelit dari utara (derajat kompas)
  int snr;  // Signal-to-Noise Ratio (0-99 dB) — kekuatan sinyal. >40 = bagus, <20 = lemah
};

WiFiClientSecure espClient;
PubSubClient mqttClient(espClient);
TinyGPSPlus gps;
Preferences prefs;

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

// Kelas Kalman 1 dimensi — filtering sinyal biar gak goyang
// Cara kerja singkat:
// 1. PREDICT: perbesar ketidakpastian (p) karena waktu berlalu
// 2. GAIN: hitung seberapa percaya data baru vs data lama
// 3. CORRECT: update posisi (x) berdasarkan gain
// 4. UPDATE: kecilin ketidakpastian karena udah dikoreksi
// Parameter:
//   meaNoise — seberapa noise GPS-nya (dalam degrees). Makin gede, filter makin lambat bereaksi
//   procNoise — seberapa cepat posisi bisa berubah. Makin gede, filter makin responsif
class Kalman1D {
  double x; // Estimated state (posisi yang udah di-smooth)
  double p; // Uncertainty / ketidakpastian estimasi
  double q; // Process noise — seberapa cepat posisi berubah
  double r; // Measurement noise — seberapa noise data GPS mentah
  double k; // Kalman gain — hasil bagi: seberapa percaya data baru?
public:
  Kalman1D(double meaNoise, double procNoise)
    : x(0), p(1), q(procNoise), r(meaNoise), k(0) {}
  double update(double z) {
    p += q;                  // Predict: makin lama tanpa update, ketidakpastian makin gede
    k = p / (p + r);         // Gain: kalo r gede (GPS noise), k kecil (gak percaya data baru)
    x += k * (z - x);        // Correct: posisi baru = posisi lama + gain * selisih
    p *= (1 - k);            // Update: setelah dikoreksi, ketidakpastian menurun
    return x;
  }
  void reset(double pos) { x = pos; p = 1; } // Reset ke posisi awal (pas pertama kali dapet fix)
};

Kalman1D latFilter(0.00001, 0.000001);
Kalman1D lngFilter(0.00001, 0.000001);
double stableLat = 0, stableLng = 0;
unsigned long lastPublishMs = 0;

// ---------- Fungsi Jarak Haversine ----------
// Ngitung jarak antara 2 titik koordinat (lat/lng) dalam METER
// Rumus trigonometri bola (spherical trigonometry) — ngitung jarak di permukaan bumi
float haversineDist(double lat1, double lng1, double lat2, double lng2) {
  double dLat = (lat2 - lat1) * DEG_TO_RAD; // Selisih latitude dalam radian
  double dLng = (lng2 - lng1) * DEG_TO_RAD; // Selisih longitude dalam radian
  // Rumus haversine: a = sin²(Δlat/2) + cos(lat1)·cos(lat2)·sin²(Δlng/2)
  double a = sin(dLat / 2) * sin(dLat / 2) +
             cos(lat1 * DEG_TO_RAD) * cos(lat2 * DEG_TO_RAD) *
             sin(dLng / 2) * sin(dLng / 2);
  double c = 2 * atan2(sqrt(a), sqrt(1 - a)); // Sudut pusat (central angle) dalam radian
  return 6371000.0 * c; // 6371km = jari-jari bumi. Hasil akhir dalam METER
}

void loadZonePrefs();
void saveZonePrefs();

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
      digitalWrite(RELAY_PIN, HIGH);
    }

    Serial.printf("[ZONE] Set: (%.6f,%.6f) r=%.0fm active=%d mode=%s\n",
      zoneCenterLat, zoneCenterLng, zoneRadius, zoneActive, manual ? "manual" : "auto");
    saveZonePrefs();
  }
  else if (strstr(buf, "\"reset\"")) {
    zoneViolated = false;
    digitalWrite(RELAY_PIN, HIGH);
    Serial.println("[ZONE] Reset via MQTT");
  }
}

void loadZonePrefs() {
  prefs.begin("zone", true);
  zoneCenterLat = prefs.getDouble("centerLat", 0.0);
  zoneCenterLng = prefs.getDouble("centerLng", 0.0);
  zoneRadius = prefs.getFloat("radius", 50.0);
  zoneActive = prefs.getBool("active", false);
  zoneManualMode = prefs.getBool("manual", false);
  prefs.end();
  if (zoneRadius != 0) Serial.printf("[NVS] Zone restored: (%.4f,%.4f) r=%.0f active=%d\n",
    zoneCenterLat, zoneCenterLng, zoneRadius, zoneActive);
}

void saveZonePrefs() {
  prefs.begin("zone", false);
  prefs.putDouble("centerLat", zoneCenterLat);
  prefs.putDouble("centerLng", zoneCenterLng);
  prefs.putFloat("radius", zoneRadius);
  prefs.putBool("active", zoneActive);
  prefs.putBool("manual", zoneManualMode);
  prefs.end();
  Serial.println("[NVS] Zone saved");
}

void setup() {
  // --- Serial Monitor (buat debug lewat USB) ---
  Serial.begin(115200);
  delay(2000); // Tunggu serial siap

  Serial.println("\n=========================================");
  Serial.println("  Apmbob-Tracker v2.0");
  Serial.println("=========================================\n");

  // --- Relay GPIO ---
  // Relay JQC-3FF-S-Z LOW-trigger. GPIO HIGH = relay OFF = NC tertutup = LED nyala (AMAN)
  pinMode(RELAY_PIN, OUTPUT);
  digitalWrite(RELAY_PIN, HIGH); // Mulai dengan keadaan aman
  Serial.printf("[RELAY] GPIO %d siap (HIGH=AMAN)\n", RELAY_PIN);

  // --- NVS Zone Preferences ---
  // NVS (Non-Volatile Storage) — memori internal ESP32 yang datanya gak ilang meski listrik mati
  loadZonePrefs();
  if (zoneActive && zoneViolated) digitalWrite(RELAY_PIN, LOW); // Kalo lagi violated, relay ON

  // --- WiFi ---
  Serial.printf("[WiFi] Menghubungkan ke %s", WIFI_SSID);
  WiFi.mode(WIFI_STA); // Station mode = ESP32 sebagai client, bukan access point
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  int n = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
    if (++n > 30) break; // Timeout 15 detik (30 x 500ms)
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Terhubung! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] GAGAL - cek SSID/password");
  }

  // --- MQTT ---
  if (WiFi.status() == WL_CONNECTED) {
    espClient.setInsecure(); // TLS tanpa verifikasi sertifikat (cukup buat project IoT)
    mqttClient.setClient(espClient);
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setBufferSize(2048); // Buffer gede biar muat payload JSON + satelit
    Serial.printf("\n[MQTT] Konek ke %s:%d...", MQTT_BROKER, MQTT_PORT);
    if (mqttClient.connect("apmbob-esp32", MQTT_USER, MQTT_PASS)) {
      Serial.println(" OK");
      mqttClient.setCallback(mqttCallback); // Fungsi yang dipanggil pas ada pesan masuk
      if (mqttClient.subscribe(MQTT_TOPIC_ZONE)) {
        Serial.printf("[MQTT] Subscribe %s OK\n", MQTT_TOPIC_ZONE);
      }
    } else {
      Serial.printf(" MQTT GAGAL (rc=%d)\n", mqttClient.state());
    }
  }

  // --- GPS NEO-6M ---
  // Serial2 = UART kedua ESP32. RX=GPIO16, TX=GPIO17, 9600 baud (default NEO-6M)
  Serial.println("\n[GPS] Inisialisasi NEO-6M via Serial2 (GPIO16)...");
  Serial2.begin(9600, SERIAL_8N1, GPS_RX, GPS_TX);
  delay(1000);

  // Test baca 3 baris NMEA pertama buat pastiin GPS merespon
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
    // Tunggu 3 detik cek dapet fix atau belum
    for (unsigned long i = 0; i < 3000; i += 10) {
      while (Serial2.available()) {
        char c = Serial2.read();
        gps.encode(c); // Feed ke TinyGPSPlus biar diparsing otomatis
        if (nmeaIdx < LINE_BUF - 1) nmeaBuf[nmeaIdx++] = c;
        if (c == '\n') {
          nmeaBuf[nmeaIdx] = '\0';
          parseGSV(nmeaBuf); // Parse baris $GPGSV buat dapet daftar satelit
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
  // --- Baca data GPS dari Serial2 (NEO-6M) ---
  // `gps.encode()` di panggil tiap ada 1 byte masuk. TinyGPSPlus otomatis parse kalimat NMEA
  // Pas dapet newline ('\n'), ambil baris NMEA lengkap dan parse GSV buat daftar satelit
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

  // --- MQTT reconnect (kalo putus, nyoba konek tiap 10 detik) ---
  if (mqttClient.connected()) {
    mqttClient.loop(); // Wajib di-loop biar MQTT tetep hidup & nerima callback
  } else if (WiFi.status() == WL_CONNECTED && millis() - lastMqttTry > 10000) {
    lastMqttTry = millis();
    Serial.printf("[MQTT] Reconnect...");
    if (mqttClient.connect("apmbob-esp32", MQTT_USER, MQTT_PASS)) {
      Serial.println(" OK");
      mqttClient.setCallback(mqttCallback);
      mqttClient.subscribe(MQTT_TOPIC_ZONE);
    } else {
      Serial.printf(" GAGAL (rc=%d)\n", mqttClient.state());
    }
  }

  // Variabel posisi terakhir yg berhasil di-publish ke MQTT
  // static = nilainya gak ilang meski loop() selesai dijalankan
  static double lastPubLat = 0, lastPubLng = 0;
  static float lastPubSpd = 0, lastPubCog = 0;
  static int lastPubSats = 0;
  static bool pernahFix = false;  // Udah pernah dapet fix GPS?
  static bool kalmanInit = false; // Kalman filter udah di-init?

  // Timer: kirim data tiap 5 detik (pas fix) atau 10 detik (pas sinyal ilang)
  static unsigned long lastSend = 0;
  unsigned long interval = pernahFix && !gps.location.isValid() ? 10000 : 5000;
  if (millis() - lastSend < interval) return; // Belum waktunya kirim, skip
  lastSend = millis();

  if (gps.location.isValid()) {
    // --- KALMAN FILTER ---
    // Ambil data GPS mentah, lalu smooth pake Kalman filter
    double rawLat = gps.location.lat();
    double rawLng = gps.location.lng();
    if (!kalmanInit) {
      // Pertama kali dapet fix: reset Kalman ke posisi ini
      latFilter.reset(rawLat);
      lngFilter.reset(rawLng);
      stableLat = rawLat; stableLng = rawLng;
      kalmanInit = true;
    }
    // Update Kalman: data mentah (raw) masuk, data smoothed (smooth) keluar
    double smoothLat = latFilter.update(rawLat);
    double smoothLng = lngFilter.update(rawLng);

    float rawSpd = gps.speed.kmph();       // Kecepatan (km/h)
    float rawCog = gps.course.deg();       // Arah (derajat dari utara)
    int rawSats = gps.satellites.value();  // Jumlah satelit yg di-track
    pernahFix = true;

    Serial.printf("[GPS] REAL | Smooth: %.6f,%.6f | %.1f km/h | %d sat\n", smoothLat, smoothLng, rawSpd, rawSats);
    if (satCount > 0) {
      Serial.printf("[SAT] Terlihat: %d satelit\n", satCount);
      for (int i = 0; i < satCount && i < 4; i++) {
        Serial.printf("  PRN:%d elev:%d azim:%d SNR:%d\n", satList[i].prn, satList[i].elev, satList[i].azim, satList[i].snr);
      }
    }

    // Zone logic (pakai smoothed position biar relay gak goyang)
    if (zoneActive) {
      float dist = haversineDist(zoneCenterLat, zoneCenterLng, smoothLat, smoothLng);
      if (dist > zoneRadius) {
        if (!zoneViolated) {
          zoneViolated = true;
          digitalWrite(RELAY_PIN, LOW);
          Serial.printf("[ZONE] DILANGGAR! Jarak: %.1fm > %.0fm\n", dist, zoneRadius);
        }
      } else {
        if (zoneViolated && !zoneManualMode) {
          zoneViolated = false;
          digitalWrite(RELAY_PIN, HIGH);
          Serial.println("[ZONE] Auto reset - kembali ke zona");
        }
      }
    }

    // --- Publish decision: kapan data MQTT dikirim? ---
    bool shouldPublish = false;

    // Cek kualitas sinyal GPS sebelum publish
    // HDOP (Horizontal Dilution of Precision) = ukuran akurasi geometri satelit
    // Makin kecil makin bagus. 1.0 = ideal, 2.0 = OK, >3.0 = jelek
    bool hdopOk = true; // Default: HDOP dianggap OK
    if (gps.hdop.isValid()) {
      hdopOk = (gps.hdop.value() <= HDOP_THRESHOLD);
      if (!hdopOk) {
        Serial.printf("[GPS] HDOP jelek (%d > %d), skip publish\n", gps.hdop.value(), HDOP_THRESHOLD);
      }
    }
    int rawHdop = gps.hdop.isValid() ? gps.hdop.value() : 0; // Ambil HDOP buat dikirim ke JSON

    // 1. First publish — kirim data pertama kali
    if (lastPubLat == 0 && lastPubLng == 0) {
      shouldPublish = true;
    }
    // 2. Publish kalo jarak >= threshold DAN satelit cukup DAN HDOP bagus
    else if (rawSats >= MIN_SATS && hdopOk) {
      double dist = haversineDist(lastPubLat, lastPubLng, smoothLat, smoothLng);
      if (dist >= MOVE_THRESHOLD_M) shouldPublish = true;
      if (!shouldPublish) {
        Serial.printf("[GPS] Skip publish (gerak %.1fm, threshold %dm)\n", dist, MOVE_THRESHOLD_M);
      }
    }
    // 3. Heartbeat — force publish tiap HEARTBEAT_MS biar dashboard tau ESP32 masih hidup
    if (!shouldPublish && millis() - lastPublishMs > HEARTBEAT_MS) {
      // Pas heartbeat, cek lagi: kalo satelit < MIN_SATS atau HDOP jelek, jangan publish
      if (rawSats >= MIN_SATS && hdopOk) {
        shouldPublish = true;
        Serial.println("[GPS] Force publish (heartbeat 60s)");
      } else {
        Serial.printf("[GPS] Heartbeat skip: sats=%d (min %d), hdopOk=%d\n", rawSats, MIN_SATS, hdopOk);
      }
    }

    if (shouldPublish && mqttClient.connected()) {
      lastPubLat = smoothLat;
      lastPubLng = smoothLng;
      lastPubSpd = rawSpd;
      lastPubCog = rawCog;
      lastPubSats = rawSats;
      lastPublishMs = millis();

      // Bangun JSON payload. HDOP ditambah biar dashboard tahu kualitas sinyal
      char buf[2048];
      const char* zoneStatus = zoneActive ? (zoneViolated ? "violated" : "safe") : "inactive";
      int pos = snprintf(buf, sizeof(buf),
        "{\"device\":\"apmbob-01\",\"lat\":%.6f,\"lng\":%.6f,\"speed\":%.1f,\"heading\":%.1f,\"sats\":%d,\"hdop\":%d,\"mode\":\"gps\","
        "\"zone\":{\"status\":\"%s\",\"active\":%d,\"radius\":%.0f,\"mode\":\"%s\"},",
        smoothLat, smoothLng, rawSpd, rawCog, rawSats, rawHdop,
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
    Serial.printf("[GPS] STALE | Lat: %.6f Lng: %.6f | SINYAL HILANG! sat terlihat: %d\n", lastPubLat, lastPubLng, gps.satellites.value());

    if (mqttClient.connected()) {
      char buf[2048];
      const char* zoneStatus = zoneActive ? (zoneViolated ? "violated" : "safe") : "inactive";
      int pos = snprintf(buf, sizeof(buf),
        "{\"device\":\"apmbob-01\",\"lat\":%.6f,\"lng\":%.6f,\"speed\":%.1f,\"heading\":%.1f,\"sats\":%d,\"hdop\":%d,\"mode\":\"gps_stale\","
        "\"zone\":{\"status\":\"%s\",\"active\":%d,\"radius\":%.0f,\"mode\":\"%s\"},",
        lastPubLat, lastPubLng, lastPubSpd, lastPubCog, lastPubSats, 0,
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
