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

// A bare "yes / sure / go ahead" answers the assistant's standing offer to find
// a hotel. Kept narrow so it doesn't swallow real questions.
const AFFIRMATIVE_RE = /^(y|yes|yep|yeah|yup|sure|ok|okay|please|do it|go ahead|sounds good|absolutely|definitely)\b/i;

const STAR_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5 };

// Render a star rating as "3-star". Falls back to 5-star for anything unparseable.
export function starWord(n) {
  const x = Math.round(Number(n));
  return Number.isFinite(x) && x >= 1 && x <= 5 ? `${x}-star` : "5-star";
}

// Pull a requested star rating (1-5) out of a chat message. Understands both
// digit ("3-star", "4 star") and word ("three-star", "five star") forms so the
// demo can pivot from the scripted 5-star ask to any tier the presenter types.
// Defaults to `fallback` (5) when no rating is mentioned.
export function parseRequestedStars(question, fallback = 5) {
  const q = String(question || "").toLowerCase();
  let m = q.match(/\b([1-5])\s*[-\s]?\s*star\b/);
  if (m) return Number(m[1]);
  m = q.match(/\b(one|two|three|four|five)[\s-]?star\b/);
  if (m) return STAR_WORDS[m[1]];
  return fallback;
}

// Does this chat message ask us to actually FIND / CHOOSE a hotel (at any star
// tier)? The /api/ask route uses this to run a live WebIQ search straight from
// chat, so "find me a 3-star hotel" (or a simple "yes please") really pulls a
// result instead of telling the presenter to "run step 4".
export function chatWantsHotelSearch(question) {
  const q = String(question || "").toLowerCase().trim();
  if (!q) return false;
  // Explicitly naming a star tier ("4-star", "three star") is itself a request
  // to find a hotel at that tier — no action verb needed ("what about a 4-star?").
  const mentionsStarTier = /\b([1-5][\s-]?star|(?:one|two|three|four|five)[\s-]?star)\b/.test(q);
  if (mentionsStarTier) return true;
  const mentionsHotel = /\b(hotel|hotels|stay|lodging|accommodation)\b/.test(q);
  const askVerb = /\b(find|search|look\s*up|get|show|pull|recommend|suggest|book|pick|choose|which|what'?s|whats|where|nearest|closest|best|top)\b/.test(q);
  if (mentionsHotel && askVerb) return true;
  if (mentionsHotel && /\b(yes|yeah|sure|ok|okay|please)\b/.test(q)) return true;
  if (AFFIRMATIVE_RE.test(q) && q.length <= 30) return true;
  return false;
}

// Conversational confirmation once a hotel has actually been located via WebIQ.
// No robotic "based on the center of your rides…" preamble. `requestedStars` is
// what the user asked for; `hotel.stars` is what we actually found (they can
// differ when no exact tier exists nearby).
export function answerHotelFound(recommendation, hotel, requestedStars = 5) {
  const hood = (recommendation?.neighborhood || "downtown San Francisco").split(",")[0];
  const want = starWord(requestedStars);
  if (!hotel) {
    return `I couldn't pull a ${want} hotel near **${hood}** just now \u2014 try the **Search with WebIQ** button to retry.`;
  }
  const got = starWord(hotel.stars || requestedStars);
  const dist = hotel.distanceMiles != null ? ` \u2014 just **${hotel.distanceMiles} mi** from the center of your rides` : "";
  const rate = hotel.nightlyRateUSD ? ` It runs about **$${hotel.nightlyRateUSD}/night**.` : "";
  const lead =
    got === want
      ? `The closest **${want}** hotel to **${hood}** is **${hotel.name}**`
      : `I couldn't find a **${want}** hotel near **${hood}**, but the closest match is a **${got}** property, **${hotel.name}**`;
  return `${lead}${dist}.${rate} I've dropped it on the map and queued it for the report.`;
}

// Deterministic follow-up answers for the free-form chat input. Each answer is
// grounded in the already-extracted trip data (no extra WorkIQ call), so it's
// reliable on stage. Returns markdown.
export function answerTripFollowUp(question, { rides, summary, recommendation, recommendedHotel } = {}) {
  const q = String(question || "").toLowerCase().trim();
  if (!rides || rides.length === 0) {
    return "Press **Ask WorkIQ** (step 1) first so I can scan your mailbox \u2014 then I can answer anything about the trip.";
  }
  const s = summary || summarizeRides(rides);
  const has = (...ws) => ws.some((w) => q.includes(w));

  // Compound "give me a debrief / recap" questions (often asking several things
  // at once) get the full synthesized answer instead of one narrow stat.
  if (
    has("debrief", "recap", "summary", "summarize", "overview", "rundown", "tell me about") ||
    (has("how many") && has("spend", "spent", "cost"))
  ) {
    return synthesizeTripAnswer({ rides, summary: s, recommendation });
  }
  const inCity = rides.filter((r) => !r.isAirport);
  const byCost = rides.slice().sort((a, b) => (b.total || 0) - (a.total || 0));
  const byTime = rides.slice().sort((a, b) => `${a.date}${a.time || ""}`.localeCompare(`${b.date}${b.time || ""}`));
  const dates = rides.map((r) => r.date).filter(Boolean).sort();
  const hood = recommendation?.neighborhood || "downtown San Francisco";
  const hoodShort = hood.split(",")[0];

  // Greetings / thanks / small talk.
  if (/^(hi|hey|hello|yo|thanks|thank you|thx|cheers|nice|cool|awesome|great|got it)\b/.test(q)) {
    return `Happy to help! Ask me anything about your San Francisco trip \u2014 spend, rides, dates, or where to stay.`;
  }

  // List / itemize every ride.
  if (has("list", "all rides", "each ride", "every ride", "itemize", "itinerary", "show me the rides", "all my rides")) {
    const items = rides.map(
      (r) => `- **${formatDay(r.date)}** \u2014 ${stripParen(r.pickup)} \u2192 ${stripParen(r.dropoff)} \u00b7 ${usd(r.total)}${r.isAirport ? " _(airport)_" : ""}`
    );
    return [`Here are all **${rides.length}** rides:`, "", ...items].join("\n");
  }

  // How many rides.
  if (has("how many ride", "how many uber", "how many trip", "number of ride", "ride count")) {
    return `You took **${s.rideCount}** Uber rides \u2014 **${s.inCityRideCount}** around town and **${s.airportRideCount}** airport transfer${
      s.airportRideCount === 1 ? "" : "s"
    }.`;
  }

  // Cheapest ride.
  if (has("cheapest", "least expensive", "lowest", "smallest fare")) {
    const low = byCost[byCost.length - 1];
    return `Your cheapest ride was **${usd(low.total)}** on ${formatDay(low.date)} \u2014 ${stripParen(low.pickup)} \u2192 ${stripParen(low.dropoff)}.`;
  }

  // Priciest ride.
  if (has("priciest", "expensive", "highest", "biggest", "most i spent", "most expensive")) {
    const top = byCost[0];
    return `Your priciest ride was **${usd(top.total)}** on ${formatDay(top.date)} \u2014 ${stripParen(top.pickup)} \u2192 ${stripParen(top.dropoff)}${
      top.isAirport ? " (an airport transfer)" : ""
    }.`;
  }

  // Average fare.
  if (has("average", "avg", "mean fare", "per ride", "typical")) {
    const avg = s.grandTotalUSD / Math.max(1, s.rideCount);
    const avgCity = inCity.length ? s.inCityTotalUSD / inCity.length : 0;
    return `On average you spent **${usd(avg)}** per ride \u2014 about **${usd(avgCity)}** for each in-city hop.`;
  }

  // First / last ride.
  if (has("first ride", "earliest", "started the trip", "begin")) {
    const r = byTime[0];
    return `Your first ride was on **${formatDay(r.date)}** \u2014 ${stripParen(r.pickup)} \u2192 ${stripParen(r.dropoff)} \u00b7 ${usd(r.total)}.`;
  }
  if (has("last ride", "latest", "final ride", "ended the trip")) {
    const r = byTime[byTime.length - 1];
    return `Your last ride was on **${formatDay(r.date)}** \u2014 ${stripParen(r.pickup)} \u2192 ${stripParen(r.dropoff)} \u00b7 ${usd(r.total)}.`;
  }

  // Airport transfers.
  if (has("airport", "sfo", "transfer")) {
    const ap = rides.filter((r) => r.isAirport);
    if (!ap.length) return "There were no airport transfers in this trip.";
    const apTotal = ap.reduce((a, r) => a + (r.total || 0), 0);
    const items = ap.map((r) => `- ${formatDay(r.date)} \u2014 ${stripParen(r.pickup)} \u2192 ${stripParen(r.dropoff)} \u00b7 ${usd(r.total)}`);
    return [
      `You had **${ap.length}** airport transfer${ap.length === 1 ? "" : "s"} totaling **${usd(apTotal)}**:`,
      "",
      ...items,
      "",
      "_These sit out of the stay-area recommendation \u2014 you don't stay at the airport._",
    ].join("\n");
  }

  // Dates / duration.
  if (has("when", "what date", "how long", "days", "dates", "duration")) {
    const span = dates.length ? Math.round((new Date(dates[dates.length - 1]) - new Date(dates[0])) / 86400000) + 1 : 0;
    return `Your rides ran from **${formatDay(dates[0])}** to **${formatDay(dates[dates.length - 1])}** \u2014 about **${span} day${
      span === 1 ? "" : "s"
    }**, ${s.rideCount} rides in all.`;
  }

  // Why this neighborhood / explain the recommendation.
  if (has("why", "explain", "how did you", "how do you know", "reason", "rationale")) {
    return `I took the geographic center of your **${s.inCityRideCount}** in-city rides \u2014 airport runs excluded, since you don't stay at SFO. That center lands in **${hoodShort}**, making it the most convenient base for next year.`;
  }

  // Hotel / where to stay (text answer only; the route handles actually searching).
  if (has("hotel", "stay", "where should", "base", "neighborhood", "area", "recommend", "lodging") || /\bstar\b/.test(q)) {
    if (recommendedHotel) {
      const h = recommendedHotel;
      return `The closest **${starWord(h.stars || 5)}** hotel to **${hoodShort}** is **${h.name}**${h.distanceMiles != null ? ` (**${h.distanceMiles} mi** away)` : ""}${
        h.nightlyRateUSD ? `, about $${h.nightlyRateUSD}/night` : ""
      }. It's on the map and queued for the report.`;
    }
    return `Based on your in-city rides, the best base is **${hoodShort}**. Want me to pull a nearby hotel? Just say \u201cfind a 5-star hotel\u201d (or 3-star, 4-star\u2026).`;
  }

  // Total / spend.
  if (has("total", "spend", "spent", "cost", "how much", "budget", "altogether", "sum")) {
    const airportTotal = Math.round((s.grandTotalUSD - s.inCityTotalUSD) * 100) / 100;
    return [
      `You spent **${usd(s.grandTotalUSD)}** across **${s.rideCount}** rides:`,
      "",
      `- In-city: **${usd(s.inCityTotalUSD)}** (${s.inCityRideCount} rides)`,
      `- Airport: **${usd(airportTotal)}** (${s.airportRideCount} rides)`,
    ].join("\n");
  }

  // Catch-all: acknowledge and offer concrete angles (less canned).
  return [
    `I'm grounded in the **${s.rideCount}** Uber receipts WorkIQ pulled, so I can slice this trip a few ways \u2014 for example:`,
    "",
    "- \u201cWhat did I spend?\u201d \u00b7 \u201cWhat was the average fare?\u201d",
    "- \u201cWhich ride was priciest?\u201d \u00b7 \u201cWhich was cheapest?\u201d",
    "- \u201cWhat dates was the trip?\u201d \u00b7 \u201cList all my rides.\u201d",
    "- \u201cWhy " + hoodShort + "?\u201d \u00b7 \u201cFind me a 5-star hotel.\u201d",
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
