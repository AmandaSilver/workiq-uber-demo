// server/services/workiq.js
// =============================================================================
//
//      🔵🔵🔵   W O R K I Q   " A S K "   A P I   B O U N D A R Y   🔵🔵🔵
//
//   This module is where the app asks WorkIQ a natural-language question over
//   the user's Microsoft 365 data (email/meetings/files). In this demo we ask
//   it to find Uber ride receipts in the user's mailbox.
//
//   The single WorkIQ call site is `callLiveWorkIQ()` below, clearly marked.
//   Everything is recorded in the Call Log so it is visible in the UI/terminal.
//
// =============================================================================
import fs from "node:fs/promises";
import path from "node:path";
import { config, CAPTURED_DIR } from "../config.js";
import { logCall } from "./callLog.js";
import { parseReceipts } from "./receiptParser.js";

const CALL_SITE = "services/workiq.js \u2192 askWorkIQ()";

// The exact prompt sent to WorkIQ. We request STRICT JSON to keep the live path
// reliable; the parser also tolerates prose if WorkIQ answers conversationally.
export const WORKIQ_PROMPT = [
  "Search my email from the last 3 weeks for Uber ride receipts.",
  "Deduplicate repeated forwards of the same ride.",
  "Return ONLY a JSON array (no prose, no code fences) where each element is:",
  '{ "date": "YYYY-MM-DD", "time": "HH:MM", "pickupAddress": "...",',
  '  "dropoffAddress": "...", "total": <number, final amount incl. tip> }.',
].join(" ");

async function loadCaptured() {
  const raw = await fs.readFile(path.join(CAPTURED_DIR, "uber-receipts.json"), "utf8");
  return JSON.parse(raw);
}

// The WorkIQ "ask" tool returns its answer inside a JSON envelope:
//   {"response": "<actual answer text>", "conversationId": "..."}
// Unwrap one (or more) such envelopes and return the inner answer text.
function unwrapWorkIQAnswer(text) {
  let out = text.trim();
  for (let i = 0; i < 3 && out.startsWith("{"); i++) {
    try {
      const env = JSON.parse(out);
      if (env && typeof env.response === "string") {
        out = env.response.trim();
        continue;
      }
    } catch {
      /* not a JSON envelope */
    }
    break;
  }
  return out;
}

