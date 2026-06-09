// server/services/recommendation.js
// Pure logic (no external calls): given the rides, work out where to stay.
//
// Heuristic: the best base for next year's trip is the geographic center of the
// places you actually needed to be. Airport transfers are EXCLUDED because they
// pull the center toward SFO and you don't "stay" at the airport. We compute the
// centroid of every non-airport pickup/dropoff endpoint, then rank hotels by
// straight-line (haversine) distance to that centroid.

const EARTH_KM = 6371;
const toRad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export function kmToMiles(km) {
  return km * 0.621371;
}

export function summarizeRides(rides) {
  const grandTotal = rides.reduce((s, r) => s + (r.total || 0), 0);
  const airport = rides.filter((r) => r.isAirport);
  const inCity = rides.filter((r) => !r.isAirport);
  return {
    rideCount: rides.length,
    airportRideCount: airport.length,
    inCityRideCount: inCity.length,
    grandTotalUSD: Math.round(grandTotal * 100) / 100,
    inCityTotalUSD: Math.round(inCity.reduce((s, r) => s + (r.total || 0), 0) * 100) / 100,
  };
}

/**
 * @param {object[]} rides
 * @returns {{centroid:{lat,lng}, pointCount:number, usedAirportFallback:boolean,
 *            includedRideIds:string[], excludedRideIds:string[]}}
 */
export function computeStayCentroid(rides) {
  let source = rides.filter((r) => !r.isAirport);
  let usedAirportFallback = false;

  // Fallback: if every ride was an airport transfer, use all endpoints rather
  // than recommending nothing.
  if (source.length === 0) {
    source = rides;
    usedAirportFallback = true;
  }

  const pts = [];
  for (const r of source) {
    if (Number.isFinite(r.pickup?.lat)) pts.push(r.pickup);
    if (Number.isFinite(r.dropoff?.lat)) pts.push(r.dropoff);
  }
  if (pts.length === 0) return null;

  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lng = pts.reduce((s, p) => s + p.lng, 0) / pts.length;

  return {
    centroid: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 },
    pointCount: pts.length,
    usedAirportFallback,
    includedRideIds: source.map((r) => r.id),
    excludedRideIds: rides.filter((r) => !source.includes(r)).map((r) => r.id),
  };
}

// Very small neighborhood lookup so the recommendation reads naturally.
const NEIGHBORHOODS = [
  { name: "SoMa / Yerba Buena, San Francisco", lat: 37.785, lng: -122.401 },
  { name: "Union Square, San Francisco", lat: 37.788, lng: -122.4075 },
  { name: "Financial District, San Francisco", lat: 37.7946, lng: -122.3999 },
  { name: "Nob Hill, San Francisco", lat: 37.7929, lng: -122.4156 },
  { name: "Fisherman's Wharf, San Francisco", lat: 37.808, lng: -122.4177 },
];

export function labelNeighborhood(centroid) {
  let best = null;
  let bestKm = Infinity;
  for (const n of NEIGHBORHOODS) {
    const km = haversineKm(centroid, n);
    if (km < bestKm) { bestKm = km; best = n; }
  }
  return best ? best.name : "Downtown San Francisco";
}

// --- Trip debrief synthesis (for the Ask chat panel) -------------------------
// Deterministically turns the parsed rides into a short, conversational debrief
// (markdown). It's grounded entirely in the receipts WorkIQ extracted, so the
// numbers always match the data and the formatting is always clean — exactly
// what we want for a live "show me Ask's synthesized answer" moment.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function formatDateRange(startIso, endIso) {
  const year = new Date(`${endIso}T00:00:00Z`).getUTCFullYear();
  if (startIso === endIso) return `${formatDay(startIso)}, ${year}`;
  return `${formatDay(startIso)} \u2013 ${formatDay(endIso)}, ${year}`;
}

// The canned opening question the demo asks on behalf of the presenter.
export const TRIP_DEBRIEF_QUESTION =
  "Give me a quick debrief of my San Francisco trip \u2014 how many Uber rides did I take, what did I spend, and where did I spend most of my time?";

const stripParen = (p) => (p?.name || p?.address || "").replace(/\s*\(.*?\)\s*/g, "").trim();
const usd = (n) => `$${Number(n || 0).toFixed(2)}`;

export function synthesizeTripAnswer({ rides, summary, recommendation } = {}) {
  if (!rides || rides.length === 0) {
    return "I didn't find any Uber receipts in your mailbox for the last few weeks.";
  }
  const s = summary || summarizeRides(rides);
  const dates = rides.map((r) => r.date).filter(Boolean).sort();
  const range = dates.length ? formatDateRange(dates[0], dates[dates.length - 1]) : "the last few weeks";
  const airportTotal = Math.round((s.grandTotalUSD - s.inCityTotalUSD) * 100) / 100;
  const inCity = rides.filter((r) => !r.isAirport);
  const priciest = inCity.slice().sort((a, b) => (b.total || 0) - (a.total || 0))[0];
  const centroid = recommendation?.centroid || computeStayCentroid(rides)?.centroid;
  const hood = recommendation?.neighborhood || (centroid ? labelNeighborhood(centroid) : "downtown San Francisco");
  const hoodShort = hood.split(",")[0];

  const lines = [
    "Here's a quick debrief of your **San Francisco** trip, pulled straight from the Uber receipts in your mailbox:",
    "",
    `- **${s.rideCount} rides** between **${range}**`,
    `- **${usd(s.grandTotalUSD)} total** \u2014 ${s.inCityRideCount} in-city ride${s.inCityRideCount === 1 ? "" : "s"} (${usd(s.inCityTotalUSD)})${
      s.airportRideCount ? ` plus ${s.airportRideCount} airport transfer${s.airportRideCount === 1 ? "" : "s"} (${usd(airportTotal)})` : ""
    }`,
  ];
  if (priciest) {
    lines.push(`- Priciest in-city hop: **${usd(priciest.total)}** \u2014 ${stripParen(priciest.pickup)} \u2192 ${stripParen(priciest.dropoff)}`);
  }
  lines.push(`- Most of your rides clustered around **${hoodShort}**, so that's where you spent the bulk of your time`);
  lines.push("");
  lines.push(`If you treat this year as the template for next year, the best base is **${hood}** \u2014 the geographic center of your in-city rides.`);
  lines.push("");
  lines.push("Want me to find the closest 5-star hotel there?");
  return lines.join("\n");
}

