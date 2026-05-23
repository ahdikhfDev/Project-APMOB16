# 📘 MODE BELAJAR — Panduan Lengkap Kode GPS Tracker

> **Dari NOL sampai paham seluruh kode.** Setiap istilah teknis dijelasin, setiap baris kode diterangin fungsinya.

---

## 📖 PENDAHULUAN

### Proyek Ini Apa?

Sistem **pelacak kendaraan real-time**. Ada alat (ESP32 + GPS NEO-6M) yang dipasang di motor/mobil, ngirim posisinya tiap beberapa detik, dan hasilnya keliatan di dashboard web.

### Alur Kerja Singkat

```
GPS (satelit) → NEO-6M (antena) → ESP32 (proses) → WiFi → HiveMQ Cloud (server MQTT)
                                                                        ↓
                                                         Dashboard Web (Next.js)
                                                                        ↓
                                                          Firebase (database)
```

1. **GPS NEO-6M** nerima sinyal dari satelit → ngasih data posisi (lat/lng)
2. **ESP32** baca data itu → bikin JSON → kirim ke HiveMQ Cloud lewat WiFi
3. **HiveMQ Cloud** server MQTT di cloud — nerusin data ke semua yang subscribe
4. **Dashboard Web** subscribe ke topic yang sama → dapet data real-time → tampilin di peta
5. **Firebase** nyimpen data biar ada history

### Glosarium Istilah

| Istilah | Arti |
|---------|------|
| **GPS** | Global Positioning System — sistem navigasi satelit |
| **NEO-6M** | Modul GPS receiver (nerima sinyal dari satelit) |
| **ESP32** | Mikrokontroler WiFi + Bluetooth (otaknya alat) |
| **NMEA** | Format data GPS standar internasional (text, pake koma) |
| **GSV** | $GPGSV — kalimat NMEA yang berisi data satelit |
| **PRN** | ID unik tiap satelit GPS (1-32) |
| **SNR** | Signal-to-Noise Ratio — kekuatan sinyal satelit (dB) |
| **Elevasi** | Tinggi satelit dari horizon (0-90°) |
| **Azimuth** | Arah satelit dari utara (0-360°) |
| **MQTT** | Protocol komunikasi publish/subscribe buat IoT |
| **TLS** | Enkripsi koneksi (biar data aman) |
| **WebSocket** | Koneksi real-time dua arah lewat browser |
| **Baud rate** | Kecepatan komunikasi serial (bit per detik) |
| **Serial** | Jalur komunikasi data pake kabel (TX/RX) |
| **GPIO** | General Purpose Input Output — pin serba guna di ESP32 |
| **Relay** | Saklar elektrik (bisa nyalain/matiin perangkat lain) |
| **NC** | Normally Closed — kondisi default relay tertutup |
| **COM** | Common — pin tengah relay |
| **JSON** | Format data text buat pertukaran data (key: value) |
| **NVS** | Non-Volatile Storage — penyimpanan ESP32 yang gak ilang pas mati |
| **RTDB** | Realtime Database — database Firebase yang real-time |
| **Fix** | Kondisi dimana GPS dapet posisi valid |
| **Stale** | Data lama (fix hilang, pake posisi terakhir) |
| **Haversine** | Rumus hitung jarak 2 titik di permukaan bumi |

---

# 📦 BAGIAN 1 — ESP32 FIRMWARE

## 1.1 Apa Itu main.cpp?

File `main.cpp` di folder `Apmbob-Tracker/src/` adalah **otaknya ESP32**. Semua logika program ditulis di sini.

Cara kerja ESP32:
- Ada fungsi `setup()` — jalan **sekali** pas ESP32 dinyalain
- Ada fungsi `loop()` — jalan **terus menerus** sampe ESP32 dimatiin

## 1.2 Include & Library

```cpp
#include <Arduino.h>           // Library dasar ESP32
#include <WiFi.h>              // Biar bisa konek WiFi
#include <WiFiClientSecure.h>  // Biar konek pake TLS (enkripsi)
#include <PubSubClient.h>      // Library MQTT
#include <TinyGPSPlus.h>       // Library baca data GPS
#include <Preferences.h>       // Library simpan data ke NVS
#include "secrets.h"           // File kredensial (WiFi, MQTT)
```

**Penjelasan:**
- `#include` = ngambil kode dari library lain biar bisa dipake
- **PubSubClient** — library buat publish/subscribe MQTT. Butuh WiFiClientSecure biar koneksinya pake TLS (enkripsi)
- **TinyGPSPlus** — library yang nerjemahin data NMEA mentah jadi lat, lng, speed, dll
- **Preferences** — biar data zone gak ilang pas ESP32 restart
- **secrets.h** — file khusus kredensial, dipisah biar aman dan gak ke-commit ke GitHub

## 1.3 Define & Pin

```cpp
#define MQTT_TOPIC "apmbob/tracker/gps"
#define MQTT_TOPIC_ZONE "apmbob/tracker/zone"
#define GPS_RX 16
#define GPS_TX 17
#define RELAY_PIN 25
#define MAX_SATS 16
#define LINE_BUF 128
```

**Apa itu `#define`?** — perintah buat bikin konstanta (nilai tetap, gak bisa diubah).

**Penjelasan tiap pin:**
- **GPS_RX (GPIO16)** — ESP32 nerima data dari GPS. Kenapa RX? Karena ESP32 yang **nerima** (receive).
- **GPS_TX (GPIO17)** — ESP32 **ngirim** data ke GPS. Cuma beberapa module GPS perlu ini.
- **RELAY_PIN (GPIO25)** — pin buat kontrol relay. HIGH/OFF = relay mati, LOW/ON = relay aktif.

**Serial2?** — ESP32 punya 3 serial: Serial (USB), Serial1 (pin bebas), Serial2 (pin bebas). GPS pake Serial2 biar gak bentrok sama Serial (yang dipake buat debug di komputer).

## 1.4 Secrets.h — Kenapa Dipisah?

File `secrets.h` isinya kredensial (SSID WiFi, password MQTT, dll). Dipisah dari `main.cpp` biar:
1. **Aman** — file ini masuk `.gitignore`, gak ikut ke GitHub
2. **Gampang ganti** — tinggal edit satu file, gak perlu nyari di tengah code

