// ─── Chrome launching ────────────────────────────────────────────────────────
// Used for browser:'new' — a session that wants a browser no one else has
// touched (F1). Each instance gets its own port and its own profile directory,
// so instances cannot share cookies, storage or a debugging socket.
//
// SEC-1: --disable-web-security is NOT passed by default. v4's launcher always
// set it, which silently made CORS bugs unreproducible in the one browser users
// were told to debug in.

import { spawn } from "child_process";
import fs   from "fs";
import path from "path";
import net  from "net";
import crypto from "crypto";
import CDP  from "chrome-remote-interface";
import os   from "os";
import { CODES, fail } from "../core/errors.js";
import { log } from "../core/log.js";

const CANDIDATES = {
  win32: [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"],
};

/**
 * Did the companion extension actually load?
 *
 * Asking is not the same as succeeding. This used to report `extensionLoaded: true`
 * whenever `--load-extension` was on the command line — but branded Google Chrome
 * ignores that switch, so the claim was false on the most common browser there is,
 * which is precisely the kind of unverified success this project exists to remove.
 *
 * Identified by manifest name: Chrome ships several bundled extensions of its own, so
 * counting `chrome-extension://` targets would say yes for any browser at all.
 */
/**
 * The id Chrome will give an unpacked extension loaded from `dir`.
 *
 * Deterministic, and worth having because the alternative was asking the extension its
 * own name — which means attaching to its service worker and evaluating inside it. A
 * manifest-v3 worker suspends when idle, so that question intermittently cannot be
 * answered at all, and "no answer" was being reported as "not loaded" and blamed on
 * branded Chrome. The id lets us recognise our extension from the target list alone.
 *
 * Chrome hashes the absolute path and maps each hex digit onto a-p. On Windows the
 * path is hashed as UTF-16, everywhere else as its UTF-8 bytes — verified against a
 * real browser rather than assumed.
 */
export function unpackedExtensionId(dir) {
  if (!dir) return null;
  const normalised = process.platform === "win32" ? path.win32.normalize(dir) : path.posix.normalize(dir);
  const bytes = process.platform === "win32" ? Buffer.from(normalised, "utf16le") : Buffer.from(normalised, "utf8");
  const hex = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
  return [...hex].map(ch => String.fromCharCode(97 + parseInt(ch, 16))).join("");
}

/**
 * Did the companion extension actually load?
 *
 * 8s rather than 5s, because a service worker registers quickly on an idle machine and
 * not always quickly on a busy one, and the cost of guessing wrong is asymmetric:
 * success returns the instant it is seen, so a longer deadline costs nothing when the
 * extension is there.
 */
export async function verifyExtension(host, port, { expectedName = "DevCDP Session Marker", extensionDir = null, timeoutMs = 8000 } = {}) {
  const expectedId = unpackedExtensionId(extensionDir);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const found = await extensionTarget(host, port, expectedName, expectedId);
    if (found.loaded || Date.now() >= deadline) return found;
    await new Promise(r => setTimeout(r, 400));
  }
}

async function extensionTarget(host, port, expectedName, expectedId) {
  let targets = [];
  try { targets = await CDP.List({ host, port }); } catch (_) { return { loaded: false }; }

  const extensionTargets = targets.filter(t => /^chrome-extension:\/\//.test(t.url || ""));

  // The cheap, reliable answer first: is one of these targets ours? Identifying by id
  // rather than by counting keeps the original guarantee — Chrome ships bundled
  // extensions of its own, so any chrome-extension:// target would say yes for any
  // browser at all — while needing nothing from the extension itself.
  if (expectedId) {
    const mine = extensionTargets.find(t => t.url.startsWith(`chrome-extension://${expectedId}/`));
    if (mine) return { loaded: true, id: expectedId, identifiedBy: "path-derived id" };
  }

  // Fall back to asking it, for a packed install or a path we derived wrongly.
  for (const t of extensionTargets) {
    let c;
    try {
      c = await CDP({ host, port, target: t.id });
      const { result } = await c.Runtime.evaluate({
        returnByValue: true,
        expression: `(function(){ try { return JSON.stringify({ n: chrome.runtime.getManifest().name, i: chrome.runtime.id }); }
                                  catch (e) { return "{}"; } })()`,
      });
      let name = null, id = null;
      try { ({ n: name, i: id } = JSON.parse(result?.value || "{}")); } catch (_) {}
      if (name === expectedName) return { loaded: true, id, identifiedBy: "manifest name" };
    } catch (_) {
    } finally { try { if (c) await c.close(); } catch (_) {} }
  }
  return { loaded: false };
}

/** A browser that will load an unpacked extension from the command line, if one is here. */
export function findExtensionCapableChrome() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const candidates = [
    path.join(local, "Google", "Chrome for Testing", "chrome.exe"),
    path.join(local, "ms-playwright"),                       // scanned below
    "/usr/bin/chromium", "/usr/bin/chromium-browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  for (const c of candidates) {
    try {
      if (!fs.existsSync(c)) continue;
      if (!fs.statSync(c).isDirectory()) return c;
      // Playwright keeps versioned chromium-<n> directories.
      for (const dir of fs.readdirSync(c).filter(d => /^chromium-\d+$/.test(d)).sort().reverse()) {
        for (const rel of [["chrome-win", "chrome.exe"], ["chrome-linux", "chrome"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]]) {
          const exe = path.join(c, dir, ...rel);
          if (fs.existsSync(exe)) return exe;
        }
      }
    } catch (_) {}
  }
  return null;
}

