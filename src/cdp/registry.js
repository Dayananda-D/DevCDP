// ─── Cross-session tab registry (F1) ─────────────────────────────────────────
// Every MCP client spawns its own server.js process, so two agents debugging the
// same machine cannot see each other in memory. Coordination therefore lives on
// disk, in a per-user directory shared by every DevCDP install:
//
//   ~/.devcdp/registry/
//     claim-<port>-<targetId>.json   one file per claimed tab
//     browser-<port>.json            one file per browser a session launched
//     seq                            monotonic session-number counter
//
// A claim is taken with O_EXCL (flag "wx"), which is atomic on NTFS and POSIX:
// if the file exists, someone else owns that tab. Liveness is a heartbeat plus a
// pid check, so a crashed session never wedges a tab forever.

import fs   from "fs";
import path from "path";
import os   from "os";
import { log } from "../core/log.js";

export const REGISTRY_DIR = process.env.DEVCDP_REGISTRY_DIR
  || path.join(os.homedir(), ".devcdp", "registry");

const HEARTBEAT_MS   = 10_000;   // how often we refresh our own claims
const STALE_AFTER_MS = 45_000;   // a claim this quiet is considered abandoned

function ensureDir() {
  try { fs.mkdirSync(REGISTRY_DIR, { recursive: true }); } catch (_) {}
}

const claimFile = (port, targetId) =>
  path.join(REGISTRY_DIR, `claim-${port}-${sanitise(targetId)}.json`);

/**
 * A browser this session launched.
 *
 * Tabs are claimed exclusively; a browser deliberately is not — two sessions working
 * in different tabs of one window is the normal case, not a collision. The record
 * exists so sessions_list can say where a browser came from, and so findFreePort does
 * not hand the same port to a second session while the first browser is still starting
 * up and therefore not yet listening.
 *
 * The browser is never closed when the session ends: launch.js detaches it precisely so
 * it outlives the agent, and the user keeps whatever they were looking at. Only the
 * *record* is released, which is what returns the port to the pool.
 */
const browserFile = port => path.join(REGISTRY_DIR, `browser-${port}.json`);

const sanitise = s => String(s).replace(/[^A-Za-z0-9_-]/g, "");

/** Every readable record of one kind. Reaping is the caller's business. */
function readRecords(prefix) {
  ensureDir();
  let files = [];
  try { files = fs.readdirSync(REGISTRY_DIR).filter(f => f.startsWith(prefix)); }
  catch (_) { return []; }
  return files.map(f => readClaim(path.join(REGISTRY_DIR, f))).filter(Boolean);
}

function readClaim(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (_) { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === "EPERM"; }   // EPERM = exists, not ours
}

function isStale(claim) {
  if (!claim) return true;
  if (!pidAlive(claim.pid)) return true;
  return Date.now() - (claim.heartbeatAt || 0) > STALE_AFTER_MS;
}

/**
 * Delete abandoned records. Returns how many were reaped.
 *
 * Browser records are reaped on exactly the same terms as tab claims — a dead or silent
 * owner releases both. That is what lets a later session adopt a browser an earlier one
 * launched, rather than the port staying spoken for by a session that no longer exists.
 */
export function reap() {
  ensureDir();
  let reaped = 0;
  let files = [];
  try {
    files = fs.readdirSync(REGISTRY_DIR)
      .filter(f => f.startsWith("claim-") || f.startsWith("browser-"));
  } catch (_) { return 0; }

  for (const f of files) {
    const full  = path.join(REGISTRY_DIR, f);
    const claim = readClaim(full);
    if (isStale(claim)) {
      try { fs.unlinkSync(full); reaped++; log.debug("registry", "reaped stale record", { file: f, pid: claim?.pid }); }
      catch (_) {}
    }
  }
  return reaped;
}

/**
 * Delete a claim file regardless of who wrote it.
 *
 * Recovery only. Normal release goes through the owning session, and reaping handles
 * processes that exited — but a claim whose pid has been recycled by the operating
 * system looks alive until its heartbeat goes stale, and something has to be able to
 * clear that by hand.
 */
export function releaseClaimFile(port, targetId) {
  try { fs.unlinkSync(claimFile(port, targetId)); return true; }
  catch (_) { return false; }
}