```cpp
#define WIFI_SSID "ciwak"
#define WIFI_PASS "bentargwcek"
#define MQTT_BROKER "202f37f7e67c4292b30a95877382225e.s1.eu.hivemq.cloud"
#define MQTT_PORT 8883
#define MQTT_USER "kelompok16"
#define MQTT_PASS "Kelompok16"
```

## 1.5 Variabel Global

```cpp
WiFiClientSecure espClient;     // Objek WiFi dengan TLS
PubSubClient mqttClient(espClient);  // Objek MQTT pake client WiFi
TinyGPSPlus gps;                // Objek GPS parser
Preferences prefs;              // Objek NVS storage
```

**Variabel-variabel ini disebut "global"** — bisa diakses dari fungsi manapun (setup, loop, dll).

**Variabel tracking satelit:**
```cpp
SatInfo satList[MAX_SATS];      // Array penampung data satelit
int satCount = 0;               // Jumlah satelit yang ke-detect
int gsvTotalMsg = 0;            // Total baris GSV yang diharapkan
int gsvMsgNum = 0;              // Baris GSV ke berapa (saat ini)
SatInfo gsvAccum[MAX_SATS];     // Akumulator sementara
int gsvAccumCount = 0;          // Jumlah satelit di akumulator
```

**Variabel zona:**
```cpp
double zoneCenterLat = 0;       // Latitude pusat zona
double zoneCenterLng = 0;       // Longitude pusat zona
float zoneRadius = 50;          // Radius zona (meter)
bool zoneActive = false;        // Zona aktif atau tidak
bool zoneViolated = false;      // Status pelanggaran
bool zoneManualMode = false;    // Mode manual (butuh reset manual)
```

## 1.6 Setup() — Jalan Sekali Pas ESP32 Nyala

```cpp
void setup() {
```

### 1.6a Serial Monitor

```cpp
Serial.begin(115200);
```

**Fungsi:** Biar ESP32 bisa komunikasi sama komputer lewat USB.
- `115200` = baud rate (kecepatan komunikasi)
- Pake `Serial.print()` untuk kirim teks ke Serial Monitor di komputer
- PENTING buat debugging — liat error, status, dll

### 1.6b Relay Init

```cpp
pinMode(RELAY_PIN, OUTPUT);
digitalWrite(RELAY_PIN, HIGH);
```

- `pinMode(RELAY_PIN, OUTPUT)` — set GPIO25 sebagai output (bisa ngirim sinyal ON/OFF)
- `digitalWrite(RELAY_PIN, HIGH)` — set HIGH = relay OFF = NC tertutup = LED nyala (status aman di awal)

### 1.6c NVS — Zone Gak Ilang Pas Restart

```cpp
loadZonePrefs();
```

Fungsi `loadZonePrefs()` baca data zona dari memori NVS:
```cpp
void loadZonePrefs() {
  prefs.begin("zone", true);        // Buka namespace "zone" (read-only)
  zoneCenterLat = prefs.getDouble("centerLat", 0.0);
  zoneCenterLng = prefs.getDouble("centerLng", 0.0);
  zoneRadius = prefs.getFloat("radius", 50.0);
  zoneActive = prefs.getBool("active", false);
  zoneManualMode = prefs.getBool("manual", false);
  prefs.end();                       // Tutup
}
```

**Apa itu NVS?** — Non-Volatile Storage, bagian memori ESP32 yang datanya tetap ada meskipun listrik mati. Kayak hard drive mini.

### 1.6d WiFi — Konek ke Internet

```cpp
WiFi.mode(WIFI_STA);            // Mode station (client WiFi biasa)
WiFi.begin(WIFI_SSID, WIFI_PASS);  // Mulai konek

int n = 0;
while (WiFi.status() != WL_CONNECTED) {
  delay(500);                   // Tunggu 0.5 detik
  Serial.print(".");
  if (++n > 30) break;          // Max 30×0.5 = 15 detik
}
```

**Proses:**
- `WiFi.begin()` — mulai proses konek ke WiFi yang udah ditentuin
- Loop `while` — nunggu sampe status jadi `WL_CONNECTED`
- `n > 30` — timeout 15 detik biar gak stuck selamanya
- Serial print titik-titik — biar keliatan progress di monitor

**Bedanya `WIFI_STA` vs `WIFI_AP`:** STation = client biasa (kayak HP lo konek WiFi rumah), AP = jadi hotspot (bikin WiFi sendiri).

### 1.6e MQTT — Siapin Koneksi ke HiveMQ Cloud

```cpp
espClient.setInsecure();             // TLS tanpa verifikasi sertifikat
mqttClient.setClient(espClient);     // Sambungin MQTT ke WiFi Secure
mqttClient.setServer(MQTT_BROKER, MQTT_PORT);  // Set server tujuan
mqttClient.setBufferSize(2048);      // Buffer 2048 byte ← cukup buat JSON besar

mqttClient.connect("apmbob-esp32", MQTT_USER, MQTT_PASS)
```

**Penjelasan:**
- `setInsecure()` — nerima sertifikat TLS apapun (praktis, tapi secara teknis kurang aman). Alternatifnya pake root CA.
- `setServer()` — ngasih tau alamat broker MQTT (HiveMQ Cloud) sama port-nya (8883 = TLS)
- `setBufferSize(2048)` — biar bisa kirim JSON yang lebih besar (data satelit bisa bikin payload gede)
- `.connect()` — bikin koneksi MQTT dengan client ID "apmbob-esp32"

**Apa itu buffer?** — memori sementara buat nampung data sebelum dikirim. 2048 byte ~ 2 kilobyte.

**Pasang callback + subscribe:**
```cpp
mqttClient.setCallback(mqttCallback);  // Fungsi yang dipanggil pas ada pesan masuk
mqttClient.subscribe(MQTT_TOPIC_ZONE); // Subscribe ke topic zone biar dapet konfigurasi
```

### 1.6f GPS — Nyalain NEO-6M

```cpp
Serial2.begin(9600, SERIAL_8N1, GPS_RX, GPIO17);  // Serial2: RX=16, TX=17, 9600 baud
```

