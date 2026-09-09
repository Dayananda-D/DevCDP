// ─── DOM tools ───────────────────────────────────────────────────────────────
// DOM-1: v4 hardcoded six computed style properties and only ever evaluated in
// the main frame, so anything rendered in an iframe was invisible with no hint
// that a frame boundary existed.
// SPY-5: visibility was tested with `offsetParent !== null`, which is always null
// for position:fixed elements — so fixed modals read as hidden.

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";

/** Execution contexts to run against, per the `frame` argument. */
function contextsFor(ctx, frame) {
  const all = [...ctx.contexts.values()].filter(c => c.isDefault);
  if (frame === "all") return all;
  if (frame && frame !== "main") {
    const hit = all.filter(c => (c.origin || "").includes(frame) || (c.name || "").includes(frame));
    if (!hit.length) {
      fail(CODES.NO_TARGET, `No frame matches "${frame}".`,
        "Call dom_list_frames to see what is available, or use frame:'all'.",
        { frames: all.map(c => ({ origin: c.origin, name: c.name })) });
    }
    return hit;
  }
  return [];   // main frame — let CDP use the default context
}

async function evalIn(ctx, expression, context) {
  const { result, exceptionDetails } = await ctx.conn.eval(expression, {
    contextId: context ? context.id : undefined,
    label: context ? `query in frame ${context.origin}` : "DOM query",
  });
  if (exceptionDetails) {
    return { error: exceptionDetails.exception?.description?.split("\n")[0] || exceptionDetails.text };
  }
  return { value: result.value };
}

const VISIBLE_FN = `function(el){
  if(!el||!el.isConnected||el.nodeType!==1)return false;
  var cs;try{cs=getComputedStyle(el)}catch(_){return false}
  if(!cs||cs.display==='none'||cs.visibility==='hidden'||cs.visibility==='collapse')return false;
  if(parseFloat(cs.opacity||'1')===0)return false;
  if(el.getAttribute&&el.getAttribute('aria-hidden')==='true')return false;
  var r;try{r=el.getBoundingClientRect()}catch(_){return false}
  return r.width>=1&&r.height>=1;
}`;

/**
 * Why did a selector match nothing?
 *
 * Three causes look identical from a bare `count: 0`, and only one of them was ever
 * reported: the selector is invalid, the content is in an iframe, or the page simply
 * does not use that element — a framework that renders its controls as divs has no
 * <button> anywhere, and answering "0" to dom_query('button') on a screen full of
 * buttons invites exactly the wrong conclusion. So look, and say which it is.
 */
async function explainNoMatch(args, ctx) {
  const probe = `(function(){
    var sel = ${JSON.stringify(args.selector)};
    var out = { valid: true, elements: document.querySelectorAll('*').length, alternatives: {} };
    try { document.querySelector(sel); } catch (e) { out.valid = false; out.error = String(e.message || e); return JSON.stringify(out); }
    // For a bare tag name, the usual reason is that the app builds that control from
    // something else. Report generic equivalents rather than guessing at a framework.
    if (/^[a-z][a-z0-9-]*$/.test(sel)) {
      var tries = ['[role="' + sel + '"]', '[class*="' + sel + '" i]', '[id*="' + sel + '" i]'];
      if (sel === 'button') tries.push('a[href]', 'input[type=button]', 'input[type=submit]', '[onclick]');
      for (var i = 0; i < tries.length; i++) {
        try { var n = document.querySelectorAll(tries[i]).length; if (n) out.alternatives[tries[i]] = n; } catch (_) {}
      }
    }
    return JSON.stringify(out);
  })()`;

  let info = {};
  try { info = JSON.parse(await ctx.conn.evalQuiet(probe, 3000) || "{}"); } catch (_) {}

  if (info.valid === false) {
    return { hint: `That is not a valid CSS selector: ${info.error}. dom_query takes CSS, not XPath or a text query.` };
  }

  const alts = Object.entries(info.alternatives || {});
  if (alts.length) {
    return {
      hint: `Nothing matches "${args.selector}" on this page, but these do: `
          + alts.map(([k, v]) => `${k} (${v})`).join(", ")
          + ". The application builds those controls from other elements, so there are none of that tag to find.",
      nextStep: "app_discover lists selectors that actually work on this screen, taken from the live page.",
    };
  }

  if (args.frame === "main" && ctx.contexts.size > 1) {
    return { hint: `Nothing matches "${args.selector}" in the main frame, and this page has iframes. Retry with frame:'all'.` };
  }
  if (!info.elements) {
    return { hint: "The page appears to be empty — it may still be loading, or the tab may have navigated." };
  }
  return {
    hint: `Nothing matches "${args.selector}" anywhere in this page (${info.elements} elements present).`,
    nextStep: "app_discover lists selectors taken from the live page; dom_get_html shows the real markup around a landmark.",
  };
}

