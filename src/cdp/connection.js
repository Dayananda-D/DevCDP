// ─── CDP connection ──────────────────────────────────────────────────────────
// The single most important line ordering in this codebase is in wire()/enable():
//
//   v4 called Debugger.enable() and *then* subscribed Debugger.scriptParsed.
//   Chrome replays scriptParsed for every already-loaded script synchronously in
//   response to enable(), so the entire burst landed before the listener existed.
//   Result: source_list_scripts returned 0 on any page that was already open —
//   which is every page, because the guide tells users to open the app first.
//   Verified live: 0 scripts → 22 scripts after a reload. (SRC-1)
//
// Therefore: subscribe every handler first, enable domains second. Always.
//
// Also fixed here:
//   OBS-1  console/network were blind to anything before attach, with no signal
//          that a boundary existed. We now snapshot resource timing on attach and
//          report attachedAt + preAttach explicitly.
//   DBG-3  nothing was ever cleaned up — breakpoints stayed set and a paused page
//          was left frozen for the user. Teardown is now deterministic.
//   DBG-5  a capture kept reporting paused:true after resume. Captures are
//          stamped with a pause id and marked stale.
//   DBG-6  exception line/col were 0-based while breakpoints were 1-based.
//          Everything is normalised to 1-based at this boundary.
//   CONN-2 reconnect restored nothing. It now replays breakpoints + agent and
//          verifies it landed on the same tab.

import CDP from "chrome-remote-interface";
import { CODES, DevCdpError, fail } from "../core/errors.js";
import { log } from "../core/log.js";
import { pickTarget, createTarget, listPageTargets, TargetWatcher } from "./targets.js";
import { findFreePort, launchChrome } from "./launch.js";
import { portsInUse } from "./registry.js";
import { buildAgentSource } from "../browser/agent.js";
import { captureFrameScope } from "../debug/scope.js";

const BINDING = "__devcdp_event__";

