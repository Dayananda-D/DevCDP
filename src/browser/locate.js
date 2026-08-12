// ─── Locating and qualifying an element to act on ────────────────────────────
//
// This is the half of interaction that is not "send an event". Dispatching input is
// trivial; deciding *when* it is safe to dispatch is the entire problem, and skipping
// it is the difference between automation that is fast and automation that is fast and
// wrong. A click sent at a button that is still sliding into place lands on whatever
// was underneath it a moment ago, and the failure is silent — the page simply does
// something else, or nothing.
//
// So every interaction goes through the same gate:
//
//   1. resolve   selector / text / testid / role, piercing shadow roots and skipping
//                DevCDP's own overlay
//   2. scroll    bring it into the viewport, because input is dispatched at viewport
//                coordinates and an off-screen element has none that mean anything
//   3. stable    the box must be in the same place two samples running — this is what
//                catches animations, lazy layout and virtualised grids mid-scroll
//   4. visible   rendered, non-zero, not display:none / visibility:hidden / opacity:0
//   5. enabled   not [disabled], not aria-disabled, not inert
//   6. hit-test  elementFromPoint at the exact click point must be the target or
//                inside it. This is the one that catches the real-world failures:
//                a modal backdrop, a sticky header, a toast, a spinner overlay
//
// Steps 3-6 are re-checked on every poll rather than once, because a page that is
// still settling will pass any single one of them at some point.
//
// The functions here are stringified into the page, not imported — they run inside
// the tab. Keep them ES5-flavoured and dependency-free for the same reason the rest
// of src/browser does.

