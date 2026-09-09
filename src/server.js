// ─── DevCDP MCP server ───────────────────────────────────────────────────────
// Entry point. Wires the tool registry to MCP, and guarantees two things v4 did
// not: arguments are validated and defaulted in one place before a handler runs
// (TOOL-5, MEM-2), and the tab claim plus any paused page are always released on
// exit (DBG-3, F1) — including on Ctrl-C and on an unhandled rejection.

import { Server }               from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { createContext }  from "./core/context.js";
import { Connection }     from "./cdp/connection.js";
import { MemoryStore }    from "./store/memory.js";
import { log, attachMcpServer } from "./core/log.js";
import { toErrorResult, DevCdpError, CODES } from "./core/errors.js";

/**
 * Socket-level failures worth one retry. Deliberately narrow: a wedged renderer
 * (PAGE_UNRESPONSIVE) is NOT transient — retrying would just stall again — and a
 * bad argument or a missing script certainly is not.
 */
function isTransient(err) {
  if (err?.code === CODES.PAGE_UNRESPONSIVE) return false;
  const m = String(err?.message || "");
  return /WebSocket is not open|Target closed|Session closed|socket hang up|ECONNRESET|not connected to (the )?browser/i.test(m)
      || err?.code === CODES.NOT_CONNECTED;
}

/** Hard ceiling on a tool call, enforced here rather than trusted to the browser. */
function withDeadline(promise, ms, toolName) {
  if (!ms || ms <= 0) return promise;
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DevCdpError(
      CODES.TIMEOUT,
      `${toolName} did not finish within ${ms}ms and was abandoned.`,
      "The browser or the page stopped answering. Call devtools_status to check the connection, and page_reload if the "
      + "page itself is stuck. Raise toolTimeoutMs in your settings file (devcdp_settings shows where it lives) if this "
      + "tool legitimately needs longer.",
      { tool: toolName, waitedMs: ms },
    )), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}
import {
  listTools, getTool, resolveArgs, shape, capResponse, assertRegistryHealthy,
} from "./core/tools.js";

// Registering a tool module is what puts it on the wire.
import "./tools/guide.js";
import "./tools/connect.js";
import "./tools/console.js";
import "./tools/network.js";
import "./tools/dom.js";
import "./tools/interact.js";
import "./tools/capture.js";
import "./tools/sources.js";
import "./tools/debugger.js";
import "./tools/session.js";
import "./tools/memory.js";
import "./tools/discover.js";
import "./tools/settings.js";
import { narrate, narrateFailure } from "./core/narrate.js";

