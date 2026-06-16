// server/services/webiq.js
// =============================================================================
//
//      🟣🟣🟣   W E B I Q   ( W E B   S E A R C H )   B O U N D A R Y   🟣🟣🟣
//
//   This module is where the app searches the public web for the best hotel
//   (at a requested star tier, default 5-star) closest to the recommended stay
//   area. The live call site is `callLiveWebSearch()`. Captured mode replays
//   real hotel results across star tiers retrieved for downtown San Francisco so
//   the demo is reliable offline.
//
// =============================================================================
import fs from "node:fs/promises";
import path from "node:path";
import { config, CAPTURED_DIR } from "../config.js";
import { logCall } from "./callLog.js";
import { rankHotelsByDistance, labelNeighborhood } from "./recommendation.js";
import { geocode } from "./geocode.js";

const CALL_SITE = "services/webiq.js \u2192 searchHotels()";

// =============================================================================
//  DEMO-LOCALE CONSTANTS
//  The single place this demo is hardcoded to San Francisco. In a real app these
//  would be derived from the user/trip (e.g. geocode the city, read radius from
//  config) rather than baked in. Centralized here so they're easy to find/change.
// =============================================================================
const CITY = "San Francisco, CA";
const SEARCH_RADIUS_M = 3000; // metres around the trip centroid to search
// Approx. centroid of downtown SF (Union Square); used only to pre-warm the
// keyless Overpass mirror at startup so the FIRST live demo click isn't slow.
const SF_DOWNTOWN = { lat: 37.78905, lng: -122.403214 };

// OpenStreetMap rarely tags a hotel's `stars`, so we identify genuine 5-star
// properties by well-known luxury brands/names. Word-boundary matched so e.g.
// "CW Hotel" doesn't match "W Hotel". This is the curated 5-star whitelist.
const FIVE_STAR_RE = new RegExp(
  "\\b(" +
    [
      "ritz[\\s-]?carlton", "st\\.?\\s*regis", "four seasons", "fairmont",
      "mandarin oriental", "waldorf astoria", "the peninsula", "peninsula hotel",
      "intercontinental", "loews regency", "palace hotel", "the palace",
      "1 hotel", "taj",
    ].join("|") +
    ")\\b",
  "i"
);

// Public Overpass instances are flaky (frequent 504s) but usually succeed on a
// retry or a sibling mirror. We cycle through these within the overall budget.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.osm.ch/api/interpreter",
];

// -----------------------------------------------------------------------------
//  QUERY BUILDING — the natural-language search query is constructed in exactly
//  one place so the demo can point at "this is what we asked the web".
// -----------------------------------------------------------------------------
function buildQuery(centroid, stars = 5) {
  const area = labelNeighborhood(centroid);
  const lux = stars >= 5 ? " luxury" : "";
  return `best ${stars}-star${lux} hotels near ${area}`;
}

// Clamp an incoming star request to a sane 1-5 integer (default 5).
function clampStars(s) {
  const n = Math.round(Number(s));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? n : 5;
}

// =============================================================================
//  LIVE PATH — the real web search. This is what runs in normal ("live"/"auto")
//  operation. Captured data (further below) is touched ONLY if this fails or
//  times out. Two providers: a keyed web-search API, or keyless OSM Overpass.
// =============================================================================

// -----------------------------------------------------------------------------
//  THE LIVE WEB SEARCH CALL. Uses Bing Web Search v7 or SerpApi if a key is set.
//  Returns an array of { name, url, snippet }. Throws if not configured/usable.
// -----------------------------------------------------------------------------
async function callLiveWebSearch(query) {
  const { bingKey, serpApiKey, timeoutMs } = config.webiq;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (bingKey) {
      const url = new URL("https://api.bing.microsoft.com/v7.0/search");
      url.searchParams.set("q", query);
      url.searchParams.set("count", "10");
      const res = await fetch(url, {
        headers: { "Ocp-Apim-Subscription-Key": bingKey },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`Bing search HTTP ${res.status}`);
      const data = await res.json();
      return (data.webPages?.value || []).map((v) => ({ name: v.name, url: v.url, snippet: v.snippet }));
    }
    if (serpApiKey) {
      const url = new URL("https://serpapi.com/search.json");
      url.searchParams.set("engine", "google");
      url.searchParams.set("q", query);
      url.searchParams.set("api_key", serpApiKey);
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`SerpApi HTTP ${res.status}`);
      const data = await res.json();
      return (data.organic_results || []).map((v) => ({ name: v.title, url: v.link, snippet: v.snippet }));
    }
    throw new Error("No web-search provider configured (set BING_SEARCH_KEY or SERPAPI_KEY).");
  } finally {
    clearTimeout(t);
  }
}