export function findChrome(explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.DEVCDP_CHROME_PATH && fs.existsSync(process.env.DEVCDP_CHROME_PATH)) return process.env.DEVCDP_CHROME_PATH;
  for (const p of (CANDIDATES[process.platform] || [])) {
    if (p && fs.existsSync(p)) return p;
  }
  fail(CODES.UNSUPPORTED, "Could not find a Chrome installation.",
    "Set DEVCDP_CHROME_PATH to the full path of chrome.exe, or launch Chrome yourself and use browser:'existing'.");
}

/** Is anything listening on this port? */
function portOpen(host, port, timeout = 350) {
  return new Promise(resolve => {
    const sock = new net.Socket();
    const done = result => { sock.destroy(); resolve(result); };
    sock.setTimeout(timeout);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error",   () => done(false));
    sock.connect(port, host);
  });
}

/** First port in range that is neither listening nor claimed by another session. */
export async function findFreePort(host, [from, to], inUse = new Set()) {
  for (let port = from; port <= to; port++) {
    if (inUse.has(port)) continue;
    if (await portOpen(host, port)) continue;
    return port;
  }
  fail(CODES.NO_TARGET, `No free debugging port in range ${from}-${to}.`,
    "Close an unused debug Chrome window, or widen portRange in your settings file (devcdp_settings shows which one is in effect).");
}

async function waitForPort(host, port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portOpen(host, port)) return true;
    await new Promise(r => setTimeout(r, 200));
  }
  return false;
}

/**
 * Launch an isolated Chrome. Detached so it outlives this MCP process — the user
 * keeps their browser if the agent goes away.
 */
export async function launchChrome({ port, cfg, url = "about:blank", host = "localhost" }) {
  const exe = findChrome(cfg.chromePath);

  // chromeProfile: "isolated" (own directory per port), "default" (your everyday
  // Chrome profile), or an explicit path.
  const mode = cfg.chromeProfile || "isolated";
  let profile = null;
  if (mode === "isolated") {
    profile = path.join(cfg.chromeProfileBase || path.join(os.tmpdir(), "devcdp-chrome"), `port-${port}`);
  } else if (mode !== "default") {
    profile = path.resolve(mode);
  }
  if (profile) fs.mkdirSync(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    ...(profile ? [`--user-data-dir=${profile}`] : []),
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-popup-blocking",
    // Without these, covering the browser window breaks DevCDP's clicks.
    //
    // Chrome detects when a window is fully occluded by other windows and treats its
    // tabs as hidden — and a hidden tab does not process synthesized input, so
    // Input.dispatchMouseEvent is accepted and silently does nothing. Measured: a
    // click on a full-viewport button registered zero hits with the window covered,
    // while the same element's own click() fired normally, and the page reported
    // visibilityState 'hidden'. Since the ordinary way to use this tool is to put your
    // editor in front of the browser, that made automated clicking unreliable exactly
    // when it looked like it should work.
    "--disable-backgrounding-occluded-windows",
    "--disable-features=CalculateNativeWinOcclusion",
    // A debug browser must start empty.
    //
    // The isolated profile persists per port, so if the browser was killed rather than
    // closed — a test run, a machine restart, Task Manager — Chrome records a crash and
    // restores the previous session's tabs on the next launch. Two things go wrong:
    // the "Restore pages?" bubble sits over the app, and a restored tab arrives as a
    // newly created target with its opener relationship intact, so DevCDP adopted it as
    // a window the application had just opened. Observed as a phantom claim on a tab
    // that no longer had any reason to exist.
    "--no-restore-session-state",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    `--remote-allow-origins=http://${host}:${port}`,
  ];

  if (mode === "default") {
    log.warn("launch",
      "chromeProfile is 'default' — Chrome 136 and later refuse remote debugging on the default profile, so this may "
      + "not open. If it fails, use 'isolated' or give an explicit profile path.");
  }

  if (cfg.extensionDir && fs.existsSync(path.join(cfg.extensionDir, "manifest.json"))) {
    args.push(`--disable-extensions-except=${cfg.extensionDir}`, `--load-extension=${cfg.extensionDir}`);
  }
  if (cfg.disableWebSecurity) {
    args.push("--disable-web-security", "--disable-site-isolation-trials");
    log.warn("launch", "web security disabled by config — CORS bugs will NOT reproduce in this browser");
  }
  if (Array.isArray(cfg.chromeFlags) && cfg.chromeFlags.length) {
    args.push(...cfg.chromeFlags);
    log.info("launch", `extra flags from settings: ${cfg.chromeFlags.join(" ")}`);
  }
  args.push(url);

  log.info("launch", `starting Chrome on port ${port}`, { profile });
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();

  if (!await waitForPort(host, port)) {
    fail(CODES.CHROME_UNREACHABLE, `Launched Chrome but port ${port} never opened.`,
      "Another Chrome may already own this profile directory. Close all Chrome windows using it and retry.");
  }

  const requested = args.some(a => a.startsWith("--load-extension"));
  const extension = requested ? await verifyExtension(host, port, { extensionDir: cfg.extensionDir }) : { loaded: false };

  return {
    port, profile: profile || "(your default Chrome profile)", profileMode: mode,
    executable: exe, pid: child.pid,
    extensionLoaded: extension.loaded,
    ...(requested && !extension.loaded
      ? { extensionNote: "Passed --load-extension and waited, but the extension never registered. Usually this is branded "
                       + "Google Chrome, which refuses the switch (\"not allowed in Google Chrome, ignoring\", from its own log) "
                       + "and does not expose Extensions.loadUnpacked over the debugging port. Install it once by hand from "
                       + "chrome://extensions (Developer mode → Load unpacked); this profile is persistent, so it stays. "
                       + "Chromium and Chrome for Testing load it automatically." }
      : {}),
    webSecurityDisabled: !!cfg.disableWebSecurity,
    extraFlags: cfg.chromeFlags?.length ? cfg.chromeFlags : undefined,
  };
}