export function createServer(overrides = {}) {
  const ctx = createContext(overrides);
  ctx.conn   = new Connection(ctx);
  ctx.memory = new MemoryStore(ctx.cfg);

  const health = assertRegistryHealthy();

  const server = new Server(
    { name: "devcdp", version: "5.0.0" },
    { capabilities: { tools: {}, logging: {} } },
  );
  attachMcpServer(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const started = Date.now();

    try {
      const tool = getTool(name);
      if (!tool) {
        throw new DevCdpError(CODES.BAD_ARGS, `Unknown tool "${name}".`,
          `Available: ${listTools().map(t => t.name).join(", ")}`);
      }

      const args = resolveArgs(tool, rawArgs || {});

      // One place decides whether a live page is required, and reconnects if so.
      let reconnect = null;
      if (tool.needsClient) {
        const r = await ctx.conn.ensure();
        if (r?.reconnected) reconnect = r;
      }

      // Nothing may hang for ever. A tool that waits on purpose declares its own
      // ceiling; everything else gets the configured backstop.
      const deadlineMs = tool.deadlineFor ? tool.deadlineFor(args, ctx) : ctx.cfg.toolTimeoutMs;

      // Say what is about to happen, before it happens. One place, so every tool is
      // covered — including ones that do not exist yet.
      narrate(ctx, name, args);

      let result, retried = null;
      try {
        result = await withDeadline(tool.handler(args, ctx), deadlineMs, name);
      } catch (err) {
        // A socket that died mid-call is worth exactly one retry, after
        // reattaching — anything more risks repeating a side effect.
        if (ctx.cfg.retryOnDisconnect && tool.needsClient && tool.retryable !== false && isTransient(err)) {
          log.warn("tool", `${name} hit a dropped connection — reattaching and retrying once`);
          ctx.conn.client = null;
          const r = await ctx.conn.ensure();
          retried = { reason: err.message, reconnected: r?.reconnected === true };
          result = await withDeadline(tool.handler(args, ctx), deadlineMs, name);
        } else throw err;
      }

      // Binary a tool wants the model to actually see, lifted out before shaping.
      //
      // It cannot travel through the JSON payload: capResponse would treat a megabyte
      // of base64 as the heaviest string in the tree and truncate it to 200 characters,
      // producing a corrupt image and a cheerful _truncated note. MCP has a content
      // type for exactly this, so it goes alongside the text rather than inside it.
      const media = result && typeof result === "object" ? result._media : null;
      if (media) delete result._media;

      const payload = capResponse(shape(tool, result, args), ctx.cfg.maxResponseBytes, name);

      annotateResponse(payload, ctx, { reconnect, retried });

      log.debug("tool", `${name} ok`, { ms: Date.now() - started });
      const content = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
      if (media?.data) content.push({ type: "image", data: media.data, mimeType: media.mimeType || "image/png" });
      return { content };

    } catch (err) {
      const result = toErrorResult(err);
      // A failure the user cannot see looks exactly like a step still running.
      narrateFailure(ctx, name, err);
      log.warn("tool", `${name} failed: ${result.code}`, { message: result.message, ms: Date.now() - started });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], isError: true };
    }
  });

  // ── shutdown: never leave a frozen page or a stuck claim behind ──
  let shuttingDown = false;
  const shutdown = async (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("server", `shutting down (${why})`);
    try { await ctx.conn.detach({ release: true, quiet: true }); } catch (_) {}
    try { ctx.registry.releaseAll(); } catch (_) {}
  };

  process.on("SIGINT",  () => shutdown("SIGINT").finally(() => process.exit(0)));
  process.on("SIGTERM", () => shutdown("SIGTERM").finally(() => process.exit(0)));
  process.on("beforeExit", () => { shutdown("beforeExit"); });
  process.on("uncaughtException", (e) => {
    log.error("server", `uncaught: ${e.message}`, { stack: e.stack?.split("\n").slice(0, 3) });
    shutdown("uncaughtException").finally(() => process.exit(1));
  });
  process.on("unhandledRejection", (e) => {
    log.error("server", `unhandled rejection: ${e?.message || e}`);
  });

  return { server, ctx, health, shutdown };
}

/**
 * Attach the facts about *how* a call was answered, as opposed to what it returned.
 *
 * Each of these is something the caller would otherwise have to go looking for, and
 * would probably not think to: that we silently reattached, that the call was retried,
 * that the app's running script had to be aborted, or that somebody used the page while
 * we were working. Exported so the tests drive the same function the server does.
 */
export function annotateResponse(payload, ctx, { reconnect = null, retried = null } = {}) {
  if (reconnect) payload._reconnected = reconnect;
  if (retried)   payload._retried = retried;

  // The page had to be unblocked to answer this call, which aborted the app's
  // in-flight script — never silent.
  if (ctx.conn.lastRecovery) {
    payload._recovered = ctx.conn.lastRecovery;
    ctx.conn.lastRecovery = null;
  }

  // Somebody interacted with the page. Not an error — it is often the whole point —
  // but anything concluded before it may no longer hold.
  const seen = ctx.session.interference;
  if (seen?.count) {
    payload._userActed = {
      count: seen.count,
      actions: seen.actions,
      note: "Someone interacted with the page during this session. The app may no longer be in the state you left it "
          + "in — re-read what you depend on before drawing a conclusion. Full detail: session_get_user_actions.",
      caution: "Browser-dispatched input is indistinguishable from a real person's, so this may also be another "
             + "automation tool driving the same tab.",
    };
    ctx.session.interference = null;
  }
  return payload;
}

export async function main() {
  const { server, ctx, health, shutdown } = createServer();
  const transport = new StdioServerTransport();

  // The usual way an MCP server's work ends is the client closing the pipe, not a
  // signal — and on Windows a client that kills the process sends no signal at all.
  // Without this the indicator stayed on screen until the in-page watchdog gave up on
  // us, which is right for a crash but far too slow for an ordinary disconnect: the
  // moment nobody is driving the tab, the mark should be gone.
  transport.onclose = () => { shutdown("client disconnected").finally(() => process.exit(0)); };
  process.stdin.on("end",   () => shutdown("stdin closed").finally(() => process.exit(0)));
  process.stdin.on("close", () => shutdown("stdin closed").finally(() => process.exit(0)));

  await server.connect(transport);
  log.info("server", `DevCDP v5 ready — ${health.tools} tools`, {
    session: ctx.sessionId,
    docsRoot: ctx.cfg.docsRoot || "(not configured)",
    sharedMemory: ctx.cfg.sharedMemoryDir || "(local only)",
  });
}
