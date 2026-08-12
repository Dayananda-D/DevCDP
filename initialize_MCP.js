// ─── DevCDP setup wizard ─────────────────────────────────────────────────────
// The previous installer had a genuinely destructive bug (CFG-1):
//
//   let cfg = {};
//   if (fileExists) { try { cfg = JSON.parse(read(file)) } catch (_) { cfg = {} } }
//   ...
//   fs.writeFileSync(file, JSON.stringify(cfg))
//
// Any config it could not parse — a file with comments, a trailing comma, a
// momentarily truncated write — was silently replaced by a file containing only
// DevCDP's own entry. For one editor that meant the user's entire settings file;
// for the CLI config it meant every project's stored history. And the README
// advertised this as "saves configuration cleanly without creating backup
// clutter", i.e. no backups either.
//
// Rules now:
//   • a file we cannot parse is NEVER written — we print the snippet to paste
//   • every write is atomic (temp file + rename) and takes one timestamped backup
//   • each editor gets the config shape it actually documents (CFG-2)
//   • the automation server is pinned to a resolved version, not "@latest" (CFG-3)
//   • detection looks for real markers, not just a home directory (CFG-4)
//   • legacy entries from older installs are cleaned up (CFG-5)

import fs   from "fs";
import path from "path";
import os   from "os";
import readline from "readline";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const SERVER_PATH = path.join(__dirname, "index.js").replace(/\\/g, "/");
const EXTENSION   = path.join(__dirname, "extension").replace(/\\/g, "/");
// Older installs registered this server under other names, sometimes twice, which
// left the assistant seeing two copies of every tool and two clients attached to one
// browser (CFG-5). Rather than keep a list of historical names, we identify a stale
// entry by what it points at: any server whose command arguments reference this
// install directory but is not the canonical "devcdp" entry.
export function isStaleEntry(name, entry) {
  if (name === "devcdp") return false;
  const args = Array.isArray(entry?.args) ? entry.args : [];
  const here = path.resolve(__dirname).toLowerCase();

  return args.some(a => {
    if (typeof a !== "string" || !a) return false;

    // Only absolute paths are considered. path.resolve() on a relative argument
    // resolves it against the CURRENT directory — and the wizard is launched from
    // the install directory, so a bare flag like "--headless" resolved to
    // <install>/--headless and matched, silently deleting an unrelated MCP server
    // from the user's config. Same family of damage as CFG-1, caught by its test.
    if (a.startsWith("-")) return false;
    if (!path.isAbsolute(a)) return false;

    const resolved = path.resolve(a).toLowerCase();
    // Compare on a separator boundary, so a sibling directory sharing our prefix
    // (…/DevCDP-old) is not mistaken for something inside …/DevCDP.
    return resolved === here || resolved.startsWith(here + path.sep);
  });
}

const c = {
  b: s => `\x1b[1m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`, c: s => `\x1b[36m${s}\x1b[0m`,
};
const say = (...a) => console.log(...a);

// ─── targets ─────────────────────────────────────────────────────────────────
// `markers` are files/dirs that only exist if the editor is really installed
// (CFG-4: the old probe used os.homedir(), which always exists).
export const TARGETS = [
  {
    id: "claude-desktop", name: "Claude Desktop",
    file: path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json"),
    markers: [path.join(process.env.APPDATA || "", "Claude")],
    shape: "mcpServers", jsonc: false,
  },
  {
    id: "claude-code", name: "Claude Code (CLI)",
    file: path.join(os.homedir(), ".claude.json"),
    markers: [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude")],
    shape: "mcpServers", jsonc: false,
  },
  {
    id: "cursor", name: "Cursor",
    file: path.join(os.homedir(), ".cursor", "mcp.json"),
    markers: [path.join(os.homedir(), ".cursor")],
    shape: "mcpServers", jsonc: false,
  },
  {
    id: "windsurf", name: "Windsurf",
    file: path.join(os.homedir(), ".codeium", "windsurf", "mcp_config.json"),
    markers: [path.join(os.homedir(), ".codeium", "windsurf")],
    shape: "mcpServers", jsonc: false,
  },
  {
    id: "vscode", name: "VS Code (user settings)",
    file: process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "Code", "User", "settings.json")
      : path.join(os.homedir(), ".config", "Code", "User", "settings.json"),
    markers: [process.platform === "win32"
      ? path.join(process.env.APPDATA || "", "Code", "User")
      : path.join(os.homedir(), ".config", "Code", "User")],
    shape: "vscode", jsonc: true,
  },
  {
    id: "zed", name: "Zed",
    file: path.join(os.homedir(), ".config", "zed", "settings.json"),
    markers: [path.join(os.homedir(), ".config", "zed")],
    // CFG-2: Zed uses context_servers, not mcpServers. The old installer wrote
    // mcpServers, so Zed never worked while the docs claimed it did.
    shape: "contextServers", jsonc: true,
  },
];

