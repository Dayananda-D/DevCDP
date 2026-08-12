// ─── Logging ─────────────────────────────────────────────────────────────────
// stderr is the MCP server log — useful for us, invisible to the user.
// Anything the *user* must see goes through src/ui/hud.js instead (SESS-2).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS[process.env.DEVCDP_LOG_LEVEL] ?? LEVELS.info;

let mcpServer = null;   // set once the MCP server exists, for logging notifications

export function attachMcpServer(server) { mcpServer = server; }

function emit(level, scope, msg, data) {
  if (LEVELS[level] < threshold) return;
  const line = `[${level}] ${scope} — ${msg}${data ? " " + safeJson(data) : ""}`;
  process.stderr.write(line + "\n");

  // Best-effort MCP logging notification; never let this break a tool call.
  if (mcpServer && LEVELS[level] >= LEVELS.warn) {
    try {
      mcpServer.notification?.({
        method: "notifications/message",
        params: { level: level === "warn" ? "warning" : level, logger: "devcdp", data: msg },
      });
    } catch (_) {}
  }
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch (_) { return "[unserialisable]"; }
}

export const log = {
  debug: (scope, msg, data) => emit("debug", scope, msg, data),
  info:  (scope, msg, data) => emit("info",  scope, msg, data),
  warn:  (scope, msg, data) => emit("warn",  scope, msg, data),
  error: (scope, msg, data) => emit("error", scope, msg, data),
  setLevel(l) { if (LEVELS[l] != null) threshold = LEVELS[l]; },
};
