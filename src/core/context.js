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

  return ctx;
}