// ─── assistant guidance ──────────────────────────────────────────────────────
//
// Registering the server tells an assistant that seventy-odd tools exist. It does not
// tell it which to reach for, in what order, or what the traps are — so the first
// session with DevCDP tends to relearn the same three things: that console history
// before attach is gone, that an unbound breakpoint never fires, and that reaching for
// a general browser-automation server when DevCDP is already attached to the tab is
// slower and can land in someone else's tab.
//
// That belongs with the install, not in each person's memory, so it is written once
// into the file the chosen client already reads.
//
// The text lives in initialize/ as plain markdown rather than as a string in here, so
// it can be edited — and reviewed in a diff — without touching code, and so a team can
// add what is specific to their own application. A per-client file overrides the
// default when one exists.

export const GUIDANCE_DIR = path.join(__dirname, "initialize");

const MARK_BEGIN = "<!-- devcdp:begin — managed by initialize_MCP.js; edits inside this block are overwritten -->";
const MARK_END   = "<!-- devcdp:end -->";

/**
 * The guidance to give one client: initialize/<id>.md if it exists, else
 * initialize/AGENTS.md.
 *
 * A missing template is reported rather than papered over with a built-in fallback.
 * Silently writing something other than what is in the folder would make the folder a
 * lie, and the folder is the whole point — someone who edits AGENTS.md and sees their
 * words not appear has no way to tell why.
 */
export function loadGuidance(clientId = null) {
  const candidates = [
    ...(clientId ? [path.join(GUIDANCE_DIR, `${clientId}.md`)] : []),
    path.join(GUIDANCE_DIR, "AGENTS.md"),
  ];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const body = fs.readFileSync(file, "utf8").trim();
      if (body) return { ok: true, body, source: file };
      return { ok: false, reason: `${file} is empty` };
    } catch (e) {
      return { ok: false, reason: `cannot read ${file} (${e.message})` };
    }
  }
  return {
    ok: false,
    reason: `no guidance template found — expected ${path.join(GUIDANCE_DIR, "AGENTS.md")}. `
          + "The install looks incomplete; re-copy the initialize/ folder.",
  };
}


/**
 * Where each client reads standing instructions.
 *
 * Only the two user-level files that are unambiguous get written. The rest are
 * project-scoped by design — the assistant reads them from the repository being worked
 * on, not from the home directory — so the installer writes a copy it can be pointed
 * at and says where to put it, rather than guessing at a path and silently writing a
 * file nobody reads.
 */
export function guidanceTargetFor(id) {
  switch (id) {
    case "claude-code":
      return { file: path.join(os.homedir(), ".claude", "CLAUDE.md"), scope: "user" };
    case "windsurf":
      return { file: path.join(os.homedir(), ".codeium", "windsurf", "memories", "global_rules.md"), scope: "user" };
    case "cursor":
      return { scope: "project", where: "AGENTS.md in each project you debug" };
    case "zed":
      return { scope: "project", where: "AGENTS.md in each project you debug" };
    case "vscode":
      return { scope: "project", where: ".github/copilot-instructions.md in each project you debug" };
    default:
      return { scope: "none" };     // Claude Desktop has no instruction-file mechanism
  }
}