// Turn fuzzy web results into mappable hotel candidates by geocoding their names.
async function resultsToHotels(results, stars = 5) {
  const hotels = [];
  for (const r of results.slice(0, 6)) {
    const name = (r.name || "").split(/[|\u2013\u2014\-:]/)[0].trim();
    if (!name || !/hotel|ritz|regis|four seasons|palace|fairmont|st\.?\s*regis|taj/i.test(r.name || "")) continue;
    const g = await geocode(`${name}, ${CITY}`);
    if (!g) continue;
    hotels.push({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      address: CITY,
      lat: g.lat,
      lng: g.lng,
      stars,
      nightlyRateUSD: null,
      url: r.url,
      highlights: r.snippet || "",
    });
  }
  return hotels;
}

// POST an Overpass QL query, retrying across mirrors until it succeeds or the
// overall time budget runs out. Throws only if every attempt failed.
async function overpassFetch(ql, totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  let attempt = 0;
  let lastErr;
  while (Date.now() < deadline) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    attempt++;
    const perTry = Math.min(7000, deadline - Date.now());
    if (perTry < 1500) break; // not enough time left for a meaningful attempt
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), perTry);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "User-Agent": "WorkIQ-Trip-Planner-Demo/1.0 (local demo)",
        },
        body: ql,
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
    } finally {
      clearTimeout(t);
    }
  }
  throw new Error(`Overpass unavailable after ${attempt} attempt(s): ${lastErr?.message || "timed out"}`);
}

// -----------------------------------------------------------------------------
//  KEYLESS LIVE FALLBACK: query the OpenStreetMap Overpass API for real hotels
//  near the trip centroid (no API key required, same public-data spirit as the
//  Nominatim geocoder). OSM hotels come WITH coordinates, so no extra geocoding
//  is needed.
//
//  Star filtering: OSM rarely tags luxury properties with `stars`, so for a
//  5-star request we keep the curated luxury-brand whitelist OR an explicit
//  stars=5 tag. For other tiers (3-star, 4-star, …) we trust OSM's `stars` tag
//  with an exact match. Throws on transport errors so the caller can fall back
//  to captured data.
// -----------------------------------------------------------------------------
async function overpassHotels(centroid, timeoutMs, stars = 5) {
  const ql =
    "[out:json][timeout:12];(" +
    `node["tourism"="hotel"](around:${SEARCH_RADIUS_M},${centroid.lat},${centroid.lng});` +
    `way["tourism"="hotel"](around:${SEARCH_RADIUS_M},${centroid.lat},${centroid.lng});` +
    ");out center tags 80;";
  const data = await overpassFetch(ql, timeoutMs);
  const seen = new Set();
  const hotels = [];
  for (const el of data.elements || []) {
    const name = el.tags?.name;
    if (!name) continue;
    const osmStars = parseInt(el.tags.stars, 10);
    const matches =
      stars >= 5
        ? FIVE_STAR_RE.test(name) || osmStars === 5 // luxury brands rarely carry a stars tag
        : osmStars === stars; // other tiers: exact OSM stars-tag match
    if (!matches) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (seen.has(id)) continue;
    seen.add(id);
    const resolvedStars = Number.isFinite(osmStars) ? osmStars : stars;
    const street = [el.tags["addr:housenumber"], el.tags["addr:street"]].filter(Boolean).join(" ");
    hotels.push({
      id,
      name,
      address: street ? `${street}, ${CITY}` : CITY,
      lat,
      lng,
      stars: resolvedStars,
      nightlyRateUSD: null,
      url: el.tags.website || el.tags["contact:website"] || `https://www.openstreetmap.org/${el.type}/${el.id}`,
      highlights: el.tags.brand ? `${el.tags.brand} \u2014 ${resolvedStars}-star property` : `${resolvedStars}-star property (OpenStreetMap)`,
    });
  }
  return hotels;
}

/**
 * Pre-warm the keyless live WebIQ path at startup so the FIRST demo click is fast.
 * Public Overpass mirrors are slow when cold; firing one throwaway query against
 * the downtown SF centroid leaves a working mirror responsive (later runs ~2s
 * instead of ~20s). No-op in captured mode or when a real search key is set
 * (those don't use Overpass). Fire-and-forget: any failure is logged and ignored.
 */
export async function prewarmWebIQ() {
  const mode = (config.webiq.mode || "captured").toLowerCase();
  if (mode === "captured") return;
  if (config.webiq.bingKey || config.webiq.serpApiKey) return; // only Overpass needs warming
  const started = Date.now();
  try {
    const hotels = await overpassHotels(SF_DOWNTOWN, config.webiq.timeoutMs, 5);
    console.log(`[WebIQ] Overpass pre-warmed in ${((Date.now() - started) / 1000).toFixed(1)}s (${hotels.length} hotels; first live search will be fast).`);
  } catch (err) {
    console.log(`[WebIQ] pre-warm skipped: ${err.message}`);
  }
}

