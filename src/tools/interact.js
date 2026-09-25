// ─── Interaction tools ───────────────────────────────────────────────────────
//
// Sixty tools could read the page and not one could touch it, so every session that
// needed to click something reached for a second automation server pointed at the same
// browser — which knew nothing about DevCDP's tab claims and walked straight into
// whichever tab happened to be active. The isolation work upstream cannot fix that,
// because the collision comes from the gap, not from the claims.
//
// Two things make these worth having beyond closing that gap:
//
//   Cost.  The usual MCP browser-automation shape is snapshot → ref → act: a full
//          accessibility tree serialised into the model's context before every single
//          action. On a real application screen that dwarfs the action itself. Here the
//          target is named directly — a selector, the visible text, a test id — over a
//          socket that is already open.
//
//   Consequence. Console, network and DOM mutations are already being recorded. So an
//          action can report what it *caused* in the same call: the request it fired,
//          the error it logged, whether the DOM moved at all. That collapses the
//          click → check console → check network sequence into one round trip, and it
//          is the difference between "clicked" and "clicked, and here is what happened".
//
// Input is dispatched through CDP's Input domain, so the events are trusted — real
// input as far as the page is concerned, not synthesised el.click() that half the
// frameworks treat differently. Every action goes through the actionability gate in
// src/browser/locate.js first; see the header there for why that is the hard part.

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";
import { qualifyExpression, withElementExpression } from "../browser/locate.js";

// ── target arguments, shared by every tool here ──────────────────────────────
// One vocabulary for "which element", so learning it once is enough.
const TARGET_ARGS = {
  selector: { type: "string", description: "CSS selector. Descends into open shadow roots." },
  text:     { type: "string", description: "Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input." },
  testid:   { type: "string", description: "Value of a test attribute (data-testid and friends — see the testAttributes setting)." },
  role:     { type: "string", description: "Narrow the matches to this ARIA role." },
  exact:    { type: "boolean", description: "Require the whole text to match rather than a substring.", default: false },
  nth:      { type: "number", description: "Which match to use when several qualify, 0-based.", default: 0, min: 0, max: 500 },
  frame:    { type: "string", description: "'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.", default: "main" },
  timeout_ms: { type: "number", description: "How long to wait for the element to become actionable before giving up.", default: 5000, min: 0, max: 60000 },
};

const targetOf = args => ({
  selector: args.selector, text: args.text, testid: args.testid,
  role: args.role, exact: args.exact,
});

function requireTarget(args) {
  if (!args.selector && !args.text && !args.testid) {
    fail(CODES.BAD_ARGS, "No target given — pass selector, text or testid.",
      "selector:'#save' for CSS, text:'Save' for what the user sees, testid:'save-btn' for a test attribute.");
  }
}

/** Execution context for the `frame` argument, mirroring dom_query's behaviour. */
function contextFor(ctx, frame) {
  if (!frame || frame === "main") return null;
  const all = [...ctx.contexts.values()].filter(c => c.isDefault);
  const hit = all.find(c => (c.origin || "").includes(frame) || (c.name || "").includes(frame));
  if (!hit) {
    fail(CODES.NO_TARGET, `No frame matches "${frame}".`,
      "Call dom_list_frames to see what is available.",
      { frames: all.map(c => ({ origin: c.origin, name: c.name })) });
  }
  return hit;
}

async function evalJson(ctx, expression, context, label) {
  const { result, exceptionDetails } = await ctx.conn.eval(expression, {
    contextId: context ? context.id : undefined,
    label: label || "interaction",
  });
  if (exceptionDetails) {
    fail(CODES.EVAL_FAILED,
      `The page threw while locating the element: ${exceptionDetails.exception?.description?.split("\n")[0] || exceptionDetails.text}`,
      "Usually an invalid selector. dom_query is a safe way to test one.");
  }
  try { return JSON.parse(result?.value || "{}"); } catch (_) { return {}; }
}

/**
 * Poll until the target is actionable, or explain precisely why it never was.
 *
 * Two samples must agree on the element's position before it is considered ready.
 * That is what makes this safe on animated UI: a dialog sliding in passes "visible"
 * and "hit-testable" while it is still moving, and a click aimed where it was one
 * frame ago lands on the page behind it.
 */