/**
 * Write the guidance into a markdown file, inside markers so re-running replaces it
 * instead of appending a second copy. Anything the user wrote outside the block is
 * left exactly as it was.
 */
export function writeGuidance(file, body) {
  if (!body || !String(body).trim()) {
    return { status: "skipped", reason: "no guidance body was supplied" };
  }
  const block = `${MARK_BEGIN}\n${body.trim()}\n${MARK_END}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  let existing = "";
  if (fs.existsSync(file)) {
    try { existing = fs.readFileSync(file, "utf8"); }
    catch (e) { return { status: "skipped", reason: `cannot read it (${e.message})` }; }
  }

  let backup = null;
  if (existing) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backup = `${file}.devcdp-backup-${stamp}`;
    try { fs.copyFileSync(file, backup); } catch (_) { backup = null; }
  }

  const start = existing.indexOf(MARK_BEGIN);
  const end   = existing.indexOf(MARK_END);
  let next, action;

  if (start !== -1 && end !== -1 && end > start) {
    next = existing.slice(0, start) + block + existing.slice(end + MARK_END.length).replace(/^\n/, "");
    action = "updated";
  } else if (existing.trim()) {
    next = existing.replace(/\s*$/, "") + "\n\n" + block;
    action = "appended";
  } else {
    next = block;
    action = "created";
  }

  try {
    const tmp = `${file}.devcdp-tmp-${process.pid}`;
    fs.writeFileSync(tmp, next, "utf8");
    fs.renameSync(tmp, file);
  } catch (e) { return { status: "skipped", reason: e.message, backup }; }

  return { status: "written", file, action, backup };
}

export const detected = () => TARGETS.map(t => ({
  ...t,
  installed: t.markers.some(m => m && fs.existsSync(m)),
  hasFile: fs.existsSync(t.file),
}));

// ─── safe JSON handling ──────────────────────────────────────────────────────
export function readConfig(target) {
  if (!target.hasFile) return { ok: true, data: {}, existed: false };
  let raw;
  try { raw = fs.readFileSync(target.file, "utf8"); }
  catch (e) { return { ok: false, reason: `cannot read the file (${e.message})` }; }

  if (!raw.trim()) return { ok: true, data: {}, existed: true, empty: true };

  try { return { ok: true, data: JSON.parse(raw), existed: true, raw }; }
  catch (e) {
    const hasComments = /^\s*\/\//m.test(raw) || /\/\*/.test(raw);
    return {
      ok: false, existed: true, raw,
      reason: hasComments
        ? "the file contains comments (JSONC), which cannot be rewritten safely without losing them"
        : `the file is not valid JSON (${e.message})`,
    };
  }
}

/** @returns {string|null} the backup path, if one was taken. */
export function writeAtomic(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let backup = null;
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    backup = `${file}.devcdp-backup-${stamp}`;
    fs.copyFileSync(file, backup);
  }

  const tmp = `${file}.devcdp-tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);      // atomic on the same volume
  return backup;
}

