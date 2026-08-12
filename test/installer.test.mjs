// ─── Installer tests ─────────────────────────────────────────────────────────
// CFG-1 was the most dangerous defect in the whole audit: the old installer
// replaced any config it could not parse with a file containing only DevCDP's own
// entry. For one editor that meant the user's entire settings file; for the CLI
// config it meant every project's stored history. It was fixed, and then sat there
// with no test guarding it — the single highest-value gap in the suite, because a
// regression damages the user's machine rather than just failing.
//
// These drive the real installer functions against real files in a temp directory.
// Nothing here touches your actual editor configuration.

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { pathToFileURL } from "url";

import {
  TARGETS, detected, readConfig, writeAtomic, configureTarget,
  entriesFor, applyEntries, isStaleEntry, snippetFor, writeLauncher,
  GUIDANCE_DIR, loadGuidance, guidanceTargetFor, writeGuidance, stripDevCdpEndpoint,
} from "../initialize_MCP.js";

let passed = 0, failed = 0;
const results = [];
// Awaits, so an async test cannot report ok while its assertion rejects into the
// void. That is TEST-1's defect, which this suite still had — and it silently passed
// the first async test added to it.
const check = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok   ${name}\n`); passed++; }
  catch (e) { process.stdout.write(`  FAIL ${name}\n       ${e.message}\n`); failed++; results.push({ name, error: e.message }); }
};

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-installer-test-"));
const INSTALL_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\//, "")), "..");

let seq = 0;
/** A target pointing at a scratch file, so the real write path can be exercised. */
function scratchTarget(contents, { shape = "mcpServers", id = "scratch" } = {}) {
  const file = path.join(ROOT, `cfg-${++seq}.json`);
  if (contents !== null) fs.writeFileSync(file, contents, "utf8");
  return {
    id, name: `scratch-${seq}`, file, shape,
    markers: [file],
    hasFile: contents !== null,
  };
}

const backupsFor = file =>
  fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(path.basename(file) + ".devcdp-backup-"));
const tempsFor = file =>
  fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(path.basename(file) + ".devcdp-tmp-"));

process.stdout.write("\nDevCDP installer test\n\n");

// ── CFG-1: never destroy a file we cannot parse ─────────────────────────────
await check("a config containing comments is left untouched (CFG-1)", () => {
  // This is the exact shape that used to be destroyed: JSONC, as several editors
  // legitimately use.
  const original = `{
  // my own settings, with a comment
  "editor.fontSize": 14,
  "some.other.extension": { "enabled": true }
}`;
  const target = scratchTarget(original);
  const before = fs.readFileSync(target.file, "utf8");

  const res = configureTarget(target, { includeAutomation: false });

  assert.equal(res.status, "skipped", "must refuse rather than write");
  assert.equal(res.wrote, false);
  assert.match(res.reason, /comment/i, `the reason must name the cause: ${res.reason}`);
  assert.equal(fs.readFileSync(target.file, "utf8"), before,
    "THE FILE MUST BE BYTE-IDENTICAL — this is the destructive bug");
  assert.ok(res.snippet, "must hand back a snippet to paste instead");
  assert.match(res.snippet, /devcdp/, "and the snippet must contain the entry");
});

await check("invalid JSON is left untouched, with the parse error reported (CFG-1)", () => {
  const original = `{ "mcpServers": { "other": { "command": "node" } },, }`;   // trailing commas
  const target = scratchTarget(original);
  const before = fs.readFileSync(target.file, "utf8");

  const res = configureTarget(target, { includeAutomation: false });
  assert.equal(res.status, "skipped");
  assert.equal(fs.readFileSync(target.file, "utf8"), before, "the file must not be rewritten");
  assert.ok(res.reason && res.reason.length > 10, "must explain why it was skipped");
});

await check("an unrelated user setting survives a successful write (CFG-1)", () => {
  // The old bug's real damage: everything that was not DevCDP's entry vanished.
  const target = scratchTarget(JSON.stringify({
    "editor.theme": "dark",
    mcpServers: { somethingElse: { command: "node", args: ["C:/elsewhere/other.js"] } },
    projects: { "/home/me/work": { history: ["a", "b"] } },
  }, null, 2));

  const res = configureTarget(target, { includeAutomation: false });
  assert.equal(res.status, "configured");

  const after = JSON.parse(fs.readFileSync(target.file, "utf8"));
  assert.equal(after["editor.theme"], "dark", "unrelated top-level keys must survive");
  assert.deepEqual(after.projects["/home/me/work"].history, ["a", "b"], "nested user data must survive");
  assert.ok(after.mcpServers.somethingElse, "another MCP server must survive");
  assert.ok(after.mcpServers.devcdp, "and ours must be added");
});

await check("a backup is taken before overwriting, and no temp file is left behind", () => {
  const target = scratchTarget(JSON.stringify({ mcpServers: {} }));
  const res = configureTarget(target, { includeAutomation: false });

  assert.equal(res.status, "configured");
  assert.ok(res.backup, "a backup path must be reported");
  assert.equal(backupsFor(target.file).length, 1, "exactly one backup");
  assert.equal(tempsFor(target.file).length, 0, "the atomic temp file must be renamed away");
  assert.ok(fs.existsSync(res.backup), "the backup must exist on disk");
  assert.deepEqual(JSON.parse(fs.readFileSync(res.backup, "utf8")), { mcpServers: {} },
    "the backup must hold the ORIGINAL content");
});

await check("a config that does not exist yet is created, not skipped", () => {
  const target = scratchTarget(null);
  const res = configureTarget(target, { includeAutomation: false });
  assert.equal(res.status, "configured");
  assert.ok(fs.existsSync(target.file));
  assert.ok(JSON.parse(fs.readFileSync(target.file, "utf8")).mcpServers.devcdp);
  assert.equal(res.backup, null, "nothing to back up when the file is new");
});

await check("an empty file is treated as empty config, not as corrupt", () => {
  const target = scratchTarget("   \n");
  const res = configureTarget(target, { includeAutomation: false });
  assert.equal(res.status, "configured", "whitespace is not a parse failure");
  assert.ok(JSON.parse(fs.readFileSync(target.file, "utf8")).mcpServers.devcdp);
});

// ── CFG-2: each editor gets the shape it documents ──────────────────────────
await check("each editor gets the config shape it actually documents (CFG-2)", () => {
  const opts = { playwrightVersion: "1.2.3", includeAutomation: true };

  const standard = entriesFor("mcpServers", opts);
  assert.equal(standard.key, "mcpServers");

  const zed = entriesFor("contextServers", opts);
  assert.equal(zed.key, "context_servers",
    "Zed uses context_servers — writing mcpServers is why it never worked");
  assert.equal(zed.devcdp.source, "custom", "Zed entries need source:custom");

  const vscode = entriesFor("vscode", opts);
  assert.deepEqual(vscode.nested, ["mcp", "servers"], "VS Code nests under mcp.servers");
});

await check("the Zed entry lands under context_servers in a real file (CFG-2)", () => {
  const target = scratchTarget(JSON.stringify({ "theme": "One Dark" }), { shape: "contextServers", id: "zed" });
  configureTarget(target, { includeAutomation: false });

  const after = JSON.parse(fs.readFileSync(target.file, "utf8"));
  assert.ok(after.context_servers?.devcdp, "must be under context_servers");
  assert.equal(after.mcpServers, undefined, "must NOT write the wrong key");
  assert.equal(after.theme, "One Dark", "the user's own settings must survive");
});

await check("the VS Code entry nests under mcp.servers in a real file (CFG-2)", () => {
  const target = scratchTarget(JSON.stringify({ "editor.fontSize": 13, mcp: { servers: { existing: {} } } }),
    { shape: "vscode", id: "vscode" });
  configureTarget(target, { includeAutomation: false });

  const after = JSON.parse(fs.readFileSync(target.file, "utf8"));
  assert.ok(after.mcp.servers.devcdp, "must nest correctly");
  assert.ok(after.mcp.servers.existing, "a sibling server must survive");
  assert.equal(after["editor.fontSize"], 13);
});

// ── CFG-3: pin the automation server ────────────────────────────────────────
await check("the automation server is pinned, never a floating tag (CFG-3)", () => {
  const pinned = entriesFor("mcpServers", { playwrightVersion: "0.0.42", includeAutomation: true });
  const pkg = pinned.automation.args[0];
  assert.equal(pkg, "@playwright/mcp@0.0.42", `expected a pinned version, got ${pkg}`);
  assert.ok(!JSON.stringify(pinned).includes("@latest"),
    "a floating tag means someone else's release can break every install at once");
});

await check("with no resolvable version it falls back without pinning to @latest (CFG-3)", () => {
  const unpinned = entriesFor("mcpServers", { playwrightVersion: null, includeAutomation: true });
  assert.equal(unpinned.automation.args[0], "@playwright/mcp");
  assert.ok(!JSON.stringify(unpinned).includes("@latest"));
});

await check("the automation server is optional (CFG-3)", () => {
  const none = entriesFor("mcpServers", { playwrightVersion: "1.0.0", includeAutomation: false });
  assert.equal(none.automation, null);

  const target = scratchTarget(JSON.stringify({ mcpServers: {} }));
  configureTarget(target, { includeAutomation: false });
  const after = JSON.parse(fs.readFileSync(target.file, "utf8"));
  assert.ok(after.mcpServers.devcdp);
  assert.equal(after.mcpServers.playwright, undefined, "must not register it when declined");
});

await check("an existing automation entry is not overwritten", () => {
  const mine = { command: "npx", args: ["@playwright/mcp@9.9.9", "--my-flag"] };
  const target = scratchTarget(JSON.stringify({ mcpServers: { playwright: mine } }));
  configureTarget(target, { playwrightVersion: "1.0.0", includeAutomation: true });

  const after = JSON.parse(fs.readFileSync(target.file, "utf8"));
  assert.deepEqual(after.mcpServers.playwright, mine, "the user's own configuration must be respected");
});

// ── CFG-4: detection uses real markers ─────────────────────────────────────
await check("detection looks for real markers, not just a home directory (CFG-4)", () => {
  for (const t of TARGETS) {
    assert.ok(Array.isArray(t.markers) && t.markers.length, `${t.id} has no markers`);
    for (const m of t.markers) {
      assert.notEqual(path.resolve(m), path.resolve(os.homedir()),
        `${t.id} probes the home directory itself, which always exists — that was CFG-4`);
    }
  }
  const report = detected();
  assert.equal(report.length, TARGETS.length);
  for (const r of report) assert.equal(typeof r.installed, "boolean");
});

await check("a target whose marker is absent is reported as not installed (CFG-4)", () => {
  const absent = { ...TARGETS[0], markers: [path.join(ROOT, "definitely-not-here")] };
  assert.equal(absent.markers.some(m => fs.existsSync(m)), false);
});

// ── CFG-5: stale entries identified by what they point at ──────────────────
await check("a stale entry is recognised by its path, not by a hardcoded name (CFG-5)", () => {
  const ours = path.join(INSTALL_DIR, "index.js");
  assert.equal(isStaleEntry("someOldName", { command: "node", args: [ours] }), true,
    "an entry pointing into this install under another name is stale");
  assert.equal(isStaleEntry("devcdp", { command: "node", args: [ours] }), false,
    "the canonical entry is not stale");
  assert.equal(isStaleEntry("unrelated", { command: "node", args: ["C:/other/project/server.js"] }), false,
    "somebody else's server must never be removed");
  assert.equal(isStaleEntry("weird", {}), false, "an entry with no args must not be touched");
  assert.equal(isStaleEntry("weird2", { args: "not-an-array" }), false);
});

await check("a bare flag is never mistaken for a path into this install (CFG-5)", () => {
  // Found by the test below: path.resolve() on a relative argument resolves it
  // against the current directory, and the wizard runs FROM the install directory,
  // so "--my-flag" became <install>/--my-flag and matched. That silently deleted
  // unrelated MCP servers from the user's config.
  assert.equal(isStaleEntry("other", { command: "npx", args: ["@some/pkg", "--headless"] }), false,
    "flags must never be treated as paths");
  assert.equal(isStaleEntry("other", { command: "npx", args: ["--flag=value"] }), false);
  assert.equal(isStaleEntry("other", { command: "node", args: ["relative/path.js"] }), false,
    "a relative path must not be resolved against the current directory");
  assert.equal(isStaleEntry("other", { command: "node", args: ["server.js"] }), false);
});

await check("a sibling directory sharing our prefix is not treated as ours (CFG-5)", () => {
  const sibling = INSTALL_DIR + "-old";
  assert.equal(isStaleEntry("other", { command: "node", args: [path.join(sibling, "index.js")] }), false,
    `${sibling} is a different install and must be left alone`);
  assert.equal(isStaleEntry("other", { command: "node", args: [path.join(INSTALL_DIR, "sub", "x.js")] }), true,
    "something genuinely inside this install is still detected");
});

await check("duplicate registrations of this install are removed (CFG-5)", () => {
  const ours = path.join(INSTALL_DIR, "index.js").replace(/\\/g, "/");
  const target = scratchTarget(JSON.stringify({
    mcpServers: {
      claudebugg: { command: "node", args: [ours] },              // an older name
      "browser-debugger": { command: "node", args: [ours] },      // and another
      keepMe: { command: "node", args: ["C:/somewhere/else.js"] },
    },
  }, null, 2));

  const res = configureTarget(target, { includeAutomation: false });
  assert.equal(res.status, "configured");
  assert.equal(res.removed.length, 2, `expected 2 stale entries removed, got ${JSON.stringify(res.removed)}`);

  const after = JSON.parse(fs.readFileSync(target.file, "utf8"));
  assert.equal(after.mcpServers.claudebugg, undefined);
  assert.equal(after.mcpServers["browser-debugger"], undefined);
  assert.ok(after.mcpServers.keepMe, "an unrelated server must be left alone");
  assert.ok(after.mcpServers.devcdp, "and ours must be present exactly once");
});

// ── general ────────────────────────────────────────────────────────────────
await check("the written entry points at this install's entry point", () => {
  const target = scratchTarget(null);
  configureTarget(target, { includeAutomation: false });
  const entry = JSON.parse(fs.readFileSync(target.file, "utf8")).mcpServers.devcdp;
  assert.equal(entry.command, "node");
  assert.ok(entry.args[0].endsWith("index.js"), `expected index.js, got ${entry.args[0]}`);
  assert.ok(fs.existsSync(entry.args[0]), "the path written must actually exist");
});

await check("re-running the installer is idempotent", () => {
  const target = scratchTarget(JSON.stringify({ mcpServers: {} }));
  configureTarget(target, { includeAutomation: false });
  const first = fs.readFileSync(target.file, "utf8");
  configureTarget({ ...target, hasFile: true }, { includeAutomation: false });
  const second = fs.readFileSync(target.file, "utf8");
  assert.equal(first, second, "a second run must not change the result");
});

await check("the manual snippet is valid JSON for every shape", () => {
  for (const shape of ["mcpServers", "contextServers", "vscode"]) {
    const spec = entriesFor(shape, { playwrightVersion: "1.0.0", includeAutomation: false });
    const snippet = snippetFor(spec);
    const parsed = JSON.parse(snippet);
    assert.ok(JSON.stringify(parsed).includes("devcdp"), `${shape} snippet must contain the entry`);
  }
});

await check("one spec applied to several configs keeps them independent", () => {
  const spec = entriesFor("mcpServers", { playwrightVersion: "1.0.0", includeAutomation: true });
  const a = {}, b = {};
  applyEntries(a, spec);
  applyEntries(b, spec);
  assert.deepEqual(a.mcpServers.devcdp, b.mcpServers.devcdp, "both configs must get the same entry");

  a.mcpServers.devcdp.args.push("mutated");
  assert.equal(b.mcpServers.devcdp.args.includes("mutated"), false,
    "editing one config must not reach into another — entries are cloned, not shared");
});

await check("importing the installer does not start the wizard", async () => {
  // It used to. `run()` was called unconditionally at the bottom of the file, so
  // merely importing it printed a setup menu and read whatever was on stdin — one
  // keystroke away from rewriting the user's editor config as a side effect of loading
  // a module. This suite imports the file, so it was running the wizard on every test
  // run as well.
  const { execFileSync } = await import("child_process");
  const url = pathToFileURL(path.resolve("initialize_MCP.js")).href;
  const out = execFileSync(process.execPath,
    ["--input-type=module", "-e", `import(${JSON.stringify(url)}).then(() => console.log("IMPORTED"))`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 });
  assert.match(out, /IMPORTED/, "the module should import cleanly");
  assert.ok(!/DevCDP setup|Configure which/i.test(out),
    `importing printed the wizard:\n${out.slice(0, 400)}`);
});

await check("the launcher and the server share one persistent Chrome profile", async () => {
  // The companion extension that draws real Chrome tab groups cannot be installed
  // programmatically — branded Chrome refuses --load-extension — so it is installed by
  // hand, once. That only stays true if the profile persists and both entry points use
  // it. Previously the launcher used %LOCALAPPDATA%\DevCDP\chrome-profile while the
  // server used a directory under TEMP, so an extension installed via one was invisible
  // to the other, and Windows cleanup could purge the server's copy.
  const { loadConfig } = await import("../src/core/config.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-launcher-"));
  const bat = fs.readFileSync(writeLauncher(dir), "utf8");
  const base = loadConfig({}).chromeProfileBase;

  assert.ok(!/[\\/]Temp[\\/]/i.test(base) && !/[\\/]tmp[\\/]/i.test(base),
    `the profile must not live in a temp directory that cleanup can purge: ${base}`);

  const forPort = path.join(base, "port-9222");
  const inBat = /set "PROFILE=([^"]+)"/.exec(bat)?.[1] || "";
  const expanded = inBat
    .replace(/%LOCALAPPDATA%/i, process.env.LOCALAPPDATA || "")
    .replace(/%PORT%/i, "9222");
  assert.equal(path.resolve(expanded).toLowerCase(), path.resolve(forPort).toLowerCase(),
    `launcher uses ${expanded}, server uses ${forPort} — a one-time extension install would only apply to one of them`);
});

await check("the launcher tells Chrome not to sleep when its window is covered", () => {
  // Chrome treats a fully occluded window's tabs as hidden, and a hidden tab does not
  // process synthesized input — so with the browser behind your editor, DevCDP's
  // clicks were accepted and did nothing. Measured, then fixed with these flags.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-launcher-"));
  const bat = fs.readFileSync(writeLauncher(dir), "utf8");
  assert.match(bat, /--disable-backgrounding-occluded-windows/);
  assert.match(bat, /--disable-features=CalculateNativeWinOcclusion/);
});

// ── assistant guidance ───────────────────────────────────────────────────────
await check("the automation server is never pointed at DevCDP's own browser", () => {
  // This is the whole reason two sessions appeared to share one tab: the installer
  // attached the automation server to port 9222, where it took whichever tab was
  // active, knowing nothing about DevCDP's claims. It must launch its own browser.
  for (const shape of ["mcpServers", "contextServers", "vscode"]) {
    const spec = entriesFor(shape, { playwrightVersion: "1.2.3", includeAutomation: true });
    const args = spec.automation.args.join(" ");
    assert.equal(args.includes("--cdp-endpoint"), false,
      `${shape}: automation must not attach to the debugging port — got ${args}`);
    assert.equal(args.includes("9222"), false, `${shape}: must not reference DevCDP's port`);
  }
});

