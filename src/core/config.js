// ─── Configuration ───────────────────────────────────────────────────────────
// v4 baked one particular deployment into the server: an internal help URL
// (HELP-3), that app's modal element ids (SPY-3), and a static UI-framework
// selector cheatsheet (APP-1). Anyone outside that one environment inherited dead
// features and a background fetch to a host they could not reach.
//
// Nothing app-specific, company-specific or framework-specific lives in code any
// more. It comes from, in priority order (later wins):
//   1. safe generic defaults
//   2. <install>/devcdp.settings.json  or  <install>/settings.json
//   3. <cwd>/.devcdp/settings.json, <cwd>/devcdp.settings.json, <cwd>/devcdp.config.json
//   4. DEVCDP_* environment variables
//   5. explicit tool arguments
//
// Files are MERGED rather than first-match, so an install-wide baseline can be
// overridden per project. Every effective value records where it came from, which
// the devcdp_settings tool reports — "customisable" is not much use if you cannot
// see what is actually in effect.
//
// A bare settings.json is only honoured inside the install directory or a .devcdp/
// folder: plenty of projects have their own settings.json, and silently adopting
// one as DevCDP configuration would be a nasty surprise.
//
// App understanding is *discovered* at runtime instead (src/discover/): the
// framework from the page, the API surface from real traffic + OpenAPI probes,
// and domain vocabulary from the app's own README/docs.

import fs   from "fs";
import path from "path";
import os   from "os";
import { fileURLToPath } from "url";
import { log } from "./log.js";

