// ─── Connection tools ────────────────────────────────────────────────────────

import { defineTool } from "../core/tools.js";
import { listPageTargets, probeVisibility } from "../cdp/targets.js";
import { liveClaims, liveBrowsers, portsInUse } from "../cdp/registry.js";
import { launchChrome, findFreePort, findExtensionCapableChrome } from "../cdp/launch.js";
import { CODES, fail } from "../core/errors.js";

/**
 * Pages where Chrome does not allow extension content scripts, so the marker cannot be
 * read and grouping is impossible by design rather than by fault.
 */
const cannotRunExtensions = url =>
  !url || /^(about:|chrome:|chrome-extension:|devtools:|edge:|view-source:)/i.test(String(url));

// Scanning the disk on every status call would be wasteful, and the answer cannot
// change while the process lives.
let _capable;
const extensionCapableChrome = () => {
  if (_capable === undefined) { try { _capable = findExtensionCapableChrome(); } catch (_) { _capable = null; } }
  return _capable;
};

defineTool({
  name: "devtools_connect",
  description:
    "Attach to a Chrome tab over the DevTools Protocol and start observing it (console, network, DOM, debugger). "
    + "Claims the tab so no other DevCDP session can drive it, marks it visibly in the browser, and reports what "
    + "was loaded before we attached. Call this once at the start of a debugging session.",
  needsClient: false,
  args: {
    host:   { type: "string",  description: "Chrome host.", default: "localhost" },
    port:   { type: "number",  description: "Chrome remote-debugging port.", default: 9222 },
    target: { type: "string",  description:
      "'visible' (the tab on screen) | 'url-match:<substring>' | 'index:<n>' from list_tabs | 'new' | a URL substring.",
      default: "visible" },
    browser: { type: "string", description:
      "'new' launches a separate isolated Chrome on the next free port — a browser no other session has touched.",
      enum: ["existing", "new"], default: "existing" },
    allow_new_tab: { type: "boolean", description:
      "If every tab is already claimed by another session, open a new one instead of failing.", default: true },
    window: { type: "string", description:
      "'new' gives this session its own browser window — the fallback when Chrome tab groups are unavailable.",
      enum: ["current", "new"], default: "current" },
  },
  async handler(args, ctx) {
    let { host, port } = args;
    let launched = null;

    if (args.browser === "new") {
      port = await findFreePort(host, ctx.cfg.portRange, portsInUse());
      launched = await launchChrome({ port, cfg: ctx.cfg });
      // Recorded so sessions_list can attribute it and so no other session picks this
      // port while Chrome is still starting. Released, never closed, when we exit.
      ctx.registry.registerBrowser(port, {
        pid: launched.pid, executable: launched.executable, profile: launched.profile,
      });
    }

    const info = await ctx.conn.attach({
      host, port,
      target: args.target,
      allowNewTab: args.allow_new_tab,
      newWindow: args.window === "new",
    });

    // attach() escalates on its own when every tab is claimed, and rung 2 of that
    // ladder launches a browser — so the browser we end up in is not necessarily the
    // one we were asked for.
    const escalated = !launched && ctx.conn.launchedBrowser;

    return {
      connected: true,
      ...info,
      ...(launched || escalated ? { launchedBrowser: launched || ctx.conn.launchedBrowser } : {}),
      ...(escalated ? { note: `Every tab on port ${args.port} was claimed, so this session launched its own browser on `
                            + `port ${ctx.conn.port}.` } : {}),
      next: "source_search to find the code, debugger_set_breakpoint, trigger it, debugger_get_capture.",
    };
  },
});

