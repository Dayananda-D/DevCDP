// ─── Session & manual fallback tools ─────────────────────────────────────────
// SESS-2 was the quiet one: notify_user was described as "Show status to user"
// and the model was told to call it before every action — but it wrote to
// process.stderr, i.e. the MCP server log. The user never saw a single one.
// It now drives the in-page badge, which the user is actually looking at.
//
// SESS-1: wait_for:'network_request' could never resolve, because network events
// never notified the waiter. The enum is now honest about what can be waited on,
// and every option is wired.
//
// The manual handover also stops guessing. v4 resolved on "any_action", which
// includes actions the automation driver itself performed — so it would report
// "the user acted" when nobody had. The badge now carries an explicit
// "I've done it" button, so a human confirmation is a real signal rather than an
// inference from mouse events we cannot attribute.

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";

const STATUS_KIND = {
  error: "err", waiting: "ask", done: null, found: null,
  breakpoint: "busy", debug: "busy", navigate: "busy", click: "busy",
  fill: "busy", network: "busy", dom: "busy", evaluate: "busy",
};

defineTool({
  name: "notify_user",
  destructive: false, openWorld: true,
  description:
    "Show a short status line to the human, in the badge on the page you are debugging. This is the only channel the "
    + "user actually sees — call it before a slow or surprising step so a frozen-looking app is explained. Keep it to "
    + "a few words.",
  args: {
    action: { type: "string", description: "What you are doing.", required: true,
      enum: ["navigate", "click", "fill", "debug", "network", "dom", "evaluate", "breakpoint", "found", "waiting", "done", "error"] },
    detail: { type: "string", description: "Short human-readable detail, e.g. 'checking the save handler'.", required: true },
  },
  async handler(args, ctx) {
    const text = `${args.action}: ${args.detail}`.slice(0, 120);
    const shown = await ctx.conn.setBadge(text, STATUS_KIND[args.action]);
    ctx.recordActivity("notify", { action: args.action, detail: args.detail });
    return {
      shown,
      text,
      ...(shown ? {} : { warning: "The badge is not available (agent not installed, or badge disabled in config), so the user did not see this." }),
    };
  },
});

defineTool({
  name: "session_start",
  destructive: false,
  description:
    "Open a debugging session with a goal and an ordered list of steps, so progress is tracked and a failed step can "
    + "fall back to asking the human. Use it for multi-step reproductions; a single-question investigation does not "
    + "need it.",
  args: {
    goal:  { type: "string", description: "What you are trying to find out or prove.", required: true },
    steps: { type: "array",  description: "Ordered steps, each { id, description, actor }. actor is 'agent', 'user' or 'either'.", required: true,
      items: { type: "object", required: ["id", "description"],
        properties: { id: { type: "string" }, description: { type: "string" },
                      actor: { type: "string", enum: ["agent", "user", "either"] } } } },
  },
  async handler(args, ctx) {
    if (!args.steps.length) fail(CODES.BAD_ARGS, "steps was empty.", "Provide at least one step.");
    const bad = args.steps.filter(s => !s?.id || !s?.description);
    if (bad.length) fail(CODES.BAD_ARGS, `${bad.length} step(s) are missing id or description.`, "Every step needs both.");

    ctx.session.active = true;
    ctx.session.goal = args.goal;
    ctx.session.steps = args.steps.map(s => ({ ...s, actor: s.actor || "either", status: "pending", result: null }));
    ctx.session.currentStepIdx = 0;
    ctx.session.pendingAsk = null;
    ctx.recordActivity("session_start", { goal: args.goal, stepCount: args.steps.length });
    ctx.conn.setBadge(`session: ${args.goal}`.slice(0, 90), null);

    const first = ctx.session.steps[0];
    return {
      started: true, goal: args.goal, totalSteps: ctx.session.steps.length,
      currentStep: { index: 0, ...first },
      instruction: first.actor === "user"
        ? "This step is for the human — call session_ask_user with a clear instruction."
        : "Find the code, arm a breakpoint with auto_resume, trigger it, then read debugger_get_capture.",
    };
  },
});