/** Shared preamble: every helper the resolver and the gate need, as page source. */
export const LOCATE_SOURCE = `
var DEVCDP_OWN = '[data-devcdp]';

/**
 * Does this node belong to DevCDP's own overlay rather than the application?
 *
 * closest() stops at a shadow boundary, and the overlay lives inside a shadow root —
 * so a plain closest() check sees the host as ours and everything *inside* it as the
 * application's. That is not theoretical: the status toast for a fill reads
 * "filled Reference", so a subsequent text:'Reference' matched our own toast instead
 * of the field, and reported that a <div> has no value to set. Walk out through each
 * shadow root's host until we run out of document.
 */
function ours(el) {
  try {
    var n = el;
    while (n) {
      if (n.nodeType === 1) {
        if (n.hasAttribute && n.hasAttribute('data-devcdp')) return true;
        if (n.closest && n.closest(DEVCDP_OWN)) return true;
      }
      var root = n.getRootNode ? n.getRootNode() : null;
      n = root && root.host ? root.host : null;      // shadow root → its host, else stop
    }
  } catch (_) {}
  return false;
}

/**
 * querySelectorAll that descends into open shadow roots.
 *
 * Component frameworks put the actual <button> inside a shadow root, where a plain
 * querySelectorAll cannot see it — the selector looks wrong when the element is
 * simply behind a boundary. Closed roots stay invisible, and nothing can change that.
 */
function deepQueryAll(root, sel, out, budget) {
  out = out || []; budget = budget || { n: 0 };
  if (budget.n++ > 20000) return out;
  var found;
  try { found = root.querySelectorAll(sel); } catch (e) { throw e; }
  for (var i = 0; i < found.length; i++) if (!ours(found[i])) out.push(found[i]);
  var all;
  try { all = root.querySelectorAll('*'); } catch (_) { return out; }
  for (var j = 0; j < all.length; j++) {
    // Never descend into our own overlay: cheaper than filtering its contents back
    // out afterwards, and it cannot be the thing the caller meant.
    if (all[j].shadowRoot && !ours(all[j])) deepQueryAll(all[j].shadowRoot, sel, out, budget);
  }
  return out;
}

function isVisible(el) {
  if (!el || !el.isConnected || el.nodeType !== 1) return false;
  var cs; try { cs = getComputedStyle(el); } catch (_) { return false; }
  if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  if (parseFloat(cs.opacity || '1') === 0) return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  var r; try { r = el.getBoundingClientRect(); } catch (_) { return false; }
  return r.width >= 1 && r.height >= 1;
}

/**
 * Disabled in every way a real application expresses it.
 *
 * The native property alone is not enough: frameworks that build controls out of
 * divs cannot set it, so they use aria-disabled or a class, and a click on one of
 * those "does nothing" in a way that looks exactly like a broken selector.
 */
function isDisabled(el) {
  if (!el) return true;
  if (el.disabled === true) return true;
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
  if (el.closest && el.closest('[inert]')) return true;
  if (el.closest && el.closest('fieldset[disabled]')) return true;
  return false;
}

/**
 * What a person would call this element.
 *
 * For a control the answer is its label, and the label has to outrank its current
 * value — otherwise a field is findable by name only while it is empty, and the moment
 * anything types into it, text:'Reference' stops matching and starts matching whatever
 * was typed. Value is kept as a last resort, for controls with no label at all.
 */
function textOf(el) {
  var t = '';
  try { t = (el.innerText || el.textContent || '').trim(); } catch (_) {}
  if (t) return t.replace(/\\s+/g, ' ');

  try {
    t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.placeholder || '').trim();

    // The two ways HTML actually associates a label with a control.
    if (!t && el.id) {
      var esc = (window.CSS && CSS.escape) ? CSS.escape(el.id) : el.id.replace(/["\\\\]/g, '\\\\$&');
      var lab = document.querySelector('label[for="' + esc + '"]');
      if (lab) t = (lab.textContent || '').trim();
    }
    if (!t && el.closest) {
      var wrap = el.closest('label');
      if (wrap) t = (wrap.textContent || '').trim();
    }
    if (!t) t = String(el.value || el.name || '').trim();
  } catch (_) {}
  return t.replace(/\\s+/g, ' ');
}

function describe(el) {
  if (!el) return null;
  var d = { tag: el.tagName ? el.tagName.toLowerCase() : '?' };
  try { if (el.id) d.id = el.id; } catch (_) {}
  try { if (typeof el.className === 'string' && el.className.trim()) d.classes = el.className.trim().slice(0, 120); } catch (_) {}
  var t = textOf(el); if (t) d.text = t.slice(0, 80);
  try { var role = el.getAttribute && el.getAttribute('role'); if (role) d.role = role; } catch (_) {}
  return d;
}

/** The smallest CSS path that identifies this element again — for reporting only. */
function pathOf(el) {
  var parts = [], node = el, depth = 0;
  while (node && node.nodeType === 1 && depth++ < 5) {
    var seg = node.tagName.toLowerCase();
    if (node.id) { parts.unshift(seg + '#' + node.id); break; }
    var cls = (typeof node.className === 'string' ? node.className.trim().split(/\\s+/)[0] : '');
    if (cls) seg += '.' + cls;
    parts.unshift(seg);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/**
 * Find candidates for a target description.
 *
 * Accepts the three ways a person actually identifies a control: a CSS selector, the
 * text they can see on it, or a test attribute. Text matching is deliberate about
 * *which* element it returns — the innermost one whose own text matches, because
 * matching on textContent alone returns <body> for every query.
 */
function locate(spec) {
  var out = [];

  if (spec.selector) {
    out = deepQueryAll(document, spec.selector);
  } else if (spec.testid) {
    var attrs = spec.testAttributes || ['data-testid'];
    for (var a = 0; a < attrs.length && !out.length; a++) {
      out = deepQueryAll(document, '[' + attrs[a] + '=' + JSON.stringify(spec.testid) + ']');
    }
  } else if (spec.text) {
    var needle = String(spec.text).toLowerCase();
    var exact  = !!spec.exact;
    var all = deepQueryAll(document, '*');
    var hits = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      // Containers match everything their children say; only take a node whose own
      // rendered text is the match.
      var own = textOf(el).toLowerCase();
      if (!own) continue;
      var ok = exact ? own === needle : own.indexOf(needle) !== -1;
      if (!ok) continue;
      // Prefer the innermost: drop any candidate that contains another candidate.
      hits.push(el);
    }
    for (var h = 0; h < hits.length; h++) {
      var inner = false;
      for (var k = 0; k < hits.length; k++) {
        if (k !== h && hits[h].contains(hits[k])) { inner = true; break; }
      }
      if (!inner) out.push(hits[h]);
    }
    // A label is not the control. If the match is a <label>, follow it.
    for (var m = 0; m < out.length; m++) {
      var e = out[m];
      if (e.tagName === 'LABEL') {
        var forId = e.getAttribute('for');
        var ctrl = forId ? document.getElementById(forId) : e.querySelector('input,select,textarea,button');
        if (ctrl) out[m] = ctrl;
      }
    }
  }

  if (spec.role) {
    out = out.filter(function (el) {
      try { return (el.getAttribute('role') || '') === spec.role; } catch (_) { return false; }
    });
  }
  if (spec.visible_only !== false) {
    var vis = out.filter(isVisible);
    // Only narrow to visible matches if there are any — otherwise the report would
    // say "nothing matched" when the truth is "it is there but hidden", which sends
    // the reader after the wrong problem.
    if (vis.length) out = vis;
  }
  return out;
}

/**
 * Where to aim.
 *
 * The centre is right almost always, and wrong in one common case: a wide element
 * whose centre is covered by something else (a sticky column header over a grid row,
 * a badge over a card). So the centre is offered first and a small set of fallbacks
 * follow, all inside the element.
 */
function aimPoints(r) {
  var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return [
    { x: cx, y: cy },
    { x: r.left + Math.min(12, r.width / 4),  y: cy },
    { x: r.right - Math.min(12, r.width / 4), y: cy },
    { x: cx, y: r.top + Math.min(8, r.height / 4) },
    { x: cx, y: r.bottom - Math.min(8, r.height / 4) },
  ];
}

/**
 * One actionability sample: is this element ready to receive input right now, and if
 * not, precisely what is stopping it?
 *
 * Returns viewport coordinates on success. The caller polls this; a single pass is
 * never enough, because "not ready yet" and "never going to be ready" look identical
 * in one frame.
 */
function qualify(el, opts) {
  opts = opts || {};
  if (!el || !el.isConnected) return { ready: false, why: 'detached', detail: 'The element is no longer in the document.' };

  if (opts.scroll !== false) {
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }
    catch (_) { try { el.scrollIntoView(); } catch (__) {} }
  }

  if (!isVisible(el)) return { ready: false, why: 'hidden', detail: 'Present in the DOM but not rendered.', node: describe(el) };
  if (opts.requireEnabled !== false && isDisabled(el)) {
    return { ready: false, why: 'disabled', detail: 'The control is disabled, so input would be ignored.', node: describe(el) };
  }

  var r; try { r = el.getBoundingClientRect(); } catch (_) { return { ready: false, why: 'no-box' }; }

  // Still off-screen after scrolling means a scroll container that did not move —
  // worth saying, because the usual cause is a virtualised list.
  if (r.bottom < 0 || r.top > (window.innerHeight || 0) || r.right < 0 || r.left > (window.innerWidth || 0)) {
    return { ready: false, why: 'offscreen', detail: 'Outside the viewport even after scrolling into view.', rect: box(r) };
  }

  // Hit-testing happens in this frame's coordinates; dispatch happens in the page's.
  var off = frameOffset();

  if (opts.hitTest === false) {
    var c = aimPoints(r)[0];
    return { ready: true, x: c.x + off.dx, y: c.y + off.dy, rect: box(r), node: describe(el),
             frameOffset: off.dx || off.dy ? off : undefined };
  }

  var points = aimPoints(r), blocker = null;
  for (var i = 0; i < points.length; i++) {
    var p = points[i];
    var top = null;
    try { top = document.elementFromPoint(p.x, p.y); } catch (_) {}
    if (!top) continue;
    if (top === el || el.contains(top) || top.contains(el)) {
      return { ready: true, x: p.x + off.dx, y: p.y + off.dy, rect: box(r), node: describe(el),
               aimedAt: i === 0 ? 'centre' : 'offset',
               frameOffset: (off.dx || off.dy || off.crossOrigin) ? off : undefined };
    }
    // Our own overlay is never a legitimate blocker: it is click-through by design,
    // so if it is on top something has gone wrong in the overlay, not the app.
    if (!blocker) blocker = { node: describe(top), path: pathOf(top), isDevCdpOverlay: ours(top) };
  }
  return {
    ready: false, why: 'covered', rect: box(r), node: describe(el),
    detail: 'Something else is on top of this element at every point we would click.',
    blockedBy: blocker,
  };
}

function box(r) {
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
}

/**
 * How far this frame's coordinate space is from the page's.
 *
 * getBoundingClientRect and elementFromPoint are both relative to the *frame* the code
 * runs in, but Input.dispatchMouseEvent takes coordinates in the top-level page. Act on
 * something inside an iframe without correcting for that and the click lands wherever
 * the frame's offset happens to put it — usually in the page chrome above the app,
 * which is the kind of miss that looks like the selector was wrong.
 *
 * Cross-origin frames deny access to frameElement, so the offset is unknowable from
 * inside; that is reported rather than guessed.
 */
function frameOffset() {
  var dx = 0, dy = 0, w = window;
  try {
    while (w !== w.parent) {
      var fe = w.frameElement;                     // throws across an origin boundary
      if (!fe) return { dx: dx, dy: dy, crossOrigin: true };
      var fr = fe.getBoundingClientRect();
      dx += fr.left; dy += fr.top;
      w = w.parent;
    }
  } catch (_) { return { dx: dx, dy: dy, crossOrigin: true }; }
  return { dx: dx, dy: dy, crossOrigin: false };
}
`;

