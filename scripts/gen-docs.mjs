// ─── Tool reference generator ────────────────────────────────────────────────
// 48 of 60 tools were undocumented, because the docs were hand-written and the
// tool surface kept moving. Generating the reference from the registry means it
// cannot drift; test/validate.mjs fails if the committed file is out of date.
//
//   npm run docs        regenerate docs/TOOLS.md, the plugin skill and GEMINI.md

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GROUPS = [
  ["Getting oriented", ["workflow_guide", "devcdp_settings", "devcdp_settings_init"],
    "Start here. `workflow_guide` explains the division of labour and the traps; the settings tools show what configuration is in effect and where it came from."],
  ["Connecting", ["devtools_connect", "devtools_status", "devcdp_triage", "devtools_disconnect", "list_tabs", "sessions_list"],
    "Attaching to a tab claims it, so no other DevCDP session can drive it. `sessions_list` shows who holds what when a tab is unavailable."],
  ["Page control", ["page_navigate", "page_reload", "page_interrupt"],
    "`page_reload` is often the first thing to reach for: console and network capture start at attach, so a reload replays the page with DevCDP watching. `page_interrupt` is the only thing that frees a page whose main thread is blocked."],
  ["Console", ["console_get_logs", "console_evaluate", "runtime_evaluate_many", "console_clear"],
    "Chrome does not replay console history to a debugger that attaches later, so anything logged before attach is gone — reproduce it, or reload."],
  ["Network", ["network_get_requests", "network_wait_for_request", "network_get_response_body", "network_clear"],
    "Response bodies are opt-in because they are large, and Chrome discards them on navigation — read them while the page is still on the same document."],
  ["DOM", ["dom_query", "dom_list_frames", "dom_get_html", "dom_get_mutations", "dialog_detect"],
    "If a selector finds nothing, the content is often in an iframe: `dom_list_frames` will show it and `frame:'all'` will search it. Dialog detection is structural, so it works regardless of UI framework."],
  ["Driving the page", ["ui_inspect", "ui_click", "ui_fill", "ui_type", "ui_select", "ui_check",
    "ui_press", "ui_hover", "ui_scroll", "ui_drag", "ui_upload", "ui_wait_for", "page_screenshot"],
    "Every action waits until the element is genuinely actionable — rendered, enabled, no longer moving, and not "
    + "covered — then dispatches trusted input, and reports what it caused: requests fired, console errors, whether "
    + "the DOM changed at all. When an action cannot proceed it names the condition that failed and what was in the "
    + "way, which is the difference between a fixable report and \"click failed\". Start with `ui_inspect` when a "
    + "selector does not match: it lists the controls actually on screen and the target to use for each. Prefer "
    + "`ui_wait_for` over sleeping."],
  ["Sources", ["source_list_scripts", "source_search", "source_get_script", "source_list_files", "source_get_file"],
    "`source_search` is the fastest route from a symptom to a line number when you do not know the file. Original pre-bundling files are recovered from source maps where they exist, and clearly labelled when they do not."],
  ["Debugger", ["debugger_set_breakpoint", "debugger_set_breakpoint_at_function",
    "debugger_list_breakpoints", "debugger_remove_breakpoint",
    "debugger_remove_all_breakpoints", "debugger_pause", "debugger_resume", "debugger_step_over",
    "debugger_step_into", "debugger_step_out", "debugger_get_state", "debugger_get_scope",
    "debugger_evaluate_at_frame", "debugger_get_capture"],
    "Breakpoints capture and then resume themselves by default, so the page is never left frozen and the action that tripped them can finish. Always check `bound` in the reply: an unbound breakpoint never fires."],
  ["Understanding an unfamiliar app", ["app_discover", "api_discover", "docs_outline", "docs_search"],
    "Nothing about any particular application is built in. The page is asked what it is, the API surface comes from real traffic plus OpenAPI discovery, and vocabulary comes from the project's own documentation."],
  ["Working with a human", ["notify_user", "session_ask_user", "session_poll_user_action", "session_get_user_actions"],
    "The user can step in at any time and it is recorded whether or not you asked. `notify_user` is the only channel they actually see."],
  ["Session bookkeeping", ["session_start", "session_step_done", "session_step_failed", "session_get_status",
    "session_get_activity", "session_get_state", "session_end"],
    "Optional. Useful for multi-step reproductions; a single question does not need it."],
  ["Learned memory", ["memory_get", "memory_record", "memory_import_legacy"],
    "Record what fixed a problem so a later session skips the dead end. Set `sharedMemoryDir` to pool entries across a team."],
];

