import assert from "assert";
import { SessionCoordinator } from "../src/core/coordinator.js";

const c = new SessionCoordinator();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

await assert.rejects(
  () => c.run({ agentId: "worker-a", toolName: "ui_click", readOnly: false }, async () => "bad"),
  /must hold the session action lease/,
);
const lease = c.acquireLease("worker-a", "Worker A", { ttlMs: 5000 });
assert.ok(lease.leaseId);

let readerStarted = 0;
let readerFinished = 0;
const reader = agentId => c.run({ agentId, toolName: "dom_query", readOnly: true }, async () => {
  readerStarted++;
  await sleep(30);
  readerFinished++;
  return agentId;
});
const readers = await Promise.all([reader("worker-a"), reader("worker-b")]);
assert.deepEqual(readers.sort(), ["worker-a", "worker-b"]);
assert.equal(readerStarted, 2);
assert.equal(readerFinished, 2);

let releaseWriter;
const writerGate = new Promise(resolve => { releaseWriter = resolve; });
const writer = c.run({ agentId: "worker-a", leaseId: lease.leaseId, toolName: "ui_click", readOnly: false }, async () => {
  await writerGate;
  return "writer";
});
await sleep(5);
let readDone = false;
const blockedRead = reader("worker-b").then(value => { readDone = true; return value; });
await sleep(15);
assert.equal(readDone, false, "a reader must wait behind an active writer");
releaseWriter();
await writer;
await blockedRead;

const writer2 = c.run({ agentId: "worker-a", leaseId: lease.leaseId, requestId: "hold", toolName: "ui_fill", readOnly: false }, async () => {
  await sleep(50);
  return "hold";
});
await sleep(5);
const queued = c.run({ agentId: "worker-a", leaseId: lease.leaseId, requestId: "cancel-me", toolName: "ui_type", readOnly: false }, async () => "should-not-run");
await sleep(5);
const cancelled = c.cancel("cancel-me", "worker-a");
assert.equal(cancelled.cancelled, true);
await assert.rejects(queued, /cancelled before execution/);
await writer2;

const status = c.status();
assert.equal(status.activeReaders, 0);
assert.equal(status.activeWriter, null);
assert.equal(status.queued.length, 0);
assert.equal(c.releaseLease("worker-a", lease.leaseId).released, true);
let executions = 0;
const first = await c.run({ agentId: "worker-a", requestId: "idempotent-1", toolName: "ui_click", readOnly: true, fingerprint: "same" }, async () => {
  executions++;
  return { value: 42 };
});
const replay = await c.run({ agentId: "worker-a", requestId: "idempotent-1", toolName: "ui_click", readOnly: true, fingerprint: "same" }, async () => {
  executions++;
  return { value: 99 };
});
assert.deepEqual(replay, first);
assert.equal(executions, 1, "a completed request_id must not execute twice");
await assert.rejects(
  () => c.run({ agentId: "worker-b", requestId: "idempotent-1", toolName: "ui_click", readOnly: true }, async () => null),
  /belongs to another agent/,
);
await assert.rejects(
  () => c.run({ agentId: "worker-a", requestId: "idempotent-1", toolName: "ui_type", readOnly: true, fingerprint: "different" }, async () => null),
  /different arguments/,
);
console.log("coordinator concurrency checks passed");
