// server/services/mailer.js
// =============================================================================
//
//      🟢🟢🟢   W O R K I Q   " T O O L S "   B O U N D A R Y   🟢🟢🟢
//
//   WorkIQ isn't only "Ask" — it can take ACTIONS via tools. Here the action is
//   "send the analysis as an email report". The call site is `sendReport()`.
//
//   Default MAIL_MODE=preview renders the email and writes it to disk WITHOUT
//   sending (so a demo never accidentally emails a real person). MAIL_MODE=smtp
//   really sends via nodemailer. MAIL_MODE=draft saves it to the user's Outlook
//   Drafts via the interactive Graph worker (scripts/draft-worker.ps1) — useful
//   when admin policy blocks programmatic sending. Either way it's logged as a
//   WorkIQ Tool call, and any failure degrades gracefully to preview.
//
// =============================================================================
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { config, OUTBOX_DIR, DRAFT_QUEUE_DIR } from "../config.js";
import { logCall } from "./callLog.js";

const CALL_SITE = "services/mailer.js \u2192 sendReport()";

const money = (n) => (n == null ? "\u2014" : `$${Number(n).toFixed(2)}`);

// --- Draft worker hand-off ---------------------------------------------------
// Admin policy blocks programmatic *sending*, but saving a DRAFT is allowed.
// The interactive Graph session lives in scripts/draft-worker.ps1; the server
// just drops a request on a filesystem queue and waits for the worker to create
// the draft and write back. Keeps Graph credentials out of the server entirely.
async function isDraftWorkerAlive() {
  try {
    const st = await fs.stat(path.join(DRAFT_QUEUE_DIR, ".worker.alive"));
    return Date.now() - st.mtimeMs < 6000;
  } catch {
    return false;
  }
}

