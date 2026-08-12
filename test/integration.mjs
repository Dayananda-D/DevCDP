// ─── Integration test ────────────────────────────────────────────────────────
// Every assertion here maps to a specific P0/P1 in BACKLOG.md. The point is that
// each of those bugs shipped because nothing exercised the real thing against a
// real browser — so this launches Chrome, loads a fixture app, and attaches AFTER
// the page has finished loading, which is precisely the case v4 got wrong.

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import CDP from "chrome-remote-interface";

import { startFixture, LINES, ORIGINAL_PATH, SHARED_TERM, MODULE_COUNT, VENDOR_PATH } from "./fixture-app/server.mjs";
import { createContext } from "../src/core/context.js";
import { Connection }    from "../src/cdp/connection.js";
import { MemoryStore }   from "../src/store/memory.js";
import { launchChrome, findFreePort, findExtensionCapableChrome } from "../src/cdp/launch.js";
import { liveClaims, releaseClaimFile, reapClosedTabs } from "../src/cdp/registry.js";
import { getTool, resolveArgs, shape, capResponse } from "../src/core/tools.js";
import { annotateResponse } from "../src/server.js";

import "../src/tools/connect.js";
import "../src/tools/console.js";
import "../src/tools/network.js";
import "../src/tools/dom.js";
import "../src/tools/sources.js";
import "../src/tools/debugger.js";
import "../src/tools/session.js";
import "../src/tools/memory.js";
import "../src/tools/discover.js";
import "../src/tools/guide.js";
import "../src/tools/settings.js";

const REGISTRY_DIR = path.join(os.tmpdir(), `devcdp-test-registry-${process.pid}`);
process.env.DEVCDP_REGISTRY_DIR = REGISTRY_DIR;

let passed = 0, failed = 0;
const skipped = [];
const results = [];

