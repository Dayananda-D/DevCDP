// ─── Offline validation ──────────────────────────────────────────────────────
// No browser required. This catches the entire class of defect that shipped in
// v4 undetected: tools with no description, schema defaults that disagree with
// the code, blind response-key stripping, and required args that were never
// validated.

import assert from "assert";
import fs from "fs";
import { createServer } from "../src/server.js";
import { listTools, getTool, resolveArgs, shape, allTools, capResponse } from "../src/core/tools.js";
import { decodeMappings, originalPositionFor, generatedPositionFor, findSourceIndex } from "../src/debug/sourcemap.js";
import { buildAgentSource } from "../src/browser/agent.js";
import { loadConfig, settingsCandidates } from "../src/core/config.js";
import { phraseFor } from "../src/core/narrate.js";

/** Minimal args that satisfy a tool's required fields, so defaults can be checked. */
function requiredStub(tool) {
  const stub = {};
  for (const [arg, spec] of Object.entries(tool.args)) {
    if (!spec.required) continue;
    stub[arg] = spec.enum ? spec.enum[0]
      : spec.type === "number" ? (spec.min ?? 1)
      : spec.type === "boolean" ? true
      : spec.type === "array" ? [{ name: "n", expression: "1", id: "s", description: "d" }]
      : spec.type === "object" ? {}
      : "placeholder-value-long-enough";
  }
  return stub;
}

let passed = 0, failed = 0;
const check = async (name, fn) => {
  try { await fn(); process.stdout.write(`  ok   ${name}
`); passed++; }
  catch (e) { process.stdout.write(`  FAIL ${name}
       ${e.message}
`); failed++; }
};

process.stdout.write("\nDevCDP offline validation\n\n");

const { ctx, health } = createServer();
const tools = listTools();

// ── registry hygiene ────────────────────────────────────────────────────────
await check("every tool has a substantial description (TOOL-4)", () => {
  const bad = tools.filter(t => !t.description || t.description.length < 20);
  assert.deepEqual(bad.map(t => t.name), [], `missing descriptions: ${bad.map(t => t.name).join(", ")}`);
});

await check("release metadata agrees across package.json, server.json, plugin and marketplace (PUB-1)", () => {
  const read = f => JSON.parse(fs.readFileSync(f, "utf8"));
  const pkg = read("package.json"), srv = read("server.json");
  const plugin = read("plugins/devcdp/.claude-plugin/plugin.json"), market = read(".claude-plugin/marketplace.json");
  assert.equal(srv.name, pkg.mcpName, "server.json name must equal package.json mcpName (registry verifies this)");
  assert.equal(srv.version, pkg.version, "server.json version");
  assert.equal(srv.packages[0].version, pkg.version, "server.json packages[0].version");
  assert.equal(srv.packages[0].identifier, pkg.name, "server.json package identifier");
  assert.ok(srv.description.length <= 100, "registry description is capped at 100 characters");
  assert.equal(plugin.version, pkg.version, "plugin.json version");
  assert.equal(market.plugins[0].version, pkg.version, "marketplace.json plugin version");
  assert.equal(market.plugins[0].source, "./plugins/devcdp");
  assert.equal(pkg.license, "MIT");
  for (const f of ["LICENSE", "PRIVACY.md", "plugins/devcdp/.mcp.json", "plugins/devcdp/scripts/launch.mjs"])
    assert.ok(fs.existsSync(f), `${f} must ship`);
});

await check("the plugin skill carries the same guidance the installer writes (PUB-2)", async () => {
  const { generateSkill } = await import("../scripts/gen-docs.mjs");
  const committed = fs.readFileSync("plugins/devcdp/skills/devcdp/SKILL.md", "utf8").replace(/\r\n/g, "\n");
  assert.equal(committed, generateSkill(), "plugins/devcdp/skills/devcdp/SKILL.md is out of date — run `npm run docs`");
});

await check("every tool carries all four MCP annotations, explicitly (directory requirement)", () => {
  const keys = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"];
  const bad = tools.filter(t => !t.annotations || keys.some(k => typeof t.annotations[k] !== "boolean"));
  assert.deepEqual(bad.map(t => t.name), [], `incomplete annotations: ${bad.map(t => t.name).join(", ")}`);
});