defineTool({
  name: "devtools_status",
  description:
    "Connection health and buffer accounting: which tab is attached, how many console/network/script entries are "
    + "held, whether the debugger is paused, and whether anything has been evicted from the buffers.",
  needsClient: false,
  async handler(_args, ctx) {
    const conn = ctx.conn;
    if (!conn.connected) {
      return {
        connected: false,
        lastTarget: conn.targetId || null,
        hint: "Call devtools_connect. Chrome must be running with --remote-debugging-port=9222.",
      };
    }

    // Bounded, and a stall is reported rather than hanging devtools_status —
    // which is the one tool you reach for when things are wrong. Crucially the
    // page probe is NOT auto-recovered: this tool's job is to tell you the truth
    // about the page, not to change it. And once one probe stalls, the rest are
    // skipped — three sequential timeouts made the diagnostic tool take 8.5s.
    let page = {}, pageStalled = false;
    try {
      const res = await conn.eval(
        `JSON.stringify({url:location.href,title:document.title,readyState:document.readyState})`,
        { timeoutMs: 2500, recover: false, label: "status probe" });
      page = JSON.parse(res?.result?.value || "{}");
    } catch (_) { pageStalled = true; }

    const agent = pageStalled ? null : await conn.agentReport();

    // F2 — the companion extension writes the group id back into the DOM, so we
    // can report whether the tab really is grouped rather than assuming it.
    let grouping = { grouped: false, unknown: pageStalled || undefined };
    if (!pageStalled) try {
      const gRaw = await conn.evalQuiet(
        `JSON.stringify({g:document.documentElement.getAttribute('data-devcdp-group'),
                         c:document.documentElement.getAttribute('data-devcdp-group-color'),
                         e:document.documentElement.getAttribute('data-devcdp-group-error'),
                         m:document.documentElement.getAttribute('data-devcdp-session')})`, 3000);
      const g = JSON.parse(gRaw || "{}");
      grouping = {
        grouped: g.g != null,
        groupId: g.g != null ? Number(g.g) : null,
        color: g.c || null,
        markerPresent: !!g.m,
        // Three different reasons a tab is not grouped, which used to produce one
        // message — and usually the wrong one. A page that cannot run a content script
        // at all is the first thing to rule out: extensions are not permitted on
        // about:blank or chrome:// pages, so nothing can read the marker there.
        ...(g.m && g.g == null && cannotRunExtensions(page.url)
          ? { note: `This page (${page.url}) cannot run an extension content script, so it cannot be grouped.`,
              fix: "Nothing to fix — the tab joins a group by itself as soon as it loads a real page." }
          : {}),

        // An installed extension that failed is a different problem from no extension,
        // and telling them apart is the difference between a useful message and a
        // confident wrong one.
        ...(g.m && g.g == null && g.e && !cannotRunExtensions(page.url)
          ? { note: "The companion extension IS installed and tried to group this tab, but Chrome refused.",
              extensionError: g.e,
              fix: "This is a fault in the extension or a Chrome restriction, not a missing install. Reload it at "
                 + "chrome://extensions and check its service-worker console for the full error." }
          : {}),
        ...(g.m && g.g == null && !g.e && !cannotRunExtensions(page.url)
          ? { note: "Tab is marked but not grouped — the companion extension is not installed in this Chrome profile.",
              why: "Branded Google Chrome refuses --load-extension and does not expose Extensions.loadUnpacked over the "
                 + "debugging port, so an extension cannot be installed programmatically. Its own log says "
                 + "\"not allowed in Google Chrome, ignoring\".",
              fix: `One time, in this browser: chrome://extensions → Developer mode → Load unpacked → select ${ctx.cfg.extensionDir || "<install>/extension"}. `
                 + "The debug profile is persistent, so it stays installed after that — and both debug-chrome.bat and "
                 + "DevCDP's own launcher use the same profile, so it applies to both.",
              ...(extensionCapableChrome()
                ? { alternative: `No manual step at all: set chromePath to ${extensionCapableChrome()} in your settings. `
                               + "That build allows the switch, so the extension loads on its own and grouping just works." }
                : { alternative: "Chromium and Chrome for Testing allow the switch, so the extension loads on its own there." }),
              meanwhile: "Grouping is the only thing missing. The edge border, the identity chip and window:'new' all work without it." }
          : {}),
      };
    } catch (_) {}

    return {
      connected: true,
      ...(pageStalled
        ? { pageResponsive: false,
            warning: "The page did not answer a trivial evaluation in 2.5s — its main thread is blocked, most likely an "
                   + "infinite loop or a long synchronous task. Console, network, sources and the debugger all still "
                   + "work. Call page_interrupt to abort the running script; reloading will not free it." }
        : { pageResponsive: true }),
      tabGrouping: grouping,
      target: { id: conn.targetId, ...page },
      attachedAt: conn.attachedAt,
      ...(conn.followed?.size
        ? { tabsAppOpened: conn.followedTabs(),
            note: "The app opened these tabs. They are marked and held for this session; switch with devtools_connect to debug inside one." }
        : {}),
      session: { id: ctx.sessionId, number: ctx.registry.sessionNumber, label: conn.agentCfg?.label || null },
      buffers: {
        console: ctx.consoleBuf().stats(),
        network: ctx.network.stats(),
        mutations: ctx.mutations.stats(),
        scripts: { count: ctx.scripts.size, withSourceMaps: [...ctx.scripts.values()].filter(s => s.hasSourceMap).length },
      },
      debugger: {
        paused: ctx.pause.active,
        breakpoints: ctx.desired.breakpoints.size,
        unbound: [...ctx.desired.breakpoints.values()].filter(b => !b.bound).length,
      },
      inPageAgent: agent
        ? { installed: Object.values(agent.installed || {}).every(Boolean) ? "all features" : agent.installed }
        : { installed: false, warning: "Not reporting — mutations, dialog events and the indicator are unavailable." },
    };
  },
});

