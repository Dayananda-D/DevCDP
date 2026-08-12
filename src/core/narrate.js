// ─── Narration ───────────────────────────────────────────────────────────────
//
// The overlay used to speak only where somebody had remembered to make it speak:
// eleven hand-placed setBadge calls out of seventy-three tools. So the page went
// quiet for whole stretches of work — a source search, a scope read, six evaluations
// — and quiet looks identical to stuck. The user watching their own application had
// no way to tell a long step from a dead one.
//
// This makes the tool call itself the signal. Every call narrates before it runs, from
// one place in the dispatcher, so a tool added tomorrow is covered without anyone
// remembering anything. The hand-placed messages stay: they fire *after* the work with
// the result in hand ("200 ← /api/bom (412ms)"), which is a different and better
// message than anything derivable from the arguments.
//
// What this cannot do is show what the assistant *said*. Its prose never reaches this
// process — only its tool calls do. `notify_user` remains the channel for that, and
// the guidance in initialize/ tells the model to use it.

/**
 * Tools that would be noise rather than narration.
 *
 * Everything here is either introspection that does not touch the page, or a tool that
 * already writes its own more specific message. Narrating them would push the message
 * that matters out of a three-deep stack.
 */
const SILENT = new Set([
  "notify_user", "session_ask_user", "session_poll_user_action",   // speak for themselves
  "devtools_status", "sessions_list", "list_tabs", "devcdp_settings", "devcdp_settings_init",
  "session_get_status", "session_get_state", "session_get_activity", "session_get_user_actions",
  "workflow_guide", "docs_outline", "docs_search", "memory_get",
  "debugger_list_breakpoints", "debugger_get_capture", "debugger_get_state",
]);

/**
 * Phrasing for the tools worth phrasing well. Everything else falls back to the
 * generic transform below, which is serviceable rather than good — a table entry is
 * for when "source get script" reads worse than "reading".
 */
const VERBS = {
  devtools_connect: "attaching to the tab",
  devtools_disconnect: "detaching",
  page_navigate: "navigating",
  page_reload: "reloading",
  page_interrupt: "aborting the running script",
  console_get_logs: "reading the console",
  console_evaluate: "evaluating",
  console_clear: "clearing the console",
  runtime_evaluate_many: "evaluating several expressions",
  network_get_requests: "reading network traffic",
  network_get_response_body: "reading a response body",
  network_wait_for_request: "waiting for a request",
  network_clear: "clearing network history",
  dom_query: "looking at the DOM",
  dom_get_html: "reading markup",
  dom_get_mutations: "checking what changed",
  dom_list_frames: "listing frames",
  dialog_detect: "looking for a dialog",
  source_search: "searching the source",
  source_get_script: "reading a script",
  source_list_scripts: "listing scripts",
  source_get_file: "reading a file",
  source_list_files: "listing files",
  debugger_set_breakpoint: "setting a breakpoint",
  debugger_set_breakpoint_at_function: "setting a breakpoint",
  debugger_remove_breakpoint: "removing a breakpoint",
  debugger_remove_all_breakpoints: "clearing breakpoints",
  debugger_pause: "pausing execution",
  debugger_resume: "resuming",
  debugger_step_over: "stepping over",
  debugger_step_into: "stepping into",
  debugger_step_out: "stepping out",
  debugger_get_scope: "reading the scope",
  debugger_evaluate_at_frame: "evaluating in the paused frame",
  app_discover: "working out what this app is",
  api_discover: "mapping the API",
  memory_record: "recording what worked",
  ui_click: "clicking",
  ui_hover: "hovering over",
  ui_fill: "filling",
  ui_type: "typing into",
  ui_select: "choosing",
  ui_check: "setting",
  ui_press: "pressing",
  ui_scroll: "scrolling",
  ui_drag: "dragging",
  ui_upload: "attaching a file to",
  ui_wait_for: "waiting for",
  ui_inspect: "looking at the controls",
};

/**
 * Which argument says most about this call, in the order worth trying.
 *
 * Ordering matters more than it looks: `ui_fill` carries both a selector and a value,
 * and "filling Reference" is a better thing to read on your own screen than
 * "filling ORD-4471" — the control is the context, the value is the detail.
 */
const SALIENT = [
  "text", "selector", "testid", "url", "url_filter", "option", "key",
  "query", "pattern", "expression", "file", "path", "goal", "detail",
  "function", "function_name", "breakpoint_id", "name",
];

const clean = v => String(v).replace(/\s+/g, " ").trim();

/** Generic phrasing: turn `source_get_file` into something readable. */
function generic(name) {
  const words = name.replace(/^(devtools|page|console|network|dom|source|debugger|session|memory|ui)_/, "").replace(/_/g, " ");
  return words || name.replace(/_/g, " ");
}

/**
 * The line to show for one tool call, or null if this call should stay quiet.
 * Pure, so it can be tested without a browser.
 */
export function phraseFor(name, args = {}) {
  if (!name || SILENT.has(name)) return null;

  const verb = VERBS[name] || generic(name);

  let subject = null;
  for (const key of SALIENT) {
    const v = args[key];
    if (v == null || v === "") continue;
    if (typeof v !== "string" && typeof v !== "number") continue;
    subject = clean(v);
    break;
  }

  // A URL is unreadable at full length and its tail is the informative part. The hash
  // has to survive: in a single-page app it *is* the route, so trimming to path+search
  // reduces every screen in the application to the same handful of characters.
  if (subject && /^https?:\/\//i.test(subject)) {
    try {
      const u = new URL(subject);
      subject = (u.pathname + u.search + u.hash) || u.host;
    } catch (_) { /* keep it as it is */ }
  }

  if (!subject) return verb;
  if (subject.length > 48) subject = subject.slice(0, 47) + "…";
  return `${verb} ${subject}`;
}

/**
 * Say what is about to happen.
 *
 * Deliberately not awaited by the caller: this is decoration, and a page whose main
 * thread is wedged — precisely when the user most needs to see something — must not
 * add its stall to every tool call. Failures are swallowed for the same reason.
 */
export function narrate(ctx, name, args) {
  if (!ctx?.cfg?.narrateTools) return null;
  const phrase = phraseFor(name, args);
  if (!phrase) return null;
  try { ctx.conn?.setBadge?.(phrase, "busy")?.catch?.(() => {}); } catch (_) {}
  return phrase;
}

/** And say when it did not work, which is the half a spinner never tells you. */
export function narrateFailure(ctx, name, err) {
  if (!ctx?.cfg?.narrateTools) return null;
  if (SILENT.has(name)) return null;
  const what = VERBS[name] || generic(name);
  const why = clean(err?.message || "failed").slice(0, 90);
  const phrase = `${what} — ${why}`;
  try { ctx.conn?.setBadge?.(phrase, "err")?.catch?.(() => {}); } catch (_) {}
  return phrase;
}
