// ─── Session-level multi-agent coordinator ───────────────────────────────────
// One DevCDP process owns one mutable browser context. This coordinator makes
// that ownership explicit: readers may overlap, mutations are exclusive, and
// distinct agents must hold an action lease before driving the page.
import crypto from "crypto";
import { CODES, fail } from "./errors.js";

const DEFAULT_AGENT = "default";
const id = prefix => `${prefix}-${crypto.randomBytes(5).toString("hex")}`;

export class SessionCoordinator {
  constructor({ maxAgents = 32 } = {}) {
    this.maxAgents = maxAgents;
    this.agents = new Map();
    this.leases = new Map();
    this.jobs = new Map();
    this.completed = new Map();
    this.waiters = [];
    this.activeReaders = 0;
    this.activeWriter = null;
    this.sequence = 0;
    this.register(DEFAULT_AGENT, "Default session agent");
  }

  register(agentId = DEFAULT_AGENT, label = agentId) {
    const normalized = String(agentId || DEFAULT_AGENT).trim();
    if (!/^[A-Za-z0-9._:-]{1,80}$/.test(normalized)) {
      fail(CODES.BAD_ARGS, `Invalid agent_id "${agentId}".`, "Use 1–80 letters, numbers, dots, underscores, colons or hyphens.");
    }
    const existing = this.agents.get(normalized);
    if (existing) {
      existing.lastSeenAt = new Date().toISOString();
      if (label) existing.label = String(label).slice(0, 120);
      return existing;
    }
    if (this.agents.size >= this.maxAgents) {
      fail(CODES.SESSION_CONTENTION, `This session already has ${this.maxAgents} registered agents.`, "Unregister an idle agent, then retry.");
    }
    const agent = {
      id: normalized,
      label: String(label || normalized).slice(0, 120),
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      calls: 0,
    };
    this.agents.set(normalized, agent);
    return agent;
  }

  touch(agentId, label) {
    return this.register(agentId, label);
  }

  unregister(agentId) {
    const agent = String(agentId || DEFAULT_AGENT);
    if (agent === DEFAULT_AGENT) return false;
    if (this.leases.has(agent) || [...this.jobs.values()].some(j => j.agentId === agent && j.state === "running")) {
      fail(CODES.SESSION_CONTENTION, `Agent "${agent}" is still active.`, "Release its lease and wait for its running call before unregistering it.");
    }
    return this.agents.delete(agent);
  }

