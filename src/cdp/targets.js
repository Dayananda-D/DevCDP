// ─── Target selection ────────────────────────────────────────────────────────
// v4's `target:'visible'` did no visibility check whatsoever — it was
// `pages[0]`, i.e. whatever order Chrome happened to return (CONN-1). With 11
// tabs open that is a coin toss, and the tool's own recorded field notes describe
// it failing under concurrent sessions: neither the 'visible' binding nor the
// automation driver's current-tab pointer stayed pinned to the intended tab, and
// evaluate() ended up running against a different session's page mid-call.
//
// So: 'visible' now genuinely means visible. Chrome reports
// document.visibilityState === 'visible' only for the active tab of a window, so
// we probe candidates in parallel over short-lived CDP connections and use the
// answer. Claims held by other sessions (F1) are excluded before we choose, and
// ambiguity is reported rather than silently resolved.

import CDP from "chrome-remote-interface";
import { DevCdpError, CODES, fail } from "../core/errors.js";
import { log } from "../core/log.js";
import { reapClosedTabs } from "./registry.js";

const isRealPage = t =>
  t.type === "page" &&
  !t.url.startsWith("devtools://") &&
  !t.url.startsWith("chrome-extension://") &&
  !t.url.startsWith("chrome://");

/** Raw page targets, DevTools/extension/internal pages filtered out. */
export async function listPageTargets(host, port) {
  let all;
  try {
    all = await CDP.List({ host, port });
  } catch (e) {
    fail(CODES.CHROME_UNREACHABLE,
      `Chrome is not reachable at ${host}:${port}.`,
      `Start it with --remote-debugging-port=${port} (use debug-chrome.bat), then retry. Check http://${host}:${port}/json/version.`,
      { cause: e.message });
  }
  // A successful listing is the only moment we can tell that a claimed tab has been
  // closed, so it is the right moment to let those claims go.
  try { reapClosedTabs(port, new Set(all.filter(t => t.type === "page").map(t => t.id))); } catch (_) {}

  return all.filter(isRealPage);
}

/**
 * Ask each target whether it is the visible tab. Parallel + timeboxed, so 11
 * tabs costs one round trip rather than eleven.
 */
export async function probeVisibility(host, port, targets, timeoutMs = 1200) {
  const probe = async t => {
    let c;
    try {
      c = await Promise.race([
        CDP({ host, port, target: t.id }),
        new Promise((_, rej) => setTimeout(() => rej(new Error("probe timeout")), timeoutMs)),
      ]);
      const { result } = await c.Runtime.evaluate({
        expression: `JSON.stringify({v:document.visibilityState,f:document.hasFocus()})`,
        returnByValue: true,
      });
      const { v, f } = JSON.parse(result.value || "{}");
      return { id: t.id, visible: v === "visible", focused: !!f };
    } catch (_) {
      return { id: t.id, visible: false, focused: false, probeFailed: true };
    } finally {
      try { if (c) await c.close(); } catch (_) {}
    }
  };

  const results = [];
  const width = Math.min(6, Math.max(1, targets.length));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= targets.length) return;
      results[i] = await probe(targets[i]);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return new Map(results.map(r => [r.id, r]));
}

/**
 * Choose a target.
 *
 * @param {object} o
 * @param {string} o.host
 * @param {number} o.port
 * @param {string} o.target            'visible' | 'url-match:<s>' | 'index:<n>' | 'new' | '<url substring>'
 * @param {Set<string>} o.excludeIds   targetIds claimed by other sessions (F1)
 * @param {boolean} o.probe            probe real visibility (default true for 'visible')
 * @returns {{chosen:object, reason:string, candidates:object[], excluded:object[]}}
 */
