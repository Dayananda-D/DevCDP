---
name: devcdp
description: How to debug a running web app with the DevCDP tools - connect to a tab, reload to capture, drive the page with the ui_* tools, set breakpoints that bind, and hand off to the user. Use whenever DevCDP tools are available and the task involves a web page, the browser, console or network output, or a front-end bug.
---

## Debugging a web app with DevCDP

DevCDP is attached to a real Chrome tab over the DevTools Protocol. It can read the
page, drive it, and stop it mid-execution to show you live values.

**Start here**
- `devtools_connect` first — nothing else works until a tab is claimed.
- Console and network capture begin at attach, so anything logged *before attach* is
  gone for good — Chrome does not replay it. `page_reload` replays the page with
  DevCDP watching; do that before concluding nothing was logged.
- `workflow_guide` explains the division of labour; `ui_inspect` and `app_discover`
  describe the screen you are actually on.

**Driving the page — use the `ui_*` tools**
- `ui_click`, `ui_fill`, `ui_type`, `ui_select`, `ui_check`, `ui_press`, `ui_hover`,
  `ui_scroll`, `ui_drag`, `ui_upload`, `ui_wait_for`.
- They wait until the element is genuinely actionable — rendered, enabled, no longer
  moving, not covered — then dispatch trusted input. Each reports what it caused:
  requests fired, console errors, whether the DOM changed. A click and its
  consequences are one call, not three.
- Target by `selector`, by the `text` a person reads, or by `testid`. When a target
  does not match, `ui_inspect` lists the controls really on screen and the exact
  target to use for each.
- `ui_fill` sets the value in one step. `ui_type` sends a key per character and is the
  one to use for typeahead, autocomplete and masked fields — if `ui_fill` left the
  field looking right but the application unaware, switch to `ui_type`.
- Never sleep to wait for the UI. `ui_wait_for` returns the moment the condition holds,
  and says what the page looked like when it does not.
- When an action reports `nothingHappened`, the event was delivered and the
  application ignored it. That is a different problem from a wrong selector.

**Prefer these over a general browser-automation server** while DevCDP is attached.
That server drives its own separate browser, so it cannot see the tab you are
debugging — and it needs a full page snapshot before each action, which costs far more
context than naming the element. Reach for it only for what DevCDP does not do:
downloads, the operating system's file-chooser dialog, and tracing.

**Debugger**
- Always check `bound` in the reply to `debugger_set_breakpoint`. An unbound breakpoint
  is accepted by Chrome and never fires.
- Breakpoints capture and then resume by themselves, so the page is not left frozen.
- `debugger_get_capture` returns the frame, scope and values from the last pause.

**Sharing a machine with other sessions**
- One tab belongs to one session. If a tab is unavailable, `sessions_list` says who
  holds it; DevCDP opens its own window rather than sharing one.
- `devtools_disconnect` when finished, so the tab is released and the page left clean.

**Telling the user what is happening**
- Every tool call already announces itself on the page — "searching the source",
  "clicking Save order". What that cannot show is *why*, because your prose never
  reaches DevCDP; only your tool calls do.
- So `notify_user` is how you speak. Call it whenever you would have said something
  out loud: what you are about to try, what you just concluded, what surprised you.
  The person is watching their own application, not the transcript, and a running
  commentary is the difference between "it is working on it" and "it is stuck".
  Two or three words is enough — `notify_user(action:'debug', detail:'the save
  handler never fires')`.
- `session_ask_user` when a step needs a human — logging in, choosing a record.
