/* WorkIQ Trip Planner — frontend
   Drives the guided demo: calls the API, paints the map, and refreshes the
   live Call Log so the WorkIQ/WebIQ/Tool boundaries are visible at all times. */

const $ = (s) => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    method: opts.method || "GET",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};

const state = { rides: [], recommendation: null, hotels: [], lastReport: null };

/* ---------------- Map ---------------- */
const map = L.map("map", { zoomControl: true }).setView([37.79, -122.41], 13);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const layers = {
  rides: L.layerGroup().addTo(map),
  centroid: L.layerGroup().addTo(map),
  hotels: L.layerGroup().addTo(map),
};

function clearLayer(name) {
  layers[name].clearLayers();
}

// Token bumped on every drawRides() call so any in-flight animation from a
// previous call cancels itself instead of drawing onto a cleared layer.
let rideAnimToken = 0;

function rideLine(r) {
  const a = [r.pickup.lat, r.pickup.lng];
  const b = [r.dropoff.lat, r.dropoff.lng];
  // Prefer the real street-following route; fall back to a straight line.
  const pts = Array.isArray(r.route) && r.route.length > 1 ? r.route : [a, b];
  return { a, b, pts, color: r.isAirport ? "#7a8290" : "#2b9bff" };
}

function rideEndpoint(label, pt, latlng, r, color) {
  L.circleMarker(latlng, { radius: 5, color, fillColor: color, fillOpacity: 0.9, weight: 1 })
    .bindPopup(
      `<b>${label}:</b> ${pt.name || pt.address}<br>${r.date} ${r.time} &middot; $${(r.total || 0).toFixed(
        2
      )}${r.isAirport ? "<br><i>airport transfer (excluded from recommendation)</i>" : ""}`
    )
    .addTo(layers.rides);
}

// Return the leading portion of `pts` covering `frac` (0..1) of the total path
// length, so a polyline appears to "grow" along its real route at a steady pace.
function pathUpTo(pts, frac) {
  if (pts.length < 2) return pts.slice();
  let total = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    seg.push(d);
    total += d;
  }
  if (total === 0) return [pts[0]];
  const target = total * Math.max(0, Math.min(1, frac));
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    if (acc + seg[i - 1] < target) {
      out.push(pts[i]);
      acc += seg[i - 1];
    } else {
      const t = seg[i - 1] === 0 ? 0 : (target - acc) / seg[i - 1];
      out.push([
        pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t,
        pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t,
      ]);
      break;
    }
  }
  return out;
}

// Draw the rides one after another, each polyline growing along its route, so
// the whole sequence plays like a fast time-lapse of the trip (~5s total).
function animateRides(toDraw) {
  const token = ++rideAnimToken;
  const TOTAL_MS = 5000;
  const perRide = Math.max(350, TOTAL_MS / toDraw.length);
  const drawDur = Math.max(220, perRide - 120); // small gap between rides
  let idx = 0;

  function next() {
    if (token !== rideAnimToken || idx >= toDraw.length) return;
    const r = toDraw[idx];
    const { a, b, pts, color } = rideLine(r);
    rideEndpoint("From", r.pickup, a, r, color);
    const poly = L.polyline([a], {
      color,
      weight: 4,
      opacity: 0.9,
      dashArray: r.isAirport ? "6 7" : null,
    }).addTo(layers.rides);
    const head = L.circleMarker(a, { radius: 5, color, fillColor: "#fff", fillOpacity: 1, weight: 2 }).addTo(layers.rides);
    const start = performance.now();
    function step(t) {
      if (token !== rideAnimToken) return;
      const frac = Math.min(1, (t - start) / drawDur);
      const grown = pathUpTo(pts, frac);
      poly.setLatLngs(grown);
      head.setLatLng(grown[grown.length - 1]);
      if (frac < 1) {
        requestAnimationFrame(step);
      } else {
        layers.rides.removeLayer(head);
        rideEndpoint("To", r.dropoff, b, r, color);
        idx++;
        next();
      }
    }
    requestAnimationFrame(step);
  }
  next();
}