export async function pickTarget({ host, port, target = "visible", excludeIds = new Set(), probe = true }) {
  const pages = await listPageTargets(host, port);

  if (!pages.length) {
    fail(CODES.NO_TARGET,
      `Chrome at ${host}:${port} has no debuggable page tabs.`,
      "Open your app in the debug Chrome window first, then retry.");
  }

  const free     = pages.filter(t => !excludeIds.has(t.id));
  const excluded = pages.filter(t =>  excludeIds.has(t.id))
    .map(t => ({ id: t.id, url: t.url, title: t.title, claimedByAnotherSession: true }));

  const describe = t => ({ id: t.id, url: t.url, title: t.title });

  if (!free.length) {
    fail(CODES.TARGET_CLAIMED,
      `All ${pages.length} tab(s) on port ${port} are already claimed by other DevCDP sessions.`,
      "Pass target:'new' for a fresh tab, or browser:'new' for a separate Chrome instance.",
      { claimed: excluded });
  }

  // ── an exact target id, used by reconnect so it cannot drift to another tab ──
  if (target.startsWith("id:")) {
    const wantedId = target.slice(3);
    const chosen = free.find(t => t.id === wantedId);
    if (!chosen) {
      const claimed = excluded.find(t => t.id === wantedId);
      fail(claimed ? CODES.TARGET_CLAIMED : CODES.TARGET_GONE,
        claimed
          ? `Tab ${wantedId} is now claimed by another DevCDP session.`
          : `Tab ${wantedId} no longer exists.`,
        "Call devtools_connect to pick a tab explicitly.",
        { available: free.map(describe) });
    }
    return { chosen, reason: "same-tab", candidates: [describe(chosen)], excluded };
  }

  // ── explicit index ──
  if (target.startsWith("index:")) {
    const idx = parseInt(target.slice(6), 10);
    const chosen = free[idx];
    if (!chosen) {
      fail(CODES.NO_TARGET,
        `index:${idx} is out of range — ${free.length} unclaimed tab(s) available (0..${free.length - 1}).`,
        "Call list_tabs to see the current indices.",
        { available: free.map(describe) });
    }
    return { chosen, reason: `index:${idx}`, candidates: free.map(describe), excluded };
  }

  // ── url match (explicit prefix or bare substring) ──
  const needle = target.startsWith("url-match:") ? target.slice(10)
               : (target !== "visible" && target !== "new") ? target
               : null;

  if (needle) {
    const matches = free.filter(t => t.url.includes(needle) || (t.title || "").includes(needle));
    if (!matches.length) {
      fail(CODES.NO_TARGET,
        `No unclaimed tab matches "${needle}".`,
        "Call list_tabs to see what is open, or pass target:'new'.",
        { available: free.map(describe) });
    }
    return {
      chosen: matches[0],
      reason: `url-match:${needle}`,
      candidates: matches.map(describe),
      excluded,
      ...(matches.length > 1 ? { ambiguous: true, note: `${matches.length} tabs matched; took the first. Use index: or a longer substring to disambiguate.` } : {}),
    };
  }

  // ── visible: actually check ──
  if (probe && free.length > 1) {
    const vis = await probeVisibility(host, port, free);
    const focused = free.filter(t => vis.get(t.id)?.focused);
    const shown   = free.filter(t => vis.get(t.id)?.visible);
    const pick    = focused[0] || shown[0];

    if (pick) {
      return {
        chosen: pick,
        reason: focused[0] ? "visible+focused" : "visible",
        candidates: (focused.length ? focused : shown).map(describe),
        excluded,
      };
    }
    log.warn("targets", "no tab reported itself visible — falling back to first unclaimed");
    return {
      chosen: free[0],
      reason: "fallback:first-unclaimed",
      candidates: free.map(describe),
      excluded,
      note: "No tab reported visibilityState 'visible' (all backgrounded, or the window is minimised). Took the first unclaimed tab — pass target:'url-match:…' to be certain.",
    };
  }

  return { chosen: free[0], reason: free.length === 1 ? "only-unclaimed-tab" : "first-unclaimed", candidates: free.map(describe), excluded };
}

