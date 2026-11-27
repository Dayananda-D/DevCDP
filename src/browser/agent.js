// ─── In-page agent ───────────────────────────────────────────────────────────
// Injected via Page.addScriptToEvaluateOnNewDocument (so it survives navigation)
// AND evaluated once into the current document (so an already-loaded page is
// covered too).
//
// v4 post-mortem — this script was the single biggest source of P0 bugs:
//   SPY-1  it called MutationObserver.observe(document.body || documentElement)
//          at document-start, when BOTH are still null. It threw on every load.
//   SPY-1b it set its installed-flag BEFORE the throw, so the guard made the
//          failure permanent — it never retried for the life of the page.
//   SPY-2  consequence: DOM mutations were always empty
//   SPY-3  consequence: the dialog watcher never registered
//   SPY-4  consequence: two DevCDP TypeErrors polluted the console of the very
//          app it was hired to debug
//   SPY-5  visibility used `offsetParent !== null`, which is ALWAYS null for
//          position:fixed elements — i.e. for most modals
//
// Design rules, therefore:
//   1. nothing here may throw. Every feature is wrapped, and so is the bootstrap.
//      A failure in one feature must not take out the others.
//   2. an installed-flag is set only after that feature actually installed.
//   3. anything needing <body> waits for it instead of assuming it.
//   4. re-entrant: safe to evaluate repeatedly; it heals partial installs.
//   5. pointer-events:none on all chrome we add, so we can never eat a click
//      meant for the app (that would break automation).
//
// Dialog detection is deliberately *structural* — ARIA/HTML standards plus
// geometry — not a list of framework class names. A class-name list only works
// for the frameworks someone remembered to add, silently fails on the rest, and
// ties the tool to whatever stack it was written against.

/**
 * @param {object} cfg
 * @param {string}   cfg.sessionId
 * @param {number}   cfg.sessionNumber
 * @param {string}   cfg.label             badge text, e.g. "DevCDP · session 1"
 * @param {string}   cfg.bindingName       Runtime.addBinding name
 * @param {string[]=} cfg.dialogSelectors  extra selectors for your app, from config
 * @param {string[]=} cfg.testAttributes   attributes to prefer when building selectors
 * @param {boolean=} cfg.badge             show the in-page badge
 * @param {string=}  cfg.corner            'tc' | 'bc' | 'tr' | 'tl' | 'br' | 'bl' — where the
 *                                        overlay parks before the user drags it elsewhere
 * @param {boolean=} cfg.captureValues     record input values (off by default, SEC-2)
 */