await check("an existing automation entry is detached from DevCDP's browser", () => {
  // The fix to entriesFor only helps new installs: applyEntries never overwrites an
  // entry the user already has, so every existing setup kept pointing at port 9222.
  const pw = { command: "npx", args: ["@playwright/mcp@1.2.3", "--browser", "chrome",
    "--cdp-endpoint", "http://localhost:9222", "--image-responses", "omit"] };
  assert.equal(stripDevCdpEndpoint(pw), true, "the collision must be repaired");
  assert.deepEqual(pw.args, ["@playwright/mcp@1.2.3", "--browser", "chrome", "--image-responses", "omit"],
    "only the endpoint pair may be removed");

  // …and it must happen through the real path, on an entry we did not write.
  const data = { mcpServers: { playwright: { command: "npx",
    args: ["@playwright/mcp", "--cdp-endpoint", "http://127.0.0.1:9223"] } } };
  const res = applyEntries(data, entriesFor("mcpServers", { playwrightVersion: null, includeAutomation: true }));
  assert.deepEqual(res.migrated, ["playwright"], "the change must be reported, not silent");
  assert.equal(data.mcpServers.playwright.args.includes("--cdp-endpoint"), false);
});

await check("a deliberate CDP endpoint elsewhere is left alone", () => {
  // Only DevCDP's own port range is ours to repair. Anything else is somebody's
  // configuration, and rewriting it would be the overreach CFG-1 was about.
  const remote = { command: "npx", args: ["@playwright/mcp", "--cdp-endpoint", "http://build-box:9222"] };
  assert.equal(stripDevCdpEndpoint(remote), false, "a non-local endpoint is not ours");
  assert.equal(remote.args.length, 3);

  const otherPort = { command: "npx", args: ["@playwright/mcp", "--cdp-endpoint", "http://localhost:3000"] };
  assert.equal(stripDevCdpEndpoint(otherPort), false, "a port outside DevCDP's range is not ours");

  const notPlaywright = { command: "node", args: ["thing.js", "--cdp-endpoint", "http://localhost:9222"] };
  assert.equal(stripDevCdpEndpoint(notPlaywright), false, "only automation entries are touched");
  assert.equal(notPlaywright.args.length, 3);
});

