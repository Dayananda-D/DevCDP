// ─── Discovery tools ─────────────────────────────────────────────────────────
// These replace v4's static knowledge. It shipped a hand-written selector
// cheatsheet for one company's UI, seeded into memory as if it had been learned
// (APP-1), and it referenced automation helpers that did not exist. It also
// hardcoded that company's internal help URL and fetched it on every first
// connect (HELP-3).
//
// Nothing is hardcoded here. The page is asked what it is, the API surface is
// derived from traffic the app actually made plus standard OpenAPI discovery
// paths, and domain vocabulary comes from the project's own documentation. That
// works for any app, and stays correct as the app changes.

import fs   from "fs";
import path from "path";
import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";
import { log } from "../core/log.js";

// ─── app_discover ────────────────────────────────────────────────────────────

const DISCOVERY_EXPR = `JSON.stringify((function(){
  function vis(el){
    if(!el||!el.isConnected)return false;
    var cs;try{cs=getComputedStyle(el)}catch(_){return false}
    if(!cs||cs.display==='none'||cs.visibility==='hidden')return false;
    var r;try{r=el.getBoundingClientRect()}catch(_){return false}
    return r.width>=1&&r.height>=1;
  }
  var TEST_ATTRS=['data-testid','data-test-id','data-test','data-qa','data-cy','data-automation-id'];
  function sel(el){
    for(var i=0;i<TEST_ATTRS.length;i++){var v=el.getAttribute&&el.getAttribute(TEST_ATTRS[i]);if(v)return '['+TEST_ATTRS[i]+'="'+v+'"]';}
    if(el.id)return '#'+el.id;
    var n=el.getAttribute&&el.getAttribute('name');if(n)return el.tagName.toLowerCase()+'[name="'+n+'"]';
    var al=el.getAttribute&&el.getAttribute('aria-label');if(al)return '[aria-label="'+al+'"]';
    var c=(typeof el.className==='string'&&el.className.trim())?el.className.trim().split(/\\s+/)[0]:null;
    return c?el.tagName.toLowerCase()+'.'+c:el.tagName.toLowerCase();
  }
  function label(el){
    var t=(el.textContent||'').trim().replace(/\\s+/g,' ');
    if(t)return t.slice(0,60);
    return (el.getAttribute&&(el.getAttribute('aria-label')||el.getAttribute('title')||el.getAttribute('placeholder')))||'';
  }

  // Which UI libraries are present, with a version where one is cheap to read —
  // "Ext JS 7.9.0" tells you which documentation to open; a bare name does not.
  //
  // Two faults this list had, both found against a real enterprise application:
  // it reported "Web Components" for a page whose ONLY shadow root was DevCDP's own
  // indicator — the tool detecting itself and naming a framework that was not there —
  // and it had no probe for the framework the application actually used, so the answer
  // was wrong in both directions at once. Nothing here is app-specific: it is a long
  // list of public global signatures, and adding to it is how it stays useful.
  var OURS = "devcdp-badge-host";
  var PROBES=[
    ['React',   function(){return !!(window.__REACT_DEVTOOLS_GLOBAL_HOOK__||document.querySelector('[data-reactroot],#root ._reactRootContainer'))},
                function(){return window.React&&window.React.version}],
    ['Vue',     function(){return !!(window.__VUE__||window.Vue||document.querySelector('[data-v-app],#app.__vue__'))},
                function(){return window.Vue&&window.Vue.version}],
    ['Angular', function(){return !!(window.ng||window.getAllAngularRootElements||document.querySelector('[ng-version]'))},
                function(){var e=document.querySelector('[ng-version]');return e&&e.getAttribute('ng-version')}],
    ['Svelte',  function(){return !!document.querySelector('[class*="svelte-"]')}],
    ['Ember',   function(){return !!window.Ember},   function(){return window.Ember&&window.Ember.VERSION}],
    ['Ext JS',  function(){return !!(window.Ext&&(window.Ext.getVersion||window.Ext.versions))},
                function(){try{return window.Ext.getVersion().version}catch(_){return null}}],
    ['Dojo',    function(){return !!(window.dojo||window.dijit)}, function(){return window.dojo&&window.dojo.version&&String(window.dojo.version)}],
    ['jQuery',  function(){return !!window.jQuery}, function(){return window.jQuery&&window.jQuery.fn&&window.jQuery.fn.jquery}],
    ['Backbone',function(){return !!window.Backbone}, function(){return window.Backbone&&window.Backbone.VERSION}],
    ['Knockout',function(){return !!window.ko}, function(){return window.ko&&window.ko.version}],
    ['Alpine',  function(){return !!window.Alpine}, function(){return window.Alpine&&window.Alpine.version}],
    ['htmx',    function(){return !!window.htmx}, function(){return window.htmx&&window.htmx.version}],
    ['Web Components', function(){
      // A real custom element, and never our own indicator.
      var u=document.querySelectorAll(':not(:defined)');
      for(var i=0;i<u.length;i++){if(u[i].id!==OURS&&u[i].tagName.indexOf('-')>-1)return true}
      var all=document.querySelectorAll('*');
      for(var j=0;j<all.length;j++){
        if(all[j].shadowRoot&&all[j].id!==OURS&&all[j].tagName.indexOf('-')>-1)return true
      }
      return false
    }]
  ];
  var frameworks=[];
  for(var p=0;p<PROBES.length;p++){
    try{
      if(!PROBES[p][1]())continue;
      var v=null; if(PROBES[p][2]){try{v=PROBES[p][2]()}catch(_){}}
      frameworks.push(v?PROBES[p][0]+' '+v:PROBES[p][0]);
    }catch(_){}
  }

  var out={
    url:location.href, title:document.title, readyState:document.readyState,
    routing: location.hash&&location.hash.length>1 ? 'hash' : 'path',
    frameworks: frameworks,
    frames: (function(){try{return document.querySelectorAll('iframe').length}catch(_){return 0}})(),
    scriptTags: document.scripts.length
  };

  // Interactive surface, with usable selectors — the discovered replacement for
  // a hand-written cheatsheet.
  try{
    var btns=[],seen={};
    var bn=document.querySelectorAll('button,[role="button"],input[type="submit"],input[type="button"],a[role="button"]');
    for(var i=0;i<bn.length&&btns.length<25;i++){
      if(!vis(bn[i]))continue;
      var l=label(bn[i]); if(!l||seen[l])continue; seen[l]=1;
      btns.push({label:l,selector:sel(bn[i]),disabled:bn[i].disabled===true||undefined});
    }
    out.buttons=btns;
  }catch(_){}

  try{
    var fields=[];
    var fn=document.querySelectorAll('input,select,textarea,[contenteditable="true"]');
    for(var j=0;j<fn.length&&fields.length<25;j++){
      var f=fn[j]; if(!vis(f)||f.type==='hidden')continue;
      var lbl='';
      try{
        if(f.labels&&f.labels[0])lbl=(f.labels[0].textContent||'').trim().slice(0,50);
        if(!lbl)lbl=f.getAttribute('aria-label')||f.getAttribute('placeholder')||f.getAttribute('name')||'';
      }catch(_){}
      fields.push({label:lbl,type:f.type||f.tagName.toLowerCase(),selector:sel(f),required:f.required||undefined});
    }
    out.fields=fields;
  }catch(_){}

  try{
    var grids=[];
    var gn=document.querySelectorAll('table,[role="grid"],[role="table"],[role="treegrid"]');
    for(var g=0;g<gn.length&&grids.length<10;g++){
      if(!vis(gn[g]))continue;
      var rows=gn[g].querySelectorAll('tr,[role="row"]').length;
      grids.push({selector:sel(gn[g]),rows:rows,role:gn[g].getAttribute('role')||'table'});
    }
    out.grids=grids;

    var tabs=[];
    var tn=document.querySelectorAll('[role="tab"]');
    for(var t=0;t<tn.length&&tabs.length<20;t++){ if(vis(tn[t])) tabs.push({label:label(tn[t]),selector:sel(tn[t]),selected:tn[t].getAttribute('aria-selected')==='true'||undefined}); }
    out.tabs=tabs;

    out.landmarks=Array.prototype.slice.call(document.querySelectorAll('[role="navigation"],[role="main"],nav,main,header,footer'))
      .filter(vis).slice(0,10).map(function(e){return {tag:e.tagName.toLowerCase(),role:e.getAttribute('role')||undefined,selector:sel(e)}});
  }catch(_){}

  // Storage keys often name the app's domain concepts. Keys only, never values.
  try{
    out.storageKeys={local:Object.keys(localStorage||{}).slice(0,30),session:Object.keys(sessionStorage||{}).slice(0,30)};
  }catch(_){}

  return out;
})())`;

