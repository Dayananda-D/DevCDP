// ─── Call one tool from the command line ─────────────────────────────────────
// The fastest loop for working on DevCDP: no assistant, no MCP client, just the
// tool and the exact response a model would receive — plus what it costs.
//
//   node scripts/call.mjs list_tabs
//   node scripts/call.mjs dom_query '{"selector":"button","limit":3}'
//   node scripts/call.mjs source_search '{"query":"saveOrder"}' --port 9222
//   node scripts/call.mjs devtools_status --no-connect
//
// Attaches first unless the tool works without a page, or --no-connect is given.
// Add --raw to print the response with no framing, --quiet to hide server logs.

import path from "path";
import { fileURLToPath } from "url";
import { createContext } from "../src/core/context.js";
import { Connection } from "../src/cdp/connection.js";
import { MemoryStore } from "../src/store/memory.js";
import { getTool, resolveArgs, shape, capResponse, listTools } from "../src/core/tools.js";

import "../src/tools/guide.js";     import "../src/tools/connect.js";
import "../src/tools/console.js";   import "../src/tools/network.js";
import "../src/tools/dom.js";       import "../src/tools/sources.js";
import "../src/tools/debugger.js";  import "../src/tools/session.js";
import "../src/tools/memory.js";    import "../src/tools/discover.js";
import "../src/tools/settings.js";

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith("--")));
const positional = argv.filter(a => !a.startsWith("--"));
const [toolName, argsJson] = positional;

const portFlag = argv.find(a => a.startsWith("--port"));
const port = portFlag ? Number(portFlag.split("=")[1] || argv[argv.indexOf(portFlag) + 1]) : undefined;

if (flags.has("--quiet")) process.env.DEVCDP_LOG_LEVEL = "error";

if (!toolName || flags.has("--help")) {
  console.log("\nUsage: node scripts/call.mjs <tool> '<json args>' [--port N] [--no-connect] [--raw] [--quiet]\n");
  console.log("Tools:\n");
  const names = listTools().map(t => t.name).sort();
  for (let i = 0; i < names.length; i += 3) {
    console.log("  " + names.slice(i, i + 3).map(n => n.padEnd(30)).join(""));
  }
  console.log("\nSchema for one tool:  node scripts/call.mjs <tool> --help\n");
  process.exit(0);
}

const tool = getTool(toolName);
if (!tool) {
  console.error(`\nNo tool named "${toolName}". Run without arguments to list them.\n`);
  process.exit(1);
}

let args = {};
if (argsJson) {
  try { args = JSON.parse(argsJson); }
  catch (e) {
    console.error(`\nArguments must be JSON: ${e.message}`);
    console.error(`Got: ${argsJson}\n`);
    process.exit(1);
  }
}

const ctx = createContext(port ? { port } : {});
ctx.conn = new Connection(ctx);
ctx.memory = new MemoryStore(ctx.cfg);

const run = async (name, callArgs) => {
  const t = getTool(name);
  const resolved = resolveArgs(t, callArgs);
  if (t.needsClient) await ctx.conn.ensure();
  const started = Date.now();
  const out = capResponse(shape(t, await t.handler(resolved, ctx), resolved), ctx.cfg.maxResponseBytes, name);
  return { out, ms: Date.now() - started };
};

let exitCode = 0;
try {
  if (tool.needsClient && !flags.has("--no-connect")) {
    const { out, ms } = await run("devtools_connect", port ? { port } : {});
    if (!flags.has("--raw")) {
      console.log(`\nattached to ${out.url} (${ms}ms, ${out.selectedBy})`);
      if (out.openedNewTab) console.log(`  note: opened a tab — ${out.openedNewTab.because}`);
    }
  }

  const { out, ms } = await run(toolName, args);
  const text = JSON.stringify(out, null, 2);

  if (flags.has("--raw")) {
    console.log(text);
  } else {
    const bytes = Buffer.byteLength(text, "utf8");
    console.log(`\n── ${toolName} ── ${ms}ms · ${bytes} bytes · ~${Math.round(bytes / 3.6)} tokens\n`);
    console.log(text);
    console.log("");
  }
  if (out.ok === false) exitCode = 1;
} catch (e) {
  console.error(`\n${e.code || "ERROR"}: ${e.message}`);
  if (e.hint) console.error(`hint: ${e.hint}`);
  console.error("");
  exitCode = 1;
} finally {
  try { await ctx.conn.detach({ release: true, quiet: true }); } catch (_) {}
  try { ctx.registry.releaseAll(); } catch (_) {}
}
process.exit(exitCode);