/**
 * Watch the browser for tabs appearing and disappearing.
 *
 * Without this, DevCDP was strictly single-tab: a window the application itself
 * opened — `window.open`, `target="_blank"`, a detail screen in its own window —
 * was invisible. No overlay appeared on it, no session claimed it, and anything the
 * user did there happened outside the tool's view. In real applications that is
 * where a great deal of the interesting behaviour lives (UI-6).
 *
 * Discovery runs on a browser-level session, so it sees every target regardless of
 * which page we happen to be attached to.
 */
export class TargetWatcher {
  constructor(host, port) {
    this.host = host; this.port = port;
    this.client = null;
    this.onCreated = null;
    this.onDestroyed = null;
    this.preExisting = new Set();
  }

  async start({ onCreated, onChanged, onDestroyed } = {}) {
    if (this.client) return true;
    this.onCreated = onCreated; this.onChanged = onChanged; this.onDestroyed = onDestroyed;
    try {
      this.client = await CDP({ host: this.host, port: this.port });

      // Enabling discovery replays every target that already exists as a
      // targetCreated event. Those are not new tabs, and adopting them would sweep
      // up anything our page ever opened in an earlier run — tabs the user may now
      // be using, and tabs other sessions could otherwise have. Snapshot first, so
      // "created" means created.
      try {
        const { targetInfos } = await this.client.Target.getTargets();
        this.preExisting = new Set(targetInfos.map(t => t.targetId));
      } catch (_) { this.preExisting = new Set(); }

      this.client.Target.targetCreated(({ targetInfo }) => {
        if (!targetInfo || targetInfo.type !== "page") return;
        if (this.preExisting.has(targetInfo.targetId)) return;
        try { this.onCreated?.(targetInfo); } catch (e) { log.debug("targets", `onCreated threw: ${e.message}`); }
      });
      // A tab is created as about:blank and only becomes identifiable when it
      // navigates, so its url and title arrive later than the tab itself.
      this.client.Target.targetInfoChanged(({ targetInfo }) => {
        if (!targetInfo || targetInfo.type !== "page") return;
        try { this.onChanged?.(targetInfo); } catch (_) {}
      });
      this.client.Target.targetDestroyed(({ targetId }) => {
        try { this.onDestroyed?.(targetId); } catch (_) {}
      });
      this.client.on("disconnect", () => { this.client = null; });
      await this.client.Target.setDiscoverTargets({ discover: true });
      return true;
    } catch (e) {
      // Discovery is an enhancement; losing it must not cost us the session.
      log.warn("targets", `tab discovery unavailable: ${e.message}`);
      try { await this.client?.close(); } catch (_) {}
      this.client = null;
      return false;
    }
  }

  async stop() {
    const c = this.client; this.client = null;
    if (!c) return;
    try { await c.Target.setDiscoverTargets({ discover: false }); } catch (_) {}
    try { await c.close(); } catch (_) {}
  }
}

/**
 * Open a fresh tab and return its target record.
 *
 * `newWindow` puts it in its own browser window. That matters because real Chrome
 * tab groups need the companion extension, and recent Chrome builds refuse
 * --load-extension — so a dedicated window is the grouping fallback that always
 * works, with no install step.
 */
export async function createTarget(host, port, url = "about:blank", { newWindow = false } = {}) {
  let browser;
  try {
    browser = await CDP({ host, port });                 // browser-level session
    const { targetId } = await browser.Target.createTarget({ url, ...(newWindow ? { newWindow: true } : {}) });
    const list = await CDP.List({ host, port });
    const found = list.find(t => t.id === targetId);
    if (!found) fail(CODES.NO_TARGET, "Created a tab but Chrome did not list it.", "Retry devtools_connect.");
    return found;
  } catch (e) {
    if (e instanceof DevCdpError) throw e;
    fail(CODES.CHROME_UNREACHABLE, `Could not open a new tab on ${host}:${port}: ${e.message}`,
      "Check that the debug Chrome window is still running.");
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
}