function drawRides(rides, { animate = false } = {}) {
  clearLayer("rides");
  rideAnimToken++; // cancel any animation still running from a prior call
  // Hide airport transfers — long freeway lines to SFO make the city map look
  // bad and aren't part of the "where I need to be" story. But never blank the
  // map: if every ride is an airport transfer (e.g. a thin live proof), show all.
  const inCity = rides.filter((r) => !r.isAirport);
  const toDraw = inCity.length ? inCity : rides;
  const bounds = [];
  toDraw.forEach((r) => rideLine(r).pts.forEach((pt) => bounds.push(pt)));
  // Frame the whole trip up front so the animation plays inside a stable view.
  if (bounds.length) map.fitBounds(bounds, { padding: [50, 50] });

  if (animate && toDraw.length) {
    animateRides(toDraw);
    return;
  }
  toDraw.forEach((r) => {
    const { a, b, pts, color } = rideLine(r);
    L.polyline(pts, { color, weight: 4, opacity: 0.9, dashArray: r.isAirport ? "6 7" : null }).addTo(layers.rides);
    rideEndpoint("From", r.pickup, a, r, color);
    rideEndpoint("To", r.dropoff, b, r, color);
  });
}

function drawCentroid(reco) {
  clearLayer("centroid");
  if (!reco) return;
  const icon = L.divIcon({ className: "", html: '<div class="centroid-icon">📍</div>', iconSize: [22, 22], iconAnchor: [11, 22] });
  L.marker([reco.centroid.lat, reco.centroid.lng], { icon, zIndexOffset: 500 })
    .bindPopup(`<b>Recommended stay area</b><br>${reco.neighborhood}<br><i>center of ${reco.pointCount} in-city ride points</i>`)
    .addTo(layers.centroid)
    .openPopup();
  L.circle([reco.centroid.lat, reco.centroid.lng], { radius: 500, color: "#2ecc71", weight: 1, fillOpacity: 0.06 }).addTo(layers.centroid);
}

function drawHotels(hotels) {
  clearLayer("hotels");
  hotels.forEach((h, i) => {
    const best = i === 0;
    const icon = L.divIcon({
      className: "",
      html: `<div class="hotel-icon">${best ? "⭐" : "🏨"}</div>`,
      iconSize: [20, 20],
      iconAnchor: [10, 20],
    });
    L.marker([h.lat, h.lng], { icon, zIndexOffset: best ? 400 : 200 })
      .bindPopup(
        `<b>${h.name}</b>${best ? " ⭐ closest" : ""}<br>${h.address}<br>${
          h.distanceMiles != null ? `${h.distanceMiles} mi from center` : ""
        }${h.nightlyRateUSD ? ` &middot; from $${h.nightlyRateUSD}/night` : ""}<br><a href="${h.url}" target="_blank">website</a>`
      )
      .addTo(layers.hotels);
  });
}

/* ---------------- Step helpers ---------------- */
function setStep(n, status) {
  const el = document.querySelector(`.step[data-step="${n}"]`);
  if (!el) return;
  el.classList.toggle("done", status === "done");
  el.classList.toggle("active", status === "active");
}
function busy(btn, on) {
  btn.classList.toggle("loading", on);
  btn.disabled = on;
}
// Inline, demo-friendly error: show a recoverable banner in the step's result
// panel instead of a jarring browser alert() mid-presentation.
function showError(resId, prefix, err) {
  const el = document.getElementById(resId);
  if (!el) return;
  el.hidden = false;
  el.innerHTML = `<div class="banner-fallback"><b>${escapeHtml(prefix)}</b><br>${escapeHtml(err.message || String(err))}</div>`;
}
function modeOverride(kind) {
  const v = $(`#sel-${kind}`).value;
  return v || undefined;
}
// A small, presenter-only line revealing which path actually ran (LIVE /
// CAPTURED / PREVIEW). CSS hides it whenever the Call Log is collapsed, so the
// audience never sees how the sausage is made — but you can while debugging.
function provenanceHtml(mode, status, detail) {
  const cls = status === "fallback" ? "fallback" : mode === "LIVE" ? "live" : "captured";
  const tag = status === "fallback" ? `${mode} (fallback)` : mode;
  const extra = detail ? ` — ${escapeHtml(detail)}` : "";
  return `<div class="provenance ${cls}"><span class="dot"></span><span>mode: ${escapeHtml(tag)}${extra}</span></div>`;
}

/* ---------------- Step 1: single live Ask (captured safety net) ---------------- */
let liveData = null; // the scan response (for the raw-response modal)
let scanGen = 0;     // generation token: drop renders from superseded scans