**Serial2.begin(baud, config, RX, TX):**
- `9600` — NEO-6M default pake 9600 baud
- `SERIAL_8N1` — 8 bit data, No parity, 1 stop bit (standar)
- `GPS_RX (16)` — ESP32 RX = GPIO16 (nerima data dari GPS TX)
- `GPS_TX (17)` — ESP32 TX = GPIO17 (ngirim data ke GPS RX, jarang dipake)

## 1.7 Loop() — Jantung Program

```cpp
void loop() {
```

Fungsi `loop()` jalan terus-menerus dari atas ke bawah. Isinya:

### 1.7a Baca Data GPS

```cpp
while (Serial2.available() > 0) {
  char c = Serial2.read();           // Baca 1 karakter dari GPS
  gps.encode(c);                      // Feed ke TinyGPSPlus
  if (nmeaIdx < LINE_BUF - 1) nmeaBuf[nmeaIdx++] = c;  // Simpan ke buffer NMEA
  if (c == '\n') {                    // Akhir baris NMEA
    nmeaBuf[nmeaIdx] = '\0';
    parseGSV(nmeaBuf);                // Parse GSV manual
    nmeaIdx = 0;                      // Reset buffer
  }
}
```

**Alur:**
1. `Serial2.available()` — cek ada data masuk dari GPS?
2. `Serial2.read()` — ambil 1 karakter
3. `gps.encode(c)` — kasih ke TinyGPSPlus yang otomatis nge-parse lat/lng/speed dll
4. Simpen karakter ke `nmeaBuf` buat parsing GSV manual
5. Kalo ketemu newline (`\n`), berarti 1 baris NMEA selesai → panggil `parseGSV()`

**Kenapa manual GSV?** — TinyGPSPlus cuma bisa parsing data posisi, **gak bisa parsing detail satelit** (PRN, elevasi, azimuth, SNR). Jadi kita parse manual.

### 1.7b MQTT Reconnect

```cpp
if (mqttClient.connected()) {
  mqttClient.loop();                    // Jaga koneksi MQTT tetap hidup
} else if (WiFi.status() == WL_CONNECTED && millis() - lastMqttTry > 10000) {
  lastMqttTry = millis();
  if (mqttClient.connect("apmbob-esp32", MQTT_USER, MQTT_PASS)) {
    mqttClient.setCallback(mqttCallback);
    mqttClient.subscribe(MQTT_TOPIC_ZONE);
  }
}
```

**Logika:** Kalo MQTT putus, coba connect ulang tiap 10 detik. `mqttClient.loop()` penting biar koneksi tetep idup dan pesan masuk ke `mqttCallback`.

### 1.7c Timer Publish

```cpp
unsigned long interval = pernahFix && !gps.location.isValid() ? 10000 : 5000;
if (millis() - lastSend < interval) return;
lastSend = millis();
```

- Kalo **fix valid** → kirim tiap **5 detik**
- Kalo **fix hilang + pernah fix sebelumnya** → kirim tiap **10 detik** (data stale)
- `millis()` — fungsi yang ngasih jumlah milidetik sejak ESP32 nyala

**Selanjutnya** — kalo GPS valid, ambil data lat/lng/speed/heading, cek zone, bikin JSON, kirim MQTT. Kalo gak valid tapi pernah fix, kirim data terakhir pake mode `gps_stale`.

## 1.8 GSV Parsing (parseGSV) — Deep Dive

### NMEA Itu Kayak Apa?

NMEA adalah format text standar GPS. Contoh:

```
$GPGSV,3,1,12,02,41,130,34,05,12,052,29*7B
```

**Artinya:**
- `$GPGSV` — jenis kalimat (GPS Satellites in View)
- `3` — total ada 3 baris GSV
- `1` — ini baris ke-1
- `12` — total ada 12 satelit
- `02,41,130,34` — satelit pertama: PRN=02, elevasi=41°, azimuth=130°, SNR=34dB
- `05,12,052,29` — satelit kedua: PRN=05, elevasi=12°, azimuth=052°, SNR=29dB
- `*7B` — checksum (buat validasi data)

### Parser Code

```cpp
void parseGSV(const char* line) {
  if (strstr(line, "$GPGSV") == NULL) return;  // Bukan kalimat GSV, skip

  // Tokenize — potong string berdasarkan koma
  char buf[LINE_BUF];
  strcpy(buf, line);
  char* tokens[20];
  int tokCount = 0;
  char* p = strtok(buf, ",");
  while (p != NULL && tokCount < 20) {
    tokens[tokCount++] = p;
    p = strtok(NULL, ",");
  }

  if (tokCount < 4) return;

  int totalMsg = atoi(tokens[1]);   // Total baris GSV
  int msgNum = atoi(tokens[2]);     // Baris ke berapa
  int totalSats = atoi(tokens[3]);  // Total satelit
```

**Cara kerja `strtok`:** `strtok(string, ",")` ngambil potongan pertama sebelum koma. Panggil lagi pake `strtok(NULL, ",")` buat potongan berikutnya. Ini namanya **tokenize**.

**Kenapa `tokens[1]` bukan `tokens[0]`?** — `tokens[0]` itu alamat `$GPGSV` itu sendiri. Token 1 = totalMsg.

### Accumulator State Machine

GSV bisa sampai 3 baris kalo ada banyak satelit. Pake sistem accumulator:

```cpp
if (msgNum == 1) {
  gsvAccumCount = 0;                // Reset accumulator
  gsvTotalMsg = totalMsg;
}

// Parse 4 field per satelit
for (int i = 4; i + 3 < tokCount; i += 4) {
  if (gsvAccumCount >= MAX_SATS) break;
  gsvAccum[gsvAccumCount].prn = atoi(tokens[i]);
  gsvAccum[gsvAccumCount].elev = atoi(tokens[i + 1]);
  gsvAccum[gsvAccumCount].azim = atoi(tokens[i + 2]);
  gsvAccum[gsvAccumCount].snr = atoi(tokens[i + 3]);
  gsvAccumCount++;
}

if (msgNum == totalMsg) {           // Baris terakhir
  satCount = gsvAccumCount;          // Copy accumulator ke satList
  for (int i = 0; i < satCount; i++) {
    satList[i] = gsvAccum[i];
  }
}
```

