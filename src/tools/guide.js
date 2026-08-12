// ─── Workflow guide ──────────────────────────────────────────────────────────
// v4's guide named specific tools belonging to a separate automation server —
// several of which did not exist (APP-2). Naming another server's tools means
// going stale the moment that server ships a release, and sending the model to
// call things that are not there.
//
// So this describes *roles* and DevCDP's own tools only. Whatever automation tool
// the host happens to expose, the model can already see it in its own tool list.

import { defineTool } from "../core/tools.js";
import { listTools } from "../core/tools.js";

defineTool({
  name: "workflow_guide",
  description:
    "How to use DevCDP effectively: the observe/act division of labour, the fastest path from a bug report to an exact "
    + "line, and the traps worth knowing. Call it once at the start of a debugging session.",
  needsClient: false,
  async handler(_args, ctx) {
    return {
      principle: "DevCDP observes and drives the debugger. It does not click — use your host's automation tool for that.",

      fastPath: [
        "devtools_connect",
        "source_search('<function or message>') to locate the code",
        "debugger_set_breakpoint(url, line) — check bound:true",
        "trigger the action",
        "debugger_get_capture — scope, console and network in one call",
        "report the observed value and line, not a hypothesis",
      ],

      traps: [
        "Console and network start at attach. For anything earlier: page_reload, or reproduce it.",
        "An unbound breakpoint never fires — check bound in the reply.",
        "A capture stays readable after resume; check live before treating it as current.",
        "Selector found nothing? The content may be in an iframe: dom_query(frame:'all').",
        "Page stopped answering? Its main thread is blocked — page_interrupt, not reload.",
      ],

      whenStuck: [
        "memory_get('<what failed>') — a previous session may have solved this already",
        "session_ask_user(instruction) — shows the request on the page with a confirmation button",
        "session_get_user_actions() — read what the user did, whether or not you asked",
        "memory_record(...) after any human-assisted recovery, so it is not needed twice",
      ],

      workingWithTheUser: [
        "The user may act at any time; it is recorded whether or not you asked. Read it with session_get_user_actions.",
        "For a step you cannot do, session_ask_user shows the request on the page with a confirmation button.",
        "Ctrl+Shift+D lets the user take control and starts capturing the values they type.",
        "After they help: session_get_state to see what changed, then memory_record.",
      ],

      understandingAnUnfamiliarApp: [
        "app_discover — frameworks, routing, buttons, fields, grids, tabs, with working selectors",
        "api_discover — the backend surface from real traffic, plus an OpenAPI spec if published",
        "docs_outline / docs_search — the project's own documentation for domain vocabulary",
      ],

      multiSession: "Each session claims its own tab. sessions_list shows who holds what; "
        + "devtools_connect(browser:'new') gives you a separate browser.",

      etiquette: [
        "notify_user before anything slow — the only channel the human sees.",
        "devtools_disconnect when done: resumes the page, clears breakpoints, releases the tab.",
      ],

      toolCount: listTools().length,
    };
  },
});
