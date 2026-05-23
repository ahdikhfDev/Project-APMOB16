"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

const MQTT_HOST = process.env.NEXT_PUBLIC_MQTT_HOST!;
const MQTT_USER = process.env.NEXT_PUBLIC_MQTT_USER!;
const MQTT_PASS = process.env.NEXT_PUBLIC_MQTT_PASS!;
const MQTT_TOPIC = process.env.NEXT_PUBLIC_MQTT_TOPIC!;
const MQTT_TOPIC_ZONE = process.env.NEXT_PUBLIC_MQTT_TOPIC_ZONE!;

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

interface ZoneData {
  status: "safe" | "violated" | "inactive";
  active: boolean;
  radius: number;
  mode: "auto" | "manual";
}

// Module-level — cached agar Firebase init cuma sekali, bukan per-message
const firebaseWrite = import("@/lib/firebase").then((fb) => fb).catch(() => null);

let mqttClientId: string | null = null;
const getMqttClientId = () => {
  if (typeof window === "undefined") return "web-dashboard";
  if (!mqttClientId) {
    mqttClientId = localStorage.getItem("mqttClientId");
    if (!mqttClientId) {
      mqttClientId = "web-" + Math.random().toString(36).substring(2, 10);
      localStorage.setItem("mqttClientId", mqttClientId);
    }
  }
  return mqttClientId;
};

const HAVERSINE_KM = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLng = (lng2 - lng1) * (Math.PI / 180);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

const TRAIL_MAX = 200;