  acquireLease(agentId = DEFAULT_AGENT, label, { ttlMs = 30_000 } = {}) {
    const agent = this.touch(agentId, label);
    const held = [...this.leases.values()][0];
    if (held && held.agentId !== agent.id) {
      fail(CODES.SESSION_CONTENTION,
        `Session action lease is held by agent "${held.agentId}".`,
        "Wait for it to release the lease, or ask that agent to finish its action.",
        { owner: held.agentId, leaseId: held.leaseId, expiresAt: held.expiresAt });
    }
    if (held) {
      held.expiresAt = new Date(Date.now() + Math.max(1000, Math.min(ttlMs, 10 * 60_000))).toISOString();
      return held;
    }
    const lease = {
      leaseId: id("lease"), agentId: agent.id,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + Math.max(1000, Math.min(ttlMs, 10 * 60_000))).toISOString(),
    };
    this.leases.set(agent.id, lease);
    return lease;
  }

  releaseLease(agentId = DEFAULT_AGENT, leaseId = null) {
    const agent = String(agentId || DEFAULT_AGENT);
    const lease = this.leases.get(agent);
    if (!lease) return { released: false };
    if (leaseId && lease.leaseId !== leaseId) {
      fail(CODES.SESSION_CONTENTION, "The lease_id does not belong to this agent.", "Read session_agent_status and pass the current lease_id.");
    }
    this.leases.delete(agent);
    this.pump();
    return { released: true, leaseId: lease.leaseId };
  }

  leaseFor(agentId) {
    const lease = this.leases.get(String(agentId || DEFAULT_AGENT));
    if (lease && Date.parse(lease.expiresAt) <= Date.now()) {
      this.leases.delete(lease.agentId);
      this.pump();
      return null;
    }
    return lease || null;
  }

  status() {
    return {
      agents: [...this.agents.values()].map(a => ({ ...a, lease: this.leaseFor(a.id) })),
      activeReaders: this.activeReaders,
      activeWriter: this.activeWriter,
      queued: this.waiters.filter(w => !w.cancelled).map(w => ({
        requestId: w.requestId, tool: w.toolName, agentId: w.agentId, mode: w.mode, queuedAt: w.queuedAt,
      })),
      running: [...this.jobs.values()].filter(j => j.state === "running").map(j => ({ ...j })),
    };
  }

  cancel(requestId, agentId = DEFAULT_AGENT) {
    const job = this.jobs.get(String(requestId));
    if (!job) return { cancelled: false, requestId, note: "No queued or running call has this request_id." };
    if (job.agentId !== String(agentId || DEFAULT_AGENT)) {
      fail(CODES.SESSION_CONTENTION, `Request ${requestId} belongs to another agent.`, "Only the owning agent can cancel its request.");
    }
    if (job.state === "queued") {
      job.cancelled = true;
      job.state = "cancelled";
      const waiterIndex = this.waiters.findIndex(w => w.requestId === job.requestId);
      if (waiterIndex >= 0) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter.reject(new Error(`Request ${job.requestId} was cancelled before execution.`));
      }
      this.pump();
      return { cancelled: true, requestId, state: "cancelled" };
    }
    job.cancelRequested = true;
    return { cancelled: false, requestId, state: "running", note: "Cancellation requested; the active CDP call cannot be interrupted safely by the coordinator." };
  }

  async run({ agentId = DEFAULT_AGENT, label, requestId = id("call"), toolName, readOnly = false, leaseId = null, requiresLease = true, fingerprint = null }, fn) {
    const agent = this.touch(agentId, label);
    // Registration, lease management, status, and cancellation must remain
    // available while a writer is active; in particular, cancellation cannot
    // itself wait behind the call it is meant to cancel.
    if (!requiresLease) return fn({ agentId: agent.id, requestId: String(requestId), cancelRequested: () => false });
    const key = String(requestId);
    const prior = this.completed.get(key);
    if (prior) {
      if (prior.agentId !== agent.id) {
        fail(CODES.SESSION_CONTENTION, `Request ${key} belongs to another agent.`, "Use a request_id owned by this agent.");
      }
      if (prior.fingerprint !== fingerprint) {
        fail(CODES.BAD_ARGS, `Request ${key} was already used with different arguments.`, "Use a new request_id for a different call.");
      }
      return prior.result;
    }
    const duplicate = this.jobs.get(key);
    if (duplicate) {
      fail(CODES.SESSION_CONTENTION, `Request ${key} is already running.`, "Use a new request_id unless you are retrying the same completed call.", { requestId: key, state: duplicate.state });
    }
    const mode = readOnly ? "read" : "write";
    if (requiresLease && !readOnly && agent.id !== DEFAULT_AGENT) {
      const lease = this.leaseFor(agent.id);
      if (!lease || (leaseId && lease.leaseId !== leaseId)) {
        fail(CODES.SESSION_CONTENTION,
          `Agent "${agent.id}" must hold the session action lease before calling ${toolName}.`,
          "Call session_agent_acquire_lease first, then pass its lease_id with the action.",
          { agentId: agent.id, tool: toolName });
      }
    }
    const job = { requestId: key, agentId: agent.id, toolName, mode, state: "queued", queuedAt: new Date().toISOString(), sequence: ++this.sequence };
    this.jobs.set(job.requestId, job);
    try {
      await this.acquire(mode, job);
    } catch (err) {
      this.jobs.delete(job.requestId);
      throw err;
    }
    if (job.cancelled) {
      this.jobs.delete(job.requestId);
      fail(CODES.BAD_ARGS, `Request ${job.requestId} was cancelled before execution.`, "Retry with a new request_id.");
    }
    job.state = "running";
    job.startedAt = new Date().toISOString();
    job.cancelRequested = false;
    try {
      agent.calls++;
      const result = await fn({ agentId: agent.id, requestId: job.requestId, cancelRequested: () => job.cancelRequested });
      this.completed.set(job.requestId, { agentId: agent.id, toolName, fingerprint, result, completedAt: new Date().toISOString() });
      while (this.completed.size > 256) this.completed.delete(this.completed.keys().next().value);
      return result;
    } finally {
      this.release(mode, job);
      job.state = "completed";
      job.finishedAt = new Date().toISOString();
      this.jobs.delete(job.requestId);
    }
  }

  acquire(mode, job) {
    if (mode === "read" && !this.activeWriter && !this.waiters.some(w => w.mode === "write" && !w.cancelled)) {
      this.activeReaders++;
      job.granted = true;
      return Promise.resolve();
    }
    if (mode === "write" && !this.activeWriter && this.activeReaders === 0 && !this.waiters.some(w => !w.cancelled && w.sequence < job.sequence)) {
      this.activeWriter = job;
      job.granted = true;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.waiters.push(Object.assign(job, { resolve, reject }));
    });
  }

  release(mode, job) {
    if (mode === "read") this.activeReaders = Math.max(0, this.activeReaders - 1);
    else if (this.activeWriter === job) this.activeWriter = null;
    this.pump();
  }

  pump() {
    this.waiters = this.waiters.filter(w => {
      if (w.cancelled) { w.reject(new Error("cancelled")); return false; }
      return true;
    });
    if (this.activeWriter || this.activeReaders) return;
    const first = this.waiters[0];
    if (!first) return;
    if (first.mode === "write") {
      this.waiters.shift(); this.activeWriter = first; first.granted = true; first.resolve(); return;
    }
    while (this.waiters[0]?.mode === "read") {
      const next = this.waiters.shift(); this.activeReaders++; next.granted = true; next.resolve();
    }
  }
}

export { DEFAULT_AGENT };