// -----------------------------------------------------------------------------
//  THE LIVE WORKIQ CALL. Speaks MCP (stdio) to a configured WorkIQ MCP server
//  and calls its "ask" tool. Throws on any problem so callers can fall back.
// -----------------------------------------------------------------------------
async function callLiveWorkIQ() {
  const { mcpCommand, mcpArgs, mcpTool, questionArg, timeoutMs } = config.workiq;
  if (!mcpCommand) {
    throw new Error("WORKIQ_MCP_COMMAND is not set (no live WorkIQ MCP server configured).");
  }

  // Imported lazily because @modelcontextprotocol/sdk is an optional dependency.
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");

  const transport = new StdioClientTransport({ command: mcpCommand, args: mcpArgs });
  const client = new Client({ name: "workiq-trip-planner", version: "1.0.0" }, { capabilities: {} });

  // Race a promise against a timeout, ALWAYS clearing the timer so it can't leak
  // or fire late. On timeout the caller tears down the transport (below), which
  // kills the spawned MCP child process.
  const withTimeout = (p, label) => {
    let timer;
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };

  try {
    await withTimeout(client.connect(transport), "WorkIQ MCP connect");
    // ===== THE ACTUAL WORKIQ "ASK" INVOCATION =====
    const result = await withTimeout(
      client.callTool({ name: mcpTool, arguments: { [questionArg]: WORKIQ_PROMPT } }),
      "WorkIQ Ask"
    );
    // ==============================================
    const text = (result?.content || [])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!text) throw new Error("WorkIQ returned an empty response.");
    // The WorkIQ MCP "ask" tool wraps its answer as
    //   {"response": "<the actual answer>", "conversationId": "..."}
    // Unwrap it so the receipt parser sees the real answer (often a JSON array),
    // not the escaped envelope.
    return unwrapWorkIQAnswer(text);
  } finally {
    // Close the client AND the transport so the spawned npx child is reaped even
    // when we bailed out on a timeout (otherwise the process can linger).
    try { await client.close(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
  }
}

/**
 * Pre-warm the live WorkIQ MCP server at startup so the FIRST demo click is fast.
 *
 * The slow, variable part of a live Ask is the mailbox query itself (~30s+), which
 * we now cover with a generous timeout. This pre-warm eliminates the OTHER cold
 * cost: `npx -y @microsoft/workiq@latest` downloading the package and spawning the
 * MCP child. We connect + listTools (a cheap handshake) and tear down, leaving the
 * npx cache hot so the real call's connect phase stays a few seconds, not tens.
 *
 * Fire-and-forget: any failure is logged and ignored (the live call still falls
 * back to captured data in auto mode).
 */
export async function prewarmWorkIQ() {
  const { mcpCommand, mcpArgs } = config.workiq;
  const mode = (config.workiq.mode || "captured").toLowerCase();
  if (mode === "captured" || !mcpCommand) return; // nothing to warm in captured mode
  const started = Date.now();
  try {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({ command: mcpCommand, args: mcpArgs });
    const client = new Client({ name: "workiq-trip-planner-prewarm", version: "1.0.0" }, { capabilities: {} });
    try {
      await client.connect(transport);
      await client.listTools();
    } finally {
      try { await client.close(); } catch { /* ignore */ }
      try { await transport.close(); } catch { /* ignore */ }
    }
    console.log(`[WorkIQ] MCP pre-warmed in ${((Date.now() - started) / 1000).toFixed(1)}s (npx cache hot; first live Ask will connect fast).`);
  } catch (err) {
    console.log(`[WorkIQ] pre-warm skipped: ${err.message}`);
  }
}

/**
 * Ask WorkIQ for the user's Uber receipts.
 * @param {object} [opts]
 * @param {"captured"|"live"|"auto"} [opts.mode]  Overrides config for this call.
 * @returns {Promise<{rides:object[], mode:"LIVE"|"CAPTURED", status:string,
 *                     rawText:string, parser:string, prompt:string, detail:string}>}
 */
export async function askWorkIQ(opts = {}) {
  const mode = (opts.mode || config.workiq.mode || "captured").toLowerCase();
  const started = Date.now();

  const useCaptured = async (status, detail) => {
    const data = await loadCaptured();
    logCall({
      type: "ASK",
      title: "WorkIQ Ask",
      mode: "CAPTURED",
      callSite: CALL_SITE,
      request: WORKIQ_PROMPT,
      responseSummary: `${data.rides.length} ride receipts (captured sample dataset)`,
      durationMs: Date.now() - started,
      status,
      detail,
    });
    return {
      rides: data.rides,
      mode: "CAPTURED",
      status,
      rawText: data.rawText,
      parser: "captured",
      prompt: WORKIQ_PROMPT,
      detail: detail || "",
    };
  };

  if (mode === "captured") return useCaptured("ok", "Captured mode (configured).");

  // live or auto -> attempt the real WorkIQ call.
  try {
    const rawText = await callLiveWorkIQ();
    const { rides, parser } = await parseReceipts(rawText);
    if (rides.length === 0) throw new Error("WorkIQ answered but no rides could be parsed/mapped.");
    logCall({
      type: "ASK",
      title: "WorkIQ Ask",
      mode: "LIVE",
      callSite: CALL_SITE,
      request: WORKIQ_PROMPT,
      responseSummary: `${rides.length} ride receipts parsed live from WorkIQ (${parser})`,
      durationMs: Date.now() - started,
      status: "ok",
    });
    return { rides, mode: "LIVE", status: "ok", rawText, parser, prompt: WORKIQ_PROMPT, detail: "" };
  } catch (err) {
    if (mode === "live") {
      // Loud failure: in pure-live mode we do NOT silently fake success.
      logCall({
        type: "ASK",
        title: "WorkIQ Ask",
        mode: "LIVE",
        callSite: CALL_SITE,
        request: WORKIQ_PROMPT,
        responseSummary: "LIVE WorkIQ call failed",
        durationMs: Date.now() - started,
        status: "error",
        detail: err.message,
      });
      const e = new Error(`Live WorkIQ failed: ${err.message}`);
      e.code = "WORKIQ_LIVE_FAILED";
      throw e;
    }
    // auto -> loud, visible fallback to captured.
    return useCaptured("fallback", `Live WorkIQ failed, replayed captured data. Reason: ${err.message}`);
  }
}