function wireRawLink() {
  const link = $("#show-raw");
  if (!link || !liveData) return;
  link.onclick = () =>
    openModal(
      "WorkIQ Ask — prompt &amp; raw response",
      `<pre>PROMPT SENT TO WORKIQ:\n\n${escapeHtml(liveData.prompt)}\n\n${"—".repeat(40)}\n\nWORKIQ RESPONSE (${liveData.mode}):\n\n${escapeHtml(liveData.rawText || "")}</pre>`
    );
}

// One fully-live flow: ask the real mailbox and let the result drive every
// downstream step. The audience sees a single neutral "receipts found" card; the
// LIVE vs CAPTURED truth is a presenter-only provenance line (hidden with the
// Call Log). If the requested path errors, we retry on captured so the demo
// never shows a red banner.
async function runScan() {
  const requested = modeOverride("workiq");
  try {
    return await api("/api/scan-receipts", { method: "POST", body: { mode: requested } });
  } catch (e) {
    if (requested === "captured") throw e; // already on the safety net
    return await api("/api/scan-receipts", { method: "POST", body: { mode: "captured" } });
  }
}

const SCAN_QUESTION =
  "Give me a quick debrief of my San Francisco trip — how many Uber rides did I take, what did I spend, and where did I spend most of my time?";

$("#btn-scan").addEventListener("click", async () => {
  const btn = $("#btn-scan");
  if (btn.disabled) return; // client-side dup guard (server also enforces)
  const myGen = ++scanGen;
  busy(btn, true);
  // Show the Ask conversation as it happens: switch to Chat, post the question,
  // and show a typing indicator while WorkIQ scans the mailbox.
  setRailTab("chat");
  clearChat();
  appendChat("user", SCAN_QUESTION);
  chatTyping(true);
  setChatEnabled(false);
  try {
    const data = await runScan();
    if (myGen !== scanGen) return; // a newer scan superseded this one
    liveData = data;
    state.rides = data.rides;
    drawRides(data.rides, { animate: true });
    const s = data.summary;
    const res = $("#res-scan");
    res.hidden = false;
    res.innerHTML = `
      <div class="proof-card">
        <div class="proof-head">✅ <b>WorkIQ Ask</b> found ${data.rides.length} Uber receipt${data.rides.length === 1 ? "" : "s"} in your mailbox</div>
        <div class="kpi-row">
          <div class="kpi"><div class="kpi-label">Receipts</div><div class="kpi-val blue">${data.rides.length}</div></div>
          <div class="kpi"><div class="kpi-label">In-city</div><div class="kpi-val">${s.inCityRideCount}</div></div>
          <div class="kpi"><div class="kpi-label">Total</div><div class="kpi-val green">$${s.grandTotalUSD.toFixed(2)}</div></div>
        </div>
        ${provenanceHtml(data.mode, data.status, data.detail)}
        <p style="margin:8px 0 0"><span class="linklike" id="show-raw">View WorkIQ response &amp; prompt →</span></p>
      </div>`;
    wireRawLink();
    // Step 2 summary runs on the active dataset.
    const sres = $("#res-summary");
    sres.hidden = false;
    sres.innerHTML = `
      <div class="kpi-row">
        <div class="kpi"><div class="kpi-label">Total spent</div><div class="kpi-val green">$${s.grandTotalUSD.toFixed(2)}</div></div>
        <div class="kpi"><div class="kpi-label">In-city rides</div><div class="kpi-val">${s.inCityRideCount}</div></div>
        <div class="kpi"><div class="kpi-label">Airport</div><div class="kpi-val">${s.airportRideCount}</div></div>
      </div>`;
    // Render WorkIQ's synthesized debrief in the chat.
    chatTyping(false);
    appendChat("assistant", data.chatAnswer || "I found your receipts — see the map and summary on the left.");
    setChatEnabled(true);
    $("#chat-text").focus();
    setStep(1, "done"); setStep(2, "done"); setStep(3, "active");
    $("#btn-reco").disabled = !data.readyForRecommendation;
    btn.textContent = "↺ Re-run scan";
  } catch (e) {
    if (myGen !== scanGen) return;
    liveData = null;
    chatTyping(false);
    appendChat("assistant", "Sorry — I couldn't complete the mailbox scan. Try **Ask WorkIQ** again in a moment.");
    showError("res-scan", "WorkIQ scan failed.", e);
  } finally {
    if (myGen === scanGen) busy(btn, false);
  }
});
$("#btn-reco").addEventListener("click", async () => {
  const btn = $("#btn-reco");
  busy(btn, true);
  try {
    const data = await api("/api/recommendation");
    state.recommendation = data.recommendation;
    drawRides(state.rides); // redraw so excluded airport styling is fresh
    drawCentroid(data.recommendation);
    const r = data.recommendation;
    const res = $("#res-reco");
    res.hidden = false;
    res.innerHTML = `
      <div class="hotel-card" style="border-color:#2ecc71">
        <div class="kpi-label">Recommended stay area</div>
        <h4 style="color:#2ecc71">${r.neighborhood}</h4>
        <div class="meta">Geographic center of ${r.pointCount} in-city ride endpoints.<br>
        Excluded ${r.excludedRideIds.length} airport transfer(s): ${r.excludedRideIds.join(", ") || "none"}.</div>
      </div>`;
    setStep(3, "done"); setStep(4, "active");
    $("#btn-hotels").disabled = false;
  } catch (e) {
    showError("res-reco", "Recommendation failed.", e);
  } finally {
    busy(btn, false);
  }
});