const INSTALL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const DEFAULTS = {
  // ── connection ──
  host: "localhost",
  port: 9222,

  // ── browser launching (F1 "clean browser") ──
  // Deliberately NOT a temp directory, and deliberately the same path the generated
  // debug-chrome.bat uses.
  //
  // Branded Google Chrome refuses --load-extension outright ("not allowed in Google
  // Chrome, ignoring", from its own log), so the companion extension that draws real
  // Chrome tab groups has to be installed once by hand — after which it lives in the
  // profile, exactly like any other extension. That only holds if the profile survives:
  // this used to sit under the temp directory, which Windows cleanup purges, so a
  // one-time install silently became every-time. Worse, the launcher script used a
  // different directory again, so an extension installed via one entry point was
  // invisible to the other.
  chromeProfileBase: process.platform === "win32"
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "DevCDP", "chrome-profiles")
    : path.join(os.homedir(), ".devcdp", "chrome-profiles"),
  portRange: [9222, 9242],
  disableWebSecurity: false,        // SEC-1 — off by default now
  // "isolated" (default) gives each launched browser its own profile directory.
  // "default" uses your everyday Chrome profile — convenient because you are
  // already signed in, but Chrome 136+ refuses remote debugging on the default
  // profile, so this may simply fail; DevCDP says so rather than hanging.
  // Any other value is treated as a profile directory path.
  chromeProfile: "isolated",
  chromePath: null,                 // explicit chrome.exe, else auto-detected
  chromeFlags: [],                  // extra command-line flags, appended last

  // ── in-page UI (F2) ──
  badge: true,
  // Where the overlay parks itself before the user moves it. Top centre by default:
  // every corner is somewhere an application already puts something — a menu, a user
  // avatar, a help launcher, a cookie banner — so a corner badge lands on real controls
  // often enough to be a problem, and which corner is wrong differs per app. The chip
  // is a drag handle, and wherever it is dropped is remembered per origin, so this is
  // only the starting point.
  //   tc | bc — top/bottom centre        tr | tl | br | bl — corners
  badgeCorner: "tc",
  // Live status messages. Separate from the chip so they can sit out of the way
  // of whatever you are looking at, and translucent so they obscure as little as
  // possible while still being readable.
  toasts: true,                    // false hides live status messages entirely
  // Narrate every tool call on the page, not only the dozen steps someone remembered
  // to announce by hand. Silence and a wedged page look the same from the outside, and
  // the person watching is looking at their own application, not at the transcript.
  // The assistant's own words are a separate channel — it has to call notify_user for
  // those, because its prose never reaches this process.
  narrateTools: true,
  // Messages keep their own corner, independent of the badge. The badge is dragged
  // because it is a fixed object sitting on the app; messages are a stream that
  // appears and clears itself, and anchoring them to a chip the user has just tidied
  // into a corner would drag the running commentary there with it.
  toastCorner: "tr",               // tc | bc | tl | tr | bl | br
  toastPosition: "tr",             // accepted alias of toastCorner, kept in sync
  toastMs: 3500,                   // how long each message lingers before fading
  toastOpacity: 0.78,              // 0..1 — the panel, not the text
  toastMaxVisible: 3,              // older messages fade out as new ones arrive
  // The badge shrinks to a status dot when idle, so it is not permanently
  // occupying a corner of the app. It expands on any status change, when the
  // pointer comes near it, and never collapses while it is waiting for the user,
  // showing an error, or explaining why the page is paused.
  // The edge border breathes while DevCDP is driving, and goes still and green
  // when it hands over — motion and stillness carry the state, not hue alone.
  edgePulse: true,
  badgeAutoCollapse: true,
  badgeIdleMs: 6000,
  // How the companion extension groups tabs.
  //   'session' — one group per DevCDP session, titled with it. Matches the isolation
  //               model, so you can see which agent owns which tab.
  //   'single'  — every DevCDP tab in one group regardless of session. Tidier
  //               when you only ever run one session.
  tabGroupMode: "session",
  // Show a ring where interaction is happening, a ripple on each click, and the
  // element being inspected. Makes an agent's actions followable in real time.
  showCursor: true,
  // Flash Chrome's own inspector highlight on elements DevCDP looks at. Rendered
  // by the browser, so it adds nothing to the page.
  highlightInspected: true,
  // How long an overlay keeps drawing itself without hearing from its session
  // before it removes itself. Guards the case where the server is killed or
  // crashes mid-run: a graceful detach cleans up, a `kill -9` cannot, and a border
  // that claims DevCDP is driving a tab nobody owns destroys trust in the signal.
  // The overlay distinguishes a dead owner from a page frozen at a breakpoint or a
  // throttled background tab, so this can stay short.
  ownerTimeoutMs: 45000,
  // Adopt tabs the application opens for itself — window.open, target="_blank", a
  // detail screen in its own window. They get the same overlay and are claimed for
  // this session, so a second agent will not walk into one and so the model can
  // switch to whichever tab the bug actually lives in.
  followNewTabs: true,

  // ── autonomous pause control ──
  // A paused page is frozen for everyone, and the automation action that tripped
  // the breakpoint will time out waiting for it. So the default is capture-then-
  // resume: DevCDP drives the debugger itself and nobody has to press anything.
  autoResumeDefault: true,
  // Backstop. If execution is still paused this long — because a hold was
  // requested and then forgotten, or the agent stopped responding — DevCDP
  // resumes anyway rather than leaving a dead app on screen.
  maxPauseMs: 30000,

  // ── privacy (SEC-2) ──
  captureInputValues: false,
  maxPostDataBytes: 8192,

  // ── app-specific hooks, empty by default ──
  dialogSelectors: [],             // extra modal selectors for your app
  testAttributes: ["data-testid", "data-test-id", "data-test", "data-qa", "data-cy", "data-automation-id"],
  docsRoot: null,                  // where to read README/docs from
  helpBaseUrl: null,               // in-app help system, if you have one
  apiProbePaths: [                 // generic OpenAPI discovery, not app-specific
    "/swagger/v1/swagger.json",
    "/swagger/v1/swagger.yaml",
    "/openapi.json",
    "/openapi/v3.json",
    "/api-docs",
    "/v3/api-docs",
    "/.well-known/openapi.json",
  ],

  // ── storage ──
  memoryDir: path.join(os.homedir(), ".devcdp"),
  // Screenshots are written to disk and referenced by path by default, rather than
  // returned inline. A full-page capture of a real application is comfortably over a
  // megabyte of base64 — around a quarter of a million tokens — so returning one to
  // the model by default would cost more than the entire tool listing, every time.
  // Ask for `inline` when the model genuinely needs to look at it.
  screenshotDir: path.join(os.homedir(), ".devcdp", "screenshots"),
  sharedMemoryDir: null,           // MEM-1 — set to a network/repo path to pool team fixes

  // ── liveness ──
  // Every call into the page is raced against this. It has to be enforced on our
  // side: Runtime.evaluate's own `timeout` parameter is applied by the renderer,
  // so when the renderer is the thing that is stuck — an infinite loop or a long
  // synchronous task in page JS — that parameter never fires and the call hangs
  // for ever. Measured, not assumed.
  evalTimeoutMs: 8000,
  // Backstop for anything else a tool might wait on (fetching a script's source,
  // reading a response body) if the renderer or the socket stops answering.
  toolTimeoutMs: 30000,
  // How long to wait for the initial CDP socket.
  connectTimeoutMs: 10000,
  // When every tab is claimed, wait this long for a departing session to release
  // one before opening a new tab. Reloading an assistant overlaps the outgoing and
  // incoming server processes, and without this grace period every reload left a
  // stray tab behind.
  claimGraceMs: 2500,
  // A dropped socket mid-call is retried once, after reattaching.
  retryOnDisconnect: true,
  // When the page's main thread is wedged, abort the running script with
  // Runtime.terminateExecution and retry once. Measured: terminateExecution frees
  // a spin loop in ~8ms, whereas Page.reload and Page.navigate do not free it at
  // all. This is reported on the response and in the activity log, never silently.
  autoRecoverUnresponsive: true,

  // ── response budget ──
  // Ceiling on any single tool response. Measured: an uncapped whole-file read or a
  // DOM dump reached 8 KB on a trivial fixture and would be far larger on a real
  // app — every byte of it spent from the model's context. Enforced centrally so a
  // new tool cannot forget it, and reported rather than silently trimmed.
  maxResponseBytes: 16000,

  // ── limits ──
  consoleBufferSize: 2000,
  networkBufferSize: 500,
  mutationBufferSize: 400,
  activityBufferSize: 800,
};

