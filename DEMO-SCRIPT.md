# WorkIQ Hero Demo — Presenter Script

A \~4‑minute live demo that shows the two halves of WorkIQ working together:
**Ask** (read/reason over your real M365 data) and **Tools** (take a real action
on your behalf), with **WebIQ** in the middle for an open‑web search.

> **The one‑sentence premise:** \*"I took a work trip to San Francisco. Let's have
> WorkIQ read my mailbox, figure out where I actually spent my time, and plan next
> year's trip for me — then file the report back into my mailbox as a draft."\*

---

## 0. Before you go on stage (2‑minute setup)

1. **Start the app**

```javascript
cd workiq-trip-planner
   npm start            # → http://localhost:4317
```

2. **Start the Draft worker** (only needed for the step‑5 "save to Drafts" finale)

```javascript
   npm run draft-worker
```

   Open the printed URL, enter the one device code, sign in. Wait for
   **`Draft worker ready`**. Do this *before* the demo so the token is fresh.

3. **Open the app** and leave it on the clean landing screen. The right panel
   should be on the **💬 Chat** tab.
4. **Presenter check (your eyes only):** the small **⚙ Presenter** menu in the
   top‑right lets you pin Ask/WebIQ/Mail to `captured` (safe, offline) or `live`.
   Leave **WorkIQ Ask** and **WebIQ** on **auto** — both run live by default and
   silently fall back to the sample if the live call is slow or finds nothing.

**WorkIQ Ask** reads your real mailbox (≈30s on a cold call; the app pre‑warms
     the connection at startup so the first demo click is fast).**WebIQ** runs live with **no API key** — it queries OpenStreetMap for nearby
     luxury hotels. The public endpoint is occasionally rate‑limited; on a miss it
     falls back to the captured hotel so the demo never stalls. (Add a
     `BING_SEARCH_KEY` or `SERPAPI_KEY` to `.env` for a rock‑solid live path.)**Mail** is pinned to `draft` — it only ever **saves to Drafts**, never sends.

> If anything looks stale between runs, click the **✕** on the panel or hit
> **Reset** — every step returns to the start.

---

## 1. The talk track (what to click + what to say)

> **Tip:** each step carries a colored **API badge** in its top‑right corner —
> blue **WorkIQ Ask**, purple **WebIQ**, green **WorkIQ Tool**. Point at them as you
> go so the audience can see exactly which capability is firing.

### ▶ Step 1 — **Ask**: "Read my mailbox"

**Click `🔵 Ask WorkIQ`.**

> \*"I'm not uploading anything or pasting data. WorkIQ **Ask** is reading my real
> Microsoft 365 mailbox, finding every Uber receipt from the trip, and pulling out
> the pickup, drop‑off, and price from each one."\*

Watch the map draw the rides and the totals appear. Then point at the \*\*chat panel
on the right\*\*, which now shows a synthesized answer:

> \*"And this is the part people feel — Ask doesn't just return rows, it gives me a
> **debrief in plain language**: 9 rides, $227.76, most of my time around Union
> Square. That's the 'Ask' experience — a conversation grounded in my own data."\*

### ▶ Follow‑up — **Ask is conversational**

**Type into the chat box:** `Which ride was the most expensive?` (or `List all my rides`).

> \*"Because it's a conversation, I can keep digging — no new query language, just
> follow‑up questions against the same trip."\*

### ▶ Steps 2–3 — the app's own reasoning

**Click `📍 Recommend stay area`.**

> \*"Now my app does ordinary work on what Ask gave it — it takes the geographic
> center of the in‑city rides (ignoring airport runs) and says: \*\*next year, base
> yourself in Union Square.\*\*"\*

### ▶ Step 4 — **WebIQ**: open‑web search

**Click `🟣 Search with WebIQ`.**

> \*"WorkIQ can also reach beyond my tenant. **WebIQ** searches the open web for the
> closest 5‑star hotel to that spot — here's the top match, just a short walk away."\*