**Kenapa pake accumulator?** Karena data satelit bisa tersebar di beberapa baris GSV. Kita kumpulin dulu di `gsvAccum`, baru finalisasi pas baris terakhir (msgNum == totalMsg).

**Bug yang pernah terjadi:** Waktu parsing awal, offset index-nya salah — `tokens[2]` dibaca sebagai totalMsg, padahal itu msgNum. Akibatnya accumulator gak pernah finalize dan data satelit kosong melulu.

## 1.9 Build JSON (buildSatJson)

```cpp
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
```

**`snprintf`** — fungsi buat nulis format string ke buffer. Mirip `printf()` tapi output-nya ke string, bukan ke serial. Aman karena dibatesin size buffer.

Format output: `"satellites":[{"p":2,"e":41,"a":130,"s":34},{"p":5,"e":12,"a":52,"s":29}]`

## 1.10 MQTT Callback (mqttCallback)

```cpp
void mqttCallback(char* topic, byte* payload, unsigned int len) {
```

Fungsi ini **dipanggil otomatis** setiap kali ada pesan MQTT masuk ke topic yang di-subscribe.

### Parsing Topic

```cpp
if (strcmp(topic, MQTT_TOPIC_ZONE) != 0) return;
```

`strcmp` membandingkan dua string. Kalo beda, fungsi keluar (`return`).

### Parsing JSON Manual

Karena ESP32 gak pake library JSON, parsing dilakukan manual pake `strstr`:

```cpp
char* p = strstr(buf, "\"centerLat\"");
if (p) { p = strchr(p, ':'); if (p) lat = atof(p + 1); }
```

**Cara kerja:**
1. `strstr()` — cari kata `"centerLat"` di dalam string
2. `strchr()` — cari karakter `:` pertama setelah kata itu
3. `atof()` — ubah string angka jadi float/double

**Kenapa gak pake library JSON (ArduinoJson)?** — hemat memori. Untuk tugas sesimpel parsing JSON zona, manual search udah cukup.

### Set Zone + Save NVS

```cpp
zoneCenterLat = lat;
zoneCenterLng = lng;
zoneRadius = rad;
zoneActive = act;
zoneManualMode = manual;
saveZonePrefs();    // Simpan ke NVS biar gak ilang
```

## 1.11 Haversine Distance

```cpp
float haversineDist(double lat1, double lng1, double lat2, double lng2) {
  double dLat = (lat2 - lat1) * DEG_TO_RAD;
  double dLng = (lng2 - lng1) * DEG_TO_RAD;
  double a = sin(dLat / 2) * sin(dLat / 2) +
             cos(lat1 * DEG_TO_RAD) * cos(lat2 * DEG_TO_RAD) *
             sin(dLng / 2) * sin(dLng / 2);
  double c = 2 * atan2(sqrt(a), sqrt(1 - a));
  return 6371000.0 * c;  // Meter
}
```

**Rumus Haversine** — cara hitung jarak antara 2 titik di permukaan bola (bumi). Hasilnya meter.

1. Ubah derajat ke radian (biar pake fungsi trigonometri)
2. Hitung selisih latitude dan longitude
3. Masukin ke rumus → dapet jarak
4. Kali radius bumi (6.371.000 meter) → dapet result dalam meter

## 1.12 Zone Logic

```cpp
if (zoneActive) {
  float dist = haversineDist(zoneCenterLat, zoneCenterLng, lastLat, lastLng);
  if (dist > zoneRadius) {
    if (!zoneViolated) {
      zoneViolated = true;
      digitalWrite(RELAY_PIN, LOW);    // LOW = relay ON = NC terbuka = LED mati
      Serial.printf("DILANGGAR! Jarak: %.1fm > %.0fm\n", dist, zoneRadius);
    }
  } else {
    if (zoneViolated && !zoneManualMode) {
      zoneViolated = false;
      digitalWrite(RELAY_PIN, HIGH);   // HIGH = relay OFF = NC tertutup = LED nyala
    }
  }
}
```

**Logika lengkap:**
1. Kalo zone aktif, hitung jarak posisi sekarang ke pusat zona
2. Kalo jarak > radius → violated!
   - Relay ON (`LOW`) → NC terbuka → **LED mati**
3. Kalo balik ke zona:
   - **Auto mode** → relay OFF → LED nyala lagi (otomatis)
   - **Manual mode** → LED tetap mati sampe di-reset dari dashboard

## 1.13 Payload Builder

```cpp
char buf[2048];
int pos = snprintf(buf, sizeof(buf),
  "{\"device\":\"apmbob-01\",\"lat\":%.6f,\"lng\":%.6f,\"speed\":%.1f,\"heading\":%.1f,\"sats\":%d,\"mode\":\"gps\","
  "\"zone\":{\"status\":\"%s\",\"active\":%d,\"radius\":%.0f,\"mode\":\"%s\"},",
  lastLat, lastLng, lastSpd, lastCog, lastSats,
  zoneStatus, zoneActive, zoneRadius, zoneManualMode ? "manual" : "auto");
buildSatJson(buf + pos, sizeof(buf) - pos);
int len = strlen(buf);
if (len < (int)sizeof(buf) - 2) {
  buf[len] = '}';        // Tutup JSON
  buf[len + 1] = '\0';
}
mqttClient.publish(MQTT_TOPIC, buf);
```

**Hasil JSON:**
```json
{
  "device": "apmbob-01",
  "lat": -6.590025,
  "lng": 106.810120,
  "speed": 0.8,
  "heading": 180.0,
  "sats": 8,
  "mode": "gps",
  "zone": {
    "status": "safe",
    "active": 1,
    "radius": 50,
    "mode": "auto"
  },
  "satellites": [
    {"p": 10, "e": 61, "a": 16, "s": 38},
    {"p": 23, "e": 59, "a": 108, "s": 37}
  ]
}
```

---

# 💻 BAGIAN 2 — NEXT.JS DASHBOARD

## 2.1 Kenapa `"use client"`?

Di baris pertama `page.tsx`:

```tsx
"use client";
```

**Apa itu?** — Next.js punya 2 jenis rendering: Server (SSR) sama Client. Komponen yang pake `"use client"` cuma jalan di **browser**, bukan di server.

