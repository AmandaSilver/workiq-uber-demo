// scripts/seed-inbox.mjs
// =============================================================================
//  Seed the demo mailbox with realistic Uber ride-receipt emails so the LIVE
//  WorkIQ "Ask" path finds a full, rich trip in a REAL inbox — no "captured"
//  sample needed on screen. The receipts mirror the 9-ride San Francisco sample
//  (single source of truth: server/data/captured/uber-receipts.json).
//
//  Every seeded message carries a discreet marker (SEED_MARKER) in a tiny footer
//  so the whole demo set can be found and deleted in one search. Subjects/bodies
//  otherwise look like genuine Uber receipts.
//
//  USAGE
//    # Preview only — writes rendered .html files, sends nothing:
//    node scripts/seed-inbox.mjs --out
//
//    # Actually send to a mailbox via Microsoft Graph (sends as the signed-in user):
//    #   get a token:  az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
//    GRAPH_TOKEN=<token> SEED_TO=you@example.com node scripts/seed-inbox.mjs --send
//
//  CLEANUP
//    In Outlook search:  "WTP-DEMO-SEED"   (then select all -> delete)
// =============================================================================
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "..", "server", "data", "captured", "uber-receipts.json");
const OUT_DIR = path.resolve(__dirname, "seed-output");

export const SEED_MARKER = "WTP-DEMO-SEED";

const money = (n) => `$${Number(n).toFixed(2)}`;

