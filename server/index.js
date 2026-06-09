// server/index.js
// Express server: serves the UI and exposes the demo API. Each route delegates
// to a clearly-named WorkIQ/WebIQ/Tool service so the call boundaries stay obvious.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ROOT_DIR } from "./config.js";
import { askWorkIQ, prewarmWorkIQ } from "./services/workiq.js";
import { searchHotels, prewarmWebIQ } from "./services/webiq.js";
import { enrichRidesWithRoutes } from "./services/routing.js";
import { sendReport } from "./services/mailer.js";
import { getCalls, clearCalls } from "./services/callLog.js";
import {
  summarizeRides,
  computeStayCentroid,
  labelNeighborhood,
  rankHotelsByDistance,
  synthesizeTripAnswer,
  answerTripFollowUp,
  TRIP_DEBRIEF_QUESTION,
} from "./services/recommendation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));

// A trip needs at least this many in-city rides before its geographic center is
// a meaningful "where to stay" signal. Below this, the live result is too thin
// and we fall back to the representative sample (see /api/scan-receipts).
const MIN_INCITY_FOR_LIVE = 3;

// In-memory demo state (single-user demo; reset via POST /api/reset).
const state = {
  tripLabel: "Your recent trip",
  rides: [],
  summary: null,
  recommendation: null,
  hotels: [],
  recommendedHotel: null,
  // Provenance of the currently-loaded dataset and whether it can drive the
  // stay-area recommendation. A single scan (live, or captured fallback) fills
  // these in; the recommendation runs directly on whatever is loaded.
  source: null, // "LIVE" | "CAPTURED" | null
  readyForRecommendation: false,
};

function recomputeRecommendation() {
  if (state.rides.length === 0) {
    state.recommendation = null;
    return null;
  }
  const centroidInfo = computeStayCentroid(state.rides);
  if (!centroidInfo) {
    state.recommendation = null;
    return null;
  }
  state.recommendation = {
    centroid: centroidInfo.centroid,
    neighborhood: labelNeighborhood(centroidInfo.centroid),
    pointCount: centroidInfo.pointCount,
    usedAirportFallback: centroidInfo.usedAirportFallback,
    includedRideIds: centroidInfo.includedRideIds,
    excludedRideIds: centroidInfo.excludedRideIds,
  };
  return state.recommendation;
}

// --- Health & config ---------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    workiqMode: config.workiq.mode,
    workiqLiveConfigured: Boolean(config.workiq.mcpCommand),
    webiqMode: config.webiq.mode,
    webiqLiveConfigured: Boolean(config.webiq.bingKey || config.webiq.serpApiKey),
    mailMode: config.mail.mode,
  });
});

app.get("/api/config", (_req, res) => {
  res.json({
    workiqMode: config.workiq.mode,
    webiqMode: config.webiq.mode,
    mailMode: config.mail.mode,
    workiqLiveConfigured: Boolean(config.workiq.mcpCommand),
    webiqLiveConfigured: Boolean(config.webiq.bingKey || config.webiq.serpApiKey),
  });
});

// --- Step 1: WorkIQ Ask -> scan email for receipts ---------------------------
let scanInFlight = false; // server-side guard: never run two scans at once.
app.post("/api/scan-receipts", async (req, res) => {
  if (scanInFlight) {
    return res.status(409).json({ error: "A scan is already running. Please wait for it to finish.", code: "SCAN_IN_FLIGHT" });
  }
  scanInFlight = true;
  try {
    const requestedMode = (req.body?.mode || "").toLowerCase(); // "", "live", "captured", "auto"
    let result = await askWorkIQ({ mode: req.body?.mode });

    // Single fully-live flow with a captured safety net. A real mailbox is the
    // hero, but a trip with only a ride or two can't produce a meaningful
    // stay-area centroid. When live succeeds yet returns too few in-city rides,
    // transparently fall back to the representative sample so the planning steps
    // still have something compelling to work with. Skip this only when the
    // presenter has explicitly pinned the mode to "live".
    let liveProof = null;
    const inCityCount = (rides) => rides.filter((r) => !r.isAirport).length;
    if (result.mode === "LIVE" && requestedMode !== "live" && inCityCount(result.rides) < MIN_INCITY_FOR_LIVE) {
      liveProof = { rideCount: result.rides.length, inCity: inCityCount(result.rides) };
      const captured = await askWorkIQ({ mode: "captured" });
      captured.status = "fallback";
      captured.detail = `Live mailbox returned only ${liveProof.inCity} in-city ride(s) \u2014 using the representative sample so the recommendation is meaningful.`;
      result = captured;
    }

    // Draw believable, street-following routes. Captured rides already have
    // routes baked in; live rides get best-effort routing that never blocks the
    // response for long and silently falls back to straight lines.
    await enrichRidesWithRoutes(result.rides, { budgetMs: 9000 });
    state.rides = result.rides;
    state.summary = summarizeRides(result.rides);
    state.source = result.mode; // "LIVE" | "CAPTURED"
    // A fresh scan invalidates any downstream results from a prior dataset.
    state.hotels = [];
    state.recommendedHotel = null;
    // The active dataset (live or sample) drives the recommendation directly:
    // ready as soon as we can compute a centroid from it.
    state.readyForRecommendation = Boolean(recomputeRecommendation());
    // Synthesize the conversational "trip debrief" answer for the Ask chat panel,
    // grounded in the receipts WorkIQ just extracted.
    const chatAnswer = synthesizeTripAnswer({
      rides: state.rides,
      summary: state.summary,
      recommendation: state.recommendation,
    });
    res.json({
      mode: result.mode,
      status: result.status,
      detail: result.detail,
      parser: result.parser,
      prompt: result.prompt,
      rawText: result.rawText,
      tripLabel: state.tripLabel,
      rides: state.rides,
      summary: state.summary,
      source: state.source,
      liveProof,
      readyForRecommendation: state.readyForRecommendation,
      chatQuestion: TRIP_DEBRIEF_QUESTION,
      chatAnswer,
    });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code || "WORKIQ_ERROR" });
  } finally {
    scanInFlight = false;
  }
});