function argLine(name, spec) {
  const bits = [`\`${name}\``, `*${spec.type}*`];
  if (spec.required) bits.push("**required**");
  else if ("default" in spec) bits.push(`default \`${JSON.stringify(spec.default)}\``);
  if (spec.enum) bits.push(`one of ${spec.enum.map(e => `\`${e}\``).join(", ")}`);
  return `  - ${bits.join(" · ")} — ${spec.description}`;
}

export async function generate() {
  const { createServer } = await import("../src/server.js");
  createServer();
  const { allTools, annotationsFor } = await import("../src/core/tools.js");
  const tools = new Map(allTools().map(t => [t.name, t]));

  const grouped = new Set(GROUPS.flatMap(([, names]) => names));
  const ungrouped = [...tools.keys()].filter(n => !grouped.has(n));

  const out = [];
  out.push("# DevCDP tool reference");
  out.push("");
  out.push("**Generated from the tool registry — do not edit by hand.** Run `npm run docs` after changing a tool.");
  out.push("");
  out.push(`${tools.size} tools. Every one is callable by name over MCP; the arguments below are exactly what the`);
  out.push("server validates, with the defaults it applies.");
  out.push("");
  out.push("## Contents");
  out.push("");
  for (const [title] of GROUPS) out.push(`- [${title}](#${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")})`);
  if (ungrouped.length) out.push("- [Other](#other)");
  out.push("");

  const section = (title, names, blurb) => {
    out.push(`## ${title}`);
    out.push("");
    if (blurb) { out.push(blurb); out.push(""); }
    for (const name of names) {
      const t = tools.get(name);
      if (!t) continue;
      out.push(`### \`${name}\``);
      out.push("");
      out.push(t.description);
      out.push("");
      const args = Object.entries(t.args || {});
      if (args.length) {
        out.push("Arguments:");
        out.push("");
        for (const [argName, spec] of args) out.push(argLine(argName, spec));
        out.push("");
      } else {
        out.push("*No arguments.*");
        out.push("");
      }
      const a = annotationsFor(t);
      const notes = [];
      notes.push(a.readOnlyHint ? "Read-only" : a.destructiveHint ? "Changes page or app state" : "Changes only DevCDP state");
      if (!t.needsClient) notes.push("works without an attached tab");
      out.push(`*${notes.join("; ")}.*`);
      out.push("");
    }
  };

  for (const [title, names, blurb] of GROUPS) section(title, names, blurb);
  if (ungrouped.length) section("Other", ungrouped, null);

  out.push("---");
  out.push("");
  out.push("Each tool also carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),");
  out.push("which is what the notes above are generated from. A client may run read-only tools without asking and");
  out.push("should confirm the ones that change page or app state.");
  out.push("");
  out.push("Every failure comes back as `{ok: false, code, message, hint}`; the `hint` names the next action.");
  out.push("Common codes: `NOT_CONNECTED`, `TARGET_CLAIMED`, `TARGET_GONE`, `PAGE_UNRESPONSIVE`, `BREAKPOINT_UNBOUND`,");
  out.push("`SOURCEMAP_MISSING`, `TIMEOUT`, `BAD_ARGS`.");
  out.push("");

  return { text: out.join("\n"), count: tools.size, ungrouped };
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

export const SKILL_FRONTMATTER = `---
name: devcdp
description: How to debug a running web app with the DevCDP tools - connect to a tab, reload to capture, drive the page with the ui_* tools, set breakpoints that bind, and hand off to the user. Use whenever DevCDP tools are available and the task involves a web page, the browser, console or network output, or a front-end bug.
---

`;

/** Gemini CLI reads GEMINI.md as the extension's context file: the same guidance, no frontmatter. */
export function generateGeminiContext() {
  return fs.readFileSync(path.join(ROOT, "initialize", "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
}

/** The Claude Code plugin skill is the installer's guidance with frontmatter on top. */
export function generateSkill() {
  const guide = fs.readFileSync(path.join(ROOT, "initialize", "AGENTS.md"), "utf8").replace(/\r\n/g, "\n");
  return SKILL_FRONTMATTER + guide;
}

if (invokedDirectly) {
  const skillTarget = path.join(ROOT, "plugins", "devcdp", "skills", "devcdp", "SKILL.md");
  fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
  fs.writeFileSync(skillTarget, generateSkill(), "utf8");
  console.log("wrote plugins/devcdp/skills/devcdp/SKILL.md");
  fs.writeFileSync(path.join(ROOT, "GEMINI.md"), generateGeminiContext(), "utf8");
  console.log("wrote GEMINI.md");

  const { text, count, ungrouped } = await generate();
  const target = path.join(ROOT, "docs", "TOOLS.md");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text, "utf8");
  console.log(`wrote docs/TOOLS.md — ${count} tools`);
  if (ungrouped.length) console.log(`  (ungrouped, listed under "Other": ${ungrouped.join(", ")})`);
  process.exit(0);
}