await check("no tool is both read-only and destructive", () => {
  const bad = tools.filter(t => t.annotations.readOnlyHint && t.annotations.destructiveHint);
  assert.deepEqual(bad.map(t => t.name), []);
});

await check("tools that drive or change the page are not marked read-only", () => {
  const mutators = tools.filter(t => /^(ui_(click|fill|type|select|check|press|drag|upload)|page_(navigate|reload|interrupt)|console_evaluate|runtime_evaluate_many|debugger_evaluate_at_frame)$/.test(t.name));
  assert.ok(mutators.length >= 14, "expected the page-changing tools to be present");
  const bad = mutators.filter(t => t.annotations.readOnlyHint || !t.annotations.destructiveHint);
  assert.deepEqual(bad.map(t => t.name), [], `should be destructive: ${bad.map(t => t.name).join(", ")}`);
});

await check("readers are marked read-only, so clients can run them without confirmation", () => {
  const readers = tools.filter(t => /^(console_get_logs|network_get_requests|dom_query|dom_get_html|source_search|source_get_file|debugger_get_scope|ui_inspect|page_screenshot|list_tabs)$/.test(t.name));
  assert.equal(readers.length, 10);
  const bad = readers.filter(t => !t.annotations.readOnlyHint);
  assert.deepEqual(bad.map(t => t.name), [], `should be read-only: ${bad.map(t => t.name).join(", ")}`);
});

await check("every argument is documented", () => {
  const bad = [];
  for (const t of tools) {
    for (const [arg, spec] of Object.entries(t.inputSchema.properties || {})) {
      if (!spec.description) bad.push(`${t.name}.${arg}`);
    }
  }
  assert.deepEqual(bad, [], `undocumented args: ${bad.join(", ")}`);
});

await check("no tool advertises a default it cannot honour (TOOL-5)", () => {
  // Defaults are applied by resolveArgs from the same declaration the schema is
  // generated from, so schema and behaviour cannot drift apart by construction.
  const t = getTool("network_wait_for_request");
  const advertised = t.args.timeout_ms.default;
  const resolved = resolveArgs(t, { url_filter: "x" });
  assert.equal(resolved.timeout_ms, advertised, "resolved default differs from advertised default");
  assert.match(t.args.timeout_ms.description, /give up|timeout|wait/i, "the timeout arg must explain itself");

  // Same guarantee, across the whole surface: schema defaults and resolved
  // defaults come from one declaration, so they cannot disagree.
  for (const tool of allTools()) {
    const resolvedAll = resolveArgs(tool, requiredStub(tool));
    for (const [arg, spec] of Object.entries(tool.args)) {
      if (!("default" in spec)) continue;
      assert.deepEqual(resolvedAll[arg], spec.default, `${tool.name}.${arg}: advertised ${JSON.stringify(spec.default)} but resolved ${JSON.stringify(resolvedAll[arg])}`);
    }
  }
});

await check("required arguments are enforced (MEM-2)", () => {
  const t = getTool("memory_record");
  assert.throws(() => resolveArgs(t, { category: "debug" }), /missing required argument/i);
  assert.throws(() => resolveArgs(t, { category: "nope", failure: "a", recovery: "b", pattern: "c" }), /must be one of/i);
});

await check("type errors are rejected, not coerced", () => {
  const t = getTool("console_get_logs");
  assert.throws(() => resolveArgs(t, { limit: "20" }), /must be a number/i);
  assert.throws(() => resolveArgs(t, { limit: 9999 }), /must be <=/i);
});

await check("unknown arguments are reported", () => {
  assert.throws(() => resolveArgs(getTool("console_clear"), { nonsense: 1 }), /unknown argument/i);
});

await check("response shaping never deletes the payload (TOOL-1/TOOL-3)", () => {
  const t = getTool("list_tabs");
  const body = { count: 3, tabs: [{ index: 0, url: "http://x" }] };
  const out = shape(t, body, resolveArgs(t, {}));
  assert.ok(Array.isArray(out.tabs), "tabs must survive shaping — this is the exact v4 bug");
  assert.equal(out.tabs.length, 1);
  assert.equal(out.ok, true);
});

