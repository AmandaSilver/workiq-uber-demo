# WorkIQ Trip Planner — a hero demo for WorkIQ

A small, local web app that shows off **WorkIQ** end-to-end:

1. **WorkIQ "Ask"** scans your email for Uber ride receipts — first **live against your real
   inbox** (proof), then it continues on a richer representative sample for a compelling map.
2. The app **maps** the rides and **totals** what the trip cost.
3. It **recommends where to stay** next year — the geographic center of this year's
   in-city rides (airport transfers excluded).
4. **WebIQ** (web search) finds the **best 5-star hotel closest** to that area.
5. A **WorkIQ "Tool"** emails a summary report of the whole analysis.

It runs locally in a git repo opened in VS Code, with a live **Call Log** panel so you can
*point at the screen and show exactly when a WorkIQ API is invoked*.

![flow](https://img.shields.io/badge/WorkIQ-Ask%20%C2%B7%20WebIQ%20%C2%B7%20Tools-0f6cbd)

---

## 👀 Where the WorkIQ APIs are invoked (read this first)

Every external boundary lives in one tiny, clearly-labeled module, and **every call is recorded
in the on-screen Call Log** (file + function + mode + request + response):

| What | File | Function (the call site) | Badge in UI |
|------|------|--------------------------|-------------|
| 🔵 WorkIQ **Ask** | [`server/services/workiq.js`](server/services/workiq.js) | `askWorkIQ()` → `callLiveWorkIQ()` | `WorkIQ ▸ Ask` |
| 🟣 **WebIQ** search | [`server/services/webiq.js`](server/services/webiq.js) | `searchHotels()` → `callLiveWebSearch()` | `WebIQ ▸ Search` |
| 🟢 WorkIQ **Tool** (email) | [`server/services/mailer.js`](server/services/mailer.js) | `sendReport()` | `WorkIQ ▸ Tool` |

Each call also logs to the terminal with a distinct prefix, e.g.
`[WorkIQ ▸ Ask] LIVE — services/workiq.js → askWorkIQ() :: 9 ride receipts ...`

---

## 🚀 Quick start

```bash
cd workiq-trip-planner
npm install
npm start
# open http://localhost:4317
```

Out of the box it runs in **CAPTURED** mode — no secrets, no network logins — replaying a
known-good sample so the demo never fails. Then click through steps 1 → 5.

## ⚙️ Hybrid: live WorkIQ + captured fallback

Copy `.env.example` to `.env` to choose how each boundary behaves. Three modes everywhere:

- `captured` — replay the bundled known-good data (default, safest).
- `live` — really call the external API; **fails loudly** if it can't.
- `auto` — try live, and if it fails, **fall back to captured** (the fallback is shown loudly
  in the Call Log as `LIVE→CAPTURED`, never silently faked).

```ini
# WorkIQ "Ask" — live path speaks MCP (stdio) to your WorkIQ MCP server.
# These exact values work with the WorkIQ CLI plugin installed in the Copilot harness:
WORKIQ_MODE=auto
WORKIQ_MCP_COMMAND=npx
WORKIQ_MCP_ARGS=-y @microsoft/workiq@latest mcp
WORKIQ_MCP_TOOL=ask_work_iq
WORKIQ_MCP_QUESTION_ARG=question
WORKIQ_TIMEOUT_MS=120000          # npx cold-start + a real mailbox query can take ~40s

# WebIQ — live path uses Bing or SerpApi if a key is present
WEBIQ_MODE=auto
BING_SEARCH_KEY=...

# WorkIQ Tool — email. preview (default) renders without sending; smtp really sends
MAIL_MODE=preview
MAIL_TO=you@example.com
SMTP_HOST=smtp.example.com
SMTP_USER=...
SMTP_PASS=...
```

> **Auth:** the live WorkIQ path reuses the Microsoft 365 sign-in already cached by the Copilot
> harness (EULA accepted once), so the app-spawned MCP process connects with **no extra login prompt**.

> **Response envelope:** `ask_work_iq` returns `{ "response": "<answer>", "conversationId": "..." }`
> where `response` is itself a string (often a JSON array of receipts). `workiq.js` unwraps this via
> `unwrapWorkIQAnswer()` before parsing — otherwise only partial data survives.

You can also flip modes per-run from the **⚙ Presenter** menu in the top-right (great for
showing "captured" then re-running the same step "live").

---

## 🎬 Suggested demo script (~3 min)

> **Step 1 is a "two-act" moment** — first prove WorkIQ reads your *real* inbox (live), then switch
> to a richer representative sample so the map and recommendation tell a compelling story.

1. **Frame it.** "WorkIQ answers questions over my real work data. Watch the Call Log on the right."
2. **Step 1 · Act 1 — Ask WorkIQ (live).** Click *Ask WorkIQ (live)*. After ~40s a `WorkIQ ▸ Ask`
   card logs `LIVE` and the **Live mailbox proof** card shows the real receipts WorkIQ found in *your*
   inbox (e.g. a couple of SF rides). Click *View WorkIQ response & prompt* to show the raw answer.
   This proves the email read is genuine — it does **not** advance the planning steps.
3. **Step 1 · Act 2 — load the hero sample.** Click *Start hero scenario (captured 9-ride sample)*.
   The live-proof card stays visible; an **Active dataset — captured sample trip** card appears
   (9 rides, **$227.76**) and the planning flow unlocks. Call out the honest dataset switch: the real
   trip was too thin for a meaningful centroid, so the demo continues on a representative sample.
4. **Step 2 — Map & total.** Rides plot on the map; the trip totaled **$227.76**. Note the dashed
   airport transfers heading to SFO.
5. **Step 3 — Recommend.** Click *Recommend stay area*. A 📍 marker drops on **Union Square** — the
   center of the in-city rides. Call out that the 2 airport rides were **excluded** so they don't skew it.
6. **Step 4 — WebIQ.** Click *Search with WebIQ*. A `WebIQ ▸ Search` card appears; the closest 5-star
   hotel (**Palace Hotel**, ~0.08 mi) is starred on the map, with the runners-up listed.
7. **Step 5 — WorkIQ Tool.** Click *Send with WorkIQ Tool*. A `WorkIQ ▸ Tool` card shows the email was
   rendered (preview-safe). Click *Open email preview* to show the polished report.
8. **Punchline.** Point at the Call Log: *Ask* read the email, the app reasoned over it, *WebIQ* searched
   the web, and a *Tool* took action — all in one flow.

> The recommendation only runs on the captured sample — the server returns a `409
> NOT_READY_FOR_RECOMMENDATION` if you try to skip Act 2, so the live-proof and sample data never blur.

---

## 🗺️ Map details: real routes, hidden airport hops

- **Street-following routes.** Rides are drawn along the actual road network (via the free
  [OSRM](https://project-osrm.org/) router), not as straight "as-the-crow-flies" lines. For the
  captured sample these routes are **precomputed and baked into the dataset** (`npm run
  precompute-routes`) so the offline demo is deterministic and instant. Live rides are routed
  best-effort at scan time with a short timeout, and any ride that can't be routed simply falls
  back to a straight line — a routing hiccup never blocks or breaks the demo.
- **Airport transfers are hidden from the map.** Long freeway lines to SFO made the city map look
  bad and aren't part of the "where do I need to be" story, so `drawRides()` skips them (they're
  still counted in the totals and excluded from the recommendation). If *every* ride is an airport
  transfer — e.g. a thin live proof — the map shows them anyway so it's never blank.

## 📨 Seeding spoof receipts for a fully-live demo (optional)

To make Step 1 read a **rich trip from a real inbox** (instead of leaning on the captured sample),
seed the mailbox with realistic Uber receipt emails that mirror the 9-ride sample:

```bash
# Preview the rendered emails (writes scripts/seed-output/*.html, sends nothing):
npm run seed-inbox -- --out

# Actually send them to a mailbox via Microsoft Graph (sends as the signed-in user):
#   az account get-access-token --resource https://graph.microsoft.com --query accessToken -o tsv
GRAPH_TOKEN=<token-with-Mail.Send> SEED_TO=you@example.com npm run seed-inbox -- --send
```

Each message looks like a genuine Uber receipt but carries a discreet `WTP-DEMO-SEED` marker in a
tiny footer. **Cleanup:** search your mailbox for `WTP-DEMO-SEED`, select all, delete. Allow a few
minutes after sending for WorkIQ/M365 to index the new mail before it appears in a live scan.

---

## 🧠 How the recommendation works

`server/services/recommendation.js` (pure logic, no external calls):

- Take every **non-airport** ride's pickup & dropoff coordinates.
- Compute their **centroid** (geographic center) — that's the recommended base.
- Label it with the nearest known neighborhood.
- Rank hotels by **haversine** distance to the centroid; nearest = the pick.
- If *every* ride was an airport transfer, it falls back to using all endpoints.

---

## 🗂️ Architecture

```
workiq-trip-planner/
├─ server/
│  ├─ index.js              # Express API + static hosting
│  ├─ config.js             # env loader + typed config (zero-dep)
│  ├─ services/
│  │  ├─ workiq.js          # 🔵 WorkIQ "Ask"  (live MCP + captured)
│  │  ├─ webiq.js           # 🟣 WebIQ search  (live Bing/SerpApi + captured)
│  │  ├─ mailer.js          # 🟢 WorkIQ "Tool" (preview + smtp)
│  │  ├─ receiptParser.js   # parse a live WorkIQ answer -> structured rides
│  │  ├─ geocode.js         # address -> lat/lng (static cache + Nominatim)
│  │  ├─ routing.js         # pickup->dropoff street route (OSRM, best-effort)
│  │  ├─ recommendation.js  # centroid + nearest-hotel logic
│  │  └─ callLog.js         # the live "where WorkIQ was invoked" feed
│  └─ data/captured/        # known-good sample data (see note below)
└─ public/                  # index.html, app.js, styles.css (Leaflet map)
```

### API

| Method & path | Boundary | Purpose |
|---|---|---|
| `POST /api/scan-receipts` | 🔵 Ask | scan email → structured rides + total |
| `GET  /api/recommendation` | — | centroid + neighborhood |
| `POST /api/find-hotels` | 🟣 WebIQ | 5-star hotels ranked by distance |
| `POST /api/send-report` | 🟢 Tool | email/preview the report |
| `GET  /api/call-log` | — | feed for the Call Log panel |
| `POST /api/reset` | — | clear demo state |

---

## 🔒 Privacy & data note

`server/data/captured/uber-receipts.json` is a **synthetic, demo-safe sample** — a fabricated SF
business trip. No real personal receipts are committed to the repo. When you run the **live** WorkIQ
path, the app uses *your* actual mailbox data at demo time and never writes it to disk. The captured
hotels in `hotels.json` are real, publicly-listed San Francisco 5-star hotels.

## Requirements

- Node.js ≥ 18.17 (uses built-in `fetch`).
- Internet access only for OpenStreetMap map tiles (and live mode, if enabled).
- `@modelcontextprotocol/sdk` is an **optional** dependency, used only by the live WorkIQ path.