await check("the guidance template ships with the install and covers the traps", () => {
  const loaded = loadGuidance("claude-code");
  assert.equal(loaded.ok, true, `template must ship in initialize/ — ${loaded.reason || ""}`);
  assert.match(loaded.source.replace(/\\/g, "/"), /initialize\/AGENTS\.md$/);

  const g = loaded.body;
  assert.match(g, /ui_click/, "the interaction tools must be named");
  assert.match(g, /ui_wait_for/, "waiting must be steered away from sleeps");
  assert.match(g, /Prefer these over a general browser-automation server/i);
  assert.match(g, /devtools_connect/, "it must say to attach first");
  assert.match(g, /bound/, "the unbound-breakpoint trap must be called out");
  assert.match(g, /before attach/i, "the console-history boundary must be called out");
});

await check("a per-client template overrides the default, and a missing one is reported", () => {
  // The point of a folder of files is that dropping cursor.md in it changes what
  // Cursor is told, with no code change.
  const override = path.join(GUIDANCE_DIR, "zed.md");
  const hadOne = fs.existsSync(override);
  assert.equal(hadOne, false, "test would clobber a real override");

  fs.writeFileSync(override, "# Zed-specific wording\n", "utf8");
  try {
    const zed = loadGuidance("zed");
    assert.match(zed.body, /Zed-specific wording/, "a per-client file must win");
    const other = loadGuidance("cursor");
    assert.match(other.body, /ui_click/, "other clients must still get the default");
  } finally {
    fs.rmSync(override, { force: true });
  }

  // A broken install must say so rather than quietly writing nothing, or worse,
  // writing a built-in copy that does not match what is in the folder.
  const missing = loadGuidance.call(null, "nope-not-a-client");
  assert.equal(missing.ok, true, "an unknown client falls back to the default");
});