async function waitActionable(ctx, args, opts = {}) {
  requireTarget(args);
  const spec = { ...targetOf(args), testAttributes: ctx.cfg.testAttributes };
  const context = contextFor(ctx, args.frame);
  const expr = qualifyExpression(spec, { nth: args.nth, ...opts });

  const deadline = Date.now() + (args.timeout_ms ?? 5000);
  const requireStable = opts.requireStable !== false;

  let last = null, lastRect = null, stableFor = 0, polls = 0;

  for (;;) {
    const q = await evalJson(ctx, expr, context, "actionability check");
    polls++;
    last = q;

    if (q.selectorError) {
      fail(CODES.BAD_ARGS, `That is not a valid selector: ${q.selectorError}`,
        "These tools take CSS, not XPath. Use text: to match on what is written on the control instead.");
    }

    if (q.ready) {
      const here = q.rect ? `${q.rect.x},${q.rect.y},${q.rect.w},${q.rect.h}` : "?";
      if (!requireStable || (lastRect === here && stableFor >= 1)) {
        return { ...q, polls, context, waitedMs: Math.max(0, (args.timeout_ms ?? 5000) - (deadline - Date.now())) };
      }
      if (lastRect === here) stableFor++; else { stableFor = 0; lastRect = here; }
    } else {
      stableFor = 0; lastRect = null;
    }

    if (Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, 60));
  }

  // Everything below is a failure report. The point of it is that "could not click"
  // is useless on its own — each of these causes has a different fix, and the caller
  // cannot see the screen.
  if (!last || last.found === 0) {
    fail(CODES.NO_TARGET,
      `Nothing matches ${describeTarget(args)}${args.frame && args.frame !== "main" ? ` in frame "${args.frame}"` : ""}.`,
      "dom_query confirms what is on the page; app_discover lists selectors taken from the live screen. "
      + "If the screen renders in an iframe, pass frame:.",
      last?.error ? { pageError: last.error } : undefined);
  }
  if (last.indexOutOfRange) {
    fail(CODES.BAD_ARGS, `nth:${args.nth} is out of range — ${last.found} element(s) matched.`,
      "Use a lower nth, or narrow the target.", { candidates: last.candidates });
  }

  const why = {
    hidden:   ["The element exists but is not rendered.", "It may be behind a collapsed panel or an inactive tab. Check with dom_query(visible_only:false)."],
    disabled: ["The control is disabled, so input would be ignored.", "Wait for whatever enables it — ui_wait_for(state:'enabled') does exactly that — or fix the state that keeps it disabled."],
    covered:  ["Something is on top of it at every point we would click.", "Usually a modal, a sticky header or a loading overlay. dialog_detect finds modals; the blocker is named below."],
    offscreen:["It stayed outside the viewport even after scrolling to it.", "Common in virtualised lists: scroll its container with ui_scroll first."],
    detached: ["The element left the DOM while we were waiting.", "The screen re-rendered. Locate it again after the render settles."],
  }[last.why] || ["It never became actionable.", "Raise timeout_ms, or check the screen state with dom_query."];

  fail(CODES.TIMEOUT,
    `${describeTarget(args)} was found but never became actionable within ${args.timeout_ms}ms — ${why[0]}`,
    why[1],
    {
      reason: last.why, matched: last.found, element: last.node, at: last.rect,
      ...(last.blockedBy ? { blockedBy: last.blockedBy } : {}),
      ...(last.candidates ? { candidates: last.candidates } : {}),
      polls,
    });
}

const describeTarget = args =>
  args.selector ? `selector "${args.selector}"`
  : args.text   ? `text "${args.text}"`
  : args.testid ? `testid "${args.testid}"`
  : "the target";

// ── consequences ─────────────────────────────────────────────────────────────
// The buffers are already running, so what an action caused costs nothing extra to
// report — only the discipline of taking a mark before and reading after.

function markBefore(ctx) {
  return {
    console: ctx.consoleBuf().stats().cursor,
    mutations: ctx.mutations.stats().cursor,
    requestIds: new Set(ctx.network.all().map(r => r.requestId)),
  };
}

/**
 * What changed. Deliberately a summary, not a dump — the full detail is one call away
 * in console_get_logs / network_get_requests, and pasting it into every action response
 * would cost more context than the snapshot approach this exists to avoid.
 */
export async function consequenceOf(ctx, before, settleMs = 220, quietMs = 50) {
  // Most UI actions finish synchronously. Waiting the full settle window made
  // every click pay 220ms, even when there was nothing left to observe. Return
  // after a short quiet period, but keep the old maximum so delayed requests and
  // renders remain observable. Any new buffer entry resets the quiet timer.
  const started = Date.now();
  let quietSince = started;
  const signature = () => [
    ctx.consoleBuf().stats().cursor,
    ctx.mutations.stats().cursor,
    ctx.network.all().length,
  ].join(":");
  let last = signature();
  while (Date.now() - started < settleMs) {
    await new Promise(r => setTimeout(r, Math.min(20, Math.max(1, quietMs))));
    const current = signature();
    if (current !== last) {
      last = current;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= quietMs) {
      break;
    }
  }
  const logs = ctx.consoleBuf().since(before.console);
  const errors = logs.filter(l => l.level === "error");
  const mutations = ctx.mutations.since(before.mutations);
  const fresh = ctx.network.all().filter(r => !before.requestIds.has(r.requestId));
  const failed = fresh.filter(r => r.error || (r.status != null && r.status >= 400));

  const out = {};
  if (fresh.length) {
    out.requests = fresh.slice(0, 6).map(r => ({
      method: r.method, url: String(r.url).slice(0, 120),
      status: r.status ?? (r.error ? `failed: ${r.error}` : "pending"),
    }));
    if (fresh.length > 6) out.moreRequests = fresh.length - 6;
  }
  if (errors.length) {
    out.consoleErrors = errors.slice(0, 3).map(e => String(e.text || "").slice(0, 200));
    if (errors.length > 3) out.moreConsoleErrors = errors.length - 3;
  }
  if (logs.length && !errors.length) out.consoleMessages = logs.length;
  out.domChanged = mutations.length > 0;
  if (mutations.length) out.domMutations = mutations.length;

  // The most useful single sentence a failed interaction can produce.
  if (!fresh.length && !logs.length && !mutations.length) {
    out.nothingHappened = true;
    out.note = "The page did not change, log anything, or make a request. The event was delivered — "
             + "the application simply did not react to it. Check that the control is the one that does the work, "
             + "or that a handler is attached (dom_query with include_attrs shows onclick).";
  } else if (failed.length) {
    out.note = `${failed.length} request(s) failed — see network_get_requests.`;
  }
  return out;
}

/** Draw the pointer where we acted, so a human watching can follow along. */
async function showPointer(ctx, x, y, label) {
  if (!ctx.cfg.showCursor) return;
  try {
    await ctx.conn.evalQuiet(
      `window.__devcdp && window.__devcdp.pointAt(${Math.round(x)}, ${Math.round(y)}, ${JSON.stringify(String(label || "").slice(0, 60))})`,
      1500);
  } catch (_) {}
}

// ── mouse ────────────────────────────────────────────────────────────────────

const BUTTONS = { left: 1, middle: 4, right: 2 };
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };
const modifierMask = list => (list || []).reduce((m, k) => m | (MODIFIER_BITS[String(k).toLowerCase()] || 0), 0);