defineTool({
  name: "devtools_disconnect",
  description:
    "Detach cleanly: resume the page if it is paused at a breakpoint, remove every breakpoint we set, remove the "
    + "in-page badge, and release the tab claim so another session can use it. Always call this when you are done.",
  needsClient: false,
  async handler(_args, ctx) {
    if (!ctx.conn.connected && !ctx.conn.targetId) return { disconnected: false, note: "Nothing was attached." };
    const target = ctx.conn.targetId;
    await ctx.conn.detach({ release: true });
    const cleanup = ctx.conn.lastTeardown;
    return {
      disconnected: true,
      releasedTab: target,
      inPageCleanup: cleanup
        ? { indicatorRemoved: cleanup.hostGone === true, markersRemoved: cleanup.markerGone === true, agent: cleanup.agent }
        : { indicatorRemoved: null, note: "The page did not confirm cleanup — it may have navigated or closed already." },
      note: "Page resumed, breakpoints removed, indicator removed, tab released.",
    };
  },
});

defineTool({
  name: "list_tabs",
  description:
    "List the debuggable tabs in Chrome with their index, title, URL, whether each is the visible one, and which "
    + "DevCDP session (if any) currently owns it. Use the index with target:'index:<n>' in devtools_connect.",
  needsClient: false,
  args: {
    host:  { type: "string",  description: "Chrome host.", default: "localhost" },
    port:  { type: "number",  description: "Chrome remote-debugging port.", default: 9222 },
    probe: { type: "boolean", description: "Check which tab is really visible (one extra round trip).", default: true },
  },
  async handler(args, ctx) {
    const pages  = await listPageTargets(args.host, args.port);
    const claims = liveClaims().filter(c => c.port === args.port);
    const byTarget = new Map(claims.map(c => [c.targetId, c]));

    const vis = args.probe && pages.length ? await probeVisibility(args.host, args.port, pages) : new Map();

    // TOOL-1 lived here: v4's lean() stripped any key named `tabs`, and quiet
    // defaulted to true, so this tool returned {count:N} and nothing else.
    const tabs = pages.map((t, index) => {
      const claim = byTarget.get(t.id);
      return {
        index,
        id: t.id,
        title: t.title,
        url: t.url,
        visible: vis.get(t.id)?.visible ?? null,
        focused: vis.get(t.id)?.focused ?? null,
        claimedBy: claim
          ? (claim.sessionId === ctx.sessionId ? "this session" : claim.label)
          : null,
        available: !claim || claim.sessionId === ctx.sessionId,
      };
    });

    return {
      count: tabs.length,
      port: args.port,
      tabs,
      available: tabs.filter(t => t.available).length,
      claimedByOthers: tabs.filter(t => t.claimedBy && t.claimedBy !== "this session").length,
    };
  },
});

