// ─── Multi-agent session coordination tools ──────────────────────────────────
import { defineTool } from "../core/tools.js";

defineTool({
  name: "session_agent_register",
  coordination: true,
  destructive: false, idempotent: true,
  description: "Register an agent identity in this DevCDP session so concurrent callers can be attributed, queued, and audited safely.",
  needsClient: false,
  args: {
    agent_id: { type: "string", description: "Stable identity for the agent, unique within this DevCDP session.", required: true },
    label: { type: "string", description: "Human-readable agent label.", default: "" },
  },
  async handler(args, ctx) {
    return { registered: true, agent: ctx.coordinator.register(args.agent_id, args.label || args.agent_id) };
  },
});

defineTool({
  name: "session_agent_unregister",
  coordination: true,
  destructive: false, idempotent: true,
  description: "Remove an idle agent identity from this DevCDP session; active agents and held leases cannot be removed.",
  needsClient: false,
  args: { agent_id: { type: "string", description: "Agent identity to remove.", required: true } },
  async handler(args, ctx) { return { unregistered: ctx.coordinator.unregister(args.agent_id), agentId: args.agent_id }; },
});

defineTool({
  name: "session_agent_acquire_lease",
  coordination: true,
  destructive: false, idempotent: true,
  description: "Acquire the exclusive action lease required before a non-default agent drives, navigates, debugs, or changes the attached page.",
  needsClient: false,
  args: {
    agent_id: { type: "string", description: "Agent identity acquiring the lease.", required: true },
    label: { type: "string", description: "Optional human-readable label.", default: "" },
    ttl_ms: { type: "number", description: "Lease lifetime; it is bounded to 1 second through 10 minutes.", default: 30000, min: 1000, max: 600000 },
  },
  async handler(args, ctx) { return { acquired: true, lease: ctx.coordinator.acquireLease(args.agent_id, args.label, { ttlMs: args.ttl_ms }) }; },
});

defineTool({
  name: "session_agent_release_lease",
  coordination: true,
  destructive: false, idempotent: true,
  description: "Release an agent's exclusive session action lease so the next queued mutating agent can proceed.",
  needsClient: false,
  args: {
    agent_id: { type: "string", description: "Agent identity releasing the lease.", required: true },
    lease_id: { type: "string", description: "Lease token returned by session_agent_acquire_lease." },
  },
  async handler(args, ctx) { return ctx.coordinator.releaseLease(args.agent_id, args.lease_id); },
});

defineTool({
  name: "session_agent_status",
  coordination: true,
  readOnly: true,
  description: "Show registered agents, active readers, the exclusive writer, action lease ownership, queued calls, and running calls in this DevCDP session.",
  needsClient: false,
  args: {},
  async handler(_args, ctx) { return ctx.coordinator.status(); },
});

defineTool({
  name: "session_agent_cancel",
  coordination: true,
  destructive: false, idempotent: true,
  description: "Cancel an agent's queued call before it touches Chrome; a running CDP call is reported but is not forcefully interrupted by this safe coordinator operation.",
  needsClient: false,
  args: {
    request_id: { type: "string", description: "Request identifier supplied on the call to cancel.", required: true },
    agent_id: { type: "string", description: "Agent identity that owns the request.", required: true },
  },
  async handler(args, ctx) { return ctx.coordinator.cancel(args.request_id, args.agent_id); },
});