await check("tool surface names no product, and hardcodes no selector", () => {
  // Vendor neutrality is checked structurally rather than with a denylist of
  // names: a denylist only catches the vendors someone thought to list, and
  // writing them down is itself the coupling we are trying to avoid.
  const offenders = [];
  for (const t of tools) {
    const text = `${t.name} ${t.description}`;
    // CSS-ish selector literals in a description mean app knowledge has leaked in.
    if (/[#.]\w[\w-]*\s*(\{|:has-text|\.x-|\[automationid)/i.test(text)) offenders.push(`${t.name}: selector literal`);
    // A bare http(s) host in a description means an environment is baked in.
    if (/https?:\/\/(?!localhost|127\.0\.0\.1)[a-z0-9.-]+/i.test(text)) offenders.push(`${t.name}: hardcoded host`);
  }
  assert.deepEqual(offenders, [], "tool surface must stay app-neutral");
});

await check("registry health check reports the tool count", () => {
  assert.ok(health.tools >= 30, `expected 30+ tools, got ${health.tools}`);
});

// ── source maps ─────────────────────────────────────────────────────────────
await check("VLQ mappings decode (SRC-2)", () => {
  // one generated line, one segment: gen col 0 → source 0, line 0, col 0
  const decoded = decodeMappings("AAAA");
  assert.equal(decoded.length, 1);
  assert.equal(decoded[0][0].srcIndex, 0);
  assert.equal(decoded[0][0].srcLine, 0);
});

await check("bundle position maps to original position", () => {
  const map = {
    sources: ["src/app.js"],
    names: [],
    // line 1: col 0 → app.js:1 ; line 2: col 0 → app.js:5
    decoded: decodeMappings("AAAA;AAIA"),
    sourcesContent: ["a\nb\nc\nd\ne\n"],
  };
  const at1 = originalPositionFor(map, 1, 1);
  assert.equal(at1.source, "src/app.js");
  assert.equal(at1.line, 1);
  const at2 = originalPositionFor(map, 2, 1);
  assert.equal(at2.line, 5, `expected original line 5, got ${at2.line}`);
});

await check("original position maps back to a bundle position (SRC-3)", () => {
  const map = { sources: ["src/app.js"], names: [], decoded: decodeMappings("AAAA;AAIA") };
  const gen = generatedPositionFor(map, "src/app.js", 5);
  assert.equal(gen.generatedLine, 2);
  assert.equal(gen.exact, true);
});

await check("source lookup tolerates partial paths", () => {
  const map = { sources: ["webpack:///./src/components/Save.jsx"], names: [], decoded: [] };
  assert.equal(findSourceIndex(map, "components/Save.jsx"), 0);
  assert.equal(findSourceIndex(map, "Save.jsx"), 0);
  assert.equal(findSourceIndex(map, "Nope.jsx"), -1);
});

// ── in-page agent ───────────────────────────────────────────────────────────
const agentSrc = buildAgentSource({ sessionId: "t", sessionNumber: 1, label: "DevCDP · test", bindingName: "__b" });

await check("agent source is syntactically valid JavaScript (SPY-1)", () => {
  new Function(agentSrc);   // throws on a syntax error
});

await check("agent never observes a null node (the v4 crash)", () => {
  assert.ok(!/observe\(document\.body\s*\|\|/.test(agentSrc), "must not observe(document.body || documentElement)");
  assert.ok(/whenBody/.test(agentSrc), "must defer observers until body exists");
});

await check("agent sets its installed flags only after installing", () => {
  const readyIdx  = agentSrc.indexOf("S.installed.mutations = true");
  const observeIdx = agentSrc.indexOf("mo.observe(document.body");
  assert.ok(observeIdx !== -1 && readyIdx > observeIdx, "flag must be set after observe() succeeds");
});

await check("agent uses geometry for visibility, not offsetParent (SPY-5)", () => {
  assert.ok(!/offsetParent/.test(agentSrc), "offsetParent is always null for position:fixed — must not be used");
  assert.ok(/getBoundingClientRect/.test(agentSrc));
});

await check("dialog detection uses only web standards, plus whatever config adds", () => {
  // Enforced by inspecting the actual selector list the agent ships with, so no
  // framework class name can be added without this failing.
  // Non-greedy up to the `.concat` that appends config-supplied selectors —
  // a naive [^\]]* stops inside the first attribute selector.
  const m = agentSrc.match(/var STANDARD_SELECTORS = (\[[\s\S]*?\])\s*\.concat/);
  assert.ok(m, "could not find the agent's selector list");
  // Extract the single-quoted entries directly; the selectors contain double
  // quotes, so quote-swapping into JSON would corrupt them.
  const list = [...m[1].matchAll(/'([^']*)'/g)].map(x => x[1]);
  assert.ok(list.length >= 4, `expected the standards-based selectors, parsed: ${JSON.stringify(list)}`);
  for (const sel of list) {
    assert.ok(
      /^(dialog\[open\]|\[role=|\[aria-)/.test(sel),
      `"${sel}" is not a web standard — dialog detection must not ship framework class names`,
    );
  }
  assert.ok(/structuralCandidates/.test(agentSrc), "geometry-based fallback must exist for apps using none of the standards");
});

await check("agent chrome cannot swallow clicks meant for the app", () => {
  assert.ok(/pointer-events:none/.test(agentSrc), "badge must not intercept pointer events");
});

// ── context / config ────────────────────────────────────────────────────────
await check("config carries no hardcoded internal hosts (HELP-3)", () => {
  assert.equal(ctx.cfg.helpBaseUrl, null, "helpBaseUrl must default to null, never a baked-in host");
  assert.deepEqual(ctx.cfg.dialogSelectors, [], "no app-specific selectors by default");
});

await check("web security is not disabled by default (SEC-1)", () => {
  assert.equal(ctx.cfg.disableWebSecurity, false);
});

await check("input values are not captured by default (SEC-2)", () => {
  assert.equal(ctx.cfg.captureInputValues, false);
});

// ── documentation ───────────────────────────────────────────────────────────
await check("the tool reference is generated and up to date", async () => {
  // 48 of 60 tools were undocumented because the docs were hand-maintained while
  // the tool surface moved. This fails the build rather than letting it drift.
  const { generate } = await import("../scripts/gen-docs.mjs");
  const { text, count, ungrouped } = await generate();
  assert.equal(count, listTools().length, "the generator must cover every registered tool");
  assert.deepEqual(ungrouped, [], `these tools are not grouped in the reference: ${ungrouped.join(", ")}`);

  const committed = fs.existsSync("docs/TOOLS.md") ? fs.readFileSync("docs/TOOLS.md", "utf8") : "";
  assert.equal(committed, text, "docs/TOOLS.md is out of date — run `npm run docs`");
});

await check("no tool points the user at a settings file we no longer recommend", () => {
  // The guides were guarded against this and the tool hints were not, so they drifted:
  // seven hints across four files still told the user to edit devcdp.config.json — the
  // legacy name, still honoured but no longer the one devcdp_settings_init writes or
  // devcdp_settings reports. Being sent to the wrong file is worse than being told
  // nothing, because it looks like it should have worked.
  const files = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".js")) files.push(full);
    }
  };
  walk("src");

  const offenders = [];
  for (const f of files) {
    // config.js legitimately lists it as a legacy filename it still reads.
    if (f.endsWith("core/config.js")) continue;
    const text = fs.readFileSync(f, "utf8");
    text.split(/\r?\n/).forEach((line, i) => {
      if (line.includes("devcdp.config.json")) offenders.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, [],
    `these name the legacy settings file: ${offenders.join(", ")}`);
});

await check("the guides do not name configuration that no longer exists", async () => {
  const stale = [/devcdp\.config\.json/, /\bquiet\b\s*:/, /popup_detect/, /app_help_get/, /filesystem_watch/];
  for (const file of ["Readme.md", "GETTING-STARTED.md"]) {
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of stale) {
      assert.ok(!pattern.test(text), `${file} still references ${pattern} — removed or renamed`);
    }
  }
});

// ── settings ────────────────────────────────────────────────────────────────
await check("settings are searched in a documented, override-friendly order", () => {
  const files = settingsCandidates("C:/some/project");
  assert.ok(files.length >= 4, "should look in both the install dir and the project");
  const names = files.map(f => f.replace(/\\/g, "/"));
  assert.ok(names.some(n => n.endsWith("/devcdp.settings.json")), "primary name must be searched");
  assert.ok(names.some(n => n.endsWith("/devcdp.config.json")), "the earlier name must still be honoured");
  // A bare settings.json must only be accepted from the install dir or .devcdp/,
  // never from a project root, where it would collide with the project's own.
  const bare = names.filter(n => n.endsWith("/settings.json"));
  assert.ok(bare.length > 0, "a bare settings.json should be supported somewhere");
  assert.ok(!bare.includes("C:/some/project/settings.json"),
    "a project's own settings.json must NOT be adopted as DevCDP configuration");
  assert.ok(bare.some(n => n.includes("/.devcdp/")), ".devcdp/settings.json should be supported");
});

await check("every effective setting records where it came from", () => {
  const cfg = loadConfig({ toastCorner: "br" });
  const prov = cfg._meta.provenance;
  assert.equal(prov.toastCorner, "session override", "an override must be attributed");
  assert.equal(prov.evalTimeoutMs, "default", "an untouched value must read as default");
  assert.ok(Array.isArray(cfg._meta.settingsFilesSearched));
  assert.ok(cfg._meta.recommendedSettingsPath, "must say which file to edit");
});

await check("nonsense setting values are clamped, not obeyed", () => {
  const cfg = loadConfig({ toastOpacity: 99, toastMs: 5, evalTimeoutMs: -1, toastCorner: "nowhere", chromeFlags: "oops" });
  assert.ok(cfg.toastOpacity <= 1 && cfg.toastOpacity >= 0.15, `opacity not clamped: ${cfg.toastOpacity}`);
  assert.ok(cfg.toastMs >= 500, `duration not clamped: ${cfg.toastMs}`);
  assert.ok(cfg.evalTimeoutMs >= 500, `timeout not clamped: ${cfg.evalTimeoutMs}`);
  assert.equal(cfg.badgeCorner, "tc", "an invalid corner must fall back");
  assert.deepEqual(cfg.chromeFlags, [], "a non-array flag list must not reach the command line");
});

await check("toast defaults: shown, top-right, translucent, self-fading", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.toasts, true, "toasts are shown by default; toasts:false hides them");
  assert.equal(cfg.toastCorner, "tr", "messages keep their own corner, independent of the badge");
  assert.notEqual(cfg.toastCorner, cfg.badgeCorner, "the badge is centred; the messages are not");
  assert.equal(cfg.toastPosition, cfg.toastCorner, "the alias must mirror the real setting");
  assert.ok(cfg.toastOpacity < 1, "must be translucent by default");
  assert.ok(cfg.toastMs > 0, "must fade rather than persist");
});

