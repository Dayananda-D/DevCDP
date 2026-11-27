// ─── Shared context ──────────────────────────────────────────────────────────
// One object threaded into every tool handler. v4 kept this as ~15 module-level
// `let`s, which is why reconnects lost breakpoints (CONN-2) and a stale pause
// could be reported as live (DBG-5). State that must survive a reconnect is
// marked `desired` — it is the contract the connection layer replays on attach.

import os from "os";
import crypto from "crypto";
import { ConsoleStore, NetworkStore, RingBuffer } from "./buffers.js";
import { SessionRegistry } from "../cdp/registry.js";
import { loadConfig } from "./config.js";
import { SessionCoordinator } from "./coordinator.js";

export function createContext(overrides = {}) {
  const cfg = loadConfig(overrides);

  const sessionId = process.env.DEVCDP_SESSION_ID
    || `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;

  const ctx = {
    cfg,
    sessionId,
    startedAt: new Date().toISOString(),
    caller: {
      name: overrides.callerName || "",
      id: overrides.callerId || "",
      topic: overrides.callerTopic || "",
    },

    registry: new SessionRegistry(sessionId),
    coordinator: new SessionCoordinator({ maxAgents: cfg.maxAgentsPerSession }),

    // ── live connection, owned by src/cdp/connection.js ──
    conn: null,

    // ── observation buffers ──
    console:   new ConsoleStore(cfg.consoleBufferSize),
    network:   new NetworkStore(cfg.networkBufferSize),
    mutations: new RingBuffer(cfg.mutationBufferSize),
    activity:  new RingBuffer(cfg.activityBufferSize),
    // What the human did, kept separately from the general timeline so the model
    // can read it with a cursor whether or not it ever asked for help.
    userActions: new RingBuffer(200),

    // ── frames & execution contexts (DOM-1: v4 only ever saw the main frame) ──
    contexts: new Map(),     // executionContextId → { id, origin, name, frameId, isDefault }

    // ── scripts & source maps ──
    scripts:    new Map(),   // scriptId → { scriptId, url, sourceMapURL, hasSourceMap }
    sourceMaps: new Map(),   // sourceMapURL → { raw, sources, sourcesContent, mappings? }

    /**
     * Desired debugger state — replayed verbatim after any reconnect (CONN-2).
     * key → { url|urlRegex, line, column, condition, breakpointId, bound, locations }
     */
    desired: {
      breakpoints: new Map(),
    },

    // ── pause state (DBG-5: every capture is stamped and can go stale) ──
    pause: {
      id: 0,
      active: false,
      callFrames: null,
      reason: null,
      capture: null,
    },

    // ── manual-fallback session ──
    session: {
      active: false,
      goal: null,
      steps: [],
      currentStepIdx: -1,
      pendingAsk: null,     // { instruction, waitFor, captured, askedAt }
      userHasControl: false,
      expectation: null,
      topic: null,
      tools: [],
      sessionName: null,
      sessionId: null,
    },

    // ── network waiters (event driven) ──
    waiters: [],

    // ── discovery cache ──
    discovered: {
      app: null,     // framework, routing, globals
      api: null,     // endpoint map
      docs: null,    // README/docs digest
    },
  };

  /**
   * Append to the activity timeline.
   *
   * `type` is the category and is authoritative — it is applied LAST. Spreading
   * the payload afterwards let an event's own `type` field clobber it: a user's
   * click was filed as "click" rather than "user_interaction", so the category
   * documented on session_get_activity matched nothing and spontaneous user help
   * was invisible. The event's own kind is preserved as `action`.
   */
  ctx.recordActivity = (type, data = {}) => {
    const { type: action, ...rest } = data;
    return ctx.activity.push({
      ...rest,
      ...(action && action !== type ? { action } : {}),
      ts: new Date().toISOString(),
      type,
    });
  };

  ctx.consoleBuf = () => ctx.console.for(ctx.conn?.targetId);

  // Only intentional session copy is sent to the browser panel. In particular,
  // never pass tool arguments, selectors, URLs, timings, or raw activity here.
  ctx.sessionPanel = () => {
    const s = ctx.session;
    const steps = (s.steps || []).map(step => ({
      id: step.id,
      description: step.description,
      actor: step.actor,
      status: step.status,
      result: step.result || null,
    }));
    const done = steps.filter(step => step.status === "done").length;
    return {
      sessionId: ctx.sessionId,
      sessionNumber: ctx.registry.sessionNumber || null,
      clientName: s.sessionName || ctx.caller.name || "MCP client",
      clientId: s.sessionId || ctx.caller.id || ctx.sessionId,
      topic: s.topic || ctx.caller.topic || ctx.caller.name || "MCP debugging session",
      goal: s.goal || null,
      expectation: s.pendingAsk?.instruction || s.expectation || null,
      status: s.pendingAsk ? "ask" : (steps.some(step => step.status === "blocked") ? "err"
        : (!s.active && steps.length && done === steps.length ? "done" : "working")),
      steps,
      tools: (s.tools || []).map(name => ({ name, status: "used" })),
    };
  };

  return ctx;
}