/** A URL short enough for a toast: path and hash, without the origin. */
function shortUrl(url, max = 48) {
  if (!url) return "the page";
  let s;
  try { const u = new URL(url); s = (u.pathname + u.search + u.hash) || u.host; }
  catch (_) { s = String(url); }
  if (s === "/" ) { try { s = new URL(url).host; } catch (_) {} }
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
const KEEPALIVE_MS = 20_000;

/** Chrome's ways of saying "that value will not fit down the wire". */
const SERIALISATION_FAILED = /reference chain is too long|could ?n[o']t be returned by value|circular/i;

/** CDP is 0-based for script positions; humans and editors are 1-based. */
const line1 = n => (typeof n === "number" ? n + 1 : null);

export class Connection {
  constructor(ctx) {
    this.ctx        = ctx;
    this.client     = null;
    this.targetId   = null;
    this.targetUrl  = null;
    this.targetTitle= null;
    this.host       = ctx.cfg.host;
    this.port       = ctx.cfg.port;
    this.targetSpec = "visible";
    this.attachedAt = null;
    this.preAttach  = null;
    this.keepalive  = null;
    this.agentCfg   = null;
    this.detaching  = false;
    this.watcher    = null;
    this.followed   = new Map();   // targetId → { client, url, title } for tabs the app opened
    this.pendingOpen = null;       // set by Page.windowOpen; covers rel="noopener"
  }

  get connected() { return !!this.client; }

  // ── liveness helpers ──────────────────────────────────────────────────────

  /**
   * Race a CDP promise against a deadline enforced in THIS process.
   *
   * Necessary because the renderer enforces its own timeouts. If page JS is in an
   * infinite loop, Runtime.evaluate never returns and its `timeout` parameter
   * never fires either — verified against a real spin loop. Without this, a single
   * bad loop in the app under test wedges the agent permanently.
   */
  withTimeout(promise, ms, what) {
    let timer;
    const guard = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new DevCdpError(
          CODES.PAGE_UNRESPONSIVE,
          `${what} did not answer within ${ms}ms — the page's main thread is blocked.`,
          // Measured, not guessed: Page.reload and Page.navigate do NOT free a spin
          // loop; Runtime.terminateExecution does, in about 8ms.
          "Page JS is in an infinite loop or a long synchronous task. Call page_interrupt to abort the running script — "
          + "reloading will NOT free it. Tools that do not run code in the page still work: source_list_scripts, "
          + "network_get_requests, console_get_logs and the debugger_* tools.",
          { evaluated: what, waitedMs: ms },
        );
        reject(err);
      }, ms);
      timer.unref?.();
    });
    return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
  }

  /**
   * Abort whatever JavaScript the page is currently running. This is the only
   * thing that frees a wedged main thread — verified against a real spin loop,
   * where reload and navigate both left it stuck.
   */
  async terminateScript() {
    if (!this.client) return false;
    try {
      await this.withTimeout(this.client.Runtime.terminateExecution(), 4000, "terminateExecution");
      this.ctx.recordActivity("script_terminated", { reason: "page main thread was blocked" });
      log.warn("connection", "aborted the page's running script to unblock the main thread");
      return true;
    } catch (_) { return false; }
  }

  /**
   * Evaluate in the page, always bounded. If the main thread is wedged, abort the
   * running script and try once more, so a runaway loop in the app under test
   * cannot strand the agent. Reports what it had to do rather than hiding it.
   */
  async eval(expression, opts = {}) {
    const {
      timeoutMs = this.ctx.cfg.evalTimeoutMs,
      awaitPromise = false,
      returnByValue = true,
      contextId,
      silent = true,
      label = "evaluation",
      recover = this.ctx.cfg.autoRecoverUnresponsive,
    } = opts;

    if (!this.client) {
      fail(CODES.NOT_CONNECTED, "Not attached to a browser tab.", "Call devtools_connect first.");
    }

    const run = () => this.withTimeout(
      this.client.Runtime.evaluate({
        expression, returnByValue, awaitPromise, silent,
        ...(contextId ? { contextId } : {}),
      }),
      timeoutMs,
      label,
    );

    try {
      return await run();
    } catch (err) {
      // Some values cannot be copied out of the page at all: a DOM node, a window,
      // a framework component holding a reference back to itself. Chrome answers
      // returnByValue with a bare protocol error, which used to surface as an
      // unhandled "Object reference chain is too long" — opaque, and common the
      // moment you evaluate anything real. Ask by reference instead and hand back a
      // preview, which is what a developer wanted anyway (EVAL-1).
      if (returnByValue && SERIALISATION_FAILED.test(err?.message || "")) {
        const res = await this.withTimeout(
          this.client.Runtime.evaluate({
            expression, returnByValue: false, generatePreview: true, awaitPromise, silent,
            ...(contextId ? { contextId } : {}),
          }),
          timeoutMs, label);
        if (res?.result) res.result.byReference = true;
        return res;
      }

      const wedged = err instanceof DevCdpError && err.code === CODES.PAGE_UNRESPONSIVE;
      if (!wedged || !recover || this._recovering) throw err;

      this._recovering = true;
      try {
        if (!await this.terminateScript()) throw err;
        const result = await run();
        this.lastRecovery = { at: new Date().toISOString(), label, action: "terminated the page's running script" };
        return result;
      } finally {
        this._recovering = false;
      }
    }
  }

  /**
   * Best-effort evaluation for our own chrome (badge, cursor, markers). Never
   * throws and never blocks a tool: if the page is wedged, the indicator simply
   * does not update.
   */
  async evalQuiet(expression, timeoutMs = 2500) {
    try {
      const res = await this.eval(expression, { timeoutMs, label: "indicator update" });
      return res?.result?.value ?? null;
    } catch (_) { return null; }
  }

  // ── attach ────────────────────────────────────────────────────────────────
  async attach({ host, port, target = "visible", allowNewTab = true, newWindow = false } = {}) {
    const ctx = this.ctx;
    if (host) this.host = host;
    if (port) this.port = port;
    this.targetSpec = target;

    if (this.client) await this.detach({ release: true, quiet: true });

    const survey = ctx.registry.survey(this.port);

    let chosen, reason, candidates = [], excluded = [], openedNewTab = null;
    if (target === "new") {
      chosen = await createTarget(this.host, this.port, "about:blank", { newWindow });
      reason = newWindow ? "new-tab-in-own-window" : "new-tab";
      openedNewTab = { url: "about:blank", because: "you asked for a new tab" };
    } else {
      try {
        ({ chosen, reason, candidates, excluded } =
          await pickTarget({ host: this.host, port: this.port, target, excludeIds: survey.claimedByOthers }));
      } catch (e) {
        // Every tab taken? Open one rather than dead-ending the agent (F1) — but
        // open it ON THE PAGE WE WANTED, not about:blank. A bare blank tab appearing
        // during a reload is baffling, and it is the commonest symptom of the same
        // server being registered twice, so say so.
        if (e instanceof DevCdpError && e.code === CODES.TARGET_CLAIMED && allowNewTab) {
          // First: wait a moment. When an assistant reloads, the outgoing server
          // and the incoming one overlap for a second or two, so the tab looks
          // claimed by a session that is on its way out. Waiting for it to release
          // means reattaching to the same tab instead of opening a stray one —
          // which is what "a blank tab appeared when I reloaded" actually was.
          const freed = await this.waitForFreedTab(target, survey.claimedByOthers);
          if (freed) {
            ({ chosen, reason, candidates, excluded } = freed);
            log.info("connection", "a departing session released the tab — reattaching to it");
          } else {
            ({ chosen, reason, openedNewTab } = await this.escalate(e, survey));
          }
        } else throw e;
      }
    }

    // ── claim it before touching it (F1) ──
    const claim = ctx.registry.claim(this.port, chosen.id, { url: chosen.url, title: chosen.title });
    if (!claim.ok) {
      if (!allowNewTab) {
        fail(CODES.TARGET_CLAIMED,
          `Tab "${chosen.title || chosen.url}" was claimed by ${claim.heldBy?.label || "another session"} a moment ago.`,
          "Retry — selection will skip it now — or pass target:'new'.",
          { heldBy: claim.heldBy });
      }
      log.info("connection", "lost race for tab, opening a fresh one in its own window");
      chosen = await createTarget(this.host, this.port, "about:blank", { newWindow: true });
      const retry = ctx.registry.claim(this.port, chosen.id, { url: chosen.url, title: chosen.title });
      if (!retry.ok) {
        // Losing the race twice in the same browser means contention this browser is
        // not going to resolve. Last rung: our own Chrome, where nothing can be taken
        // from us.
        log.warn("connection", "lost the race twice — escalating to a browser of our own");
        chosen = await this.launchOwnBrowser("about:blank");
        const third = ctx.registry.claim(this.port, chosen.id, { url: chosen.url, title: chosen.title });
        if (!third.ok) fail(CODES.TARGET_CLAIMED, "Could not claim a tab even in a freshly launched browser.",
          "Something is claiming tabs faster than they can be opened — check sessions_list for a runaway session.");
        reason = "new-browser (race lost twice)";
      } else {
        reason = "new-window (race lost on first choice)";
      }
    }

    try {
      // Bounded: a half-open socket to a hung browser would otherwise never settle.
      this.client = await this.withTimeout(
        CDP({ host: this.host, port: this.port, target: chosen.id }),
        ctx.cfg.connectTimeoutMs,
        `CDP connect to ${chosen.id}`,
      );
    } catch (e) {
      ctx.registry.release(this.port, chosen.id);
      if (e instanceof DevCdpError && e.code === CODES.PAGE_UNRESPONSIVE) {
        fail(CODES.CHROME_UNREACHABLE,
          `Chrome accepted the connection but never completed the DevTools handshake within ${ctx.cfg.connectTimeoutMs}ms.`,
          "The browser may be hung. Close and relaunch it with debug-chrome.bat, or use browser:'new'.");
      }
      if (/403|already attached|Target closed/i.test(e.message || "")) {
        fail(CODES.SESSION_CONTENTION,
          `Another DevTools client already owns this tab exclusively.`,
          "Close the DevTools window for that tab, or pass target:'index:1' / target:'new'.",
          { cause: e.message });
      }
      fail(CODES.CHROME_UNREACHABLE, `Could not attach to the tab: ${e.message}`,
        "Confirm Chrome is still running with remote debugging enabled.");
    }

    this.targetId    = chosen.id;
    this.targetUrl   = chosen.url;
    this.targetTitle = chosen.title;
    this.attachedAt  = new Date().toISOString();
    this.detaching   = false;

    // ══ ORDER IS LOAD-BEARING (SRC-1) ══
    this.wire();
    await this.enable();

    await this.installAgent(claim.claim || { label: `DevCDP · session ${ctx.registry.sessionNumber}`, sessionNumber: ctx.registry.sessionNumber });

    // Say on the page itself which session just took this tab, and whether it had to
    // go somewhere new to get it.
    //
    // This is the whole point of the escalation ladder being visible: two agents
    // debugging one app were indistinguishable from one agent, because nothing on
    // screen ever named an owner. A tab that says "session 2 — opened its own window"
    // cannot be mistaken for session 1's tab.
    const n = ctx.registry.sessionNumber;
    const badge = openedNewTab
      ? `session ${n} — opened this ${openedNewTab.launchedBrowserOnPort ? "browser" : openedNewTab.inOwnWindow ? "window" : "tab"}, every other tab was claimed`
      : `session ${n} attached — watching this tab`;
    const [, preAttach] = await Promise.all([
      this.setBadge(badge, null),
      this.snapshotPreAttach(),
    ]);
    this.preAttach = preAttach;
    this.startKeepalive();
    await this.startWatcher();

    const scriptCount = ctx.scripts.size;
    log.info("connection", "attached", { target: chosen.id, reason, scripts: scriptCount });

    return {
      targetId: this.targetId,
      url: this.targetUrl,
      title: this.targetTitle,
      selectedBy: reason,
      attachedAt: this.attachedAt,
      session: {
        id: ctx.sessionId,
        number: ctx.registry.sessionNumber,
        label: claim.claim?.label || null,
      },
      ...(openedNewTab ? { openedNewTab } : {}),
      scriptsIndexed: scriptCount,
      otherSessions: survey.others.map(o => ({ label: o.label, tabs: 1, url: o.url })),
      ...(candidates.length > 1 ? { alsoAvailable: candidates.filter(c => c.id !== chosen.id) } : {}),
      ...(excluded.length ? { skippedClaimedTabs: excluded } : {}),
      preAttach: this.preAttach,
    };
  }

  /**
   * Every tab here belongs to somebody else. Get out of their way.
   *
   * Two rungs, cheapest first:
   *
   *   1. our own tab in its OWN WINDOW, same browser — the session is visibly separate
   *      on screen, and one profile means one companion-extension install, so tab
   *      grouping keeps working. This is the common case and it is nearly free.
   *   2. our own BROWSER, if the browser will not give us a window at all — it is
   *      shutting down, wedged, or refusing Target.createTarget.
   *
   * A window rather than a bare tab because that was the actual complaint: a second
   * session opening a tab on the *same URL* in the *same window* is indistinguishable
   * from the first session's tab, so two agents look like they are sharing one page
   * even when they are not.
   */
  async escalate(claimedError, survey) {
    const claimedUrls = (claimedError.details?.claimed || []).map(c => c.url).filter(Boolean);
    const wanted  = claimedUrls.find(u => /^https?:/i.test(u));
    const openUrl = wanted || "about:blank";

    const context = {
      url: openUrl,
      claimedTabs: claimedUrls.slice(0, 5),
      otherSessions: survey.others.map(o => o.label),
      hint: survey.others.length === 1
        ? "If you are not deliberately running two agents, this is usually the same server registered twice in your "
          + "editor config — check with sessions_list, and re-run initialize_MCP.js, which removes duplicate entries."
        : undefined,
    };

    // ── rung 1: our own window in the browser we are already talking to ──
    try {
      log.info("connection", `every tab is claimed — opening our own window on ${openUrl}`);
      const chosen = await createTarget(this.host, this.port, openUrl, { newWindow: true });
      return {
        chosen,
        reason: "new-window (every existing tab is claimed by another session)",
        openedNewTab: {
          ...context,
          because: "every existing tab was already claimed by another DevCDP session",
          inOwnWindow: true,
          note: "Opened in a separate browser window so this session's tab is not mistaken for another session's.",
        },
      };
    } catch (e) {
      log.warn("connection", `could not open a window in the browser on ${this.port}: ${e.message}`);
    }

    // ── rung 2: a browser of our own ──
    const fromPort = this.port;
    const chosen = await this.launchOwnBrowser(openUrl);
    return {
      chosen,
      reason: "new-browser (every tab claimed and the browser would not open a window)",
      openedNewTab: {
        ...context,
        because: `every tab on port ${fromPort} was claimed and that browser refused to open a new window`,
        launchedBrowserOnPort: this.port,
      },
    };
  }

  /**
   * Launch a Chrome that belongs to this session, and point us at it.
   *
   * Mutates this.port — everything downstream (the claim, the CDP socket, the target
   * watcher) reads it, so the switch has to happen before any of them run.
   *
   * The browser is registered but never closed on our way out: it is spawned detached
   * so the user keeps it, and only the registry record is released when the session
   * ends, which is what lets the next session adopt it.
   */
  async launchOwnBrowser(url = "about:blank") {
    const ctx  = this.ctx;
    const port = await findFreePort(this.host, ctx.cfg.portRange, portsInUse());

    log.info("connection", `escalating to a browser of our own on port ${port}`);
    const launched = await launchChrome({ port, cfg: ctx.cfg, url, host: this.host });

    ctx.registry.registerBrowser(port, {
      pid: launched.pid, executable: launched.executable, profile: launched.profile,
    });

    this.port = port;
    this.launchedBrowser = launched;

    if (launched.extensionLoaded === false) {
      log.warn("connection",
        "launched browser has no companion extension, so its tabs will not be grouped — "
        + "set chromePath to Chromium or Chrome for Testing to get grouping automatically");
    }

    // A fresh Chrome already opened `url` in its first window; adopt that tab rather
    // than opening a second one next to it.
    const existing = await listPageTargets(this.host, port).catch(() => []);
    const adoptable = existing.find(t => t.url === url)
                   || existing.find(t => t.url && t.url !== "about:blank")
                   || existing[0];
    if (adoptable) return adoptable;

    return await createTarget(this.host, port, url);
  }

  /**
   * Give a departing session a moment to release its tab.
   *
   * Reloading an assistant starts the new MCP server before the old one has
   * finished exiting, so for a second or two the tab is legitimately claimed by a
   * session that is about to disappear. Opening a fresh tab in that window is what
   * produced a stray blank tab on every reload. Re-surveying briefly turns that
   * into a clean reattachment to the same tab.
   *
   * @returns the pickTarget result once something frees up, or null.
   */
  async waitForFreedTab(target, initiallyClaimed) {
    const budget = this.ctx.cfg.claimGraceMs;
    if (!budget || budget <= 0) return null;

    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 220));
      const survey = this.ctx.registry.survey(this.port);
      // Only interesting if something actually changed hands.
      if (survey.claimedByOthers.size >= initiallyClaimed.size) continue;
      try {
        return await pickTarget({
          host: this.host, port: this.port, target,
          excludeIds: survey.claimedByOthers,
        });
      } catch (_) { /* still nothing free — keep waiting */ }
    }
    return null;
  }

  // ── event wiring (BEFORE enable) ──────────────────────────────────────────
  wire() {
    const ctx = this.ctx;
    const c   = this.client;

    // ── console ──
    c.Runtime.consoleAPICalled(({ type, args, stackTrace, timestamp }) => {
      const text = (args || [])
        .map(a => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(" ");
      const top = stackTrace?.callFrames?.[0];
      this.pushLog({
        level: type, text, source: "console",
        url: top?.url || null,
        line: line1(top?.lineNumber),
        column: line1(top?.columnNumber),
        fn: top?.functionName || null,
        timestamp: timestamp ? new Date(timestamp).toISOString() : undefined,
      });
    });

    c.Runtime.exceptionThrown(({ exceptionDetails: ex }) => {
      const frames = ex.stackTrace?.callFrames || [];
      // SPY-4 — never surface our own agent's problems as app errors.
      const fromAgent = frames.some(f => f.url === "" && /__devcdp/.test(f.functionName || ""))
        || /__devcdp/.test(ex.exception?.description || "");
      this.pushLog({
        level: "error",
        text: ex.exception?.description?.split("\n")[0] || ex.text,
        exception: ex.exception?.description || null,
        source: fromAgent ? "devcdp-agent" : "exception",
        url: ex.url || frames[0]?.url || null,
        line: line1(ex.lineNumber ?? frames[0]?.lineNumber),
        column: line1(ex.columnNumber ?? frames[0]?.columnNumber),
        stack: frames.slice(0, 8).map(f => `${f.functionName || "(anonymous)"} ${f.url}:${line1(f.lineNumber)}:${line1(f.columnNumber)}`),
        ...(fromAgent ? { note: "Raised by DevCDP's own injected agent, not your app." } : {}),
      });
    });

    // ── network ──
    c.Network.requestWillBeSent(({ requestId, request, timestamp, type, initiator }) => {
      ctx.network.start(requestId, {
        requestId, url: request.url, method: request.method,
        type: type || "Other",
        status: null, error: null,
        startTime: timestamp,
        initiator: initiator?.type || null,
        _reqHeaders: request.headers,
        _postData: request.postData ? request.postData.slice(0, ctx.cfg.maxPostDataBytes) : null,
      });
      ctx.recordActivity("network_request", { url: request.url, method: request.method });
    });

    c.Network.responseReceived(({ requestId, response, timestamp }) => {
      const req = ctx.network.get(requestId);
      if (!req) return;
      Object.assign(req, {
        status: response.status,
        statusText: response.statusText || null,
        mimeType: response.mimeType,
        remoteAddress: response.remoteIPAddress || null,
        fromCache: !!response.fromDiskCache,
        endTime: timestamp,
        durationMs: Math.round((timestamp - req.startTime) * 1000),
        _resHeaders: response.headers,
      });
      ctx.recordActivity("network_response", { url: req.url, status: response.status });
      this.resolveWaiters(req);
    });

    c.Network.loadingFailed(({ requestId, errorText, timestamp, canceled }) => {
      const req = ctx.network.get(requestId);
      if (!req) return;
      Object.assign(req, {
        error: errorText, canceled: !!canceled, endTime: timestamp,
        durationMs: Math.round((timestamp - req.startTime) * 1000),
      });
      ctx.recordActivity("network_error", { url: req.url, error: errorText });
      this.resolveWaiters(req);
    });

    c.Network.loadingFinished(({ requestId, encodedDataLength }) => {
      const req = ctx.network.get(requestId);
      if (req) req.bytes = encodedDataLength;
    });

    // ── execution contexts, so DOM/eval can reach iframes too (DOM-1) ──
    c.Runtime.executionContextCreated(({ context }) => {
      ctx.contexts.set(context.id, {
        id: context.id,
        origin: context.origin,
        name: context.name || null,
        frameId: context.auxData?.frameId || null,
        isDefault: !!context.auxData?.isDefault,
      });
    });
    c.Runtime.executionContextDestroyed(({ executionContextId }) => ctx.contexts.delete(executionContextId));
    c.Runtime.executionContextsCleared(() => ctx.contexts.clear());

    // ── scripts (the SRC-1 subscription) ──
    c.Debugger.scriptParsed(({ scriptId, url, sourceMapURL, hasSourceURL, length }) => {
      if (!url) return;
      ctx.scripts.set(scriptId, {
        scriptId, url,
        sourceMapURL: sourceMapURL || null,
        hasSourceMap: !!sourceMapURL,
        hasSourceURL: !!hasSourceURL,
        bytes: length ?? null,
      });
    });

    // ── debugger pause ──
    c.Debugger.paused(async (params) => { await this.onPaused(params); });
    c.Debugger.resumed(() => {
      ctx.pause.active = false;
      ctx.pause.callFrames = null;
      if (ctx.pause.capture) ctx.pause.capture.isCurrent = false;   // DBG-5
      this.clearPauseWatchdog();
      this.showPausedMessage(null);      // undim the page
      this.setBadge("running", null);
      // Page JS was stopped, so the overlay could not hear from us while paused.
      // Say so immediately rather than leaving it to the next keepalive.
      this.beatAgents();
    });

    // ── page ──
    c.Page.frameNavigated(({ frame }) => {
      if (frame.parentId) return;
      this.targetUrl = frame.url;
      ctx.recordActivity("navigation", { url: frame.url });
      ctx.network.clear();          // a new document: old requestIds are unusable
      this.notifyAsk({ type: "navigation", url: frame.url });
    });

    // A new document means a new agent with empty state, so anything the user still
    // needs to see has to be put back (UI-10).
    c.Page.loadEventFired(() => {
      this.restoreOverlayState()
        // Close the loop the "navigating"/"reloading" toast opened. A progress
        // message with no completion leaves the user unsure whether it finished or
        // stalled, which is the state this overlay exists to remove.
        .then(() => this.setBadge(`loaded ${shortUrl(this.targetUrl)}`, null))
        .catch(() => {});
    });

    // A tab the app opens for itself. The Target event that follows carries no
    // openerId when the link asked for noopener, so record that one is expected.
    c.Page.windowOpen(({ url }) => {
      // One event, one tab. Without that limit a burst of new targets — or a tab the
      // user happened to open at the same moment — would all be swept up as ours.
      this.pendingOpen = { url: url || "", until: Date.now() + 4000 };
      ctx.recordActivity("window_open", { url });
    });

    c.Page.javascriptDialogOpening(async ({ message, type }) => {
      log.info("dialog", `${type} auto-accepted`, { message: (message || "").slice(0, 80) });
      try { await c.Page.handleJavaScriptDialog({ accept: true }); } catch (_) {}
      ctx.recordActivity("browser_dialog", { dialogType: type, message: (message || "").slice(0, 200), handled: "accepted" });
      this.notifyAsk({ type: "browser_dialog", dialogType: type, message });
    });

    // ── in-page agent events ──
    c.Runtime.bindingCalled(({ name, payload }) => {
      if (name !== BINDING) return;
      let evt;
      try { evt = JSON.parse(payload); } catch (_) { return; }

      switch (evt.type) {
        case "dom_mutation":
          for (const m of evt.mutations || []) ctx.mutations.push({ ...m, ts: new Date().toISOString() });
          return;
        case "agent_error":
          log.warn("agent", `in-page feature failed: ${evt.feature}`, { message: evt.message });
          ctx.recordActivity("agent_error", { feature: evt.feature, message: evt.message });
          return;
        case "dialog_opened":
          ctx.recordActivity("dialog_opened", evt);
          this.notifyAsk(evt);
          return;
        case "dialog_closed":
          ctx.recordActivity("dialog_closed", evt);
          return;
        case "user_confirmed":
          ctx.recordActivity("user_confirmed", evt);
          this.notifyAsk({ ...evt, explicit: true });
          return;
        case "user_takeover":
          // The user pressed Ctrl+Shift+D to drive. Everything they do is still
          // recorded, and the model can read it whether or not it asked.
          ctx.session.userHasControl = evt.active === true;
          ctx.recordActivity("user_takeover", evt);
          log.info("session", evt.active ? "user took control of the tab" : "user handed control back");
          return;
        default: {
          ctx.recordActivity("user_interaction", evt);
          ctx.userActions.push({ ...evt, at: new Date().toISOString() });
          // An action may be the answer to an open question, in which case
          // session_poll_user_action reports it and it is expected rather than
          // interference. notifyAsk consumes it if so.
          const ask = ctx.session.pendingAsk;
          this.notifyAsk(evt);
          if (!(ask && ask.captured === evt)) this.noteInterference(evt);
        }
      }
    });

    c.on("disconnect", () => {
      if (!this.detaching) log.warn("connection", "CDP disconnected unexpectedly");
      this.stopKeepalive();
      this.client = null;
      // A dropped socket has two very different causes needing opposite handling: a
      // transient failure, where the claim must be kept so we can reattach to the same
      // tab, and a closed tab, where the claim now refers to something that does not
      // exist. Only the second releases. Without this, closing a tab left its claim
      // held for the life of the process — and since session numbers are the smallest
      // unused integer, those ghosts pushed the next real session to "session 3" with
      // no sessions 1 or 2 anywhere to be seen.
      if (!this.detaching && this.targetId) this.releaseIfTabGone().catch(() => {});
    });
  }

  async enable() {
    const c = this.client;
    await Promise.all([
      c.Runtime.enable(),
      c.Page.enable(),
      c.Network.enable({ maxPostDataSize: this.ctx.cfg.maxPostDataBytes }),
      c.DOM.enable(),
      c.CSS.enable(),
      c.Debugger.enable(),      // replays scriptParsed — listener is already up
    ]);
    await c.Runtime.addBinding({ name: BINDING }).catch(() => {});

    // Chrome's own "Paused in debugger" bar. It is rendered by the browser, adds
    // zero DOM nodes, and gives the user working resume/step controls.
    //
    // The message is deliberately NOT set here. setPausedInDebuggerMessage makes
    // Chrome display the overlay — dimming the whole page — the moment it is set,
    // regardless of whether execution is actually paused. Setting it at attach
    // therefore left every tab looking permanently frozen. It is set on pause and
    // cleared on resume instead.
    try {
      await c.Overlay.enable();
      this.pausedOverlay = true;
    } catch (e) {
      this.pausedOverlay = false;
      log.debug("connection", `native paused overlay unavailable: ${e.message}`);
    }
  }

  // ── in-page agent ─────────────────────────────────────────────────────────
  async installAgent(claim) {
    const ctx = this.ctx;
    this.agentCfg = {
      sessionId: ctx.sessionId,
      sessionNumber: claim.sessionNumber || ctx.registry.sessionNumber || 1,
      label: claim.label || `DevCDP · session ${ctx.registry.sessionNumber || 1}`,
      bindingName: BINDING,
      dialogSelectors: ctx.cfg.dialogSelectors,
      testAttributes: ctx.cfg.testAttributes,
      badge: ctx.cfg.badge,
      corner: ctx.cfg.badgeCorner,
      edgePulse: ctx.cfg.edgePulse,
      autoCollapse: ctx.cfg.badgeAutoCollapse,
      idleMs: ctx.cfg.badgeIdleMs,
      tabGroupMode: ctx.cfg.tabGroupMode,
      showCursor: ctx.cfg.showCursor,
      toasts: ctx.cfg.toasts,
      toastCorner: ctx.cfg.toastCorner,
      toastMs: ctx.cfg.toastMs,
      toastOpacity: ctx.cfg.toastOpacity,
      toastMaxVisible: ctx.cfg.toastMaxVisible,
      captureValues: ctx.cfg.captureInputValues,
      ownerTimeoutMs: ctx.cfg.ownerTimeoutMs,
    };
    const source = buildAgentSource(this.agentCfg);

    // Future documents…
    try {
      const { identifier } = await this.client.Page.addScriptToEvaluateOnNewDocument({ source });
      this.agentScriptId = identifier;
    } catch (e) { log.warn("agent", `could not register on-new-document script: ${e.message}`); }

    // …and the one already loaded.
    try { await this.eval(source, { label: "agent install", timeoutMs: 5000 }); }
    catch (e) { log.warn("agent", `could not evaluate into current document: ${e.message}`); }

    return this.agentReport();
  }

  /**
   * Tell every overlay this session owns that we are still here (UI-5).
   * Fire-and-forget: a beat that fails is indistinguishable to us from a tab that
   * has gone away, and the overlay's own watchdog handles both.
   */
  /** Give up our claim if the tab it refers to has actually gone. */
  async releaseIfTabGone() {
    const id = this.targetId;
    if (!id) return false;
    let pages;
    try { pages = await listPageTargets(this.host, this.port); }
    catch (_) { return false; }                 // browser unreachable: assume nothing
    if (pages.some(t => t.id === id)) return false;
    this.ctx.registry.release(this.port, id);
    log.info("connection", "the attached tab was closed — released its claim", { target: id });
    return true;
  }

  beatAgents() {
    this.evalQuiet(`window.__devcdp && window.__devcdp.beat()`).catch(() => {});
    for (const [id, f] of this.followed) {
      f.client?.Runtime?.evaluate({ expression: `window.__devcdp && window.__devcdp.beat()`, returnByValue: true })
        .catch(() => { this.dropFollowed(id); });
    }
  }

  // ── tabs the application opens for itself (UI-6) ───────────────────────────
  async startWatcher() {
    if (!this.ctx.cfg.followNewTabs || this.watcher) return;
    this.watcher = new TargetWatcher(this.host, this.port);
    const ok = await this.watcher.start({
      onCreated:   info => { this.maybeAdopt(info).catch(() => {}); },
      onChanged:   info => {
        const f = this.followed.get(info.targetId);
        if (f) { f.url = info.url || f.url; f.title = info.title || f.title; }
      },
      onDestroyed: id   => { this.dropFollowed(id); },
    });
    if (!ok) this.watcher = null;
  }

  /**
   * Decide whether a newly created tab belongs to the flow we are debugging.
   *
   * `openerId` is the reliable signal, but a link carrying rel="noopener" arrives
   * without one — so a recent `Page.windowOpen` on our own target counts as
   * corroboration for a few seconds. Anything else is somebody else's tab and is
   * deliberately left alone.
   */
  async maybeAdopt(info) {
    if (!this.client || this.detaching) return;
    if (info.targetId === this.targetId || this.followed.has(info.targetId)) return;

    // Opened by the tab we are attached to, or by one we already adopted — a detail
    // window that opens a further window is still part of the same flow.
    const ours = !!info.openerId &&
                 (info.openerId === this.targetId || this.followed.has(info.openerId));

    // No openerId: either a rel="noopener" link from our page, or somebody else's
    // tab entirely. Only a window.open we just watched happen, still unspent, and
    // with a matching destination counts as corroboration.
    const p = this.pendingOpen;
    const blank = !info.url || info.url === "about:blank";
    const pending = !info.openerId && p && p.until > Date.now() &&
                    (blank || !p.url || p.url === info.url);
    if (!ours && !pending) return;
    if (pending) this.pendingOpen = null;

    const survey = this.ctx.registry.survey(this.port);
    if (survey.claimedByOthers.has(info.targetId)) return;

    const claim = this.ctx.registry.claim(this.port, info.targetId, {
      url: info.url, title: info.title, label: this.agentCfg?.label,
    });
    if (!claim.ok) return;

    let client = null;
    try {
      client = await this.withTimeout(
        CDP({ host: this.host, port: this.port, target: info.targetId }),
        this.ctx.cfg.connectTimeoutMs, `follow tab ${info.targetId}`);
      const source = buildAgentSource({ ...this.agentCfg, label: `${this.agentCfg.label} · opened tab` });
      await client.Page.enable();
      await client.Page.addScriptToEvaluateOnNewDocument({ source });
      await client.Runtime.evaluate({ expression: source, returnByValue: true });
      this.followed.set(info.targetId, { client, url: info.url, title: info.title, adoptedAt: new Date().toISOString() });
      log.info("connection", "adopted a tab the app opened", { target: info.targetId, url: info.url });
    } catch (e) {
      log.warn("connection", `could not follow new tab: ${e.message}`);
      try { await client?.close(); } catch (_) {}
      this.ctx.registry.release(this.port, info.targetId);
    }
  }

  dropFollowed(targetId) {
    const f = this.followed.get(targetId);
    if (!f) return;
    this.followed.delete(targetId);
    try { f.client?.close?.(); } catch (_) {}
    try { this.ctx.registry.release(this.port, targetId); } catch (_) {}
  }

  /** Tabs the app opened that we are holding — reported so the model can switch. */
  followedTabs() {
    return [...this.followed.entries()].map(([id, f]) => ({
      targetId: id, url: f.url || "about:blank", title: f.title || null,
      switchWith: `devtools_connect target:'id:${id}'`,
    }));
  }

  async releaseFollowed() {
    for (const [id, f] of [...this.followed]) {
      try { await f.client?.Runtime?.evaluate({ expression: `window.__devcdp && window.__devcdp.teardown()`, returnByValue: true }); } catch (_) {}
      this.dropFollowed(id);
    }
  }

  async agentReport() {
    try {
      const value = await this.evalQuiet(`(window.__devcdp && window.__devcdp.report) ? JSON.stringify(window.__devcdp.report()) : "null"`);
      return JSON.parse(value || "null");
    } catch (_) { return null; }
  }

  /**
   * Show or clear Chrome's native paused banner. Passing no message clears it —
   * which must happen on resume, or the page stays dimmed and looks frozen.
   */
  async showPausedMessage(message) {
    if (!this.client || !this.pausedOverlay) return false;
    try {
      await this.client.Overlay.setPausedInDebuggerMessage(message ? { message } : {});
      this.pausedMessageShown = !!message;
      return true;
    } catch (_) { return false; }
  }

  /**
   * Remember that somebody touched the page while we were working (COLLAB-5).
   *
   * Interference is not an error — a developer clicking through the reproduction is
   * the tool working as intended. The failure mode is silence: the action was recorded
   * in a buffer nobody had a reason to read, so the model went on reasoning about a
   * page that had changed underneath it, and its next conclusion was drawn from a
   * state that no longer existed. So the next response says so, the way a reconnect or
   * a script termination does.
   */
  noteInterference(evt) {
    const s = this.ctx.session;
    // While a question is open — or answered and not yet collected — the user acting
    // is precisely what was asked for. Warning about it would cry wolf, and a warning
    // that fires when nothing is wrong stops being read.
    if (s.pendingAsk) return;
    if (!s.interference) s.interference = { count: 0, actions: [] };
    s.interference.count++;
    if (s.interference.actions.length < 5) {
      s.interference.actions.push({
        action:  evt.type,
        element: evt.selector || evt.testId || evt.text || evt.tag || undefined,
        at:      new Date().toISOString(),
        while:   s.userHasControl ? "user has control" : "unprompted",
      });
    }
  }

  /** Update the in-page badge — the user-visible status channel (SESS-2). */
  async setBadge(text, kind) {
    if (!this.client || !this.ctx.cfg.badge) return false;
    try {
      await this.evalQuiet(`window.__devcdp && window.__devcdp.setStatus(${JSON.stringify(String(text ?? ""))}, ${JSON.stringify(kind || null)})`);
      return true;
    } catch (_) { return false; }
  }

  /**
   * Put back what the user still needs to see after a navigation.
   *
   * A pending question lives in two places: the server, which waits for an answer, and
   * the page, which shows the instruction and the only button that can give one. A page
   * load wipes the second — so asking someone to "log in, then press the button" broke
   * itself: logging in is a navigation, the panel vanished with it, and the session sat
   * waiting for a button that no longer existed. Nothing on screen said anything was
   * expected. The instruction most likely to involve navigating is exactly the one this
   * mechanism exists for, so this is not an edge case.
   */
  async restoreOverlayState() {
    const ask = this.ctx.session.pendingAsk;
    if (ask && !ask.captured) {
      await this.askInPage(ask.instruction);
      this.ctx.recordActivity("ask_restored", { instruction: ask.instruction, after: "navigation" });
      log.info("session", "re-showed the pending question after a navigation");
      return true;
    }
    // No question, but the tab should still say who is driving it.
    if (this.ctx.session.userHasControl) {
      await this.setBadge("you have control — DevCDP is watching", "ask");
    }
    return false;
  }

  async askInPage(instruction) {
    if (!this.client) return false;
    try {
      await this.evalQuiet(`window.__devcdp && window.__devcdp.ask(${JSON.stringify(String(instruction))})`);
      return true;
    } catch (_) { return false; }
  }

  /**
   * Flash Chrome's inspector highlight over the first element matching a selector,
   * and point the in-page cursor at it, so a human watching can see what DevCDP is
   * looking at. The highlight is drawn by the browser — nothing is added to the DOM.
   */
  /** Take the cursor label down, so it never describes something we are not showing. */
  async clearPointer() {
    await this.evalQuiet(`window.__devcdp && window.__devcdp.clearPointer && window.__devcdp.clearPointer()`);
  }

  async showInspected(selector, { label = null, ms = 1400 } = {}) {
    if (!this.client || !this.ctx.cfg.highlightInspected) return false;
    try {
      const { root } = await this.client.DOM.getDocument({ depth: 0 });
      const { nodeId } = await this.client.DOM.querySelector({ nodeId: root.nodeId, selector });
      // A label left over from the previous element is worse than none: it points the
      // watcher confidently at the wrong thing. Observed pointing at "input · 3 matches"
      // while the query was for anchors.
      if (!nodeId) { await this.clearPointer(); return false; }

      await this.client.Overlay.highlightNode({
        nodeId,
        highlightConfig: {
          showInfo: true,
          contentColor: { r: 43, g: 127, b: 212, a: 0.28 },
          borderColor:  { r: 43, g: 127, b: 212, a: 0.9 },
        },
      });

      // Also nudge the in-page cursor to the element's centre.
      const { model } = await this.client.DOM.getBoxModel({ nodeId }).catch(() => ({ model: null }));
      if (model?.content?.length >= 4) {
        const x = Math.round((model.content[0] + model.content[2]) / 2);
        const y = Math.round((model.content[1] + model.content[5]) / 2);
        // The selector is the useful part — it is what you would type yourself — so it
        // is always shown. A label used to replace it, which lost it in the commonest
        // case of all: dom_query pointing at what it just matched.
        const shown = selector.length > 60 ? selector.slice(0, 57) + "…" : selector;
        const tip = label ? `${shown} · ${label}` : shown;
        await this.evalQuiet(`window.__devcdp && window.__devcdp.pointAt(${x}, ${y}, ${JSON.stringify(tip)})`);
      } else {
        await this.clearPointer();          // located, but nothing to point at
      }

      setTimeout(() => { this.client?.Overlay.hideHighlight().catch(() => {}); }, ms);
      return true;
    } catch (_) { return false; }
  }

  async clearAskInPage() {
    if (!this.client) return false;
    try {
      await this.evalQuiet(`window.__devcdp && window.__devcdp.clearAsk()`);
      return true;
    } catch (_) { return false; }
  }

  // ── pre-attach history (OBS-1) ────────────────────────────────────────────
  // CDP cannot replay console history, and network events only start at attach.
  // Resource timing, however, is retained by the page — so we can at least tell
  // the model what loaded before we arrived, and be explicit about the boundary.
  async snapshotPreAttach() {
    try {
      const { result } = await this.eval(`JSON.stringify((function(){
          var out={readyState:document.readyState,url:location.href,title:document.title,resources:[],errorsRecoverable:false};
          try{
            var e=performance.getEntriesByType('resource')||[];
            out.resourceCount=e.length;
            out.resources=e.slice(-40).map(function(r){return {url:r.name,type:r.initiatorType,ms:Math.round(r.duration),bytes:r.transferSize||0};});
            var nav=(performance.getEntriesByType('navigation')||[])[0];
            if(nav)out.pageLoadMs=Math.round(nav.duration);
          }catch(_){}
          return out;
        })())`, { label: "pre-attach snapshot", timeoutMs: 5000 });
      const snap = JSON.parse(result.value || "{}");
      // The resource list was up to 40 entries of URLs nobody reads; the count and
      // the boundary itself are what matter.
      return {
        readyState: snap.readyState,
        resourcesLoadedBeforeAttach: snap.resourceCount ?? 0,
        pageLoadMs: snap.pageLoadMs,
        // Kept as an explicit boolean, not just prose: a machine-readable flag is
        // more reliable for a small model than inferring it from a sentence.
        consoleHistoryAvailable: false,
        note: "Console history and network traffic from before this moment are not available. Reproduce the action, or page_reload, to capture them.",
      };
    } catch (_) {
      return { consoleHistoryAvailable: false, note: "Pre-attach snapshot unavailable." };
    }
  }

  // ── pause handling ────────────────────────────────────────────────────────
  async onPaused({ callFrames, reason, data, hitBreakpoints }) {
    const ctx = this.ctx;
    const pauseId = ++ctx.pause.id;

    ctx.pause.active     = true;
    ctx.pause.callFrames = callFrames;
    ctx.pause.reason     = reason;

    const top = callFrames?.[0];
    log.info("debugger", `paused (${reason})`, { at: this.frameLabel(top) });
    // Chrome's native bar tells the user the page is paused, and where.
    if (this.pausedOverlay) {
      this.showPausedMessage(`Paused by DevCDP · session ${ctx.registry.sessionNumber || 1} — ${this.frameLabel(top)}`);
    } else {
      this.setBadge(`paused at ${this.frameLabel(top)}`, "paused");
    }

    const hit = hitBreakpoints?.[0] || null;
    const desired = hit ? [...ctx.desired.breakpoints.values()].find(b => b.breakpointId === hit) : null;

    // ── who decides when to resume ──────────────────────────────────────────
    // Default: DevCDP resumes itself as soon as it has the values, so the page is
    // never left frozen and the action that tripped the breakpoint can complete.
    // A hold is only honoured when it was explicitly asked for — an interactive
    // pause, a step, or a breakpoint set with auto_resume:false.
    if (desired?.autoResume === false) this.holdUntilResumed = true;
    const holding = this.holdUntilResumed === true;

    const capture = {
      pauseId,
      isCurrent: true,
      reason,
      hitBreakpoint: hit,
      capturedAt: new Date().toISOString(),
    };

    try {
      const frames = [];
      for (const [i, frame] of (callFrames || []).slice(0, 5).entries()) {
        frames.push({
          index: i,
          fn: frame.functionName || "(anonymous)",
          url: this.frameFile(frame),
          ...(this.frameFile(frame) ? {} : { origin: this.frameOrigin(frame) }),
          line: line1(frame.location?.lineNumber),
          column: line1(frame.location?.columnNumber),
          // Depth is quadratic in tokens. The innermost frame is where the answer
          // almost always is, so it gets the full expansion; any other frame can be
          // expanded on demand with debugger_get_scope.
          scope: i === 0 ? await captureFrameScope(this.client, frame, { depth: 3, maxProps: 25 })
               : i < 3   ? await captureFrameScope(this.client, frame, { depth: 1, maxProps: 12 })
               : undefined,
          ...(i >= 3 ? { scopeNote: "Call debugger_get_scope(frame_index) for this frame." } : {}),
        });
      }
      capture.frames = frames;
      capture.callStackDepth = callFrames?.length || 0;

      const logs = ctx.consoleBuf().since(0).slice(-8);
      capture.logs    = { count: logs.length, items: logs };
      const reqs = ctx.network.all().slice(-6).map(r => this.publicRequest(r));
      capture.network = { count: reqs.length, items: reqs };
    } catch (e) {
      capture.captureError = e.message;
    }

    ctx.pause.capture = capture;
    ctx.recordActivity("paused", { reason, at: this.frameLabel(top), pauseId });

    // DBG-2 — a frozen page makes the automation action that triggered this time
    // out, so unless a hold was explicitly requested, resume now that we have the
    // values. The capture keeps everything we needed from the pause.
    capture.holdRequested = holding;
    if (!holding && this.ctx.cfg.autoResumeDefault) {
      try {
        await this.client.Debugger.resume();
        capture.autoResumed = true;
        log.info("debugger", "captured and resumed automatically");
      } catch (e) {
        capture.autoResumeFailed = e.message;
      }
    } else {
      this.armPauseWatchdog(pauseId);
    }
  }

  /**
   * Backstop for a held pause. Nothing outside DevCDP should ever have to press
   * resume in Chrome — if a hold is forgotten, or the agent stops responding, the
   * page is released anyway rather than left dead on screen.
   */
  armPauseWatchdog(pauseId) {
    this.clearPauseWatchdog();
    const ms = this.ctx.cfg.maxPauseMs;
    if (!ms || ms <= 0) return;
    this.pauseWatchdog = setTimeout(async () => {
      if (!this.ctx.pause.active || this.ctx.pause.id !== pauseId) return;
      log.warn("debugger", `pause held for ${ms}ms — resuming automatically`);
      try {
        await this.client?.Debugger.resume();
        this.holdUntilResumed = false;
        if (this.ctx.pause.capture) this.ctx.pause.capture.watchdogResumed = true;
        this.ctx.recordActivity("pause_watchdog_resumed", { pauseId, afterMs: ms });
        this.setBadge("resumed automatically", null);
      } catch (_) {}
    }, ms);
    this.pauseWatchdog.unref?.();
  }

  clearPauseWatchdog() {
    if (this.pauseWatchdog) { clearTimeout(this.pauseWatchdog); this.pauseWatchdog = null; }
  }

  // ── network waiters ───────────────────────────────────────────────────────
  resolveWaiters(req) {
    const waiters = this.ctx.waiters;
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (!req.url.includes(w.filter)) continue;
      if (w.method && req.method !== w.method) continue;
      clearTimeout(w.timer);
      waiters.splice(i, 1);
      w.resolve(req);                 // NET-2 — the actual request, not a rescan
    }
  }

  /**
   * A request as the caller sees it.
   *
   * Lean by default: url, method, status, timing, size, and anything that went
   * wrong. Mime type, remote address, cache flag, initiator and requestId are real
   * but rarely read, and at twenty rows a call they were most of the response.
   * Pass full to restore everything.
   */
  publicRequest(r, { headers = false, postData = false, full = false } = {}) {
    const { _reqHeaders, _resHeaders, _postData, startTime, endTime, ...base } = r;
    const lean = full ? base : {
      requestId: r.requestId,
      url: r.url,
      method: r.method,
      status: r.status,
      durationMs: r.durationMs,
      bytes: r.bytes,
      ...(r.type && r.type !== "XHR" && r.type !== "Fetch" ? { type: r.type } : {}),
      ...(r.error     ? { error: r.error }  : {}),
      ...(r.canceled  ? { canceled: true }  : {}),
      ...(r.fromCache ? { fromCache: true } : {}),
    };
    return {
      ...lean,
      ...(headers  ? { requestHeaders: _reqHeaders, responseHeaders: _resHeaders } : {}),
      ...(postData ? { postData: _postData } : {}),
    };
  }

  /**
   * The file a paused frame belongs to.
   *
   * Chrome returns `url: ""` on CallFrame when the script carries a source map,
   * even though the script itself has a perfectly good URL — so trusting
   * frame.url produced labels like "paused at :2" and frames with no file at all.
   * The scriptId is always present, and our own index has the URL.
   */
  frameFile(frame) {
    if (frame?.url) return frame.url;
    const scriptId = frame?.location?.scriptId || frame?.functionLocation?.scriptId;
    return (scriptId && this.ctx.scripts.get(scriptId)?.url) || null;
  }

  /**
   * Why a frame has no file. A frame created by Runtime.evaluate — including the
   * calls DevCDP itself makes to trigger things — genuinely has no source file,
   * which is different from us having failed to resolve one.
   */
  frameOrigin(frame) {
    if (this.frameFile(frame)) return null;
    const scriptId = frame?.location?.scriptId;
    if (scriptId && !this.ctx.scripts.has(scriptId)) return "evaluated code — no source file (injected or eval'd)";
    return "no source file associated with this frame";
  }

  /** Short "file:line" for humans — used in the badge and the log. */
  frameLabel(frame) {
    const file = this.frameFile(frame);
    const line = line1(frame?.location?.lineNumber);
    const base = file ? file.split("?")[0].split("/").pop() : null;
    if (base) return `${base}:${line}`;
    return frame?.functionName ? `${frame.functionName}() line ${line}` : `line ${line}`;
  }

  pushLog(entry) {
    const buf = this.ctx.consoleBuf();
    entry.timestamp = entry.timestamp || new Date().toISOString();
    buf.push(entry);
    this.ctx.recordActivity("console", { level: entry.level, text: (entry.text || "").slice(0, 160) });
    return entry;
  }

  notifyAsk(evt) {
    const ask = this.ctx.session.pendingAsk;
    if (!ask || ask.captured) return;
    const want = ask.waitFor || "any_action";
    const ok =
      evt.explicit ||                                            // badge "I've done it"
      want === "any_action" ||
      (want === "navigation"      && evt.type === "navigation") ||
      (want === "click"           && evt.type === "click") ||
      (want === "dialog"          && evt.type === "dialog_opened") ||
      (want === "confirmation"    && evt.explicit === true);
    if (ok) {
      ask.captured = evt;
      ask.capturedAt = new Date().toISOString();
      this.clearAskInPage();
      this.setBadge("resuming", null);
    }
  }

  // ── keepalive / reconnect ─────────────────────────────────────────────────
  startKeepalive() {
    this.stopKeepalive();
    this.keepalive = setInterval(async () => {
      if (!this.client) return;
      // The same tick proves the socket is alive and tells the in-page overlay its
      // owner is still here. Stop beating and the overlay removes itself, so a
      // crashed server can never leave a tab looking driven (UI-5).
      try { await this.eval("1", { timeoutMs: 5000, label: "keepalive" }); this.beatAgents(); }
      catch (e) {
        // A wedged renderer is not a dead socket — do not throw the session away.
        if (e?.code === "PAGE_UNRESPONSIVE") { log.warn("connection", "keepalive stalled — page main thread is blocked"); return; }
        log.warn("connection", "keepalive failed — will reattach on next call");
        this.client = null;
      }
    }, KEEPALIVE_MS);
    this.keepalive.unref?.();
  }

  stopKeepalive() { if (this.keepalive) { clearInterval(this.keepalive); this.keepalive = null; } }

  /**
   * Called before every tool that needs the page. Reattaches and — unlike v4 —
   * restores state, verifies the tab, and says what it had to do (CONN-2).
   */
  async ensure() {
    // Every tool that touches the page comes through here, so this is the cheapest
    // place to keep the overlay's owner-liveness fresh between keepalive ticks.
    if (this.client) { this.beatAgents(); return { reconnected: false }; }
    if (!this.targetId) {
      fail(CODES.NOT_CONNECTED, "Not attached to a browser tab.",
        "Call devtools_connect first (Chrome must be running with --remote-debugging-port).");
    }

    const previousId = this.targetId;
    let stillThere = false;
    try {
      const pages = await listPageTargets(this.host, this.port);
      stillThere = pages.some(t => t.id === previousId);
    } catch (_) {}

    if (!stillThere) {
      // A background reconnect must never conjure a tab. Silently opening one is
      // how a blank tab appears out of nowhere mid-session; the caller decides.
      fail(CODES.TARGET_GONE,
        "The tab this session was attached to no longer exists, so there is nothing to reconnect to.",
        "Call devtools_connect to choose a tab — target:'visible' for the one on screen, or target:'new' for a fresh one.",
        { lastUrl: this.targetUrl, lastTargetId: previousId });
    }

    // Reattach by the tab's own id, not by position: 'index:0' is an index into
    // whatever happens to be unclaimed and can land on a different page.
    const result = await this.attach({
      host: this.host, port: this.port,
      target: `id:${previousId}`,
      allowNewTab: false,
    });

    // Selecting by id guarantees the same tab, so there is no drift to repair —
    // the previous code path here re-opened the socket by hand and skipped
    // claiming it, which is worth not having.
    const sameTab = this.targetId === previousId;
    const replayed = await this.replayBreakpoints();
    log.info("connection", "reattached", { target: this.targetId, sameTab, replayed });

    return {
      reconnected: true,
      sameTab,
      breakpointsReplayed: replayed,
      target: result.url,
    };
  }

  async replayBreakpoints() {
    const desired = this.ctx.desired.breakpoints;
    if (!desired.size) return 0;
    let n = 0;
    for (const [key, bp] of desired) {
      try {
        const res = await this.client.Debugger.setBreakpointByUrl({
          lineNumber: bp.line - 1,
          columnNumber: bp.column ?? 0,
          ...(bp.urlRegex ? { urlRegex: bp.urlRegex } : { url: bp.url }),
          ...(bp.condition ? { condition: bp.condition } : {}),
        });
        bp.breakpointId = res.breakpointId;
        bp.bound        = (res.locations || []).length > 0;
        bp.locations    = (res.locations || []).map(l => ({ scriptId: l.scriptId, line: line1(l.lineNumber), column: line1(l.columnNumber) }));
        n++;
      } catch (e) {
        bp.bound = false;
        bp.replayError = e.message;
        log.warn("debugger", `could not replay breakpoint ${key}: ${e.message}`);
      }
    }
    return n;
  }

  // ── teardown (DBG-3) ──────────────────────────────────────────────────────
  async detach({ release = true, quiet = false } = {}) {
    this.detaching = true;
    this.stopKeepalive();
    await this.releaseFollowed();
    if (this.watcher) { await this.watcher.stop(); this.watcher = null; }
    this.clearPauseWatchdog();
    this.holdUntilResumed = false;

    if (this.client) {
      // Never leave the user's app frozen at a breakpoint, or dimmed by the banner.
      try { if (this.ctx.pause.active) await this.client.Debugger.resume(); } catch (_) {}
      try { await this.showPausedMessage(null); } catch (_) {}
      for (const bp of this.ctx.desired.breakpoints.values()) {
        if (!bp.breakpointId) continue;
        try { await this.client.Debugger.removeBreakpoint({ breakpointId: bp.breakpointId }); } catch (_) {}
      }
      try { if (this.agentScriptId) await this.client.Page.removeScriptToEvaluateOnNewDocument({ identifier: this.agentScriptId }); } catch (_) {}
      try {
        // Teardown is verified and forced, not merely requested. A badge or a
        // marker left behind stays visible to the user long after we are gone, and
        // a stale marker keeps the tab in a Chrome tab group. So: ask the agent to
        // clean up, then remove our nodes and attributes directly regardless of
        // whether it answered, and report what the page actually looks like
        // afterwards. Recovery is allowed — if the page is wedged, abort its script
        // so cleanup can run at all.
        const torn = await this.eval(`(function(){
          var out = { agent: "absent", removed: [] };
          try { if (window.__devcdp && window.__devcdp.teardown) { window.__devcdp.teardown(); out.agent = "torn-down"; } } catch (e) { out.agent = "threw"; }
          try {
            var h = document.getElementById("devcdp-badge-host");
            if (h && h.parentNode) { h.parentNode.removeChild(h); out.removed.push("host"); }
            var de = document.documentElement;
            ["data-devcdp-session","data-devcdp-session-id","data-devcdp-session-no","data-devcdp-group-mode","data-devcdp-group","data-devcdp-group-color"]
              .forEach(function(a){ if (de && de.hasAttribute(a)) { de.removeAttribute(a); out.removed.push(a); } });
            try { delete window.__devcdp; } catch (_) { window.__devcdp = undefined; }
          } catch (e) { out.error = String(e && e.message || e); }
          out.hostGone   = !document.getElementById("devcdp-badge-host");
          out.markerGone = !document.documentElement.getAttribute("data-devcdp-session");
          return JSON.stringify(out);
        })()`, { timeoutMs: 4000, label: "agent teardown", recover: true }).catch(() => null);

        let cleanup = null;
        try { cleanup = JSON.parse(torn?.result?.value || "null"); } catch (_) {}
        if (cleanup && (!cleanup.hostGone || !cleanup.markerGone)) {
          log.warn("connection", "in-page indicator could not be fully removed", cleanup);
        }
        this.lastTeardown = cleanup;
      } catch (_) {}
      try { await this.client.close(); } catch (_) {}
    }

    this.client = null;
    this.ctx.pause.active = false;
    this.ctx.pause.callFrames = null;
    if (this.ctx.pause.capture) this.ctx.pause.capture.isCurrent = false;

    if (release && this.targetId) this.ctx.registry.release(this.port, this.targetId);
    if (!quiet) log.info("connection", "detached", { target: this.targetId });
    return true;
  }
}

export { BINDING, line1 };
