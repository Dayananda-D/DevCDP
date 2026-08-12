// ─── Console tools ───────────────────────────────────────────────────────────

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";

const LEVEL_ALIASES = { warning: "warn", err: "error" };
const norm = l => LEVEL_ALIASES[l] || l;

defineTool({
  name: "console_get_logs",
  description:
    "Read console output captured since attach: logs, warnings, uncaught exceptions with file, line and stack. "
    + "Pass cursor=nextCursor from a previous call to get only what is new. Note that Chrome does not replay "
    + "messages logged before DevCDP attached — reproduce the action or call page_reload to see those.",
  args: {
    level:  { type: "string", description: "Only this level.", enum: ["all", "log", "info", "warn", "warning", "error", "debug"], default: "all" },
    cursor: { type: "number", description: "Return only entries with seq greater than this. 0 for everything held.", default: 0 },
    since:  { type: "string", description: "ISO timestamp lower bound." },
    limit:  { type: "number", description: "Maximum entries to return (most recent first in the buffer order).", default: 30, min: 1, max: 500 },
    include_agent: { type: "boolean", description: "Include DevCDP's own diagnostics, normally hidden so they cannot be mistaken for app errors.", default: false },
    clear:  { type: "boolean", description: "Empty the buffer after reading.", default: false },
  },
  async handler(args, ctx) {
    const buf = ctx.consoleBuf();
    const stats = buf.stats();

    let logs = buf.since(args.cursor);
    const nothingNew = args.cursor > 0 && logs.length === 0;

    if (args.since)  logs = logs.filter(l => l.timestamp >= args.since);
    if (args.level !== "all") {
      const want = norm(args.level);
      logs = logs.filter(l => norm(l.level) === want);
    }
    if (!args.include_agent) logs = logs.filter(l => l.source !== "devcdp-agent");

    const total = logs.length;
    logs = logs.slice(-args.limit);
    if (args.clear) buf.clear();

    return {
      nextCursor: buf.seq,
      count: logs.length,
      ...(total > logs.length ? { omitted: total - logs.length, note: `${total} matched; showing the newest ${logs.length}. Raise limit or use cursor paging.` } : {}),
      ...(nothingNew ? { noChange: true } : {}),
      ...(stats.dropped ? { evicted: stats.dropped, evictionNote: stats.note } : {}),
      logs,
    };
  },
});

defineTool({
  name: "console_evaluate",
  description:
    "Run a JavaScript expression in the page and return its value. On failure returns the full exception detail "
    + "(message, 1-based line and column, URL, stack). Use it to read app state; use debugger_evaluate_at_frame "
    + "instead when you are paused and need a local variable.",
  args: {
    expression:    { type: "string",  description: "JavaScript to evaluate in the page's main frame.", required: true },
    await_promise: { type: "boolean", description: "Await the result if the expression returns a promise.", default: false },
    timeout_ms:    { type: "number",  description: "Abandon the evaluation after this long.", default: 10000, min: 100, max: 120000 },
  },
  deadlineFor: args => args.timeout_ms + 5000,
  async handler(args, ctx) {
    // Bounded on our side: the renderer cannot enforce a timeout while it is the
    // thing that is stuck.
    const { result, exceptionDetails } = await ctx.conn.eval(args.expression, {
      awaitPromise: args.await_promise,
      timeoutMs: args.timeout_ms,
      silent: false,
      label: "console_evaluate",
    });

    if (exceptionDetails) {
      const frames = exceptionDetails.stackTrace?.callFrames || [];
      fail(CODES.EVAL_FAILED,
        exceptionDetails.exception?.description?.split("\n")[0] || exceptionDetails.text || "Evaluation failed",
        "Check the expression against the page's actual globals — console_evaluate('Object.keys(window).slice(0,50)') is a quick way to look.",
        {
          line:   exceptionDetails.lineNumber   != null ? exceptionDetails.lineNumber + 1   : null,
          column: exceptionDetails.columnNumber != null ? exceptionDetails.columnNumber + 1 : null,
          url:    exceptionDetails.url || frames[0]?.url || null,
          stack:  frames.slice(0, 6).map(f => `${f.functionName || "(anonymous)"} ${f.url}:${f.lineNumber + 1}`),
        });
    }

    return describeResult(result);
  },
});

/**
 * Turn a Runtime.RemoteObject into something a model can act on.
 *
 * Most values come back copied and need no help. Live objects — a DOM node, a
 * window, a component with a reference back to itself — cannot be copied at all,
 * so they arrive as a reference plus a preview. Saying so plainly, with the property
 * names that were visible and how to read one, beats either a raw protocol error or
 * a bare "[object Object]" (EVAL-1).
 */
function describeResult(result) {
  const base = {
    type: result.type,
    subtype: result.subtype || undefined,
  };
  if (!result.byReference) {
    return { ...base, value: result.value !== undefined ? result.value : result.description };
  }

  const props = (result.preview?.properties || []).slice(0, 30);
  return {
    ...base,
    className: result.className || undefined,
    value: result.description || result.className || result.type,
    ...(props.length
      ? { properties: Object.fromEntries(props.map(p => [p.name, p.type === "string" ? p.value : (p.value ?? p.type)])) }
      : {}),
    ...(result.preview?.overflow ? { more: "preview truncated — more properties exist" } : {}),
    note: "A live object, so its value could not be copied out of the page. The properties above are a shallow "
        + "preview; evaluate a specific path (for example the same expression + '.id') to read one for real.",
  };
}

defineTool({
  name: "runtime_evaluate_many",
  description:
    "Evaluate several named expressions in one round trip and get a map of name to result. Use it to sample a lot "
    + "of app state at once instead of paying a round trip per question. Individual failures are reported per entry "
    + "rather than aborting the batch.",
  args: {
    expressions: {
      type: "array", required: true,
      description: "Array of { name, expression } objects.",
      items: {
        type: "object",
        required: ["name", "expression"],
        properties: { name: { type: "string" }, expression: { type: "string" } },
      },
    },
    await_promise: { type: "boolean", description: "Await promise results.", default: false },
  },
  async handler(args, ctx) {
    if (!args.expressions.length) {
      fail(CODES.BAD_ARGS, "expressions was empty.", "Pass at least one { name, expression } pair.");
    }

    const results = {};
    let failures = 0;

    for (const item of args.expressions) {
      if (!item?.name || !item?.expression) {
        failures++;
        results[item?.name || `unnamed_${failures}`] = { ok: false, message: "Each entry needs both name and expression." };
        continue;
      }
      try {
        const { result, exceptionDetails } = await ctx.conn.eval(item.expression, {
          awaitPromise: args.await_promise, silent: false, label: `expression "${item.name}"`,
        });
        if (exceptionDetails) {
          failures++;
          results[item.name] = {
            ok: false,
            message: exceptionDetails.exception?.description?.split("\n")[0] || exceptionDetails.text,
            line: exceptionDetails.lineNumber != null ? exceptionDetails.lineNumber + 1 : null,
          };
        } else {
          results[item.name] = { ok: true, ...describeResult(result) };
        }
      } catch (e) {
        failures++;
        results[item.name] = { ok: false, message: e.message };
      }
    }

    return { evaluated: args.expressions.length, failed: failures, results };
  },
});

defineTool({
  name: "console_clear",
  description:
    "Empty the console buffer so that what you read next belongs only to the action you are about to take. "
    + "Does not touch the browser's own console display.",
  async handler(_args, ctx) {
    const before = ctx.consoleBuf().items.length;
    ctx.consoleBuf().clear();
    return { cleared: true, discarded: before };
  },
});