defineTool({
  name: "app_discover",
  readOnly: true,
  description:
    "Ask the running page what it is: which UI libraries it uses, how it routes, how many frames it has, and its "
    + "actual interactive surface — visible buttons, fields, grids and tabs with working selectors. Call this once "
    + "before driving an unfamiliar app, instead of guessing selectors.",
  async handler(_args, ctx) {
    const { result, exceptionDetails } = await ctx.conn.eval(DISCOVERY_EXPR, {
      timeoutMs: 10000, label: "app_discover",
    });
    if (exceptionDetails) {
      fail(CODES.EVAL_FAILED, `Discovery failed: ${exceptionDetails.text}`, "The page may still be loading — retry after page_reload.");
    }

    const info = JSON.parse(result.value || "{}");
    ctx.discovered.app = { ...info, at: new Date().toISOString() };

    return {
      ...info,
      counts: {
        buttons: info.buttons?.length || 0,
        fields: info.fields?.length || 0,
        grids: info.grids?.length || 0,
        tabs: info.tabs?.length || 0,
      },
      guidance: [
        "Selectors above are read from this page right now — prefer them over guesses.",
        info.frames > 0 ? `This page has ${info.frames} iframe(s); use frame:'all' on dom_query if a selector finds nothing.` : null,
        info.routing === "hash" ? "Routing is hash-based, so navigation may not fire a full page load — watch network instead of load events." : null,
      ].filter(Boolean),
    };
  },
});