**Kenapa perlu?** — Karena Leaflet dan MQTT library butuh `window` (objek browser). Kalo di-render di server, dia gak tau `window` itu apa, error.

## 2.2 Konstanta dari .env

```tsx
const MQTT_HOST = process.env.NEXT_PUBLIC_MQTT_HOST!;
const MQTT_USER = process.env.NEXT_PUBLIC_MQTT_USER!;
```

**`NEXT_PUBLIC_`** — prefix khusus Next.js. Variable yang pake prefix ini bakal **terekspos ke browser** (bisa dibaca JavaScript di sisi client).

**`!` (non-null assertion)** — ngasih tau TypeScript: "Percaya deh, ini gak null."

**`.env.local`** — file yang isinya variable environment. Gak di-commit karena ada di `.gitignore`.

## 2.3 TypeScript Interface

```tsx
interface SatData {
  p: number;
  e: number;
  a: number;
  s: number;
}

interface GpsData {
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  sats: number;
  mode: string;
  satellites?: SatData[];
  zone?: ZoneData;
}
```

**Interface** — kayak cetakan data. "GpsData harus punya lat (angka), lng (angka), speed (angka), dll." Biar data yang masuk terstruktur dan gak sembarangan.

**`?`** — optional. Jadi `satellites` bisa ada bisa gak.

## 2.4 Firebase Import

```tsx
const firebaseWrite = import("@/lib/firebase").then((fb) => fb).catch(() => null);
```

**Kenapa module-level (di luar component)?** — Biar Firebase cuma di-load sekali, bukan tiap kali render komponen. Kayak one-time setup.

**`.catch(() => null)`** — kalo Firebase gagal init (misal jaringan error), kita tetep jalan aja tanpa Firebase.

## 2.5 MQTT Client ID

```tsx
const getMqttClientId = () => {
  if (!mqttClientId) {
    mqttClientId = localStorage.getItem("mqttClientId");
    if (!mqttClientId) {
      mqttClientId = "web-" + Math.random().toString(36).substring(2, 10);
      localStorage.setItem("mqttClientId", mqttClientId);
    }
  }
  return mqttClientId;
};
```

**Kenapa pake `localStorage`?** — Biar client ID-nya tetap sama setiap kali buka browser. Kalo pake `Math.random()` terus, tiap reconnect dianggap client baru sama broker.

**Client ID stabil itu penting** — broker MQTT bisa tracking session client berdasarkan ID.

## 2.6 State & Ref — useState vs useRef

### Stale Closure — Kenapa Pake Ref?

**Masalah:** Kalo pake `useState`, nilai variable cuma bisa dibaca di dalam React component. Tapi kode di dalem `useEffect` (yang cuma jalan sekali pas mount) **mengunci** nilai variable di awal. Nilainya gak pernah update meskipun state berubah.

Contoh: Di `useEffect` pertama, kita bikin MQTT message handler. Di handler itu, kita pake `zoneCenterLat`. Tapi `zoneCenterLat` di-handler itu nilainya **null** terus, karena handler-nya udh terlanjur "mengunci" nilai awal.

**Solusi:** Pake `useRef` — nilai di ref bisa diubah kapan aja, dan handler yang udh terlanjur jalan tetep bisa baca nilai terbaru.

```tsx
const zoneRef = useRef({ L: null, circle: null, radius: 50, centerLat: null, centerLng: null, active: false, status: "inactive" });
```

**Perbedaan state vs ref:**
| useState | useRef |
|----------|--------|
| Kalo berubah, component di-render ulang | Kalo berubah, component TIDAK di-render ulang |
| Cocok buat yang ngaruh ke UI (text, warna) | Cocok buat nilai internal yang gak perlu render ulang |
| Stale closure di event handler | Gak ada stale closure |

### trailRefs

```tsx
const trailRefs = useRef<any>({ polyline: null, glowLine: null, startMarker: null, map: null, points: [] });
```

**Isinya:**
- `polyline` — garis trail utama
- `glowLine` — garis trail efek glow
- `startMarker` — marker titik awal
- `map` — objek peta Leaflet
- `points` — array kumpulan titik koordinat

### Syncing Ref tiap Render

```tsx
zoneRef.current.radius = zoneRadius;
zoneRef.current.centerLat = zoneCenterLat;
zoneRef.current.centerLng = zoneCenterLng;
zoneRef.current.active = zoneActive;
zoneRef.current.status = zoneStatus;
```

Ini **wajib** dilakukan di luar useEffect — biar ref selalu punya nilai terbaru dari state. Kalo gak gini, handler yang di dalem useEffect tetep null.

## 2.7 useEffect Pertama — Init

```tsx
useEffect(() => {
  Promise.all([import("leaflet"), import("mqtt")]).then(([leaf, mq]) => {
```

**`Promise.all`** — jalanin 2 import sekaligus, tunggu keduanya selesai. Ini karena Leaflet dan MQTT duaduanya di-dynamic import (biar gak error SSR).

### Map Init

```tsx
const L = leaf.default;
const map = L.map("map", { zoomControl: false }).setView([-6.4025, 106.7942], 14);
L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
}).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);
```

- `L.map("map", ...)` — bikin map Leaflet di elemen HTML dengan id `"map"`
- `.setView([lat, lng], zoom)` — set posisi awal (Bogor, zoom 14)
- `tileLayer` — provider peta (CartoDB Voyager)

### MQTT Connect

```tsx
const client = mqtt.connect(MQTT_HOST, {
  username: MQTT_USER,
  password: MQTT_PASS,
  clientId: getMqttClientId(),
});
```

**WebSocket** — dashboard pake port 8884 (WebSocket), beda dari ESP32 yang pake 8883 (TCP TLS). Soalnya browser cuma bisa WebSocket, bukan TCP langsung.

```tsx
client.on("connect", () => setStatus("connected"));
client.on("reconnect", () => setStatus("connecting"));
client.on("close", () => setStatus("disconnected"));
```

**Event listener** — dengerin perubahan status koneksi. Status ini ditampilin di sidebar dashboard (badge hijau/kuning/merah).

## 2.8 GPS Message Handler

Ini bagian paling kompleks — dipanggil tiap kali ada pesan MQTT masuk.