const ENV_MAP = {
  DEVCDP_HOST:                ["host",               String],
  DEVCDP_PORT:                ["port",               Number],
  DEVCDP_BADGE:              ["badge",              v => v !== "0" && v !== "false"],
  DEVCDP_BADGE_CORNER:        ["badgeCorner",        String],
  DEVCDP_BADGE_AUTOCOLLAPSE:  ["badgeAutoCollapse",  v => v !== "0" && v !== "false"],
  DEVCDP_BADGE_IDLE_MS:       ["badgeIdleMs",        Number],
  DEVCDP_TAB_GROUP_MODE:      ["tabGroupMode",       String],
  DEVCDP_TOASTS:              ["toasts",             v => v !== "0" && v !== "false"],
  DEVCDP_NARRATE:             ["narrateTools",       v => v !== "0" && v !== "false"],
  DEVCDP_TOAST_CORNER:        ["toastCorner",        String],
  DEVCDP_TOAST_POSITION:      ["toastPosition",      String],
  DEVCDP_TOAST_MS:            ["toastMs",            Number],
  DEVCDP_TOAST_OPACITY:       ["toastOpacity",       Number],
  DEVCDP_CHROME_PROFILE:      ["chromeProfile",      String],
  DEVCDP_CHROME_FLAGS:        ["chromeFlags",        v => v.split(/s+/).filter(Boolean)],
  DEVCDP_EVAL_TIMEOUT_MS:     ["evalTimeoutMs",      Number],
  DEVCDP_TOOL_TIMEOUT_MS:     ["toolTimeoutMs",      Number],
  DEVCDP_MAX_PAUSE_MS:        ["maxPauseMs",         Number],
  DEVCDP_AUTO_RESUME:         ["autoResumeDefault",  v => v !== "0" && v !== "false"],
  DEVCDP_DOCS_ROOT:           ["docsRoot",           String],
  DEVCDP_HELP_BASE_URL:       ["helpBaseUrl",        String],
  DEVCDP_SHARED_MEMORY_DIR:   ["sharedMemoryDir",    String],
  DEVCDP_CAPTURE_INPUT_VALUES:["captureInputValues", v => v === "1" || v === "true"],
  DEVCDP_DISABLE_WEB_SECURITY:["disableWebSecurity", v => v === "1" || v === "true"],
  DEVCDP_DIALOG_SELECTORS:    ["dialogSelectors",    v => v.split(",").map(s => s.trim()).filter(Boolean)],
  DEVCDP_TEST_ATTRIBUTES:     ["testAttributes",     v => v.split(",").map(s => s.trim()).filter(Boolean)],
};

