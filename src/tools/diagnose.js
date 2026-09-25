// Fast, low-token diagnosis for the first response after attaching.
// This deliberately summarizes in-memory observations instead of fetching large
// console, network, DOM, or response-body payloads.
import { defineTool } from "../core/tools.js";

function recentConsoleErrors(ctx) {
  return ctx.consoleBuf().all()
    .filter(entry => entry.source !== "devcdp-agent" && (entry.level === "error" || entry.level === "uncaughtException"))
    .slice(-5)
    .map(entry => ({
      level: entry.level,
      text: String(entry.text || entry.message || "").slice(0, 240),
      url: entry.url || undefined,
      line: entry.line ?? undefined,
    }));
}

function failedRequests(ctx) {
  return ctx.network.all()
    .filter(request => request.error || (request.status != null && request.status >= 400))
    .slice(-5)
    .map(request => ({
      method: request.method,
      url: String(request.url || "").slice(0, 300),
      status: request.status ?? undefined,
      error: request.error || undefined,
    }));
}

defineTool({
  name: "devcdp_triage",
  readOnly: true,
  description:
    "Return a compact, low-token diagnosis of the attached page and the next best debugging action. "
    + "Use this first after connecting or after a reproduction instead of calling status, console and network tools separately. "
    + "It never includes full logs, DOM, headers, or response bodies; use the suggested follow-up tool for detail.",
  args: {
    include_recent: {
      type: "boolean",
      description: "Include up to five recent app console errors and failed requests.",
      default: true,
    },
  },
  async handler(args, ctx) {
    const conn = ctx.conn;
    let page = {};
    let pageResponsive = true;
    try {
      const probe = await conn.eval(
        "JSON.stringify({url:location.href,title:document.title,readyState:document.readyState})",
        { timeoutMs: 1500, recover: false, label: "triage probe" },
      );
      page = JSON.parse(probe?.result?.value || "{}");
    } catch (_) {
      pageResponsive = false;
    }

    const allConsoleErrors = recentConsoleErrors(ctx);
    const allFailedRequests = failedRequests(ctx);
    const consoleErrors = args.include_recent ? allConsoleErrors : [];
    const failed = args.include_recent ? allFailedRequests : [];
    const unbound = [...ctx.desired.breakpoints.values()].filter(breakpoint => !breakpoint.bound).length;
    const findings = [];
    const nextActions = [];

    if (!pageResponsive) {
      findings.push({ severity: "critical", code: "page_unresponsive", message: "The page did not answer a quick probe." });
      nextActions.push({ tool: "page_interrupt", why: "Abort a runaway script without reloading and losing page state." });
    }
    if (allConsoleErrors.length) {
      findings.push({ severity: "error", code: "console_errors", count: allConsoleErrors.length, message: "Recent application errors are captured." });
      nextActions.push({ tool: "console_get_logs", args: { level: "error", limit: 20 }, why: "Read the full stack and source location." });
    }
    if (allFailedRequests.length) {
      findings.push({ severity: "error", code: "failed_requests", count: allFailedRequests.length, message: "Recent network failures or HTTP 4xx/5xx responses are captured." });
      nextActions.push({ tool: "network_list_requests", args: { failed_only: true, limit: 20 }, why: "Inspect the failing request, status and initiator." });
    }
    if (ctx.pause.active) {
      findings.push({ severity: "warning", code: "debugger_paused", message: "Execution is currently paused at a breakpoint." });
      nextActions.push({ tool: "debugger_get_capture", why: "Read the paused call stack and captured locals." });
    }
    if (unbound) {
      findings.push({ severity: "warning", code: "unbound_breakpoints", count: unbound, message: "Some requested breakpoints are not bound to executable code." });
      nextActions.push({ tool: "debugger_list_breakpoints", why: "Check the source URL and line where each breakpoint was requested." });
    }
    if (!findings.length) {
      findings.push({ severity: "ok", code: "no_observed_failure", message: "No console, network, or liveness failure is currently observed." });
      nextActions.push({ tool: "app_discover", why: "Map the page's real interactive surface before guessing selectors." });
    }
    if (!ctx.conn.preAttach) {
      nextActions.push({ tool: "page_reload", why: "Capture failures that happened before DevCDP attached." });
    }

    return {
      health: findings.some(f => f.severity === "critical")
        ? "blocked"
        : findings.some(f => f.severity === "error")
          ? "errors-observed"
          : "ready",
      pageResponsive,
      target: { url: page.url || conn.targetUrl || null, title: page.title || conn.targetTitle || null, readyState: page.readyState || null },
      observed: {
        consoleErrors: ctx.consoleBuf().stats().count,
        failedRequests: ctx.network.all().filter(request => request.error || (request.status != null && request.status >= 400)).length,
        bufferedRequests: ctx.network.stats().count,
        paused: ctx.pause.active,
        breakpoints: ctx.desired.breakpoints.size,
        unboundBreakpoints: unbound,
      },
      findings,
      ...(args.include_recent ? { recentConsoleErrors: consoleErrors, recentFailedRequests: failed } : {}),
      nextActions,
      note: "This is a compact triage summary. Follow the suggested tool for full evidence; no response bodies or DOM were fetched.",
    };
  },
});
