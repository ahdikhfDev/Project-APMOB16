# 🚗 APMOB GPS Tracker — Project APMOB 16

Sistem pelacakan kendaraan **real-time** berbasis **ESP32 + NEO-6M GPS** dengan dashboard web **Next.js**, komunikasi **MQTT via HiveMQ Cloud**, dan penyimpanan data **Firebase Realtime Database**.

---

## 📋 Daftar Isi

- [Arsitektur Sistem](#-arsitektur-sistem)
- [Hardware](#-hardware)
- [Fitur](#-fitur)
- [Cara Kerja](#-cara-kerja)
- [Komponen Kode](#-komponen-kode)
- [Setup & Instalasi](#-setup--instalasi)
- [Dashboard Web](#-dashboard-web)
- [Perjalanan Kode & Pelajaran](#-perjalanan-kode--pelajaran)
- [📘 MODE BELAJAR — Panduan Lengkap Kode](./MODE_BELAJAR.md)
- [FAQ / Troubleshooting](#-faq--troubleshooting)
- [Lisensi](#-lisensi)

---

## 🏗 Arsitektur Sistem

```
┌──────────────────┐     MQTT (TLS 8883)     ┌──────────────┐     Firebase RTDB     ┌──────────────┐
│   ESP32 + GPS +  │ ──────────────────────→ │  HiveMQ Cloud │ ←────────────────── │  Dashboard   │
│   Relay/LED      │  apmbob/tracker/gps     │   (Broker)   │                     │  Next.js Web │
│                  │  apmbob/tracker/zone    │              │                     │              │
└────────┬─────────┘                          └──────────────┘                     └──────┬───────┘
         │ WiFi (ciwak)                                                                    │
         └─────────────────────────────────────────────────────────────────────────────────┘
                                    MQTT WebSocket (8884)
```

- **ESP32** membaca data GPS via Serial2, mengontrol relay GPIO25, mengirim ke HiveMQ Cloud
- **Dashboard Next.js** subscribe MQTT via WebSocket (port 8884), menampilkan peta & data real-time
- **Firebase RTDB** menyimpan posisi terkini di `apmbob/tracker/latest`
- **Auth** login via Firebase Email/Password sebelum akses dashboard

---

## 🔧 Hardware

| Komponen | Fungsi | Pin ESP32 |
|----------|--------|-----------|
| **ESP32 DOIT DEVKIT V1** | Mikrokontroler utama | — |
| **NEO-6M GPS Module** | Mendapatkan koordinat, kecepatan, heading | RX2=16, TX2=17 |
| **JQC-3FF-S-Z Relay** | Kontrol LED/alarm zona keamanan | GPIO25 (LOW=trigger) |

### Wiring GPS NEO-6M

| NEO-6M | ESP32 |
|--------|-------|
| VCC | 3.3V |
| GND | GND |
| TX | GPIO16 (RX2) |
| RX | GPIO17 (TX2) |

> **Catatan:** Baud rate GPS = **9600 bps**. LED NEO-6M berkedip 1 detik saat fix didapat.

### Wiring Relay JQC-3FF-S-Z

| Relay | ESP32 / LED |
|-------|-------------|
| VCC | 3.3V |
| GND | GND |
| IN | GPIO25 |
| COM | ke (+) BATRE |
| NC | ke (+) LED (Normally Closed — LED menyala saat relay OFF) |

> **Logika:** Relay **LOW-trigger**. LED dipasang ke **COM & NC**:
> - `GPIO HIGH` = relay OFF → NC tertutup → **LED menyala** (dalam zona)
> - `GPIO LOW` = relay ON → NC terbuka → **LED mati** (melanggar zona)

### Wiring SIM800L V2 *(jika digunakan)*

| SIM800L | ESP32 |
|---------|-------|
| VCC | 5V |
| GND | GND |
| TXD | GPIO26 (Serial1 RX) |
| RXD | GPIO27 (Serial1 TX) |
| RST | GPIO14 |

> **Catatan:** SIM800L butuh arus 2A peak — pastikan power supply cukup.

---

## ✨ Fitur

### ✅ Real-time GPS Tracking
- Posisi (lat/lng), kecepatan (km/h), heading (arah)
- Update setiap 5 detik (real) / 10 detik (stale/no fix)
- **Marker mobil** di peta yang bergerak otomatis

### ✅ GPS Noise Filter (Stabilisasi Peta)
- **Marker & trail**: hanya update jika pergerakan > **5 meter** — GPS noise NEO-6M (~2.5m) diabaikan
- **Map pan (peta geser)**: hanya geser jika pergerakan > **15 meter** — peta tetap stabil saat alat diem
- **Sidebar (speed/sats/heading)**: tetap real-time, tidak kena filter

### ✅ Detail Satelit
- **GSV Parsing** — membaca langsung dari NMEA `$GPGSV` 
- Menampilkan: **PRN**, **elevasi**, **azimuth**, **SNR** (signal strength)
- 5-level signal bars dengan warna: hijau ≥40dB, kuning 20-40dB, merah <20dB

### ✅ Trail / Jejak Pergerakan
- **Polyline** putus-putus merah mengikuti semua titik GPS
- Berubah abu-abu saat sinyal GPS hilang

### ✅ GPS Lost Detection
- Banner **"GPS LOST"** animasi merah saat satelit hilang
- Timer **MM:SS** sejak fix terakhir
- Marker & polyline berubah **abu-abu**
- Data tetap dikirim dengan `mode: "gps_stale"` (30 detik)

### ✅ MQTT ke HiveMQ Cloud
- TLS port 8883 (ESP32) / WebSocket port 8884 (dashboard)
- Auto-reconnect saat WiFi terputus

### ✅ Firebase Realtime Database
- Semua data GPS otomatis tersimpan di Firebase
- Path: `apmbob/tracker/{timestamp}`
- Data siap untuk history & analisis

### ✅ Geo-Fence Zone (Keamanan)
- Relay/LED on GPIO25 — **mati** saat kendaraan keluar zona (NC terbuka)
- Radius zona bisa diatur 5–500m dari dashboard
- **Auto mode** — relay mati otomatis saat kembali ke zona
- **Manual mode** — relay tetap menyala sampai di-reset dari dashboard
- Lingkaran zona ditampilkan real-time di peta Leaflet
- Konfigurasi zona tersimpan di NVS ESP32 — tidak hilang setelah restart

### ✅ Firebase Auth (Email/Password)
- Halaman login dengan autentikasi Firebase
- Proteksi dashboard — redirect ke `/login` jika belum login
- Tombol logout di sidebar

### ✅ Dashboard Neo-Brutalist
- Desain border hitam tebal, shadow kotak, warna neon
- Font Space Grotesk
- Background dot grid

---

## 🧠 Cara Kerja

### 1. Baca GPS (NEO-6M)
```
NEO-6M ──(Serial2, 9600 baud)──→ ESP32
```
- ESP32 membaca data NMEA mentah dari Serial2
- Feed ke **TinyGPSPlus** untuk parsing koordinat, kecepatan, heading
- Feed ke **GSV Parser** manual untuk detail satelit (PRN, elevasi, SNR)

### 2. Kirim ke MQTT
```
ESP32 ──(TLS, port 8883)──→ HiveMQ Cloud
```
- Format JSON:
```json
{
  "device": "apmbob-01",
  "lat": -6.6409,
  "lng": 106.8553,
  "speed": 0.8,
  "heading": 180.0,
  "sats": 8,
  "mode": "gps",
  "satellites": [
    {"p": 10, "e": 61, "a": 16, "s": 38},
    {"p": 23, "e": 59, "a": 108, "s": 37}
  ]
}
```
- `mode: "gps"` = fix valid
- `mode: "gps_stale"` = fix hilang, data adalah posisi terakhir
- `zone` field — status zona, radius, mode (auto/manual)

### 2b. Zone Logic (ESP32)
```
ESP32 ──(GPIO25)──→ Relay/LED
```
- ESP32 menerima konfigurasi zona via MQTT topic `apmbob/tracker/zone`
- Menghitung jarak Haversine antara posisi GPS dan pusat zona
- Jika jarak > radius → `digitalWrite(RELAY_PIN, LOW)` → relay ON → NC terbuka → **LED mati** (violated)
- Jika kembali ke zona + mode **auto** → relay OFF → NC tertutup → **LED nyala** (safe)
- Mode **manual** → relay tetap ON (LED mati) sampai ada perintah `reset` dari dashboard

### 3. Dashboard Web
```
HiveMQ Cloud ──(WebSocket, port 8884)──→ Next.js (browser)
```
- Dashboard subscribe ke topic MQTT via WebSocket
- Update peta Leaflet, marker, polyline, dan sidebar secara real-time
- GPS noise filter dual-threshold:
  - **5 meter** — marker posisi & trail hanya bergerak jika GPS berpindah ≥5m (abaikan noise NEO-6M ~2.5m)
  - **15 meter** — peta hanya geser (pan) jika pergerakan ≥15m (peta tetap di posisi saat alat diem)
- Sidebar (speed, sats, heading) tetap update di setiap pesan — tidak kena filter
- Tulis setiap data ke Firebase untuk persistensi

---

## 📁 Komponen Kode

### ESP32 — `Apmbob-Tracker/src/main.cpp`
| Fungsi | Deskripsi |
|--------|-----------|
| `setup()` | Inisialisasi WiFi, MQTT, GPS, SIM800L |
| `loop()` | Baca GPS, reconnect MQTT, kirim data periodik |
| `parseGSV()` | Parse manual NMEA `$GPGSV` untuk detail satelit |
| `buildSatJson()` | Bangun JSON array satelit untuk payload MQTT |
| `mqttCallback()` | MQTT subscribe — parse zone config JSON + NVS save |
| `haversineDist()` | Hitung jarak posisi GPS ke pusat zona (meter) |
| `loadZonePrefs()` / `saveZonePrefs()` | Baca/tulis zona ke NVS Preferences — persist antar restart |

### Next.js — `apmbob-web/src/app/page.tsx`
| Bagian | Deskripsi |
|--------|-----------|
| `MQTT client` | Koneksi WebSocket ke HiveCloud, subscribe topic |
| `Leaflet map` | Map with tile layer, marker, zoom control |
| `Polyline` | Trail pergerakan (glow + main line) |
| `Satellite panel` | Daftar satelit dengan signal bars 5 level |
| `Firebase write` | Cached dynamic import, write ke `apmbob/tracker/latest` |
| `GPS Lost timer` | Interval 1 detik update timer saat sinyal hilang |
| `GPS noise filter` | `MOVE_THRESHOLD_M=5` (marker/trail), `PAN_THRESHOLD_M=15` (map pan) |
| `Zone panel` | Slider radius, toggle ON/OFF, mode Auto/Manual, Set Posisi, Reset |
| `Zone circle` | Leaflet circle via ref — update realtime tanpa React state |
| `Auth guard` | Firebase Email/Password — redirect ke `/login` jika belum login |

### Firebase — `apmbob-web/src/lib/firebase.ts`
- Init Firebase dengan credentials project
- Export database instance

---

## 🚀 Setup & Instalasi

### Prasyarat
- Node.js ≥ 18
- PlatformIO (VSCode extension)
- Git

### 1. Clone Repository
```bash
git clone https://github.com/ahdikhfDev/Project-APMOB16.git
cd Project-APMOB16
```

### 2. ESP32 — Upload Firmware
1. Buka folder `Apmbob-Tracker` di VSCode (dengan PlatformIO)
2. Buat file `src/secrets.h` dari template berikut:
   ```cpp
   #ifndef SECRETS_H
   #define SECRETS_H

   #define WIFI_SSID "NamaWiFi"
   #define WIFI_PASS "PasswordWiFi"

   #define MQTT_BROKER "202f37f7e67c4292b30a95877382225e.s1.eu.hivemq.cloud"
   #define MQTT_PORT 8883
   #define MQTT_USER "kelompok16"
   #define MQTT_PASS "Kelompok16"

   #endif
   ```
3. Klik **Upload** (panah kanan bawah) atau:
   ```bash
   pio run --target upload
   ```

### 3. Dashboard Web — Install & Jalankan
```bash
cd apmbob-web
npm install
npm run dev
```
Buka browser di `http://localhost:3000`

### 4. Environment Variables
Dashboard menggunakan `.env.local` untuk konfigurasi (jangan di-commit):
```bash
cd apmbob-web
cp .env.example .env.local
# Edit .env.local sesuai kredensial lo
```

### 5. Firebase (optional)
- Buka **Firebase Console** → Realtime Database → Rules:
  ```json
  {
    "rules": {
      ".read": true,
      ".write": true
    }
  }
  ```
- Buka **Authentication** → Sign-in method → **Email/Password** → **Enable**
- Tambah user di tab **Users** → **Add user**

---

## 🖥 Dashboard Web

### Layout
- **Sidebar (kiri):** GPS LOST banner, status koneksi, kecepatan, satelit, arah, koordinat, terakhir update
- **Map (kanan):** Full-screen Leaflet map dengan marker & trail

### Screenshot (deskripsi)
- Marker pink berbentuk icon mobil
- Polyline putus-putus merah (jejak pergerakan)
- Panel satelit dark mode dengan signal bars
- Banner merah **"GPS LOST"** saat satelit hilang

### Konfigurasi MQTT (jika ingin ganti broker)
Di `.env.local`:
```
NEXT_PUBLIC_MQTT_HOST=wss://broker-anda.hivemq.cloud:8884/mqtt
NEXT_PUBLIC_MQTT_USER=username
NEXT_PUBLIC_MQTT_PASS=password
```

---

## 📖 Perjalanan Kode & Pelajaran

Dokumentasi proses belajar dari awal sampai akhir — biar lo paham gimana struggle dan fix yang dilakuin.

---

### 🥾 Awal: SIM800L Gagal Total

**Masalah:** `+CME ERROR: 10` — SIM not detected.

**Yang udah dicoba:**
1. Konek 5VIN dari USB ESP32 → gagal
2. Ganti baud 9600, 115200, 57600, dll → module echo `AT` tapi gak pernah `OK`
3. Ganti pin RX/TX dari GPIO16/17 → GPIO26/27 (Serial1)
4. Tambah auto-detect baud → tetep gak bisa
5. Tambah PWRKEY simulation → butuh hardware

**Kesimpulan:** SIM800L butuh **arus 2A peak**. USB laptop (~500mA) cukup buat echo tapi gak cukup buat boot GSM processor. Solusi: power bank dedicated atau kapasitor 1000µF. Sementara **fallback ke WiFi**.

**Pelajaran:**
- Jangan percaya multimeter aja — ukur arus juga, bukan cuma tegangan
- SIM800L V2 butuh arus gede banget pas register ke BTS
- `Serial1.begin(baud, config, RX, TX)` di ESP32 itu fleksibel — bisa pake pin mana aja

---

### 🗺 GPS NEO-6M: Dari Nol ke Fix

**Masalah:** GPS gak dapet fix — padahal LED kedip-kedip.

**Yang dipelajari:**
- LED kedip 1 detik = **mencari** satelit, BUKAN berarti fix
- LED mati/kedip lambat = **fix didapat**
- Minimal **4 satelit** dengan SNR ≥ 20 dB buat fix 3D
- Butuh **view langit terbuka** — dalem ruangan susah dapet fix

**Pelajaran:**
- `$GPRMC` status `V` = Void (no fix), `A` = Active (fix)
- Cold start NEO-6M butuh ~30-60 detik
- Satelit di bawah elevasi 10° biasanya noise — SNR rendah

---

### 📡 Parsing GSV: Elevasi & Azimuth Fix yang Ribet

Ini bagian paling seru — dari data satelit mentah sampe tampil di dashboard.

#### Step 1: Nemu ada GSV di NMEA

```
$GPGSV,3,1,12,02,41,130,34,05,12,052,29*7B
```

Awalnya cuma liat `gps.satellites.value()` — jumlah satelit doang. Padahal di GSV ada:
- **PRN** (nomor ID satelit)
- **Elevasi** (derajat dari horizon)
- **Azimuth** (derajat dari utara)
- **SNR** (signal strength 0-99 dB)

#### Step 2: Parse manual — karena TinyGPSPlus gak support detail satelit

Bikin fungsi `parseGSV()` yang:
1. Nangkep raw NMEA line dari `Serial2`
2. Split by koma
3. Ambil totalMsg, msgNum, totalSats
4. Loop 4 field per satelit

**Bug pertama: index offset salah**

```cpp
// SALAH — header field index geser 1
int totalMsg = atoi(tokens[2]);  // dapet msgNum, bukan totalMsg!
int msgNum = atoi(tokens[3]);    // dapet totalSats!
int totalSats = atoi(tokens[4]); // dapet PRN satelit pertama!
// for loop mulai dari i=5, salah juga
```

Akibat: `msgNum == 1` gak pernah true → accumulator **gak pernah reset** + **gak pernah finalize** → `satList` selalu kosong → dashboard nunjukin "Mencari satelit..." terus.

**Fix:**
```cpp
// BENAR — GSV format: $GPGSV,total,msgNum,satInView,prn,elev,azim,snr,...
int totalMsg = atoi(tokens[1]);  // ✅
int msgNum = atoi(tokens[2]);    // ✅
int totalSats = atoi(tokens[3]); // ✅
for (int i = 4; i + 3 < tokCount; i += 4)  // ✅ satelit mulai dari index 4
```

#### Step 3: GSV multi-message accumulator

GSV bisa 1-3 baris (kalo banyak satelit). Pake accumulator:
- `msgNum == 1` → reset accumulator
- `msgNum == totalMsg` → copy accumulator ke satList (finalize)
- Di antaranya → accumulate

**Debug:** tambah `Serial.printf("[GSV] Complete: %d sats parsed\n", satCount)` biar kelihatan di serial

#### Step 4: Dashboard rendering

Data sampe di dashboard sebagai:
```json
"satellites":[{"p":10,"e":61,"a":16,"s":38}, {"p":23,"e":59,"a":108,"s":37}]
```

(p = PRN, e = elevasi, a = azimuth, s = SNR)

Di React, sorting by SNR descending, render signal bars 5 level:
- SNR ≥ 40 dB → hijau 🟢 (sinyal kuat)
- SNR 20-40 dB → kuning 🟡 (cukup)
- SNR < 20 dB → merah 🔴 (lemah)

**Pelajaran:**
- NMEA itu cuma text dipisah koma — tinggal `strtok` / split manual
- `atoi()` berhenti otomatis di karakter non-angka — `"29*7B"` → `29`
- GSV multi-message butuh accumulator state machine
- GSV parsing ini ngajarin: **jangan percaya offset index**, trace pake contoh nyata

---

### 🔌 WiFi: Port 8883 Diblokir

**Masalah:** MQTT gagal — `espClient.connect` return error.

**Penyebab:** WiFi tertentu (hotspot HP, WiFi kampus/kantor) **memblokir port non-standar**.

**Yang dipelajari:**
- Port **8883** (MQTT TLS) bukan port umum kayak 80/443
- Coba ganti WiFi — ada yang allow, ada yang block
- **Solusi:** pake WiFi "HiFi MQ" dan "AsepDanSiti" — port 8883 terbuka
- Dashboard pake **WebSocket port 8884** (beda port dari ESP32)

**Pelajaran:**
- Kalo MQTT gagal, pertama cek DNS, kedua cek port
- Browsergate WebSocket (`wss://`) otomatis lewat port 443 kalo pake HiveMQ Cloud — lebih aman
- ESP32 pake `WiFiClientSecure` + `setInsecure()` buat TLS tanpa sertifikat

---

### 🖥 Dashboard: Next.js + Leaflet + MQTT

**Masalah:** Leaflet & MQTT library pake `window` — error pas SSR (Server Side Rendering).

**Fix:**
```javascript
// Import dinamis di dalem useEffect — cuma jalan di browser
Promise.all([import("leaflet"), import("mqtt")])
  .then(([leaf, mq]) => {
    const L = leaf.default;
    const mqtt = mq.default;
    // ...
  });
```

**Masalah Firebase:** Path error karena karakter `.` di ISO timestamp.
```
Firebase: Paths can't contain ".", "#", "$", "[", or "]"
```

**Fix:** Pake `Date.now()` (angka murni) sebagai key — `apmbob/tracker/1779372140685`

---

### 🔥 Firebase: Permission Denied

**Masalah:** `WARNING: set at /apmbob/tracker/... failed: permission_denied`

**Fix:** Firebase Realtime Database security rules di-set ke:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

**Pelajaran:** Firebase RTDB default-nya **terkunci** — harus diubah manual di console.

---

### 🧠 Ringkasan Pelajaran Teknis

| Konsep | Yang Dipelajari |
|--------|----------------|
| **NMEA 0183** | Format data GPS: RMC (posisi), GGA (fix), GSV (satelit), VTG (kecepatan) |
| **TinyGPSPlus** | Library parsing GPS — dapet lat/lng/speed/heading, tapi **gak dapet detail satelit** |
| **Manual NMEA parsing** | Split string by koma, `atoi()`, state machine buat multi-message |
| **ESP32 UART** | `Serial1.begin(baud, config, RX, TX)` → bisa pin mana aja |
| **MQTT TLS** | ESP32 → `WiFiClientSecure.setInsecure()`, Dashboard → WebSocket `wss://` |
| **Next.js SSR** | Library browser-only harus dynamic import |
| **Firebase RTDB** | Path restriction (gak boleh `.`, `#`, `$`, `[`, `]`) |
| **Leaflet** | Map, marker, polyline, divIcon custom |
| **SIM800L power** | Butuh 2A — jangan dari USB laptop |
| **GSV multi-message** | Accumulator + flag `msgNum == totalMsg` buat finalize |

---

## ❓ FAQ / Pelajaran

### 🔹 GPS NEO-6M — Kenapa susah dapet fix?
- Butuh **view langit terbuka** (outdoor/teras)
- Di dalam ruangan dekat jendela masih bisa tapi butuh waktu lebih lama (30-60 detik)
- **Antena patch** harus menghadap langit — casing logam di atas antena akan menghalangi sinyal

### 🔹 GPS — Kenapa posisi di peta gerak-gerak terus meskipun alat diam?
- **Akurasi NEO-6M** hanya ~2.5m (CEP50) — 50% posisi yang dilaporkan bisa meleset sampai 2.5m dari posisi asli
- **Atmospheric noise** — sinyal satelit terganggu ionosfer & troposfer
- **Multipath** — sinyal memantul dari gedung/pohon sebelum sampai ke antena
- **Fix:** Dashboard sudah pakai GPS noise filter dual-threshold (5m marker, 15m pan)
- Kalau masih kepengen lebih stabil, threshold bisa dinaikkan di `page.tsx` variabel `MOVE_THRESHOLD_M` dan `PAN_THRESHOLD_M`

### 🔹 GPS — Kenapa sering ilang & susah balik?
1. **Cold start lambat** — setelah fix hilang, NEO-6M harus mengunduh ephemeris data ulang
2. **Power drop** — komponen lain (SIM800L terutama) narik arus besar, voltase GPS bisa turun
3. **Multipath** — sinyal GPS memantul di gedung tinggi, SNR turun, fix hilang

### 🔹 SIM800L — Kenapa CME ERROR 10?
Error "SIM not detected" bisa karena:
- **Power tidak cukup** — SIM800L butuh 2A peak, USB laptop hanya 500mA
- **SIM card rusak** atau tidak terpasang dengan benar
- **Konektor SIM longgar**

### 🔹 SIM800L — AT command echo tapi tidak "OK"
Modul menerima data (TX/RX bener) tapi prosesor GSM tidak boot penuh. Penyebab:
- **PWRKEY tidak ditarik** — beberapa module butuh PWRKEY dinaikkan ke VDD/3.3V
- **Arus tidak cukup** — modul hanya cukup untuk echo, tidak untuk boot penuh
- **Suggested fix:** power bank dedicated 5V 2A, PWRKEY ke VDD

### 🔹 Kecepatan satelit — apa yang memengaruhi?
- **Jumlah satelit** — minimal 4 untuk fix 3D (posisi + ketinggian)
- **SNR** — kualitas sinyal (≥40 dB = bagus, ≥30 dB = cukup, <20 dB = lemah)
- **HDOP** — horizontal dilution of precision (semakin kecil semakin akurat)
- **Elevasi satelit** — satelit rendah dekat horizon lebih noise

### 🔹 MQTT — Kenapa kadang gagal konek?
- **Firewall/port blocker** — operator WiFi tertentu memblokir port non-standar (8883 TLS)
- **DNS tidak ter-resolve** — sambungkan ke WiFi yang stabil
- **WiFi dengan port 8883 terbuka** diperlukan — coba jaringan rumah/kantor, bukan hotspot HP

### 🔹 Firebase — Permission denied
- Buka Firebase Console → Realtime Database → Rules
- Set `.read` dan `.write` ke `true` (development) atau atur autentikasi

### 🔹 Casing & Penempatan GPS
- **Antena WAJIB di luar casing** — plastik tipis masih tembus, logam tidak
- **Letakkan di dashboard mobil** (di bawah kaca depan) untuk hasil terbaik
- **Parkiran basement** — kemungkinan besar kehilangan sinyal

---

## 📄 Lisensi

Proyek ini dibuat untuk keperluan akademik — **Project APMOB 16**.

---

*Dibuat dengan ❤️ oleh Kelompok 16*
