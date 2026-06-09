// server/services/geocode.js
// Address -> {lat,lng}. Used ONLY to enrich LIVE WorkIQ receipts that arrive
// without coordinates. Captured data already has coordinates baked in, so the
// demo never depends on a geocoder. We keep a small local cache of well-known
// SF addresses for instant, offline-friendly results, and fall back to the free
// OpenStreetMap Nominatim service (no key) for anything else.
//
// NOTE: Geocoding is deliberately kept separate from WorkIQ so that a Nominatim
// hiccup is never mistaken for a WorkIQ failure during a demo.

const STATIC = new Map(
  Object.entries({
    "335 powell st": { lat: 37.7873, lng: -122.4082 },
    "1 ferry building": { lat: 37.7955, lng: -122.3937 },
    "415 mission st": { lat: 37.7896, lng: -122.3969 },
    "500 brannan st": { lat: 37.7787, lng: -122.397 },
    "747 howard st": { lat: 37.7841, lng: -122.4011 },
    "1570 stockton st": { lat: 37.8004, lng: -122.4103 },
    "101 california st": { lat: 37.7932, lng: -122.3984 },
    "234 townsend st": { lat: 37.7765, lng: -122.3946 },
    "900 n point st": { lat: 37.8058, lng: -122.4222 },
    sfo: { lat: 37.616, lng: -122.3854 },
  })
);

const cache = new Map();

function staticLookup(address) {
  const a = address.toLowerCase();
  if (a.includes("airport") || a.includes("sfo") || a.includes("terminal")) return STATIC.get("sfo");
  for (const [key, coord] of STATIC) {
    if (key !== "sfo" && a.includes(key)) return coord;
  }
  return null;
}

export async function geocode(address, timeoutMs = 8000) {
  if (!address) return null;
  const fromStatic = staticLookup(address);
  if (fromStatic) return { ...fromStatic, source: "static" };
  if (cache.has(address)) return cache.get(address);

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "json");
    url.searchParams.set("q", address);
    url.searchParams.set("limit", "1");
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, {
      headers: { "User-Agent": "WorkIQ-Trip-Planner-Demo/1.0 (local demo)" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;
    const coord = { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), source: "nominatim" };
    cache.set(address, coord);
    return coord;
  } catch {
    return null;
  }
}