export default function Home() {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();

  const [gps, setGps] = useState<GpsData | null>(null);
  const [gpsLost, setGpsLost] = useState(false);
  const [gpsLostSec, setGpsLostSec] = useState(0);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [lastUpdate, setLastUpdate] = useState<string>("-");
  const [trailCount, setTrailCount] = useState(0);
  const [zoneCenterLat, setZoneCenterLat] = useState<number | null>(null);
  const [zoneCenterLng, setZoneCenterLng] = useState<number | null>(null);
  const [zoneRadius, setZoneRadius] = useState(50);
  const [zoneActive, setZoneActive] = useState(false);
  const [zoneManualMode, setZoneManualMode] = useState(false);
  const [zoneStatus, setZoneStatus] = useState<"safe" | "violated" | "inactive">("inactive");
  const lastFixTime = useRef<number>(Date.now());
  const trailRefs = useRef<any>({ polyline: null, glowLine: null, startMarker: null, map: null, points: [] });
  const zoneRef = useRef({ L: null as any, circle: null as any, radius: 50, centerLat: null as number | null, centerLng: null as number | null, active: false, status: "inactive" });
  const mqttRef = useRef<any>(null);
  const mapInited = useRef(false);

  useEffect(() => {
    if (!authLoading && !user) router.replace("/login");
  }, [user, authLoading, router]);

  useEffect(() => {
    if (authLoading || !user || mapInited.current) return;
    mapInited.current = true;
    Promise.all([import("leaflet"), import("mqtt")]).then(([leaf, mq]) => {
      const L = leaf.default;
      const mqtt = mq.default;

      const tr = trailRefs.current;
      const map = L.map("map", { zoomControl: false }).setView([-6.4025, 106.7942], 14);
      tr.map = map;
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
      }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);
      let polyline: L.Polyline | null = tr.polyline;
      let glowLine: L.Polyline | null = tr.glowLine;
      let markerRef: L.Marker | null = null;
      let startMarker: L.Marker | null = tr.startMarker;
      const trailPoints: [number, number][] = tr.points;

      zoneRef.current.L = L;

      const client = mqtt.connect(MQTT_HOST, {
        username: MQTT_USER,
        password: MQTT_PASS,
        clientId: getMqttClientId(),
      });
      mqttRef.current = client;

      client.on("connect", () => setStatus("connected"));
      client.on("reconnect", () => setStatus("connecting"));
      client.on("close", () => setStatus("disconnected"));
      client.on("offline", () => setStatus("disconnected"));

      client.subscribe(MQTT_TOPIC);

      client.on("message", (_topic, payload) => {
        try {
          const data: GpsData = JSON.parse(payload.toString());
          if (data.lat === 0 && data.lng === 0) return;

          setGps(data);
          setLastUpdate(new Date().toLocaleTimeString("id-ID"));

          const isStale = data.mode === "gps_stale";

          setGpsLost(isStale);
          if (!isStale) lastFixTime.current = Date.now();

          // Zone status dari ESP32
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

          // Write to Firebase RTDB — latest always, history max once per menit
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

          if (data.lat && data.lng) {
            const latlng: [number, number] = [data.lat, data.lng];

            const markerColor = isStale ? "#888" : "#ff3366";

            if (!isStale) {
              const isFirst = trailPoints.length === 0;
              let shouldAddTrail = true;
              if (!isFirst) {
                const lastPt = trailPoints[trailPoints.length - 1];
                if (lastPt) {
                  const d = HAVERSINE_KM(lastPt[0], lastPt[1], latlng[0], latlng[1]) * 1000;
                  if (d < 3) shouldAddTrail = false;
                }
              }
              if (shouldAddTrail) {
                trailPoints.push(latlng);
                if (trailPoints.length > TRAIL_MAX) {
                  const decimated: [number, number][] = [];
                  for (let i = 0; i < trailPoints.length; i += 2) decimated.push(trailPoints[i]);
                  trailPoints.length = 0;
                  trailPoints.push(...decimated);
                }
                setTrailCount(trailPoints.length);
              }

              // Glow trail (outer)
              if (!glowLine) {
                glowLine = L.polyline(trailPoints, {
                  color: "#c6f91f",
                  weight: 10,
                  opacity: 0.25,
                  lineCap: "round",
                  lineJoin: "round",
                }).addTo(map);
                tr.glowLine = glowLine;
              } else {
                glowLine.setLatLngs(trailPoints);
              }

              // Main trail (inner)
              if (!polyline) {
                polyline = L.polyline(trailPoints, {
                  color: "#ffdb00",
                  weight: 4,
                  opacity: 0.95,
                  lineCap: "round",
                  lineJoin: "round",
                }).addTo(map);
                tr.polyline = polyline;
              } else {
                polyline.setLatLngs(trailPoints);
              }

              // Start marker (first point)
              if (isFirst) {
                const startIcon = L.divIcon({
                  className: "",
                  html: `<div style="background:#00e5ff;width:14px;height:14px;border:3px solid white;border-radius:50%;box-shadow:0 0 0 3px #00e5ff"></div>`,
                  iconSize: [14, 14],
                  iconAnchor: [7, 7],
                });
                startMarker = L.marker(latlng, { icon: startIcon }).addTo(map);
                tr.startMarker = startMarker;
              }
            }

            if (isStale && trailPoints.length > 0) {
              // Still show trail but faded
              const fadeColor = "#888";
              if (polyline) polyline.setStyle({ color: fadeColor, opacity: 0.4 });
              if (glowLine) glowLine.setStyle({ color: fadeColor, opacity: 0.1 });
            } else {
              if (polyline) polyline.setStyle({ color: "#ffdb00", opacity: 0.95 });
              if (glowLine) glowLine.setStyle({ color: "#c6f91f", opacity: 0.25 });
            }

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

            if (!isStale) map.panTo(latlng);
          }

          // Zone circle (via ref biar realtime)
          const zr = zoneRef.current;
          if (zr.circle) {
            if (data.zone?.active && zr.centerLat && zr.centerLng) {
              zr.circle.setLatLng([zr.centerLat, zr.centerLng]);
              zr.circle.setRadius(data.zone.radius);
              zr.circle.setStyle({
                color: data.zone.status === "violated" ? "#ff0000" : "#00e5ff",
                fillColor: data.zone.status === "violated" ? "#ff4d4d" : "#c6f91f",
              });
            } else {
              map.removeLayer(zr.circle);
              zr.circle = null;
            }
          }
        } catch (e) {
          console.error("Parse error", e);
        }
      });

      return () => {
        client.end(true);
        map.remove();
      };
    });
  }, [authLoading, user]);

  useEffect(() => {
    if (!gpsLost) return;
    const timer = setInterval(() => {
      setGpsLostSec(Math.floor((Date.now() - lastFixTime.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [gpsLost]);

  if (authLoading) return (
    <div className="h-screen w-screen flex items-center justify-center bg-[#f4eedd]">
      <div className="text-center">
        <i className="fa-solid fa-satellite-dish fa-spin text-5xl text-black"></i>
        <p className="text-sm font-bold uppercase mt-4 tracking-widest">Memuat...</p>
      </div>
    </div>
  );
  if (!user) return null;

  const statusColor =
    status === "connected" ? "bg-[#c6f91f]" : status === "connecting" ? "bg-[#ffdb00]" : "bg-[#ff4d4d]";
  const statusText =
    status === "connected" ? "ONLINE" : status === "connecting" ? "MENGHUBUNGKAN..." : "OFFLINE";
  const statusIcon =
    status === "connected"
      ? "fa-solid fa-plug-circle-check"
      : status === "connecting"
      ? "fa-solid fa-satellite-dish fa-spin"
      : "fa-solid fa-plug-circle-xmark";

  const fmtDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  };

  // Sync zone state ke ref (biar gak stale closure)
  zoneRef.current.radius = zoneRadius;
  zoneRef.current.centerLat = zoneCenterLat;
  zoneRef.current.centerLng = zoneCenterLng;
  zoneRef.current.active = zoneActive;
  zoneRef.current.status = zoneStatus;

  const zUpdateMap = (lat: number, lng: number, rad: number, act: boolean, stat: string) => {
    const zr = zoneRef.current;
    const map = trailRefs.current.map;
    if (!zr.L || !map) return;
    if (act && lat && lng) {
      const isViolated = stat === "violated";
      if (!zr.circle) {
        zr.circle = zr.L.circle([lat, lng], {
          radius: rad,
          color: isViolated ? "#ff0000" : "#00e5ff",
          fillColor: isViolated ? "#ff4d4d" : "#c6f91f",
          fillOpacity: 0.2,
          weight: 4,
          dashArray: "10, 8",
        }).addTo(map);
      } else {
        zr.circle.setLatLng([lat, lng]);
        zr.circle.setRadius(rad);
        zr.circle.setStyle({ color: isViolated ? "#ff0000" : "#00e5ff", fillColor: isViolated ? "#ff4d4d" : "#c6f91f" });
      }
    } else if (zr.circle) {
      map.removeLayer(zr.circle);
      zr.circle = null;
    }
  };

  const publishZone = (overrides?: Record<string, any>) => {
    const zr = zoneRef.current;
    const lat = overrides?.centerLat ?? zr.centerLat ?? gps?.lat ?? 0;
    const lng = overrides?.centerLng ?? zr.centerLng ?? gps?.lng ?? 0;
    const rad = overrides?.radius ?? zr.radius;
    const act = overrides?.active ?? zr.active;
    const mode = overrides?.mode ?? (zoneManualMode ? "manual" : "auto");
    const action = overrides?.action ?? "set_zone";
    const payload = JSON.stringify({ action, centerLat: lat, centerLng: lng, radius: rad, active: act, mode });
    if (mqttRef.current?.connected) {
      mqttRef.current.publish(MQTT_TOPIC_ZONE, payload);
    }
  };

  return (
    <>
      {/* SIDEBAR */}
      <div className="w-full md:w-1/3 lg:w-1/4 neo-card bg-white p-5 flex flex-col gap-5 z-10 overflow-y-auto h-auto md:h-full shrink-0">
        <div className="flex items-center gap-3 pb-4 border-b-4 border-black">
          <div className="bg-[#c6f91f] p-3 border-2 border-black rounded shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
            <i className="fa-solid fa-satellite-dish text-2xl text-black"></i>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tighter uppercase leading-none">LacakIn</h1>
            <p className="font-semibold text-sm tracking-widest uppercase mt-1 bg-black text-white px-2 py-0.5 inline-block">
              Tracker Web
            </p>
          </div>
        </div>

        {/* GPS LOST BANNER */}
        {gpsLost && (
          <div className="bg-[#ff4d4d] neo-border p-3 rounded-lg text-center animate-pulse">
            <div className="flex items-center justify-center gap-2 mb-1">
              <i className="fa-solid fa-triangle-exclamation text-black text-lg"></i>
              <span className="font-extrabold text-black text-sm uppercase tracking-widest">GPS LOST</span>
              <i className="fa-solid fa-triangle-exclamation text-black text-lg"></i>
            </div>
            <span className="font-mono text-2xl font-extrabold text-black bg-white px-3 py-1 border-2 border-black inline-block mt-1">
              {fmtDuration(gpsLostSec)}
            </span>
            <p className="text-black text-[10px] font-bold uppercase mt-1">Sinyal Hilang</p>
          </div>
        )}

        <div
          className={`${statusColor} neo-border p-4 rounded-lg flex justify-between items-center transition-colors duration-300`}
        >
          <div className="flex items-center gap-3">
            <div className="p-1 bg-white border-2 border-black rounded-full">
              <div
                className={`w-3 h-3 rounded-full ${
                  status === "connected" ? "bg-green-600" : status === "connecting" ? "bg-yellow-500" : "bg-red-600"
                }`}
              ></div>
            </div>
            <span className="font-bold text-black uppercase tracking-wider">{statusText}</span>
          </div>
          <i className={`${statusIcon} text-black text-xl`}></i>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className={`col-span-2 neo-card neo-shadow p-5 relative overflow-hidden group ${gpsLost ? "bg-gray-300" : "bg-[#c6f91f]"}`}>
            <i className="fa-solid fa-gauge-high absolute -right-2 -top-2 text-7xl text-black opacity-10 group-hover:scale-110 transition-transform"></i>
            <div className="border-b-2 border-black mb-2 inline-block">
              <p className="text-black text-sm font-bold uppercase tracking-wider">Kecepatan</p>
            </div>
            <div className="flex items-end gap-2">
              <span className="text-5xl font-extrabold text-black tracking-tighter">
                {gps ? gps.speed.toFixed(1) : "0.0"}
              </span>
              <span className="text-black font-bold text-xl mb-1 border-2 border-black px-2 py-0.5 rounded bg-white">
                km/h
              </span>
            </div>
          </div>

          <div className="col-span-2 neo-card neo-shadow bg-[#0d0d0d] p-4">
            <div className="flex items-center gap-2 mb-3 border-b-2 border-[#c6f91f] pb-2">
              <i className="fa-solid fa-satellite-dish text-[#c6f91f]"></i>
              <p className="text-[#c6f91f] text-sm font-bold uppercase tracking-wider">Satelit Terlihat</p>
              <span className="ml-auto text-[#c6f91f] font-extrabold text-lg">{gps ? gps.sats : 0}</span>
            </div>
            <div className="flex flex-col gap-1.5 max-h-[240px] overflow-y-auto">
              {gps?.satellites && gps.satellites.length > 0 ? (
                [...gps.satellites]
                  .sort((a, b) => b.s - a.s)
                  .map((sat, i) => {
                    const bars = sat.s > 0 ? Math.min(Math.ceil(sat.s / 10), 5) : 0;
                    const color = sat.s >= 40 ? "#c6f91f" : sat.s >= 20 ? "#ffdb00" : "#ff4d4d";
                    return (
                      <div key={sat.p ?? i} className="flex items-center gap-2 bg-black border border-gray-800 rounded px-3 py-1.5">
                        <span className="text-[11px] font-mono font-bold text-white w-[32px] shrink-0">
                          {sat.p}
                        </span>
                        <div className="flex gap-[3px] items-center flex-1">
                          {[1, 2, 3, 4, 5].map((b) => (
                            <div
                              key={b}
                              className="w-[14px] h-[4px] rounded-sm transition-all duration-200"
                              style={{
                                background: b <= bars ? color : "#222",
                                opacity: b <= bars ? 1 : 0.4,
                              }}
                            />
                          ))}
                        </div>
                        <span
                          className="text-[10px] font-mono font-bold w-[28px] text-right shrink-0"
                          style={{ color }}
                        >
                          {sat.s}
                        </span>
                        <span className="text-[9px] text-gray-500 w-[24px] text-right shrink-0 font-mono">
                          {sat.e}°
                        </span>
                      </div>
                    );
                  })
              ) : (
                <div className="text-center py-4">
                  <div className="text-[#c6f91f] text-5xl font-extrabold tracking-tighter mb-1">
                    {gps ? gps.sats : 0}
                  </div>
                  <p className="text-gray-500 text-[10px] font-bold uppercase tracking-wider">
                    {gps && gps.sats > 0 ? "Satelit Terdeteksi" : "Mencari satelit..."}
                  </p>
                </div>
              )}
            </div>
          </div>

          <div className="neo-card neo-shadow bg-[#00e5ff] p-4 flex flex-col justify-center items-center text-center">
            <div className="bg-white border-2 border-black rounded-full w-10 h-10 flex items-center justify-center mb-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]">
              <i
                className="fa-solid fa-location-arrow text-black text-lg transition-transform duration-500"
                style={{ transform: `rotate(${(gps?.heading ?? 0) - 45}deg)` }}
              ></i>
            </div>
            <div className="flex items-end gap-1">
              <span className="text-3xl font-extrabold text-black">{gps ? gps.heading.toFixed(0) : "0"}</span>
              <span className="text-black font-bold text-lg mb-1">°</span>
            </div>
            <span className="text-black text-xs font-bold uppercase tracking-widest mt-1">Arah</span>
          </div>

          <div className="col-span-2 neo-card neo-shadow bg-white p-4">
            <div className="flex items-center gap-2 mb-3 border-b-2 border-black pb-2">
              <i className="fa-solid fa-map-location-dot text-black"></i>
              <p className="text-black text-sm font-bold uppercase">Titik Koordinat</p>
              {gps && (
                <span className={`ml-auto text-[10px] font-bold uppercase px-2 py-0.5 border-2 border-black rounded ${gpsLost ? "bg-[#ff4d4d] text-black" : "bg-[#c6f91f] text-black"}`}>
                  {gpsLost ? "STALE" : "LIVE"}
                </span>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <div className="flex justify-between items-center bg-[#f0f0f0] border-2 border-black rounded p-2">
                <span className="text-xs font-bold bg-black text-white px-2 py-1 rounded">LAT</span>
                <span className="font-bold text-sm text-black font-mono">
                  {gps ? gps.lat.toFixed(6) : "-"}
                </span>
              </div>
              <div className="flex justify-between items-center bg-[#f0f0f0] border-2 border-black rounded p-2">
                <span className="text-xs font-bold bg-black text-white px-2 py-1 rounded">LNG</span>
                <span className="font-bold text-sm text-black font-mono">
                  {gps ? gps.lng.toFixed(6) : "-"}
                </span>
              </div>
            </div>
          </div>

          {/* ZONA KEAMANAN */}
          <div className="col-span-2 neo-card neo-shadow bg-white p-4">
            <div className="flex items-center gap-2 mb-3 border-b-2 border-black pb-2">
              <i className="fa-solid fa-shield-halved text-black"></i>
              <p className="text-black text-sm font-bold uppercase">Zona Keamanan</p>
              <span
                className={`ml-auto text-[10px] font-bold uppercase px-2 py-0.5 border-2 border-black rounded ${
                  zoneStatus === "safe" ? "bg-[#c6f91f] text-black" :
                  zoneStatus === "violated" ? "bg-[#ff4d4d] text-black animate-pulse" :
                  "bg-gray-300 text-black"
                }`}
              >
                {zoneStatus === "safe" ? "AMAN" : zoneStatus === "violated" ? "DILANGGAR!" : "NONAKTIF"}
              </span>
            </div>

            {/* ON/OFF Toggle */}
            <div className="flex gap-2 mb-3">
              <button
                onClick={() => {
                  const next = !zoneActive;
                  setZoneActive(next);
                  if (!next) setZoneStatus("inactive");
                  publishZone({ active: next });
                  if (zoneCenterLat != null && zoneCenterLng != null) {
                    zUpdateMap(zoneCenterLat, zoneCenterLng, zoneRadius, next, next ? "safe" : "inactive");
                  }
                }}
                className={`flex-1 text-xs font-bold uppercase tracking-wider border-2 border-black rounded px-3 py-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all ${
                  zoneActive ? "bg-[#c6f91f] text-black" : "bg-gray-200 text-black"
                }`}
              >
                <i className={`fa-solid ${zoneActive ? "fa-toggle-on" : "fa-toggle-off"} mr-1`}></i>
                {zoneActive ? "AKTIF" : "NONAKTIF"}
              </button>
              <button
                onClick={() => {
                  const zr = zoneRef.current;
                  if (gps?.lat && gps?.lng) {
                    setZoneCenterLat(gps.lat);
                    setZoneCenterLng(gps.lng);
                    zUpdateMap(gps.lat, gps.lng, zr.radius, zr.active, zr.status);
                    publishZone({ centerLat: gps.lat, centerLng: gps.lng });
                  }
                }}
                disabled={!gps}
                className="text-xs font-bold uppercase tracking-wider bg-[#00e5ff] text-black border-2 border-black rounded px-3 py-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all disabled:opacity-40"
              >
                <i className="fa-solid fa-crosshairs mr-1"></i> Set Posisi
              </button>
            </div>

            {/* Radius slider */}
            <div className="mb-3">
              <div className="flex justify-between items-center mb-1">
                <span className="text-[10px] font-bold uppercase text-black">Radius</span>
                <span className="text-lg font-extrabold text-black font-mono">{zoneRadius}m</span>
              </div>
              <input
                type="range"
                min={5}
                max={500}
                value={zoneRadius}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setZoneRadius(v);
                  const zr = zoneRef.current;
                  zUpdateMap(zr.centerLat ?? 0, zr.centerLng ?? 0, v, zr.active, zr.status);
                }}
                onMouseUp={() => {
                  const zr = zoneRef.current;
                  publishZone({ radius: zr.radius });
                }}
                onTouchEnd={() => {
                  const zr = zoneRef.current;
                  publishZone({ radius: zr.radius });
                }}
                className="w-full h-2 border-2 border-black rounded appearance-none cursor-pointer"
                style={{ accentColor: "#c6f91f" }}
              />
              <div className="flex justify-between text-[9px] font-bold text-gray-500 mt-0.5">
                <span>5m</span><span>250m</span><span>500m</span>
              </div>
            </div>

            {/* Mode: Auto / Manual */}
            <div className="flex gap-2 mb-3">
              {["auto", "manual"].map((mode) => (
                <button
                  key={mode}
                  onClick={() => {
                    setZoneManualMode(mode === "manual");
                    publishZone({ mode });
                  }}
                  className={`flex-1 text-[10px] font-bold uppercase tracking-wider border-2 border-black rounded px-2 py-1.5 transition-all ${
                    (mode === "manual" ? zoneManualMode : !zoneManualMode)
                      ? "bg-black text-white shadow-[2px_2px_0px_0px_rgba(0,0,0,1)]"
                      : "bg-gray-100 text-black"
                  }`}
                >
                  {mode === "auto" ? "⚡ Otomatis" : "✋ Manual"}
                </button>
              ))}
            </div>

            {/* Reset button (manual mode, violated) */}
            {zoneManualMode && zoneStatus === "violated" && (
              <button
                onClick={() => {
                  publishZone({ action: "reset" });
                  const zr = zoneRef.current;
                  zUpdateMap(zr.centerLat ?? 0, zr.centerLng ?? 0, zr.radius, true, "safe");
                  setZoneStatus("safe");
                }}
                className="w-full text-[10px] font-bold uppercase tracking-wider bg-[#ffdb00] text-black border-2 border-black rounded px-3 py-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all"
              >
                <i className="fa-solid fa-arrow-rotate-left mr-1"></i> Reset Zona
              </button>
            )}

            {zoneCenterLat != null && zoneCenterLng != null && (
              <div className="mt-2 flex flex-col gap-1 bg-gray-50 border-2 border-black rounded p-2 text-[10px]">
                <div className="flex justify-between">
                  <span className="font-bold">PUSAT</span>
                  <span className="font-mono font-bold">{zoneCenterLat.toFixed(4)}, {zoneCenterLng.toFixed(4)}</span>
                </div>
              </div>
            )}
          </div>

          {/* TRAIL STATS */}
          {trailCount > 0 && (
            <div className="neo-card neo-shadow bg-white p-4">
              <div className="flex items-center gap-2 mb-2 border-b-2 border-black pb-2">
                <i className="fa-solid fa-route text-black"></i>
                <p className="text-black text-sm font-bold uppercase">Jejak Pergerakan</p>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs font-bold bg-black text-white px-2 py-1 rounded">TITIK</span>
                <span className="font-extrabold text-2xl text-black font-mono tracking-tighter">{trailCount}</span>
              </div>
              <button
                onClick={() => {
                  const t = trailRefs.current;
                  if (t.polyline) { t.polyline.setLatLngs([]); t.map?.removeLayer(t.polyline); t.polyline = null; }
                  if (t.glowLine) { t.glowLine.setLatLngs([]); t.map?.removeLayer(t.glowLine); t.glowLine = null; }
                  if (t.startMarker) { t.map?.removeLayer(t.startMarker); t.startMarker = null; }
                  t.points.length = 0;
                  setTrailCount(0);
                }}
                className="mt-3 w-full text-[10px] font-bold uppercase tracking-wider bg-[#ff4d4d] text-black border-2 border-black rounded px-3 py-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all"
              >
                <i className="fa-solid fa-eraser mr-1"></i> Hapus Jejak
              </button>
            </div>
          )}

          <div className="col-span-2 text-center mt-2 p-2 border-2 border-black border-dashed rounded bg-white">
            <p className="text-xs font-bold uppercase text-black">
              Update Terakhir: <br />
              <span className={`text-base px-2 py-0.5 mt-1 inline-block border-2 border-black ${gpsLost ? "bg-[#ff4d4d] text-white" : "bg-[#ffdb00] text-black"}`}>
                {lastUpdate}
              </span>
            </p>
          </div>

          <button
            onClick={logout}
            className="col-span-2 text-[10px] font-bold uppercase tracking-wider bg-black text-white border-2 border-black rounded px-3 py-2 shadow-[2px_2px_0px_0px_rgba(0,0,0,1)] hover:shadow-none hover:translate-x-[2px] hover:translate-y-[2px] transition-all mt-2"
          >
            <i className="fa-solid fa-right-from-bracket mr-1"></i> Keluar
          </button>
        </div>
      </div>

      {/* MAP */}
      <div className="flex-1 h-full w-full relative neo-card overflow-hidden">
        <div id="map" className="h-full w-full"></div>
      </div>
    </>
  );
}