function renderHotels(data) {
  state.hotels = data.hotels;
  drawHotels(data.hotels);
  const top = data.recommendedHotel;
  const res = $("#res-hotels");
  res.hidden = false;
  res.innerHTML = `
    <div class="hotel-card">
      <div class="kpi-label" style="color:#b76bff">⭐ Best 5-star hotel near your trip's center</div>
      <h4>${top.name}</h4>
      <div class="meta">${top.address}<br>${top.distanceMiles} mi from your trip's center${top.nightlyRateUSD ? ` · from $${top.nightlyRateUSD}/night` : ""}</div>
      <a class="linklike" href="${top.url}" target="_blank">Open hotel website →</a>
    </div>
    <ul class="hotel-list">
      ${data.hotels.slice(1).map((h) => `<li><span>${h.name}</span><span>${h.distanceMiles} mi</span></li>`).join("")}
    </ul>
    <p style="margin:8px 0 0;color:#9aa3b2;font-size:11.5px">Query: “${escapeHtml(data.query)}”</p>
    ${provenanceHtml(data.mode, data.status, data.detail)}`;
  setStep(4, "done"); setStep(5, "active");
  $("#btn-report").disabled = false;
}

$("#btn-hotels").addEventListener("click", async () => {
  const btn = $("#btn-hotels");
  busy(btn, true);
  try {
    const data = await api("/api/find-hotels", { method: "POST", body: { mode: modeOverride("webiq") } });
    renderHotels(data);
  } catch (e) {
    showError("res-hotels", "WebIQ hotel search failed.", e);
  } finally {
    busy(btn, false);
  }
});

$("#btn-report").addEventListener("click", async () => {
  const btn = $("#btn-report");
  const mode = modeOverride("mail");
  if (mode === "smtp" && !confirm("MAIL_MODE=smtp will actually SEND a real email. Continue?")) return;
  busy(btn, true);
  try {
    const data = await api("/api/send-report", { method: "POST", body: { mode, to: $("#inp-to").value || undefined } });
    state.lastReport = data;
    const res = $("#res-report");
    res.hidden = false;
    const isDraft = data.mode === "DRAFT";
    const heading = isDraft ? "Draft saved to your mailbox" : "Report emailed";
    const outlookLink = isDraft && data.webLink
      ? `<p style="margin:8px 0 0"><a class="linklike" href="${escapeHtml(data.webLink)}" target="_blank" rel="noopener">Open the draft in Outlook →</a></p>`
      : "";
    res.innerHTML = `
      <div class="banner-live">
        <b>${heading}</b><br>
        To: ${escapeHtml(data.to)}<br>Subject: ${escapeHtml(data.subject)}
      </div>
      ${provenanceHtml(data.mode, data.status, data.detail)}
      ${outlookLink}
      <p style="margin:8px 0 0"><span class="linklike" id="show-email">Open email preview →</span></p>`;
    $("#show-email").onclick = () => openModal("Email preview", `<iframe srcdoc="${data.html.replace(/"/g, "&quot;")}"></iframe>`);
    setStep(5, "done");
  } catch (e) {
    showError("res-report", "Sending the report failed.", e);
  } finally {
    busy(btn, false);
  }
});

