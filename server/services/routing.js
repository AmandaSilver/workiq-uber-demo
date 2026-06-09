// server/services/routing.js
// Turn a pickup -> dropoff pair into a real, street-following driving path so the
// map shows believable routes instead of straight "as-the-crow-flies" lines.
//
// Uses the free OSRM demo server (no key). This is deliberately BEST-EFFORT and
// kept separate from WorkIQ: a routing hiccup must never look like a WorkIQ
// failure, and the caller always falls back to a straight line if a route is
// missing. For the captured sample we precompute routes into the dataset (see
// scripts/precompute-routes.mjs) so the offline demo is fully deterministic.

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving";

// Cache by a normalized coordinate pair so repeated legs (e.g. the same
// hotel->office hop) only hit the network once per process.
const cache = new Map();

function key(a, b) {
  const r = (n) => Number(n).toFixed(5);
  return `${r(a.lat)},${r(a.lng)};${r(b.lat)},${r(b.lng)}`;
}

/**
 * Fetch a street-following driving path plus real distance/duration.
 * @returns {Promise<{path:[number,number][], distanceMi:number, durationMin:number} | null>}
 */
export async function routeBetweenDetailed(pickup, dropoff, timeoutMs = 6000) {
  if (!pickup || !dropoff) return null;
  if (![pickup.lat, pickup.lng, dropoff.lat, dropoff.lng].every(Number.isFinite)) return null;

  const k = key(pickup, dropoff);
  if (cache.has(k)) return cache.get(k);

  const url =
    `${OSRM_BASE}/${pickup.lng},${pickup.lat};${dropoff.lng},${dropoff.lat}` +
    `?overview=full&geometries=geojson`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "WorkIQ-Trip-Planner-Demo/1.0 (local demo)" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const route = data?.routes?.[0];
    const coords = route?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) return null;
    // OSRM returns [lng,lat]; Leaflet wants [lat,lng].
    const path = coords.map(([lng, lat]) => [lat, lng]);
    const detailed = {
      path,
      distanceMi: route.distance != null ? route.distance / 1609.344 : null,
      durationMin: route.duration != null ? route.duration / 60 : null,
    };
    cache.set(k, detailed);
    return detailed;
  } catch {
    return null; // timeout / network / parse — caller draws a straight line.
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch a street-following driving path between two points.
 * @returns {Promise<[number, number][] | null>} array of [lat,lng] or null on any failure.
 */
export async function routeBetween(pickup, dropoff, timeoutMs = 6000) {
  const detailed = await routeBetweenDetailed(pickup, dropoff, timeoutMs);
  return detailed ? detailed.path : null;
}

/**
 * Best-effort: attach a `route` ([lat,lng][]) to every in-city ride that doesn't
 * already have one. Never throws and never blocks longer than `budgetMs` overall;
 * airport transfers are skipped (they're hidden from the planning map). Rides that
 * fail to route simply keep no `route` and the frontend falls back to a line.
 */
export async function enrichRidesWithRoutes(rides, { budgetMs = 8000 } = {}) {
  const targets = rides.filter((r) => !r.route && !r.isAirport);
  if (targets.length === 0) return rides;

  const perCall = Math.max(2500, Math.floor(budgetMs / targets.length));
  await Promise.allSettled(
    targets.map(async (r) => {
      const path = await routeBetween(r.pickup, r.dropoff, perCall);
      if (path) r.route = path;
    })
  );
  return rides;
}