export function buildAgentSource(cfg) {
  const C = {
    badge: true,
    corner: "tc",
    autoCollapse: true,
    idleMs: 6000,
    showCursor: true,
    edgePulse: true,
    toasts: true,
    toastCorner: "bc",          // messages keep their own corner; the chip is dragged
    toastMs: 3500,
    toastOpacity: 0.78,
    toastMaxVisible: 3,
    activityPanel: true,
    activityPanelOpacity: 1,
    activityPanelMaxEntries: 80,
    callerName: "",
    callerId: "",
    callerTopic: "",
    dialogSelectors: [],
    testAttributes: ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "data-automation-id"],
    captureValues: false,
    ...cfg,
  };

  return `(function(){
"use strict";
var CFG = ${JSON.stringify(C)};
var NS  = "__devcdp";

try {

// ── singleton state (survives re-evaluation) ─────────────────────────────────
var S = window[NS];
if (!S) {
  S = window[NS] = { version: 5, installed: {}, seq: 0, pendingAsk: null, lastStatus: null };
}
S.sessionId = CFG.sessionId;
S.label     = CFG.label;
S.panelState = S.panelState || { steps: [], thoughts: [] };

function send(type, detail) {
  try {
    var fn = window[CFG.bindingName];
    if (typeof fn !== "function") return false;
    fn(JSON.stringify(Object.assign({ type: type, ts: Date.now(), seq: ++S.seq }, detail)));
    return true;
  } catch (_) { return false; }
}
S.send = send;

// Report our own breakage through the binding, never as an exception (SPY-4).
function guard(feature, fn) {
  try { return fn(); }
  catch (e) {
    try { send("agent_error", { feature: feature, message: String((e && e.message) || e) }); } catch (_) {}
    return undefined;
  }
}

function whenBody(fn) {
  if (document.body) { guard("whenBody", fn); return; }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { guard("whenBody", fn); }, { once: true });
  } else {
    var tries = 0;
    var iv = setInterval(function () {
      if (document.body) { clearInterval(iv); guard("whenBody", fn); }
      else if (++tries > 50) clearInterval(iv);
    }, 40);
  }
}

// ── visibility, done properly (SPY-5) ────────────────────────────────────────
function visible(el) {
  if (!el || !el.isConnected || el.nodeType !== 1) return false;
  var cs;
  try { cs = getComputedStyle(el); } catch (_) { return false; }
  if (!cs) return false;
  if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
  if (parseFloat(cs.opacity || "1") === 0) return false;
  if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
  var r;
  try { r = el.getBoundingClientRect(); } catch (_) { return false; }
  return r.width >= 1 && r.height >= 1;
}
S.visible = visible;

function labelFor(el) {
  try {
    if (el.labels && el.labels[0]) {
      var t = (el.labels[0].textContent || "").trim();
      if (t) return t.slice(0, 60);
    }
    return (el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("placeholder"))) || undefined;
  } catch (_) { return undefined; }
}

function testAttr(el) {
  if (!el || !el.getAttribute) return null;
  for (var i = 0; i < CFG.testAttributes.length; i++) {
    var v = el.getAttribute(CFG.testAttributes[i]);
    if (v) return { attr: CFG.testAttributes[i], value: v };
  }
  return null;
}

function cssEscape(v) {
  try { return (window.CSS && CSS.escape) ? CSS.escape(v) : String(v).replace(/["\\\\]/g, "\\\\$&"); }
  catch (_) { return String(v); }
}

function describe(el) {
  if (!el || !el.tagName) return {};
  var tag = el.tagName.toLowerCase();
  var id  = el.id || undefined;
  var cls = (typeof el.className === "string" && el.className.trim())
    ? el.className.trim().split(/\\s+/).slice(0, 3).join(".") : undefined;

  var ta = testAttr(el);
  var selector;
  if (ta)        selector = "[" + ta.attr + '="' + cssEscape(ta.value) + '"]';
  else if (id)   selector = "#" + cssEscape(id);
  else if (el.getAttribute && el.getAttribute("name")) selector = tag + '[name="' + cssEscape(el.getAttribute("name")) + '"]';
  else if (cls)  selector = tag + "." + cls;
  else           selector = tag;

  return {
    tag: tag, id: id, classes: cls,
    testId: ta ? ta.value : undefined,
    role: (el.getAttribute && el.getAttribute("role")) || undefined,
    ariaLabel: (el.getAttribute && el.getAttribute("aria-label")) || undefined,
    text: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 80) || undefined,
    selector: selector,
  };
}
S.describe = describe;

// ── 1. interaction listeners ────────────────────────────────────────────────
// Attached to the document, which always exists — safe at document-start.
if (!S.installed.listeners) {
  guard("listeners", function () {
    var SENSITIVE = /pass|pwd|secret|token|auth|ssn|card|cvv|iban|pin|otp/i;

    document.addEventListener("click", function (e) {
      // Our own controls are not the application. A click inside the shadow root
      // retargets to the host, so the confirmation button was being reported as a
      // page interaction as well as a confirmation — which read as the user
      // interfering at the exact moment they were doing what was asked.
      if (e.target && e.target.id === "devcdp-badge-host") return;
      var d = describe(e.target);
      d.trusted = e.isTrusted;
      send("click", d);
    }, true);

    document.addEventListener("change", function (e) {
      var el = e.target || {};
      var name = el.name || el.id || "";
      var value;
      // Values are private by default. They are captured only inside a
      // collaboration window — while DevCDP has asked the user to act, or the user
      // has taken over — because "tell me what to choose" is useless without them.
      // Password and sensitive-looking fields stay redacted regardless.
      var collaborating = !!(S.pendingAsk || S.userHasControl);
      if (el.type === "password" || SENSITIVE.test(name)) value = "[redacted]";
      else if (CFG.captureValues || collaborating) value = String(el.value == null ? "" : el.value).slice(0, 100);
      else value = "[not captured]";
      send("input_change", {
        tag: (el.tagName || "").toLowerCase(), id: el.id || undefined,
        name: el.name || undefined, label: labelFor(el), value: value,
        capturedBecause: (!CFG.captureValues && collaborating) ? "collaboration window" : undefined,
        trusted: e.isTrusted,
      });
    }, true);

    // Selects are the classic "which one do I choose" case, and a change event
    // alone does not tell you what the chosen option said.
    document.addEventListener("change", function (e) {
      var el = e.target;
      if (!el || (el.tagName || "").toLowerCase() !== "select") return;
      var opt = el.options && el.options[el.selectedIndex];
      send("option_chosen", {
        name: el.name || el.id || undefined, label: labelFor(el),
        chosen: opt ? (opt.textContent || "").trim().slice(0, 80) : undefined,
        value: opt ? String(opt.value).slice(0, 80) : undefined,
        index: el.selectedIndex,
      });
    }, true);

    // A way for the user to say "I'm driving" without any on-screen control, so
    // nothing extra is drawn over the app and nothing can eat a click.
    document.addEventListener("keydown", function (e) {
      if (!e.ctrlKey || !e.shiftKey) return;
      var k = (e.key || "").toLowerCase();
      if (k === "d") {                       // Ctrl+Shift+D — take/hand back control
        S.userHasControl = !S.userHasControl;
        send("user_takeover", { active: S.userHasControl });
        S.setStatus(S.userHasControl ? "you have control — DevCDP is watching" : "control handed back", S.userHasControl ? "ask" : null);
      }
      if (k === "p" && e.altKey) {            // Ctrl+Alt+Shift+P — show/hide the session panel
        e.preventDefault();
        e.stopPropagation();
        S.toggleSessionPanel && S.toggleSessionPanel();
      }
    }, true);

    document.addEventListener("submit", function (e) {
      var f = e.target || {};
      send("form_submit", { id: f.id || undefined, action: f.action || undefined, trusted: e.isTrusted });
    }, true);

    S.installed.listeners = true;
  });
}

// ── 2. DOM mutation observer (needs body) ───────────────────────────────────
if (!S.installed.mutations) {
  whenBody(function () {
    if (S.installed.mutations) return;
    guard("mutations", function () {
      var mo = new MutationObserver(function (records) {
        var batch = [];
        for (var i = 0; i < records.length && i < 20; i++) {
          var m = records[i];
          if (m.target && m.target.closest && m.target.closest("[data-devcdp]")) continue;  // ignore our own badge
          batch.push({
            type: m.type,
            target: (m.target && m.target.id) ? "#" + m.target.id
                  : (m.target && m.target.tagName ? m.target.tagName.toLowerCase() : undefined),
            added: m.addedNodes ? m.addedNodes.length : 0,
            removed: m.removedNodes ? m.removedNodes.length : 0,
            attr: m.attributeName || undefined,
          });
        }
        if (batch.length) send("dom_mutation", { mutations: batch });
      });
      mo.observe(document.body, { childList: true, subtree: true, attributes: true });
      S._mo = mo;
      S.installed.mutations = true;
    });
  });
}

// ── 3. dialog / overlay detection — structural, not framework-specific ──────
// Layer 1: web standards. These are specified behaviour, not any one library.
var STANDARD_SELECTORS = ['dialog[open]', '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]']
  .concat(CFG.dialogSelectors || []);

function findButtons(el) {
  var out = [];
  try {
    var nodes = el.querySelectorAll(
      'button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], a[href="#"]'
    );
    for (var i = 0; i < nodes.length && out.length < 12; i++) {
      if (!visible(nodes[i])) continue;
      var t = (nodes[i].textContent || nodes[i].value || nodes[i].getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ");
      if (t && out.indexOf(t) === -1) out.push(t);
    }
    // Fall back to anything that *behaves* like a button when nothing standard matched.
    if (!out.length) {
      var loose = el.querySelectorAll('[class*="btn" i], [class*="button" i], [onclick]');
      for (var j = 0; j < loose.length && out.length < 12; j++) {
        if (!visible(loose[j])) continue;
        var lt = (loose[j].textContent || "").trim().replace(/\\s+/g, " ");
        if (lt && lt.length < 40 && out.indexOf(lt) === -1) out.push(lt);
      }
    }
  } catch (_) {}
  return out;
}

function titleOf(el) {
  try {
    var t = el.querySelector('h1,h2,h3,h4,legend,[role="heading"],[class*="title" i],[class*="header" i]');
    if (t && visible(t)) return (t.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 140);
    var labelled = el.getAttribute && (el.getAttribute("aria-label") || el.getAttribute("title"));
    return labelled ? String(labelled).slice(0, 140) : "";
  } catch (_) { return ""; }
}

// Layer 2: geometry. Whatever library drew it, a modal is a positioned element,
// stacked above the page, that does not fill the whole viewport, and that sits
// under the cursor-neutral centre point of the screen.
function structuralCandidates() {
  var out = [];
  try {
    var vw = innerWidth, vh = innerHeight;
    if (!vw || !vh) return out;
    var probes = [[vw / 2, vh / 2], [vw / 2, vh * 0.33], [vw / 2, vh * 0.66]];
    var seen = [];

    for (var p = 0; p < probes.length; p++) {
      var stack = document.elementsFromPoint ? document.elementsFromPoint(probes[p][0], probes[p][1]) : [];
      for (var i = 0; i < stack.length; i++) {
        var el = stack[i];
        if (!el || el === document.body || el === document.documentElement) break;
        if (el.closest && el.closest("[data-devcdp]")) continue;      // our own badge
        // Walk up to the outermost positioned, stacked container.
        var node = el, best = null, hops = 0;
        while (node && node !== document.body && hops++ < 12) {
          var cs; try { cs = getComputedStyle(node); } catch (_) { break; }
          if (!cs) break;
          var z = parseInt(cs.zIndex, 10);
          var positioned = cs.position === "fixed" || cs.position === "absolute" || cs.position === "sticky";
          if (positioned && (isNaN(z) ? false : z >= 10)) best = node;
          node = node.parentElement;
        }
        if (!best || seen.indexOf(best) !== -1) continue;
        var r = best.getBoundingClientRect();
        var coversAll = r.width >= vw * 0.98 && r.height >= vh * 0.98;
        if (coversAll) continue;                                      // page shell or backdrop
        if (r.width < 120 || r.height < 60) continue;                 // toast/tooltip, not a dialog
        if (!visible(best)) continue;
        seen.push(best);
        out.push(best);
      }
    }
  } catch (_) {}
  return out;
}

function scanDialogs() {
  var found = [], seen = [];

  function add(el, how) {
    if (!el || seen.indexOf(el) !== -1 || !visible(el)) return;
    if (el.closest && el.closest("[data-devcdp]")) return;
    seen.push(el);
    var d = describe(el);
    found.push({
      detectedBy: how,
      selector: d.selector,
      role: d.role,
      title: titleOf(el),
      message: (el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 300),
      buttons: findButtons(el),
      modal: !!(el.getAttribute && el.getAttribute("aria-modal") === "true") || (el.tagName || "").toLowerCase() === "dialog",
    });
  }

  for (var i = 0; i < STANDARD_SELECTORS.length; i++) {
    var nodes;
    try { nodes = document.querySelectorAll(STANDARD_SELECTORS[i]); } catch (_) { continue; }
    for (var j = 0; j < nodes.length; j++) add(nodes[j], "standard:" + STANDARD_SELECTORS[i]);
  }

  if (!found.length) {
    var cands = structuralCandidates();
    for (var k = 0; k < cands.length; k++) {
      if (findButtons(cands[k]).length) add(cands[k], "structural:stacked-overlay");
    }
  }
  return found;
}
S.scanDialogs = scanDialogs;

if (!S.installed.dialogs) {
  whenBody(function () {
    if (S.installed.dialogs) return;
    guard("dialogs", function () {
      var openKeys = {};
      function check() {
        var now = scanDialogs(), keys = {};
        for (var i = 0; i < now.length; i++) {
          var key = now[i].selector + "|" + now[i].title;
          keys[key] = true;
          if (!openKeys[key]) send("dialog_opened", now[i]);
        }
        for (var k in openKeys) if (!keys[k]) send("dialog_closed", { key: k });
        openKeys = keys;
      }
      var obs = new MutationObserver(function () {
        if (S._dlgT) return;
        S._dlgT = setTimeout(function () { S._dlgT = null; guard("dialogCheck", check); }, 120);
      });
      obs.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ["style", "class", "hidden", "aria-hidden", "open", "aria-modal"],
      });
      S._dlgObs = obs;
      check();
      S.installed.dialogs = true;
    });
  });
}

// ── 4. presence indicator (F2 + SESS-2) ─────────────────────────────────────
// Redesigned after the corner badge proved too intrusive: a 191x122px panel sat
// permanently over the app's own UI.
//
// Three separate concerns, three different mechanisms, each chosen so it costs
// the app as little as possible:
//
//   presence   a 2px border inset at the viewport edge. Occludes no content, has
//              no layout impact, and is coloured per session so two agents are
//              distinguishable at a glance.
//   messages   a toast that appears only when there is something to say and then
//              disappears. Nothing sits there while idle.
//   handover   a sticky panel with the confirmation button — the one thing that
//              must not auto-hide, and the only interactive pixels we own.
//
// The paused state is not handled here at all: Chrome renders its own
// "Paused in debugger" bar via the Overlay domain, which adds zero DOM nodes and
// gives the user working resume/step controls. See connection.js.
//
// Everything lives in a shadow root, so the app cannot style it and our own
// dom_query cannot see it (querySelectorAll does not pierce shadow boundaries).

// Where the overlay parks itself. 'tc' is the default: top centre is the one place
// that is symmetric, predictable, and not already occupied — app chrome tends to live
// in the corners, which is what made a corner badge sit on top of real controls.
// Centre positions are done with a transform, which drag then replaces with explicit
// left/top, so the two mechanisms never fight.
var CORNERS = {
  tr: "top:14px;right:14px;",
  tl: "top:14px;left:14px;",
  br: "bottom:14px;right:14px;",
  bl: "bottom:14px;left:14px;",
  tc: "top:14px;left:50%;transform:translateX(-50%);",
  bc: "bottom:14px;left:50%;transform:translateX(-50%);",
};

/** How the stack's children line up under the chip, given where it is parked. */
var ALIGN = { tr: "flex-end", br: "flex-end", tl: "flex-start", bl: "flex-start", tc: "center", bc: "center" };

// Where the user last dragged it. Survives navigation, which matters because a
// single-page app reloading would otherwise snap the overlay back over whatever the
// user moved it away from.
var POS_KEY = "__devcdp_overlay_pos";
var PANEL_KEY = "__devcdp_panel_collapsed_";
var PANEL_LAYOUT_KEY = "__devcdp_panel_layout_";
var PANEL_VIS_KEY = "__devcdp_panel_visible_";

// Two colours, each meaning exactly one thing: blue means DevCDP is working, green
// means it is your turn.
//
// Sessions used to get a colour each. That made the border a puzzle instead of a
// signal — a second hue on screen raises the question "and what does that one mean?"
// when the only thing worth knowing at a glance is whether the tab is waiting for you.
// It also went wrong in practice: one of those session colours was a green close
// enough to the handover green to be indistinguishable on screen. Concurrent sessions
// are still told apart, by the chip text and by their own Chrome tab group, which is
// where that belongs.
var ACCENT = "#3b5bdb";   // blue
var accent = ACCENT;

// Reserved. Green is only ever a handover, red is only ever an error.
var HANDOVER = "#35c759";
var ALERT    = "#f0564a";

function buildChrome() {
  var host = document.getElementById("devcdp-badge-host");
  if (host && host.shadowRoot) return host;
  host = document.createElement("div");
  host.id = "devcdp-badge-host";
  host.setAttribute("data-devcdp", "chrome");
  // A single fixed, click-through layer covering the viewport. The border is
  // drawn with an inset shadow so it overlays rather than displaces anything.
  host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    "<style>" +
    ":host{all:initial}" +
    // A 1px line, with the presence carried by a soft inward fade rather than by
    // line weight — visible at a glance without drawing a hard frame around the app.
    //
    // The two states are deliberately different in *kind*, not just hue, so they
    // are distinguishable at a glance and by anyone who cannot rely on colour:
    //   DevCDP driving  → blue, glow breathing slowly
    //   your turn       → green, completely still. Stillness reads as "go ahead";
    //                     a pulsing border reads as "something is still running".
    ".edge{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 1px " + accent +
      ",inset 0 0 34px " + accent + "5c,inset 0 0 72px " + accent + "2e;" +
      "transition:box-shadow .18s ease" +
      (CFG.edgePulse ? ";animation:devcdpBreathe 2.6s ease-in-out infinite" : "") + "}" +
    "@keyframes devcdpBreathe{" +
      "0%,100%{box-shadow:inset 0 0 0 1px " + accent + ",inset 0 0 26px " + accent + "47,inset 0 0 58px " + accent + "1f}" +
      "50%{box-shadow:inset 0 0 0 1px " + accent + ",inset 0 0 46px " + accent + "85,inset 0 0 96px " + accent + "3d}}" +
    // Handover: green and static. animation:none is what stops the breathing.
    ".edge.ask{animation:none;box-shadow:inset 0 0 0 1px " + HANDOVER +
      ",inset 0 0 44px " + HANDOVER + "7a,inset 0 0 92px " + HANDOVER + "38}" +
    // Errors are a settled state too, so they do not breathe either.
    ".edge.alert{animation:none;box-shadow:inset 0 0 0 1px #f0564a,inset 0 0 44px #f0564a7a,inset 0 0 92px #f0564a38}" +
    // Respect a stated preference for less motion.
    "@media (prefers-reduced-motion:reduce){.edge{animation:none}}" +
    // The draggable object is the chip, and only the chip. It is the one part that is
    // always on screen, so it is the one worth being able to move; everything else
    // appears, is read, and goes away.
    //
    // The handover panel started out in here on the reasoning that a question belongs
    // beside the identity asking it. On screen that was plainly wrong: it is the
    // largest thing the overlay draws, and parking it top centre put it straight over
    // the application's own toolbar. It is a message that wants an answer, so it
    // belongs with the messages.
    ".stack{position:fixed;" + (CORNERS[CFG.corner] || CORNERS.tc) +
      "display:flex;flex-direction:column;gap:6px;pointer-events:none;" +
      "align-items:" + (ALIGN[CFG.corner] || "center") + ";}" +
    ".chip{font:600 10px/1 -apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.03em;background:" + accent +
      ";color:#fff;padding:4px 7px;border-radius:5px;" +
      // The one element that must accept input: it is the drag handle.
      "pointer-events:auto;cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none;" +
      "box-shadow:0 2px 6px rgba(0,0,0,.28);opacity:.85;transition:opacity .18s ease}" +
    ".chip:hover{opacity:1}" +
    ".chip.drag{cursor:grabbing;opacity:1}" +
    ".chip.dim{opacity:.35}" +
    // Everything the overlay says, in its own corner: the running commentary and the
    // one question that waits for an answer. One container, so the panel and the
    // toasts can never land on top of each other.
    ".msgs{position:fixed;" + (CORNERS[CFG.toastCorner] || CORNERS.tr) +
      "display:flex;gap:6px;pointer-events:none;max-width:330px;" +
      "align-items:" + (ALIGN[CFG.toastCorner] || "flex-end") + ";" +
      // Sharing a corner with the chip would stack messages on top of it, so clear
      // its height and sit underneath.
      (CFG.toastCorner === CFG.corner
        ? (String(CFG.toastCorner).charAt(0) === "b" ? "margin-bottom:30px;" : "margin-top:30px;")
        : "") +
      // From a bottom anchor the newest message should still be the one nearest the
      // edge the eye is already on.
      (String(CFG.toastCorner || "tr").charAt(0) === "b" ? "flex-direction:column-reverse;" : "flex-direction:column;") + "}" +
    // Live status messages, translucent so they obscure as little of the app as
    // possible, each entry fading itself out.
    ".toasts{display:flex;flex-direction:column;gap:5px;pointer-events:none;width:100%;" +
      "align-items:" + (ALIGN[CFG.toastCorner] || "flex-end") + ";" +
      (String(CFG.toastCorner || "tr").charAt(0) === "b" ? "flex-direction:column-reverse;" : "") + "}" +
    ".toast{font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#eaf3ff;" +
      "background:rgba(11,26,42," + CFG.toastOpacity + ");-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);" +
      "border:1px solid " + accent + "aa;border-left:2px solid " + accent + ";border-radius:7px;padding:5px 9px;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.26);pointer-events:none;opacity:0;transform:translateY(3px);" +
      "transition:opacity .18s ease,transform .18s ease}" +
    ".toast.show{opacity:1;transform:translateY(0)}" +
    ".toast-body{display:inline-block;padding-right:16px}" +
    ".toast-close{position:absolute;top:2px;right:4px;border:0;background:none;color:#fff9;font-size:14px;line-height:14px;padding:0;pointer-events:auto;cursor:pointer}" +
    ".toast-close:hover{color:#fff}" +
    ".toast.err{border-color:#f0564a;border-left-color:#f0564a}" +
    ".toast.ask{border-color:" + HANDOVER + ";border-left-color:" + HANDOVER + "}" +
    ".panel{font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;background:#0f2438;color:#d7ffe4;" +
      "border:1px solid " + HANDOVER + ";border-radius:9px;padding:9px 11px;max-width:320px;" +
      "box-shadow:0 8px 26px rgba(0,0,0,.4);pointer-events:none;display:none}" +
    ".panel.show{display:block}" +
    ".panel .q{margin-bottom:7px}" +
    ".btn{display:inline-block;pointer-events:auto;cursor:pointer;background:" + HANDOVER + ";color:#06240f;" +
      "border-radius:6px;padding:4px 12px;font-weight:700;font-size:11px;user-select:none}" +
    ".btn:hover{filter:brightness(1.12)}" +
    ".activity-panel{position:fixed;top:16px;right:12px;bottom:16px;width:320px;max-width:calc(100vw - 28px);font:12px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;color:#172033;background:#f8fafc;border:1px solid #aebdd0;border-radius:10px;box-shadow:0 8px 30px rgba(31,48,71,.22);pointer-events:auto;display:" + (CFG.activityPanel === false ? "none" : "flex") + ";flex-direction:column;z-index:2;overflow:hidden}" +
    ".activity-panel.collapsed{width:34px;top:16px;bottom:16px;height:auto;max-height:none}" +
    ".activity-head{flex:0 0 auto;padding:16px;border-bottom:1px solid #d9e2ec;background:#eef4fa;cursor:grab}.activity-head:active{cursor:grabbing}" +
    ".activity-headbar{display:flex;align-items:center;gap:7px}.activity-name{font-size:13px;font-weight:600;color:#16243a}.activity-chip{font-size:10px;font-weight:600;letter-spacing:.03em;background:#3b5bdb;color:#fff;padding:4px 7px;border-radius:5px}.activity-status{font-size:10px;font-weight:600;padding:4px 7px;border-radius:5px;background:#dce8ff;color:#2448a5}.activity-status.done{background:#e7edf3;color:#52657a}.activity-status.ask{background:#d9f4df;color:#145b2a}.activity-status.err{background:#f9dfdf;color:#8c2424}.activity-toggle{flex:0 0 auto;width:24px;height:24px;display:grid;place-items:center;pointer-events:auto;cursor:pointer;border:1px solid #c4d0dd;border-radius:7px;background:#fff;color:#5d7187;padding:0;line-height:0;transition:background .15s ease,border-color .15s ease,color .15s ease}.activity-toggle:hover{background:#edf3fa;border-color:#9fb2c7;color:#3b5bdb}.activity-toggle svg{width:14px;height:14px;display:block}.activity-caller{margin-top:12px}.activity-client{font-size:10px;line-height:14px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#52657a}.activity-topic{margin:3px 0 0;font-size:14px;line-height:19px;font-weight:600;color:#17243a;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.activity-id{margin-top:4px;font:11px/14px ui-monospace,SFMono-Regular,Consolas,monospace;color:#718197;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
    ".activity-body{flex:1;min-height:0;overflow:auto;padding:16px}.activity-section{margin:0 0 24px}.activity-label{margin:0 0 7px;font-size:10px;line-height:14px;letter-spacing:.06em;text-transform:uppercase;font-weight:600;color:#63758a}.activity-goal{margin:0;font-size:13px;line-height:18px;color:#172033}.activity-expect{margin:10px 0 0;padding:9px 10px;background:#edf3fa;border-left:2px solid #8ea6ff;border-radius:7px;color:#52657a;font-size:12px;line-height:17px}.activity-planhead{display:flex;justify-content:space-between;align-items:center}.activity-value{font:11px/14px ui-monospace,SFMono-Regular,Consolas,monospace;color:#718197}.activity-progress{display:flex;gap:3px;margin:8px 0 10px}.activity-seg{height:3px;flex:1;background:#dbe3ec;border-radius:2px}.activity-seg.done{background:#92a7bf}.activity-seg.now{background:#8ea6ff}.activity-seg.ask{background:#63c879}.activity-steps{margin:0;padding:0;list-style:none}.activity-step{display:flex;gap:8px;padding:8px;border-radius:7px;position:relative}.activity-step.now{background:#e7efff}.activity-step.ask{background:#e8f7ea}.activity-step.err{background:#f9eaea}.activity-mark{flex:0 0 16px;width:16px;height:16px;color:#8496ab;display:grid;place-items:center}.activity-mark svg{width:16px;height:16px}.activity-step.now .activity-mark{color:#5476df}.activity-step.ask .activity-mark{color:#269b46}.activity-step.done .activity-mark{color:#8496ab}.activity-step.err .activity-mark{color:#c94343}.activity-steptext{font-size:13px;line-height:18px;color:#223149}.activity-step.done .activity-steptext{text-decoration:line-through;color:#8b9cb3}.activity-note{margin:3px 0 0;font-size:12px;line-height:17px;color:#60738a}.activity-thought{margin:8px 0 0;padding-top:8px;border-top:1px solid #d9e2ec;font-size:12px;line-height:17px;color:#52657a}.activity-tag{margin-left:auto;align-self:flex-start;font-size:10px;line-height:14px;padding:3px 5px;border-radius:4px;background:#dce8ff;color:#2448a5}.activity-step.ask .activity-tag{background:#d9f4df;color:#145b2a}.activity-tools{margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:5px}.activity-tool{padding:4px 7px;border:1px solid #d4dfeb;border-radius:5px;background:#f3f7fb;color:#52657a;font:10px/14px ui-monospace,SFMono-Regular,Consolas,monospace}.activity-foot{flex:0 0 auto;display:flex;justify-content:space-between;padding:12px 16px;border-top:1px solid #d9e2ec;background:#eef4fa;color:#63758a;font-size:11px}.activity-resize{position:absolute;left:0;top:0;bottom:0;width:6px;cursor:ew-resize;background:transparent}.activity-resize:hover{background:#8ea6ff55}.activity-panel.hidden{display:none}.activity-panel.collapsed .activity-head{height:100%;padding:8px 7px;display:flex;align-items:flex-start;justify-content:center}.activity-panel.collapsed .activity-headbar{display:flex;flex-direction:column;gap:10px}.activity-panel.collapsed .activity-name,.activity-panel.collapsed .activity-status,.activity-panel.collapsed .activity-caller,.activity-panel.collapsed .activity-body,.activity-panel.collapsed .activity-foot{display:none}.activity-panel.collapsed .activity-chip{writing-mode:vertical-rl}.activity-panel.collapsed .activity-toggle{margin:0}" +
    // activity cursor: a ring that follows pointer activity, and a ripple on each
    // click, so it is visible where something is being interacted with.
    ".cur{position:fixed;left:0;top:0;width:20px;height:20px;margin:-10px 0 0 -10px;border:2px solid " + accent +
      ";border-radius:50%;pointer-events:none;opacity:0;transition:opacity .18s ease;" +
      "box-shadow:0 0 0 1px #fff8,0 0 8px " + accent + "88}" +
    ".cur.on{opacity:.95}" +
    ".cur:after{content:'';position:absolute;left:50%;top:50%;width:3px;height:3px;margin:-1.5px 0 0 -1.5px;" +
      "border-radius:50%;background:" + accent + "}" +
    ".rip{position:fixed;left:0;top:0;width:14px;height:14px;margin:-7px 0 0 -7px;border-radius:50%;" +
      "background:" + accent + ";pointer-events:none;animation:rip .55s ease-out forwards}" +
    "@keyframes rip{0%{transform:scale(1);opacity:.8}100%{transform:scale(4);opacity:0}}" +
    ".tip{position:fixed;left:0;top:0;font:600 10px/1 -apple-system,Segoe UI,Roboto,sans-serif;" +
      "background:#0f2438;color:#e8f2ff;border:1px solid " + accent + ";border-radius:4px;padding:3px 6px;" +
      "pointer-events:none;white-space:nowrap;opacity:0;transition:opacity .15s ease;transform:translate(14px,-24px)}" +
    ".tip.on{opacity:.95}" +
    "</style>" +
    '<div class="edge" id="edge"></div>' +
    '<div class="stack" id="stack">' +
      '<div class="chip" id="chip" title="Drag to move DevCDP out of your way"></div>' +
    '</div>' +
    '<div class="msgs" id="msgs">' +
      '<div class="toasts" id="toasts"></div>' +
      '<div class="panel" id="panel"><div class="q" id="q"></div><div class="btn" id="btn">I\\u2019ve done it \\u2713</div></div>' +
    '</div>' +
    '<aside class="activity-panel" id="activity-panel" aria-label="DevCDP session activity"><header class="activity-head"><div class="activity-headbar"><button class="activity-toggle" id="activity-toggle" aria-label="Collapse DevCDP panel"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6.25 3.5 10.75 8l-4.5 4.5"/></svg></button><span class="activity-name">DevCDP</span><span class="activity-chip" id="activity-session"></span><span class="activity-status" id="activity-status">Working</span></div><div class="activity-caller"><div class="activity-client" id="activity-client"></div><div class="activity-topic" id="activity-topic"></div><div class="activity-id" id="activity-id"></div></div></header><div class="activity-body" id="activity-body"><section class="activity-section"><h3 class="activity-label">Goal</h3><p class="activity-goal" id="activity-goal"></p><p class="activity-expect" id="activity-expect"><b>Expect</b> <span></span></p></section><section class="activity-section"><div class="activity-planhead"><h3 class="activity-label">Plan</h3><span class="activity-value" id="activity-count"></span></div><div class="activity-progress" id="activity-progress"></div><ol class="activity-steps" id="activity-steps"></ol></section><section class="activity-section"><h3 class="activity-label">Tools used</h3><ul class="activity-tools" id="activity-tools"></ul></section></div><footer class="activity-foot"><span>Take over any time · Ctrl+Shift+D</span><span>Panel · Ctrl+Alt+Shift+P</span></footer><div class="activity-resize" id="activity-resize" title="Resize panel"></div></aside>' +
    '<div class="cur" id="cur"></div>' +
    '<div class="tip" id="tip"></div>';

  makeDraggable(root);
  return host;
}

// ── dragging ────────────────────────────────────────────────────────────────
// The overlay is deliberately small, but "small" is not the same as "never in the
// way": the one control the user needs can be exactly underneath it, and no setting
// helps someone who only discovers the clash once the app is on screen. So the chip
// is a handle, and where it is dropped is remembered.

/** Keep the stack fully on screen — dragging it out of reach would be worse than fixed. */
function clampPos(x, y, w, h) {
  var maxX = Math.max(0, (window.innerWidth  || 0) - w - 4);
  var maxY = Math.max(0, (window.innerHeight || 0) - h - 4);
  return { x: Math.min(Math.max(4, x), maxX), y: Math.min(Math.max(4, y), maxY) };
}

function placeStack(stack, x, y) {
  var r = stack.getBoundingClientRect();
  var p = clampPos(x, y, r.width, r.height);
  // Explicit left/top must displace every anchoring rule, including the centring
  // transform, or the stack lands offset by half its own width.
  stack.style.left = p.x + "px";
  stack.style.top  = p.y + "px";
  stack.style.right = "auto";
  stack.style.bottom = "auto";
  stack.style.transform = "none";
  return p;
}

function savedPos() {
  try { var raw = localStorage.getItem(POS_KEY); return raw ? JSON.parse(raw) : null; }
  catch (_) { return null; }   // sandboxed origins throw on localStorage
}

/**
 * Give a click back to the application.
 *
 * The chip has to be hit-testable to be draggable, which means the app underneath
 * stops receiving clicks at that spot. Rather than accept that, we take our whole
 * layer out of hit-testing for one measurement, ask the document what the user was
 * actually aiming at, and replay the press there.
 */
function forwardClick(e) {
  var host = document.getElementById("devcdp-badge-host");
  if (!host) return;

  var prev = host.style.display;
  host.style.display = "none";
  var target = null;
  try { target = document.elementFromPoint(e.clientX, e.clientY); } catch (_) {}
  host.style.display = prev;
  if (!target) return;

  var init = {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: e.clientX, clientY: e.clientY, button: 0, buttons: 0,
  };
  // The full sequence, not just click: plenty of UI reacts on mousedown.
  ["mousedown", "mouseup", "click"].forEach(function (type) {
    try { target.dispatchEvent(new MouseEvent(type, init)); } catch (_) {}
  });
}

function makeDraggable(root) {
  var stack = root.getElementById("stack");
  var chip  = root.getElementById("chip");
  if (!stack || !chip) return;

  var pos = savedPos();
  if (pos && typeof pos.x === "number" && typeof pos.y === "number") {
    // Restore after layout, so the clamp measures a real box rather than 0×0.
    requestAnimationFrame(function () { guard("posRestore", function () { placeStack(stack, pos.x, pos.y); }); });
  }

  // A handle has to accept input, and accepting input is exactly how agent chrome
  // starts swallowing clicks meant for the app (F2) — the one thing this overlay
  // must never do, and now at top centre, where applications put their toolbars.
  //
  // So the chip claims the pointer only once it has actually been dragged: below the
  // threshold nothing is captured, nothing is preventDefault'd, and the resulting
  // click is forwarded to whatever sits underneath. Press-and-release on the chip
  // behaves as though the chip were not there; press-and-move moves it.
  var DRAG_MIN = 3;
  var armed = false, dragging = false, dragged = false, sx = 0, sy = 0, dx = 0, dy = 0;

  chip.addEventListener("pointerdown", function (e) {
    guard("dragStart", function () {
      var r = stack.getBoundingClientRect();
      armed = true; dragging = false; dragged = false;
      sx = e.clientX; sy = e.clientY;
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
    });
  }, true);

  chip.addEventListener("pointermove", function (e) {
    if (!armed) return;
    guard("dragMove", function () {
      if (!dragging) {
        if (Math.abs(e.clientX - sx) < DRAG_MIN && Math.abs(e.clientY - sy) < DRAG_MIN) return;
        dragging = dragged = true;
        chip.classList.add("drag");
        try { chip.setPointerCapture(e.pointerId); } catch (_) {}
      }
      placeStack(stack, e.clientX - dx, e.clientY - dy);
      e.preventDefault();
    });
  }, true);

  function end(e) {
    if (!armed) return;
    guard("dragEnd", function () {
      armed = false;
      if (!dragging) return;              // a click, not a drag — leave it alone
      dragging = false;
      chip.classList.remove("drag");
      try { chip.releasePointerCapture(e.pointerId); } catch (_) {}
      var r = stack.getBoundingClientRect();
      try { localStorage.setItem(POS_KEY, JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top) })); } catch (_) {}
    });
  }
  chip.addEventListener("pointerup", end, true);
  chip.addEventListener("pointercancel", end, true);

  chip.addEventListener("click", function (e) {
    guard("clickThrough", function () {
      // The click that ends a drag is not a click on anything.
      if (dragged) { dragged = false; e.preventDefault(); e.stopPropagation(); return; }
      forwardClick(e);
    });
  }, true);

  // A window that shrinks below the drop point would strand the overlay off-screen.
  window.addEventListener("resize", function () {
    guard("dragResize", function () {
      if (!stack.style.left) return;
      placeStack(stack, parseFloat(stack.style.left) || 0, parseFloat(stack.style.top) || 0);
    });
  }, true);
}

// ── activity cursor ─────────────────────────────────────────────────────────
// Chrome dispatches CDP-synthesised input as trusted events, so a driver's clicks
// are indistinguishable from a human's at this level. Rather than guess, this
// simply shows where interaction is happening — which is what makes an agent's
// actions followable — and labels the element involved.
function moveCursor(x, y, label) {
  var cur = part("cur"), tip = part("tip");
  if (!cur) return;
  cur.style.transform = "translate(" + x + "px," + y + "px)";
  cur.classList.add("on");
  if (tip) {
    if (label) { tip.textContent = label; tip.style.transform = "translate(" + (x + 14) + "px," + (y - 24) + "px)"; tip.classList.add("on"); }
    else tip.classList.remove("on");
  }
  if (S._curT) clearTimeout(S._curT);
  S._curT = setTimeout(function () {
    guard("cursorHide", function () {
      var c = part("cur"); if (c) c.classList.remove("on");
      var t = part("tip"); if (t) t.classList.remove("on");
    });
  }, 2200);
}

function ripple(x, y) {
  var h = document.getElementById("devcdp-badge-host");
  if (!h || !h.shadowRoot) return;
  var r = document.createElement("div");
  r.className = "rip";
  r.style.transform = "translate(" + x + "px," + y + "px)";
  h.shadowRoot.appendChild(r);
  setTimeout(function () { try { r.remove(); } catch (_) {} }, 600);
}

if (!S.installed.cursor && CFG.badge && CFG.showCursor) {
  guard("cursor", function () {
    var lastMove = 0;
    document.addEventListener("pointermove", function (e) {
      var now = Date.now();
      if (now - lastMove < 60) return;
      lastMove = now;
      guard("cursorMove", function () { moveCursor(e.clientX, e.clientY, null); });
    }, { passive: true, capture: true });

    document.addEventListener("pointerdown", function (e) {
      guard("cursorDown", function () {
        S._lastPointerTs = Date.now();
        var d = describe(e.target);
        moveCursor(e.clientX, e.clientY, (d.text || d.selector || "").slice(0, 40));
        ripple(e.clientX, e.clientY);
      });
    }, { passive: true, capture: true });

    S.installed.cursor = true;
  });
}

/**
 * Let the server point the cursor at something it is about to inspect.
 * Real interaction wins: a highlight resolved asynchronously must not drag the
 * cursor back to where DevCDP was looking a moment ago.
 */
S.pointAt = function (x, y, label) {
  guard("pointAt", function () {
    if (S._lastPointerTs && Date.now() - S._lastPointerTs < 500) return;
    mountChrome();
    moveCursor(x, y, label || null);
    ripple(x, y);
  });
  return true;
};
S.clearPointer = function () {
  guard("clearPointer", function () {
    var c = part("cur"), t = part("tip");
    if (c) c.classList.remove("on");
    if (t) t.classList.remove("on");
  });
  return true;
};
S.cursorVisible = function () { var c = part("cur"); return !!(c && c.classList.contains("on")); };

function part(id) {
  var h = document.getElementById("devcdp-badge-host");
  return (h && h.shadowRoot) ? h.shadowRoot.getElementById(id) : null;
}

function panelStorageKey(prefix) { return prefix + (CFG.sessionId || "default"); }
function savePanelGeometry(panel) {
  try {
    var r = panel.getBoundingClientRect();
    localStorage.setItem(panelStorageKey(PANEL_LAYOUT_KEY), JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }));
  } catch (_) {}
}
function restorePanelGeometry(panel) {
  try {
    var raw = localStorage.getItem(panelStorageKey(PANEL_LAYOUT_KEY));
    if (!raw) return;
    var g = JSON.parse(raw);
    if (!g || !g.width || !g.height) return;
    panel.style.left = Math.max(4, Math.min(g.left || 0, innerWidth - 80)) + "px";
    panel.style.right = "auto";
    panel.style.top = Math.max(4, Math.min(g.top || 0, innerHeight - 80)) + "px";
    panel.style.bottom = "auto";
    panel.style.width = Math.max(260, Math.min(g.width, innerWidth - 28)) + "px";
    panel.style.height = Math.max(300, Math.min(g.height, innerHeight - 28)) + "px";
  } catch (_) {}
}
function wirePanelMovement(panel, head, resize) {
  if (!panel || panel.__movementWired) return;
  panel.__movementWired = true;
  var drag = null;
  head.addEventListener("pointerdown", function (e) {
    if (e.target && (e.target.closest("button") || e.target.closest(".activity-resize"))) return;
    var r = panel.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    head.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, true);
  head.addEventListener("pointermove", function (e) {
    if (!drag) return;
    panel.style.left = Math.max(4, Math.min(innerWidth - 80, drag.left + e.clientX - drag.x)) + "px";
    panel.style.top = Math.max(4, Math.min(innerHeight - 80, drag.top + e.clientY - drag.y)) + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
  }, true);
  function stopDrag(e) { if (!drag) return; drag = null; try { head.releasePointerCapture?.(e.pointerId); } catch (_) {} savePanelGeometry(panel); }
  head.addEventListener("pointerup", stopDrag, true);
  head.addEventListener("pointercancel", stopDrag, true);

  var resizing = null;
  resize.addEventListener("pointerdown", function (e) {
    var r = panel.getBoundingClientRect();
    resizing = { x: e.clientX, y: e.clientY, right: r.right, top: r.top, height: r.height };
    resize.setPointerCapture?.(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, true);
  resize.addEventListener("pointermove", function (e) {
    if (!resizing) return;
    var width = Math.max(260, Math.min(600, resizing.right - e.clientX));
    var height = Math.max(300, Math.min(innerHeight - 28, resizing.height + e.clientY - resizing.y));
    panel.style.left = Math.max(4, resizing.right - width) + "px";
    panel.style.top = Math.max(4, Math.min(resizing.top, innerHeight - 80)) + "px";
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.width = width + "px";
    panel.style.height = height + "px";
  }, true);
  function stopResize(e) { if (!resizing) return; resizing = null; try { resize.releasePointerCapture?.(e.pointerId); } catch (_) {} savePanelGeometry(panel); }
  resize.addEventListener("pointerup", stopResize, true);
  resize.addEventListener("pointercancel", stopResize, true);
}

function mountChrome() {
  if (!CFG.badge) return null;
  var host = buildChrome();
  if (!host.isConnected && document.body) document.body.appendChild(host);
  var chip = part("chip");
  if (chip && !chip.textContent) chip.textContent = CFG.label || "DevCDP";
  var btn = part("btn");
  if (btn && !btn.__wired) {
    btn.__wired = true;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      send("user_confirmed", { instruction: S.pendingAsk ? S.pendingAsk.instruction : null });
      applyAsk(null);
    }, true);
  }
  var toggle = part("activity-toggle");
  if (toggle && !toggle.__wired) {
    toggle.__wired = true;
    toggle.addEventListener("click", function (e) {
      e.stopPropagation();
      var p = part("activity-panel");
      if (!p) return;
      var collapsed = p.classList.toggle("collapsed");
      toggle.innerHTML = chevronSvg(collapsed ? "left" : "right");
      toggle.setAttribute("aria-label", collapsed ? "Expand DevCDP panel" : "Collapse DevCDP panel");
      try { localStorage.setItem(PANEL_KEY + (CFG.sessionId || "default"), collapsed ? "1" : "0"); } catch (_) {}
    }, true);
  }
  var activityPanel = part("activity-panel");
  var activityHead = activityPanel && activityPanel.querySelector(".activity-head");
  var resize = part("activity-resize");
  if (activityPanel && activityHead && resize) {
    restorePanelGeometry(activityPanel);
    wirePanelMovement(activityPanel, activityHead, resize);
  }
  var sessionChip = part("activity-session");
  if (sessionChip) sessionChip.textContent = "session " + String(CFG.sessionNumber || "?");
  var client = part("activity-client");
  if (client) client.textContent = CFG.callerName || "MCP client";
  var callerId = part("activity-id");
  if (callerId) callerId.textContent = CFG.callerId || CFG.sessionId || "session id unavailable";
  if (activityPanel && !activityPanel.__restored) {
    activityPanel.__restored = true;
    var collapsed = false;
    try { collapsed = localStorage.getItem(PANEL_KEY + (CFG.sessionId || "default")) === "1"; } catch (_) {}
    activityPanel.classList.toggle("collapsed", collapsed);
    if (toggle) {
      toggle.innerHTML = chevronSvg(collapsed ? "left" : "right");
      toggle.setAttribute("aria-label", collapsed ? "Expand DevCDP panel" : "Collapse DevCDP panel");
    }
    var visible = true;
    try { visible = localStorage.getItem(panelStorageKey(PANEL_VIS_KEY)) !== "0"; } catch (_) {}
    activityPanel.classList.toggle("hidden", !visible);
  }
  if (S.pendingAsk) applyAsk(S.pendingAsk);
  return host;
}

function setEdge(kind) {
  var e = part("edge");
  if (!e) return;
  e.className = "edge" + (kind === "err" ? " alert" : kind === "ask" ? " ask" : "");
}

function pushToast(text, kind) {
  var box = part("toasts");
  if (!box || !CFG.toasts) return null;

  var el = document.createElement("div");
  el.className = "toast" + (kind === "err" ? " err" : kind === "ask" ? " ask" : "");
  el.style.position = "relative";
  var body = document.createElement("span"); body.className = "toast-body"; body.textContent = text;
  el.appendChild(body);
  var close = document.createElement("button");
  close.className = "toast-close"; close.type = "button"; close.setAttribute("aria-label", "Dismiss notification"); close.textContent = "×";
  close.addEventListener("click", function (e) {
    e.stopPropagation(); el.classList.remove("show");
    setTimeout(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {} }, 180);
  }, true);
  el.appendChild(close);
  box.appendChild(el);
  // Force a frame so the transition runs rather than snapping in.
  requestAnimationFrame(function () { guard("toastShow", function () { el.classList.add("show"); }); });

  // Keep the stack short; oldest goes first.
  while (box.children.length > CFG.toastMaxVisible) box.removeChild(box.firstChild);

  // Errors stay until superseded; ordinary progress fades itself out.
  if (kind !== "err") {
    setTimeout(function () {
      guard("toastFade", function () {
        el.classList.remove("show");
        setTimeout(function () { try { if (el.parentNode) el.parentNode.removeChild(el); } catch (_) {} }, 260);
      });
    }, CFG.toastMs);
  }
  return el;
}

function clearToasts() {
  var box = part("toasts");
  if (!box) return;
  while (box.firstChild) box.removeChild(box.firstChild);
}
function markSvg(kind) {
  if (kind === "done") return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
  if (kind === "err") return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
  if (kind === "ask") return '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1L5.92 2.7A.6.6 0 0 0 5 3.2z"/></svg>';
  if (kind === "now") return '<span style="display:block;width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 0 4px #8ea6ff55"></span>';
  return '<span style="display:block;width:10px;height:10px;border:1.5px solid currentColor;border-radius:50%"></span>';
}
function chevronSvg(direction) {
  var path = direction === "right" ? "M6.25 3.5 10.75 8l-4.5 4.5" : "M9.75 3.5 5.25 8l4.5 4.5";
  return '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"></path></svg>';
}
function addActivity() { return false; }
function renderPanel(data) {
  if (CFG.activityPanel === false) return false;
  mountChrome();
  data = data || {};
  var topic = part("activity-topic"); if (topic) topic.textContent = data.topic || "MCP debugging session";
  var client = part("activity-client"); if (client) client.textContent = data.clientName || CFG.callerName || "MCP client";
  var id = part("activity-id"); if (id) id.textContent = data.clientId || CFG.callerId || CFG.sessionId || "session id unavailable";
  var goal = part("activity-goal"); if (goal) goal.textContent = data.goal || "No goal has been set yet.";
  var expect = part("activity-expect"); if (expect) expect.querySelector("span").textContent = data.expectation || "Watching the browser for the next confirmed state.";
  var steps = Array.isArray(data.steps) ? data.steps : [];
  var done = steps.filter(function (x) { return x && x.status === "done"; }).length;
  var current = steps.findIndex(function (x) { return x && x.status !== "done" && x.status !== "blocked"; });
  var count = part("activity-count"); if (count) count.textContent = done + " of " + steps.length + " done";
  var progress = part("activity-progress");
  if (progress) { progress.textContent = ""; steps.forEach(function (st, i) { var seg = document.createElement("span"); seg.className = "activity-seg" + (st.status === "done" ? " done" : st.status === "blocked" ? " ask" : i === current ? " now" : ""); progress.appendChild(seg); }); }
  var list = part("activity-steps");
  if (list) {
    list.textContent = "";
    steps.forEach(function (st, i) {
      var state = st.status === "done" ? "done" : st.status === "blocked" ? "err" : i === current ? "now" : "later";
      var li = document.createElement("li"); li.className = "activity-step " + state;
      var mark = document.createElement("span"); mark.className = "activity-mark"; mark.innerHTML = markSvg(state); li.appendChild(mark);
      var body = document.createElement("div");
      var text = document.createElement("div"); text.className = "activity-steptext"; text.textContent = st.description || st.id || "Untitled step"; body.appendChild(text);
      if (st.result) { var note = document.createElement("p"); note.className = "activity-note"; note.textContent = st.result; body.appendChild(note); }
      if (st.thought) { var thought = document.createElement("p"); thought.className = "activity-thought"; thought.textContent = st.thought; body.appendChild(thought); }
      li.appendChild(body);
      if (state === "now" || state === "err") { var tag = document.createElement("span"); tag.className = "activity-tag"; tag.textContent = state === "err" ? "Blocked" : "Now"; li.appendChild(tag); }
      list.appendChild(li);
    });
  }
  var toolsList = part("activity-tools");
  if (toolsList) {
    toolsList.textContent = "";
    (Array.isArray(data.tools) ? data.tools : []).forEach(function (tool) {
      var item = document.createElement("li");
      item.className = "activity-tool";
      item.textContent = tool && (tool.name || tool) ? (tool.name || tool) : "Unknown tool";
      toolsList.appendChild(item);
    });
  }
  var status = part("activity-status");
  if (status) { var label = data.status === "ask" ? "Your turn" : data.status === "done" ? "Done" : data.status === "err" ? "Blocked" : "Working"; status.textContent = label; status.className = "activity-status" + (data.status ? " " + data.status : ""); }
  return true;
}

function applyStatus(st) {
  // A pending question outranks background chatter. Without this, an internal
  // update that lands just after the ask — "running", when execution resumes —
  // repaints things idle while it is in fact waiting for the user.
  if (S.pendingAsk && st && st.kind !== "ask") { S.deferredStatus = st; return; }

  S.lastStatus = st;
  setEdge(st && st.kind);

  var text = (st && st.text) || "";
  if (!text) return;

  // Consecutive identical messages are noise; refresh the existing one instead.
  var box = part("toasts");
  var last = box && box.lastElementChild;
  var lastText = last && last.querySelector && last.querySelector(".toast-body");
  if (lastText && lastText.textContent === text) return;

  pushToast(text, st && st.kind);
  var chip = part("chip");
  if (chip) chip.classList.remove("dim");

  if (S._dimT) clearTimeout(S._dimT);
  S._dimT = setTimeout(function () {
    guard("chipDim", function () { var c = part("chip"); if (c && !S.pendingAsk) c.classList.add("dim"); });
  }, CFG.idleMs);
}

function applyAsk(ask) {
  var wasAsking = !!S.pendingAsk;
  S.pendingAsk = ask;

  var panel = part("panel"), q = part("q");
  if (panel) panel.classList.toggle("show", !!ask);
  if (q && ask) q.textContent = ask.instruction;

  if (ask) {
    clearToasts();                                 // the panel replaces the stream
    var chip = part("chip"); if (chip) chip.classList.remove("dim");
    setEdge("ask");
    return;
  }

  setEdge(null);
  if (wasAsking) {
    var next = S.deferredStatus || null;
    S.deferredStatus = null;
    if (next) applyStatus(next);
    else { var c = part("chip"); if (c) c.classList.add("dim"); }
  }
}

S.setStatus = function (text, kind) { guard("setStatus", function () { mountChrome(); applyStatus({ text: text, kind: kind }); }); return true; };
S.addActivity = function () { return false; };
S.setSessionPanel = function (data) { guard("sessionPanel", function () { S.panelState = data || {}; renderPanel(S.panelState); }); return true; };
S.toggleSessionPanel = function () {
  guard("toggleSessionPanel", function () {
    mountChrome();
    var panel = part("activity-panel");
    if (!panel) return;
    var hidden = panel.classList.toggle("hidden");
    try { localStorage.setItem(panelStorageKey(PANEL_VIS_KEY), hidden ? "0" : "1"); } catch (_) {}
  });
  return true;
};
S.ask       = function (instruction) { guard("ask", function () { mountChrome(); applyAsk({ instruction: instruction }); }); return true; };
S.clearAsk  = function () { guard("clearAsk", function () { applyAsk(null); }); return true; };

/** True when nothing but the border and a dimmed chip is showing. */
S.isCollapsed = function () {
  var box = part("toasts"), p = part("panel");
  var noToasts = !box || box.children.length === 0;
  var side = part("activity-panel");
  return !!(noToasts && p && !p.classList.contains("show") && side && side.classList.contains("collapsed"));
};

S.collapse = function () {
  guard("collapse", function () {
    if (S.pendingAsk) return;
    clearToasts();
    var c = part("chip"); if (c) c.classList.add("dim");
    var side = part("activity-panel");
    var toggle = part("activity-toggle");
    if (side && !side.classList.contains("collapsed")) {
      side.classList.add("collapsed");
      if (toggle) { toggle.textContent = "+"; toggle.setAttribute("aria-label", "Expand DevCDP panel"); }
      try { localStorage.setItem(PANEL_KEY + (CFG.sessionId || "default"), "1"); } catch (_) {}
    }
  });
  return true;
};

/** What we currently draw over the page — used by the footprint test. */
S.footprint = function () {
  var out = { edgeBorderPx: 1, occluding: [] };
  ["chip", "toasts", "panel", "activity-panel"].forEach(function (id) {
    var el = part(id);
    if (!el) return;
    if (id === "toasts" && el.children.length === 0) return;
    if (id === "panel" && !el.classList.contains("show")) return;
    var r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    if (id === "activity-panel" && el.classList.contains("collapsed")) return;
    var entry = { part: id === "toasts" ? "toast" : id,
      w: Math.round(r.width), h: Math.round(r.height), area: Math.round(r.width * r.height) };
    if (id === "toasts") entry.messages = el.children.length;
    out.occluding.push(entry);
  });
  out.totalArea = out.occluding.reduce(function (n, o) { return n + o.area; }, 0);
  return out;
};

if (!S.installed.badge && CFG.badge) {
  whenBody(function () {
    guard("badge", function () {
      mountChrome();
      // Single-page apps routinely replace body; keep our layer attached without
      // fighting them.
      if (!S._badgeIv) {
        S._badgeIv = setInterval(function () {
          guard("badgeWatchdog", function () {
            var h = document.getElementById("devcdp-badge-host");
            if ((!h || !h.isConnected) && document.body) mountChrome();
          });
        }, 2000);
      }
      var chip = part("chip"); if (chip) chip.classList.add("dim");
      S.installed.badge = true;
    });
  });
}

// ── 5. marker for the companion extension (F2 tab grouping) ─────────────────
// The extension has no channel to the server process, so we leave a DOM marker
// and it reacts. An attribute on <html> survives body rewrites and SPA routing.
// This ran at document-start and gave up when documentElement was null — which it is,
// at document-start, on every navigation. The null check then skipped silently and
// nothing retried, so the marker existed only on pages we injected into after load.
// Consequence: tab grouping worked on the tab you attached to and never again after a
// navigation, which is precisely the SPY-1 mistake this file was rewritten to avoid —
// assuming the DOM is there instead of waiting for it.
if (!S.installed.marker) {
  whenBody(function () {
    var de = document.documentElement;
    if (!de) return;
    de.setAttribute("data-devcdp-session", CFG.label || "DevCDP");
    de.setAttribute("data-devcdp-session-id", CFG.sessionId || "");
    de.setAttribute("data-devcdp-session-no", String(CFG.sessionNumber || ""));
    de.setAttribute("data-devcdp-group-mode", CFG.tabGroupMode || "session");
    S.installed.marker = true;
  });
}

// ── 6. owner liveness: the overlay must never outlive the session that drew it ──
//
// A graceful detach tears this down. A killed, crashed, or hung server does not —
// which used to leave a permanent border on the tab announcing a session that no
// longer existed, in that session's colour. An indicator you cannot trust is worse
// than none, so the overlay now expires on its own unless the owner keeps beating.
//
// Two things must not be mistaken for a dead owner:
//   • a breakpoint pause — no page JS runs, so no beat can arrive and no timer fires
//   • a backgrounded tab — Chrome throttles timers to about once a minute
//
// Rebasing whenever a tick arrives late looked like the fix, but it is not: in a
// background tab every tick is late, so the overlay would never expire there — and a
// background tab is exactly where a stranded overlay sits unnoticed. Instead, require
// two consecutive ticks to agree that nothing has beaten. A pause produces no ticks
// at all, and the first tick after a resume is followed by a beat, so a live session
// never reaches two. A dead one always does, throttled or not.
S.beat = function () { S.lastBeat = Date.now(); S._misses = 0; return true; };
S.lastBeat = Date.now();
S._misses = 0;

if (!S.installed.liveness) {
  guard("liveness", function () {
    var TICK  = 4000;
    var GRACE = Math.max(20000, (CFG.ownerTimeoutMs || 45000));
    S._liveIv = setInterval(function () {
      guard("livenessTick", function () {
        if (Date.now() - S.lastBeat < GRACE) { S._misses = 0; return; }
        S._misses++;
        if (S._misses < 2) return;
        // Nobody has beaten for two rounds. Remove ourselves; a returning session
        // reinjects a fresh agent on attach, so this is recoverable, not final.
        if (S._liveIv) { clearInterval(S._liveIv); S._liveIv = null; }
        S.teardown();
      });
    }, TICK);
    S.installed.liveness = true;
  });
}

S.teardown = function () {
  guard("teardown", function () {
    if (S._liveIv) { clearInterval(S._liveIv); S._liveIv = null; }
    try { S._mo && S._mo.disconnect(); } catch (_) {}
    try { S._dlgObs && S._dlgObs.disconnect(); } catch (_) {}
    if (S._badgeIv) { clearInterval(S._badgeIv); S._badgeIv = null; }
    var h = document.getElementById("devcdp-badge-host");
    if (h && h.parentNode) h.parentNode.removeChild(h);
    var de = document.documentElement;
    if (de) {
      de.removeAttribute("data-devcdp-session");
      de.removeAttribute("data-devcdp-session-id");
      de.removeAttribute("data-devcdp-session-no");
      de.removeAttribute("data-devcdp-group-mode");
    }
    S.installed = {};
  });
  return true;
};

S.ready  = Object.keys(S.installed).length > 0;
S.report = function () {
  return { version: S.version, installed: S.installed, label: S.label, ready: S.ready,
           dialogSelectors: STANDARD_SELECTORS.length };
};

} catch (e) {
  // Absolute last resort: never surface as an app console error (SPY-4).
  try {
    window[CFG.bindingName] && window[CFG.bindingName](
      JSON.stringify({ type: "agent_error", feature: "bootstrap", message: String((e && e.message) || e) })
    );
  } catch (_) {}
}
})();`;
}

/** Expression that reports what actually installed — used by tests and health checks. */
export const AGENT_REPORT_EXPR =
  `(window.__devcdp && window.__devcdp.report) ? JSON.stringify(window.__devcdp.report()) : "null"`;