$("#btn-reset").addEventListener("click", async () => {
  await api("/api/reset", { method: "POST" });
  scanGen++; // invalidate any in-flight scan render
  ["rides", "centroid", "hotels"].forEach(clearLayer);
  state.rides = []; state.recommendation = null; state.hotels = [];
  liveData = null;
  ["res-scan", "res-summary", "res-reco", "res-hotels", "res-report"].forEach((id) => { const e = document.getElementById(id); e.hidden = true; e.innerHTML = ""; });
  $("#btn-scan").textContent = "🔵 Ask WorkIQ";
  $("#btn-reco").disabled = true; $("#btn-hotels").disabled = true; $("#btn-report").disabled = true;
  [1, 2, 3, 4, 5].forEach((n) => setStep(n, ""));
  setStep(1, "active");
  clearChat();
  setChatEnabled(false);
  setRailTab("chat");
  map.setView([37.79, -122.41], 13);
});

/* ---------------- Modal ---------------- */
function openModal(title, html) {
  $("#modal-title").innerHTML = title;
  $("#modal-body").innerHTML = html;
  $("#modal").hidden = false;
}
$("#modal-close").addEventListener("click", () => ($("#modal").hidden = true));
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").hidden = true; });
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---------------- Ask chat panel ---------------- */
// Tiny, dependency-free markdown -> HTML for the synthesized answers. Input is
// HTML-escaped first, then a whitelist of simple inline/block markup is applied,
// so it's safe even though our answers are server-generated.
function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>");
}
function mdToHtml(md) {
  const lines = escapeHtml(md).split("\n");
  let html = "";
  let para = [];
  let inList = false;
  const flushPara = () => { if (para.length) { html += `<p>${inlineMd(para.join("<br>"))}</p>`; para = []; } };
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*-\s+/.test(line)) {
      flushPara();
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inlineMd(line.replace(/^\s*-\s+/, ""))}</li>`;
    } else if (line.trim() === "") {
      flushPara(); closeList();
    } else {
      closeList();
      para.push(line);
    }
  }
  flushPara(); closeList();
  return html;
}

function appendChat(role, md) {
  const box = $("#chat");
  const empty = box.querySelector(".chat-empty");
  if (empty) empty.remove();
  const div = document.createElement("div");
  div.className = `chat-msg ${role}`;
  div.innerHTML = `<div class="chat-bubble"><div class="chat-md">${mdToHtml(md)}</div></div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
function chatTyping(on) {
  const box = $("#chat");
  let t = box.querySelector(".chat-typing");
  if (on) {
    if (!t) {
      const empty = box.querySelector(".chat-empty");
      if (empty) empty.remove();
      t = document.createElement("div");
      t.className = "chat-msg assistant chat-typing";
      t.innerHTML = `<div class="chat-bubble"><div class="typing"><span></span><span></span><span></span></div></div>`;
      box.appendChild(t);
      box.scrollTop = box.scrollHeight;
    }
  } else if (t) {
    t.remove();
  }
}
function clearChat() {
  $("#chat").innerHTML = '<div class="chat-empty">Press <b>Ask WorkIQ</b> in step 1 to start the conversation.</div>';
}
function setChatEnabled(on) {
  $("#chat-text").disabled = !on;
  $("#chat-send").disabled = !on;
}

// Free-form follow-ups are answered server-side from the already-extracted trip
// data (no extra WorkIQ call).
$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-text");
  const q = input.value.trim();
  if (!q) return;
  input.value = "";
  setChatEnabled(false);
  appendChat("user", q);
  chatTyping(true);
  try {
    const data = await api("/api/ask", { method: "POST", body: { question: q } });
    chatTyping(false);
    if (data.action === "hotels-found" && data.recommendedHotel) {
      renderHotels(data);
    }
    appendChat("assistant", data.answer || "…");
  } catch {
    chatTyping(false);
    appendChat("assistant", "Sorry — I couldn't answer that just now.");
  } finally {
    setChatEnabled(true);
    input.focus();
  }
});

/* ---------------- Right rail: tabs, visibility + call-log polling ---------------- */
let railVisible = localStorage.getItem("workiq.railVisible") !== "false";
let lastLogSig = "";

function logTabActive() {
  return !$("#pane-log").hidden;
}

