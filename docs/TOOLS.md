# DevCDP tool reference

**Generated from the tool registry — do not edit by hand.** Run `npm run docs` after changing a tool.

73 tools. Every one is callable by name over MCP; the arguments below are exactly what the
server validates, with the defaults it applies.

## Contents

- [Getting oriented](#getting-oriented)
- [Connecting](#connecting)
- [Page control](#page-control)
- [Console](#console)
- [Network](#network)
- [DOM](#dom)
- [Driving the page](#driving-the-page)
- [Sources](#sources)
- [Debugger](#debugger)
- [Understanding an unfamiliar app](#understanding-an-unfamiliar-app)
- [Working with a human](#working-with-a-human)
- [Session bookkeeping](#session-bookkeeping)
- [Learned memory](#learned-memory)

## Getting oriented

Start here. `workflow_guide` explains the division of labour and the traps; the settings tools show what configuration is in effect and where it came from.

### `workflow_guide`

How to use DevCDP effectively: the observe/act division of labour, the fastest path from a bug report to an exact line, and the traps worth knowing. Call it once at the start of a debugging session.

*No arguments.*

*Works without an attached tab.*

### `devcdp_settings`

Show every DevCDP setting: its effective value, where that value came from (default, which settings file, or which environment variable), which files were searched and loaded, and any that failed to parse or were not recognised. Use it before changing configuration, and to check a change actually took effect.

Arguments:

  - `group` · *string* · default `"all"` · one of `connection`, `browser`, `indicator`, `toasts`, `tabs`, `debugger`, `liveness`, `budget`, `privacy`, `knowledge`, `app`, `buffers`, `all` — Only one group of settings.
  - `changed_only` · *boolean* · default `false` — Only settings that are not at their default.

*Works without an attached tab.*

### `devcdp_settings_init`

Write a settings file containing every option with its current value and an explanation, so it can be edited by hand. Refuses to overwrite an existing file unless you say so.

Arguments:

  - `path` · *string* — Where to write it. Defaults to devcdp.settings.json in the install directory.
  - `overwrite` · *boolean* · default `false` — Replace the file if it already exists.

*Works without an attached tab.*

## Connecting

Attaching to a tab claims it, so no other DevCDP session can drive it. `sessions_list` shows who holds what when a tab is unavailable.

### `devtools_connect`

Attach to a Chrome tab over the DevTools Protocol and start observing it (console, network, DOM, debugger). Claims the tab so no other DevCDP session can drive it, marks it visibly in the browser, and reports what was loaded before we attached. Call this once at the start of a debugging session.

Arguments:

  - `host` · *string* · default `"localhost"` — Chrome host.
  - `port` · *number* · default `9222` — Chrome remote-debugging port.
  - `target` · *string* · default `"visible"` — 'visible' (the tab on screen) | 'url-match:<substring>' | 'index:<n>' from list_tabs | 'new' | a URL substring.
  - `browser` · *string* · default `"existing"` · one of `existing`, `new` — 'new' launches a separate isolated Chrome on the next free port — a browser no other session has touched.
  - `allow_new_tab` · *boolean* · default `true` — If every tab is already claimed by another session, open a new one instead of failing.
  - `window` · *string* · default `"current"` · one of `current`, `new` — 'new' gives this session its own browser window — the fallback when Chrome tab groups are unavailable.

*Works without an attached tab.*

### `devtools_status`

Connection health and buffer accounting: which tab is attached, how many console/network/script entries are held, whether the debugger is paused, and whether anything has been evicted from the buffers.

*No arguments.*

*Works without an attached tab.*

### `devtools_disconnect`

Detach cleanly: resume the page if it is paused at a breakpoint, remove every breakpoint we set, remove the in-page badge, and release the tab claim so another session can use it. Always call this when you are done.

*No arguments.*

*Works without an attached tab.*

### `list_tabs`

List the debuggable tabs in Chrome with their index, title, URL, whether each is the visible one, and which DevCDP session (if any) currently owns it. Use the index with target:'index:<n>' in devtools_connect.

Arguments:

  - `host` · *string* · default `"localhost"` — Chrome host.
  - `port` · *number* · default `9222` — Chrome remote-debugging port.
  - `probe` · *boolean* · default `true` — Check which tab is really visible (one extra round trip).

*Works without an attached tab.*

### `sessions_list`

Show every DevCDP session currently running on this machine and the tabs each one holds. Use it to understand why a tab is unavailable, or to confirm two agents are not fighting over the same page.

*No arguments.*

*Works without an attached tab.*

## Page control

`page_reload` is often the first thing to reach for: console and network capture start at attach, so a reload replays the page with DevCDP watching. `page_interrupt` is the only thing that frees a page whose main thread is blocked.

### `page_navigate`

Navigate the attached tab to a URL. Returns as soon as the navigation is committed, not when loading finishes — wait for a specific request with network_wait_for_request, or for text with Playwright, before asserting.

Arguments:

  - `url` · *string* · **required** — Absolute URL to open.

### `page_reload`

Reload the attached tab. Useful right after attaching, because console history and network traffic from before the attach cannot be recovered — a reload replays everything with DevCDP watching.

Arguments:

  - `bypass_cache` · *boolean* · default `false` — Ignore the HTTP cache (hard reload).

### `page_interrupt`

Abort the JavaScript the page is currently running. Use it when a tool reports PAGE_UNRESPONSIVE — an infinite loop or a long synchronous task has blocked the main thread. This is the only thing that frees it: reloading and navigating do not, because the blocked thread never processes them. The page keeps its DOM and state; only the in-flight script is killed.

*No arguments.*

## Console

Chrome does not replay console history to a debugger that attaches later, so anything logged before attach is gone — reproduce it, or reload.

### `console_get_logs`

Read console output captured since attach: logs, warnings, uncaught exceptions with file, line and stack. Pass cursor=nextCursor from a previous call to get only what is new. Note that Chrome does not replay messages logged before DevCDP attached — reproduce the action or call page_reload to see those.

Arguments:

  - `level` · *string* · default `"all"` · one of `all`, `log`, `info`, `warn`, `warning`, `error`, `debug` — Only this level.
  - `cursor` · *number* · default `0` — Return only entries with seq greater than this. 0 for everything held.
  - `since` · *string* — ISO timestamp lower bound.
  - `limit` · *number* · default `30` — Maximum entries to return (most recent first in the buffer order).
  - `include_agent` · *boolean* · default `false` — Include DevCDP's own diagnostics, normally hidden so they cannot be mistaken for app errors.
  - `clear` · *boolean* · default `false` — Empty the buffer after reading.

### `console_evaluate`

Run a JavaScript expression in the page and return its value. On failure returns the full exception detail (message, 1-based line and column, URL, stack). Use it to read app state; use debugger_evaluate_at_frame instead when you are paused and need a local variable.

Arguments:

  - `expression` · *string* · **required** — JavaScript to evaluate in the page's main frame.
  - `await_promise` · *boolean* · default `false` — Await the result if the expression returns a promise.
  - `timeout_ms` · *number* · default `10000` — Abandon the evaluation after this long.

### `runtime_evaluate_many`

Evaluate several named expressions in one round trip and get a map of name to result. Use it to sample a lot of app state at once instead of paying a round trip per question. Individual failures are reported per entry rather than aborting the batch.

Arguments:

  - `expressions` · *array* · **required** — Array of { name, expression } objects.
  - `await_promise` · *boolean* · default `false` — Await promise results.

### `console_clear`

Empty the console buffer so that what you read next belongs only to the action you are about to take. Does not touch the browser's own console display.

*No arguments.*

## Network

Response bodies are opt-in because they are large, and Chrome discards them on navigation — read them while the page is still on the same document.

### `network_get_requests`

List HTTP requests captured since attach, with method, status, duration, size and initiator. Filter by URL substring, method, status or failures only. Response bodies are opt-in via include_bodies because they are large. Capture starts when DevCDP attaches, so requests from before that are not here — reload to see them.

Arguments:

  - `url_filter` · *string* — Only requests whose URL contains this substring.
  - `method` · *string* — Only this HTTP method, e.g. POST.
  - `status` · *number* — Only this exact response status.
  - `min_status` · *number* — Only responses with status >= this, e.g. 400 for problems.
  - `failed_only` · *boolean* · default `false` — Only network failures and 4xx/5xx responses.
  - `limit` · *number* · default `20` — Maximum requests to return.
  - `offset` · *number* · default `0` — Skip this many of the newest matches, for paging back in time.
  - `include_headers` · *boolean* · default `false` — Include request and response headers.
  - `include_bodies` · *boolean* · default `false` — Include response bodies, subject to max_body_bytes.
  - `include_post_data` · *boolean* · default `false` — Include request payloads.
  - `max_body_bytes` · *number* · default `2048` — Per-body byte cap when include_bodies is set.

### `network_wait_for_request`

Block until a request whose URL contains url_filter completes, then return it. Event driven, so there is no polling. Call this immediately AFTER triggering the action, or pass a filter that has not fired yet — a request that already completed is returned straight away. Gives up after timeout_ms and tells you so.

Arguments:

  - `url_filter` · *string* · **required** — Substring the request URL must contain.
  - `method` · *string* — Also require this HTTP method.
  - `timeout_ms` · *number* · default `15000` — Give up after this long.
  - `allow_existing` · *boolean* · default `true` — Satisfy immediately from an already-completed matching request.

### `network_get_response_body`

Fetch the full response body for one requestId from network_get_requests. Chrome discards bodies when the page navigates, so read them while the page is still on the same document.

Arguments:

  - `request_id` · *string* — The requestId field from a network_get_requests row.
  - `requestId` · *string* — Deprecated spelling of request_id; both work.
  - `max_body_bytes` · *number* · default `0` — Byte cap; 0 means no limit.

### `network_clear`

Empty the network buffer so the next thing you read belongs only to the action you are about to take. Does not affect the browser's own Network panel.

*No arguments.*

## DOM

If a selector finds nothing, the content is often in an iframe: `dom_list_frames` will show it and `frame:'all'` will search it. Dialog detection is structural, so it works regardless of UI framework.

### `dom_query`

Query elements by CSS selector and return tag, id, classes, text, attributes, geometry and real visibility. Ask for computed styles by naming the properties you want. Set frame:'all' to search inside iframes too — single-page apps often render the screen you care about in a child frame.

Arguments:

  - `selector` · *string* · **required** — CSS selector.
  - `limit` · *number* · default `10` — Maximum elements to return.
  - `fields` · *array* — Restrict the returned keys, e.g. ['tag','id','text','visible'].
  - `styles` · *array* — Computed style properties to read, e.g. ['display','zIndex','color'].
  - `visible_only` · *boolean* · default `false` — Drop elements that are not actually rendered.
  - `include_attrs` · *boolean* · default `false` — Include every HTML attribute of each match. Off by default: attributes dominate the response on real apps.
  - `include_html` · *boolean* · default `false` — Include a truncated outerHTML for each match.
  - `frame` · *string* · default `"main"` — 'main' (default), 'all', or a substring of a frame's origin/name.

### `dom_list_frames`

List the frames and JavaScript execution contexts in the attached tab. Use it when a selector finds nothing — the content may live in an iframe, which needs frame:'all' on dom_query.

*No arguments.*

### `dom_get_html`

Get the inner or outer HTML of the first element matching a selector, truncated to a byte budget. Useful for understanding structure you cannot infer from dom_query alone.

Arguments:

  - `selector` · *string* · **required** — CSS selector.
  - `inner` · *boolean* · default `false` — innerHTML instead of outerHTML.
  - `max_bytes` · *number* · default `4000` — Truncate beyond this many characters.
  - `frame` · *string* · default `"main"` — 'main' (default), or a substring of a frame's origin/name.

### `dom_get_mutations`

DOM changes recorded since the last call — what was added, removed or re-attributed, and where. Use it after an action to see whether the app re-rendered at all, which distinguishes 'handler never ran' from 'handler ran and produced nothing'.

Arguments:

  - `limit` · *number* · default `30` — Maximum records to return.
  - `clear` · *boolean* · default `true` — Drain the buffer as you read it.

### `dialog_detect`

Detect modal dialogs, alerts and confirmation overlays that are visible right now, with their title, message and button labels. Detection is structural — ARIA roles, the dialog element, and stacked-overlay geometry — so it works regardless of which UI framework drew it. Call it after any action that might raise a prompt.

Arguments:

  - `frame` · *string* · default `"all"` — 'main' (default) or 'all' to include iframes.

## Driving the page

Every action waits until the element is genuinely actionable — rendered, enabled, no longer moving, and not covered — then dispatches trusted input, and reports what it caused: requests fired, console errors, whether the DOM changed at all. When an action cannot proceed it names the condition that failed and what was in the way, which is the difference between a fixable report and "click failed". Start with `ui_inspect` when a selector does not match: it lists the controls actually on screen and the target to use for each. Prefer `ui_wait_for` over sleeping.

### `ui_inspect`

List what can be interacted with on the current screen — buttons, links, inputs, selects and anything with an interactive ARIA role — with the target you would use to reach each one. Use it when a selector fails and you need to see what is really there. Far cheaper than dumping the DOM, and it names elements the way these tools expect them to be named.

Arguments:

  - `limit` · *number* · default `40` — Maximum controls to return.
  - `filter` · *string* — Only controls whose text, id or name contains this.
  - `kind` · *string* · default `"all"` · one of `all`, `buttons`, `inputs`, `links`, `selects` — Restrict to one family of control.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name.

### `ui_click`

Click an element, identified by CSS selector, visible text or test id. Waits until it is actually clickable — rendered, enabled, stopped moving, and not covered by anything — then dispatches real (trusted) mouse events, and reports what the click caused: requests fired, console errors, whether the DOM changed at all. If it never became clickable it says which of those conditions failed and what was in the way.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `button` · *string* · default `"left"` · one of `left`, `right`, `middle` — Which mouse button.
  - `click_count` · *number* · default `1` — 2 for a double-click.
  - `modifiers` · *array* — Held while clicking: shift, ctrl, alt, meta.
  - `force` · *boolean* · default `false` — Skip the hit-test and click the centre regardless of what is on top. A last resort — it is how you click the wrong thing.

### `ui_fill`

Set the value of a text field, textarea or contenteditable in one step, and fire the input and change events the application listens for. Fast, because it does not type character by character — use ui_type instead when the field reacts to each keystroke, such as a typeahead or an autocomplete.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `value` · *string* · **required** — The text to put in the field. Pass an empty string to clear it.
  - `submit` · *boolean* · default `false` — Press Enter afterwards.

### `ui_type`

Type into a field one character at a time, with real key events for each. Slower than ui_fill and necessary exactly when the field reacts per keystroke — search-as-you-type, autocomplete, input masks, and fields that reformat while you type. If ui_fill left the field looking right but the application unaware, use this.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `text_to_type` · *string* · **required** — Characters to type.
  - `clear_first` · *boolean* · default `true` — Select all and delete before typing.
  - `delay_ms` · *number* · default `12` — Pause between keystrokes. Raise it if the field drops characters.
  - `submit` · *boolean* · default `false` — Press Enter afterwards.

### `ui_select`

Choose an option in a dropdown, by visible label or by value. Handles a native <select> directly; for the custom dropdowns most applications actually use — a div that opens a list — it opens the control and clicks the matching option. Reports the options it could see when nothing matches, which is usually the whole answer.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `option` · *string* · **required** — The option's visible label, or its value attribute.
  - `by` · *string* · default `"either"` · one of `label`, `value`, `either` — Match the label, the value, or either.

### `ui_check`

Set a checkbox or radio to a specific state, rather than toggling it blindly. Reads the current state first and clicks only if it differs, so calling it twice does not undo the first call — the usual way a 'toggle' helper leaves a form in the wrong state.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `checked` · *boolean* · default `true` — The state you want.

### `ui_press`

Press a key — Enter to submit, Tab to move on, Escape to dismiss, arrows to move through a list or grid. Optionally focuses an element first. This is the tool for keyboard-driven screens, where clicking the control is not how the application expects to be used.

Arguments:

  - `key` · *string* · **required** — Key name: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, Home, End, PageUp, PageDown, Space.
  - `selector` · *string* — CSS selector. Descends into open shadow roots. Optional: focuses this element first.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input. Optional: focuses this element first.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting). Optional: focuses this element first.
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `modifiers` · *array* — Held while pressing: shift, ctrl, alt, meta.
  - `times` · *number* · default `1` — Press it this many times.

### `ui_hover`

Move the pointer over an element and leave it there. Use before clicking anything that only appears on hover — dropdown menus, row action buttons, tooltips — because those elements do not exist to click until something is hovering over their parent.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.

### `ui_scroll`

Scroll the page, or scroll a specific container. Needed before interacting with anything in a virtualised list or grid, where rows outside the viewport do not exist in the DOM at all — scrolling is what creates them.

Arguments:

  - `selector` · *string* — CSS selector of the container to scroll. Omit to scroll the page.
  - `text` · *string* — Visible text inside the container to scroll.
  - `testid` · *string* — Test id of the container to scroll.
  - `dx` · *number* · default `0` — Horizontal pixels; positive is right.
  - `dy` · *number* · default `400` — Vertical pixels; positive is down.
  - `to` · *string* · default `"none"` · one of `top`, `bottom`, `none` — Jump instead of scrolling by an amount.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the container.

### `ui_drag`

Drag one element onto another — reordering rows, moving a card between columns, resizing a split. Dispatches a real press, several intermediate moves and a release, because drag implementations almost always ignore a press followed immediately by a release somewhere else.

Arguments:

  - `selector` · *string* — CSS selector for what to drag.
  - `text` · *string* — Visible text of what to drag.
  - `testid` · *string* — Test id of what to drag.
  - `to_selector` · *string* — CSS selector for where to drop it.
  - `to_text` · *string* — Visible text of where to drop it.
  - `to_testid` · *string* — Test id of where to drop it.
  - `steps` · *number* · default `10` — Intermediate move events. More is slower but survives pickier drag handlers.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name.
  - `timeout_ms` · *number* · default `5000` — How long to wait for either element to become actionable.

### `ui_upload`

Attach one or more local files to a file input, without opening the operating system's file picker — which automation cannot drive at all. Give the absolute paths of files on the machine running Chrome.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `files` · *array* · **required** — Absolute paths to the files to attach.

### `ui_wait_for`

Block until the page reaches a state: an element appears, disappears, becomes enabled, or some text shows up. This is the honest alternative to guessing a sleep — it returns as soon as the condition holds, and when it does not, it says what the page looked like instead of just timing out.

Arguments:

  - `selector` · *string* — CSS selector. Descends into open shadow roots.
  - `text` · *string* — Visible text on the control. Matches the innermost element that carries it, and follows a <label> to its input.
  - `testid` · *string* — Value of a test attribute (data-testid and friends — see the testAttributes setting).
  - `role` · *string* — Narrow the matches to this ARIA role.
  - `exact` · *boolean* · default `false` — Require the whole text to match rather than a substring.
  - `nth` · *number* · default `0` — Which match to use when several qualify, 0-based.
  - `frame` · *string* · default `"main"` — 'main' (default) or a substring of a frame's origin/name. Single-page apps often render the screen you want in a child frame.
  - `timeout_ms` · *number* · default `5000` — How long to wait for the element to become actionable before giving up.
  - `state` · *string* · default `"visible"` · one of `visible`, `hidden`, `enabled`, `detached`, `stable` — What to wait for: 'visible' (default), 'hidden', 'enabled', 'detached', or 'stable' (present and no longer moving).
  - `contains_text` · *string* — Also require the element to contain this text.

## Sources

`source_search` is the fastest route from a symptom to a line number when you do not know the file. Original pre-bundling files are recovered from source maps where they exist, and clearly labelled when they do not.

### `source_list_scripts`

List the JavaScript files loaded in the page, with size and whether each has a source map. This is indexed the moment DevCDP attaches, so it works on a page that was already open. Filter by URL substring to find the file you need before setting a breakpoint.

Arguments:

  - `filter` · *string* — Only scripts whose URL contains this substring.
  - `with_source_maps` · *boolean* · default `false` — Only scripts that carry a source map.
  - `limit` · *number* · default `100` — Maximum scripts to return.

### `source_search`

Search the text of every loaded script — and every original file recoverable from source maps — for a string or regular expression. This is the fastest way to locate a handler when you know a function name, a message or a field name but not the file. Returns file, 1-based line and the matching line.

Arguments:

  - `query` · *string* · **required** — Text or regular expression to find.
  - `regex` · *boolean* · default `false` — Treat query as a regular expression.
  - `ignore_case` · *boolean* · default `true` — Case-insensitive search.
  - `url_filter` · *string* — Only search scripts whose URL contains this.
  - `include_original_sources` · *boolean* · default `true` — Also search original files from source maps.
  - `max_results` · *number* · default `40` — Stop after this many matches.
  - `context_chars` · *number* · default `200` — Characters of the matching line to return.

### `source_get_script`

Read the source Chrome actually loaded, by scriptId or URL substring, optionally a line range. Lines come back numbered so the numbers you quote to a breakpoint are the numbers you saw.

Arguments:

  - `script_id` · *string* — scriptId from source_list_scripts.
  - `url` · *string* — URL substring identifying the script.
  - `start_line` · *number* — First line to return (1-based).
  - `end_line` · *number* — Last line to return (1-based).

### `source_list_files`

List the original source files recoverable from the page's source maps — the pre-bundling file tree. Use it to discover real file paths before calling source_get_file or setting a breakpoint on an original file.

Arguments:

  - `filter` · *string* — Only paths containing this substring.
  - `limit` · *number* · default `200` — Maximum paths to return.

### `source_get_file`

Read an original pre-bundling source file via the page's source maps. Falls back to the loaded script when no map is available, and always tells you which of the two you got, so a bundle line is never mistaken for an original one.

Arguments:

  - `path` · *string* · **required** — Original file path or a suffix of it, e.g. 'components/SaveButton.tsx'.
  - `start_line` · *number* — First line to return (1-based).
  - `end_line` · *number* — Last line to return (1-based).

## Debugger

Breakpoints capture and then resume themselves by default, so the page is never left frozen and the action that tripped them can finish. Always check `bound` in the reply: an unbound breakpoint never fires.

### `debugger_set_breakpoint`

Set a breakpoint and report honestly whether Chrome could bind it. Accepts either a loaded script URL (a substring is resolved to the exact script) or an original pre-bundling file path, which is translated through the source map. Set auto_resume:true when the action is being driven by an automation tool, so the page does not stay frozen and time that action out.

Arguments:

  - `url` · *string* · **required** — Script URL, URL substring, or original source path.
  - `line` · *number* · **required** — 1-based line number, as shown by source_get_script / source_get_file.
  - `column` · *number* — 1-based column, when several statements share a line.
  - `condition` · *string* — JavaScript condition — pause only when it is truthy, e.g. 'id === 42'.
  - `auto_resume` · *boolean* · default `true` — Default true: capture scope/console/network on hit, then resume, so the page is never left frozen and the action that tripped it completes. Pass false to hold the pause for stepping; released after maxPauseMs regardless.

### `debugger_set_breakpoint_at_function`

Set a breakpoint on a function you can name, without knowing which file it lives in. Give any expression that evaluates to a function — 'app.saveOrder', 'MyClass.prototype.load', a framework helper — and DevCDP finds its definition and breaks at its first statement. Use this when you know what runs but not where it is defined; use debugger_set_breakpoint when you already have a file and line.

Arguments:

  - `function_expression` · *string* · **required** — JavaScript evaluating to the function itself — no call parentheses. For example 'app.store.save', not 'app.store.save()'.
  - `condition` · *string* — JavaScript condition — pause only when it is truthy, e.g. 'id === 42'.
  - `auto_resume` · *boolean* · default `true` — Default true: capture scope/console/network on hit, then resume, so the page is never left frozen and the action that tripped it completes. Pass false to hold the pause for stepping; released after maxPauseMs regardless.

### `debugger_list_breakpoints`

List the breakpoints DevCDP has set, including whether each is actually bound to executable code. An unbound breakpoint will never fire — check here first when a breakpoint 'is not hitting'.

*No arguments.*

*Works without an attached tab.*

### `debugger_remove_breakpoint`

Remove one breakpoint by its breakpointId. Use debugger_remove_all_breakpoints to clear them in one call.

Arguments:

  - `breakpoint_id` · *string* · **required** — breakpointId from debugger_set_breakpoint.

### `debugger_remove_all_breakpoints`

Remove every breakpoint DevCDP set, and resume the page if it is currently paused. Call this before handing the browser back to a human, so they do not find a frozen app.

*No arguments.*

### `debugger_pause`

Pause JavaScript execution at the next statement the page runs, and hold it so you can inspect and step. The page is frozen while held, so DevCDP releases it automatically after maxPauseMs if you have not resumed — no human ever has to press resume in Chrome.

*No arguments.*

### `debugger_resume`

Resume execution and drop any hold. Breakpoints resume themselves by default, so this is only needed after an explicit pause, after stepping, or after a breakpoint set with auto_resume:false.

*No arguments.*

### `debugger_step_over`

Step over from the current pause and stop at the next statement. Stepping implies you want the pause held, so it will not auto-resume between steps — but it is still released automatically after maxPauseMs if you stop. The new location and scope are available from debugger_get_state and debugger_get_scope once it settles.

*No arguments.*

### `debugger_step_into`

Step into from the current pause and stop at the next statement. Stepping implies you want the pause held, so it will not auto-resume between steps — but it is still released automatically after maxPauseMs if you stop. The new location and scope are available from debugger_get_state and debugger_get_scope once it settles.

*No arguments.*

### `debugger_step_out`

Step out from the current pause and stop at the next statement. Stepping implies you want the pause held, so it will not auto-resume between steps — but it is still released automatically after maxPauseMs if you stop. The new location and scope are available from debugger_get_state and debugger_get_scope once it settles.

*No arguments.*

### `debugger_get_state`

Where execution is paused right now: the reason, and the full call stack with function names and 1-based file positions. Returns paused:false when the page is running.

*No arguments.*

*Works without an attached tab.*

### `debugger_get_scope`

Read the variables in scope at a paused call frame, with objects and arrays expanded rather than printed as 'Object'. Includes `this`. Anything omitted for size is explicitly marked, so you never have to guess whether you saw the whole value.

Arguments:

  - `frame_index` · *number* · default `0` — 0 is the innermost frame; see debugger_get_state for the stack.
  - `depth` · *number* · default `3` — How many levels of nested objects to expand. 3 covers object → array → record.
  - `max_properties` · *number* · default `30` — Maximum properties per object.
  - `include_global` · *boolean* · default `false` — Include the global scope (thousands of properties).

### `debugger_evaluate_at_frame`

Evaluate an expression in the scope of a paused call frame, so local variables and closures are in scope. This is how you confirm a hypothesis with a real value rather than inferring one.

Arguments:

  - `expression` · *string* · **required** — JavaScript evaluated in the frame's scope.
  - `frame_index` · *number* · default `0` — Which frame; 0 is innermost.
  - `depth` · *number* · default `2` — How deep to expand an object result.

### `debugger_get_capture`

Everything captured automatically at the last breakpoint hit — scope for the top frames, recent console output and recent network requests — in one call instead of four. Tells you whether the pause is still current or has already resumed, so a stale snapshot is never mistaken for live state.

*No arguments.*

*Works without an attached tab.*

## Understanding an unfamiliar app

Nothing about any particular application is built in. The page is asked what it is, the API surface comes from real traffic plus OpenAPI discovery, and vocabulary comes from the project's own documentation.

### `app_discover`

Ask the running page what it is: which UI libraries it uses, how it routes, how many frames it has, and its actual interactive surface — visible buttons, fields, grids and tabs with working selectors. Call this once before driving an unfamiliar app, instead of guessing selectors.

*No arguments.*

### `api_discover`

Build a map of the backend the page actually talks to: endpoints grouped with ids collapsed, call counts, status codes, timings and failures — plus an OpenAPI/Swagger specification if the server publishes one at a standard path. Use it to understand the API surface, and to see at a glance which calls are failing.

Arguments:

  - `probe_openapi` · *boolean* · default `true` — Also try standard OpenAPI discovery paths on the page's origin.
  - `include_static` · *boolean* · default `false` — Include scripts, styles, images and fonts, not just data calls.

### `docs_outline`

List the documentation available under the docs root, with each file's headings, so you can see what the project documents before searching. A good first call when you do not yet know the app's vocabulary.

Arguments:

  - `max_files` · *number* · default `40` — Maximum files to describe.
  - `root` · *string* — Override the docs root for this call.

*Works without an attached tab.*

### `docs_search`

Search the project's own documentation — README and any markdown/text/pdf docs under the configured docs root — and return matching passages with file and line. Use it to learn what a screen, field or business term means in this app, instead of inferring it from the UI. Set docsRoot in your settings file if the docs live elsewhere.

Arguments:

  - `query` · *string* · **required** — Words or a phrase to look for.
  - `max_results` · *number* · default `12` — Maximum passages to return.
  - `context_lines` · *number* · default `4` — Lines of surrounding context per hit.
  - `root` · *string* — Override the docs root for this call.

*Works without an attached tab.*

## Working with a human

The user can step in at any time and it is recorded whether or not you asked. `notify_user` is the only channel they actually see.

### `notify_user`

Show a short status line to the human, in the badge on the page you are debugging. This is the only channel the user actually sees — call it before a slow or surprising step so a frozen-looking app is explained. Keep it to a few words.

Arguments:

  - `action` · *string* · **required** · one of `navigate`, `click`, `fill`, `debug`, `network`, `dom`, `evaluate`, `breakpoint`, `found`, `waiting`, `done`, `error` — What you are doing.
  - `detail` · *string* · **required** — Short human-readable detail, e.g. 'checking the save handler'.

### `session_ask_user`

Ask the human to do something in the browser, and show the request in the on-page badge with a confirmation button. Returns immediately — poll session_poll_user_action for the outcome. Also relay the instruction in your reply, so it is visible whether or not they are looking at the browser window.

Arguments:

  - `instruction` · *string* · **required** — Exactly what the person should do, in one sentence.
  - `wait_for` · *string* · default `"confirmation"` · one of `confirmation`, `navigation`, `click`, `dialog`, `any_action` — What counts as done. 'confirmation' — the on-page button — is the only unambiguous one.

### `session_poll_user_action`

Check whether the human has completed what session_ask_user requested. Returns acted:false while waiting. Poll at a human pace — a few seconds apart — rather than in a tight loop.

*No arguments.*

*Works without an attached tab.*

### `session_get_user_actions`

What the human has done in the browser — clicks, typed values, chosen options, submissions — and the element each one touched. Works whether or not you asked, so unprompted help is still readable. Pass the cursor back for only what is new. Values are captured during a handover or takeover; sensitive fields stay redacted.

Arguments:

  - `cursor` · *number* · default `0` — Only actions newer than this seq. 0 for everything retained.
  - `limit` · *number* · default `30` — Maximum actions to return.
  - `kinds` · *array* — Restrict to these kinds, e.g. ['click','input_change','option_chosen'].

*Works without an attached tab.*

## Session bookkeeping

Optional. Useful for multi-step reproductions; a single question does not need it.

### `session_start`

Open a debugging session with a goal and an ordered list of steps, so progress is tracked and a failed step can fall back to asking the human. Use it for multi-step reproductions; a single-question investigation does not need it.

Arguments:

  - `goal` · *string* · **required** — What you are trying to find out or prove.
  - `steps` · *array* · **required** — Ordered steps, each { id, description, actor }. actor is 'agent', 'user' or 'either'.

### `session_step_done`

Mark the current step complete with what you found, and advance. Returns the next step, or allDone when the plan is finished.

Arguments:

  - `result` · *string* — What this step established — a real observed value, not a guess.

*Works without an attached tab.*

### `session_step_failed`

Report that you cannot complete the current step yourself. Checks memory for a known recovery first, then tells you how to hand over to the human. Use it for anything automation genuinely cannot do — a login you have no credentials for, a challenge, a physical device.

Arguments:

  - `reason` · *string* · **required** — Why the step could not be completed.

*Works without an attached tab.*

### `session_get_status`

Where the session plan stands: the goal, each step's status, which step is current, and whether a human handover is outstanding.

*No arguments.*

*Works without an attached tab.*

### `session_get_activity`

Unified timeline of everything observed in this session — console output, requests, navigations, dialogs, clicks, pauses and handovers, in order. Use it to reconstruct what happened when a step behaved unexpectedly.

Arguments:

  - `types` · *array* — Restrict to these activity types.
  - `since` · *string* — ISO timestamp lower bound.
  - `limit` · *number* · default `30` — Maximum entries.

*Works without an attached tab.*

### `session_get_state`

One snapshot of console output, network requests and DOM mutations together, instead of three separate calls. Pass the cursors back on the next call to get only what is new. This is the cheapest way to see the effect of an action.

Arguments:

  - `log_cursor` · *number* · default `0` — Only console entries newer than this seq.
  - `log_limit` · *number* · default `20` — Maximum console entries.
  - `net_limit` · *number* · default `15` — Maximum network requests.
  - `net_filter` · *string* — Only requests whose URL contains this.
  - `mut_limit` · *number* · default `20` — Maximum DOM mutation records.
  - `errors_only` · *boolean* · default `false` — Restrict console to warnings and errors, and network to failures.

### `session_end`

Close the session and return a summary. Does not detach — call devtools_disconnect to release the tab and clear breakpoints when you are finished with the browser entirely.

*No arguments.*

*Works without an attached tab.*

## Learned memory

Record what fixed a problem so a later session skips the dead end. Set `sharedMemoryDir` to pool entries across a team.

### `memory_get`

Look up what previous sessions learned about this app — failures and the recovery that worked. Returns short summaries so it is cheap to call at the start of a session; pass full:true or an id to read one in detail. Search it whenever a step fails, before asking the user for help.

Arguments:

  - `query` · *string* — Words to match against category, failure, recovery, pattern or URL. Omit for the most recent.
  - `id` · *string* — Return this single entry in full.
  - `category` · *string* · one of `navigation`, `click`, `fill`, `auth`, `debug`, `network`, `selector`, `dialog`, `timing`, `other` — Restrict to one category.
  - `limit` · *number* · default `12` — Maximum entries to return.
  - `full` · *boolean* · default `false` — Return complete entries instead of summaries.

*Works without an attached tab.*

### `memory_record`

Record a failure and the recovery that worked, so a later session can skip the dead end. Call it after any user-assisted recovery or non-obvious workaround. All four fields are required and validated — a vague entry is worse than none, because it costs context on every future lookup.

Arguments:

  - `category` · *string* · **required** · one of `navigation`, `click`, `fill`, `auth`, `debug`, `network`, `selector`, `dialog`, `timing`, `other` — What kind of problem this was.
  - `failure` · *string* · **required** — What went wrong, concretely. e.g. 'Clicking Save did nothing because the form was still validating.'
  - `recovery` · *string* · **required** — What actually resolved it, as steps someone could repeat.
  - `pattern` · *string* · **required** — The reusable rule for next time. e.g. 'Wait for the validation spinner to clear before clicking Save.'
  - `url_pattern` · *string* — URL substring this applies to, so it can be matched to a page later.
  - `shared` · *boolean* · default `false` — Write to the shared team store instead of local, if one is configured.

*Works without an attached tab.*

### `memory_import_legacy`

One-off import of a v4 Markdown memory file into the current store, skipping the malformed entries v4's missing validation produced. Run once after upgrading, then delete the old file.

Arguments:

  - `path` · *string* · **required** — Full path to the old memorymanagement.md.

*Works without an attached tab.*

---

Every failure comes back as `{ok: false, code, message, hint}`; the `hint` names the next action.
Common codes: `NOT_CONNECTED`, `TARGET_CLAIMED`, `TARGET_GONE`, `PAGE_UNRESPONSIVE`, `BREAKPOINT_UNBOUND`,
`SOURCEMAP_MISSING`, `TIMEOUT`, `BAD_ARGS`.