```tsx
client.on("message", (_topic, payload) => {
  try {
    const data: GpsData = JSON.parse(payload.toString());
    if (data.lat === 0 && data.lng === 0) return;   // Skip data invalid
```

**Flow handler:**
1. Parse JSON → jadi object JavaScript
2. Kalo lat/lng 0, skip (data gak valid)
3. Update state GPS, lastUpdate, gpsLost
4. Update zone status dari data ESP32
5. Tulis ke Firebase
6. Update marker di peta
7. Update trail polyline
8. Update zone circle

### Zone Status Update

```tsx
if (data.zone) {
  setZoneStatus(data.zone.status);
  setZoneActive(data.zone.active);
  setZoneRadius(data.zone.radius);
  setZoneManualMode(data.zone.mode === "manual");
  if (data.zone.active && data.lat && data.lng) {
    if (zoneRef.current.centerLat === null || zoneRef.current.centerLng === null) {
      setZoneCenterLat(data.lat);
      setZoneCenterLng(data.lng);
      zoneRef.current.centerLat = data.lat;
      zoneRef.current.centerLng = data.lng;
    }
  }
}
```

**PENTING:** Cek pake `zoneRef.current.centerLat` bukan `zoneCenterLat` — karena di dalem useEffect handler, variable state `zoneCenterLat` selalu null. Pake ref biar nilai yang dicek adalah nilai terkini.

### Firebase Write

```tsx
firebaseWrite.then((fb) => {
  if (!fb) return;
  fb.set(fb.ref(fb.db, "apmbob/tracker/latest"), {
    lat: data.lat,
    lng: data.lng,
    speed: data.speed,
    heading: data.heading,
    sats: data.sats,
    mode: data.mode,
    device: "apmbob-01",
  });
}).catch((e) => console.error("Firebase write error", e));
```

**Path tetap:** `apmbob/tracker/latest` — selalu overwrite, bukan bikin key baru tiap kali. Ini biar Firebase gak numpuk data dan kuota gak cepet habis.

### Marker (Pin di Peta)

```tsx
const icon = L.divIcon({
  className: "",
  html: `<div class="map-pin" style="background:${markerColor}"><i class="fa-solid fa-location-dot"></i></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 22],
});

if (!markerRef) {
  markerRef = L.marker(latlng, { icon }).addTo(map);
} else {
  markerRef.setIcon(icon);
  markerRef.setLatLng(latlng);
}
```

**`divIcon`** — ikon kustom pake HTML/CSS (bukan gambar). Jadinya bentuk teardrop pink.
**`iconAnchor`** — titik ujung pin (biar posisinya pas di koordinat).

### Trail Polyline

```tsx
// Glow trail
glowLine = L.polyline(trailPoints, {
  color: "#c6f91f", weight: 10, opacity: 0.25,
});

// Main trail
polyline = L.polyline(trailPoints, {
  color: "#ffdb00", weight: 4, opacity: 0.95,
});
```

**2 layer trail:**
- **Glow** — garis tebal (10px) warna kuning neon, transparan (0.25) — efek glow
- **Main** — garis tipis (4px) warna kuning, solid — jalur utama

### Trail Throttle (3 meter)

```tsx
const d = HAVERSINE_KM(lastPt[0], lastPt[1], latlng[0], latlng[1]) * 1000;
if (d < 3) shouldAddTrail = false;
```

**Kenapa?** — Biar trail gak terlalu rapat. Kalo jarak dari titik terakhir < 3 meter, skip. Hemat performa.

### Decimate (Kalo > 200 Titik)

```tsx
if (trailPoints.length > TRAIL_MAX) {
  const decimated = [];
  for (let i = 0; i < trailPoints.length; i += 2) decimated.push(trailPoints[i]);
  trailPoints.length = 0;
  trailPoints.push(...decimated);
}
```

**Kenapa?** — Biar trail gak numpuk. 200 titik max, kalo lebih, ambil tiap titik ke-2 (decimate). Ini lebih baik dari sekedar buang yang paling lama, karena coverage jalurnya tetep.

### Zone Circle

```tsx
const zr = zoneRef.current;
if (zr.circle) {
  if (data.zone?.active && zr.centerLat && zr.centerLng) {
    zr.circle.setLatLng([zr.centerLat, zr.centerLng]);
    zr.circle.setRadius(data.zone.radius);
    zr.circle.setStyle({
      color: data.zone.status === "violated" ? "#ff0000" : "#00e5ff",
    });
  } else {
    map.removeLayer(zr.circle);
    zr.circle = null;
  }
}
```

**Circle** — lingkaran Leaflet yang nunjukin area zona. Warna berubah merah kalo violated. Update lewat ref, bukan state, biar realtime.

### 2.8.1 GPS Noise Filter — Biar Peta Gak Goyang

> **Masalah:** NEO-6M akurasinya cuma ~2.5 meter. Meskipun alat diem di meja, koordinat yang dikirim tetep beda 1-5m tiap detik karena noise atmosfer & multipath. Akibatnya marker di map goyang terus.

**Solusi:** Filter pake threshold jarak:

```tsx
const stableLatlng = useRef<[number, number] | null>(null);
const MOVE_THRESHOLD_M = 5;   // marker & trail
const PAN_THRESHOLD_M = 15;   // map pan (geser peta)
```

**Cara kerjanya:**
1. Setiap ada data GPS masuk, hitung jarak dari `stableLatlng` terakhir pake rumus Haversine
2. Kalo jaraknya < 5m → anggap noise, jangan update marker & trail
3. Kalo jaraknya >= 5m → update marker & trail, simpan posisi baru sebagai `stableLatlng`
4. Kalo jaraknya >= 15m → baru peta ikut geser (pan)

```tsx
// Hitung jarak dari posisi stabil terakhir
const distMoved = stableLatlng.current
  ? HAVERSINE_KM(stableLatlng.current[0], stableLatlng.current[1], latlng[0], latlng[1]) * 1000
  : Infinity;
