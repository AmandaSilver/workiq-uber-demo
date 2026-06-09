// server/services/receiptParser.js
// Turn a LIVE WorkIQ answer into structured, mapped rides.
//
// To keep the LIVE path reliable we ASK WorkIQ for strict JSON (see workiq.js).
// This parser therefore tries JSON first, then falls back to a tolerant
// markdown/prose parser for the case where WorkIQ answered in prose anyway.
import { geocode } from "./geocode.js";

const AIRPORT_RX = /\b(airport|sfo|sjc|oak|terminal|intl)\b/i;

function isAirport(...addresses) {
  return addresses.some((a) => a && AIRPORT_RX.test(a));
}

function money(v) {
  if (typeof v === "number") return v;
  if (!v) return null;
  const m = String(v).replace(/[, ]/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? parseFloat(m[1]) : null;
}

function stripFences(text) {
  return text.replace(/```(?:json)?/gi, "").trim();
}

// --- JSON path ---------------------------------------------------------------
function tryParseJson(text) {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  let arr;
  try {
    arr = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  return arr.map((o, i) => ({
    id: o.id || `live-${i + 1}`,
    date: o.date || o.day || "",
    time: o.time || "",
    pickup: { address: o.pickupAddress || o.pickup || o.from || "" },
    dropoff: { address: o.dropoffAddress || o.dropoff || o.to || "" },
    total: money(o.total ?? o.amount ?? o.totalAmount),
  }));
}

// --- Prose path --------------------------------------------------------------
function tryParseProse(text) {
  const rides = [];
  // Match "Pickup: X ... Dropoff: Y ... Total: $Z" possibly across one block.
  const blocks = text.split(/\n(?=\s*\d+[\).]|\s*#|\s*-\s)/);
  for (const block of blocks) {
    const pickup = block.match(/pickup[^:]*:\s*([^\n]+?)(?:\s+[-\u2014]\s+dropoff|\n|$)/i);
    const dropoff = block.match(/drop\s*-?off[^:]*:\s*([^\n]+?)(?:\s+[-\u2014]\s+total|\n|$)/i);
    const total = block.match(/total[^$]*\$?\s*([\d,]+\.\d{2})/i);
    if (pickup && dropoff && total) {
      const date = block.match(/((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^,]*,\s*[A-Z][a-z]+\.?\s*\d{1,2},?\s*\d{4})/);
      const time = block.match(/(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i);
      rides.push({
        id: `live-${rides.length + 1}`,
        date: date ? date[1].trim() : "",
        time: time ? time[1].trim() : "",
        pickup: { address: pickup[1].replace(/[\u2014-].*$/, "").trim() },
        dropoff: { address: dropoff[1].replace(/[\u2014-].*$/, "").trim() },
        total: money(total[1]),
      });
    }
  }
  return rides.length ? rides : null;
}

/**
 * Parse a raw WorkIQ answer into structured rides and enrich with coordinates.
 * @returns {Promise<{rides: object[], parser: "json"|"prose"}>}
 */
export async function parseReceipts(rawText) {
  const parsed = tryParseJson(rawText) || tryParseProse(rawText) || [];
  const parser = tryParseJson(rawText) ? "json" : "prose";

  for (const r of parsed) {
    r.isAirport = isAirport(r.pickup.address, r.dropoff.address);
    r.currency = r.currency || "USD";
    if (r.pickup.lat == null) {
      const g = await geocode(r.pickup.address);
      if (g) { r.pickup.lat = g.lat; r.pickup.lng = g.lng; }
    }
    if (r.dropoff.lat == null) {
      const g = await geocode(r.dropoff.address);
      if (g) { r.dropoff.lat = g.lat; r.dropoff.lng = g.lng; }
    }
    if (!r.pickup.name) r.pickup.name = r.pickup.address;
    if (!r.dropoff.name) r.dropoff.name = r.dropoff.address;
  }
  // Only keep rides we could actually place on the map.
  const rides = parsed.filter(
    (r) => Number.isFinite(r.pickup.lat) && Number.isFinite(r.dropoff.lat)
  );
  return { rides, parser };
}