defineTool({
  name: "dom_query",
  readOnly: true,
  description:
    "Query elements by CSS selector and return tag, id, classes, text, attributes, geometry and real visibility. "
    + "Ask for computed styles by naming the properties you want. Set frame:'all' to search inside iframes too — "
    + "single-page apps often render the screen you care about in a child frame.",
  args: {
    selector:       { type: "string",  description: "CSS selector.", required: true },
    limit:          { type: "number",  description: "Maximum elements to return.", default: 10, min: 1, max: 200 },
    fields:         { type: "array",   description: "Restrict the returned keys, e.g. ['tag','id','text','visible'].", items: { type: "string" } },
    styles:         { type: "array",   description: "Computed style properties to read, e.g. ['display','zIndex','color'].", items: { type: "string" } },
    visible_only:   { type: "boolean", description: "Drop elements that are not actually rendered.", default: false },
    include_attrs:  { type: "boolean", description: "Include every HTML attribute of each match. Off by default: attributes dominate the response on real apps.", default: false },
    include_html:   { type: "boolean", description: "Include a truncated outerHTML for each match.", default: false },
    frame:          { type: "string",  description: "'main' (default), 'all', or a substring of a frame's origin/name.", default: "main" },
  },
  async handler(args, ctx) {
    const expr = `(function(){
      var visible = ${VISIBLE_FN};
      var out=[], els;
      try { els = Array.prototype.slice.call(document.querySelectorAll(${JSON.stringify(args.selector)})); }
      catch(e){ return { selectorError: e.message }; }
      var total = els.length;
      for (var i=0;i<els.length && out.length<${args.limit};i++){
        var el=els[i];
        if (el.closest && el.closest('[data-devcdp]')) continue;
        var vis = visible(el);
        if (${args.visible_only ? "true" : "false"} && !vis) continue;
        var attrs;
        if (${args.include_attrs ? "true" : "false"}) {
          attrs = {};
          for (var a=0;a<el.attributes.length;a++) attrs[el.attributes[a].name]=el.attributes[a].value;
        }
        var r={}; try{ var b=el.getBoundingClientRect(); r={x:Math.round(b.x),y:Math.round(b.y),w:Math.round(b.width),h:Math.round(b.height)};}catch(_){}
        var item={
          tag: el.tagName.toLowerCase(),
          id: el.id||undefined,
          classes: (typeof el.className==='string'&&el.className.trim())?el.className.trim():undefined,
          text: (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,200)||undefined,
          value: (el.value!==undefined&&el.type!=='password')?String(el.value).slice(0,120):undefined,
          disabled: el.disabled===true?true:undefined,
          visible: vis,
          rect: r,
          attrs: attrs
        };
        ${args.include_html ? "try{item.html=el.outerHTML.slice(0,1200)}catch(_){}" : ""}
        var want=${JSON.stringify(args.styles || [])};
        if (want.length){ item.styles={}; try{ var cs=getComputedStyle(el); for(var s=0;s<want.length;s++) item.styles[want[s]]=cs[want[s]]; }catch(_){} }
        out.push(item);
      }
      return { total: total, elements: out };
    })()`;

    const targets = contextsFor(ctx, args.frame);
    const runs = targets.length ? targets : [null];
    const perFrame = [];
    let all = [], total = 0;

    for (const c of runs) {
      const { value, error } = await evalIn(ctx, expr, c);
      if (error) { perFrame.push({ frame: c?.origin || "main", error }); continue; }
      if (value?.selectorError) {
        fail(CODES.BAD_ARGS, `Invalid CSS selector: ${value.selectorError}`, "Check quoting and bracket syntax.");
      }
      total += value?.total || 0;
      const tagged = (value?.elements || []).map(e => (runs.length > 1 ? { ...e, frame: c?.origin || "main" } : e));
      all = all.concat(tagged);
      perFrame.push({ frame: c?.origin || "main", matched: value?.total || 0 });
    }

    if (args.fields?.length) {
      const keep = new Set(args.fields);
      all = all.map(e => Object.fromEntries(Object.entries(e).filter(([k]) => keep.has(k))));
    }

    // Let the human watching see what we just looked at.
    if (all.length && args.frame === "main") {
      ctx.conn.showInspected(args.selector, { label: `${all.length} match${all.length === 1 ? "" : "es"}` }).catch(() => {});
    }

    // Nothing matched. Say why, rather than guessing.
    //
    // This used to blame iframes whenever the page had any — true, but usually
    // irrelevant, and it sent the caller off to retry with frame:'all' for a selector
    // that matches nothing anywhere. Measured on a real application: dom_query('button')
    // returned a bare count of 0 on a screen with 48 clickable controls, because the
    // framework builds them from divs. "No buttons on this page" is the wrong conclusion
    // and it is the obvious one to draw.
    let empty = null;
    if (total === 0) {
      empty = await explainNoMatch(args, ctx);
    }

    return {
      count: all.length,
      ...(total > all.length ? { matchedInPage: total } : {}),
      elements: all,
      ...(runs.length > 1 ? { frames: perFrame } : {}),
      ...(empty || {}),
    };
  },
});