// =============================================================================
//  CAPTURED FALLBACK  (reliability net — NOT the primary path)
//  Everything below replays real hotel results previously retrieved for the demo
//  locale, stored in server/data/captured/hotels.json. It runs ONLY when:
//    • WEBIQ_MODE=captured (explicit offline demo), or
//    • a live search fails/times out under WEBIQ_MODE=auto.
//  A real production app would typically drop this section entirely (or replace
//  it with a cache); it exists here purely so the demo never dead-ends on stage.
// =============================================================================
async function loadCapturedHotels() {
  const raw = await fs.readFile(path.join(CAPTURED_DIR, "hotels.json"), "utf8");
  return JSON.parse(raw);
}

// Replay captured hotels at the requested tier, ranked nearest-first. If the
// captured dataset has nothing at that tier, fall back to all hotels so the demo
// always returns something mappable (with a note explaining the substitution).
async function replayCapturedHotels({ centroid, stars, query, startedMs, status, detail }) {
  const data = await loadCapturedHotels();
  let pool = data.hotels.filter((h) => Number(h.stars) === stars);
  let tierNote = "";
  if (pool.length === 0) {
    pool = data.hotels;
    tierNote = ` No ${stars}-star match in captured data; showing nearest available tier.`;
  }
  const ranked = rankHotelsByDistance(pool, centroid);
  const fullDetail = ((detail || "") + tierNote).trim();
  logCall({
    type: "WEBIQ",
    title: "WebIQ Search",
    mode: "CAPTURED",
    callSite: CALL_SITE,
    request: query,
    responseSummary: `${ranked.length} ${stars}-star hotels (captured) \u2014 nearest: ${ranked[0]?.name}`,
    durationMs: Date.now() - startedMs,
    status,
    detail: fullDetail,
  });
  return { hotels: ranked, mode: "CAPTURED", status, query, detail: fullDetail, stars };
}

// =============================================================================
//  ORCHESTRATOR — decides live vs. captured, then delegates. The captured path
//  is only ever reached via the mode switch or the catch block below.
// =============================================================================

/**
 * Find hotels near the centroid at a requested star tier, ranked nearest-first.
 * @param {{lat:number,lng:number}} centroid
 * @param {object} [opts]
 * @param {string} [opts.mode] "live" | "captured" | "auto"
 * @param {number} [opts.stars] requested star rating (1-5, default 5)
 * @returns {Promise<{hotels:object[], mode:string, status:string, query:string, detail:string, stars:number}>}
 */
export async function searchHotels(centroid, opts = {}) {
  const mode = (opts.mode || config.webiq.mode || "captured").toLowerCase();
  const stars = clampStars(opts.stars);
  const query = buildQuery(centroid, stars);
  const started = Date.now();

  if (mode === "captured") {
    return replayCapturedHotels({ centroid, stars, query, startedMs: started, status: "ok", detail: "Captured mode (configured)." });
  }

  try {
    // Prefer a real web-search provider when a key is configured; otherwise use
    // the keyless OpenStreetMap Overpass API so the live path works out of the box.
    const { bingKey, serpApiKey, timeoutMs } = config.webiq;
    let hotels;
    let provider;
    if (bingKey || serpApiKey) {
      const results = await callLiveWebSearch(query);
      hotels = await resultsToHotels(results, stars);
      provider = bingKey ? "Bing Web Search" : "SerpApi";
    } else {
      hotels = await overpassHotels(centroid, timeoutMs, stars);
      provider = "OpenStreetMap Overpass";
    }
    if (hotels.length === 0) throw new Error(`Live web search returned no mappable ${stars}-star hotels.`);
    const ranked = rankHotelsByDistance(hotels, centroid);
    logCall({
      type: "WEBIQ",
      title: "WebIQ Search",
      mode: "LIVE",
      callSite: CALL_SITE,
      request: query,
      responseSummary: `${ranked.length} ${stars}-star hotels from live web search (${provider}) \u2014 nearest: ${ranked[0]?.name}`,
      durationMs: Date.now() - started,
      status: "ok",
    });
    return { hotels: ranked, mode: "LIVE", status: "ok", query, detail: "", stars };
  } catch (err) {
    if (mode === "live") {
      logCall({
        type: "WEBIQ",
        title: "WebIQ Search",
        mode: "LIVE",
        callSite: CALL_SITE,
        request: query,
        responseSummary: "LIVE web search failed",
        durationMs: Date.now() - started,
        status: "error",
        detail: err.message,
      });
      const e = new Error(`Live WebIQ failed: ${err.message}`);
      e.code = "WEBIQ_LIVE_FAILED";
      throw e;
    }
    // auto -> the failure path that reaches captured data.
    return replayCapturedHotels({
      centroid,
      stars,
      query,
      startedMs: started,
      status: "fallback",
      detail: `Live web search failed, replayed captured hotels. Reason: ${err.message}`,
    });
  }
}