const isMoved = distMoved >= MOVE_THRESHOLD_M;
```

**Kenapa threshold-nya beda?**
- **Marker 5m** — NEO-6M noise maksimal ~4m. Threshold 5m = gak goyang pas diem, tapi respon kalo jalan 3-4 langkah
- **Pan 15m** — Peta gak perlu ikut geser tiap kali marker bergerak dikit. Bayangin lo lagi zoom ke suatu titik, terus peta loncat-loncat tiap detik — bikin pusing. Peta cuma geser kalo alat beneran pindah agak jauh.
- **Sidebar** (speed, sats, heading) **gak kena filter** — biar realtime

**Yang gak kena filter:**
```tsx
setGps(data);           // ⚡ selalu update — sidebar tetap hidup
setLastUpdate(...);     // ⚡ selalu update — timestamp terakhir
```

**Yang kena filter:**
```tsx
markerRef.setLatLng(latlng);  // cuma kalo isMoved == true
map.panTo(latlng);            // cuma kalo distMoved >= 15m
trailPoints.push(latlng);     // cuma kalo isMoved == true
```

**Kenapa pake `useRef` buat `stableLatlng`, bukan `useState`?** — Karena `stableLatlng` cuma dipake di dalem callback MQTT (bukan buat render UI). Pake state malah trigger re-render gak perlu.

## 2.9 Auth Guard

```tsx
const { user, loading: authLoading, logout } = useAuth();
const router = useRouter();

useEffect(() => {
  if (!authLoading && !user) router.replace("/login");
}, [user, authLoading, router]);

if (authLoading) return <LoadingSpinner />;
if (!user) return null;
```

**Alur:**
1. Cek status auth (loading/user/kosong)
2. Kalo lagi loading → tampilkan spinner
3. Kalo gak ada user → redirect ke halaman login
4. Kalo ada user → tampilkan dashboard

## 2.10 Zone UI Panel

### Toggle ON/OFF

```tsx
onClick={() => {
  const next = !zoneActive;
  setZoneActive(next);
  if (!next) setZoneStatus("inactive");
  publishZone({ active: next });
  if (zoneCenterLat != null && zoneCenterLng != null) {
    zUpdateMap(zoneCenterLat, zoneCenterLng, zoneRadius, next, next ? "safe" : "inactive");
  }
}}
```

**Guard penting:** `if (zoneCenterLat != null && zoneCenterLng != null)` — kalo null, jangan update map (biar gak bikin circle di tengah laut dengan koordinat 0,0).

### Publish Zone ke MQTT

```tsx
const publishZone = (overrides?: Record<string, any>) => {
  const zr = zoneRef.current;
  const lat = overrides?.centerLat ?? zr.centerLat ?? gps?.lat ?? 0;
  const lng = overrides?.centerLng ?? zr.centerLng ?? gps?.lng ?? 0;
  const payload = JSON.stringify({ action, centerLat: lat, centerLng: lng, radius: rad, active: act, mode });
  mqttRef.current.publish(MQTT_TOPIC_ZONE, payload);
};
```

**`??` (nullish coalescing)** — pake nilai pertama yang bukan null/undefined.

### zUpdateMap — Update Circle

```tsx
const zUpdateMap = (lat: number, lng: number, rad: number, act: boolean, stat: string) => {
  const zr = zoneRef.current;
  const map = trailRefs.current.map;
  if (!zr.L || !map) return;
  if (act && lat && lng) {
    if (!zr.circle) {
      zr.circle = zr.L.circle([lat, lng], { ... }).addTo(map);
    } else {
      zr.circle.setLatLng([lat, lng]);
      zr.circle.setRadius(rad);
    }
  } else if (zr.circle) {
    map.removeLayer(zr.circle);
    zr.circle = null;
  }
};
```

Fungsi ini dipanggil dari event handler button (toggle, slider, set posisi, reset). Update circle langsung tanpa nunggu MQTT round-trip.

## 2.11 GPS Lost Timer

```tsx
useEffect(() => {
  if (!gpsLost) return;
  const timer = setInterval(() => {
    setGpsLostSec(Math.floor((Date.now() - lastFixTime.current) / 1000));
  }, 1000);
  return () => clearInterval(timer);
}, [gpsLost]);
```

**Efisien:** Timer cuma jalan kalo GPS beneran lost. Kalo fix lagi, timer berhenti. `clearInterval` di cleanup biar gak bocor memory.

---

# 🔐 BAGIAN 3 — FIREBASE AUTH

## 3.1 Firebase Config & Init

```tsx
const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
const db = getDatabase(app);
const auth = getAuth(app);
```

**`getApps().length ? getApp() : initializeApp(...)`** — Next.js hot-reload bisa bikin Firebase init berkali-kali. Ini mencegahnya dengan ngecek apakah udah pernah di-init.

**Apa itu Auth?** — Firebase Authentication, layanan login bawaan Firebase. Kita pake Email/Password.

## 3.2 Auth Provider

```tsx
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  const login = async (email: string, password: string) => {
    await signInWithEmailAndPassword(auth, email, password);
  };

  const logout = async () => {
    await signOut(auth);
  };
```

**`onAuthStateChanged`** — listener Firebase yang otomatis kepanggil kalo status login berubah. Kalo user login, dapet object User. Kalo logout, dapet null.

**`useContext`** — provider biar semua component anak bisa pake `useAuth()` buat dapet user/login/logout.

## 3.3 Login Page

```tsx
const handleSubmit = async (e: FormEvent) => {
  e.preventDefault();
  setError("");
  setLoading(true);
  try {
    await login(email, password);
    router.push("/");         // Redirect ke dashboard
  } catch (err: any) {
    setError("Email atau password salah");
  }
};
```

**`e.preventDefault()`** — biar form gak reload halaman pas di-submit.

**Error handling:** Kalo Firebase login gagal (salah pass, email gak terdaftar, dll), tangkap error-nya dan tampilkan pesan user-friendly.

## 3.4 Route Protection

Di layout.tsx, semua halaman dibungkus AuthProvider:

```tsx
<AuthProvider>{children}</AuthProvider>
```

Di page.tsx (halaman utama), kalo gak login → redirect ke `/login`:

```tsx
if (!authLoading && !user) router.replace("/login");
```

Di halaman login, kalo udah login → redirect ke `/`:

```tsx
await login(email, password);
router.push("/");
```

---

# 📁 BAGIAN 4 — FILE LAINNYA

## secrets.h

File template buat kredensial ESP32:

```cpp
#ifndef SECRETS_H
#define SECRETS_H