async function saveDraftViaWorker({ to, subject, html }) {
  if (!(await isDraftWorkerAlive())) {
    return { ok: false, reason: "Draft worker isn't running \u2014 start it in a terminal with `npm run draft-worker`, then try again." };
  }
  await fs.mkdir(DRAFT_QUEUE_DIR, { recursive: true });
  const id = `${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const htmlFile = path.join(DRAFT_QUEUE_DIR, `${id}.html`);
  const reqFile = path.join(DRAFT_QUEUE_DIR, `${id}.req.json`);
  const resFile = path.join(DRAFT_QUEUE_DIR, `${id}.res.json`);
  await fs.writeFile(htmlFile, html, "utf8");
  await fs.writeFile(reqFile, JSON.stringify({ id, to, subject, htmlFile }), "utf8");

  const deadline = Date.now() + 20000;
  let res = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      res = JSON.parse(await fs.readFile(resFile, "utf8"));
      break;
    } catch {
      /* result not ready yet */
    }
  }
  await fs.rm(resFile, { force: true }).catch(() => {});
  await fs.rm(htmlFile, { force: true }).catch(() => {});
  if (!res) {
    await fs.rm(reqFile, { force: true }).catch(() => {});
    return { ok: false, reason: "The draft worker didn't respond in time." };
  }
  if (!res.ok) return { ok: false, reason: res.error || "Graph rejected the draft." };
  return { ok: true, draftId: res.draftId, webLink: res.webLink };
}

export function buildReportHtml(payload) {
  const { tripLabel, summary, rides = [], recommendation, hotel } = payload;
  const rideRows = rides
    .map(
      (r) => `
      <tr>
        <td>${r.date || ""} ${r.time || ""}</td>
        <td>${r.pickup?.name || r.pickup?.address || ""}</td>
        <td>${r.dropoff?.name || r.dropoff?.address || ""}</td>
        <td style="text-align:right">${money(r.total)}</td>
        <td style="text-align:center">${r.isAirport ? "\u2708\ufe0f airport" : ""}</td>
      </tr>`
    )
    .join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trip Analysis Report</title></head>
<body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1b1b1f">
  <div style="max-width:680px;margin:0 auto;padding:24px">
    <div style="background:#0f6cbd;color:#fff;border-radius:12px 12px 0 0;padding:20px 24px">
      <div style="font-size:13px;opacity:.85;letter-spacing:.05em">WORKIQ TRIP ANALYSIS</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${tripLabel || "Trip report"}</div>
    </div>
    <div style="background:#fff;padding:24px;border:1px solid #e3e3e6;border-top:0;border-radius:0 0 12px 12px">
      <p style="margin:0 0 16px">Generated from your email by WorkIQ. Here's the analysis of your recent
      Uber rides and a recommendation for where to stay next time.</p>

      <div style="display:flex;gap:12px;flex-wrap:wrap;margin:0 0 20px">
        <div style="flex:1;min-width:150px;background:#f0f6fc;border:1px solid #d7e7f5;border-radius:10px;padding:14px">
          <div style="font-size:12px;color:#5a6b7b">Total spent on rides</div>
          <div style="font-size:24px;font-weight:700;color:#0f6cbd">${money(summary?.grandTotalUSD)}</div>
          <div style="font-size:12px;color:#5a6b7b">${summary?.rideCount ?? 0} rides (${summary?.airportRideCount ?? 0} airport)</div>
        </div>
        <div style="flex:1;min-width:150px;background:#f3fbf4;border:1px solid #cfe9d4;border-radius:10px;padding:14px">
          <div style="font-size:12px;color:#5a6b7b">Recommended stay area</div>
          <div style="font-size:18px;font-weight:700;color:#107c41">${recommendation?.neighborhood || "\u2014"}</div>
          <div style="font-size:12px;color:#5a6b7b">densest in-city ride cluster</div>
        </div>
      </div>

      ${
        hotel
          ? `<div style="background:#fff;border:2px solid #0f6cbd;border-radius:10px;padding:16px;margin:0 0 20px">
        <div style="font-size:12px;color:#0f6cbd;font-weight:700;letter-spacing:.05em">\u2b50 RECOMMENDED 5-STAR HOTEL (via WebIQ)</div>
        <div style="font-size:18px;font-weight:700;margin-top:4px">${hotel.name}</div>
        <div style="color:#5a6b7b;font-size:14px">${hotel.address}</div>
        <div style="margin-top:6px;font-size:14px">${hotel.distanceMiles != null ? `${hotel.distanceMiles} mi from your recommended base` : ""}${
              hotel.nightlyRateUSD ? ` &middot; from $${hotel.nightlyRateUSD}/night` : ""
            }</div>
        ${hotel.url ? `<a href="${hotel.url}" style="color:#0f6cbd;font-size:13px">${hotel.url}</a>` : ""}
      </div>`
          : ""
      }

      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="background:#f4f5f7;text-align:left">
            <th style="padding:8px">When</th><th style="padding:8px">From</th>
            <th style="padding:8px">To</th><th style="padding:8px;text-align:right">Total</th><th></th>
          </tr>
        </thead>
        <tbody>${rideRows}</tbody>
      </table>

      <p style="margin:20px 0 0;font-size:12px;color:#8a94a0">
        Sent by the WorkIQ Trip Planner demo. WorkIQ <b>Ask</b> read the receipts, the app mapped and
        totaled them, <b>WebIQ</b> found the hotel, and this email was sent via a WorkIQ <b>Tool</b>.
      </p>
    </div>
  </div>
</body></html>`;
}

/**
 * Send, draft, or preview the trip report email.
 * @param {object} payload  Report data (tripLabel, summary, rides, recommendation, hotel).
 * @param {object} [opts]   { mode: "preview"|"smtp"|"draft", to }
 */