/**
 * Where settings may live, lowest precedence first. A bare `settings.json` is only
 * accepted from the install directory or a `.devcdp/` folder — see the header.
 */
export function settingsCandidates(cwd = process.cwd()) {
  return [
    path.join(INSTALL_DIR, "devcdp.settings.json"),
    path.join(INSTALL_DIR, "settings.json"),
    path.join(cwd, ".devcdp", "settings.json"),
    path.join(cwd, "devcdp.settings.json"),
    path.join(cwd, "devcdp.config.json"),        // the earlier name, still honoured
  ];
}

/** Comment-tolerant, so a hand-edited settings file with notes in it still loads. */
function parseJsonc(text) {
  const stripped = text
    .replace(/^\uFEFF/, "")
    .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\n\r]*/g, (m, str) => (str ? str : ""))
    .replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(stripped);
}

function readFileConfig() {
  const merged = {};
  const provenance = {};
  const loaded = [];
  const problems = [];

  for (const file of settingsCandidates()) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = parseJsonc(fs.readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        problems.push({ file, error: "top level is not an object" });
        continue;
      }
      for (const [k, v] of Object.entries(parsed)) {
        if (k.startsWith("//") || k === "$schema") continue;   // comment keys
        merged[k] = v;
        provenance[k] = file;
      }
      loaded.push(file);
      log.info("config", `loaded settings from ${file}`);
    } catch (e) {
      // Never guess at a broken settings file — say so and carry on with defaults.
      problems.push({ file, error: e.message });
      log.warn("config", `ignoring unreadable ${file}: ${e.message}`);
    }
  }
  return { merged, provenance, loaded, problems };
}

function readEnvConfig() {
  const out = {}, provenance = {};
  for (const [envName, [key, cast]] of Object.entries(ENV_MAP)) {
    const raw = process.env[envName];
    if (raw == null || raw === "") continue;
    try { out[key] = cast(raw); provenance[key] = `env:${envName}`; } catch (_) {}
  }
  return { out, provenance };
}

