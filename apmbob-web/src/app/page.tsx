"use client";

import { useEffect, useRef, useState } from "react";

const MQTT_HOST = "wss://202f37f7e67c4292b30a95877382225e.s1.eu.hivemq.cloud:8884/mqtt";
const MQTT_USER = "kelompok16";
const MQTT_PASS = "Kelompok16";
const MQTT_TOPIC = "apmbob/tracker/gps";

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
}

type L = typeof import("leaflet");

export default function Home() {
  const [gps, setGps] = useState<GpsData | null>(null);
  const [gpsLost, setGpsLost] = useState(false);
  const [gpsLostSec, setGpsLostSec] = useState(0);
  const [status, setStatus] = useState<"disconnected" | "connecting" | "connected">("disconnected");
  const [lastUpdate, setLastUpdate] = useState<string>("-");
  const lastFixTime = useRef<number>(Date.now());

  useEffect(() => {
    Promise.all([import("leaflet"), import("mqtt")]).then(([leaf, mq]) => {
      const L = leaf.default;
      const mqtt = mq.default;

      const map = L.map("map", { zoomControl: false }).setView([-6.4025, 106.7942], 14);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 19,
      }).addTo(map);
      L.control.zoom({ position: "bottomright" }).addTo(map);

      let polyline: L.Polyline | null = null;
      let markerRef: L.Marker | null = null;
      const trailPoints: [number, number][] = [];

      const client = mqtt.connect(MQTT_HOST, {
        username: MQTT_USER,
        password: MQTT_PASS,
        clientId: "web-" + Math.random().toString(16).substring(2, 10),
      });

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

          // Write to Firebase RTDB
          import("@/lib/firebase").then((fb) => {
            const now = new Date();
            const ts = `${now.getTime()}`;
            const path = `apmbob/tracker/${ts}`;
            fb.set(fb.ref(fb.db, path), {
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

            if (!isStale) trailPoints.push(latlng);

            const markerColor = isStale ? "#888" : "#ff3366";
            const polyColor = isStale ? "#888" : "#ff3366";

            if (!polyline) {
              polyline = L.polyline(trailPoints, {
                color: polyColor,
                weight: 4,
                opacity: isStale ? 0.4 : 0.8,
                dashArray: "10, 8",
              }).addTo(map);
            } else {
              polyline.setStyle({ color: polyColor, opacity: isStale ? 0.4 : 0.8 });
              polyline.setLatLngs(trailPoints);
            }

            const icon = L.divIcon({
              className: "",
              html: `<div class="car-marker" style="background:${markerColor}"><i class="fa-solid fa-car-side"></i></div>`,
              iconSize: [40, 40],
              iconAnchor: [20, 20],
            });

            if (!markerRef) {
              markerRef = L.marker(latlng, { icon }).addTo(map);
            } else {
              markerRef.setIcon(icon);
              markerRef.setLatLng(latlng);
            }

            if (!isStale) map.panTo(latlng);
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
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (gpsLost) {
        setGpsLostSec(Math.floor((Date.now() - lastFixTime.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [gpsLost]);

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

  return (
    <>
      {/* SIDEBAR */}
      <div className="w-full md:w-1/3 lg:w-1/4 neo-card bg-white p-5 flex flex-col gap-5 z-10 overflow-y-auto h-auto md:h-full shrink-0">
        <div className="flex items-center gap-3 pb-4 border-b-4 border-black">
          <div className="bg-[#c6f91f] p-3 border-2 border-black rounded shadow-[3px_3px_0px_0px_rgba(0,0,0,1)]">
            <i className="fa-solid fa-satellite-dish text-2xl text-black"></i>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tighter uppercase leading-none">Apmbob</h1>
            <p className="font-semibold text-sm tracking-widest uppercase mt-1 bg-black text-white px-2 py-0.5 inline-block">
              Tracker
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

          <div className="col-span-2 text-center mt-2 p-2 border-2 border-black border-dashed rounded bg-white">
            <p className="text-xs font-bold uppercase text-black">
              Update Terakhir: <br />
              <span className={`text-base px-2 py-0.5 mt-1 inline-block border-2 border-black ${gpsLost ? "bg-[#ff4d4d] text-white" : "bg-[#ffdb00] text-black"}`}>
                {lastUpdate}
              </span>
            </p>
          </div>
        </div>
      </div>

      {/* MAP */}
      <div className="flex-1 h-full w-full relative neo-card overflow-hidden">
        <div id="map" className="h-full w-full"></div>
      </div>
    </>
  );
}