await check("the overlay starts top-centre and can be moved out of the way", () => {
  const cfg = loadConfig({});
  assert.equal(cfg.badgeCorner, "tc",
    "corners are where apps put their own controls, so the overlay must not default into one");

  const src = buildAgentSource({ corner: cfg.badgeCorner });

  // Top centre is a transform, not a corner offset — and drag has to be able to
  // override it, or the stack lands half its own width away from the drop point.
  assert.ok(/left:50%;transform:translateX\(-50%\)/.test(src), "top centre must actually be centred");
  assert.ok(/stack\.style\.transform = "none"/.test(src), "dragging must clear the centring transform");

  // The draggable object is the chip alone. Everything the overlay *says* — the
  // running commentary and the one question that waits for an answer — lives in the
  // message corner. The handover panel is the largest thing drawn, so centring it put
  // it over the application's own toolbar; it belongs with the messages.
  assert.ok(/class="stack" id="stack"/.test(src), "the chip must have its own draggable container");
  assert.ok(/id="msgs">[\s\S]{0,400}id="panel"/.test(src),
    "the handover panel must sit with the messages, not under the centred chip");
  assert.equal(/id="stack">[\s\S]{0,200}id="panel"/.test(src), false,
    "the panel must not be centred with the chip");

  const split = buildAgentSource({ corner: "tc", toastCorner: "tr" });
  assert.match(split, /"corner":"tc"/, "the chip's position must reach the page");
  assert.match(split, /"toastCorner":"tr"/, "the messages' position must reach the page");
  // position:fixed is the proof of independence — a child of the draggable stack
  // would be laid out by it and could not be positioned separately.
  assert.ok(/\.msgs\{position:fixed;" \+ \(CORNERS\[CFG\.toastCorner\]/.test(split),
    "messages must be positioned from their own setting, not dragged along by the chip");
  assert.ok(/\.chip\{[^}]*pointer-events:auto[^}]*cursor:grab/.test(src), "the chip must be grabbable");
  assert.ok(/pointerdown/.test(src) && /pointerup/.test(src), "drag must be pointer-event based, not mouse-only");

  // Two ways the overlay could become useless: dropped off-screen, or snapping back
  // over the control the user just uncovered.
  assert.ok(/function clampPos/.test(src), "the overlay must not be draggable out of the viewport");
  assert.ok(/localStorage\.setItem\(POS_KEY/.test(src), "a dropped position must survive navigation");
});

// ── narration ───────────────────────────────────────────────────────────────
await check("every tool narrates itself, not just the dozen that were hand-wired", () => {
  // The point of moving this into the dispatcher: coverage stops depending on anyone
  // remembering. A tool added tomorrow must speak without being told to.
  const silentByDesign = new Set([
    "notify_user", "session_ask_user", "session_poll_user_action",
    "devtools_status", "sessions_list", "list_tabs", "devcdp_settings", "devcdp_settings_init",
    "session_get_status", "session_get_state", "session_get_activity", "session_get_user_actions",
    "workflow_guide", "docs_outline", "docs_search", "memory_get",
    "debugger_list_breakpoints", "debugger_get_capture", "debugger_get_state",
  ]);

  const mute = [];
  for (const t of allTools()) {
    const phrase = phraseFor(t.name, {});
    if (silentByDesign.has(t.name)) {
      assert.equal(phrase, null, `${t.name} is meant to stay quiet`);
      continue;
    }
    if (!phrase || !phrase.trim()) mute.push(t.name);
  }
  assert.deepEqual(mute, [], `these tools would say nothing: ${mute.join(", ")}`);
});

await check("narration names what is being acted on, not just the verb", () => {
  assert.equal(phraseFor("ui_click", { text: "Save order" }), "clicking Save order");
  assert.equal(phraseFor("source_search", { query: "calculateTotal" }), "searching the source calculateTotal");

  // The control is the context and the value is the detail — "filling Reference"
  // tells you where you are, "filling ORD-4471" does not.
  assert.equal(phraseFor("ui_fill", { text: "Reference", value: "ORD-4471" }), "filling Reference");

  // A full URL is unreadable in a toast and its tail carries the meaning.
  assert.equal(phraseFor("page_navigate", { url: "https://erp.example.com/8/qa/#form/?table=StandardBOM" }),
    "navigating /8/qa/#form/?table=StandardBOM");
});

await check("narration stays short enough to read at a glance", () => {
  const long = phraseFor("console_evaluate", { expression: "x".repeat(400) });
  assert.ok(long.length <= 70, `a toast must not be a paragraph, got ${long.length} chars`);
  assert.match(long, /…$/, "truncation must be visible, not silent");
});

await check("narration can be turned off, and is on by default", () => {
  assert.equal(loadConfig({}).narrateTools, true, "silence and a wedged page look the same");
  assert.equal(loadConfig({ narrateTools: false }).narrateTools, false, "it must be possible to shut it up");
});

await check("the response cap holds on nested content, not just top-level lists (CAP-1)", () => {
  // Measured against a real application: a single paused frame of framework code
  // expanded to 79 KB, so trimming the frames array from two to one "capped" an 83 KB
  // response to 82 KB and reported success. The cap only ever looked at top-level
  // keys, which is no cap at all for a real object graph.
  const payload = {
    ready: true,
    frames: [{ index: 0, fn: "saveOrder", url: "app/orders.js", line: 412, scope: { local: {}, closure: {} } },
             { index: 1, fn: "handleClick", url: "app/ui.js", line: 88 }],
  };
  for (let i = 0; i < 400; i++) payload.frames[0].scope.local["v" + i] = { name: "value-".repeat(20) + i };

  const before = Buffer.byteLength(JSON.stringify(payload), "utf8");
  assert.ok(before > 50000, "the fixture payload should be genuinely oversized");

  const out = capResponse(payload, 4000, "test");
  const after = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(after <= 4000, `the cap must be a fact: ${before}B became ${after}B against a 4000B limit`);

  // The shell that says where you are must survive; only the bulk may go.
  assert.equal(out.frames[0].fn, "saveOrder", "pruning must not throw away the frame's identity");
  assert.equal(out.frames[0].url, "app/orders.js");
  assert.equal(out.frames[0].line, 412);
  assert.ok(out._truncated?.dropped?.length, "what was dropped must be reported");
  assert.ok(out._truncated.dropped.some(d => String(d.at || "").includes("scope")),
    `the report must name where detail was lost: ${JSON.stringify(out._truncated.dropped)}`);

  // And it must not damage the caller's object — debugger_get_capture hands back
  // state the context keeps, so trimming in place would corrupt every later read.
  assert.equal(Buffer.byteLength(JSON.stringify(payload), "utf8"), before,
    "capResponse mutated the payload it was given");

  // A long string buried deep is the other shape that used to slip through.
  const nested = capResponse({ a: { b: { c: "y".repeat(50000) } } }, 2000, "test");
  assert.ok(Buffer.byteLength(JSON.stringify(nested), "utf8") <= 2000, "a deeply nested string must be trimmed too");
});

await check("handover and driving states differ in motion, not only in hue", () => {
  const src = buildAgentSource({ sessionId: "t", sessionNumber: 1, label: "L", bindingName: "b" });
  assert.match(src, /@keyframes devcdpBreathe/, "driving state needs a breathing animation");
  assert.match(src, /\.edge\.ask\{animation:none/, "handover must explicitly stop the animation");
  assert.match(src, /\.edge\.alert\{animation:none/, "an error is a settled state too");
  assert.match(src, /prefers-reduced-motion/, "a stated motion preference must be respected");

  // Two colours, each with one meaning: blue is DevCDP driving, green is your turn.
  //
  // An earlier version gave every session its own accent and this check compared hex
  // strings. It passed while session 2 was #2ea043 — a different string from the
  // handover #35c759 and indistinguishable from it on screen, so a session-2 border
  // read as "your turn" to anyone looking at the tab. Nobody debugs by diffing hex, so
  // compare hue, and assert there is only one working colour to confuse.
  const hue = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const apart = (a, b) => { const d = Math.abs(hue(a) - hue(b)); return Math.min(d, 360 - d); };

  const accent   = src.match(/var ACCENT\s*=\s*"(#[0-9a-f]{6})"/i)[1];
  const handover = src.match(/var HANDOVER\s*=\s*"(#[0-9a-f]{6})"/i)[1];
  const alert    = src.match(/var ALERT\s*=\s*"(#[0-9a-f]{6})"/i)[1];

  // The working colour must not vary per session: one hue, one meaning.
  assert.ok(!/SESSION_COLORS/.test(src), "the working colour must not be chosen per session");
  for (const n of [1, 2, 5, 9]) {
    const built = buildAgentSource({ sessionId: "t", sessionNumber: n, label: "L", bindingName: "b" });
    assert.ok(built.includes(`var ACCENT = "${accent}"`), `session ${n} must use the same working colour`);
  }

  assert.ok(apart(accent, handover) > 40,
    `the working blue ${accent} is only ${Math.round(apart(accent, handover))}° from the handover green ${handover} — ` +
    `a user could not tell "DevCDP is driving" from "it is your turn"`);
  assert.ok(apart(accent, alert) > 40,
    `the working blue ${accent} is only ${Math.round(apart(accent, alert))}° from the error red ${alert}`);
  assert.ok(apart(handover, alert) > 40, "handover and error must not look alike either");
});

await check("an overlay expires when its session stops beating (UI-5)", () => {
  const src = buildAgentSource({ sessionId: "t", sessionNumber: 1, label: "L", bindingName: "b" });
  assert.match(src, /S\.beat = function/, "the session needs a way to say it is still here");
  assert.match(src, /S\.lastBeat/, "and the page has to remember when that last happened");
  // Two strikes, not one: a page paused at a breakpoint cannot beat, and a
  // background tab's timers are throttled to about once a minute — so neither a
  // single missed round nor a late tick may be treated as an abandoned session.
  assert.match(src, /S\._misses\+\+/, "the watchdog must count missed rounds");
  assert.match(src, /S\._misses < 2/, "one missed round must not be enough to give up");
  assert.ok(/S\.beat = function[^]*?S\._misses = 0/.test(src), "a beat must reset the miss count");
  assert.ok(/Date\.now\(\) - S\.lastBeat < GRACE/.test(src) && /S\.teardown\(\)/.test(src),
    "past the grace period the overlay must remove itself");

  // A too-short timeout would tear down healthy overlays between 20s keepalives.
  const cfg = loadConfig({ ownerTimeoutMs: 1000 });
  assert.ok(cfg.ownerTimeoutMs >= 20000,
    `ownerTimeoutMs must be clamped above the keepalive interval, got ${cfg.ownerTimeoutMs}`);
});

await check("edgePulse can be turned off without losing the handover signal", () => {
  const off = buildAgentSource({ sessionId: "t", sessionNumber: 1, label: "L", bindingName: "b", edgePulse: false });
  // The rule is assembled in the page from CFG, so the setting has to be checked
  // where it actually takes effect, not in the source text.
  const cfgJson = JSON.parse(off.match(/var CFG = (\{[\s\S]*?\});/)[1]);
  assert.equal(cfgJson.edgePulse, false, "the flag must reach the page");
  assert.match(off, /CFG\.edgePulse \? ";animation:devcdpBreathe/, "the pulse must be conditional on the setting");
  assert.match(off, /\.edge\.ask\{animation:none/, "handover must still be a distinct, static state");
});

await check("the agent honours toast settings rather than hardcoding them", () => {
  const src = buildAgentSource({
    sessionId: "t", sessionNumber: 1, label: "L", bindingName: "b",
    toastCorner: "bl", toastOpacity: 0.4, toastMaxVisible: 2,
  });
  assert.match(src, /bottom:14px;left:14px/, "position must come from settings");
  assert.match(src, /column-reverse/, "a bottom stack must grow upwards");
  // Opacity and duration are interpolated in the page from CFG, so assert they
  // reached CFG rather than looking for a baked-in literal.
  const cfgJson = JSON.parse(src.match(/var CFG = (\{[\s\S]*?\});/)[1]);
  assert.equal(cfgJson.toastOpacity, 0.4, "opacity must be passed to the page");
  assert.equal(cfgJson.toastMaxVisible, 2, "stack depth must be passed to the page");
  assert.match(src, /rgba\(11,26,42," \+ CFG\.toastOpacity/, "the panel colour must be driven by the setting");
});

await check("buffers account for what they drop (NET-2)", () => {
  for (let i = 0; i < ctx.cfg.mutationBufferSize + 25; i++) ctx.mutations.push({ n: i });
  const stats = ctx.mutations.stats();
  assert.equal(stats.dropped, 25, `expected 25 dropped, got ${stats.dropped}`);
  assert.ok(stats.note, "must explain the eviction rather than silently losing data");
});

process.stdout.write(`\n${passed} passed, ${failed} failed\n\n`);
process.exit(failed ? 1 : 0);