defineTool({
  name: "session_step_done",
  destructive: false,
  description: "Mark the current step complete with what you found, and advance. Returns the next step, or allDone when the plan is finished.",
  needsClient: false,
  args: { result: { type: "string", description: "What this step established — a real observed value, not a guess." } },
  async handler(args, ctx) {
    if (!ctx.session.active) fail(CODES.NO_SESSION, "No session is active.", "Call session_start first, or just proceed without a session.");
    const step = ctx.session.steps[ctx.session.currentStepIdx];
    if (!step) fail(CODES.NO_SESSION, "The session has no current step.", "Call session_get_status to inspect it, or session_end.");

    step.status = "done";
    step.result = args.result || "completed";
    ctx.recordActivity("step_done", { stepId: step.id, result: step.result });
    ctx.session.currentStepIdx++;

    const next = ctx.session.steps[ctx.session.currentStepIdx];
    if (!next) {
      ctx.session.active = false;
      return { stepDone: step.id, allDone: true, note: "Every step is complete. Summarise the root cause, then call devtools_disconnect." };
    }
    return {
      stepDone: step.id,
      nextStep: { index: ctx.session.currentStepIdx, ...next },
      instruction: next.actor === "user" ? "Human step — call session_ask_user." : "Agent step — breakpoint, trigger, capture.",
    };
  },
});

defineTool({
  name: "session_step_failed",
  destructive: false,
  description:
    "Report that you cannot complete the current step yourself. Checks memory for a known recovery first, then tells "
    + "you how to hand over to the human. Use it for anything automation genuinely cannot do — a login you have no "
    + "credentials for, a challenge, a physical device.",
  needsClient: false,
  args: { reason: { type: "string", description: "Why the step could not be completed.", required: true } },
  async handler(args, ctx) {
    if (!ctx.session.active) fail(CODES.NO_SESSION, "No session is active.", "Call session_start first.");
    // SESS-3 — v4 dereferenced this without a guard and threw a TypeError.
    const step = ctx.session.steps[ctx.session.currentStepIdx];
    if (!step) fail(CODES.NO_SESSION, "The session has no current step to fail.", "Call session_get_status, or session_end.");

    step.status = "blocked";
    step.result = args.reason;
    ctx.recordActivity("step_failed", { stepId: step.id, reason: args.reason });

    const known = ctx.memory.search(`${step.description} ${args.reason}`).slice(0, 3);

    return {
      stepId: step.id,
      reason: args.reason,
      knownRecoveries: known.map(e => ({ id: e.id, pattern: e.pattern, recovery: e.recovery })),
      instruction: known.length
        ? "A previous session hit something similar — try the pattern above before involving the human."
        : "No known recovery. Call session_ask_user with a specific instruction, then poll session_poll_user_action.",
      reminder: "After a human-assisted recovery, call memory_record so this step does not need them next time.",
    };
  },
});

defineTool({
  name: "session_ask_user",
  destructive: false, openWorld: true,
  description:
    "Ask the human to do something in the browser, and show the request in the on-page badge with a confirmation "
    + "button. Returns immediately — poll session_poll_user_action for the outcome. Also relay the instruction in your "
    + "reply, so it is visible whether or not they are looking at the browser window.",
  args: {
    instruction: { type: "string", description: "Exactly what the person should do, in one sentence.", required: true },
    wait_for:    { type: "string", description:
      "What counts as done. 'confirmation' — the on-page button — is the only unambiguous one.",
      enum: ["confirmation", "navigation", "click", "dialog", "any_action"], default: "confirmation" },
  },
  async handler(args, ctx) {
    ctx.session.pendingAsk = {
      instruction: args.instruction,
      waitFor: args.wait_for,
      captured: null,
      askedAt: new Date().toISOString(),
    };
    const shownInPage = await ctx.conn.askInPage(args.instruction);
    ctx.recordActivity("ask_user", { instruction: args.instruction, waitFor: args.wait_for });

    return {
      waiting: true,
      instruction: args.instruction,
      waitFor: args.wait_for,
      shownInPage,
      ...(shownInPage
        ? { note: "Shown in the page badge with an 'I've done it' button. Relay the instruction in your reply too, then poll session_poll_user_action." }
        : { warning: "Could not show this in the page, so the user will only see it if you relay it in your reply." }),
    };
  },
});