await check("guidance is written into a marked block and re-running replaces it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-guidance-"));
  const file = path.join(dir, "CLAUDE.md");
  const body = loadGuidance("claude-code").body;

  const first = writeGuidance(file, body);
  assert.equal(first.status, "written");
  assert.equal(first.action, "created");
  assert.match(fs.readFileSync(file, "utf8"), /ui_click/);

  // Re-running must not leave two copies — the defect every append-based installer has.
  const second = writeGuidance(file, body);
  assert.equal(second.action, "updated");
  const out = fs.readFileSync(file, "utf8");
  assert.equal(out.split("devcdp:begin").length - 1, 1, "a second run must replace, not append");
});

await check("guidance never touches what the user wrote around it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-guidance-"));
  const file = path.join(dir, "CLAUDE.md");
  const body = loadGuidance("claude-code").body;
  fs.writeFileSync(file, "# My rules\n\nAlways run the linter.\n", "utf8");

  writeGuidance(file, body);
  let out = fs.readFileSync(file, "utf8");
  assert.match(out, /Always run the linter/, "existing instructions must survive");
  assert.equal(out.indexOf("# My rules"), 0, "the user's own content must stay at the top");
  assert.ok(fs.readdirSync(dir).some(f => f.includes("devcdp-backup")), "an existing file must be backed up");

  // And on the second pass, with the block already present.
  writeGuidance(file, body);
  out = fs.readFileSync(file, "utf8");
  assert.match(out, /Always run the linter/, "the user's content must survive an update too");
  assert.equal(out.split("devcdp:begin").length - 1, 1);
});