defineTool({
  name: "dom_list_frames",
  readOnly: true,
  description:
    "List the frames and JavaScript execution contexts in the attached tab. Use it when a selector finds nothing — "
    + "the content may live in an iframe, which needs frame:'all' on dom_query.",
  async handler(_args, ctx) {
    let tree = null;
    try { tree = await ctx.conn.client.Page.getFrameTree(); } catch (_) {}

    const flatten = (node, depth = 0, out = []) => {
      if (!node) return out;
      out.push({
        depth,
        frameId: node.frame.id,
        url: node.frame.url,
        name: node.frame.name || null,
        securityOrigin: node.frame.securityOrigin,
        isMain: depth === 0,
      });
      for (const child of node.childFrames || []) flatten(child, depth + 1, out);
      return out;
    };

    const frames = tree ? flatten(tree.frameTree) : [];
    const contexts = [...ctx.contexts.values()];

    return {
      frameCount: frames.length,
      frames,
      executionContexts: contexts.map(c => ({ origin: c.origin, name: c.name, frameId: c.frameId, isDefault: c.isDefault })),
      note: frames.length > 1
        ? "This page has child frames. dom_query and console_evaluate use the main frame unless you pass frame:'all'."
        : "Single frame — the main frame is all there is.",
    };
  },
});

