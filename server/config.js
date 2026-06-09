// server/config.js
// Tiny zero-dependency .env loader + typed config. Keeping deps minimal so the
// demo is easy to read and trust.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const str = (k, d = "") => (process.env[k] ?? d).toString();
const int = (k, d) => {
  const n = parseInt(process.env[k] ?? "", 10);
  return Number.isFinite(n) ? n : d;
};

export const ROOT_DIR = ROOT;
export const CAPTURED_DIR = path.join(ROOT, "server", "data", "captured");
export const OUTBOX_DIR = path.join(ROOT, "server", "data", "outbox");
// Filesystem hand-off between the server and the interactive Graph "draft worker"
// (scripts/draft-worker.ps1). The server drops a request here; the worker, which
// holds the user's authenticated Graph session, creates the draft and writes back.
export const DRAFT_QUEUE_DIR = path.join(OUTBOX_DIR, "draft-queue");

export const config = {
  port: int("PORT", 4317),

  workiq: {
    mode: str("WORKIQ_MODE", "captured").toLowerCase(), // captured | live | auto
    mcpCommand: str("WORKIQ_MCP_COMMAND"),
    mcpArgs: str("WORKIQ_MCP_ARGS").split(" ").map((s) => s.trim()).filter(Boolean),
    mcpTool: str("WORKIQ_MCP_TOOL", "ask"),
    questionArg: str("WORKIQ_MCP_QUESTION_ARG", "question"),
    timeoutMs: int("WORKIQ_TIMEOUT_MS", 90000),
  },

  webiq: {
    mode: str("WEBIQ_MODE", "captured").toLowerCase(), // captured | live | auto
    bingKey: str("BING_SEARCH_KEY"),
    serpApiKey: str("SERPAPI_KEY"),
    timeoutMs: int("WEBIQ_TIMEOUT_MS", 12000),
  },

  mail: {
    mode: str("MAIL_MODE", "preview").toLowerCase(), // preview | smtp | draft
    from: str("MAIL_FROM", "WorkIQ Trip Planner <trip-planner@example.com>"),
    to: str("MAIL_TO"),
    smtpHost: str("SMTP_HOST"),
    smtpPort: int("SMTP_PORT", 587),
    smtpUser: str("SMTP_USER"),
    smtpPass: str("SMTP_PASS"),
  },
};