// Switch between the Chat (audience) and Call Log (presenter) tabs. Provenance
// hints are gated on the Log tab so they stay invisible to the audience.
function setRailTab(tab) {
  const isLog = tab === "log";
  $("#pane-chat").hidden = isLog;
  $("#pane-log").hidden = !isLog;
  $("#tab-chat").classList.toggle("active", !isLog);
  $("#tab-log").classList.toggle("active", isLog);
  $("#tab-chat").setAttribute("aria-selected", String(!isLog));
  $("#tab-log").setAttribute("aria-selected", String(isLog));
  $("#steps").closest(".layout").classList.toggle("log-active", isLog && railVisible);
  if (isLog && railVisible) { lastLogSig = ""; refreshCallLog(); }
}
$("#tab-chat").addEventListener("click", () => setRailTab("chat"));
$("#tab-log").addEventListener("click", () => setRailTab("log"));

function setRailVisible(visible) {
  railVisible = visible;
  localStorage.setItem("workiq.railVisible", String(visible));
  const layout = $("#steps").closest(".layout");
  layout.classList.toggle("rail-hidden", !visible);
  // Audience-safe: provenance only when the rail is open AND on the Log tab.
  layout.classList.toggle("log-active", visible && logTabActive());
  const btn = $("#btn-toggle-log");
  btn.setAttribute("aria-pressed", String(visible));
  btn.textContent = visible ? "🗔 Hide panel" : "🗔 Show panel";
  if (visible && logTabActive()) { lastLogSig = ""; refreshCallLog(); }
  if (map) setTimeout(() => map.invalidateSize(), 50);
}

$("#btn-toggle-log").addEventListener("click", () => setRailVisible(!railVisible));
$("#btn-collapse-log").addEventListener("click", () => setRailVisible(false));
async function refreshConfig() {
  try {
    const c = await api("/api/config");
    const chip = (id, label, mode, liveConfigured) => {
      const el = $(id);
      el.innerHTML = `${label}: <b>${mode}</b>`;
      el.classList.toggle("live", mode === "live");
      el.classList.toggle("captured", mode === "captured");
      el.title = liveConfigured === false ? "Live path not configured (will use captured)" : "";
    };
    chip("#chip-workiq", "WorkIQ", c.workiqMode, c.workiqLiveConfigured);
    chip("#chip-webiq", "WebIQ", c.webiqMode, c.webiqLiveConfigured);
    $("#chip-mail").innerHTML = `Mail: <b>${c.mailMode}</b>`;
  } catch { /* ignore */ }
}

function timeAgo(iso) {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  return `${Math.round(s / 60)}m ago`;
}

async function refreshCallLog() {
  // Only poll when the Call Log is actually on screen — keeps the Chat tab calm
  // and avoids needless DOM churn.
  if (!railVisible || !logTabActive()) return;
  let data;
  try { data = await api("/api/call-log"); } catch { return; }
  const box = $("#calllog");
  // Only touch the DOM when something actually changed — avoids the 1.5s flicker
  // and preserves any <details> the presenter has expanded.
  const sig = JSON.stringify(
    data.calls.map((c) => [c.at, c.status, c.mode, c.responseSummary, c.detail])
  );
  if (sig === lastLogSig) return;
  lastLogSig = sig;
  if (!data.calls.length) {
    box.innerHTML = '<div class="calllog-empty">No calls yet. Start with step 1.</div>';
    return;
  }
  box.innerHTML = data.calls
    .map((c) => {
      const modeBadge = c.status === "fallback" ? "fallback" : c.status === "error" ? "error" : c.mode;
      const dur = c.durationMs != null ? `${c.durationMs} ms` : "";
      return `
      <div class="call ${c.type}">
        <div class="call-top">
          <span class="call-type">${c.title}</span>
          <span class="badge ${modeBadge}">${c.status === "fallback" ? "LIVE→CAPTURED" : c.status === "error" ? "ERROR" : c.mode}</span>
          <span class="call-time">${timeAgo(c.at)}</span>
        </div>
        <div class="call-site">${escapeHtml(c.callSite)}</div>
        <div class="call-summary">${escapeHtml(c.responseSummary)}</div>
        ${c.detail ? `<div class="call-detail">${escapeHtml(c.detail)}</div>` : ""}
        <div class="call-meta">${dur}</div>
        ${c.request ? `<details class="call-req"><summary>request</summary><pre>${escapeHtml(c.request)}</pre></details>` : ""}
      </div>`;
    })
    .join("");
}

setStep(1, "active");
refreshConfig();
setRailTab("chat");
setRailVisible(railVisible);
refreshCallLog();
setInterval(refreshCallLog, 1500);
setTimeout(() => map.invalidateSize(), 200);