export async function sendReport(payload, opts = {}) {
  const mode = (opts.mode || config.mail.mode || "preview").toLowerCase();
  const to = opts.to || config.mail.to || "(no recipient set)";
  const subject = `Trip analysis: ${payload.tripLabel || "your recent rides"}`;
  const html = buildReportHtml(payload);
  const started = Date.now();
  // When a real send/draft is requested but the backing service isn't reachable
  // (the common case for a laptop demo), we don't blow up the demo with a 502 —
  // we quietly render the preview instead and record the reason for the presenter.
  let fallbackDetail = null;

  // draft: hand off to the interactive Graph worker, which saves it to Drafts.
  if (mode === "draft") {
    const out = await saveDraftViaWorker({ to, subject, html });
    if (out.ok) {
      logCall({
        type: "TOOL",
        title: "WorkIQ Tool: Save Draft",
        mode: "DRAFT",
        callSite: CALL_SITE,
        request: `POST /me/messages \u2014 to=${to} subject="${subject}"`,
        responseSummary: `Draft saved to your mailbox (id ${out.draftId})`,
        durationMs: Date.now() - started,
        status: "ok",
      });
      return {
        mode: "DRAFT",
        status: "ok",
        detail: "Saved to your Drafts via Microsoft Graph (Mail.ReadWrite) \u2014 nothing was sent.",
        to,
        subject,
        html,
        webLink: out.webLink,
        draftId: out.draftId,
      };
    }
    logCall({
      type: "TOOL",
      title: "WorkIQ Tool: Save Draft",
      mode: "DRAFT",
      callSite: CALL_SITE,
      request: `POST /me/messages \u2014 to=${to} subject="${subject}"`,
      responseSummary: "Draft save unavailable \u2192 preview fallback",
      durationMs: Date.now() - started,
      status: "fallback",
      detail: out.reason,
    });
    fallbackDetail = `${out.reason} Rendered a preview instead.`;
  }

  if (mode === "smtp") {
    try {
      const nodemailer = (await import("nodemailer")).default;
      const transporter = nodemailer.createTransport({
        host: config.mail.smtpHost,
        port: config.mail.smtpPort,
        secure: config.mail.smtpPort === 465,
        auth: config.mail.smtpUser ? { user: config.mail.smtpUser, pass: config.mail.smtpPass } : undefined,
      });
      const info = await transporter.sendMail({ from: config.mail.from, to, subject, html });
      logCall({
        type: "TOOL",
        title: "WorkIQ Tool: Send Mail",
        mode: "LIVE",
        callSite: CALL_SITE,
        request: `to=${to} subject="${subject}"`,
        responseSummary: `Email sent (messageId ${info.messageId})`,
        durationMs: Date.now() - started,
        status: "ok",
      });
      return { mode: "LIVE", status: "ok", to, subject, html, messageId: info.messageId };
    } catch (err) {
      logCall({
        type: "TOOL",
        title: "WorkIQ Tool: Send Mail",
        mode: "LIVE",
        callSite: CALL_SITE,
        request: `to=${to} subject="${subject}"`,
        responseSummary: "SMTP send failed \u2192 preview fallback",
        durationMs: Date.now() - started,
        status: "fallback",
        detail: err.message,
      });
      // Degrade to preview so the demo keeps flowing instead of throwing a 502.
      fallbackDetail = `SMTP unavailable (${err.message}) \u2014 rendered a preview instead of sending.`;
    }
  }

  // preview: write the email to the outbox and return it for the UI. Also the
  // graceful landing spot when a send/draft was requested but couldn't complete.
  await fs.mkdir(OUTBOX_DIR, { recursive: true });
  const file = path.join(OUTBOX_DIR, `report-${Date.now()}.html`);
  await fs.writeFile(file, html, "utf8");
  logCall({
    type: "TOOL",
    title: "WorkIQ Tool: Send Mail",
    mode: "PREVIEW",
    callSite: CALL_SITE,
    request: `to=${to} subject="${subject}"`,
    responseSummary: `Email rendered to preview (not sent) \u2192 ${path.basename(file)}`,
    durationMs: Date.now() - started,
    status: fallbackDetail ? "fallback" : "ok",
    detail: fallbackDetail || "MAIL_MODE=preview \u2014 no email actually sent.",
  });
  return {
    mode: "PREVIEW",
    status: fallbackDetail ? "fallback" : "ok",
    detail: fallbackDetail || "",
    to,
    subject,
    html,
    previewFile: file,
  };
}