// --- Step 2: recommendation (geographic center of the trip) ------------------
app.get("/api/recommendation", (_req, res) => {
  if (state.rides.length === 0) {
    return res.status(409).json({ error: "No rides yet. Run /api/scan-receipts first." });
  }
  const reco = recomputeRecommendation();
  if (!reco) {
    return res.status(409).json({
      error: "Not enough in-city ride points to compute a stay-area center.",
      code: "NOT_READY_FOR_RECOMMENDATION",
    });
  }
  res.json({ recommendation: reco, summary: state.summary });
});

// --- Step 3: WebIQ -> best 5-star hotel near the recommendation --------------
app.post("/api/find-hotels", async (req, res) => {
  if (!state.recommendation) {
    return res.status(409).json({ error: "No recommendation yet. Run scan + recommendation first." });
  }
  try {
    const result = await searchHotels(state.recommendation.centroid, { mode: req.body?.mode });
    state.hotels = result.hotels;
    state.recommendedHotel = result.hotels[0] || null;
    res.json({
      mode: result.mode,
      status: result.status,
      detail: result.detail,
      query: result.query,
      hotels: result.hotels,
      recommendedHotel: state.recommendedHotel,
    });
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code || "WEBIQ_ERROR" });
  }
});

// --- Step 4: WorkIQ Tool -> email the report ---------------------------------
app.post("/api/send-report", async (req, res) => {
  if (state.rides.length === 0) {
    return res.status(409).json({ error: "Nothing to report yet. Run the analysis first." });
  }
  try {
    const payload = {
      tripLabel: state.tripLabel,
      summary: state.summary,
      rides: state.rides,
      recommendation: state.recommendation,
      hotel: state.recommendedHotel,
    };
    const result = await sendReport(payload, { mode: req.body?.mode, to: req.body?.to });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message, code: err.code || "MAIL_ERROR" });
  }
});

// --- Ask chat: deterministic follow-up Q&A over the extracted trip data ------
// Powers the free-form chat input. Answers are grounded in the rides WorkIQ
// already pulled (no extra live call), so follow-ups are reliable on stage.
app.post("/api/ask", (req, res) => {
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "Empty question." });
  const answer = answerTripFollowUp(question, {
    rides: state.rides,
    summary: state.summary,
    recommendation: state.recommendation,
    recommendedHotel: state.recommendedHotel,
  });
  res.json({ answer });
});

// --- Call log + reset --------------------------------------------------------
app.get("/api/call-log", (_req, res) => res.json({ calls: getCalls() }));

app.post("/api/reset", (_req, res) => {
  state.rides = [];
  state.summary = null;
  state.recommendation = null;
  state.hotels = [];
  state.recommendedHotel = null;
  state.source = null;
  state.readyForRecommendation = false;
  clearCalls();
  res.json({ ok: true });
});

// --- Static UI ---------------------------------------------------------------
app.use(express.static(path.join(ROOT_DIR, "public")));

app.listen(config.port, () => {
  console.log("\n  WorkIQ Trip Planner \u2014 hero demo");
  console.log(`  \u25b6 http://localhost:${config.port}`);
  console.log(`  modes: WorkIQ=${config.workiq.mode}  WebIQ=${config.webiq.mode}  Mail=${config.mail.mode}\n`);
  // Warm the live WorkIQ MCP server in the background so the first demo click is
  // fast (no-op in captured mode). Fire-and-forget; failures are logged, not fatal.
  prewarmWorkIQ();
  // Likewise warm the keyless live WebIQ (Overpass) path so the first hotel
  // search isn't slow when the public mirrors are cold.
  prewarmWebIQ();
});