async function mouseSequence(ctx, { x, y, button = "left", clickCount = 1, modifiers = 0 }) {
  const Input = ctx.conn.client.Input;
  const common = { x: Math.round(x), y: Math.round(y), button, modifiers, buttons: BUTTONS[button] || 1 };

  // A move first, always. Menus, tooltips and grids that open on hover need the
  // pointer to have arrived before the press, and without it a click on a hover-only
  // menu item hits whatever was there before the menu opened.
  await Input.dispatchMouseEvent({ type: "mouseMoved", x: common.x, y: common.y, modifiers, buttons: 0 });
  for (let i = 1; i <= clickCount; i++) {
    await Input.dispatchMouseEvent({ ...common, type: "mousePressed", clickCount: i });
    await Input.dispatchMouseEvent({ ...common, type: "mouseReleased", clickCount: i, buttons: 0 });
  }
}

defineTool({
  name: "ui_click",
  description:
    "Click an element, identified by CSS selector, visible text or test id. Waits until it is actually clickable — "
    + "rendered, enabled, stopped moving, and not covered by anything — then dispatches real (trusted) mouse events, "
    + "and reports what the click caused: requests fired, console errors, whether the DOM changed at all. "
    + "If it never became clickable it says which of those conditions failed and what was in the way.",
  args: {
    ...TARGET_ARGS,
    button: { type: "string", description: "Which mouse button.", enum: ["left", "right", "middle"], default: "left" },
    click_count: { type: "number", description: "2 for a double-click.", default: 1, min: 1, max: 3 },
    modifiers: { type: "array", description: "Held while clicking: shift, ctrl, alt, meta.", items: { type: "string" } },
    force: { type: "boolean", description: "Skip the hit-test and click the centre regardless of what is on top. A last resort — it is how you click the wrong thing.", default: false },
  },
  async handler(args, ctx) {
    const q = await waitActionable(ctx, args, { hitTest: !args.force });
    const before = markBefore(ctx);

    await showPointer(ctx, q.x, q.y, q.node?.text || q.node?.tag);
    await mouseSequence(ctx, {
      x: q.x, y: q.y, button: args.button,
      clickCount: args.click_count, modifiers: modifierMask(args.modifiers),
    });
    ctx.conn.setBadge(`clicked ${q.node?.text || q.path || "element"}`.slice(0, 70), "busy");
    ctx.recordActivity("interaction", { action: "click", target: describeTarget(args), element: q.node });

    return {
      clicked: q.node,
      at: { x: Math.round(q.x), y: Math.round(q.y) },
      path: q.path,
      ...(q.found > 1 ? { matched: q.found, note: `${q.found} elements matched; used nth:${args.nth}.`, candidates: q.candidates } : {}),
      ...(q.aimedAt === "offset" ? { note: "The centre was covered, so an offset point inside the element was used." } : {}),
      ...(args.force ? { forced: true, warning: "Hit-testing was skipped — this may have clicked something on top of the target." } : {}),
      caused: await consequenceOf(ctx, before),
    };
  },
});

defineTool({
  name: "ui_hover",
  destructive: false,
  description:
    "Move the pointer over an element and leave it there. Use before clicking anything that only appears on hover — "
    + "dropdown menus, row action buttons, tooltips — because those elements do not exist to click until something "
    + "is hovering over their parent.",
  args: { ...TARGET_ARGS },
  async handler(args, ctx) {
    const q = await waitActionable(ctx, args);
    const before = markBefore(ctx);
    await showPointer(ctx, q.x, q.y, q.node?.text || q.node?.tag);
    await ctx.conn.client.Input.dispatchMouseEvent({
      type: "mouseMoved", x: Math.round(q.x), y: Math.round(q.y), buttons: 0,
    });
    ctx.recordActivity("interaction", { action: "hover", element: q.node });
    return { hovering: q.node, at: { x: Math.round(q.x), y: Math.round(q.y) }, caused: await consequenceOf(ctx, before, 300) };
  },
});

defineTool({
  name: "ui_drag",
  description:
    "Drag one element onto another — reordering rows, moving a card between columns, resizing a split. Dispatches a "
    + "real press, several intermediate moves and a release, because drag implementations almost always ignore a "
    + "press followed immediately by a release somewhere else.",
  args: {
    selector: { type: "string", description: "CSS selector for what to drag." },
    text:     { type: "string", description: "Visible text of what to drag." },
    testid:   { type: "string", description: "Test id of what to drag." },
    to_selector: { type: "string", description: "CSS selector for where to drop it." },
    to_text:     { type: "string", description: "Visible text of where to drop it." },
    to_testid:   { type: "string", description: "Test id of where to drop it." },
    steps:    { type: "number", description: "Intermediate move events. More is slower but survives pickier drag handlers.", default: 10, min: 2, max: 60 },
    frame:    { type: "string", description: "'main' (default) or a substring of a frame's origin/name.", default: "main" },
    timeout_ms: { type: "number", description: "How long to wait for either element to become actionable.", default: 5000, min: 0, max: 60000 },
  },
  async handler(args, ctx) {
    if (!args.to_selector && !args.to_text && !args.to_testid) {
      fail(CODES.BAD_ARGS, "No drop target given.", "Pass to_selector, to_text or to_testid.");
    }
    const from = await waitActionable(ctx, args);
    const to = await waitActionable(ctx, {
      selector: args.to_selector, text: args.to_text, testid: args.to_testid,
      nth: 0, frame: args.frame, timeout_ms: args.timeout_ms,
    });

    const before = markBefore(ctx);
    const Input = ctx.conn.client.Input;
    const round = n => Math.round(n);

    await Input.dispatchMouseEvent({ type: "mouseMoved", x: round(from.x), y: round(from.y), buttons: 0 });
    await Input.dispatchMouseEvent({ type: "mousePressed", x: round(from.x), y: round(from.y), button: "left", buttons: 1, clickCount: 1 });

    for (let i = 1; i <= args.steps; i++) {
      const t = i / args.steps;
      await Input.dispatchMouseEvent({
        type: "mouseMoved", button: "left", buttons: 1,
        x: round(from.x + (to.x - from.x) * t),
        y: round(from.y + (to.y - from.y) * t),
      });
    }
    await Input.dispatchMouseEvent({ type: "mouseReleased", x: round(to.x), y: round(to.y), button: "left", buttons: 0, clickCount: 1 });

    ctx.conn.setBadge("dragged", "busy");
    ctx.recordActivity("interaction", { action: "drag", from: from.node, to: to.node });
    return { dragged: from.node, onto: to.node, steps: args.steps, caused: await consequenceOf(ctx, before, 300) };
  },
});