/**
 * Delete claims on one browser whose tab no longer exists.
 *
 * Reaping was based entirely on the owning *process*: alive and heartbeating meant the
 * claim stood. But a session whose tab the user closed keeps heartbeating happily, so
 * its claim outlived the tab — and since session numbers are the smallest unused
 * integer, those ghosts pushed a genuinely fresh session to "session 3" with no
 * sessions 1 or 2 anywhere to be seen. Measured on a real browser: three claims, all
 * three for tabs that had been closed.
 *
 * `liveTargetIds` must come from a *successful* listing. An empty set is honoured
 * (a browser with no tabs really does hold no valid claims), so a failed lookup must
 * not be passed here as an empty set.
 */
export function reapClosedTabs(port, liveTargetIds) {
  if (!(liveTargetIds instanceof Set)) return 0;
  ensureDir();
  let files = [];
  try { files = fs.readdirSync(REGISTRY_DIR).filter(f => f.startsWith("claim-")); } catch (_) { return 0; }

  let reaped = 0;
  for (const f of files) {
    const full = path.join(REGISTRY_DIR, f);
    const claim = readClaim(full);
    if (!claim || claim.port !== port) continue;
    if (liveTargetIds.has(claim.targetId)) continue;
    try {
      fs.unlinkSync(full);
      reaped++;
      log.info("registry", "released a claim whose tab no longer exists",
        { session: claim.sessionNumber, pid: claim.pid, url: String(claim.url || "").slice(0, 60) });
    } catch (_) {}
  }
  return reaped;
}

/** Every live claim on the machine, ours included. */
export function liveClaims() {
  reap();
  return readRecords("claim-");
}

/** Every browser a live session launched, ours included. */
export function liveBrowsers() {
  reap();
  return readRecords("browser-");
}

/** Smallest unused positive integer — the human-facing "session 1/2/3" label. */
function nextSessionNumber(records) {
  const taken = new Set(records.map(c => c.sessionNumber).filter(Number.isInteger));
  let n = 1;
  while (taken.has(n)) n++;
  return n;
}

/**
 * Every record this session's number must not collide with.
 *
 * Browsers count as well as tabs: a session that has launched a browser but not yet
 * claimed a tab in it is still session N, and numbering it from claims alone would
 * hand N to somebody else in the gap between the two.
 */
const numberedRecords = () => [...liveClaims(), ...readRecords("browser-")];

export class SessionRegistry {
  constructor(sessionId) {
    this.sessionId     = sessionId;
    this.sessionNumber = null;
    this.claims        = new Map();   // key `${port}-${targetId}` → claim
    this.browsers      = new Map();   // port → browser record we launched
    this.timer         = null;
    ensureDir();
  }

  /** Who owns what right now, from this session's point of view. */
  survey(port) {
    const all = liveClaims();
    const mine   = all.filter(c => c.sessionId === this.sessionId);
    const others = all.filter(c => c.sessionId !== this.sessionId);
    return {
      all,
      mine,
      others,
      claimedByOthers: new Set(
        others.filter(c => port == null || c.port === port).map(c => c.targetId)
      ),
    };
  }

  /**
   * Try to take a tab. Atomic: either we own it, or we learn who does.
   * @returns {{ok:true, claim:object} | {ok:false, heldBy:object}}
   */
  claim(port, targetId, meta = {}) {
    ensureDir();
    reap();

    const key = `${port}-${targetId}`;
    if (this.claims.has(key)) return { ok: true, claim: this.claims.get(key) };

    if (this.sessionNumber == null) this.sessionNumber = nextSessionNumber(numberedRecords());

    const file  = claimFile(port, targetId);
    const claim = {
      sessionId:     this.sessionId,
      sessionNumber: this.sessionNumber,
      pid:           process.pid,
      port,
      targetId,
      url:           meta.url   || null,
      title:         meta.title || null,
      label:         meta.label || `DevCDP · session ${this.sessionNumber}`,
      claimedAt:     new Date().toISOString(),
      heartbeatAt:   Date.now(),
    };

    try {
      fs.writeFileSync(file, JSON.stringify(claim, null, 2), { flag: "wx", encoding: "utf8" });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const held = readClaim(file);
      if (isStale(held)) {                       // owner died between reap and write
        try { fs.unlinkSync(file); } catch (_) {}
        return this.claim(port, targetId, meta);
      }
      if (held?.sessionId === this.sessionId) {   // ours from a previous attach
        this.claims.set(key, held);
        this.startHeartbeat();
        return { ok: true, claim: held };
      }
      return { ok: false, heldBy: held };
    }

    this.claims.set(key, claim);
    this.startHeartbeat();
    log.info("registry", "claimed tab", { port, targetId, session: this.sessionNumber });
    return { ok: true, claim };
  }