await check("writing guidance with no body is refused rather than emptying the file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devcdp-guidance-"));
  const file = path.join(dir, "CLAUDE.md");
  fs.writeFileSync(file, "# Mine\n", "utf8");

  const res = writeGuidance(file, "");
  assert.equal(res.status, "skipped", "an empty template must never be written");
  assert.equal(fs.readFileSync(file, "utf8"), "# Mine\n", "the file must be untouched");
});

await check("guidance goes to a real file for user-scoped clients, and is flagged for the rest", () => {
  // Writing a plausible-looking path that the client never reads would be worse than
  // saying where to put it: the user would believe it was configured.
  const claude = guidanceTargetFor("claude-code");
  assert.equal(claude.scope, "user");
  assert.match(claude.file, /CLAUDE\.md$/);

  const windsurf = guidanceTargetFor("windsurf");
  assert.equal(windsurf.scope, "user");

  for (const id of ["cursor", "zed", "vscode"]) {
    const g = guidanceTargetFor(id);
    assert.equal(g.scope, "project", `${id} reads instructions per project`);
    assert.ok(g.where, `${id} must say where the file belongs`);
  }
  assert.equal(guidanceTargetFor("claude-desktop").scope, "none",
    "Claude Desktop has no instruction file, and inventing one would be a lie");

  // Every configurable target must be accounted for, so a new one cannot be silently
  // skipped when it is added to TARGETS.
  for (const t of TARGETS) {
    const g = guidanceTargetFor(t.id);
    assert.ok(["user", "project", "none"].includes(g.scope), `${t.id} has no guidance decision`);
  }
});

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) {}

process.stdout.write(`\n${passed} passed, ${failed} failed\n`);
if (failed) {
  process.stdout.write("\nfailures:\n");
  for (const r of results) process.stdout.write(`  • ${r.name}\n    ${r.error}\n`);
}
process.stdout.write("\n");
process.exit(failed ? 1 : 0);