defineTool({
  name: "sessions_list",
  description:
    "Show every DevCDP session currently running on this machine and the tabs each one holds. Use it to understand "
    + "why a tab is unavailable, or to confirm two agents are not fighting over the same page.",
  needsClient: false,
  async handler(_args, ctx) {
    const claims   = liveClaims();
    const browsers = liveBrowsers();
    const bySession = new Map();

    const entry = c => {
      if (!bySession.has(c.sessionId)) {
        bySession.set(c.sessionId, {
          label: c.label, sessionNumber: c.sessionNumber, pid: c.pid,
          isThisSession: c.sessionId === ctx.sessionId, tabs: [], browsersLaunched: [],
        });
      }
      return bySession.get(c.sessionId);
    };

    for (const c of claims) {
      entry(c).tabs.push({ port: c.port, targetId: c.targetId, url: c.url, title: c.title, claimedAt: c.claimedAt });
    }
    for (const b of browsers) {
      entry(b).browsersLaunched.push({ port: b.port, profile: b.profile, browserPid: b.browserPid, launchedAt: b.launchedAt });
    }

    const sessions = [...bySession.values()].sort((a, b) => (a.sessionNumber || 0) - (b.sessionNumber || 0));
    return {
      count: sessions.length,
      thisSession: { id: ctx.sessionId, number: ctx.registry.sessionNumber, label: ctx.conn.agentCfg?.label || null },
      sessions,
      portsInUse: [...portsInUse()],
      note: browsers.length
        ? "A launched browser stays open after its session ends — only the record is released, so the next session can "
          + "adopt it or take a free port."
        : undefined,
    };
  },
});

defineTool({
  name: "page_navigate",
  description:
    "Navigate the attached tab to a URL. Returns as soon as the navigation is committed, not when loading finishes — "
    + "wait for a specific request with network_wait_for_request, or for text with Playwright, before asserting.",
  args: {
    url: { type: "string", description: "Absolute URL to open.", required: true },
  },
  async handler(args, ctx) {
    const res = await ctx.conn.client.Page.navigate({ url: args.url });
    if (res.errorText) {
      fail(CODES.EVAL_FAILED, `Navigation to ${args.url} failed: ${res.errorText}`,
        "Check the URL is reachable from the debug browser.");
    }
    ctx.conn.setBadge(`navigating`, "busy");
    return { navigating: args.url, frameId: res.frameId, note: "Returns immediately; load is still in progress." };
  },
});

defineTool({
  name: "page_interrupt",
  description:
    "Abort the JavaScript the page is currently running. Use it when a tool reports PAGE_UNRESPONSIVE — an infinite "
    + "loop or a long synchronous task has blocked the main thread. This is the only thing that frees it: reloading and "
    + "navigating do not, because the blocked thread never processes them. The page keeps its DOM and state; only the "
    + "in-flight script is killed.",
  async handler(_args, ctx) {
    const before = await ctx.conn.evalQuiet("1", 1200);
    if (before !== null) {
      return { interrupted: false, note: "The page is already responsive — nothing needed interrupting." };
    }

    const ok = await ctx.conn.terminateScript();
    const after = ok ? await ctx.conn.evalQuiet("1", 2000) : null;

    if (!ok) {
      fail(CODES.PAGE_UNRESPONSIVE, "Could not abort the page's running script.",
        "The renderer may be beyond recovery. Attach to a different tab with devtools_connect(target:'new'), or restart the browser.");
    }
    return {
      interrupted: true,
      responsiveAgain: after !== null,
      note: after !== null
        ? "The running script was aborted and the page is answering again. Whatever it was doing did not finish — check console_get_logs."
        : "The script was aborted but the page is still not answering; something may be re-entering the loop. Consider devtools_connect(target:'new').",
    };
  },
});

defineTool({
  name: "page_reload",
  description:
    "Reload the attached tab. Useful right after attaching, because console history and network traffic from before "
    + "the attach cannot be recovered — a reload replays everything with DevCDP watching.",
  args: {
    bypass_cache: { type: "boolean", description: "Ignore the HTTP cache (hard reload).", default: false },
  },
  async handler(args, ctx) {
    ctx.network.clear();
    ctx.consoleBuf().clear();
    await ctx.conn.client.Page.reload({ ignoreCache: args.bypass_cache });
    ctx.conn.setBadge("reloading", "busy");
    return {
      reloaded: true,
      bypassedCache: args.bypass_cache,
      note: "Console and network buffers were cleared so what you read next belongs to this load.",
    };
  },
});