defineTool({
  name: "session_poll_user_action",
  readOnly: true,
  description:
    "Check whether the human has completed what session_ask_user requested. Returns acted:false while waiting. Poll "
    + "at a human pace — a few seconds apart — rather than in a tight loop.",
  needsClient: false,
  async handler(_args, ctx) {
    const ask = ctx.session.pendingAsk;
    if (!ask) {
      // The user may well have stepped in without being asked — to demonstrate a
      // reproduction, or to pick the right option. Report that rather than a flat
      // "nothing is pending", which used to hide their help completely.
      const recent = ctx.userActions.items.slice(-5);
      return {
        acted: false,
        waiting: false,
        userHasControl: ctx.session.userHasControl === true,
        recentUserActions: recent.length ? recent : undefined,
        note: recent.length
          ? `No handover is open, but ${recent.length} recent user action(s) were recorded — read them with session_get_user_actions.`
          : "Nothing is pending, and the user has not done anything. Call session_ask_user to request help.",
      };
    }

    if (!ask.captured) {
      const waitedMs = Date.now() - new Date(ask.askedAt).getTime();
      return {
        acted: false, waiting: true, waitedMs,
        instruction: ask.instruction,
        ...(waitedMs > 120000
          ? { hint: "Waiting over two minutes. Consider re-stating the request in your reply — the user may not have the browser in view." }
          : {}),
      };
    }

    const action = ask.captured;
    ctx.session.pendingAsk = null;
    ctx.recordActivity("user_acted", { action });

    return {
      acted: true,
      action,
      confirmedExplicitly: action.explicit === true,
      ...(action.explicit
        ? {}
        : { caution: "Inferred from a page event rather than an explicit confirmation. It could have been caused by automation — verify the app is in the state you expect before continuing." }),
      nextStep: "Read what changed: session_get_state, or debugger_get_capture if a breakpoint fired. Then memory_record the recovery.",
    };
  },
});

defineTool({
  name: "session_get_user_actions",
  readOnly: true,
  description:
    "What the human has done in the browser — clicks, typed values, chosen options, submissions — and the element each "
    + "one touched. Works whether or not you asked, so unprompted help is still readable. Pass the cursor back for only "
    + "what is new. Values are captured during a handover or takeover; sensitive fields stay redacted.",
  needsClient: false,
  args: {
    cursor: { type: "number", description: "Only actions newer than this seq. 0 for everything retained.", default: 0 },
    limit:  { type: "number", description: "Maximum actions to return.", default: 30, min: 1, max: 200 },
    kinds:  { type: "array",  description: "Restrict to these kinds, e.g. ['click','input_change','option_chosen'].", items: { type: "string" } },
  },
  async handler(args, ctx) {
    let items = ctx.userActions.since(args.cursor);
    if (args.kinds?.length) items = items.filter(a => args.kinds.includes(a.type));
    const matched = items.length;
    items = items.slice(-args.limit);

    const stats = ctx.userActions.stats();
    return {
      nextCursor: stats.cursor,
      count: items.length,
      matched,
      userHasControl: ctx.session.userHasControl === true,
      valuesBeingCaptured: !!(ctx.session.pendingAsk || ctx.session.userHasControl || ctx.cfg.captureInputValues),
      actions: items,
      ...(stats.dropped ? { evicted: stats.dropped } : {}),
      ...(!items.length && args.cursor === 0
        ? { note: "Nothing from the user yet. They can act any time, or press Ctrl+Shift+D to take control." }
        : {}),
      ...(items.length
        ? { caution: "Automation input is also reported as trusted, so these cannot be proven to be human." }
        : {}),
    };
  },
});

defineTool({
  name: "session_get_activity",
  readOnly: true,
  description:
    "Unified timeline of everything observed in this session — console output, requests, navigations, dialogs, clicks, "
    + "pauses and handovers, in order. Use it to reconstruct what happened when a step behaved unexpectedly.",
  needsClient: false,
  args: {
    types: { type: "array",  description: "Restrict to these activity types.", items: { type: "string" } },
    since: { type: "string", description: "ISO timestamp lower bound." },
    limit: { type: "number", description: "Maximum entries.", default: 30, min: 1, max: 500 },
  },
  async handler(args, ctx) {
    let items = ctx.activity.items;
    if (args.types?.length) items = items.filter(a => args.types.includes(a.type));
    if (args.since)         items = items.filter(a => a.ts >= args.since);
    const matched = items.length;
    // Full ISO timestamps are 24 characters each and mostly identical across a
    // burst; the time of day is what anyone reading a timeline actually uses.
    items = items.slice(-args.limit).map(a => {
      const { ts, ...rest } = a;
      return { t: String(ts).slice(11, 23), ...rest };
    });

    const counts = {};
    for (const a of ctx.activity.items) counts[a.type] = (counts[a.type] || 0) + 1;

    return { count: items.length, matched, activity: items, typeCounts: counts };
  },
});