// ─── api_discover ────────────────────────────────────────────────────────────

function summariseEndpoints(requests) {
  const groups = new Map();
  for (const r of requests) {
    let u;
    try { u = new URL(r.url); } catch (_) { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;

    // Collapse ids so /orders/1041 and /orders/1042 become one endpoint.
    const generic = u.pathname
      .replace(/\/\d+(?=\/|$)/g, "/{id}")
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi, "/{uuid}")
      .replace(/\/[0-9a-f]{24,}(?=\/|$)/gi, "/{hash}");

    const key = `${r.method} ${u.origin}${generic}`;
    if (!groups.has(key)) {
      groups.set(key, {
        method: r.method, origin: u.origin, path: generic,
        calls: 0, statuses: {}, avgMs: 0, totalMs: 0, failures: 0,
        queryParams: new Set(), contentTypes: new Set(),
      });
    }
    const g = groups.get(key);
    g.calls++;
    if (r.status != null) g.statuses[r.status] = (g.statuses[r.status] || 0) + 1;
    if (r.error || (r.status != null && r.status >= 400)) g.failures++;
    if (r.durationMs) { g.totalMs += r.durationMs; g.avgMs = Math.round(g.totalMs / g.calls); }
    for (const k of u.searchParams.keys()) g.queryParams.add(k);
    if (r.mimeType) g.contentTypes.add(r.mimeType);
  }

  return [...groups.values()]
    .map(g => ({
      method: g.method, origin: g.origin, path: g.path, calls: g.calls,
      statuses: g.statuses, avgMs: g.avgMs || undefined,
      failures: g.failures || undefined,
      queryParams: g.queryParams.size ? [...g.queryParams].slice(0, 12) : undefined,
      contentTypes: g.contentTypes.size ? [...g.contentTypes].slice(0, 3) : undefined,
    }))
    .sort((a, b) => b.calls - a.calls);
}

