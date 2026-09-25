import assert from "assert";
import { getTool, resolveArgs } from "../src/core/tools.js";
import "../src/tools/diagnose.js";

const tool = getTool("devcdp_triage");
assert.ok(tool, "devcdp_triage must be registered");

const ctx = {
  conn: {
    targetUrl: "https://example.test/",
    targetTitle: "Example",
    preAttach: { consoleHistoryAvailable: false },
    async eval() {
      return { result: { value: JSON.stringify({
        url: "https://example.test/",
        title: "Example",
        readyState: "complete",
      }) } };
    },
  },
  consoleBuf: () => ({
    all: () => [{ level: "error", text: "Save failed", url: "app.js", line: 42 }],
    stats: () => ({ count: 1 }),
  }),
  network: {
    all: () => [{ method: "POST", url: "https://example.test/api/save", status: 500 }],
    stats: () => ({ count: 1 }),
  },
  desired: { breakpoints: new Map() },
  pause: { active: false },
};

const args = resolveArgs(tool, {});
assert.equal(args.include_recent, true, "the compact path should include useful recent failures by default");
const result = await tool.handler(args, ctx);
assert.equal(result.health, "errors-observed");
assert.equal(result.pageResponsive, true);
assert.equal(result.recentConsoleErrors.length, 1);
assert.equal(result.recentFailedRequests.length, 1);
assert.equal(result.nextActions[0].tool, "console_get_logs");
assert.equal(result.nextActions[1].tool, "network_list_requests");
assert.match(result.note, /compact triage summary/);

const quiet = await tool.handler(resolveArgs(tool, { include_recent: false }), ctx);
assert.deepEqual(quiet.recentConsoleErrors, undefined);
assert.deepEqual(quiet.recentFailedRequests, undefined);
assert.equal(quiet.health, "errors-observed", "hiding detail must not hide the health signal");

console.log("diagnose tool checks passed");