// ─── entries ─────────────────────────────────────────────────────────────────
export function resolvePlaywrightVersion() {
  // CFG-3: "@latest" meant a release elsewhere could break every install at once.
  try {
    const v = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm",
      ["view", "@playwright/mcp", "version"], { encoding: "utf8", timeout: 25000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  } catch (_) {}
  return null;
}

export function entriesFor(shape, { playwrightVersion, includeAutomation }) {
  const devcdp = { command: "node", args: [SERVER_PATH] };
  // Deliberately NOT pointed at DevCDP's debugging port.
  //
  // This used to pass --cdp-endpoint http://localhost:9222, which attached the
  // automation server to the very browser DevCDP drives — and it knows nothing about
  // DevCDP's tab claims, so it took whichever tab happened to be active. Two agents
  // then appeared to share one tab while the registry showed no conflict at all,
  // because the collision came from outside the registry entirely. Without the flag it
  // launches its own browser and cannot collide.
  //
  // DevCDP's own ui_* tools are the ones to use on the attached tab; this server is
  // kept for what they do not cover — downloads, the OS file chooser, tracing.
  const automation = includeAutomation ? {
    command: "npx",
    args: [
      playwrightVersion ? `@playwright/mcp@${playwrightVersion}` : "@playwright/mcp",
      "--browser", "chrome",
      "--output-dir", path.join(os.tmpdir(), "devcdp-automation-output"),
      "--image-responses", "omit",
    ],
  } : null;

  if (shape === "contextServers") {
    const wrap = e => ({ source: "custom", command: e.command, args: e.args, env: {} });
    return { key: "context_servers", devcdp: wrap(devcdp), automation: automation ? wrap(automation) : null };
  }
  if (shape === "vscode") {
    const wrap = e => ({ type: "stdio", command: e.command, args: e.args });
    return { key: "mcp.servers", devcdp: wrap(devcdp), automation: automation ? wrap(automation) : null, nested: ["mcp", "servers"] };
  }
  const wrap = e => ({ type: "stdio", command: e.command, args: e.args, env: {} });
  return { key: "mcpServers", devcdp: wrap(devcdp), automation: automation ? wrap(automation) : null };
}

/**
 * Detach an existing automation entry from DevCDP's browser.
 *
 * Earlier installs wrote --cdp-endpoint http://localhost:9222 into the automation
 * server, and applyEntries deliberately never overwrites an entry the user already
 * has — so the fix reached new installs only, and every existing one kept pointing at
 * the tab DevCDP drives. Left alone, the collision it causes outlives the fix.
 *
 * Only the exact collision is repaired: a Playwright entry whose CDP endpoint is a
 * local port in DevCDP's own range. An endpoint pointing anywhere else is somebody's
 * deliberate configuration and is not ours to rewrite.
 *
 * @returns {boolean} whether anything was changed.
 */
export function stripDevCdpEndpoint(entry) {
  const args = Array.isArray(entry?.args) ? entry.args : null;
  if (!args || !args.some(a => typeof a === "string" && a.includes("@playwright/mcp"))) return false;

  const i = args.indexOf("--cdp-endpoint");
  if (i === -1 || i + 1 >= args.length) return false;

  let url;
  try { url = new URL(args[i + 1]); } catch (_) { return false; }

  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const port  = Number(url.port);
  if (!local || !(port >= 9222 && port <= 9242)) return false;

  args.splice(i, 2);
  return true;
}

export function applyEntries(data, spec) {
  let bucket = data;
  if (spec.nested) {
    for (const k of spec.nested) {
      if (typeof bucket[k] !== "object" || bucket[k] === null) bucket[k] = {};
      bucket = bucket[k];
    }
  } else {
    if (typeof data[spec.key] !== "object" || data[spec.key] === null) data[spec.key] = {};
    bucket = data[spec.key];
  }

  const removed = [];
  for (const [name, entry] of Object.entries(bucket)) {    // CFG-5
    if (isStaleEntry(name, entry)) { delete bucket[name]; removed.push(name); }
  }

  // Cloned, so one spec applied to several targets cannot leak a mutation from one
  // config into another.
  bucket.devcdp = structuredClone(spec.devcdp);
  if (spec.automation && !bucket.playwright) bucket.playwright = structuredClone(spec.automation);

  // An entry we are not replacing may still be attached to DevCDP's browser from an
  // older install. Detaching it is the one edit worth making to somebody else's entry,
  // because leaving it is what makes two sessions fight over one tab.
  const migrated = [];
  for (const [name, entry] of Object.entries(bucket)) {
    if (stripDevCdpEndpoint(entry)) migrated.push(name);
  }

  return { removed, migrated, addedAutomation: !!spec.automation };
}

/**
 * Configure one editor. This is the path that used to destroy files (CFG-1), so it
 * is a single exported function the tests can drive against real files rather than
 * logic buried in an interactive prompt.
 *
 * Returns { status: "configured" | "skipped", ... } and — critically — writes
 * NOTHING when the existing file cannot be parsed.
 */
export function configureTarget(target, { playwrightVersion = null, includeAutomation = true } = {}) {
  const spec = entriesFor(target.shape, { playwrightVersion, includeAutomation });
  const read = readConfig(target);

  if (!read.ok) {
    // The v4 bug lived exactly here: it fell back to an empty object and wrote,
    // replacing the user's file with only DevCDP's own entry.
    return { status: "skipped", reason: read.reason, snippet: snippetFor(spec), wrote: false };
  }

  try {
    const { removed, migrated, addedAutomation } = applyEntries(read.data, spec);
    const backup = writeAtomic(target.file, read.data);
    return { status: "configured", removed, migrated, addedAutomation, backup, wrote: true, key: spec.key };
  } catch (e) {
    return { status: "skipped", reason: e.message, snippet: snippetFor(spec), wrote: false };
  }
}

export function snippetFor(spec) {
  const body = spec.nested
    ? { mcp: { servers: { devcdp: spec.devcdp } } }
    : { [spec.key]: { devcdp: spec.devcdp } };
  return JSON.stringify(body, null, 2);
}

// ─── launcher ────────────────────────────────────────────────────────────────
export function writeLauncher(dir, label) {
  const file = path.join(dir, "debug-chrome.bat");
  // SEC-1: --disable-web-security is deliberately NOT here. The old launcher
  // always set it, which quietly made CORS bugs unreproducible in the one browser
  // people were told to debug in.
  const body = `@echo off
setlocal
title Chrome for DevCDP

set "PORT=9222"
rem The same directory the server computes for this port, so the companion extension —
rem which has to be installed by hand, because branded Chrome refuses --load-extension —
rem is present however Chrome was started, and survives because this is not a temp dir.
set "PROFILE=%LOCALAPPDATA%\\DevCDP\\chrome-profiles\\port-%PORT%"
set "EXT=${EXTENSION.replace(/\//g, "\\")}"

echo.
echo   DevCDP debug browser
echo   -------------------------------------------------
echo   Port    : %PORT%
echo   Profile : %PROFILE%   (separate from your normal Chrome)
echo.

set "CHROME="
if exist "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe"
if not defined CHROME if exist "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe"
if not defined CHROME if exist "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe" set "CHROME=%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe"

if not defined CHROME (
  echo   [ERROR] Chrome was not found in the usual locations.
  echo           Set DEVCDP_CHROME_PATH, or edit this file.
  echo.
  pause
  exit /b 1
)

if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

start "" "%CHROME%" ^
  --remote-debugging-port=%PORT% ^
  --user-data-dir="%PROFILE%" ^
  --no-first-run ^
  --no-default-browser-check ^
  --disable-backgrounding-occluded-windows ^
  --disable-features=CalculateNativeWinOcclusion ^
  --no-restore-session-state ^
  --hide-crash-restore-bubble ^
  --disable-extensions-except="%EXT%" ^
  --load-extension="%EXT%"

echo   Chrome launched. Open your app, then describe the bug to your assistant.
echo.
echo   Optional, one time: to get coloured tab groups per session, open
echo     chrome://extensions  ^>  enable Developer mode  ^>  Load unpacked
echo     and select:  %EXT%
echo   Recent Chrome builds ignore --load-extension, so this step may be needed.
echo   Everything else works without it.
echo.
timeout /t 4 /nobreak >nul
`;
  try { fs.writeFileSync(file, body, "utf8"); return file; }
  catch (e) { say(`  ${c.y("!")} could not write ${label} launcher: ${e.message}`); return null; }
}

// ─── wizard ──────────────────────────────────────────────────────────────────
// One readline interface for the whole wizard, not one per question.
//
// Creating and closing an interface per prompt works at a terminal and silently loses
// input everywhere else: closing it pauses stdin, and anything already buffered from a
// pipe goes with it. So `printf 'all\ny\ny\n' | node initialize_MCP.js` answered the
// first question and then hung on the second, with no error — which also meant the
// wizard could not be exercised end to end by anything but a human.
// Lines are queued as they arrive, not read on demand.
//
// rl.question() only captures the line that arrives *after* it is called. A pipe
// delivers everything at once, so readline emitted all three answers before the second
// question was asked, two were dropped on the floor, and the next question threw
// "readline was closed". Buffering every line and handing them out in order works
// identically at a terminal and under a pipe — which is what makes the wizard
// testable rather than only human-drivable.
let rl = null, closed = false;
const pending = [];      // lines received but not yet asked for
const waiting = [];      // questions asked but not yet answered

function ensurePrompts() {
  if (rl) return;
  closed = false;
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("line", line => {
    const next = waiting.shift();
    if (next) next(line.trim()); else pending.push(line.trim());
  });
  // EOF answers everything still outstanding with the default rather than hanging.
  rl.on("close", () => { closed = true; while (waiting.length) waiting.shift()(""); });
}

const ask = q => new Promise(resolve => {
  ensurePrompts();
  process.stdout.write(q);
  if (pending.length) return resolve(pending.shift());
  if (closed) return resolve("");
  waiting.push(resolve);
});

const closePrompts = () => {
  if (!rl) return;
  const r = rl; rl = null;
  pending.length = 0; waiting.length = 0;
  r.close();
};

async function run() {
  say("");
  say(c.b("  DevCDP setup"));
  say(c.dim("  ─────────────────────────────────────────────"));
  say("");

  if (!fs.existsSync(path.join(__dirname, "index.js"))) {
    say(c.r("  index.js is missing — run this from inside the DevCDP folder."));
    process.exit(1);
  }

  const found = detected();
  const installed = found.filter(t => t.installed);
  const missing   = found.filter(t => !t.installed);

  say("  Detected:");
  if (!installed.length) say(c.y("    none of the supported editors were found"));
  installed.forEach((t, i) => say(`    ${c.c(`[${i + 1}]`)} ${t.name}${t.hasFile ? "" : c.dim("  (config will be created)")}`));
  if (missing.length) {
    say("");
    say(c.dim("  Not found: " + missing.map(t => t.name).join(", ")));
  }
  if (!installed.length) process.exit(0);

  say("");
  const choice = (await ask(`  Configure which? ${c.dim("numbers separated by commas, or 'all'")}: `)).toLowerCase();
  const chosen = choice === "all" || choice === ""
    ? installed
    : choice.split(",").map(s => installed[parseInt(s.trim(), 10) - 1]).filter(Boolean);

  if (!chosen.length) { say(c.r("\n  Nothing selected.\n")); process.exit(1); }

  const automationAnswer = (await ask(`  Also register a browser-automation server for clicking and typing? ${c.dim("[Y/n]")}: `)).toLowerCase();
  const includeAutomation = automationAnswer !== "n" && automationAnswer !== "no";

  const guidanceAnswer = (await ask(`  Write usage guidance so your assistant knows how to use DevCDP? ${c.dim("[Y/n]")}: `)).toLowerCase();
  const includeGuidance = guidanceAnswer !== "n" && guidanceAnswer !== "no";

  let playwrightVersion = null;
  if (includeAutomation) {
    process.stdout.write(c.dim("  resolving a pinned version… "));
    playwrightVersion = resolvePlaywrightVersion();
    say(playwrightVersion ? c.g(playwrightVersion) : c.y("unavailable — will use the floating tag"));
  }

  say("");
  const manual = [];
  let configured = 0;

  for (const target of chosen) {
    say(`  ${c.b(target.name)}`);
    const result = configureTarget(target, { playwrightVersion, includeAutomation });

    if (result.status === "configured") {
      say(`     ${c.g("configured")} ${c.dim(target.file)}`);
      if (result.removed.length)
        say(`     ${c.dim(`removed stale entr${result.removed.length === 1 ? "y" : "ies"}: ${result.removed.join(", ")}`)}`);
      if (result.migrated?.length)
        say(`     ${c.dim(`detached from DevCDP's browser (was --cdp-endpoint 9222): ${result.migrated.join(", ")}`)}`);
      if (result.backup) say(`     ${c.dim(`backup: ${path.basename(result.backup)}`)}`);
      if (target.id === "zed") say(`     ${c.dim("Zed's schema has changed between versions — check its settings UI shows DevCDP.")}`);
      configured++;
    } else {
      say(`     ${c.y("skipped")} — ${result.reason}`);
      say(`     ${c.dim("Nothing was written. Add this yourself:")}`);
      manual.push({ target, snippet: result.snippet });
    }
  }

  // ── guidance ──
  // Each client gets the template meant for it — initialize/<id>.md when one exists,
  // otherwise initialize/AGENTS.md — so a team can word it differently per client
  // without the wizard needing to know anything about the difference.
  const projectGuidance = [];
  if (includeGuidance) {
    say("");
    for (const target of chosen) {
      const g = guidanceTargetFor(target.id);
      if (g.scope === "none") continue;

      const loaded = loadGuidance(target.id);
      if (!loaded.ok) {
        say(`  ${c.y("!")} no guidance for ${target.name} — ${loaded.reason}`);
        continue;
      }

      if (g.scope === "project") {
        projectGuidance.push({ name: target.name, where: g.where, source: loaded.source });
        continue;
      }

      const res = writeGuidance(g.file, loaded.body);
      if (res.status === "written") {
        say(`  ${c.g("guidance")} ${c.dim(`${g.file}  (${res.action})`)}`);
        say(`     ${c.dim(`from ${path.relative(__dirname, loaded.source) || loaded.source}`)}`);
        if (res.backup) say(`     ${c.dim(`backup: ${path.basename(res.backup)}`)}`);
      } else {
        say(`  ${c.y("!")} could not write ${g.file} — ${res.reason}`);
      }
    }
  }

  say("");
  const launcher = writeLauncher(__dirname, "project");
  if (launcher) say(`  ${c.g("launcher")} ${c.dim(launcher)}`);
  const desktop = path.join(os.homedir(), "Desktop");
  if (fs.existsSync(desktop)) {
    const shortcut = writeLauncher(desktop, "desktop");
    if (shortcut) say(`  ${c.g("launcher")} ${c.dim(shortcut)}`);
  }

  if (manual.length) {
    say("");
    say(c.y("  Manual step needed"));
    for (const m of manual) {
      say(`\n  ${c.b(m.target.name)} — ${c.dim(m.target.file)}`);
      say(m.snippet.split("\n").map(l => "    " + l).join("\n"));
    }
  }

  if (projectGuidance.length) {
    say("");
    say(c.y("  Guidance these clients read per project, not per user"));
    for (const p of projectGuidance) {
      say(`    ${c.b(p.name)} — copy ${c.dim(p.source)}`);
      say(`      to ${p.where}`);
    }
  }

  say("");
  say(c.dim("  ─────────────────────────────────────────────"));
  say(`  ${configured} editor${configured === 1 ? "" : "s"} configured.`);
  say("");
  say("  Next:");
  say("    1. Fully quit and reopen your editor so it re-reads the config.");
  say("    2. Run debug-chrome.bat and open your app.");
  say("    3. Describe the bug to your assistant.");
  say("");
  say(c.dim("  Optional: set docsRoot and sharedMemoryDir in devcdp.config.json"));
  say(c.dim("  (copy devcdp.config.example.json) so it can read your project's docs"));
  say(c.dim("  and pool learned fixes across the team."));
  say("");

  closePrompts();     // or node keeps the process alive on an open stdin handle
}

// Only when run as a program. This file is also imported — by its own test suite, and
// by anything that wants `configureTarget` or `writeLauncher` as functions — and an
// import that starts an interactive wizard is a trap: it prints a menu nobody asked
// for, reads whatever happens to be on stdin, and is one keystroke away from editing
// the user's editor configuration as a side effect of loading a module.
const invokedDirectly = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  run().catch(e => { say(c.r(`\n  Setup failed: ${e.message}\n`)); process.exit(1); });
}