/**
 * Build the page expression that resolves a target and takes one actionability sample.
 *
 * Returns JSON, not an object: a DOM element cannot cross the CDP boundary, so every
 * decision that needs the element itself has to be made in the page, and only the
 * verdict comes back.
 */
export function qualifyExpression(spec, opts = {}) {
  return `(function(){
    ${LOCATE_SOURCE}
    try {
      var spec = ${JSON.stringify(spec)};
      var matches;
      try { matches = locate(spec); }
      catch (e) { return JSON.stringify({ found: 0, selectorError: String(e.message || e) }); }

      if (!matches.length) return JSON.stringify({ found: 0 });

      var index = ${Number(opts.nth) || 0};
      if (index >= matches.length) {
        return JSON.stringify({ found: matches.length, indexOutOfRange: true,
          candidates: matches.slice(0, 5).map(describe) });
      }
      var el = matches[index];
      var q = qualify(el, ${JSON.stringify({
        scroll: opts.scroll !== false,
        hitTest: opts.hitTest !== false,
        requireEnabled: opts.requireEnabled !== false,
      })});
      q.found = matches.length;
      if (matches.length > 1) q.candidates = matches.slice(0, 5).map(describe);
      q.path = pathOf(el);
      return JSON.stringify(q);
    } catch (e) {
      return JSON.stringify({ found: 0, error: String(e && e.message || e) });
    }
  })()`;
}

/**
 * Run `fn` against the located element in the page and return its result.
 *
 * Some interactions cannot be expressed as synthesised input — reading a <select>'s
 * options, setting a native value so the framework's change detection sees it — and
 * those need the element in hand rather than coordinates.
 */
export function withElementExpression(spec, opts = {}, body) {
  return `(function(){
    ${LOCATE_SOURCE}
    try {
      var spec = ${JSON.stringify(spec)};
      var matches = locate(spec);
      if (!matches.length) return JSON.stringify({ found: 0 });
      var el = matches[${Number(opts.nth) || 0}];
      if (!el) return JSON.stringify({ found: matches.length, indexOutOfRange: true });
      var out = (function(el){ ${body} })(el);
      out = out || {};
      out.found = matches.length;
      out.node = describe(el);
      return JSON.stringify(out);
    } catch (e) {
      return JSON.stringify({ found: 0, error: String(e && e.message || e) });
    }
  })()`;
}