defineTool({
  name: "api_discover",
  readOnly: true,
  description:
    "Build a map of the backend the page actually talks to: endpoints grouped with ids collapsed, call counts, status "
    + "codes, timings and failures — plus an OpenAPI/Swagger specification if the server publishes one at a standard "
    + "path. Use it to understand the API surface, and to see at a glance which calls are failing.",
  args: {
    probe_openapi: { type: "boolean", description: "Also try standard OpenAPI discovery paths on the page's origin.", default: true },
    include_static:{ type: "boolean", description: "Include scripts, styles, images and fonts, not just data calls.", default: false },
  },
  async handler(args, ctx) {
    let requests = ctx.network.all();
    if (!args.include_static) {
      requests = requests.filter(r =>
        !["Script", "Stylesheet", "Image", "Font", "Media", "Manifest"].includes(r.type) &&
        !/\.(js|mjs|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|map)(\?|$)/i.test(r.url));
    }

    const endpoints = summariseEndpoints(requests);
    let openapi = null;

    if (args.probe_openapi && ctx.conn.targetUrl) {
      let origin = null;
      try { origin = new URL(ctx.conn.targetUrl).origin; } catch (_) {}
      if (origin) {
        for (const p of ctx.cfg.apiProbePaths) {
          try {
            const { result } = await ctx.conn.eval(
              `fetch(${JSON.stringify(origin + p)},{credentials:"include"})
                .then(r=>r.ok?r.text():null).then(t=>t?t.slice(0,200000):null).catch(()=>null)`,
              { awaitPromise: true, timeoutMs: 8000, label: `OpenAPI probe ${p}` });
            if (!result.value) continue;
            let spec;
            try { spec = JSON.parse(result.value); } catch (_) { continue; }
            if (!spec || (!spec.openapi && !spec.swagger)) continue;

            const paths = Object.entries(spec.paths || {}).slice(0, 60).map(([p2, ops]) => ({
              path: p2,
              methods: Object.keys(ops || {}).filter(m => /^(get|post|put|patch|delete|head|options)$/i.test(m)),
              summary: Object.values(ops || {})[0]?.summary || undefined,
            }));
            openapi = {
              foundAt: origin + p,
              version: spec.openapi || spec.swagger,
              title: spec.info?.title, apiVersion: spec.info?.version,
              serverCount: (spec.servers || []).length,
              pathCount: Object.keys(spec.paths || {}).length,
              schemaCount: Object.keys(spec.components?.schemas || spec.definitions || {}).length,
              paths,
            };
            log.info("discover", `OpenAPI found at ${p}`);
            break;
          } catch (_) {}
        }
      }
    }

    ctx.discovered.api = { endpoints, openapi, at: new Date().toISOString() };
    const failing = endpoints.filter(e => e.failures);

    return {
      observedEndpoints: endpoints.length,
      fromRequests: requests.length,
      endpoints: endpoints.slice(0, 40),
      ...(failing.length ? { failing, note: `${failing.length} endpoint(s) returned errors — likely where to look first.` } : {}),
      openapi: openapi || undefined,
      ...(!openapi && args.probe_openapi
        ? { openapiNote: "No specification found at the standard paths. Add yours to apiProbePaths in your settings file if it lives elsewhere; devcdp_settings shows which file is in effect." }
        : {}),
      ...(!requests.length
        ? { warning: "No requests captured. Capture starts when DevCDP attaches — call page_reload, or exercise the feature, then try again." }
        : {}),
    };
  },
});

// ─── docs_search ─────────────────────────────────────────────────────────────

const DOC_EXT = /\.(md|mdx|markdown|rst|txt|adoc)$/i;
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|coverage|vendor|\.next|\.venv|__pycache__|target)$/i;

function walkDocs(root, { maxFiles = 400, maxDepth = 6 } = {}) {
  const found = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (found.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (SKIP_DIR.test(e.name)) continue;
        visit(path.join(dir, e.name), depth + 1);
      } else if (DOC_EXT.test(e.name)) {
        found.push(path.join(dir, e.name));
      }
    }
  };
  visit(root, 0);
  return found;
}

