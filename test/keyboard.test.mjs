import assert from "assert";
import { getTool, resolveArgs } from "../src/core/tools.js";
import "../src/tools/interact.js";

const tool = getTool("ui_press");
assert.ok(tool, "ui_press must be registered");

const events = [];
const ctx = {
  cfg: { showCursor: false, testAttributes: ["data-testid"] },
  conn: {
    client: {
      Input: {
        async dispatchKeyEvent(event) { events.push(event); },
      },
    },
    setBadge() {},
    async eval() { return { result: { value: "{}" } }; },
  },
  consoleBuf: () => ({ stats: () => ({ cursor: 0 }), since: () => [] }),
  mutations: { stats: () => ({ cursor: 0 }), since: () => [] },
  network: { all: () => [] },
  recordActivity() {},
};

const args = resolveArgs(tool, { keycode: 65, code: "KeyA", times: 2 });
const result = await tool.handler(args, ctx);
assert.equal(result.pressed, "keycode:65");
assert.equal(result.keycode, 65);
assert.equal(events.length, 4, "two presses should emit down/up twice");
assert.equal(events[0].windowsVirtualKeyCode, 65);
assert.equal(events[0].nativeVirtualKeyCode, 65);
assert.equal(events[0].code, "KeyA");
assert.equal(events[0].key, "Unidentified");
assert.equal(events[0].type, "rawKeyDown");
assert.equal(events[1].type, "keyUp");

await assert.rejects(
  () => tool.handler(resolveArgs(tool, { keycode: 65.5 }), ctx),
  /Invalid keycode 65\.5/,
);
await assert.rejects(
  () => tool.handler(resolveArgs(tool, { key: "Enter", keycode: 65 }), ctx),
  /key and keycode disagree/,
);

console.log("keyboard keycode checks passed");
