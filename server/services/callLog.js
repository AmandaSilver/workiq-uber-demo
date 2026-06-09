// server/services/callLog.js
// -----------------------------------------------------------------------------
//  The Call Log is THE feature that makes this a clear WorkIQ demo: every single
//  WorkIQ / WebIQ / Tool invocation is recorded here and streamed to the UI so
//  the audience can SEE exactly when an external WorkIQ API is hit, in which mode
//  (LIVE vs CAPTURED), from which source file/function, with the request and a
//  response summary.
// -----------------------------------------------------------------------------

const MAX_ENTRIES = 200;
const entries = [];
let seq = 0;

/**
 * Record a WorkIQ / WebIQ / Tool call.
 * @param {object} e
 * @param {"ASK"|"WEBIQ"|"TOOL"} e.type        Which kind of WorkIQ boundary.
 * @param {string} e.title                     Human label, e.g. "WorkIQ Ask".
 * @param {"LIVE"|"CAPTURED"|"PREVIEW"} e.mode  How it actually ran.
 * @param {string} e.callSite                   Source file + function, e.g. "services/workiq.js \u2192 askWorkIQ()".
 * @param {string} [e.request]                  The prompt / query / tool input.
 * @param {string} [e.responseSummary]          Short summary of the result.
 * @param {number} [e.durationMs]
 * @param {"ok"|"error"|"fallback"} [e.status]
 * @param {string} [e.detail]                   Extra note (e.g. fallback reason).
 */
export function logCall(e) {
  const entry = {
    id: ++seq,
    at: new Date().toISOString(),
    type: e.type,
    title: e.title,
    mode: e.mode,
    callSite: e.callSite,
    request: e.request ?? "",
    responseSummary: e.responseSummary ?? "",
    durationMs: e.durationMs ?? null,
    status: e.status ?? "ok",
    detail: e.detail ?? "",
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  const badge = { ASK: "WorkIQ \u25b8 Ask", WEBIQ: "WebIQ \u25b8 Search", TOOL: "WorkIQ \u25b8 Tool" }[e.type] ?? e.type;
  const flag = entry.status === "fallback" ? " (LIVE FAILED \u2192 CAPTURED FALLBACK)" : "";
  // Distinct console prefix so it is obvious in the terminal during a demo too.
  console.log(`[${badge}] ${entry.mode}${flag} \u2014 ${entry.callSite} :: ${entry.responseSummary}`);
  return entry;
}

export function getCalls() {
  return entries.slice().reverse(); // newest first
}

export function clearCalls() {
  entries.length = 0;
  seq = 0;
}