defineTool({
  name: "dom_get_html",
  readOnly: true,
  description:
    "Get the inner or outer HTML of the first element matching a selector, truncated to a byte budget. Useful for "
    + "understanding structure you cannot infer from dom_query alone.",
  args: {
    selector:   { type: "string",  description: "CSS selector.", required: true },
    inner:      { type: "boolean", description: "innerHTML instead of outerHTML.", default: false },
    max_bytes:  { type: "number",  description: "Truncate beyond this many characters.", default: 4000, min: 100, max: 200000 },
    frame:      { type: "string",  description: "'main' (default), or a substring of a frame's origin/name.", default: "main" },
  },
  async handler(args, ctx) {
    const targets = contextsFor(ctx, args.frame === "all" ? "all" : args.frame);
    const expr = `(function(){
      var el=document.querySelector(${JSON.stringify(args.selector)});
      if(!el) return null;
      var h=el.${args.inner ? "innerHTML" : "outerHTML"}||"";
      return { html:h.slice(0,${args.max_bytes}), length:h.length };
    })()`;

    for (const c of (targets.length ? targets : [null])) {
      const { value } = await evalIn(ctx, expr, c);
      if (value) {
        return {
          selector: args.selector,
          frame: c?.origin || "main",
          html: value.html,
          ...(value.length > args.max_bytes ? { truncated: true, totalLength: value.length } : {}),
        };
      }
    }

    fail(CODES.NO_TARGET, `No element matches "${args.selector}".`,
      ctx.contexts.size > 1
        ? "This page has iframes — try frame:'all' on dom_query first to locate it."
        : "Verify the selector with dom_query.");
  },
});

defineTool({
  name: "dom_get_mutations",
  readOnly: true,
  description:
    "DOM changes recorded since the last call — what was added, removed or re-attributed, and where. Use it after an "
    + "action to see whether the app re-rendered at all, which distinguishes 'handler never ran' from 'handler ran "
    + "and produced nothing'.",
  args: {
    limit: { type: "number",  description: "Maximum records to return.", default: 30, min: 1, max: 400 },
    clear: { type: "boolean", description: "Drain the buffer as you read it.", default: true },
  },
  async handler(args, ctx) {
    const stats = ctx.mutations.stats();
    const items = ctx.mutations.items.slice(-args.limit);
    if (args.clear) ctx.mutations.clear();

    const agent = await ctx.conn.agentReport();
    return {
      count: items.length,
      mutations: items,
      ...(stats.dropped ? { evicted: stats.dropped } : {}),
      ...(!items.length && !agent?.installed?.mutations
        ? { warning: "The in-page mutation observer is not installed, so this will always be empty. Call devtools_status for the agent report." }
        : {}),
    };
  },
});

defineTool({
  name: "dialog_detect",
  readOnly: true,
  description:
    "Detect modal dialogs, alerts and confirmation overlays that are visible right now, with their title, message "
    + "and button labels. Detection is structural — ARIA roles, the dialog element, and stacked-overlay geometry — "
    + "so it works regardless of which UI framework drew it. Call it after any action that might raise a prompt.",
  args: {
    frame: { type: "string", description: "'main' (default) or 'all' to include iframes.", default: "all" },
  },
  async handler(args, ctx) {
    const expr = `(window.__devcdp && window.__devcdp.scanDialogs) ? JSON.stringify(window.__devcdp.scanDialogs()) : "__no_agent__"`;
    const targets = args.frame === "all" ? contextsFor(ctx, "all") : [];
    const found = [];
    let agentMissing = false;

    for (const c of (targets.length ? targets : [null])) {
      const { value } = await evalIn(ctx, expr, c);
      if (value === "__no_agent__" || value == null) { agentMissing = true; continue; }
      try {
        for (const d of JSON.parse(value)) found.push({ ...d, frame: c?.origin || "main" });
      } catch (_) {}
    }

    return {
      count: found.length,
      dialogs: found.map(d => ({
        ...d,
        dismissWith: d.buttons?.length
          ? `Click the "${d.buttons[0]}" button — with an automation driver, target by role/text rather than by class.`
          : "No button found; this overlay may close on outside click or Escape.",
      })),
      ...(agentMissing && !found.length
        ? { warning: "The in-page agent did not answer in one or more frames, so this result may be incomplete. Check devtools_status." }
        : {}),
      note: found.length
        ? "Browser-level alert/confirm/prompt dialogs are auto-accepted by DevCDP and appear in session_get_activity instead."
        : "No in-page dialog visible.",
    };
  },
});