async function check(name, fn) {
  try { await fn(); process.stdout.write(`  ok   ${name}\n`); passed++; results.push({ name, ok: true }); }
  catch (e) { process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); failed++; results.push({ name, ok: false, error: e.message }); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Call a tool the way the MCP dispatcher does, so arg resolution is exercised. */
async function call(ctx, name, rawArgs = {}) {
  const tool = getTool(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const args = resolveArgs(tool, rawArgs);
  if (tool.needsClient) await ctx.conn.ensure();
  return tool.handler(args, ctx);
}

/**
 * A call through the response-shaping path the server really uses, including the
 * annotations that say *how* it was answered (_userActed, _recovered, _retried).
 * `call` invokes handlers directly, which is fine for testing what a tool returns but
 * cannot see anything the dispatcher adds afterwards.
 */
async function dispatch(name, rawArgs = {}) {
  const tool = getTool(name);
  const args = resolveArgs(tool, rawArgs);
  if (tool.needsClient) await ctx.conn.ensure();
  const result = await tool.handler(args, ctx);
  return annotateResponse(capResponse(shape(tool, result, args), ctx.cfg.maxResponseBytes, name), ctx);
}

/**
 * Claims belonging to this test run only.
 *
 * Claims are recorded machine-wide, which is right for the product — a session
 * number has to be unique across every browser you have open — but it means a
 * developer who happens to be using DevCDP on their own app while running this suite
 * saw four F1 tests fail for no reason. Scope every count to the port we launched.
 */
let testPort = null;
const ourClaims = () => liveClaims().filter(c => c.port === testPort);

/** Wait for a condition, so tests do not depend on fixed sleeps. */
async function until(fn, { timeout = 8000, interval = 120, what = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}`);
}

process.stdout.write("\nDevCDP integration test\n\n");

const fixture = await startFixture();
process.stdout.write(`  fixture app on ${fixture.origin}\n`);

let chrome = null, ctx = null, ctx2 = null;

try {
  const memoryDir = path.join(os.tmpdir(), `devcdp-test-memory-${process.pid}`);
  const port = await findFreePort("localhost", [9350, 9380], new Set());
  testPort = port;

  // A previous run that was killed can leave a claim file behind, and on Windows a
  // recycled pid makes it look alive until its heartbeat goes stale — which showed up
  // as F1 tests failing on a claim count nobody in this run created. The port was
  // just confirmed free, so nothing legitimate can be holding a tab on it.
  for (const stale of liveClaims().filter(c => c.port === port)) {
    releaseClaimFile(port, stale.targetId);
    process.stdout.write(`  cleared a stale claim on port ${port} from pid ${stale.pid}\n`);
  }

  // A profile per run. The isolated profile is keyed by port and persists, so a
  // previous run's tabs could be restored into this one — which showed up as
  // "list_tabs returned 2 tabs, expected 1" and a phantom adopted tab.
  const profileBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-test-profile-"));

  ctx = createContext({ port, memoryDir, badge: true, chromeProfileBase: profileBase });
  ctx.conn   = new Connection(ctx);
  ctx.memory = new MemoryStore(ctx.cfg);

  chrome = await launchChrome({ port, cfg: ctx.cfg, url: fixture.origin });
  process.stdout.write(`  chrome on port ${port}${chrome.extensionLoaded ? " (extension loaded)" : ""}\n\n`);

  // Let the fixture finish loading BEFORE we attach — the v4 failure mode.
  await until(async () => {
    try {
      const targets = await CDP.List({ host: "localhost", port });
      return targets.some(t => t.type === "page" && t.url.startsWith(fixture.origin));
    } catch (_) { return false; }
  }, { what: "the fixture page to open" });
  await sleep(1200);

  // ── attach ────────────────────────────────────────────────────────────────
  const connected = await call(ctx, "devtools_connect", { port, target: `url-match:${fixture.origin}` });

  await check("attaches and reports which tab it chose (CONN-1)", () => {
    assert.equal(connected.connected, true);
    assert.ok(connected.url.startsWith(fixture.origin), `attached to ${connected.url}`);
    assert.ok(connected.selectedBy, "must say how the tab was selected");
  });

  await check("indexes scripts on an ALREADY-LOADED page (SRC-1)", () => {
    assert.ok(connected.scriptsIndexed > 0,
      `scriptsIndexed was ${connected.scriptsIndexed} — this is the exact v4 bug: 0 scripts on a loaded page`);
  });

  await check("reports the pre-attach boundary instead of pretending (OBS-1)", () => {
    assert.ok(connected.preAttach, "no preAttach block");
    assert.equal(connected.preAttach.consoleHistoryAvailable, false);
    assert.ok(connected.preAttach.resourcesLoadedBeforeAttach > 0, "should see resource timing from before attach");
    assert.match(connected.preAttach.note, /before this moment|reproduce/i);
  });

  await check("claims the tab and labels the session (F1)", () => {
    const claims = ourClaims();
    assert.equal(claims.length, 1, `expected 1 claim, got ${claims.length}`);
    assert.equal(claims[0].targetId, connected.targetId);
    assert.match(claims[0].label, /DevCDP · session \d+/);
  });

  // ── in-page agent ─────────────────────────────────────────────────────────
  const agent = await ctx.conn.agentReport();

  await check("in-page agent installs every feature (SPY-1)", () => {
    assert.ok(agent, "agent did not report at all");
    for (const feature of ["listeners", "mutations", "dialogs", "badge", "marker"]) {
      assert.equal(agent.installed[feature], true, `feature "${feature}" did not install`);
    }
  });

  await check("agent adds no errors to the app's console (SPY-4)", async () => {
    const logs = await call(ctx, "console_get_logs", { include_agent: true, limit: 50 });
    const ours = logs.logs.filter(l => l.source === "devcdp-agent" || /__devcdp/.test(l.text || ""));
    assert.deepEqual(ours, [], `agent polluted the console: ${JSON.stringify(ours)}`);
  });

  await check("badge is present and cannot intercept clicks (F2/SESS-2)", async () => {
    const shown = await call(ctx, "notify_user", { action: "debug", detail: "integration test running" });
    assert.equal(shown.shown, true, "badge did not accept a status update");
    const probe = await call(ctx, "console_evaluate", {
      expression: `(function(){var h=document.getElementById('devcdp-badge-host');
        if(!h) return 'missing';
        var r=h.shadowRoot, box=r.getElementById('toasts');
        return JSON.stringify({shadow:!!r,pointer:getComputedStyle(h).pointerEvents,
          text:box.lastElementChild?box.lastElementChild.textContent:"",
          toastOpacity:box.lastElementChild?getComputedStyle(box.lastElementChild).backgroundColor:"",
          edge:!!r.getElementById('edge'),
          edgeShadow:getComputedStyle(r.getElementById('edge')).boxShadow});})()`,
    });
    assert.notEqual(probe.value, "missing", "indicator host not in the DOM");
    const info = JSON.parse(probe.value);
    assert.equal(info.shadow, true, "must live in a shadow root so dom_query cannot see it");
    assert.equal(info.pointer, "none", "the layer must not intercept pointer events");
    assert.equal(info.edge, true, "presence is an edge border, not a panel");
    assert.match(info.edgeShadow, /inset/, "the border must be drawn inset so it displaces no layout");
    assert.match(info.text, /integration test running/);
    assert.match(info.toastOpacity, /rgba\(/, "status messages must be translucent, not a solid panel");
  });

  await check("the badge never swallows a click meant for the app (F2)", async () => {
    // The user's objection, as a permanent test: put a real app button underneath
    // the badge and fire genuine mouse events at it.
    await call(ctx, "console_evaluate", { expression: `
      window.__appHits = 0;
      var b = document.createElement('button');
      b.id = 'under-badge';
      b.style.cssText = 'position:fixed;inset:0;z-index:99999';   // whole viewport: our chrome sits in more than one corner
      b.addEventListener('click', function(){ window.__appHits++; });
      document.body.appendChild(b); 'ok'` });

    // The chip is the only thing we draw in the corner while idle; the toast and
    // panel appear above/below it. Clicking any of them must reach the app.
    const rect = async (id) => JSON.parse((await call(ctx, "console_evaluate", { expression:
      `(function(){var w=document.getElementById('devcdp-badge-host').shadowRoot.getElementById('${id}').getBoundingClientRect();
        return JSON.stringify({x:w.x,y:w.y,w:w.width,h:w.height});})()` })).value);
    const hits = async () => (await call(ctx, "console_evaluate", { expression: `window.__appHits` })).value;
    const clickAt = async (x, y) => {
      await ctx.conn.client.Input.dispatchMouseEvent({ type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await ctx.conn.client.Input.dispatchMouseEvent({ type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      await sleep(150);
    };

    // Delta-based, so an unrelated click elsewhere in the suite cannot skew it.
    const clicksThrough = async (id, label, offsetY = null) => {
      const before = await hits();
      const r = await rect(id);
      assert.ok(r.w > 0 && r.h > 0, `${label} has no measurable area (${r.w}x${r.h})`);
      const x = Math.round(r.x + r.w / 2);
      const y = Math.round(offsetY === null ? r.y + r.h / 2 : r.y + offsetY);
      await clickAt(x, y);
      const after = await hits();
      if (after - before !== 1) {
        // Say what was actually under the cursor, so a failure is diagnosable
        // rather than just "it did not work".
        const diag = (await call(ctx, "console_evaluate", { expression:
          `(function(){var e=document.elementFromPoint(${x},${y});
            return JSON.stringify({at:e?(e.id||e.tagName):'none',
              appButtonPresent:!!document.getElementById('under-badge'),
              hits:window.__appHits, viewport:[innerWidth,innerHeight]});})()` })).value;
        assert.fail(`a click on ${label} at (${x},${y}) did not reach the app (hits ${before} -> ${after}); ${diag}`);
      }
    };

    // Real mouse events need the tab in front. Without this the suite failed
    // whenever another browser window happened to take focus — a genuine flake, not
    // a finding about the badge.
    await ctx.conn.client.Page.bringToFront();
    await call(ctx, "notify_user", { action: "debug", detail: "click pass-through check" });
    await sleep(250);

    let hitsBeforeBtn;
    try {
      await clicksThrough("chip", "the identity chip");
      await clicksThrough("toasts", "a status toast");

      // Only the confirmation button may be interactive, and only while asking.
      await call(ctx, "session_ask_user", { instruction: "Confirm when ready." });
      await sleep(300);
      await clicksThrough("q", "the instruction text");
      hitsBeforeBtn = await hits();
    } catch (e) {
      // Clean up even on failure: a leftover full-viewport probe would break every
      // test after this one, which is exactly what happened the first time.
      await call(ctx, "console_evaluate", { expression:
        `(function(){var b=document.getElementById('under-badge');if(b)b.remove();return 'ok';})()` }).catch(() => {});
      await call(ctx, "console_evaluate", { expression:
        `(function(){var r=document.getElementById('devcdp-badge-host').shadowRoot.getElementById('btn');if(r)r.click();return 'ok';})()` }).catch(() => {});
      await call(ctx, "session_poll_user_action", {}).catch(() => {});
      throw e;
    }

    const btn = JSON.parse((await call(ctx, "console_evaluate", { expression:
      `(function(){var b=document.getElementById('devcdp-badge-host').shadowRoot.getElementById('btn').getBoundingClientRect();
        return JSON.stringify({x:b.x,y:b.y,w:b.width,h:b.height});})()` })).value);
    assert.ok(btn.w < 140 && btn.h < 40, `the one interactive area must stay small, was ${btn.w}x${btn.h}`);
    await clickAt(Math.round(btn.x + btn.w / 2), Math.round(btn.y + btn.h / 2));
    assert.equal(await hits(), hitsBeforeBtn, "the confirm button must not double-fire into the app");
    assert.equal((await call(ctx, "session_poll_user_action", {})).acted, true, "the confirm button must resolve the handover");

    await call(ctx, "console_evaluate", { expression: `document.getElementById('under-badge').remove(); 'ok'` });
  });

  await check("idle footprint is the border and a small chip only (F2)", async () => {
    const footprint = async () => JSON.parse((await call(ctx, "console_evaluate", {
      expression: `JSON.stringify(window.__devcdp.footprint())` })).value);

    await call(ctx, "notify_user", { action: "debug", detail: "busy for a moment" });
    await sleep(200);
    const active = await footprint();
    assert.ok(active.occluding.some(o => o.part === "toast"), "a status update must show a toast");

    await call(ctx, "console_evaluate", { expression: `window.__devcdp.collapse()` });
    await sleep(250);
    const idle = await footprint();
    assert.equal(idle.occluding.some(o => o.part === "toast"), false, "the toast must clear itself");
    assert.equal(idle.edgeBorderPx, 1, "presence should be a 1px border plus a soft fade, not a panel");

    const chip = idle.occluding.find(o => o.part === "chip");
    assert.ok(chip, "the identity chip should remain");
    assert.ok(chip.h <= 24, `the chip must stay small, was ${chip.w}x${chip.h}`);
    assert.ok(idle.totalArea < active.totalArea * 0.4,
      `idle footprint (${idle.totalArea}px2) should be far smaller than active (${active.totalArea}px2)`);

    await call(ctx, "notify_user", { action: "found", detail: "something to report" });
    await sleep(200);
    assert.equal((await footprint()).occluding.some(o => o.part === "toast"), true,
      "a new status must surface a toast again");
  });

  await check("Chrome renders the paused state natively, adding no DOM (F2)", async () => {
    assert.equal(ctx.conn.pausedOverlay, true, "the native paused overlay should be available");
    const count = async () => (await call(ctx, "console_evaluate", { expression: `document.querySelectorAll('*').length` })).value;
    const before = await count();

    // The banner must not be up while the page is running: setting it dims the
    // whole page, so an always-on banner would make every tab look frozen.
    assert.notEqual(ctx.conn.pausedMessageShown, true, "the paused banner must not be shown while running");

    await call(ctx, "debugger_set_breakpoint", { url: "/app.js", line: LINES.bundleThrow, auto_resume: false });
    ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('save').click()` }).catch(() => {});
    await until(async () => (await call(ctx, "debugger_get_state", {})).paused, { what: "the pause" });

    assert.equal(await count(), before, "the paused indicator must not add elements to the page");
    assert.equal(ctx.conn.pausedMessageShown, true, "the banner should be shown while genuinely paused");

    await call(ctx, "debugger_resume", {});
    await until(async () => ctx.conn.pausedMessageShown === false, { timeout: 4000, what: "the banner to clear" });

    // Leave nothing armed: a holding breakpoint left behind freezes later tests,
    // and a frozen page stops the timers they depend on.
    await call(ctx, "debugger_remove_all_breakpoints", {});
  });

  await check("a pending question is never hidden away", async () => {
    await call(ctx, "session_ask_user", { instruction: "Do not hide this." });
    await call(ctx, "console_evaluate", { expression: `window.__devcdp.collapse()` });
    await sleep(200);
    const shown = (await call(ctx, "console_evaluate", {
      expression: `document.getElementById('devcdp-badge-host').shadowRoot.getElementById('panel').classList.contains('show')`,
    })).value;
    assert.equal(shown, true, "an outstanding request to the user must stay visible");
    await call(ctx, "console_evaluate", {
      expression: `document.getElementById('devcdp-badge-host').shadowRoot.getElementById('btn').click(); 'ok'` });
    await call(ctx, "session_poll_user_action", {});
  });

  await check("interaction is shown with a cursor ring and a click ripple (F2)", async () => {
    await ctx.conn.client.Page.bringToFront();   // real mouse events need the tab in front
    const state = async () => JSON.parse((await call(ctx, "console_evaluate", {
      expression: `(function(){var r=document.getElementById('devcdp-badge-host').shadowRoot;
        return JSON.stringify({cursorOn:window.__devcdp.cursorVisible(),
          ripples:r.querySelectorAll('.rip').length,
          tip:r.getElementById('tip').textContent,
          cursorPointerEvents:getComputedStyle(r.getElementById('cur')).pointerEvents});})()` })).value);

    // A synthetic click, exactly as a driver would produce. Coordinates are read
    // directly rather than via dom_query, whose own highlight would race the tip.
    const box = JSON.parse((await call(ctx, "console_evaluate", { expression:
      `(function(){var r=document.querySelector("[data-testid='save-order']").getBoundingClientRect();
        return JSON.stringify({x:r.x,y:r.y,w:r.width,h:r.height});})()` })).value);
    const cx = Math.round(box.x + box.w / 2), cy = Math.round(box.y + box.h / 2);
    await ctx.conn.client.Input.dispatchMouseEvent({ type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
    // Read once, immediately: a ripple deliberately removes itself after ~600ms,
    // so polling for it races its own lifetime.
    const during = await state();
    await ctx.conn.client.Input.dispatchMouseEvent({ type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });

    assert.equal(during.cursorOn, true, "the cursor ring should appear where interaction happens");
    assert.ok(during.ripples >= 1, `a click should leave a visible ripple, saw ${during.ripples}`);
    assert.match(during.tip, /Save order/i, `the tip should name the element, was "${during.tip}"`);
    assert.equal(during.cursorPointerEvents, "none", "the cursor overlay must never take pointer events");

    await sleep(700);
    assert.equal((await state()).ripples, 0, "ripples must clean themselves up");
  });

  await check("dom_query flashes Chrome's own highlight, adding no DOM (F2)", async () => {
    const count = async () => (await call(ctx, "console_evaluate", { expression: `document.querySelectorAll('*').length` })).value;
    const before = await count();
    await call(ctx, "dom_query", { selector: "[data-testid='open-dialog']" });
    await sleep(300);
    assert.equal(await count(), before, "the inspector highlight must not add elements to the page");
    const tip = (await call(ctx, "console_evaluate", {
      expression: `document.getElementById('devcdp-badge-host').shadowRoot.getElementById('tip').textContent` })).value;
    assert.ok(tip, "the cursor should have been pointed at the inspected element");
  });

  await check("extension marker is set for tab grouping (F2)", async () => {
    const probe = await call(ctx, "console_evaluate", {
      expression: `document.documentElement.getAttribute('data-devcdp-session')`,
    });
    assert.match(String(probe.value), /DevCDP · session \d+/);
  });

  await check("companion extension really groups the tab (F2)", async () => {
    const targets = await CDP.List({ host: "localhost", port });
    const worker = targets.find(t => t.url?.startsWith("chrome-extension://") && /service_worker|background/i.test(t.type + t.url));
    const status = await until(async () => {
      const s = await call(ctx, "devtools_status", {});
      return s.tabGrouping?.grouped ? s : null;
    }, { timeout: 10000, what: "the extension to group the tab" })
      .catch(() => null);

    if (!status) {
      // Grouping is cosmetic; if this Chrome build refuses --load-extension we
      // must degrade gracefully rather than fail the debugger.
      const s = await call(ctx, "devtools_status", {});
      assert.equal(s.tabGrouping.markerPresent, true, "marker must still be set even without the extension");
      assert.ok(s.tabGrouping.note, "must explain that grouping is unavailable");
      process.stdout.write(`       note: extension did not group (worker target: ${worker ? "present" : "absent"}) — degraded cleanly\n`);
      return;
    }
    assert.ok(Number.isInteger(status.tabGrouping.groupId), "should report a real Chrome tab group id");
    assert.ok(status.tabGrouping.color, "group should be coloured per session");
  });

  // ── tabs ──────────────────────────────────────────────────────────────────
  await check("list_tabs actually returns the tabs (TOOL-1)", async () => {
    const res = await call(ctx, "list_tabs", { port });
    assert.ok(Array.isArray(res.tabs), "tabs array missing — the v4 bug");
    assert.ok(res.tabs.length >= 1);
    assert.equal(res.tabs.filter(t => t.claimedBy === "this session").length, 1);
  });

  // ── source maps ───────────────────────────────────────────────────────────
  await check("fetches an EXTERNAL source map and lists original files (SRC-2)", async () => {
    const files = await call(ctx, "source_list_files", {});
    assert.ok(files.sourceMapsLoaded >= 1, `no source map loaded (v4 skipped all external maps)`);
    assert.ok(files.files.some(f => f.path.includes(ORIGINAL_PATH)), `original file not listed: ${JSON.stringify(files.files)}`);
  });

  await check("reads the original file, clearly labelled as such", async () => {
    const file = await call(ctx, "source_get_file", { path: ORIGINAL_PATH });
    assert.equal(file.via, "sourceMap");
    assert.match(file.source, /Fixture source file/, "should return the original, header and all");
  });

  await check("source_search finds code by content across original files", async () => {
    const hits = await call(ctx, "source_search", { query: "payload.customer" });
    assert.ok(hits.count > 0, "found nothing");
    assert.ok(hits.results.some(r => r.kind === "original"), "should search original sources, not just bundles");
  });

  // Found in real use: on a page with many scripts and one source-mapped
  // third-party bundle, every search was answered out of that bundle's vendor files
  // and the application's own code was never looked at (SRC-5).
  await check("source_search reaches the app's own code, not just vendor files", async () => {
    const hits = await call(ctx, "source_search", { query: SHARED_TERM, max_results: 6 });
    assert.ok(hits.count > 0, `nothing matched ${SHARED_TERM}`);
    const vendor = hits.results.filter(r => /node_modules/.test(r.file));
    const app    = hits.results.filter(r => !/node_modules/.test(r.file));
    assert.ok(app.length > 0,
      `every hit came from vendor code — the app's own ${MODULE_COUNT} modules were never searched: `
      + JSON.stringify(hits.results.map(r => r.file)));
    assert.ok(app.length >= vendor.length,
      `vendor code outranked the application: ${vendor.length} vendor vs ${app.length} app hits`);
  });

  await check("source_search says so when it did not search everything (SRC-5)", async () => {
    const hits = await call(ctx, "source_search", { query: SHARED_TERM, max_results: 2 });
    assert.equal(hits.truncated, true, "a capped search must be flagged");
    assert.match(hits.note || "", /never searched/,
      "the note must say how much was left unsearched, or 2 hits reads as 'there are 2 places'");
  });

  await check("one crowded file cannot consume the whole result budget", async () => {
    // Every module mentions the term, so results must span files rather than
    // exhausting the first one.
    const hits = await call(ctx, "source_search", { query: SHARED_TERM, max_results: 20 });
    const files = new Set(hits.results.map(r => r.file));
    assert.ok(files.size >= 3, `all ${hits.count} hits came from ${files.size} file(s): ${[...files]}`);
  });

  await check("a repeated search refetches nothing", async () => {
    // Measured on the real application: a full scan of 1500 scripts was five seconds
    // of round trips, and the identical scan a moment later paid it all again. Assert
    // the mechanism, not the clock — on a fixture this small both runs are under a
    // millisecond and a timing comparison would only measure noise.
    const cold = await call(ctx, "source_search", { query: "zzz_absent_one_zzz", max_results: 40 });
    assert.equal(cold.count, 0);
    assert.ok(cold.searched.scripts >= MODULE_COUNT,
      `a full scan should cover every script, saw ${cold.searched.scripts}`);
    assert.ok(ctx.sourceCache?.map.size >= MODULE_COUNT,
      `the scan should have filled the cache, holds ${ctx.sourceCache?.map.size}`);

    const domain = ctx.conn.client.Debugger;
    const real = domain.getScriptSource.bind(domain);
    let fetches = 0;
    domain.getScriptSource = async (...a) => { fetches++; return real(...a); };
    try {
      const warm = await call(ctx, "source_search", { query: "zzz_absent_two_zzz", max_results: 40 });
      assert.ok(warm.searched.scripts >= MODULE_COUNT, "the second scan must still cover every script");
      assert.equal(fetches, 0, `a repeat scan refetched ${fetches} script(s) it already had`);
    } finally { domain.getScriptSource = real; }
  });

  // Found while debugging a real application: you can only set a breakpoint if you
  // already know the file and line, but what you actually have is a function name.
  // Searching for it by text is unreliable — a function assigned as `Ext.getCmp =
  // function` cannot be found by searching "getCmp: function", and that query returns
  // four unrelated methods on other classes instead (DBG-9).
  await check("sets a breakpoint from a function name alone (DBG-9)", async () => {
    const bp = await call(ctx, "debugger_set_breakpoint_at_function", {
      function_expression: "window.appModule3.resolveRecord" });
    assert.equal(bp.bound, true, `could not bind: ${JSON.stringify(bp)}`);
    assert.match(bp.foundAt.url, /module3\.js/, `found the wrong file: ${bp.foundAt.url}`);
    assert.ok(bp.foundAt.line > 0, "a line must be reported");

    // And it must actually be hit when the function runs.
    await call(ctx, "console_evaluate", { expression: `String(window.appModule3.resolveRecord({ id: 7 }).id)` });
    const cap = await call(ctx, "debugger_get_capture", {});
    assert.equal(cap.ready, true, "the breakpoint never fired");
    assert.ok((cap.frames || []).length >= 1, "no frames captured");
    assert.match(String(cap.frames[0].url), /module3\.js/, "paused in the wrong file");

    await call(ctx, "debugger_remove_breakpoint", { breakpoint_id: bp.breakpointId });
  });

  await check("says plainly when a function has no source to break on (DBG-9)", async () => {
    const native = await call(ctx, "debugger_set_breakpoint_at_function", {
      function_expression: "document.querySelector" }).catch(e => e);
    assert.equal(native.code, "SCRIPT_NOT_FOUND", `expected a clear refusal, got ${JSON.stringify(native)}`);
    assert.match(native.message, /built-in/, "the reason must be stated");

    const notFn = await call(ctx, "debugger_set_breakpoint_at_function", {
      function_expression: "window.appModule3.name" }).catch(e => e);
    assert.equal(notFn.code, "BAD_ARGS");
    assert.match(notFn.message, /not a function/);
  });

  // ── breakpoints ───────────────────────────────────────────────────────────
  await check("refuses to fake a breakpoint on a file that does not exist (DBG-1)", async () => {
    let threw = null;
    try { await call(ctx, "debugger_set_breakpoint", { url: "doesNotExist.js", line: 247 }); }
    catch (e) { threw = e; }
    assert.ok(threw, "v4 returned a breakpointId and resolvedLine:247 here — it must fail instead");
    assert.match(threw.message, /no loaded script matches/i);
    assert.ok(threw.hint, "must tell the caller how to find the real file");
  });

  await check("reports bound:false for an unreachable line rather than success (DBG-1)", async () => {
    const res = await call(ctx, "debugger_set_breakpoint", { url: "/app.js", line: 4 });   // "}" — not executable
    if (res.bound === false) {
      assert.ok(res.warning && /never be hit/i.test(res.warning), "an unbound breakpoint must say so loudly");
    } else {
      // Chrome sometimes slides to the next statement; that is legitimate, but it
      // must be reported as a move rather than silently.
      assert.ok(res.resolvedLine, "a bound breakpoint must report where it really landed");
    }
    if (res.breakpointId) await call(ctx, "debugger_remove_breakpoint", { breakpoint_id: res.breakpointId });
  });

  const bp = await call(ctx, "debugger_set_breakpoint", {
    url: ORIGINAL_PATH, line: LINES.originalPayload, auto_resume: true,
  });

  await check("sets a breakpoint by ORIGINAL file and line (SRC-3)", () => {
    assert.equal(bp.bound, true, `breakpoint not bound: ${JSON.stringify(bp)}`);
    assert.ok(bp.translation, "must report the original→bundle translation");
    assert.equal(bp.translation.to.line, LINES.bundlePayload,
      `original line ${LINES.originalPayload} should map to bundle line ${LINES.bundlePayload}, got ${bp.translation.to.line}`);
    assert.equal(bp.autoResume, true);
  });

  await check("maps the bound location back to the original file", () => {
    assert.ok(bp.originalLocation, "no originalLocation in the reply");
    assert.match(String(bp.originalLocation.source), new RegExp(ORIGINAL_PATH));
    assert.equal(bp.originalLocation.line, LINES.originalPayload);
  });

  // ── trigger the staged bug ────────────────────────────────────────────────
  await ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('save').click()`, awaitPromise: false });

  const capture = await until(async () => {
    const c = await call(ctx, "debugger_get_capture", {});
    return c.ready ? c : null;
  }, { what: "the breakpoint to fire" });

  await check("captures scope, logs and network at the pause in one call", () => {
    assert.equal(capture.ready, true);
    assert.ok(capture.frames?.length, "no frames captured");
    assert.ok(capture.logs, "no console block");
    assert.ok(capture.network, "no network block");
  });

  await check("every captured frame names its file, or says why not (DBG-7)", () => {
    // Chrome sends url:"" on CallFrame for source-mapped scripts, so trusting it
    // produced frames with no file and a badge reading "paused at :2".
    // A frame from Runtime.evaluate has no source file for real, and must say so
    // rather than look like a resolution failure.
    for (const f of capture.frames) {
      assert.ok(f.url || f.origin,
        `frame ${f.index} (${f.fn}) has neither a file nor an explanation`);
      if (!f.url) assert.match(f.origin, /evaluated|no source file/i);
    }
    assert.match(capture.frames[0].url, /app\.js$/, "the application frame must name its file");
  });

  await check("debugger_get_state names files too (DBG-7)", async () => {
    // auto_resume:false so the pause is still live when we look at it.
    await call(ctx, "debugger_set_breakpoint", { url: "/app.js", line: LINES.bundleThrow, auto_resume: false });
    ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('save').click()` }).catch(() => {});
    const state = await until(async () => {
      const s = await call(ctx, "debugger_get_state", {});
      return s.paused ? s : null;
    }, { what: "a live pause" });
    assert.ok(state.callStack[0].url, "call stack entries must name their file");
    const scope = await call(ctx, "debugger_get_scope", { frame_index: 0 });
    assert.ok(scope.frame.url, "debugger_get_scope must name the frame's file");
    await call(ctx, "debugger_resume", {});
  });

  await check("the border breathes while driving and goes still green on handover (UX-1)", async () => {
    const edge = async () => JSON.parse((await call(ctx, "console_evaluate", { expression:
      `(function(){var e=document.getElementById('devcdp-badge-host').shadowRoot.getElementById('edge');
        var cs=getComputedStyle(e);
        return JSON.stringify({cls:e.className,animation:cs.animationName,
          duration:cs.animationDuration,shadow:cs.boxShadow});})()` })).value);

    const driving = await edge();
    assert.notEqual(driving.animation, "none", "while DevCDP is driving the border must animate");
    assert.match(driving.animation, /devcdpBreathe/);
    assert.ok(parseFloat(driving.duration) >= 1.5,
      `the pulse must be a slow breath, not a flicker (${driving.duration})`);

    await call(ctx, "session_ask_user", { instruction: "Your turn — click Save when ready." });
    await sleep(300);
    const handover = await edge();

    assert.match(handover.cls, /ask/);
    assert.equal(handover.animation, "none", "on handover the border must be completely still");
    assert.match(handover.shadow, /rgb\(53,\s*199,\s*89\)/,
      `handover must be the green 'go ahead' colour, got ${handover.shadow}`);
    assert.notEqual(handover.shadow, driving.shadow, "the two states must look different");

    // Handing back must restore the breathing, not leave it frozen.
    await call(ctx, "console_evaluate", { expression:
      `document.getElementById('devcdp-badge-host').shadowRoot.getElementById('btn').click(), 'ok'` });
    await call(ctx, "session_poll_user_action", {});
    await sleep(300);
    const back = await edge();
    assert.notEqual(back.animation, "none", "after the handover ends the border must breathe again");
    assert.ok(!/rgb\(53,\s*199,\s*89\)/.test(back.shadow), "and drop the handover green");
  });

  await check("a pending question is not overwritten by status chatter (F2)", async () => {
    await call(ctx, "session_ask_user", { instruction: "Please sign in, then confirm." });
    // Exactly the race that broke it: an internal status update right afterwards.
    await call(ctx, "notify_user", { action: "debug", detail: "resuming" });
    const probe = await call(ctx, "console_evaluate", {
      expression: `(function(){var r=document.getElementById('devcdp-badge-host').shadowRoot;
        return JSON.stringify({edge:r.getElementById('edge').className,
          ask:r.getElementById('q').textContent,
          panelShown:r.getElementById('panel').classList.contains('show'),
          toastShown:r.getElementById('toasts').children.length > 0});})()`,
    });
    const ui = JSON.parse(probe.value);
    assert.equal(ui.panelShown, true, "the handover panel must be visible");
    assert.match(ui.edge, /ask/, `the border must show the waiting state, was "${ui.edge}"`);
    assert.match(ui.ask, /Please sign in/);
    assert.equal(ui.toastShown, false, "progress chatter must not sit on top of a question");
  });

  // Reported from real use: a tab still carrying a border and a session label hours
  // after that session was gone. A graceful detach cleans up; a killed process
  // cannot, so the overlay has to be able to give up on its own (UI-5).
  await check("an overlay removes itself once its session stops beating (UI-5)", async () => {
    const shown = () => ctx.conn.client.Runtime.evaluate({ returnByValue: true, expression:
      `!!document.getElementById('devcdp-badge-host')` }).then(r => r.result.value);

    assert.equal(await shown(), true, "the overlay should be up while we are driving");

    // The watchdog runs on a timer, and Chrome throttles timers in a background tab
    // to roughly once a minute — so the tab has to be in front for this to be quick.
    // (That throttling is the reason the watchdog counts missed rounds instead of
    // treating a late tick as a frozen page: in a background tab every tick is late.)
    await ctx.conn.client.Page.bringToFront();

    // Stop beating, which is what a dead session looks like from inside the page. The
    // keepalive has to be stopped as well as the clock wound back: this session is
    // genuinely alive, so a keepalive landing mid-wait would reset the miss count and
    // the overlay would rightly survive — that raced, and the test flaked.
    ctx.conn.stopKeepalive();
    try {
      await ctx.conn.client.Runtime.evaluate({ expression: `window.__devcdp.lastBeat = Date.now() - 10 * 60 * 1000` });
      await until(async () => !(await shown()), { timeout: 30000, interval: 500, what: "the abandoned overlay to disappear" });
    } finally {
      ctx.conn.startKeepalive();
    }

    const marker = await ctx.conn.client.Runtime.evaluate({ returnByValue: true, expression:
      `document.documentElement.getAttribute('data-devcdp-session')` });
    assert.equal(marker.result.value, null,
      "the extension marker must go too, or the tab stays in a DevCDP tab group forever");

    // And a session that is still alive gets its overlay back on the next attach.
    await ctx.conn.installAgent({ label: "DevCDP · session 1", sessionNumber: 1 });
    assert.equal(await shown(), true, "reattaching must restore the overlay");
  });

  await check("one quiet round does not remove the overlay; a beat clears it (UI-5)", async () => {
    // Why two strikes rather than one: while the page is paused at a breakpoint no
    // beat can arrive, and the first watchdog tick after the resume may still run
    // before the server's next beat. A single miss must therefore be survivable, and
    // a beat must reset the count — otherwise a live session loses its overlay every
    // time it pauses.
    const shown = () => ctx.conn.client.Runtime.evaluate({ returnByValue: true, expression:
      `!!document.getElementById('devcdp-badge-host')` }).then(r => r.result.value);
    const misses = () => ctx.conn.client.Runtime.evaluate({ returnByValue: true, expression:
      `window.__devcdp._misses` }).then(r => r.result.value);

    ctx.conn.stopKeepalive();          // so a real beat cannot race the first miss
    try {
      await ctx.conn.client.Runtime.evaluate({ expression: `window.__devcdp.lastBeat = Date.now() - 10 * 60 * 1000` });
      await until(async () => (await misses()) >= 1, { timeout: 20000, interval: 400, what: "the first missed round" });
      assert.equal(await shown(), true, "one missed round must not be enough to give up");

      await ctx.conn.client.Runtime.evaluate({ expression: `window.__devcdp.beat()` });
      assert.equal(await misses(), 0, "a beat must reset the miss count");
      await sleep(5000);
      assert.equal(await shown(), true, "a beaten overlay must survive");
    } finally {
      ctx.conn.startKeepalive();
    }
  });

  await check("evaluating a live object returns a preview, not a protocol error (EVAL-1)", async () => {
    // Real debugging evaluates things that cannot be copied out of the page: a
    // window, a DOM node, a component holding a reference to itself. returnByValue
    // fails on all of them, and the raw CDP error said only "Object reference chain
    // is too long".
    const win = await call(ctx, "console_evaluate", { expression: `window` });
    assert.equal(win.type, "object");
    assert.ok(win.properties, `a preview of the object's properties is missing: ${JSON.stringify(win)}`);
    assert.match(win.note || "", /could not be copied/, "the response must explain why the value is a preview");

    const node = await call(ctx, "console_evaluate", { expression: `document.getElementById('save')` });
    assert.ok(node.value || node.className, `a DOM node produced nothing usable: ${JSON.stringify(node)}`);

    const cyclic = await call(ctx, "console_evaluate", {
      expression: `(function(){ var a = { name: 'cycle' }; a.self = a; return a; })()` });
    assert.ok(cyclic.value !== undefined || cyclic.properties,
      `a self-referencing object produced nothing usable: ${JSON.stringify(cyclic)}`);

    // Plain values must be unaffected.
    const plain = await call(ctx, "console_evaluate", { expression: `1 + 1` });
    assert.equal(plain.value, 2);
    assert.equal(plain.note, undefined, "a copyable value needs no explanation");
  });

  await check("confirming in the badge resolves the handover, and clears it", async () => {
    await ctx.conn.client.Runtime.evaluate({
      expression: `document.getElementById('devcdp-badge-host').shadowRoot.getElementById('btn').click()`,
    });
    const acted = await until(async () => {
      const r = await call(ctx, "session_poll_user_action", {});
      return r.acted ? r : null;
    }, { what: "the badge confirmation" });
    assert.equal(acted.confirmedExplicitly, true, "a button press must count as an explicit confirmation");

    const probe = await call(ctx, "console_evaluate", {
      expression: `(function(){var r=document.getElementById('devcdp-badge-host').shadowRoot;
        return JSON.stringify({panelShown:r.getElementById('panel').classList.contains('show'),
          edge:r.getElementById('edge').className});})()`,
    });
    const ui = JSON.parse(probe.value);
    assert.equal(ui.panelShown, false, "the panel should disappear once confirmed");
    assert.ok(!/ask/.test(ui.edge), `the border should leave the waiting state: "${ui.edge}"`);
  });

  await check("expands objects instead of printing 'Object' (DBG-4)", () => {
    const scopes = capture.frames[0].scope || {};
    const order = Object.values(scopes).map(s => s && s.order).find(Boolean);
    assert.ok(order, `local 'order' not found in scope: ${JSON.stringify(scopes).slice(0, 400)}`);
    assert.equal(typeof order, "object", "v4 rendered this as the string 'Object'");
    assert.equal(order.id, 41, `order.id should be 41, got ${JSON.stringify(order)}`);
    assert.ok(Array.isArray(order.lines), "nested array should be expanded");
    assert.equal(order.lines[0].sku, "A1", "nested object inside an array should be expanded");
  });

  await check("DevCDP resumes itself after capturing, with no intervention (DBG-2)", async () => {
    // Self-contained: earlier tests deliberately hold pauses, so this arms its own
    // breakpoint with the default (auto-resuming) behaviour.
    await call(ctx, "debugger_remove_all_breakpoints", {});
    ctx.conn.holdUntilResumed = false;
    const bp2 = await call(ctx, "debugger_set_breakpoint", { url: ORIGINAL_PATH, line: LINES.originalPayload });
    assert.equal(bp2.autoResume, true, "auto-resume must be the default — a frozen page needs no human");

    ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('save').click()` }).catch(() => {});
    const cap = await until(async () => {
      const c = await call(ctx, "debugger_get_capture", {});
      return c.ready && c.autoResumed ? c : null;
    }, { what: "the automatic resume" });

    assert.equal(cap.holdRequested, false, "no hold was requested, so none should be recorded");
    assert.ok(cap.frames?.length, "it must still have captured the values before resuming");
    const state = await call(ctx, "debugger_get_state", {});
    assert.equal(state.paused, false, "page should be running again with nobody pressing anything");
  });

  await check("a forgotten hold is released automatically (no human needed)", async () => {
    // Explicitly hold a pause, then simply walk away from it.
    const shortFuse = 1500;
    const original = ctx.cfg.maxPauseMs;
    ctx.cfg.maxPauseMs = shortFuse;
    try {
      // Start from a clean slate so an earlier auto-resuming breakpoint on the
      // same line cannot decide this test's outcome.
      await call(ctx, "debugger_remove_all_breakpoints", {});
      await call(ctx, "debugger_set_breakpoint", { url: "/app.js", line: LINES.bundlePayload, auto_resume: false });
      ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('save').click()` }).catch(() => {});
      await until(async () => (await call(ctx, "debugger_get_state", {})).paused, { what: "the held pause" });

      // Nobody resumes it. The watchdog must.
      await until(async () => !(await call(ctx, "debugger_get_state", {})).paused,
        { timeout: shortFuse + 6000, what: "the watchdog to release the page" });

      const cap = await call(ctx, "debugger_get_capture", {});
      assert.equal(cap.watchdogResumed, true, "the release must be recorded, not silent");
      const activity = await call(ctx, "session_get_activity", { types: ["pause_watchdog_resumed"] });
      assert.ok(activity.count >= 1, "the automatic release must appear in the activity timeline");
    } finally {
      ctx.cfg.maxPauseMs = original;
      ctx.conn.holdUntilResumed = false;
      await call(ctx, "debugger_remove_all_breakpoints", {});
    }
  });

  await check("an explicit pause is held, then released without a human (DBG-2)", async () => {
    const original = ctx.cfg.maxPauseMs;
    ctx.cfg.maxPauseMs = 1500;
    try {
      const res = await call(ctx, "debugger_pause", {});
      assert.equal(res.heldUntilResumed, true, "an explicit pause must declare that it holds");
      assert.equal(res.autoReleaseAfterMs, 1500, "and must say when it will be released");
      // Give the page something to execute so the pause actually lands.
      ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('grow').click()` }).catch(() => {});
      await sleep(600);
      await until(async () => !(await call(ctx, "debugger_get_state", {})).paused,
        { timeout: 9000, what: "the explicit pause to be released" });
    } finally {
      ctx.cfg.maxPauseMs = original;
      ctx.conn.holdUntilResumed = false;
      await call(ctx, "debugger_resume", {}).catch(() => {});
    }
  });

  await check("a resumed capture is marked stale, not reported as live (DBG-5)", async () => {
    const again = await call(ctx, "debugger_get_capture", {});
    assert.equal(again.live, false, "v4 kept returning paused:true forever after a resume");
    assert.match(String(again.note), /resumed/i, "and must say the values are from that pause, not now");
  });

  await check("the app's own uncaught error is captured with a 1-based line (DBG-6)", async () => {
    const isStaged = x => /TypeError|Cannot read propert/i.test(x.exception || x.text || "");
    const logs = await until(async () => {
      const l = await call(ctx, "console_get_logs", { level: "error", limit: 20 });
      return l.logs.find(isStaged) ? l : null;
    }, { what: "the staged TypeError" });
    const err = logs.logs.find(isStaged);
    assert.ok(err.line >= 1, "line numbers must be 1-based");
    assert.ok(Array.isArray(err.stack) && err.stack.length, "should carry a stack");
  });

  // ── DOM, dialogs, mutations ───────────────────────────────────────────────
  await check("records DOM mutations (SPY-2)", async () => {
    await ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('grow').click()` });
    const muts = await until(async () => {
      const m = await call(ctx, "dom_get_mutations", { clear: false });
      return m.count > 0 ? m : null;
    }, { what: "a DOM mutation" });
    assert.ok(muts.count > 0, "v4's observer never installed, so this was always empty");
  });

  await check("detects a modal structurally, with no framework class names (SPY-3/SPY-5)", async () => {
    await ctx.conn.client.Runtime.evaluate({ expression: `document.getElementById('open-dialog').click()` });
    const found = await until(async () => {
      const d = await call(ctx, "dialog_detect", {});
      return d.count > 0 ? d : null;
    }, { what: "the dialog to be detected" });
    const dlg = found.dialogs[0];
    assert.match(dlg.title, /Confirm removal/);
    assert.ok(dlg.buttons.includes("Remove"), `buttons not read: ${JSON.stringify(dlg.buttons)}`);
    assert.match(dlg.detectedBy, /standard|structural/);
  });

  await check("dom_query reports real visibility and geometry", async () => {
    const res = await call(ctx, "dom_query", { selector: "[data-testid='save-order']", styles: ["display"] });
    assert.equal(res.count, 1);
    assert.equal(res.elements[0].visible, true);
    assert.ok(res.elements[0].rect.w > 0, "should report geometry");
    assert.equal(res.elements[0].styles.display, "inline-block");
  });

  await check("dom_query never returns DevCDP's own badge", async () => {
    const res = await call(ctx, "dom_query", { selector: "div", limit: 50 });
    assert.ok(!res.elements.some(e => e.id === "devcdp-badge-host"), "our own chrome leaked into results");
  });

  // ── driving the page ──────────────────────────────────────────────────────
  await check("ui_click dispatches a real click and reports what it caused", async () => {
    await call(ctx, "console_evaluate", { expression: `window.__uiHits = 0;
      document.getElementById('grow').addEventListener('click', function(e){
        window.__uiHits += e.isTrusted ? 1 : 0;   // only count real input
      }); 'ok'` });

    const res = await call(ctx, "ui_click", { testid: "grow" });
    assert.equal(res.ok !== false, true);
    assert.equal(res.clicked.tag, "button");

    const trusted = (await call(ctx, "console_evaluate", { expression: `window.__uiHits` })).value;
    assert.equal(trusted, 1, "the click must arrive as trusted input, not a synthetic el.click()");

    // The whole point of doing this inside DevCDP: the consequence comes back with
    // the action rather than needing two more calls.
    assert.equal(res.caused.domChanged, true, "appending a node must be reported as a DOM change");
  });

  await check("ui_click finds a control by the text a human reads", async () => {
    const res = await call(ctx, "ui_click", { text: "Append node" });
    assert.equal(res.clicked.tag, "button");
    assert.match(String(res.path), /button/);
  });

  await check("ui_click refuses to guess when the target is not there", async () => {
    await assert.rejects(
      () => call(ctx, "ui_click", { selector: "#does-not-exist", timeout_ms: 300 }),
      e => {
        assert.equal(e.code, "NO_TARGET");
        assert.match(e.hint, /dom_query|app_discover/);
        return true;
      });
  });

  await check("a covered element reports the blocker rather than clicking it", async () => {
    await call(ctx, "console_evaluate", { expression: `
      var o = document.createElement('div');
      o.id = 'blocker';
      o.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.01)';
      document.body.appendChild(o); 'ok'` });

    await assert.rejects(
      () => call(ctx, "ui_click", { testid: "save-order", timeout_ms: 600 }),
      e => {
        assert.equal(e.code, "TIMEOUT");
        assert.equal(e.details.reason, "covered");
        assert.equal(e.details.blockedBy.node.id, "blocker",
          `the thing in the way must be named, got ${JSON.stringify(e.details.blockedBy)}`);
        return true;
      });

    // force: is the documented escape hatch, and must say that it was used.
    const forced = await call(ctx, "ui_click", { testid: "save-order", force: true });
    assert.equal(forced.forced, true);
    assert.ok(forced.warning, "forcing past a blocker must be reported, not silent");

    await call(ctx, "console_evaluate", { expression: `document.getElementById('blocker').remove(); 'ok'` });
  });

  await check("a disabled control is reported as disabled, not as missing", async () => {
    await call(ctx, "console_evaluate", { expression:
      `document.getElementById('grow').disabled = true; 'ok'` });
    await assert.rejects(
      () => call(ctx, "ui_click", { testid: "grow", timeout_ms: 400 }),
      e => {
        assert.equal(e.details.reason, "disabled");
        assert.match(e.hint, /ui_wait_for/);
        return true;
      });
    await call(ctx, "console_evaluate", { expression:
      `document.getElementById('grow').disabled = false; 'ok'` });
  });

  await check("ui_fill sets a value the application can actually see", async () => {
    // The native setter path matters: assigning .value directly is invisible to
    // frameworks that track it, which is how a filled form submits an empty field.
    await call(ctx, "console_evaluate", { expression: `
      window.__inputEvents = 0;
      document.querySelector('[name=reference]')
        .addEventListener('input', function(){ window.__inputEvents++; }); 'ok'` });

    const res = await call(ctx, "ui_fill", { selector: "[name=reference]", value: "ORD-4471" });
    assert.equal(res.value, "ORD-4471");
    assert.equal(res.kind, "input");

    const seen = (await call(ctx, "console_evaluate", {
      expression: `JSON.stringify({v:document.querySelector('[name=reference]').value,e:window.__inputEvents})` })).value;
    const state = JSON.parse(seen);
    assert.equal(state.v, "ORD-4471");
    assert.ok(state.e >= 1, "the application must receive an input event, or its state never updates");
  });

  await check("ui_fill reaches a field through its label text", async () => {
    // aria-label is what a person would read; it must not require knowing the selector.
    const res = await call(ctx, "ui_fill", { text: "Reference", value: "VIA-LABEL" });
    assert.equal(res.value, "VIA-LABEL");
  });

  await check("ui_type sends a key event per character", async () => {
    await call(ctx, "console_evaluate", { expression: `
      window.__keys = 0;
      document.querySelector('[name=reference]')
        .addEventListener('keydown', function(){ window.__keys++; }); 'ok'` });

    const res = await call(ctx, "ui_type", { selector: "[name=reference]", text_to_type: "AB12", delay_ms: 0 });
    assert.equal(res.characters, 4);
    const keys = (await call(ctx, "console_evaluate", { expression: `window.__keys` })).value;
    assert.ok(keys >= 4, `expected a keydown per character, saw ${keys}`);
    const val = (await call(ctx, "console_evaluate", {
      expression: `document.querySelector('[name=reference]').value` })).value;
    assert.equal(val, "AB12", "clear_first must have removed the previous value");
  });

  await check("ui_wait_for returns as soon as the condition holds", async () => {
    await call(ctx, "console_evaluate", { expression: `
      setTimeout(function(){
        var d = document.createElement('div');
        d.id = 'late'; d.textContent = 'arrived at last';
        d.style.cssText = 'width:80px;height:20px';
        document.body.appendChild(d);
      }, 250); 'ok'` });

    const res = await call(ctx, "ui_wait_for", { selector: "#late", state: "visible", timeout_ms: 4000 });
    assert.equal(res.met, true);
    assert.ok(res.waitedMs >= 150, `should have actually waited, waited ${res.waitedMs}ms`);
    assert.ok(res.waitedMs < 3000, `should return on the condition, not the timeout (${res.waitedMs}ms)`);

    await call(ctx, "console_evaluate", { expression: `document.getElementById('late').remove(); 'ok'` });
    const gone = await call(ctx, "ui_wait_for", { selector: "#late", state: "detached", timeout_ms: 2000 });
    assert.equal(gone.met, true);
  });

  await check("ui_wait_for says what the page looked like when it gives up", async () => {
    await assert.rejects(
      () => call(ctx, "ui_wait_for", { selector: "[data-testid=save-order]", state: "hidden", timeout_ms: 400 }),
      e => {
        assert.equal(e.code, "TIMEOUT");
        assert.equal(e.details.matched, 1, "it must say the element was found, not imply it was missing");
        return true;
      });
  });

  await check("ui_check sets a state instead of toggling blindly", async () => {
    await call(ctx, "console_evaluate", { expression: `
      var c = document.createElement('input');
      c.type = 'checkbox'; c.id = 'agree';
      document.body.appendChild(c); 'ok'` });

    const first = await call(ctx, "ui_check", { selector: "#agree", checked: true });
    assert.equal(first.clicked, true);
    assert.equal(first.nowChecked, true);

    // Calling it again must be a no-op, not an un-check. This is the bug every
    // hand-rolled toggle helper has.
    const again = await call(ctx, "ui_check", { selector: "#agree", checked: true });
    assert.equal(again.clicked, false);
    assert.equal(again.alreadyChecked, true);

    const off = await call(ctx, "ui_check", { selector: "#agree", checked: false });
    assert.equal(off.nowChecked, false);
    await call(ctx, "console_evaluate", { expression: `document.getElementById('agree').remove(); 'ok'` });
  });

  await check("ui_select handles a native dropdown and names the options when it cannot", async () => {
    await call(ctx, "console_evaluate", { expression: `
      var s = document.createElement('select');
      s.id = 'warehouse';
      s.innerHTML = '<option value="w1">Main store</option><option value="w2">Overflow</option>';
      window.__changes = 0;
      s.addEventListener('change', function(){ window.__changes++; });
      document.body.appendChild(s); 'ok'` });

    const res = await call(ctx, "ui_select", { selector: "#warehouse", option: "Overflow" });
    assert.equal(res.selected, "Overflow");
    assert.equal(res.value, "w2");
    assert.equal(res.kind, "native");
    const changes = (await call(ctx, "console_evaluate", { expression: `window.__changes` })).value;
    assert.ok(changes >= 1, "a change event must fire or the application never learns");

    await assert.rejects(
      () => call(ctx, "ui_select", { selector: "#warehouse", option: "Nowhere" }),
      e => {
        assert.ok(e.details.options.some(o => o.includes("Main store")),
          "the options that do exist must be listed — that is usually the whole answer");
        return true;
      });
    await call(ctx, "console_evaluate", { expression: `document.getElementById('warehouse').remove(); 'ok'` });
  });

  await check("ui_press sends real keys and can focus first", async () => {
    await call(ctx, "console_evaluate", { expression: `
      window.__enter = 0;
      document.querySelector('[name=reference]')
        .addEventListener('keydown', function(e){ if (e.key === 'Enter' && e.isTrusted) window.__enter++; }); 'ok'` });

    const res = await call(ctx, "ui_press", { key: "Enter", selector: "[name=reference]" });
    assert.equal(res.pressed, "Enter");
    assert.ok(res.focused, "it must report what it focused");
    const hits = (await call(ctx, "console_evaluate", { expression: `window.__enter` })).value;
    assert.equal(hits, 1, "Enter must arrive as trusted input");
  });

  await check("ui_inspect lists usable controls with the target to reach each", async () => {
    const res = await call(ctx, "ui_inspect", { kind: "buttons" });
    assert.ok(res.controls.length >= 3, `expected the fixture's buttons, got ${res.controls.length}`);

    const save = res.controls.find(c => (c.label || "").includes("Save order"));
    assert.ok(save, "the Save button must be listed");
    assert.ok(save.use.testid || save.use.selector || save.use.text,
      "every control must come with a target that can be passed straight back");

    // And that target must actually work — a listing that names something unusable
    // is worse than no listing.
    const clicked = await call(ctx, "ui_click", { ...save.use, force: true });
    assert.ok(clicked.clicked, "the target ui_inspect suggested must be clickable");

    assert.equal(res.controls.some(c => c.label === "DevCDP"), false, "our own overlay must never be listed");
  });

  await check("ui_scroll moves the page and reports where it ended up", async () => {
    await call(ctx, "console_evaluate", { expression: `
      var tall = document.createElement('div');
      tall.id = 'tall'; tall.style.cssText = 'height:3000px'; document.body.appendChild(tall); 'ok'` });

    const down = await call(ctx, "ui_scroll", { dy: 600 });
    assert.ok(down.position.top >= 400, `page should have scrolled, top=${down.position.top}`);
    const bottom = await call(ctx, "ui_scroll", { to: "bottom" });
    assert.equal(bottom.atBottom, true);
    await call(ctx, "ui_scroll", { to: "top" });
    await call(ctx, "console_evaluate", { expression: `document.getElementById('tall').remove(); 'ok'` });
  });

  await check("an action that changes nothing says so plainly", async () => {
    // The most useful thing a no-op interaction can report. Without it the caller
    // cannot tell "the click missed" from "the app ignored it".
    await call(ctx, "console_evaluate", { expression: `
      var inert = document.createElement('div');
      inert.id = 'inert'; inert.textContent = 'does nothing';
      inert.style.cssText = 'width:120px;height:24px;border:1px solid #ccc';
      document.body.appendChild(inert); 'ok'` });

    const res = await call(ctx, "ui_click", { selector: "#inert" });
    assert.equal(res.caused.nothingHappened, true);
    assert.match(res.caused.note, /did not react|did not change/);
    await call(ctx, "console_evaluate", { expression: `document.getElementById('inert').remove(); 'ok'` });
  });

  // ── network ───────────────────────────────────────────────────────────────
  await check("captures requests, statuses and failures with bodies on request (NET-1)", async () => {
    await call(ctx, "page_reload", {});
    await until(async () => {
      const n = await call(ctx, "network_get_requests", { url_filter: "/api/orders" });
      return n.count > 0 ? n : null;
    }, { what: "the orders request" });

    const withBody = await call(ctx, "network_get_requests", { url_filter: "/api/orders", include_bodies: true, max_body_bytes: 500 });
    assert.equal(withBody.requests[0].status, 200);
    assert.match(String(withBody.requests[0].body), /"count":\s*2/, "v4 never returned bodies here at all");

    const failures = await call(ctx, "network_get_requests", { failed_only: true });
    assert.ok(failures.requests.some(r => r.url.includes("/api/broken") && r.status === 500), "staged 500 not captured");
  });

  await check("network_wait_for_request resolves from a real event", async () => {
    const waiting = call(ctx, "network_wait_for_request", { url_filter: "/api/orders", allow_existing: false, timeout_ms: 8000 });
    await sleep(150);
    await ctx.conn.client.Runtime.evaluate({ expression: `fetch('/api/orders')` });
    const res = await waiting;
    assert.equal(res.source, "observed");
    assert.equal(res.matched.status, 200);
  });

  await check("times out honestly, with the advertised default (TOOL-5)", async () => {
    let threw = null;
    try { await call(ctx, "network_wait_for_request", { url_filter: "/never-called", timeout_ms: 600 }); }
    catch (e) { threw = e; }
    assert.ok(threw, "should have timed out");
    assert.equal(threw.code, "TIMEOUT");
    assert.match(threw.message, /600ms/);
  });

  // ── discovery ─────────────────────────────────────────────────────────────
  await check("app_discover reports real selectors from the live page", async () => {
    const app = await call(ctx, "app_discover", {});
    assert.ok(app.buttons.some(b => b.selector === `[data-testid="save-order"]`),
      `expected a test-id selector: ${JSON.stringify(app.buttons)}`);
    assert.ok(app.grids.length >= 1, "should find the grid");
    assert.ok(app.fields.some(f => f.label === "Reference"), "should find the labelled input");
  });

  await check("api_discover maps the backend and finds the OpenAPI spec", async () => {
    const api = await call(ctx, "api_discover", {});
    assert.ok(api.endpoints.some(e => e.path === "/api/orders"), `endpoints: ${JSON.stringify(api.endpoints)}`);
    assert.ok(api.failing?.some(e => e.path === "/api/broken"), "should surface the failing endpoint");
    assert.equal(api.openapi?.title, "Fixture API");
  });

  await check("id-bearing paths collapse so endpoints group", async () => {
    await ctx.conn.client.Runtime.evaluate({ expression: `fetch('/api/orders?x=1');fetch('/api/orders?x=2')`, awaitPromise: false });
    await sleep(600);
    const api = await call(ctx, "api_discover", {});
    const orders = api.endpoints.find(e => e.path === "/api/orders");
    assert.ok(orders.calls >= 2, "repeat calls should aggregate, not duplicate");
    assert.ok(orders.queryParams?.includes("x"), "query params should be summarised");
  });

  // ── memory ────────────────────────────────────────────────────────────────
  await check("rejects a junk memory entry (MEM-2)", async () => {
    let threw = null;
    try { await call(ctx, "memory_record", { category: "debug", failure: "undefined", recovery: "x", pattern: "y" }); }
    catch (e) { threw = e; }
    assert.ok(threw, "v4 wrote '### [undefined] undefined' into its memory file");
    assert.match(threw.message, /placeholder|too short/i);
  });

  await check("records and retrieves a real entry, counting only what was learned (MEM-3)", async () => {
    const rec = await call(ctx, "memory_record", {
      category: "timing",
      failure: "Clicking save before the fetch settled produced a stale total.",
      recovery: "Waited for /api/orders to complete, then clicked.",
      pattern: "Wait for the orders request to finish before asserting totals.",
    });
    assert.equal(rec.recorded, true);
    const got = await call(ctx, "memory_get", { query: "stale total" });
    assert.equal(got.totalLearned, 1, "count must reflect learned entries only, not seeded boilerplate");
    assert.equal(got.entries.length, 1);
    assert.ok(!got.entries[0].recovery, "summaries should be compact by default (MEM-4)");
    const full = await call(ctx, "memory_get", { query: "stale total", full: true });
    assert.ok(full.entries[0].recovery, "full:true must return the whole entry");
  });

  // ── multi-session isolation (F1) ──────────────────────────────────────────
  await check("a second session refuses to take the first session's tab (F1)", async () => {
    ctx2 = createContext({ port, memoryDir, badge: false });
    ctx2.conn   = new Connection(ctx2);
    ctx2.memory = new MemoryStore(ctx2.cfg);

    const second = await call(ctx2, "devtools_connect", { port, target: "visible" });
    assert.notEqual(second.targetId, connected.targetId,
      "second session attached to the SAME tab — isolation is broken");
    // Escalation is window-first: a second tab on the same URL in the same window is
    // indistinguishable from the first session's tab, which is the confusion this
    // whole mechanism exists to prevent.
    assert.match(String(second.selectedBy), /new-window|new-tab|new-browser/,
      `should have opened somewhere of its own, got: ${second.selectedBy}`);
    const held = ourClaims();
    assert.equal(held.length, 2,
      `both sessions should hold exactly one claim each, saw ${held.length}: `
      + JSON.stringify(held.map(c => ({ session: c.sessionNumber, url: String(c.url).slice(-28) }))));
  });

  await check("a second session opens its tab on the wanted page, not blank (TAB-1)", async () => {
    // The reported symptom: a blank tab appearing out of nowhere. It happens when
    // every tab is claimed — most often because the same server is registered
    // twice — and the fresh tab used to be about:blank with no explanation.
    const attached = await call(ctx2, "devtools_status", {});
    assert.equal(attached.connected, true, "the second session should be attached from the previous test");

    const pages = (await CDP.List({ host: "localhost", port })).filter(t => t.type === "page");
    const blanks = pages.filter(p => p.url === "about:blank");
    assert.deepEqual(blanks, [], `no tab should be left on about:blank, found ${blanks.length}`);

    assert.ok(attached.target.url && attached.target.url.startsWith(fixture.origin),
      `the new tab should have been opened on the page we wanted, got ${attached.target.url}`);
  });

  await check("and it explains why it opened one (TAB-1)", async () => {
    // A third session, so the "everything is claimed" path runs with a report.
    const ctx3 = createContext({ port, memoryDir, badge: false });
    ctx3.conn = new Connection(ctx3);
    ctx3.memory = new MemoryStore(ctx3.cfg);
    try {
      const res = await call(ctx3, "devtools_connect", { port, target: "visible" });
      assert.ok(res.openedNewTab, "opening a tab must be reported, not silent");
      assert.match(res.openedNewTab.because, /claimed/i);
      assert.ok(res.openedNewTab.url.startsWith(fixture.origin),
        `it must open the page we wanted, got ${res.openedNewTab.url}`);
      assert.ok(res.openedNewTab.otherSessions.length >= 1, "it must name the sessions holding the other tabs");
    } finally {
      await ctx3.conn.detach({ release: true, quiet: true }).catch(() => {});
      ctx3.registry.releaseAll();
    }
  });

  // ── tabs the app opens for itself (UI-6) ──────────────────────────────────
  // Reported from real use: clicking through into a window the application opened
  // left DevCDP behind. No overlay on it, no claim, and nothing the model could act
  // on — while that window is often exactly where the bug is.
  await check("a tab the app opens gets the overlay and is held for this session (UI-6)", async () => {
    const own = createContext({ port, memoryDir });          // badge on: this is about the overlay
    own.conn = new Connection(own);
    own.memory = new MemoryStore(own.cfg);
    let popupId = null;
    try {
      await call(own, "devtools_connect", { port, target: `url-match:${fixture.origin}` });
      const adoptedAtAttach = own.conn.followed.size;

      // userGesture matters: Chrome blocks a popup that no gesture asked for.
      await own.conn.client.Runtime.evaluate({
        expression: `document.getElementById('popup').click()`, userGesture: true });
      await until(() => own.conn.followed.size > 0, { what: "the opened tab to be adopted" });

      assert.equal(adoptedAtAttach, 0, "attaching must not sweep up tabs that already existed");
      assert.equal(own.conn.followed.size, 1, "the tab the app opened was not adopted");

      popupId = [...own.conn.followed.keys()][0];
      const held = liveClaims().find(c => c.targetId === popupId);
      assert.ok(held, "an adopted tab must be claimed, or a second session will walk into it");

      const status = await call(own, "devtools_status", {});
      assert.ok(status.tabsAppOpened?.length === 1, "the model must be told the tab exists");
      assert.match(status.tabsAppOpened[0].switchWith, /devtools_connect/, "and how to get to it");

      // The overlay must actually be on that tab, in this session's colour.
      let side;
      try {
        side = await CDP({ host: "localhost", port, target: popupId });
        const { result } = await side.Runtime.evaluate({ returnByValue: true, expression:
          `(function(){ var h=document.getElementById('devcdp-badge-host');
             return JSON.stringify({ overlay: !!h,
               chip: h && h.shadowRoot && h.shadowRoot.getElementById('chip')
                 ? h.shadowRoot.getElementById('chip').textContent : null }); })()` });
        const ui = JSON.parse(result.value);
        assert.equal(ui.overlay, true, "the adopted tab shows no overlay — the user cannot tell DevCDP is there");
        assert.match(ui.chip || "", /DevCDP/, `chip text was ${JSON.stringify(ui.chip)}`);
      } finally { try { if (side) await side.close(); } catch (_) {} }
    } finally {
      await own.conn.detach({ release: true, quiet: true }).catch(() => {});
      own.registry.releaseAll();
      if (popupId) { try { const b = await CDP({ host: "localhost", port }); await b.Target.closeTarget({ targetId: popupId }); await b.close(); } catch (_) {} }
    }
  });

  await check("an adopted tab is unmarked the moment the session finishes (UI-6)", async () => {
    // Not left to the watchdog: as soon as nobody is driving, the mark should be gone.
    // The 45s expiry exists for a crash, not for an ordinary disconnect.
    const own = createContext({ port, memoryDir });
    own.conn = new Connection(own);
    own.memory = new MemoryStore(own.cfg);
    let popupId = null;
    try {
      await call(own, "devtools_connect", { port, target: `url-match:${fixture.origin}` });
      await own.conn.client.Runtime.evaluate({
        expression: `document.getElementById('popup').click()`, userGesture: true });
      await until(() => own.conn.followed.size > 0, { what: "the opened tab to be adopted" });
      popupId = [...own.conn.followed.keys()][0];

      await own.conn.detach({ release: true, quiet: true });

      // Read the popup from an independent client: this is the page, not our books.
      const side = await CDP({ host: "localhost", port, target: popupId });
      try {
        const { result } = await side.Runtime.evaluate({ returnByValue: true, expression:
          `JSON.stringify({ host: !!document.getElementById('devcdp-badge-host'),
                            marker: document.documentElement.getAttribute('data-devcdp-session') })` });
        const left = JSON.parse(result.value);
        assert.equal(left.host, false, "the adopted tab kept its overlay after the session ended");
        assert.equal(left.marker, null, "and its marker, which would keep it in a tab group");
      } finally { await side.close(); }

      assert.ok(!liveClaims().some(c => c.targetId === popupId), "the adopted tab's claim must be released too");
    } finally {
      own.registry.releaseAll();
      if (popupId) { try { const b = await CDP({ host: "localhost", port }); await b.Target.closeTarget({ targetId: popupId }); await b.close(); } catch (_) {} }
    }
  });

  await check("closing an adopted tab releases it (UI-6)", async () => {
    const own = createContext({ port, memoryDir });
    own.conn = new Connection(own);
    own.memory = new MemoryStore(own.cfg);
    try {
      await call(own, "devtools_connect", { port, target: `url-match:${fixture.origin}` });
      await own.conn.client.Runtime.evaluate({
        expression: `document.getElementById('popup').click()`, userGesture: true });
      await until(() => own.conn.followed.size > 0, { what: "the opened tab to be adopted" });
      const popupId = [...own.conn.followed.keys()][0];

      const b = await CDP({ host: "localhost", port });
      await b.Target.closeTarget({ targetId: popupId });
      await b.close();
      await until(() => own.conn.followed.size === 0, { what: "the closed tab to be forgotten" });

      assert.equal(own.conn.followed.size, 0, "a closed tab must be forgotten");
      assert.ok(!liveClaims().some(c => c.targetId === popupId), "and its claim released, or the id leaks forever");
    } finally {
      await own.conn.detach({ release: true, quiet: true }).catch(() => {});
      own.registry.releaseAll();
    }
  });

  // Real Chrome tab groups, end to end (F2-b).
  //
  // Branded Google Chrome refuses --load-extension outright — "not allowed in Google
  // Chrome, ignoring", from its own log — so grouping cannot be verified there without a
  // manual install. Chromium and Chrome for Testing do allow it, so when one is present
  // the whole path is exercised for real: extension loads, content script sees the
  // marker, service worker groups the tab, group id comes back into the page.
  //
  // This test exists because removing the per-session colour palette deleted a colorFor()
  // helper that claim() still called. The ReferenceError was swallowed by a try/catch and
  // grouping silently stopped working, reported as a bare {ok:false} that nothing read.
  const capable = findExtensionCapableChrome();
  if (!capable) {
    skipped.push("real tab grouping (no Chromium or Chrome for Testing on this machine)");
  } else {
    // The marker is what the companion extension reads, and it was silently absent on
  // every navigated document: the block ran at document-start, found documentElement
  // null, and returned without retrying. So grouping worked on the tab you attached to
  // and never again after a navigation — the exact SPY-1 mistake, in the one feature
  // whose whole job is to survive navigation (F2-e).
  await check("the extension marker survives a navigation", async () => {
    const marker = async () => JSON.parse((await call(ctx, "console_evaluate", { expression:
      `JSON.stringify({ id: document.documentElement.getAttribute('data-devcdp-session-id'),
                        no: document.documentElement.getAttribute('data-devcdp-session-no'),
                        mode: document.documentElement.getAttribute('data-devcdp-group-mode'),
                        installed: window.__devcdp ? Object.keys(window.__devcdp.installed) : [] })` })).value);

    const before = await marker();
    assert.ok(before.id, "the marker should be present before navigating");

    await call(ctx, "page_navigate", { url: fixture.origin + "/?navigated=1" });
    const after = await until(async () => {
      const m = await marker();
      return m.id ? m : null;
    }, { timeout: 10000, interval: 300, what: "the marker to be restored after navigation" });

    assert.equal(after.id, before.id, "the same session must still own the tab");
    assert.ok(after.installed.includes("marker"),
      `the marker feature must report itself installed, got ${JSON.stringify(after.installed)}`);
    assert.ok(after.no && after.mode, "the extension needs the session number and group mode too");
  });

  await check("the extension really groups the tab it is told about (F2-b)", async () => {
      const gPort = await findFreePort("localhost", [9500, 9530], new Set([port]));
      const gCtx = createContext({
        port: gPort, memoryDir, chromePath: capable,
        chromeProfileBase: fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-group-")),
      });
      gCtx.conn = new Connection(gCtx);
      gCtx.memory = new MemoryStore(gCtx.cfg);
      let browser = null;
      try {
        browser = await launchChrome({ port: gPort, cfg: gCtx.cfg, url: fixture.origin });
        assert.equal(browser.extensionLoaded, true,
          `the extension did not load in ${capable}: ${browser.extensionNote || "no reason given"}`);

        await until(async () => {
          try { return (await CDP.List({ host: "localhost", port: gPort })).some(t => t.url.startsWith(fixture.origin)); }
          catch (_) { return false; }
        }, { what: "the fixture page in the extension-capable browser" });

        await call(gCtx, "devtools_connect", { port: gPort, target: `url-match:${fixture.origin}` });

        const grouped = await until(async () => {
          const st = await call(gCtx, "devtools_status", {});
          return st.tabGrouping?.grouped ? st.tabGrouping : null;
        }, { timeout: 15000, interval: 700, what: "the tab to be put in a Chrome tab group" });

        assert.ok(Number.isInteger(grouped.groupId), `no group id: ${JSON.stringify(grouped)}`);
        assert.equal(grouped.color, "blue", "the group must match the border colour");
      } finally {
        await gCtx.conn.detach({ release: true, quiet: true }).catch(() => {});
        gCtx.registry.releaseAll();
        try { if (browser?.pid) process.kill(browser.pid); } catch (_) {}
      }
    });
  }

  await check("a departing session's tab is reused, not replaced with a new one (TAB-3)", async () => {
    // The reload case: the outgoing server still holds the tab when the incoming
    // one starts. Waiting briefly must produce a reattachment, not a stray tab.
    const holder = createContext({ port, memoryDir, badge: false });
    holder.conn = new Connection(holder);
    holder.memory = new MemoryStore(holder.cfg);

    const arriving = createContext({ port, memoryDir, badge: false, claimGraceMs: 4000 });
    arriving.conn = new Connection(arriving);
    arriving.memory = new MemoryStore(arriving.cfg);

    try {
      // Free everything this suite holds, then reduce the browser to a SINGLE
      // matching tab — otherwise a spare one is simply picked and the grace path
      // never runs, which is what the first version of this test actually proved.
      await ctx.conn.detach({ release: true, quiet: true });
      await ctx2.conn.detach({ release: true, quiet: true });

      const browser = await CDP({ host: "localhost", port });
      try {
        const pages = (await CDP.List({ host: "localhost", port })).filter(t => t.type === "page");
        for (const extra of pages.slice(1)) await browser.Target.closeTarget({ targetId: extra.id });
      } finally { await browser.close(); }
      await sleep(400);
      assert.equal((await CDP.List({ host: "localhost", port })).filter(t => t.type === "page").length, 1,
        "the scenario needs exactly one candidate tab");

      const held = await call(holder, "devtools_connect", { port, target: `url-match:${fixture.origin}` });
      const heldId = held.targetId;

      const before = (await CDP.List({ host: "localhost", port })).filter(t => t.type === "page").length;

      // The outgoing process exits mid-attach, exactly as a reload does.
      setTimeout(() => { holder.conn.detach({ release: true, quiet: true }).catch(() => {}); }, 600);

      const res = await call(arriving, "devtools_connect", { port, target: `url-match:${fixture.origin}` });
      const after = (await CDP.List({ host: "localhost", port })).filter(t => t.type === "page").length;

      assert.equal(after, before, `no tab should have been created (${before} -> ${after})`);
      assert.equal(res.targetId, heldId, "it should have taken over the released tab");
      assert.equal(res.openedNewTab, undefined, "and must not report opening one");
    } finally {
      await arriving.conn.detach({ release: true, quiet: true }).catch(() => {});
      await holder.conn.detach({ release: true, quiet: true }).catch(() => {});
      holder.registry.releaseAll(); arriving.registry.releaseAll();
      // Restore the suite's own sessions for the tests that follow.
      await call(ctx, "devtools_connect", { port, target: `url-match:${fixture.origin}` });
      await call(ctx2, "devtools_connect", { port, target: "visible" });
    }
  });

  await check("an automatic reconnect never conjures a tab (TAB-2)", async () => {
    // Reconnecting in the background must not create anything. If the tab is gone
    // the caller is told, rather than finding a stray blank tab appear.
    const before = (await CDP.List({ host: "localhost", port })).filter(t => t.type === "page").length;

    const probe = createContext({ port, memoryDir, badge: false });
    probe.conn = new Connection(probe);
    probe.memory = new MemoryStore(probe.cfg);
    try {
      // Pretend a session was attached to a tab that has since closed.
      probe.conn.targetId = "0000000000000000DEADBEEF00000000";
      probe.conn.targetSpec = "visible";
      probe.conn.client = null;

      let code = null;
      try { await probe.conn.ensure(); } catch (e) { code = e.code; }
      assert.equal(code, "TARGET_GONE", `expected TARGET_GONE, got ${code}`);

      const after = (await CDP.List({ host: "localhost", port })).filter(t => t.type === "page").length;
      assert.equal(after, before, `reconnect created ${after - before} tab(s) — it must create none`);
    } finally {
      probe.registry.releaseAll();
    }
  });

  await check("a reconnect returns to the same tab, by id not by position (TAB-2)", async () => {
    const original = ctx.conn.targetId;
    const originalUrl = ctx.conn.targetUrl;
    ctx.conn.client = null;                       // as the keepalive does on a dropped socket

    const res = await ctx.conn.ensure();
    assert.equal(res.reconnected, true);
    assert.equal(res.sameTab, true, "it must land on the same tab");
    assert.equal(ctx.conn.targetId, original, "the target id must be identical");
    assert.equal(ctx.conn.targetUrl, originalUrl);
  });

  await check("sessions_list shows who holds what (F1)", async () => {
    // Machine-wide by design — other browsers on other ports are real sessions and
    // worth seeing — so scope the count to the browser this run launched.
    const list = await call(ctx, "sessions_list", {});
    const here = list.sessions.filter(s => s.tabs.some(t => t.port === testPort));
    assert.equal(here.length, 2, `expected 2 sessions on port ${testPort}, saw ${here.length} of ${list.count}`);
    assert.equal(list.sessions.filter(s => s.isThisSession).length, 1);
    assert.ok(here.every(s => s.tabs.length === 1));
  });

  await check("each session gets its own label and colour index (F2)", () => {
    // Not exact values: numbering is machine-wide on purpose, so two Chromes on
    // different ports still produce distinguishable overlays. What matters is that
    // concurrent sessions never share a number, and each says which it is.
    const claims  = ourClaims();
    const numbers = claims.map(c => c.sessionNumber);
    assert.equal(new Set(numbers).size, numbers.length,
      `two sessions were given the same number: ${numbers}`);
    assert.equal(new Set(claims.map(c => c.label)).size, claims.length,
      `two sessions were given the same label: ${claims.map(c => c.label)}`);
    for (const n of numbers) assert.ok(Number.isInteger(n) && n >= 1, `bad session number ${n}`);
  });

  // ── settings ──────────────────────────────────────────────────────────────
  await check("devcdp_settings reports effective values and their source (SET-1)", async () => {
    const s = await call(ctx, "devcdp_settings", {});
    assert.ok(s.settings.toasts, "toast settings must be listed");
    assert.ok(s.settings.liveness, "timeouts must be listed");
    assert.ok(s.settings.browser, "browser options must be listed");
    // A setting at its default is reported as a bare value; only an overridden one
    // carries {value, from}.
    assert.equal(s.settings.toasts.toastCorner, "tr");
    assert.ok(s.files.editThisOne, "must say which file to edit");
    assert.ok(Array.isArray(s.files.searched) && s.files.searched.length >= 4);
    assert.match(s.precedence, /environment variables/);

    // The overrides this test process passed must be attributed as such, not
    // silently presented as defaults.
    const changed = await call(ctx, "devcdp_settings", { changed_only: true });
    const flat = Object.values(changed.settings).flatMap(g => Object.values(g));
    assert.ok(flat.length > 0, "the session's own overrides should show up");
    assert.ok(flat.every(v => v.from !== "default"), "changed_only must exclude defaults");
  });

  await check("a settings file actually changes behaviour end to end (SET-2)", async () => {
    // Write one, load it in a fresh context, and check it reaches the page.
    const dir = path.join(os.tmpdir(), `devcdp-settings-${process.pid}`);
    fs.mkdirSync(path.join(dir, ".devcdp"), { recursive: true });
    const file = path.join(dir, ".devcdp", "settings.json");
    fs.writeFileSync(file, `{
      // comments and trailing commas are tolerated, so notes can live in here
      "badgeCorner": "br",
      "toastOpacity": 0.35,
      "toastMaxVisible": 2,
      "evalTimeoutMs": 4321,
      "disableWebSecurity": false,
      "nonsenseKey": true,
    }`, "utf8");

    const cwd = process.cwd();
    let fresh;
    try {
      process.chdir(dir);
      const { loadConfig } = await import("../src/core/config.js?settings-test");
      fresh = loadConfig({});
    } finally { process.chdir(cwd); }

    assert.equal(fresh.badgeCorner, "br", "the file must win over the default");
    assert.equal(fresh.toastOpacity, 0.35);
    assert.equal(fresh.evalTimeoutMs, 4321);
    assert.equal(fresh._meta.provenance.badgeCorner, file, "provenance must name the file");
    assert.ok(fresh._meta.unknownKeys.includes("nonsenseKey"),
      "an unrecognised key must be reported, not silently ignored");
    assert.equal(fresh.toastCorner, "tr",
      "the messages keep their own corner and must not be dragged along by badgeCorner");

    // And the value must reach the page, not just the config object.
    const { buildAgentSource } = await import("../src/browser/agent.js");
    const src = buildAgentSource({ sessionId: "x", sessionNumber: 1, label: "L", bindingName: "b",
      corner: fresh.badgeCorner, toastOpacity: fresh.toastOpacity });
    assert.match(src, /bottom:14px;right:14px/, "the configured corner must reach the injected agent");

    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check("devcdp_settings_init writes an editable file and will not clobber (SET-3)", async () => {
    // Unique per run and cleared first: a pid alone is not unique enough on
    // Windows, and a leftover from a previous failed run made this fail spuriously.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-init-"));
    const target = path.join(dir, "devcdp.settings.json");
    fs.rmSync(target, { force: true });

    const res = await call(ctx, "devcdp_settings_init", { path: target });
    assert.equal(res.written, target);
    assert.ok(res.keys > 10, "should write a useful number of options");

    const written = fs.readFileSync(target, "utf8");
    const parsed = JSON.parse(written.replace(/^\s*\/\/.*$/gm, ""));
    assert.ok("toastCorner" in parsed, "the written file must use the real setting name");
    assert.ok("toasts" in parsed, "and the on/off switch");
    assert.ok("evalTimeoutMs" in parsed && "disableWebSecurity" in parsed);
    assert.ok(written.includes("//"), "must carry explanations, not just values");

    let threw = null;
    try { await call(ctx, "devcdp_settings_init", { path: target }); } catch (e) { threw = e; }
    assert.ok(threw, "must refuse to overwrite silently");
    assert.match(threw.hint, /overwrite/);

    fs.rmSync(path.dirname(target), { recursive: true, force: true });
  });

  await check("toasts stack, fade, and stay translucent (SET-4)", async () => {
    const state = async () => JSON.parse((await call(ctx, "console_evaluate", { expression:
      `(function(){var b=document.getElementById('devcdp-badge-host').shadowRoot.getElementById('toasts');
        var cs=b.lastElementChild?getComputedStyle(b.lastElementChild):null;
        var r=b.getBoundingClientRect();
        return JSON.stringify({count:b.children.length,bg:cs?cs.backgroundColor:null,
          left:Math.round(r.left),top:Math.round(r.top),right:Math.round(r.right),
          viewportWidth:innerWidth});})()` })).value);

    for (const detail of ["first message", "second message", "third message", "fourth message"]) {
      await call(ctx, "notify_user", { action: "debug", detail });
      await sleep(120);
    }
    const stacked = await state();
    assert.ok(stacked.count > 1, `messages should stack, saw ${stacked.count}`);
    assert.ok(stacked.count <= ctx.cfg.toastMaxVisible, `stack must be capped at ${ctx.cfg.toastMaxVisible}, saw ${stacked.count}`);
    assert.match(stacked.bg, /rgba\(/, "must be translucent");
    // The messages stay top-right even though the badge is centred — they are a
    // stream to glance at, not something anchored to the draggable chip.
    assert.ok(stacked.right > stacked.viewportWidth - 400,
      `messages belong top-right, got right=${stacked.right} of ${stacked.viewportWidth}`);
    assert.ok(stacked.top < 200, `messages belong top-right, got top=${stacked.top}`);

    // They must clear themselves without anyone asking.
    await until(async () => (await state()).count === 0,
      { timeout: ctx.cfg.toastMs + 4000, what: "the toasts to fade out on their own" });
  });

  // ── the user pitching in ──────────────────────────────────────────────────
  await check("unprompted user actions are recorded and readable (COLLAB-1)", async () => {
    const el = async sel => JSON.parse((await call(ctx, "console_evaluate", { expression:
      "(function(){var b=document.querySelector(" + JSON.stringify(sel) +
      ").getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()" })).value);
    const realClick = async sel => {
      const p = await el(sel);
      await ctx.conn.client.Input.dispatchMouseEvent({ type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
      await ctx.conn.client.Input.dispatchMouseEvent({ type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
      await sleep(200);
    };

    const before = (await call(ctx, "session_get_user_actions", {})).nextCursor;

    // Nobody asked. The user just clicks, the way they would to demonstrate a repro.
    await realClick("[data-testid='grow']");

    const after = await until(async () => {
      const r = await call(ctx, "session_get_user_actions", { cursor: before });
      return r.count > 0 ? r : null;
    }, { timeout: 5000, what: "the user's click to be recorded" });

    const clicked = after.actions.find(a => a.type === "click");
    assert.ok(clicked, `no click recorded: ${JSON.stringify(after.actions)}`);
    assert.match(String(clicked.text || clicked.selector), /Append node|grow/i,
      `the recorded action should identify the element: ${JSON.stringify(clicked)}`);

    // And it must be findable in the timeline under the documented category —
    // the event's own kind used to overwrite it, so this filter matched nothing.
    const timeline = await call(ctx, "session_get_activity", { types: ["user_interaction"], limit: 20 });
    assert.ok(timeline.count > 0, "user_interaction must be a real, filterable category");
    assert.equal(timeline.activity.at(-1).action, "click", "the event's own kind is kept as `action`");
  });

  // Interference is not an error — someone clicking through the reproduction is the
  // tool working as intended. The failure mode is silence: it was recorded in a buffer
  // nobody had a reason to read, so the model kept reasoning about a page that had
  // changed underneath it (COLLAB-5).
  await check("a click during an ongoing action is reported on the next response (COLLAB-5)", async () => {
    const at = async sel => JSON.parse((await call(ctx, "console_evaluate", { expression:
      "(function(){var b=document.querySelector(" + JSON.stringify(sel) +
      ").getBoundingClientRect();return JSON.stringify({x:Math.round(b.x+b.width/2),y:Math.round(b.y+b.height/2)});})()" })).value);

    // Clear anything pending from earlier tests, then interfere.
    ctx.session.interference = null;
    const p = await at("[data-testid='grow']");
    await ctx.conn.client.Input.dispatchMouseEvent({ type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await ctx.conn.client.Input.dispatchMouseEvent({ type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1 });
    await until(() => ctx.session.interference?.count > 0, { timeout: 5000, what: "the click to be noticed" });

    // The next tool response — any tool — has to carry it, through the real dispatcher.
    const raw = await dispatch("dom_query", { selector: "button", limit: 1 });
    assert.ok(raw._userActed, `no _userActed on the response: ${JSON.stringify(Object.keys(raw))}`);
    assert.ok(raw._userActed.count >= 1);
    assert.match(raw._userActed.actions[0].action, /click/);
    assert.match(raw._userActed.note, /may no longer be in the state/i, "it must say what the consequence is");
    assert.equal(raw._userActed.actions[0].while, "unprompted");

    // Reported once, not on every response thereafter.
    const next = await dispatch("dom_query", { selector: "button", limit: 1 });
    assert.equal(next._userActed, undefined, "the same interference must not be re-reported for ever");
  });

  await check("an answer to a question is not reported as interference (COLLAB-5)", async () => {
    ctx.session.interference = null;
    await call(ctx, "session_ask_user", { instruction: "Press the button in the badge.", wait_for: "confirmation" });
    await ctx.conn.client.Runtime.evaluate({
      expression: `document.getElementById('devcdp-badge-host').shadowRoot.getElementById('btn').click()` });
    await until(async () => (await call(ctx, "session_poll_user_action", {})).acted, { what: "the confirmation" });

    const raw = await dispatch("dom_query", { selector: "button", limit: 1 });
    assert.equal(raw._userActed, undefined,
      "a requested action is the expected answer, not interference — reporting it as a warning would cry wolf");
  });

  await check("polling without an open handover still surfaces the user's help (COLLAB-2)", async () => {
    const res = await call(ctx, "session_poll_user_action", {});
    assert.equal(res.acted, false);
    assert.ok(Array.isArray(res.recentUserActions) && res.recentUserActions.length > 0,
      "recent user activity must be reported even with nothing pending");
    assert.match(res.note, /session_get_user_actions/, "and must point at how to read it");
  });

  await check("typed values are captured during a handover, redacted otherwise (COLLAB-3)", async () => {
    const typeInto = async (sel, text) => {
      await call(ctx, "console_evaluate", { expression:
        "(function(){var e=document.querySelector(" + JSON.stringify(sel) + ");e.focus();e.value='';return 'ok';})()" });
      await ctx.conn.client.Input.insertText({ text });
      await call(ctx, "console_evaluate", { expression:
        "(function(){var e=document.querySelector(" + JSON.stringify(sel) +
        ");e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()" });
      await sleep(250);
    };

    // Outside a collaboration window: private by default (SEC-2).
    let cursor = (await call(ctx, "session_get_user_actions", {})).nextCursor;
    await typeInto("input[name='reference']", "SECRET-VALUE");
    let seen = await until(async () => {
      const r = await call(ctx, "session_get_user_actions", { cursor, kinds: ["input_change"] });
      return r.count > 0 ? r : null;
    }, { timeout: 5000, what: "the input change" });
    assert.equal(seen.actions.at(-1).value, "[not captured]", "values must be private outside a handover");

    // Inside one: the model needs to know what the user chose.
    await call(ctx, "session_ask_user", { instruction: "Type the reference you want me to use." });
    cursor = (await call(ctx, "session_get_user_actions", {})).nextCursor;
    await typeInto("input[name='reference']", "ORDER-4417");
    seen = await until(async () => {
      const r = await call(ctx, "session_get_user_actions", { cursor, kinds: ["input_change"] });
      return r.count > 0 ? r : null;
    }, { timeout: 5000, what: "the guided input" });

    const change = seen.actions.at(-1);
    assert.equal(change.value, "ORDER-4417", `the guided value must reach the model, got ${JSON.stringify(change)}`);
    assert.equal(change.capturedBecause, "collaboration window", "and it must say why it was captured");
    assert.equal(seen.valuesBeingCaptured, true);

    await call(ctx, "console_evaluate", { expression:
      "document.getElementById('devcdp-badge-host').shadowRoot.getElementById('btn').click(), 'ok'" });
    await call(ctx, "session_poll_user_action", {});
  });

  await check("a sensitive field is redacted even while collaborating (SEC-2)", async () => {
    await call(ctx, "console_evaluate", { expression:
      `(function(){var i=document.createElement('input');i.name='password';i.id='pw';document.body.appendChild(i);return 'ok';})()` });
    await call(ctx, "session_ask_user", { instruction: "Sign in." });
    const cursor = (await call(ctx, "session_get_user_actions", {})).nextCursor;
    await call(ctx, "console_evaluate", { expression:
      `(function(){var e=document.getElementById('pw');e.value='hunter2';e.dispatchEvent(new Event('change',{bubbles:true}));return 'ok';})()` });
    const seen = await until(async () => {
      const r = await call(ctx, "session_get_user_actions", { cursor, kinds: ["input_change"] });
      return r.count > 0 ? r : null;
    }, { timeout: 5000, what: "the sensitive input" });
    assert.equal(seen.actions.at(-1).value, "[redacted]", "a field named like a secret must never be captured");
    await call(ctx, "console_evaluate", { expression: `document.getElementById('pw').remove(), 'ok'` });
    await call(ctx, "session_end", {});
  });

  await check("the user can take control explicitly with a keystroke (COLLAB-4)", async () => {
    // Ctrl+Shift+D — no on-screen control, so nothing extra is drawn over the app.
    const press = async () => {
      for (const type of ["keyDown", "keyUp"]) {
        await ctx.conn.client.Input.dispatchKeyEvent({
          type, key: "D", code: "KeyD", windowsVirtualKeyCode: 68,
          modifiers: 10,   // ctrl(2) + shift(8)
        });
      }
      await sleep(300);
    };

    await press();
    const on = await until(async () => {
      const s = await call(ctx, "session_get_status", {});
      return s.collaboration.userHasControl ? s : null;
    }, { timeout: 4000, what: "the takeover to register" });
    assert.equal(on.collaboration.userHasControl, true);
    assert.equal(on.collaboration.valuesBeingCaptured, true, "taking over should start capturing chosen values");

    const activity = await call(ctx, "session_get_activity", { types: ["user_takeover"], limit: 5 });
    assert.ok(activity.count >= 1, "the takeover must be recorded");

    await press();   // hand control back
    const off = await until(async () => {
      const s = await call(ctx, "session_get_status", {});
      return s.collaboration.userHasControl === false ? s : null;
    }, { timeout: 4000, what: "control to be handed back" });
    assert.equal(off.collaboration.userHasControl, false);
  });

  // ── liveness: a wedged page must not strand the agent ─────────────────────
  await check("a blocked main thread fails fast instead of hanging (LIVE-1)", async () => {
    const originalEval = ctx.cfg.evalTimeoutMs;
    ctx.cfg.evalTimeoutMs = 2000;
    ctx.cfg.autoRecoverUnresponsive = false;      // measure the raw behaviour first
    try {
      // Verified separately: Runtime.evaluate's own `timeout` parameter does NOT
      // fire here, because the renderer that would enforce it is the blocked one.
      ctx.conn.client.Runtime.evaluate({
        expression: `(function(){var t=Date.now();while(Date.now()-t<20000){}})()`,
      }).catch(() => {});
      await sleep(400);

      const started = Date.now();
      let code = null;
      try { await call(ctx, "dom_query", { selector: "button" }); }
      catch (e) { code = e.code; }
      const elapsed = Date.now() - started;

      assert.equal(code, "PAGE_UNRESPONSIVE", `expected PAGE_UNRESPONSIVE, got ${code}`);
      assert.ok(elapsed < 6000, `should give up promptly, took ${elapsed}ms`);

      // Tools that do not run page code must keep working throughout.
      assert.ok((await call(ctx, "source_list_scripts", {})).totalLoaded > 0, "sources must still be readable");
      assert.ok((await call(ctx, "network_get_requests", {})).held >= 0, "network must still be readable");
      const status = await call(ctx, "devtools_status", {});
      assert.equal(status.pageResponsive, false, "status must report the page as unresponsive");
      assert.match(status.warning, /page_interrupt/, "and must point at the thing that actually recovers it");
    } finally {
      ctx.cfg.evalTimeoutMs = originalEval;
    }
  });

  await check("page_interrupt frees a wedged page (LIVE-2)", async () => {
    const res = await call(ctx, "page_interrupt", {});
    assert.equal(res.interrupted, true, "the running script should have been aborted");
    assert.equal(res.responsiveAgain, true, "the page should answer again afterwards");
    const q = await call(ctx, "dom_query", { selector: "button" });
    assert.ok(q.count > 0, "and normal tools should work again");
  });

  await check("a wedged page is recovered automatically and the recovery reported (LIVE-3)", async () => {
    const originalEval = ctx.cfg.evalTimeoutMs;
    ctx.cfg.evalTimeoutMs = 2000;
    ctx.cfg.autoRecoverUnresponsive = true;
    try {
      ctx.conn.client.Runtime.evaluate({
        expression: `(function(){var t=Date.now();while(Date.now()-t<20000){}})()`,
      }).catch(() => {});
      await sleep(400);

      // No intervention: the call itself aborts the runaway script and retries.
      const q = await call(ctx, "dom_query", { selector: "button" });
      assert.ok(q.count > 0, "the query should have succeeded after self-recovery");
      assert.ok(ctx.conn.lastRecovery, "the recovery must be recorded, not silent");
      assert.match(ctx.conn.lastRecovery.action, /terminated/i);

      const activity = await call(ctx, "session_get_activity", { types: ["script_terminated"] });
      assert.ok(activity.count >= 1, "aborting the app's script must appear in the activity timeline");
    } finally {
      ctx.cfg.evalTimeoutMs = originalEval;
      ctx.conn.lastRecovery = null;
    }
  });

  await check("the tool dispatcher has a hard ceiling of its own (LIVE-4)", async () => {
    // Guards everything that is not a page evaluation — a stalled socket, a
    // renderer that will not return a script's source.
    const { getTool } = await import("../src/core/tools.js");
    const tool = getTool("dom_query");
    assert.equal(typeof ctx.cfg.toolTimeoutMs, "number", "a backstop must be configured");
    assert.ok(ctx.cfg.toolTimeoutMs > 0);

    // Tools that wait on purpose must declare a ceiling above their own timeout,
    // or the backstop would cut them short.
    const waiter = getTool("network_wait_for_request");
    assert.equal(typeof waiter.deadlineFor, "function", "network_wait_for_request must declare its own deadline");
    assert.ok(waiter.deadlineFor({ timeout_ms: 60000 }) > 60000, "its deadline must exceed its own timeout");
    assert.equal(typeof tool.deadlineFor, "undefined", "ordinary tools should just use the backstop");
  });

  // ── teardown ──────────────────────────────────────────────────────────────
  await check("detach resumes the page, clears breakpoints and releases the tab (DBG-3)", async () => {
    await call(ctx, "debugger_set_breakpoint", { url: "/app.js", line: LINES.bundlePayload });
    assert.ok(ctx.desired.breakpoints.size >= 1);

    const targetId = ctx.conn.targetId;
    await call(ctx, "devtools_disconnect", {});

    assert.equal(liveClaims().some(c => c.targetId === targetId), false, "claim was not released");
    assert.equal(ctx.conn.connected, false);
  });

  await check("the indicator and markers are gone from the page after detach", async () => {
    // Checked from a completely separate CDP client, so this is what the page
    // really looks like — not what our own bookkeeping claims.
    const client = await CDP({ host: "localhost", port, target: ctx.conn.targetId });
    try {
      const { result } = await client.Runtime.evaluate({
        expression: `JSON.stringify({
          host: !!document.getElementById('devcdp-badge-host'),
          session: document.documentElement.getAttribute('data-devcdp-session'),
          group: document.documentElement.getAttribute('data-devcdp-group'),
          agent: typeof window.__devcdp
        })`,
        returnByValue: true,
      });
      const left = JSON.parse(result.value);
      assert.equal(left.host, false, `the indicator element survived teardown: ${result.value}`);
      assert.equal(left.session, null, `the session marker survived teardown: ${result.value}`);
      assert.equal(left.group, null, `the tab-group marker survived teardown: ${result.value}`);
    } finally { await client.close(); }
  });

  // Reported from real use: a brand-new session announced itself as "session 3" with no
  // sessions 1 or 2 anywhere. Cause: claims were reaped on process liveness only, so a
  // session whose tab the *user closed* kept heartbeating and kept its number. Measured
  // on a real browser: three claims, all three for tabs that no longer existed (F1-b).
  await check("closing a tab releases its claim, so session numbers stay honest (F1-b)", async () => {
    const own = createContext({ port, memoryDir, badge: false });
    own.conn = new Connection(own);
    own.memory = new MemoryStore(own.cfg);
    let tabId = null;
    try {
      const res = await call(own, "devtools_connect", { port, target: "new" });
      tabId = res.targetId;
      assert.ok(ourClaims().some(c => c.targetId === tabId), "the new tab should be claimed");

      // Close the tab behind the session's back, the way a user does.
      const b = await CDP({ host: "localhost", port });
      await b.Target.closeTarget({ targetId: tabId });
      await b.close();

      // Either the socket drop notices, or the next listing does.
      await until(async () => {
        try { await call(own, "list_tabs", { port, probe: false }); } catch (_) {}
        return !liveClaims().some(c => c.targetId === tabId);
      }, { timeout: 15000, interval: 600, what: "the closed tab's claim to be released" });

      assert.ok(!liveClaims().some(c => c.targetId === tabId),
        "a claim on a tab that no longer exists must not be held");
    } finally {
      await own.conn.detach({ release: true, quiet: true }).catch(() => {});
      own.registry.releaseAll();
    }
  });

  await check("reaping a closed tab never touches a live one (F1-b)", () => {
    // The reaper is handed the set of live target ids; passing something that is not a
    // Set must be refused rather than treated as "nothing is alive", which would delete
    // every claim on the port.
    const before = ourClaims().length;
    assert.equal(reapClosedTabs(port, null), 0, "a non-Set must be refused");
    assert.equal(reapClosedTabs(port, undefined), 0);
    assert.equal(ourClaims().length, before, "no claim may be removed by a malformed call");
  });

  await check("a freed tab becomes available to another session again (F1)", async () => {
    const list = await call(ctx2, "list_tabs", { port });
    assert.ok(list.tabs.some(t => t.available), "no tab became available after release");
  });

} finally {
  try { if (ctx2?.conn) await ctx2.conn.detach({ release: true, quiet: true }); } catch (_) {}
  try { if (ctx?.conn)  await ctx.conn.detach({ release: true, quiet: true }); } catch (_) {}
  try { ctx?.registry?.releaseAll(); ctx2?.registry?.releaseAll(); } catch (_) {}
  try { fixture.server.close(); } catch (_) {}
  if (chrome?.pid) { try { process.kill(chrome.pid); } catch (_) {} }
  try { fs.rmSync(REGISTRY_DIR, { recursive: true, force: true }); } catch (_) {}
  await sleep(300);
}

process.stdout.write(`\n${passed} passed, ${failed} failed${skipped.length ? `, ${skipped.length} skipped` : ""}\n`);
// Named, not silent. A test that did not run must not be mistaken for one that passed.
for (const s of skipped) process.stdout.write(`  skipped: ${s}\n`);
if (failed) {
  process.stdout.write("\nfailures:\n");
  for (const r of results.filter(x => !x.ok)) process.stdout.write(`  • ${r.name}\n    ${r.error}\n`);
}
process.stdout.write("\n");
process.exit(failed ? 1 : 0);