defineTool({
  name: "session_get_status",
  readOnly: true,
  description: "Where the session plan stands: the goal, each step's status, which step is current, and whether a human handover is outstanding.",
  needsClient: false,
  async handler(_args, ctx) {
    const s = ctx.session;
    return {
      active: s.active,
      goal: s.goal,
      currentStepIndex: s.currentStepIdx,
      currentStep: s.steps[s.currentStepIdx] || null,
      steps: s.steps,
      summary: {
        total: s.steps.length,
        done: s.steps.filter(x => x.status === "done").length,
        blocked: s.steps.filter(x => x.status === "blocked").length,
        pending: s.steps.filter(x => x.status === "pending").length,
      },
      pendingUserAction: s.pendingAsk
        ? { instruction: s.pendingAsk.instruction, waitFor: s.pendingAsk.waitFor, askedAt: s.pendingAsk.askedAt }
        : null,
      collaboration: {
        userHasControl: s.userHasControl === true,
        userActionsRecorded: ctx.userActions.items.length,
        valuesBeingCaptured: !!(s.pendingAsk || s.userHasControl || ctx.cfg.captureInputValues),
        howTheUserTakesOver: "Ctrl+Shift+D in the debug tab, or just act — everything is recorded either way.",
      },
    };
  },
});

defineTool({
  name: "session_end",
  destructive: false, idempotent: true,
  description:
    "Close the session and return a summary. Does not detach — call devtools_disconnect to release the tab and clear "
    + "breakpoints when you are finished with the browser entirely.",
  needsClient: false,
  async handler(_args, ctx) {
    const s = ctx.session;
    const summary = {
      goal: s.goal,
      total: s.steps.length,
      done: s.steps.filter(x => x.status === "done").length,
      blocked: s.steps.filter(x => x.status === "blocked").length,
      pending: s.steps.filter(x => x.status === "pending").length,
      steps: s.steps.map(x => ({ id: x.id, status: x.status, result: x.result })),
    };
    s.active = false;
    s.pendingAsk = null;
    ctx.conn.clearAskInPage();
    ctx.conn.setBadge("session ended", null);
    return { ended: true, summary };
  },
});

defineTool({
  name: "session_get_state",
  readOnly: true,
  description:
    "One snapshot of console output, network requests and DOM mutations together, instead of three separate calls. "
    + "Pass the cursors back on the next call to get only what is new. This is the cheapest way to see the effect of "
    + "an action.",
  args: {
    log_cursor: { type: "number", description: "Only console entries newer than this seq.", default: 0 },
    log_limit:  { type: "number", description: "Maximum console entries.", default: 20, min: 1, max: 200 },
    net_limit:  { type: "number", description: "Maximum network requests.", default: 15, min: 1, max: 200 },
    net_filter: { type: "string", description: "Only requests whose URL contains this." },
    mut_limit:  { type: "number", description: "Maximum DOM mutation records.", default: 20, min: 1, max: 200 },
    errors_only:{ type: "boolean", description: "Restrict console to warnings and errors, and network to failures.", default: false },
  },
  async handler(args, ctx) {
    const buf = ctx.consoleBuf();
    let logs = buf.since(args.log_cursor).filter(l => l.source !== "devcdp-agent");
    if (args.errors_only) logs = logs.filter(l => l.level === "error" || l.level === "warn" || l.level === "warning");
    const logsShown = logs.slice(-args.log_limit);

    let reqs = ctx.network.all();
    if (args.net_filter)  reqs = reqs.filter(r => r.url.includes(args.net_filter));
    if (args.errors_only) reqs = reqs.filter(r => r.error || (r.status != null && r.status >= 400));
    const reqsShown = reqs.slice(-args.net_limit).map(r => ctx.conn.publicRequest(r));

    const muts = ctx.mutations.items.slice(-args.mut_limit);

    return {
      console:   { nextCursor: buf.seq, count: logsShown.length, matched: logs.length, items: logsShown },
      network:   { count: reqsShown.length, matched: reqs.length, items: reqsShown },
      mutations: { count: muts.length, items: muts },
      paused: ctx.pause.active,
      ...(ctx.pause.active ? { note: "Execution is paused — call debugger_get_capture for the values at the pause." } : {}),
    };
  },
});