// Render the real street-following route as an inline SVG "map" for the receipt.
// Inline SVG renders in Outlook on the web / new Outlook and in any browser
// preview. Returns "" when a ride has no baked route (e.g. airport transfers).
export function renderRouteSvg(route, w = 432, h = 200) {
  if (!Array.isArray(route) || route.length < 2) return "";
  const pad = 16;
  const lats = route.map((p) => p[0]);
  const lngs = route.map((p) => p[1]);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  // Equirectangular projection corrected for latitude so the shape isn't squashed.
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6);
  const spanY = Math.max(maxLat - minLat, 1e-6);
  const scale = Math.min((w - 2 * pad) / spanX, (h - 2 * pad) / spanY);
  const offX = (w - spanX * scale) / 2;
  const offY = (h - spanY * scale) / 2;
  const project = ([lat, lng]) => {
    const x = offX + (lng - minLng) * kx * scale;
    const y = h - (offY + (lat - minLat) * scale); // invert Y (north = up)
    return [x, y];
  };
  const pts = route.map(project);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [sx, sy] = pts[0];
  const [ex, ey] = pts[pts.length - 1];
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="display:block;border-radius:10px">
    <rect width="${w}" height="${h}" rx="10" fill="#eef0f2"/>
    <path d="${d}" fill="none" stroke="#276EF1" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="6" fill="#06A77D" stroke="#fff" stroke-width="2"/>
    <rect x="${(ex - 5).toFixed(1)}" y="${(ey - 5).toFixed(1)}" width="10" height="10" fill="#000" stroke="#fff" stroke-width="2"/>
  </svg>`;
}

// Render a single Uber-style receipt email body (inline-styled HTML).
export function renderReceipt(ride) {
  const d = new Date(`${ride.date}T${ride.time || "12:00"}:00`);
  const niceDate = d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const fare = ride.fare ?? (ride.total != null ? ride.total - (ride.tip || 0) : null);
  const svg = renderRouteSvg(ride.route);
  const trip =
    ride.distanceMi != null
      ? `${ride.distanceMi.toFixed(1)} miles${ride.durationMin != null ? ` · ${ride.durationMin} min` : ""}`
      : "";
  return `<!doctype html><html><body style="margin:0;background:#f6f6f6;font-family:Helvetica,Arial,sans-serif;color:#000">
  <div style="max-width:480px;margin:0 auto;background:#fff">
    <div style="background:#000;color:#fff;padding:22px 24px;font-size:22px;font-weight:700;letter-spacing:.5px">Uber</div>
    ${svg ? `<div style="padding:24px 24px 0">${svg}${trip ? `<div style="font-size:13px;color:#888;margin-top:8px">${trip}</div>` : ""}</div>` : ""}
    <div style="padding:24px">
      <div style="font-size:15px;color:#545454">Thanks for riding, Amanda</div>
      <div style="font-size:30px;font-weight:700;margin:6px 0 2px">${money(ride.total)}</div>
      <div style="font-size:13px;color:#888">${niceDate} · ${ride.time || ""}</div>
      <table style="width:100%;border-collapse:collapse;margin-top:20px;font-size:14px">
        <tr><td style="padding:8px 0;color:#888;width:64px">From</td><td style="padding:8px 0">${ride.pickup.name || ride.pickup.address}<br><span style="color:#888;font-size:12px">${ride.pickup.address}</span></td></tr>
        <tr><td style="padding:8px 0;color:#888">To</td><td style="padding:8px 0">${ride.dropoff.name || ride.dropoff.address}<br><span style="color:#888;font-size:12px">${ride.dropoff.address}</span></td></tr>
      </table>
      <table style="width:100%;border-collapse:collapse;margin-top:20px;font-size:14px;border-top:1px solid #eee">
        ${fare != null ? `<tr><td style="padding:8px 0;color:#545454">Trip fare</td><td style="padding:8px 0;text-align:right">${money(fare)}</td></tr>` : ""}
        ${ride.tip ? `<tr><td style="padding:8px 0;color:#545454">Tip</td><td style="padding:8px 0;text-align:right">${money(ride.tip)}</td></tr>` : ""}
        <tr><td style="padding:10px 0;font-weight:700;border-top:1px solid #eee">Total</td><td style="padding:10px 0;text-align:right;font-weight:700;border-top:1px solid #eee">${money(ride.total)}</td></tr>
      </table>
      <div style="margin-top:24px;font-size:12px;color:#aaa">Receipt for your Uber ride. Charged to Personal · Visa ····4242.</div>
      <div style="margin-top:14px;font-size:10px;color:#e6e6e6">Ref ${SEED_MARKER}-${ride.id.toUpperCase()}</div>
    </div>
  </div></body></html>`;
}

export async function buildReceipts() {
  const data = JSON.parse(await fs.readFile(DATA, "utf8"));
  return data.rides.map((ride) => ({
    id: ride.id,
    subject: ride.sourceEmail?.subject || `Your ${ride.date} trip with Uber`,
    html: renderReceipt(ride),
  }));
}

async function sendViaGraph(to, msg) {
  const token = process.env.GRAPH_TOKEN;
  if (!token) throw new Error("GRAPH_TOKEN is not set. See the usage header in this file.");
  const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      message: {
        subject: msg.subject,
        body: { contentType: "HTML", content: msg.html },
        toRecipients: [{ emailAddress: { address: to } }],
      },
      saveToSentItems: true,
    }),
  });
  if (!res.ok) throw new Error(`Graph sendMail failed (${res.status}): ${await res.text()}`);
}

// --- CLI ---------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("seed-inbox.mjs")) {
  const mode = process.argv.includes("--send") ? "send" : "out";
  const receipts = await buildReceipts();
  if (mode === "send") {
    const to = process.env.SEED_TO;
    if (!to) throw new Error("SEED_TO is not set (the mailbox to seed).");
    for (const r of receipts) {
      await sendViaGraph(to, r);
      console.log(`sent: ${r.subject}`);
    }
    console.log(`\nSeeded ${receipts.length} Uber receipts to ${to}. Remove later by searching "${SEED_MARKER}".`);
  } else {
    await fs.mkdir(OUT_DIR, { recursive: true });
    for (const r of receipts) {
      const file = path.join(OUT_DIR, `${r.id}.html`);
      await fs.writeFile(file, r.html, "utf8");
      console.log(`wrote: ${path.relative(process.cwd(), file)}  (${r.subject})`);
    }
    console.log(`\nPreviewed ${receipts.length} receipts. To actually send, see the usage header.`);
  }
}