> **Note:** the hotel is a **live** result, so the exact name/distance varies run to
> run (e.g. Taj Campton Place, \~0.18 mi). If the live call is rate‑limited it quietly
> shows the captured hotel instead — either way the card renders cleanly.

> **Adaptable tier (optional flourish):** the star rating isn't hard‑wired. Type
> `find me a 3-star hotel` (or `what about a 4-star?`) into the chat and WebIQ
> re‑searches at that tier — the card relabels to *"Best 3‑star hotel…"* and the map
> re‑pins. Live OSM only reliably tags luxury brands, so non‑5‑star tiers fall back to
> the captured San Francisco hotel set (3/4/5‑star) — still real hotels, always on‑map.

### ▶ Step 5 — **Tools**: take a real action  ⭐ the payoff

\*\*Make sure the Presenter ▸ Mail is `draft (save to Drafts)`, then click
`🟢 Send with WorkIQ Tool`.\*\*

> \*"Here's the other half of WorkIQ. Ask **read** my data; a **Tool** now **acts**
> on it. WorkIQ is writing a formatted trip report straight into my Outlook
> **Drafts** — a real action in a real system, not a chat reply."\*

Click **"Open the draft in Outlook →"** to show the actual draft sitting in the
mailbox. **Done.**

---

## 2. The point of the whole demo: **Ask vs. Tools**

This is the slide to land. Say it out loud, in these words:

|  | **Ask** | **Tools** |
| --- | --- | --- |
| **What it does** | *Reads & reasons* over your data | *Acts* in your systems |
| **Direction** | Information **out** | Change **in** |
| **In this demo** | Scanned the mailbox, debriefed the trip (steps 1 + chat) | Saved the report to Drafts (step 5) |
| **Feels like** | "Answer my question" | "Go do this for me" |
| **Call site** | `services/workiq.js → askWorkIQ()` | `services/mailer.js → sendReport()` |

> **The line:** \*"**Ask** turns my data into an answer. **Tools** turn that answer
> into an action. WorkIQ does both — and you just watched it read my inbox and then
> write back to it in one flow."\*

---

## 3. "Show me the code" — where WorkIQ is actually invoked

Every WorkIQ call goes through one obvious function. Flip to these if someone asks
"but where's the API?" (The **📋 Call Log** tab also logs each call live — switch to
it to show requests/responses, but it's presenter‑facing, so keep it hidden for the
main run.)

| Capability | Button | Call site (one function) |
| --- | --- | --- |
| **Ask** (scan + reason) | `🔵 Ask WorkIQ` | `server/services/workiq.js` → `askWorkIQ()` |
| **Ask** (chat follow‑ups) | chat box / `💬 Chat` | `POST /api/ask` → `answerTripFollowUp()` |
| **WebIQ** (open‑web search) | `🟣 Search with WebIQ` | `server/services/webiq.js` → `searchHotels()` |
| **Tool** (save draft / send) | `🟢 Send with WorkIQ Tool` | `server/services/mailer.js` → `sendReport()` |

---

## 3a. Code walk‑through — the actual Ask & Tool API calls ⭐

> **When to use this:** for a technical audience, or whenever someone asks \*"but where
> does it actually call WorkIQ?"\* Split the screen — app on one side, **VS Code** on the
> other — and open these two files. Each WorkIQ capability funnels through **one**
> clearly‑marked call site, so there's exactly one line to point at per API.
> 
> **VS Code tip:** `Ctrl+P` to open the file, then `Ctrl+F` for the ALL‑CAPS marker
> comment noted below — it jumps you straight to the invocation.

### 🔵 WorkIQ **Ask** — `server/services/workiq.js`

Open the file and search for the marker **`THE ACTUAL WORKIQ "ASK" INVOCATION`**
(\~line 87). This is the whole API call:

```js
// server/services/workiq.js  → callLiveWorkIQ()
const transport = new StdioClientTransport({ command: mcpCommand, args: mcpArgs });
const client = new Client({ name: "workiq-trip-planner", version: "1.0.0" }, { capabilities: {} });

await client.connect(transport);

// ===== THE ACTUAL WORKIQ "ASK" INVOCATION =====
const result = await client.callTool({
  name: mcpTool,                          // "ask"
  arguments: { [questionArg]: WORKIQ_PROMPT },  // question: "Search my email…"
});
// ==============================================
```

> \*"WorkIQ ships as an **MCP server** — the same one the VS Code / Copilot harness
> uses. We spawn it (`npx @microsoft/workiq mcp`), then make one call: the
> **`ask`** tool with a natural‑language **`question`**. That's the entire Ask
> API — no SDK, no mailbox plumbing on our side. WorkIQ reads my M365 data and hands
> back the answer."\*

Two things worth pointing at right above it:

- **The prompt** (`WORKIQ_PROMPT`, \~line 24) — \*"this is literally the English I send;
  I ask for strict JSON just to keep parsing reliable."\*
- **The tool name & arg** come from config (`mcpTool = ask`,
  `questionArg = question`) — *"swappable, but this is the real WorkIQ Ask tool."*

### 🟢 WorkIQ **Tool** — `server/services/mailer.js`

Open the file (banner: **`WORKIQ "TOOLS" BOUNDARY`** at the top). The action is "write
the report into my mailbox." Point at the Graph call that the Tool performs:

```js
// server/services/mailer.js  → sendReport()  (mode "draft")
// The WorkIQ Tool takes a real ACTION in M365: create a Draft via Microsoft Graph.
const out = await saveDraftViaWorker({ to, subject, html });   // → POST /me/messages

logCall({
  type: "TOOL",
  title: "WorkIQ Tool: Save Draft",
  request: `POST /me/messages — to=${to} subject="${subject}"`,  // the real Graph call
  // …
});
```

> \*"This is the other half. Ask **read** my data; a **Tool** now **acts** on it — a real
> **`POST /me/messages`** to Microsoft Graph that creates a draft in my Outlook. We
> deliberately stop at **Draft** (never send) so it's a safe, admin‑allowed action — and
> the Graph token lives in a separate worker, never in this server."\*

> **The payoff line:** \*"Same product, two verbs — **Ask** gives you an answer,
> **Tools** take an action. One `callTool` call read my inbox; one `POST /me/messages`
> wrote back to it."\*

**Don't forget the live proof:** switch to the **📋 Call Log** tab to show these exact
requests/responses were logged in real time — `ASK` and `TOOL` rows with durations.

---

## 4. If something goes sideways (graceful by design)

- **Live Ask is slow or finds nothing** → it auto‑falls back to a representative
  sample; the demo never stalls. (Force it with Presenter ▸ WorkIQ = `captured`.)
- **Live WebIQ is rate‑limited / the public endpoint is down** → it auto‑falls back
  to the captured 5‑star hotel; the card still renders. (Force live‑only or captured
  with Presenter ▸ WebIQ. A `BING_SEARCH_KEY`/`SERPAPI_KEY` in `.env` makes live
  reliable.)
- **Draft worker not running / token expired** → step 5 quietly renders an email
  **preview** instead and tells you why. Restart `npm run draft-worker` and re‑sign in.
- **Admin blocks the work account** → the worker signs in with a personal account;
  the draft still lands in a real mailbox. (Sending is *intentionally* not used —
  saving a Draft is the safe, allowed action.)
- **Need a clean slate** → **Reset** (or the panel **✕**) returns every step to start.

---

## 5. 30‑second version (if you're tight on time)

1. `🔵 Ask WorkIQ` → *"It read my mailbox and debriefed the trip."* (point at chat)
2. `🟣 Search with WebIQ` → *"It searched the web for the best hotel."*
3. Presenter ▸ Mail = `draft`, `🟢 Send with WorkIQ Tool` → \*"And it wrote the
   report back into my Drafts — that's a **Tool taking action**, not just answering."\*