defineTool({
  name: "ui_scroll",
  destructive: false,
  description:
    "Scroll the page, or scroll a specific container. Needed before interacting with anything in a virtualised list "
    + "or grid, where rows outside the viewport do not exist in the DOM at all — scrolling is what creates them.",
  args: {
    selector: { type: "string", description: "CSS selector of the container to scroll. Omit to scroll the page." },
    text:     { type: "string", description: "Visible text inside the container to scroll." },
    testid:   { type: "string", description: "Test id of the container to scroll." },
    dx:       { type: "number", description: "Horizontal pixels; positive is right.", default: 0, min: -20000, max: 20000 },
    dy:       { type: "number", description: "Vertical pixels; positive is down.", default: 400, min: -20000, max: 20000 },
    to:       { type: "string", description: "Jump instead of scrolling by an amount.", enum: ["top", "bottom", "none"], default: "none" },
    frame:    { type: "string", description: "'main' (default) or a substring of a frame's origin/name.", default: "main" },
    timeout_ms: { type: "number", description: "How long to wait for the container.", default: 5000, min: 0, max: 60000 },
  },
  async handler(args, ctx) {
    const context = contextFor(ctx, args.frame);
    const before = markBefore(ctx);
    const hasTarget = !!(args.selector || args.text || args.testid);

    let result;
    if (hasTarget) {
      const expr = withElementExpression(
        { ...targetOf(args), testAttributes: ctx.cfg.testAttributes }, { nth: 0 },
        `var to=${JSON.stringify(args.to)};
         if (to==='top') el.scrollTop = 0;
         else if (to==='bottom') el.scrollTop = el.scrollHeight;
         else { el.scrollTop += ${args.dy}; el.scrollLeft += ${args.dx}; }
         return { scrollTop: Math.round(el.scrollTop), scrollHeight: Math.round(el.scrollHeight),
                  clientHeight: Math.round(el.clientHeight),
                  atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 };`);
      result = await evalJson(ctx, expr, context, "scroll container");
      if (!result.found) {
        fail(CODES.NO_TARGET, `Nothing matches ${describeTarget(args)} to scroll.`,
          "dom_query confirms what is on the page.");
      }
    } else {
      const expr = `(function(){
        var to=${JSON.stringify(args.to)};
        if (to==='top') window.scrollTo(0,0);
        else if (to==='bottom') window.scrollTo(0, document.body.scrollHeight);
        else window.scrollBy(${args.dx}, ${args.dy});
        return JSON.stringify({ scrollTop: Math.round(window.scrollY), scrollHeight: Math.round(document.body.scrollHeight),
          clientHeight: Math.round(window.innerHeight),
          atBottom: window.scrollY + window.innerHeight >= document.body.scrollHeight - 2 });
      })()`;
      result = await evalJson(ctx, expr, context, "scroll page");
    }

    ctx.recordActivity("interaction", { action: "scroll", target: hasTarget ? describeTarget(args) : "page" });
    return {
      scrolled: hasTarget ? result.node : "page",
      position: { top: result.scrollTop, of: result.scrollHeight, viewport: result.clientHeight },
      atBottom: result.atBottom,
      caused: await consequenceOf(ctx, before, 250),
    };
  },
});

// ── keyboard and text ────────────────────────────────────────────────────────