#define WIFI_SSID "NamaWiFi"
#define WIFI_PASS "PasswordWiFi"

#define MQTT_BROKER "broker.hivemq.cloud"
#define MQTT_PORT 8883
#define MQTT_USER "username"
#define MQTT_PASS "password"

#endif
```

File ini HARUS ditambahin ke `.gitignore` biar gak ke-commit.

## .env.local & .env.example

`env.local` isinya konfigurasi dashboard. `.env.example` sebagai template (bisa di-commit):

```
NEXT_PUBLIC_MQTT_HOST=wss://broker.hivemq.cloud:8884/mqtt
NEXT_PUBLIC_MQTT_USER=username
NEXT_PUBLIC_MQTT_PASS=password
```

**Kenapa `.env*` di gitignore?** — `.env.local` isinya kredensial, jangan sampe ke-commit. Tapi `.env.example` di-exception biar bisa di-commit sebagai panduan.

## vercel.json

```json
{
  "framework": "nextjs",
  "buildCommand": "next build --webpack",
  "outputDirectory": ".next",
  "installCommand": "npm install"
}
```

Konfigurasi deployment ke Vercel. `--webpack` karena environment ini gak support SWC (WASM binding error).

## globals.css — Neo-Brutalist

```css
.neo-border {
  border: 3px solid #000;
}

.neo-shadow {
  box-shadow: 6px 6px 0px 0px #000;
}
```

**Neo-Brutalist:** style desain yang pake border hitam tebal, shadow kotak, warna kontras. Terinspirasi dari poster tahun 80-an.

```css
body {
  background-image: radial-gradient(#000000 1px, transparent 1px);
  background-size: 20px 20px;
}
```

**Dot grid:** background bintik-bintik hitam. Dibikin pake radial gradient — bikin lingkaran 1px tiap 20px.

---

# ❓ FAQ — Pertanyaan yang Mungkin Muncul

## 🔸 GPS Kok Kelamaan Dapet Fix?

- NEO-6M cold start butuh **30-60 detik** (kalo dari mati total)
- **Butuh view langit terbuka** — di dalem ruangan susah
- Minimal **4 satelit** dengan SNR ≥ 20dB biar dapet fix 3D
- Kalo pake CR1220 battery backup, hot start cuma 1-2 detik

## 🔸 Kenapa Satelit Pindah-Pindah Terus?

Itu normal. GPS satelit orbit di ketinggian 20.200 km dengan kecepatan 3.9 km/detik. Mereka naik (rise) dan tenggelam (set) di horizon kayak matahari. Komposisi satelit yang terlihat berubah terus.

## 🔸 GPS Noise — Kenapa Posisi di Peta Goyang-Goyang?

Ini **bukan error**, tapi keterbatasan hardware GPS consumer-grade:

**Penyebab:**
1. **Akurasi NEO-6M** cuma ~2.5m (CEP50) — 50% posisi yang dilaporkan bisa meleset sampai 2.5m
2. **Atmospheric interference** — sinyal satelit melambat & membelok di ionosfer/troposfer
3. **Multipath** — sinyal GPS mantul dari gedung, tembok, atau pohon sebelum nyampe antena
4. **GDOP** (Geometric Dilution of Precision) — posisi satelit di langit mempengaruhi akurasi. Kalo ngumpul di satu area, akurasinya jelek

**Solusi di kode:** GPS noise filter pake 2 threshold:
- **Marker & trail** — hanya update kalo jarak ≥ 5m (`MOVE_THRESHOLD_M`)
- **Map pan** — hanya geser kalo jarak ≥ 15m (`PAN_THRESHOLD_M`)

Kalo masih kurang stabil, lo bisa naikin threshold di `page.tsx`:
```tsx
const MOVE_THRESHOLD_M = 10;  // marker gerak kalo >= 10m
const PAN_THRESHOLD_M = 30;   // peta geser kalo >= 30m
```

**Yang gak kena filter:** speed, heading, sats, lastUpdate — tetap realtime.

## 🔸 MQTT Sering Gagal Konek?

- **WiFi port blocker** — beberapa WiFi (hotspot, kampus) blokir port 8883. Coba ganti WiFi.
- **DNS error** — cek `MQTT_BROKER` resolve gak.
- **Kredensial salah** — cek username/password di secrets.h.

## 🔸 Firebase Permission Denied?

Buka Firebase Console → Realtime Database → Rules → set:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

Ini penting — Firebase defaultnya ngunci semua akses.

## 🔸 Relay/LED Gak Mau Nyala?

Cek:
1. **Wiring** — COM → LED (+), NC → LED (-)
2. **GPIO 25** udah bener pinnya?
3. **Relay LOW-trigger** — GPIO LOW = relay ON. Kalo lo mau relay ON, harus kirim LOW.
4. **LED butuh resistor** — jangan sambung LED langsung ke relay tanpa resistor (bisa rusak)

## 🔸 LED Mati Padahal Lagi di Zona (Aman)?

Periksa ulang logika:
- **Aman** = `GPIO HIGH` = relay OFF = NC tertutup = **LED nyala**
- **Melanggar** = `GPIO LOW` = relay ON = NC terbuka = **LED mati**

Kalo LED mati saat aman, berarti wiring-nya pake **NO (Normally Open)** bukan NC.

## 🔸 GPS Ngelaporin Stale Terus?

Fix hilang. Penyebab:
- Masuk terowongan/parkiran basement
- Bangunan tinggi nge-block sinyal
- Antena GPS ketutup casing logam
- Power drop ke GPS

Data stale tetep dikirim pake posisi terakhir — jadi dashboard gak kehilangan track.

## 🔸 ESP32 Restart Terus?

Pernah terjadi karena SIM800L narik arus > 2A dan nge-trigger **brownout detector** ESP32. Solusi: pastikan power supply cukup (minimal 2A kalo pake SIM800L).

---

> *Dokumentasi ini dibuat step-by-step biar siapapun — bahkan yang baru pertama kali liat kode ESP32 & Next.js — bisa paham.*
>
> *Ada yang kurang jelas? Buka aja kode langsung, trace satu-satu, dan eksperimen. Pelajaran terbaik adalah dari praktek langsung.*
