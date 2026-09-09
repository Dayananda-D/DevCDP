// ─── Speak MCP to the server, as a client does ────────────────────────────────
// scripts/call.mjs bypasses the protocol and calls handlers directly, which is the
// fast loop. This is the other view: the real wire, so you can see exactly what
// the assistant sees — the handshake, the tool list, and a call's raw JSON-RPC.
//
//   node scripts/mcp-probe.mjs                       handshake + tool list summary
//   node scripts/mcp-probe.mjs workflow_guide        also call one tool
//   node scripts/mcp-probe.mjs list_tabs '{"port":9222}'
//
// Use it when a tool works via call.mjs but not through your assistant: the
// difference is always in this layer.

import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [toolName, argsJson] = process.argv.slice(2);

const child = spawn("node", [path.join(ROOT, "index.js")], { stdio: ["pipe", "pipe", "pipe"] });
const send = m => child.stdin.write(JSON.stringify(m) + "\n");
const replies = new Map();
let buf = "";

child.stdout.on("data", d => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try { const m = JSON.parse(line); if (m.id != null) replies.set(m.id, m); } catch (_) {}
  }
});
child.stderr.on("data", d => process.stdout.write("  [server] " + d.toString().trimEnd() + "\n"));

const wait = (id, ms = 20000) => new Promise((resolve, reject) => {
  const deadline = Date.now() + ms;
  const t = setInterval(() => {
    if (replies.has(id)) { clearInterval(t); resolve(replies.get(id)); }
    else if (Date.now() > deadline) { clearInterval(t); reject(new Error(`no reply to id ${id}`)); }
  }, 30);
});

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mcp-probe", version: "1" } } });
  const init = await wait(1);
  console.log("\ninitialize");
  console.log("  server:      ", JSON.stringify(init.result.serverInfo));
  console.log("  protocol:    ", init.result.protocolVersion);
  console.log("  capabilities:", Object.keys(init.result.capabilities).join(", "));

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const list = await wait(2);
  const bytes = Buffer.byteLength(JSON.stringify(list.result), "utf8");
  console.log(`\ntools/list`);
  console.log(`  ${list.result.tools.length} tools · ${bytes} bytes · ~${Math.round(bytes / 3.6)} tokens`);
  const noDesc = list.result.tools.filter(t => !t.description);
  if (noDesc.length) console.log(`  WARNING: ${noDesc.length} without a description: ${noDesc.map(t => t.name).join(", ")}`);

  if (toolName) {
    let args = {};
    if (argsJson) args = JSON.parse(argsJson);
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: toolName, arguments: args } });
    const res = await wait(3, 60000);
    const text = res.result?.content?.[0]?.text ?? "";
    console.log(`\ntools/call ${toolName}`);
    console.log(`  isError: ${res.result?.isError === true}`);
    console.log(`  ${Buffer.byteLength(text, "utf8")} bytes · ~${Math.round(Buffer.byteLength(text, "utf8") / 3.6)} tokens\n`);
    console.log(text);
  }
  console.log("");
} catch (e) {
  console.error("\nprobe failed:", e.message, "\n");
  process.exitCode = 1;
} finally {
  child.kill();
}