  /**
   * Record that this session launched the browser on `port`.
   *
   * Not exclusive, and deliberately so — unlike a tab, a browser is shareable. If a
   * record for this port already belongs to a live session we leave it alone rather
   * than stealing the attribution.
   */
  registerBrowser(port, meta = {}) {
    ensureDir();
    reap();

    const existing = readClaim(browserFile(port));
    if (existing && !isStale(existing) && existing.sessionId !== this.sessionId) return existing;

    if (this.sessionNumber == null) this.sessionNumber = nextSessionNumber(numberedRecords());

    const rec = {
      sessionId:     this.sessionId,
      sessionNumber: this.sessionNumber,
      pid:           process.pid,
      port,
      browserPid:  meta.pid        || null,
      executable:  meta.executable || null,
      profile:     meta.profile    || null,
      label:       meta.label      || `DevCDP · session ${this.sessionNumber}`,
      launchedAt:  new Date().toISOString(),
      heartbeatAt: Date.now(),
    };

    try { fs.writeFileSync(browserFile(port), JSON.stringify(rec, null, 2), "utf8"); }
    catch (e) { log.warn("registry", `could not record launched browser on ${port}: ${e.message}`); return null; }

    this.browsers.set(port, rec);
    this.startHeartbeat();
    log.info("registry", "registered launched browser", { port, session: this.sessionNumber });
    return rec;
  }

  /** Forget a browser. The browser itself keeps running — only the record goes. */
  releaseBrowser(port) {
    this.browsers.delete(port);
    try { fs.unlinkSync(browserFile(port)); } catch (_) {}
    log.info("registry", "released browser record", { port });
    this.stopHeartbeatIfIdle();
  }

  release(port, targetId) {
    const key = `${port}-${targetId}`;
    this.claims.delete(key);
    try { fs.unlinkSync(claimFile(port, targetId)); } catch (_) {}
    log.info("registry", "released tab", { port, targetId });
    this.stopHeartbeatIfIdle();
  }

  /**
   * Give everything back. Called on every shutdown path (see src/server.js), so a
   * session that ends — cleanly or not — leaves no tab and no browser spoken for.
   */
  releaseAll() {
    for (const c of [...this.claims.values()]) this.release(c.port, c.targetId);
    for (const port of [...this.browsers.keys()]) this.releaseBrowser(port);
    this.stopHeartbeat();
  }

  startHeartbeat() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [key, claim] of this.claims) {
        claim.heartbeatAt = Date.now();
        try { fs.writeFileSync(claimFile(claim.port, claim.targetId), JSON.stringify(claim, null, 2), "utf8"); }
        catch (_) { this.claims.delete(key); }
      }
      // Browsers beat too, or a session holding a browser but no tab would look dead
      // after 45s and have its port reaped out from under it.
      for (const [port, rec] of this.browsers) {
        rec.heartbeatAt = Date.now();
        try { fs.writeFileSync(browserFile(port), JSON.stringify(rec, null, 2), "utf8"); }
        catch (_) { this.browsers.delete(port); }
      }
    }, HEARTBEAT_MS);
    this.timer.unref?.();
  }

  stopHeartbeatIfIdle() {
    if (this.claims.size === 0 && this.browsers.size === 0) this.stopHeartbeat();
  }

  stopHeartbeat() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}

/**
 * Ports already spoken for — for "give me a clean browser".
 *
 * Launched browsers count as well as claimed tabs. findFreePort also probes whether a
 * port is listening, but a Chrome that has been spawned and has not finished starting
 * is neither listening nor holding a claim, and that window is wide enough for two
 * sessions escalating at once to pick the same port.
 */
export function portsInUse() {
  return new Set([...liveClaims(), ...liveBrowsers()].map(c => c.port));
}