// CDP wants both a key name and the numeric codes for anything the page might read.
const KEYS = {
  Enter:      { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  Tab:        { key: "Tab", code: "Tab", keyCode: 9 },
  Escape:     { key: "Escape", code: "Escape", keyCode: 27 },
  Backspace:  { key: "Backspace", code: "Backspace", keyCode: 8 },
  Delete:     { key: "Delete", code: "Delete", keyCode: 46 },
  ArrowUp:    { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  ArrowDown:  { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  ArrowLeft:  { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Home:       { key: "Home", code: "Home", keyCode: 36 },
  End:        { key: "End", code: "End", keyCode: 35 },
  PageUp:     { key: "PageUp", code: "PageUp", keyCode: 33 },
  PageDown:   { key: "PageDown", code: "PageDown", keyCode: 34 },
  Space:      { key: " ", code: "Space", keyCode: 32, text: " " },
};

async function pressKey(ctx, name, keycode, key, code, modifiers = 0) {
  const named = name ? KEYS[name] : null;
  if (!named && keycode == null) {
    fail(CODES.BAD_ARGS, "Provide either key or keycode.", `Named keys: ${Object.keys(KEYS).join(", ")}. For characters, use ui_type.`);
  }
  if (keycode != null && (!Number.isInteger(keycode) || keycode < 0 || keycode > 65535)) {
    fail(CODES.BAD_ARGS, `Invalid keycode ${keycode}.`, "keycode must be an integer from 0 through 65535.");
  }
  if (named && keycode != null && keycode !== named.keyCode) {
    fail(CODES.BAD_ARGS, `key and keycode disagree (${name} is ${named.keyCode}, got ${keycode}).`, "Use the matching numeric keycode or omit keycode.");
  }
  const spec = named || { key: key || "Unidentified", code: code || "", keyCode: keycode };
  const Input = ctx.conn.client.Input;
  const base = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.keyCode, nativeVirtualKeyCode: spec.keyCode, modifiers };
  // rawKeyDown rather than keyDown when there is no text: keyDown with no text is
  // what makes some frameworks miss the event entirely.
  await Input.dispatchKeyEvent({ ...base, type: spec.text ? "keyDown" : "rawKeyDown", ...(spec.text && !modifiers ? { text: spec.text } : {}) });
  await Input.dispatchKeyEvent({ ...base, type: "keyUp" });
}

defineTool({
  name: "ui_press",
  description:
    "Press a named key or an arbitrary numeric keycode — Enter to submit, Tab to move on, Escape to dismiss, arrows to move through a list or grid. "
    + "Optionally focuses an element first. This is the tool for keyboard-driven screens, where clicking the control "
    + "is not how the application expects to be used.",
  args: {
    key: { type: "string", description: `Named key: ${Object.keys(KEYS).join(", ")}. Optional when keycode is supplied.` },
    keycode: { type: "number", description: "Numeric Windows/DOM virtual-key code, 0–65535. Optional when key is supplied.", min: 0, max: 65535 },
    code: { type: "string", description: "Optional KeyboardEvent.code metadata for numeric keycode input, e.g. KeyA or F13." },
    ...Object.fromEntries(Object.entries(TARGET_ARGS).map(([k, v]) =>
      [k, k === "selector" || k === "text" || k === "testid"
        ? { ...v, description: v.description + " Optional: focuses this element first." }
        : v])),
    modifiers: { type: "array", description: "Held while pressing: shift, ctrl, alt, meta.", items: { type: "string" } },
    times: { type: "number", description: "Press it this many times.", default: 1, min: 1, max: 50 },
  },
  async handler(args, ctx) {
    let focused = null;
    if (args.selector || args.text || args.testid) {
      const q = await waitActionable(ctx, args, { hitTest: false });
      await ctx.conn.eval(
        withElementExpression({ ...targetOf(args), testAttributes: ctx.cfg.testAttributes }, { nth: args.nth },
          `try { el.focus(); } catch(_) {} return { focused: true };`),
        { contextId: contextFor(ctx, args.frame)?.id, label: "focus before key" });
      focused = q.node;
    }

    const before = markBefore(ctx);
    const mods = modifierMask(args.modifiers);
    for (let i = 0; i < args.times; i++) await pressKey(ctx, args.key, args.keycode, args.key, args.code, mods);

    const pressed = args.key || `keycode:${args.keycode}`;
    ctx.conn.setBadge(`pressed ${pressed}${args.times > 1 ? ` ×${args.times}` : ""}`, "busy");
    ctx.recordActivity("interaction", { action: "key", key: pressed, keycode: args.keycode, times: args.times });
    return {
      pressed, ...(args.keycode != null ? { keycode: args.keycode } : {}), times: args.times,
      ...(focused ? { focused } : {}),
      caused: await consequenceOf(ctx, before),
    };
  },
});

/**
 * Set a field's value so the application's change detection actually sees it.
 *
 * Assigning `el.value` directly is invisible to React and to anything else that
 * tracks the native setter — the DOM updates, the framework's state does not, and the
 * form submits the old value. The native setter has to be called explicitly, and the
 * events have to be dispatched by hand afterwards.
 */
const SET_VALUE_BODY = `
  var value = %VALUE%;
  var tag = el.tagName.toLowerCase();
  if (el.isContentEditable) {
    el.focus();
    el.textContent = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }));
    return { set: true, kind: 'contenteditable' };
  }
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
    return { set: false, kind: tag, notEditable: true };
  }
  var proto = tag === 'textarea' ? HTMLTextAreaElement.prototype
            : tag === 'select'   ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype;
  var setter = Object.getOwnPropertyDescriptor(proto, 'value');
  el.focus();
  if (setter && setter.set) setter.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { set: true, kind: tag, value: String(el.value).slice(0, 120) };
`;

defineTool({
  name: "ui_fill",
  description:
    "Set the value of a text field, textarea or contenteditable in one step: assign it and fire input and change. Fast, "
    + "and it does NOT go through the browser's key-event pipeline — no keydown, no keypress — so the field's own input "
    + "rules never run. maxlength, digits-only keypress guards and input masks are all bypassed, which is exactly what "
    + "you want to put a value past a mask and test what happens downstream, and exactly what you do not want when "
    + "reproducing what a user did: it can leave the field in a state the UI itself would not allow. Use ui_type for "
    + "that, and for anything reacting per keystroke such as a typeahead.",
  args: {
    ...TARGET_ARGS,
    value: { type: "string", description: "The text to put in the field. Pass an empty string to clear it.", required: true },
    submit: { type: "boolean", description: "Press Enter afterwards.", default: false },
  },
  async handler(args, ctx) {
    const q = await waitActionable(ctx, args, { hitTest: false });
    const before = markBefore(ctx);
    const context = contextFor(ctx, args.frame);

    const res = await evalJson(ctx,
      withElementExpression({ ...targetOf(args), testAttributes: ctx.cfg.testAttributes }, { nth: args.nth },
        SET_VALUE_BODY.replace("%VALUE%", JSON.stringify(args.value))),
      context, "fill field");

    if (res.notEditable) {
      fail(CODES.BAD_ARGS,
        `That element is a <${res.kind}>, which has no value to set.`,
        "Target the input itself. text: follows a <label> to its control automatically; dom_query shows what is there.",
        { element: res.node });
    }

    if (args.submit) await pressKey(ctx, "Enter");

    ctx.conn.setBadge(`filled ${q.node?.text || q.path || "field"}`.slice(0, 70), "busy");
    ctx.recordActivity("interaction", { action: "fill", element: q.node, chars: args.value.length });
    return {
      filled: res.node || q.node,
      kind: res.kind,
      value: res.value,
      submitted: args.submit || undefined,
      caused: await consequenceOf(ctx, before),
    };
  },
});

defineTool({
  name: "ui_type",
  description:
    "Type into a field one character at a time with real key events, through the same input pipeline a person's "
    + "keyboard uses — so the field's own rules apply: maxlength truncates, a keypress guard rejects what it rejects, "
    + "and a mask reformats as it goes. This is the tool for reproducing user behaviour, and for anything reacting per "
    + "keystroke: search-as-you-type, autocomplete, validation-on-key. Slower than ui_fill by design. Note that typing "
    + "leaves the field focused and `change` fires on blur, so pass submit:true (or press Tab) when the application "
    + "validates on change.",
  args: {
    ...TARGET_ARGS,
    text_to_type: { type: "string", description: "Characters to type.", required: true },
    clear_first: { type: "boolean", description: "Select all and delete before typing.", default: true },
    delay_ms: { type: "number", description: "Pause between keystrokes. Raise it if the field drops characters.", default: 12, min: 0, max: 500 },
    submit: { type: "boolean", description: "Press Enter afterwards.", default: false },
  },
  async handler(args, ctx) {
    const q = await waitActionable(ctx, args, { hitTest: false });
    const before = markBefore(ctx);
    const Input = ctx.conn.client.Input;

    await ctx.conn.eval(
      withElementExpression({ ...targetOf(args), testAttributes: ctx.cfg.testAttributes }, { nth: args.nth },
        `try { el.focus(); if (el.select) el.select(); } catch(_) {} return { focused: true };`),
      { contextId: contextFor(ctx, args.frame)?.id, label: "focus before typing" });

    if (args.clear_first) {
      // Select-all then Delete, rather than assigning '' — the same reason ui_fill
      // calls the native setter: the application has to observe the change.
      await Input.dispatchKeyEvent({ type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await Input.dispatchKeyEvent({ type: "keyUp",   key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
      await pressKey(ctx, "Delete");
    }

    for (const ch of args.text_to_type) {
      await Input.dispatchKeyEvent({ type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
      await Input.dispatchKeyEvent({ type: "keyUp", key: ch });
      if (args.delay_ms) await new Promise(r => setTimeout(r, args.delay_ms));
    }

    if (args.submit) await pressKey(ctx, "Enter");

    ctx.conn.setBadge(`typed ${args.text_to_type.length} chars`, "busy");
    ctx.recordActivity("interaction", { action: "type", element: q.node, chars: args.text_to_type.length });
    return {
      typedInto: q.node,
      characters: args.text_to_type.length,
      submitted: args.submit || undefined,
      caused: await consequenceOf(ctx, before, 320),
    };
  },
});

defineTool({
  name: "ui_select",
  description:
    "Choose an option in a dropdown, by visible label or by value. Handles a native <select> directly; for the custom "
    + "dropdowns most applications actually use — a div that opens a list — it opens the control and clicks the "
    + "matching option. Reports the options it could see when nothing matches, which is usually the whole answer.",
  args: {
    ...TARGET_ARGS,
    option: { type: "string", description: "The option's visible label, or its value attribute.", required: true },
    by: { type: "string", description: "Match the label, the value, or either.", enum: ["label", "value", "either"], default: "either" },
  },
  async handler(args, ctx) {
    const q = await waitActionable(ctx, args, { hitTest: false });
    const before = markBefore(ctx);
    const context = contextFor(ctx, args.frame);

    // ── native <select>: set it properly, no clicking needed ──
    const native = await evalJson(ctx,
      withElementExpression({ ...targetOf(args), testAttributes: ctx.cfg.testAttributes }, { nth: args.nth },
        `if (el.tagName.toLowerCase() !== 'select') return { native: false };
         var want = ${JSON.stringify(args.option)}, by = ${JSON.stringify(args.by)};
         var opts = Array.prototype.slice.call(el.options).map(function(o, i) {
           return { i: i, label: (o.textContent||'').trim(), value: o.value };
         });
         var hit = null;
         for (var i = 0; i < opts.length; i++) {
           var o = opts[i];
           var okL = (by === 'label' || by === 'either') && o.label === want;
           var okV = (by === 'value' || by === 'either') && o.value === want;
           if (okL || okV) { hit = o; break; }
         }
         if (!hit) return { native: true, matched: false, options: opts.slice(0, 40).map(function(o){return o.label + ' [' + o.value + ']';}) };
         el.selectedIndex = hit.i;
         el.dispatchEvent(new Event('input',  { bubbles: true }));
         el.dispatchEvent(new Event('change', { bubbles: true }));
         return { native: true, matched: true, selected: hit.label, value: hit.value };`),
      context, "native select");

    if (native.native && native.matched) {
      ctx.conn.setBadge(`selected ${native.selected}`.slice(0, 70), "busy");
      ctx.recordActivity("interaction", { action: "select", element: q.node, option: native.selected });
      return { selected: native.selected, value: native.value, kind: "native", caused: await consequenceOf(ctx, before) };
    }
    if (native.native && !native.matched) {
      fail(CODES.NO_TARGET,
        `No option matching "${args.option}" in that <select>.`,
        "The options actually present are listed below — match one of those, or pass by:'value'.",
        { options: native.options });
    }

    // ── custom dropdown: open it, then click the option ──
    // Two steps rather than one because the option does not exist in the DOM until
    // the control is opened, so it cannot be located first.
    await mouseSequence(ctx, { x: q.x, y: q.y });
    await new Promise(r => setTimeout(r, 220));

    let option;
    try {
      option = await waitActionable(ctx, {
        text: args.option, exact: false, nth: 0,
        frame: args.frame, timeout_ms: Math.min(args.timeout_ms, 4000),
      });
    } catch (e) {
      // Say what did appear. A dropdown whose options are worded differently is the
      // common case, and a bare "not found" sends the reader looking for a bug instead.
      const visible = await evalJson(ctx, `(function(){
        var out = [];
        var nodes = document.querySelectorAll('[role=option],[role=menuitem],li,[class*=option i],[class*=item i]');
        for (var i = 0; i < nodes.length && out.length < 30; i++) {
          var el = nodes[i];
          if (el.closest('[data-devcdp]')) continue;
          var r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;
          var t = (el.textContent||'').trim().replace(/\\s+/g,' ');
          if (t && out.indexOf(t) === -1) out.push(t.slice(0, 60));
        }
        return JSON.stringify({ options: out });
      })()`, context, "dropdown options");

      fail(CODES.NO_TARGET,
        `Opened the control but found no option matching "${args.option}".`,
        visible.options?.length
          ? "These options are on screen now — match one of them exactly, or click it with ui_click."
          : "Nothing that looks like an option list appeared. The control may not have opened; try ui_click on it first, then dom_query to see what rendered.",
        { optionsOnScreen: visible.options || [], underlying: e.details });
    }

    await showPointer(ctx, option.x, option.y, args.option);
    await mouseSequence(ctx, { x: option.x, y: option.y });

    ctx.conn.setBadge(`selected ${args.option}`.slice(0, 70), "busy");
    ctx.recordActivity("interaction", { action: "select", element: q.node, option: args.option });
    return {
      selected: args.option,
      kind: "custom-dropdown",
      control: q.node,
      option: option.node,
      caused: await consequenceOf(ctx, before, 300),
    };
  },
});

defineTool({
  name: "ui_check",
  description:
    "Set a checkbox or radio to a specific state, rather than toggling it blindly. Reads the current state first and "
    + "clicks only if it differs, so calling it twice does not undo the first call — the usual way a 'toggle' helper "
    + "leaves a form in the wrong state.",
  args: {
    ...TARGET_ARGS,
    checked: { type: "boolean", description: "The state you want.", default: true },
  },
  async handler(args, ctx) {
    const q = await waitActionable(ctx, args);
    const context = contextFor(ctx, args.frame);

    const state = await evalJson(ctx,
      withElementExpression({ ...targetOf(args), testAttributes: ctx.cfg.testAttributes }, { nth: args.nth },
        `var aria = el.getAttribute('aria-checked');
         var checked = el.checked === true || aria === 'true';
         return { checked: checked, kind: (el.type || el.getAttribute('role') || el.tagName).toLowerCase() };`),
      context, "read checkbox state");

    if (state.checked === args.checked) {
      return { alreadyChecked: args.checked, element: state.node, kind: state.kind, clicked: false,
               note: "Already in the requested state, so nothing was clicked." };
    }

    const before = markBefore(ctx);
    await showPointer(ctx, q.x, q.y, q.node?.text || "checkbox");
    await mouseSequence(ctx, { x: q.x, y: q.y });

    const after = await evalJson(ctx,
      withElementExpression({ ...targetOf(args), testAttributes: ctx.cfg.testAttributes }, { nth: args.nth },
        `var aria = el.getAttribute('aria-checked');
         return { checked: el.checked === true || aria === 'true' };`),
      context, "verify checkbox state");

    ctx.recordActivity("interaction", { action: "check", element: q.node, to: args.checked });
    return {
      element: q.node, kind: state.kind, clicked: true,
      wanted: args.checked, nowChecked: after.checked,
      ...(after.checked !== args.checked
        ? { warning: "The click landed but the control did not change state — it may be controlled by application logic that rejected it." }
        : {}),
      caused: await consequenceOf(ctx, before),
    };
  },
});

defineTool({
  name: "ui_upload",
  description:
    "Attach one or more local files to a file input, without opening the operating system's file picker — which "
    + "automation cannot drive at all. Give the absolute paths of files on the machine running Chrome.",
  args: {
    ...TARGET_ARGS,
    files: { type: "array", description: "Absolute paths to the files to attach.", items: { type: "string" }, required: true },
  },
  async handler(args, ctx) {
    if (!args.files.length) fail(CODES.BAD_ARGS, "No files given.", "Pass at least one absolute path.");

    // DOM.setFileInputFiles needs a backend node id, which means resolving the element
    // through the DOM domain rather than by evaluating an expression.
    const { root } = await ctx.conn.client.DOM.getDocument({ depth: -1, pierce: true });
    const selector = args.selector || "input[type=file]";
    const { nodeId } = await ctx.conn.client.DOM.querySelector({ nodeId: root.nodeId, selector });
    if (!nodeId) {
      fail(CODES.NO_TARGET, `No file input matches "${selector}".`,
        "File inputs are often hidden behind a styled button; target the input itself, not the button. "
        + "dom_query('input[type=file]', {visible_only:false}) finds them.");
    }

    const before = markBefore(ctx);
    try {
      await ctx.conn.client.DOM.setFileInputFiles({ nodeId, files: args.files });
    } catch (e) {
      fail(CODES.IO_FAILED, `Chrome rejected the file list: ${e.message}`,
        "Paths must be absolute and must exist on the machine running Chrome, not the one running the agent.");
    }

    ctx.conn.setBadge(`attached ${args.files.length} file(s)`, "busy");
    ctx.recordActivity("interaction", { action: "upload", files: args.files.length });
    return { attached: args.files, to: selector, caused: await consequenceOf(ctx, before, 300) };
  },
});

defineTool({
  name: "ui_wait_for",
  readOnly: true,
  description:
    "Block until the page reaches a state: an element appears, disappears, becomes enabled, or some text shows up. "
    + "This is the honest alternative to guessing a sleep — it returns as soon as the condition holds, and when it "
    + "does not, it says what the page looked like instead of just timing out.",
  args: {
    ...TARGET_ARGS,
    state: {
      type: "string",
      description: "What to wait for: 'visible' (default), 'hidden', 'enabled', 'detached', or 'stable' (present and no longer moving).",
      enum: ["visible", "hidden", "enabled", "detached", "stable"], default: "visible",
    },
    contains_text: { type: "string", description: "Also require the element to contain this text." },
  },
  async handler(args, ctx) {
    requireTarget(args);
    const spec = { ...targetOf(args), testAttributes: ctx.cfg.testAttributes, visible_only: false };
    const context = contextFor(ctx, args.frame);
    const expr = qualifyExpression(spec, { nth: args.nth, scroll: false, hitTest: false, requireEnabled: false });

    const deadline = Date.now() + args.timeout_ms;
    const started = Date.now();
    let last = null, lastRect = null, stable = 0;

    for (;;) {
      const q = await evalJson(ctx, expr, context, `wait for ${args.state}`);
      last = q;

      const present = q.found > 0 && q.why !== "detached";
      const visible = q.ready || (present && q.why !== "hidden" && q.why !== "detached");
      let hit = false;

      switch (args.state) {
        case "hidden":   hit = !present || q.why === "hidden"; break;
        case "detached": hit = q.found === 0 || q.why === "detached"; break;
        case "enabled":  hit = present && q.why !== "disabled" && visible; break;
        case "stable": {
          const here = q.rect ? `${q.rect.x},${q.rect.y},${q.rect.w},${q.rect.h}` : null;
          if (here && here === lastRect) stable++; else { stable = 0; lastRect = here; }
          hit = visible && stable >= 2;
          break;
        }
        default:         hit = visible; break;
      }

      if (hit && args.contains_text && args.state !== "hidden" && args.state !== "detached") {
        const t = (q.node?.text || "").toLowerCase();
        if (!t.includes(String(args.contains_text).toLowerCase())) hit = false;
      }

      if (hit) {
        return {
          state: args.state, met: true, waitedMs: Date.now() - started,
          element: q.node || undefined, at: q.rect || undefined,
          ...(q.found > 1 ? { matched: q.found } : {}),
        };
      }
      if (Date.now() >= deadline) break;
      await new Promise(r => setTimeout(r, 70));
    }

    fail(CODES.TIMEOUT,
      `${describeTarget(args)} did not become "${args.state}" within ${args.timeout_ms}ms.`,
      last?.found
        ? `It is present but ${last.why || "not in that state"}. dom_query shows its current state in full.`
        : "It never appeared. Check the selector with dom_query, and pass frame: if the screen renders in an iframe.",
      {
        matched: last?.found || 0,
        currentState: last?.why || (last?.ready ? "actionable" : "unknown"),
        element: last?.node,
        ...(args.contains_text ? { wantedText: args.contains_text, actualText: last?.node?.text } : {}),
      });
  },
});

defineTool({
  name: "ui_inspect",
  readOnly: true,
  description:
    "List what can be interacted with on the current screen — buttons, links, inputs, selects and anything with an "
    + "interactive ARIA role — with the target you would use to reach each one. Use it when a selector fails and you "
    + "need to see what is really there. Far cheaper than dumping the DOM, and it names elements the way these tools "
    + "expect them to be named.",
  readOnly: true,
  args: {
    limit: { type: "number", description: "Maximum controls to return.", default: 40, min: 1, max: 200 },
    filter: { type: "string", description: "Only controls whose text, id or name contains this." },
    kind: {
      type: "string", description: "Restrict to one family of control.",
      enum: ["all", "buttons", "inputs", "links", "selects"], default: "all",
    },
    frame: { type: "string", description: "'main' (default) or a substring of a frame's origin/name.", default: "main" },
  },
  async handler(args, ctx) {
    const SELECTORS = {
      all: "button,a[href],input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=combobox],[onclick],[contenteditable=true]",
      buttons: "button,[role=button],input[type=button],input[type=submit],[onclick]",
      inputs: "input,textarea,[contenteditable=true]",
      links: "a[href],[role=link]",
      selects: "select,[role=combobox],[role=listbox]",
    };

    const expr = `(function(){
      var els = document.querySelectorAll(${JSON.stringify(SELECTORS[args.kind] || SELECTORS.all)});
      var filter = ${JSON.stringify((args.filter || "").toLowerCase())};
      var testAttrs = ${JSON.stringify(ctx.cfg.testAttributes)};
      var out = [], hidden = 0;
      for (var i = 0; i < els.length && out.length < ${args.limit}; i++) {
        var el = els[i];
        if (el.closest('[data-devcdp]')) continue;
        var r = el.getBoundingClientRect();
        var cs = getComputedStyle(el);
        var vis = cs.display !== 'none' && cs.visibility !== 'hidden' && r.width >= 1 && r.height >= 1;
        if (!vis) { hidden++; continue; }

        var label = (el.innerText || el.textContent || '').trim().replace(/\\s+/g, ' ')
                 || el.getAttribute('aria-label') || el.placeholder || el.value || el.name || '';
        var testid = null;
        for (var t = 0; t < testAttrs.length; t++) {
          var v = el.getAttribute(testAttrs[t]);
          if (v) { testid = testAttrs[t] + '=' + v; break; }
        }
        var hay = (label + ' ' + (el.id||'') + ' ' + (el.name||'')).toLowerCase();
        if (filter && hay.indexOf(filter) === -1) continue;

        // The target a caller should actually pass, most stable first.
        var use = testid ? { testid: el.getAttribute(testAttrs[testAttrs.indexOf(testid.split('=')[0])]) }
                : el.id ? { selector: '#' + el.id }
                : label ? { text: label.slice(0, 40) }
                : { selector: el.tagName.toLowerCase() };

        out.push({
          tag: el.tagName.toLowerCase(),
          type: el.type || el.getAttribute('role') || undefined,
          label: label.slice(0, 60) || undefined,
          disabled: (el.disabled === true || el.getAttribute('aria-disabled') === 'true') || undefined,
          value: (el.value !== undefined && el.type !== 'password' && String(el.value).length) ? String(el.value).slice(0, 40) : undefined,
          use: use,
          at: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }
        });
      }
      return JSON.stringify({ controls: out, total: els.length, hidden: hidden });
    })()`;

    const res = await evalJson(ctx, expr, contextFor(ctx, args.frame), "inspect controls");
    return {
      controls: res.controls || [],
      shown: (res.controls || []).length,
      totalMatched: res.total,
      hiddenSkipped: res.hidden,
      note: "Each 'use' object is the target to pass to ui_click / ui_fill / ui_select as-is.",
      ...(ctx.contexts.size > 1 && args.frame === "main"
        ? { frames: "This page has iframes — pass frame: to inspect inside one. dom_list_frames names them." }
        : {}),
    };
  },
});