defineTool({
  name: "docs_search",
  readOnly: true,
  description:
    "Search the project's own documentation — README and any markdown/text/pdf docs under the configured docs root — and "
    + "return matching passages with file and line. Use it to learn what a screen, field or business term means in "
    + "this app, instead of inferring it from the UI. Set docsRoot in your settings file if the docs live elsewhere.",
  needsClient: false,
  args: {
    query:       { type: "string", description: "Words or a phrase to look for.", required: true },
    max_results: { type: "number", description: "Maximum passages to return.", default: 12, min: 1, max: 60 },
    context_lines:{ type: "number", description: "Lines of surrounding context per hit.", default: 4, min: 0, max: 30 },
    root:        { type: "string", description: "Override the docs root for this call." },
  },
  async handler(args, ctx) {
    const root = args.root || ctx.cfg.docsRoot;
    if (!root) {
      fail(CODES.UNSUPPORTED,
        "No documentation root is configured, so there is nothing to search.",
        'Set "docsRoot" in your settings file (or DEVCDP_DOCS_ROOT) to the app\'s repository, or pass root to this call. '
        + 'devcdp_settings shows which file is in effect and devcdp_settings_init writes one.');
    }
    if (!fs.existsSync(root)) {
      fail(CODES.IO_FAILED, `The documentation root does not exist: ${root}`, "Correct docsRoot in your settings file — devcdp_settings shows which one is in effect.");
    }

    const files = walkDocs(root);
    const terms = args.query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];

    for (const file of files) {
      if (hits.length >= args.max_results) break;
      let text = "";
      try { text = fs.readFileSync(file, "utf8"); } catch (_) { continue; }
      const lines = text.split(/\r?\n/);

      for (let i = 0; i < lines.length && hits.length < args.max_results; i++) {
        const lower = lines[i].toLowerCase();
        const matched = terms.filter(t => lower.includes(t));
        if (!matched.length) continue;
        // Require a strong-ish match on multi-word queries.
        if (terms.length > 1 && matched.length < Math.ceil(terms.length / 2)) continue;

        const from = Math.max(0, i - args.context_lines);
        const to   = Math.min(lines.length, i + args.context_lines + 1);
        hits.push({
          file: path.relative(root, file).replace(/\\/g, "/"),
          line: i + 1,
          matchedTerms: matched,
          excerpt: lines.slice(from, to).join("\n").slice(0, 1200),
        });
      }
    }

    ctx.discovered.docs = { root, fileCount: files.length, at: new Date().toISOString() };

    return {
      query: args.query,
      root,
      filesSearched: files.length,
      count: hits.length,
      results: hits,
      ...(!files.length ? { warning: `No documentation files found under ${root}.` } : {}),
      ...(!hits.length && files.length
        ? { hint: `Searched ${files.length} file(s) with no match. Try a single distinctive word, or a term from the UI.` }
        : {}),
    };
  },
});

defineTool({
  name: "docs_outline",
  readOnly: true,
  description:
    "List the documentation available under the docs root, with each file's headings, so you can see what the project "
    + "documents before searching. A good first call when you do not yet know the app's vocabulary.",
  needsClient: false,
  args: {
    max_files: { type: "number", description: "Maximum files to describe.", default: 40, min: 1, max: 200 },
    root:      { type: "string", description: "Override the docs root for this call." },
  },
  async handler(args, ctx) {
    const root = args.root || ctx.cfg.docsRoot;
    if (!root) {
      fail(CODES.UNSUPPORTED, "No documentation root is configured.",
        'Set "docsRoot" in your settings file, or pass root to this call.');
    }

    const files = walkDocs(root).slice(0, args.max_files);
    const outline = files.map(file => {
      let headings = [];
      try {
        const text = fs.readFileSync(file, "utf8");
        headings = text.split(/\r?\n/)
          .map((l, i) => ({ l, i }))
          .filter(x => /^#{1,3}\s+\S/.test(x.l))
          .slice(0, 25)
          .map(x => ({ level: (x.l.match(/^#+/) || [""])[0].length, text: x.l.replace(/^#+\s*/, "").slice(0, 100), line: x.i + 1 }));
      } catch (_) {}
      return { file: path.relative(root, file).replace(/\\/g, "/"), headings };
    });

    return {
      root,
      fileCount: files.length,
      docs: outline,
      nextStep: "Use docs_search with a term from these headings to read the relevant passage.",
    };
  },
});