// Deterministic follow-up answers for the free-form chat input. Each answer is
// grounded in the already-extracted trip data (no extra WorkIQ call), so it's
// reliable on stage. Returns markdown.
export function answerTripFollowUp(question, { rides, summary, recommendation, recommendedHotel } = {}) {
  const q = String(question || "").toLowerCase();
  if (!rides || rides.length === 0) {
    return "Run **step 1 (Ask WorkIQ)** first so I can scan your mailbox \u2014 then I can answer questions about the trip.";
  }
  const s = summary || summarizeRides(rides);
  const has = (...ws) => ws.some((w) => q.includes(w));

  if (has("list", "all rides", "each ride", "show me", "every ride", "itemize")) {
    const items = rides.map(
      (r) => `- ${r.date} \u2014 ${stripParen(r.pickup)} \u2192 ${stripParen(r.dropoff)} \u00b7 ${usd(r.total)}${r.isAirport ? " _(airport)_" : ""}`
    );
    return [`Here are all **${rides.length}** rides:`, "", ...items].join("\n");
  }
  if (has("priciest", "expensive", "highest", "biggest", "most i spent")) {
    const top = rides.slice().sort((a, b) => (b.total || 0) - (a.total || 0))[0];
    return `Your priciest ride was **${usd(top.total)}** on ${top.date} \u2014 ${stripParen(top.pickup)} \u2192 ${stripParen(top.dropoff)}${
      top.isAirport ? " (an airport transfer)" : ""
    }.`;
  }
  if (has("airport", "sfo", "transfer")) {
    const ap = rides.filter((r) => r.isAirport);
    if (!ap.length) return "There were no airport transfers in this trip.";
    const apTotal = ap.reduce((a, r) => a + (r.total || 0), 0);
    const items = ap.map((r) => `- ${r.date} \u2014 ${stripParen(r.pickup)} \u2192 ${stripParen(r.dropoff)} \u00b7 ${usd(r.total)}`);
    return [
      `You had **${ap.length}** airport transfer${ap.length === 1 ? "" : "s"} totaling **${usd(apTotal)}**:`,
      "",
      ...items,
      "",
      "_These are excluded from the stay-area recommendation \u2014 you don't stay at the airport._",
    ].join("\n");
  }
  if (has("when", "what date", "how long", "days", "dates")) {
    const dates = rides.map((r) => r.date).filter(Boolean).sort();
    return `Your rides ran from **${formatDay(dates[0])}** to **${formatDay(dates[dates.length - 1])}** \u2014 ${s.rideCount} rides across that window.`;
  }
  if (has("hotel", "stay", "where", "base", "neighborhood", "area", "recommend")) {
    const hood = recommendation?.neighborhood || "downtown San Francisco";
    let out = `Based on the center of your in-city rides, the best base is **${hood}**.`;
    if (recommendedHotel) {
      const h = recommendedHotel;
      out += ` The closest 5-star option is **${h.name}**${h.distanceMiles != null ? ` (${h.distanceMiles} mi away)` : ""}${
        h.nightlyRateUSD ? `, from $${h.nightlyRateUSD}/night` : ""
      }.`;
    } else {
      out += " Run **step 4** and I'll pull the nearest 5-star hotel.";
    }
    return out;
  }
  if (has("total", "spend", "spent", "cost", "how much", "budget")) {
    const airportTotal = Math.round((s.grandTotalUSD - s.inCityTotalUSD) * 100) / 100;
    return [
      `You spent **${usd(s.grandTotalUSD)}** across **${s.rideCount}** rides:`,
      "",
      `- In-city: **${usd(s.inCityTotalUSD)}** (${s.inCityRideCount} rides)`,
      `- Airport: **${usd(airportTotal)}** (${s.airportRideCount} rides)`,
    ].join("\n");
  }
  return [
    "I can answer follow-ups about this trip, grounded in the receipts WorkIQ pulled. Try:",
    "",
    "- \u201cWhat did I spend?\u201d",
    "- \u201cWhich ride was priciest?\u201d",
    "- \u201cWhere should I stay?\u201d",
    "- \u201cWhat dates was the trip?\u201d",
    "- \u201cList all my rides.\u201d",
  ].join("\n");
}

/**
 * Rank hotels by distance to the centroid.
 * @returns {object[]} hotels sorted nearest-first with distanceKm/distanceMiles.
 */
export function rankHotelsByDistance(hotels, centroid) {
  return hotels
    .map((h) => {
      const km = haversineKm(centroid, h);
      return {
        ...h,
        distanceKm: Math.round(km * 100) / 100,
        distanceMiles: Math.round(kmToMiles(km) * 100) / 100,
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