export function loadConfig(overrides = {}) {
  const files = readFileConfig();
  const env   = readEnvConfig();

  const cfg = { ...DEFAULTS, ...files.merged, ...env.out, ...overrides };

  // Where every effective value came from, so devcdp_settings can show it and an
  // unexpected value can be traced to the file or variable that set it.
  const provenance = {};
  for (const key of Object.keys(DEFAULTS)) provenance[key] = "default";
  Object.assign(provenance, files.provenance, env.provenance);
  for (const key of Object.keys(overrides)) provenance[key] = "session override";

  // Keys present in a settings file that DevCDP does not recognise are almost
  // always typos, and silently ignoring them is how "I changed it and nothing
  // happened" starts.
  const unknownKeys = Object.keys(files.merged).filter(k => !(k in DEFAULTS));

  cfg._meta = {
    installDir: INSTALL_DIR,
    settingsFilesLoaded: files.loaded,
    settingsFilesSearched: settingsCandidates(),
    settingsProblems: files.problems,
    unknownKeys,
    provenance,
    recommendedSettingsPath: files.loaded[0] || path.join(INSTALL_DIR, "devcdp.settings.json"),
  };
  if (unknownKeys.length) log.warn("config", `unrecognised setting(s) ignored: ${unknownKeys.join(", ")}`);

  if (!Number.isFinite(cfg.port) || cfg.port <= 0) cfg.port = DEFAULTS.port;
  const CORNERS = ["tc", "bc", "tr", "tl", "br", "bl"];
  if (!CORNERS.includes(cfg.badgeCorner)) cfg.badgeCorner = DEFAULTS.badgeCorner;

  // toastCorner is the real setting; toastPosition is accepted as an alias so an
  // existing settings file keeps working. Whichever was set explicitly wins, and
  // both end up holding the same value so either name can be read back.
  const cornerSetExplicitly   = provenance.toastCorner   && provenance.toastCorner   !== "default";
  const positionSetExplicitly = provenance.toastPosition && provenance.toastPosition !== "default";
  let corner = cornerSetExplicitly ? cfg.toastCorner
             : positionSetExplicitly ? cfg.toastPosition
             : DEFAULTS.toastCorner;
  if (!CORNERS.includes(corner)) corner = DEFAULTS.toastCorner;
  cfg.toastCorner = cfg.toastPosition = corner;
  if (positionSetExplicitly && !cornerSetExplicitly) {
    provenance.toastCorner = provenance.toastPosition;
    log.info("config", "toastPosition is an alias of toastCorner — both are honoured");
  }
  if (!["session", "single"].includes(cfg.tabGroupMode)) cfg.tabGroupMode = "session";
  if (!Array.isArray(cfg.chromeFlags)) cfg.chromeFlags = [];

  const clamp = (key, lo, hi, fallback) => {
    const v = Number(cfg[key]);
    cfg[key] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
  };
  clamp("toastOpacity", 0.15, 1, DEFAULTS.toastOpacity);
  clamp("toastMs", 500, 60000, DEFAULTS.toastMs);
  clamp("toastMaxVisible", 1, 8, DEFAULTS.toastMaxVisible);
  clamp("evalTimeoutMs", 500, 120000, DEFAULTS.evalTimeoutMs);
  clamp("toolTimeoutMs", 1000, 600000, DEFAULTS.toolTimeoutMs);
  clamp("connectTimeoutMs", 500, 120000, DEFAULTS.connectTimeoutMs);
  clamp("maxPauseMs", 0, 600000, DEFAULTS.maxPauseMs);
  // Never below 20s: the overlay beats on the 20s keepalive, so a shorter timeout
  // would tear down healthy overlays between beats.
  clamp("ownerTimeoutMs", 20000, 600000, DEFAULTS.ownerTimeoutMs);
  if (!Array.isArray(cfg.dialogSelectors)) cfg.dialogSelectors = [];
  if (!Array.isArray(cfg.testAttributes) || !cfg.testAttributes.length) cfg.testAttributes = DEFAULTS.testAttributes;

  // docsRoot defaults to the client's working directory when it looks like a repo,
  // which is what makes "read the app's own README" work with zero configuration.
  if (!cfg.docsRoot) {
    const cwd = process.cwd();
    const looksLikeRepo = [".git", "package.json", "README.md", "Readme.md", "readme.md"]
      .some(m => fs.existsSync(path.join(cwd, m)));
    if (looksLikeRepo && path.resolve(cwd) !== INSTALL_DIR) cfg.docsRoot = cwd;
  }

  cfg.installDir = INSTALL_DIR;
  cfg.extensionDir = path.join(INSTALL_DIR, "extension");
  return cfg;
}

export { INSTALL_DIR };
