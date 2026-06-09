// server/services/webiq.js
// =============================================================================
//
//      🟣🟣🟣   W E B I Q   ( W E B   S E A R C H )   B O U N D A R Y   🟣🟣🟣
//
//   This module is where the app searches the public web for the best 5-star
//   hotel closest to the recommended stay area. The live call site is
//   `callLiveWebSearch()`. Captured mode replays real hotel results retrieved
//   for downtown San Francisco so the demo is reliable offline.
//
// =============================================================================
import fs from "node:fs/promises";
import path from "node:path";
import { config, CAPTURED_DIR } from "../config.js";
import { logCall } from "./callLog.js";
import { rankHotelsByDistance, labelNeighborhood } from "./recommendation.js";
import { geocode } from "./geocode.js";

const CALL_SITE = "services/webiq.js \u2192 searchHotels()";

async function loadCapturedHotels() {
  const raw = await fs.readFile(path.join(CAPTURED_DIR, "hotels.json"), "utf8");
  return JSON.parse(raw);
}

function buildQuery(centroid) {
  const area = labelNeighborhood(centroid);
  return `best 5-star luxury hotels near ${area}`;
}

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
async function resultsToHotels(results) {
  const hotels = [];
  for (const r of results.slice(0, 6)) {
    const name = (r.name || "").split(/[|\u2013\u2014\-:]/)[0].trim();
    if (!name || !/hotel|ritz|regis|four seasons|palace|fairmont|st\.?\s*regis|taj/i.test(r.name || "")) continue;
    const g = await geocode(`${name}, San Francisco, CA`);
    if (!g) continue;
    hotels.push({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      name,
      address: "San Francisco, CA",
      lat: g.lat,
      lng: g.lng,
      stars: 5,
      nightlyRateUSD: null,
      url: r.url,
      highlights: r.snippet || "",
    });
  }
  return hotels;
}

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
];

// POST an Overpass QL query, retrying across mirrors until it succeeds or the
// overall time budget runs out. Throws only if every attempt failed.
async function overpassFetch(ql, totalTimeoutMs) {
  const deadline = Date.now() + totalTimeoutMs;
  let attempt = 0;
  let lastErr;
  while (Date.now() < deadline) {
    const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
    attempt++;
    const perTry = Math.min(6000, deadline - Date.now());
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
//  is needed. We keep only curated 5-star luxury brands. Throws on transport
//  errors so the caller can fall back to captured data.
// -----------------------------------------------------------------------------
async function overpassLuxuryHotels(centroid, timeoutMs) {
  const radius = 3000; // metres around the centroid
  const ql =
    "[out:json][timeout:12];(" +
    `node["tourism"="hotel"](around:${radius},${centroid.lat},${centroid.lng});` +
    `way["tourism"="hotel"](around:${radius},${centroid.lat},${centroid.lng});` +
    ");out center tags 80;";
  const data = await overpassFetch(ql, timeoutMs);
  const seen = new Set();
  const hotels = [];
  for (const el of data.elements || []) {
    const name = el.tags?.name;
    if (!name || !FIVE_STAR_RE.test(name)) continue;
    const lat = el.lat ?? el.center?.lat;
    const lng = el.lon ?? el.center?.lon;
    if (typeof lat !== "number" || typeof lng !== "number") continue;
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    if (seen.has(id)) continue;
    seen.add(id);
    const street = [el.tags["addr:housenumber"], el.tags["addr:street"]].filter(Boolean).join(" ");
    hotels.push({
      id,
      name,
      address: street ? `${street}, San Francisco, CA` : "San Francisco, CA",
      lat,
      lng,
      stars: 5,
      nightlyRateUSD: null,
      url: el.tags.website || el.tags["contact:website"] || `https://www.openstreetmap.org/${el.type}/${el.id}`,
      highlights: el.tags.brand ? `${el.tags.brand} \u2014 luxury 5-star property` : "Luxury 5-star property (OpenStreetMap)",
    });
  }
  return hotels;
}

// Approx. centroid of downtown San Francisco (Union Square), used only to warm
// the Overpass mirror at startup so the first live demo click isn't slow.
const SF_DOWNTOWN = { lat: 37.78905, lng: -122.403214 };

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
    const hotels = await overpassLuxuryHotels(SF_DOWNTOWN, config.webiq.timeoutMs);
    console.log(`[WebIQ] Overpass pre-warmed in ${((Date.now() - started) / 1000).toFixed(1)}s (${hotels.length} hotels; first live search will be fast).`);
  } catch (err) {
    console.log(`[WebIQ] pre-warm skipped: ${err.message}`);
  }
}

/**
 * Find 5-star hotels near the centroid, ranked nearest-first.
 * @param {{lat:number,lng:number}} centroid
 * @param {object} [opts]
 * @returns {Promise<{hotels:object[], mode:string, status:string, query:string, detail:string}>}
 */
export async function searchHotels(centroid, opts = {}) {
  const mode = (opts.mode || config.webiq.mode || "captured").toLowerCase();
  const query = buildQuery(centroid);
  const started = Date.now();

  const useCaptured = async (status, detail) => {
    const data = await loadCapturedHotels();
    const ranked = rankHotelsByDistance(data.hotels, centroid);
    logCall({
      type: "WEBIQ",
      title: "WebIQ Search",
      mode: "CAPTURED",
      callSite: CALL_SITE,
      request: query,
      responseSummary: `${ranked.length} 5-star hotels (captured) \u2014 nearest: ${ranked[0]?.name}`,
      durationMs: Date.now() - started,
      status,
      detail,
    });
    return { hotels: ranked, mode: "CAPTURED", status, query, detail: detail || "" };
  };

  if (mode === "captured") return useCaptured("ok", "Captured mode (configured).");

  try {
    // Prefer a real web-search provider when a key is configured; otherwise use
    // the keyless OpenStreetMap Overpass API so the live path works out of the box.
    const { bingKey, serpApiKey, timeoutMs } = config.webiq;
    let hotels;
    let provider;
    if (bingKey || serpApiKey) {
      const results = await callLiveWebSearch(query);
      hotels = await resultsToHotels(results);
      provider = bingKey ? "Bing Web Search" : "SerpApi";
    } else {
      hotels = await overpassLuxuryHotels(centroid, timeoutMs);
      provider = "OpenStreetMap Overpass";
    }
    if (hotels.length === 0) throw new Error("Live web search returned no mappable 5-star hotels.");
    const ranked = rankHotelsByDistance(hotels, centroid);
    logCall({
      type: "WEBIQ",
      title: "WebIQ Search",
      mode: "LIVE",
      callSite: CALL_SITE,
      request: query,
      responseSummary: `${ranked.length} hotels from live web search (${provider}) \u2014 nearest: ${ranked[0]?.name}`,
      durationMs: Date.now() - started,
      status: "ok",
    });
    return { hotels: ranked, mode: "LIVE", status: "ok", query, detail: "" };
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
    return useCaptured("fallback", `Live web search failed, replayed captured hotels. Reason: ${err.message}`);
  }
}
