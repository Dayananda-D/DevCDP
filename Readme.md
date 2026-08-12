# DevCDP

Real Chrome DevTools access for an AI assistant, over MCP. Your assistant reads the
console, watches the network, queries the DOM, resolves source maps, sets
breakpoints and inspects live variables — so it can tell you *why* something broke
instead of guessing from a pasted error.

Works with any assistant that speaks MCP, and with any web app: nothing about a
particular framework, product or company is built in.

**60 tools** — see [docs/TOOLS.md](docs/TOOLS.md) for the full reference, generated
from the server itself, and [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for measured
token costs and how to lower them.

---

## What it does

| | |
|---|---|
| **Console** | Logs, warnings and uncaught exceptions with file, 1-based line and stack. |
| **Network** | Every request from the moment it attaches — method, status, timing, size, initiator, and response bodies on request. |
| **DOM** | Selector queries with real visibility and geometry, named computed styles, mutation history, iframe support, and structural dialog detection. |
| **Sources** | Loaded scripts, plus original pre-bundling files recovered from source maps — including external `.map` files behind authentication. Full-text search across both. |
| **Debugger** | Breakpoints on original files by original line, stepping, and scope inspection that expands nested objects instead of printing `Object`. |
| **Discovery** | Asks the app what it is: framework, routing, working selectors for its buttons and fields, its backend API surface, and your project's own docs. |
| **Collaboration** | You can take over at any time; what you click, choose and type is recorded and readable by the assistant. |

### Four things it is careful about

**It never fakes success.** A breakpoint that cannot bind says `bound: false` and
explains why. A body Chrome has discarded says so. A capture from a pause that has
already resumed is marked stale. Every failure is `{ok: false, code, message, hint}`
with the next action named.

**It tells you where its knowledge ends.** Chrome cannot replay console history to
a debugger that attaches later, so attaching reports exactly that rather than
presenting an empty buffer as "no errors".

**It cannot be stranded.** Every call into the page is bounded on *our* side —
`Runtime.evaluate`'s own timeout is enforced by the renderer, which is useless when
the renderer is what is stuck. A page wedged in an infinite loop fails in seconds
with the recovery path named, and DevCDP will abort the runaway script and retry by
itself.

**It never leaves your app frozen.** Breakpoints capture what you need and then
resume on their own. A pause held deliberately is still released after
`maxPauseMs`, and everything is cleaned up on disconnect.

---

## Setup

**Requirements:** Node 18+, Chrome, and an MCP-capable assistant.

```
1. node initialize_MCP.js      (or double-click initialize_MCP.bat)
2. Fully quit and reopen your assistant
3. Double-click debug-chrome.bat, open your app
4. Describe the bug
```

The wizard detects installed editors, writes the right config shape for each, and
drops a launcher. It **never** overwrites a config file it cannot parse — it prints
the snippet to paste instead — every write is atomic with one timestamped backup,
and duplicate registrations from older installs are removed. That path is covered
by 23 tests, because getting it wrong damages your machine rather than just failing.

---

## Settings

Everything is optional. Ask the assistant to run `devcdp_settings` to see the
effective values and where each came from, or `devcdp_settings_init` to write an
annotated file you can edit.

Files are merged, later winning, so an install-wide baseline can be overridden per
project:

```
<install>/devcdp.settings.json   or  <install>/settings.json
<cwd>/.devcdp/settings.json
<cwd>/devcdp.settings.json
```

then `DEVCDP_*` environment variables, then tool arguments. Comments and trailing
commas are tolerated.

| Setting | Default | |
|---|---|---|
| `toasts` | `true` | show live status messages |
| `toastMs` · `toastOpacity` · `toastMaxVisible` | `3500` · `0.78` · `3` | how long, how visible, how many |
| `badge` · `badgeCorner` · `edgePulse` | `true` · `"tc"` · `true` | the tab indicator and its breathing border |
| `badgeCorner` positions | `tc` · `bc` · `tl` · `tr` · `bl` · `br` | where the overlay parks. Drag the chip to move it anywhere; that position is remembered per origin. Messages travel with it, so `toastCorner` follows `badgeCorner` |
| `showCursor` · `highlightInspected` | `true` · `true` | show where interaction happens, and what was inspected |
| `ownerTimeoutMs` | `45000` | how long an indicator stays up without hearing from its session, before removing itself |
| `followNewTabs` | `true` | mark and hold tabs the app opens for itself, so a popup is never an unmarked blind spot |
| `chromeProfile` | `"isolated"` | or `"default"` to reuse your signed-in Chrome, or a path |
| `disableWebSecurity` | `false` | leave off: it hides the CORS bugs you would be debugging |
| `chromeFlags` | `[]` | extra Chrome flags |
| `evalTimeoutMs` · `toolTimeoutMs` | `8000` · `30000` | liveness ceilings |
| `autoResumeDefault` · `maxPauseMs` | `true` · `30000` | autonomous pause control |
| `captureInputValues` | `false` | always-on capture of typed values |
| `docsRoot` | auto | where to read your project's README and docs |
| `sharedMemoryDir` | `null` | pool learned fixes across a team |
| `tabGroupMode` | `"session"` | one tab group per session, or `"single"` for all |

`docsRoot` and `sharedMemoryDir` are the two worth setting: the first lets the
assistant learn your domain vocabulary, the second is what makes "the team's fixes
accumulate" actually true.

---

## Multiple sessions at once

Several agents can debug on one machine safely. Each session **claims** a tab in a
registry under `~/.devcdp/registry/`, taken atomically so two processes cannot win
the same tab. A session that dies stops heartbeating and its claim is reaped, so
nothing stays wedged.

- A new session gets an unclaimed tab; if all are taken it opens its own — **on the
  page you wanted**, not blank, and it says why.
- Reloading your assistant briefly overlaps two server processes, so a short grace
  period lets the departing one release its tab and the new one simply reattaches.
- `browser: 'new'` launches a separate Chrome, own port and profile.
- `window: 'new'` gives the session its own browser window.
- `sessions_list` shows which session holds which tab.

## Knowing which tab is in use

Every claimed tab carries a **1px edge border** and a small
identity chip. The border tells you who is driving:

- **breathing blue glow** — DevCDP is working
- **still, green** — it has handed control to you
- **still, red** — something failed

Three states, three colours, and each colour means exactly one thing regardless of how
many sessions are running. Sessions are told apart by the chip text and by their own
Chrome tab group — not by hue, which would turn the border into a puzzle when the only
thing worth knowing at a glance is whether the tab is waiting for you.

**Tabs the app opens for itself** — `window.open`, `target="_blank"`, a detail screen
in its own window — are marked and held too, labelled "opened tab". `devtools_status`
lists them under `tabsAppOpened`, with the call that switches to one.

**The indicator cannot outlive the session that drew it.** A normal finish — you close
the assistant, it disconnects, the session ends — removes the border immediately. If the
server is *killed* and never gets to clean up, the overlay notices it has stopped hearing
from its session and removes itself within `ownerTimeoutMs` (45s), taking the tab out of
its group with it. Either way, a border on screen means a session is genuinely there. For
one left behind by an older build, `node scripts/sweep.mjs` clears any that no live
session owns (`--dry` to look first).

Status messages appear as translucent, self-fading toasts. A ring follows pointer
activity and a ripple marks each click, so an agent's actions are followable. When
the debugger pauses, Chrome's own "Paused in debugger" banner appears — browser
UI, adding nothing to your page.

None of it can intercept a click: the whole layer is `pointer-events: none` except
the confirmation button during a handover, which is 91×24px. There is a test that
fires real mouse events through it.

**Real Chrome tab groups** are drawn by the bundled extension, which puts each session's
tabs in a titled blue group. Chrome will not let a tool install an extension for you —
branded Google Chrome ignores `--load-extension` ("not allowed in Google Chrome", from its
own log) and does not expose `Extensions.loadUnpacked` over the debugging port — so pick
one of:

- **No manual step:** point `chromePath` at Chromium or Chrome for Testing. Those builds
  allow the switch, so the extension loads itself and grouping just works. If such a
  binary is already on your machine, `devtools_status` tells you where it is.
- **Branded Chrome:** install it once — `chrome://extensions` → Developer mode → Load
  unpacked → select `extension/`. The debug profile is persistent and shared by
  `debug-chrome.bat` and DevCDP's own launcher, so once is once.

`devtools_status.tabGrouping` reports whether the tab is *actually* in a group, and when it
is not, whether that is because no extension is installed or because an installed one
failed — with the error. Nothing else depends on grouping: the border, the chip and
`window:'new'` all work without it.

---

## Working with the assistant

You do not have to wait to be asked. Click, type, choose — it is recorded, and the
assistant reads it with `session_get_user_actions`: which element, which option,
and the value you typed.

**Ctrl+Shift+D** in the tab hands control to you explicitly. That also opens the
window in which typed values are captured, so "use this reference" reaches the
assistant. Outside that window values stay private, and password-like fields are
redacted either way.

When the assistant needs something only you can do, it asks on the page and waits
for the **I've done it ✓** button. That button is the only unambiguous signal —
Chrome reports automation input as trusted too, so an action cannot be *proven*
human, and the tools say so rather than pretending.

---

## A typical investigation

```
"The save button does nothing. Find the exact line."
```

1. `devtools_connect` — attaches, claims the tab, marks it
2. `source_search("save")` — finds the handler by content, no path needed
3. `debugger_set_breakpoint(file, line)` — replies `bound: true`
4. the click is triggered
5. `debugger_get_capture` — scope, console and network from the pause, one call
6. the answer is a value that was actually observed, at a line that actually exists

Breakpoints resume themselves, so the click that tripped one still completes.

When you know the function but not the file — which is the usual case with a framework —
`debugger_set_breakpoint_at_function("app.store.save")` asks the engine where that
function was defined and breaks at its first statement. Searching for a name in source
text is unreliable: a function assigned as `Foo.bar = function` cannot be found by
searching `"bar: function"`, and that query happily returns unrelated methods on other
classes instead.

A capture stays small even on a framework object graph: the variable that matters is
printed, and anything too large says what it is (`"constructor", 77747 bytes expanded`)
so you can read just the part you want with `debugger_evaluate_at_frame`.

---

## Security

The launcher uses a **separate Chrome profile**, so your everyday browsing is
untouched, and leaves **web security enabled** — disabling it hides exactly the
cross-origin failures you would be debugging.

Typed values are **not** recorded unless you enable it or are actively
collaborating, and password-like fields stay redacted regardless.

Remote debugging gives full control of the browser profile to anything that can
reach the port. Use the debug profile for development, not for personal accounts.

---

## Layout

```
index.js                 entry point
server.js                shim for older configs pointing here
src/
  core/      config, context, buffers, structured errors, tool registry
  cdp/       connection, target selection, session claim registry, launching
  browser/   the injected in-page agent
  debug/     source maps, scope expansion
  store/     learned-memory store
  tools/     one module per tool group
extension/               companion extension for Chrome tab groups
scripts/gen-docs.mjs     regenerates docs/TOOLS.md from the registry
docs/TOOLS.md            full tool reference (generated)
test/
  validate.mjs           offline checks, no browser needed
  installer.test.mjs     the setup wizard, against real files
  integration.mjs        real Chrome against a fixture app
  fixture-app/           small app with a staged bug and a real source map
BACKLOG.md               every defect found, its fix, and what remains
```

## Working on DevCDP

```
node scripts/call.mjs <tool> '<json>'   call one tool, see the exact response and its cost
node scripts/mcp-probe.mjs             the same thing over real MCP, raw JSON-RPC
```

Breakpoints, logs, and the traps this codebase has already fallen into:
[docs/DEBUGGING.md](docs/DEBUGGING.md).

## Tests

```
npm run validate          offline checks
npm run test:installer    the setup wizard
npm test                  all three suites
npm run docs              regenerate the tool reference
```

124 checks. The integration suite attaches to a page that has **already finished
loading**, because that is the case the previous version got wrong. `npm run
validate` fails if `docs/TOOLS.md` is out of date, so the reference cannot drift.

## Troubleshooting

**Tools not appearing** — fully quit the assistant (tray/menu, not just the window)
and reopen. Re-run the wizard if still missing.

**"Chrome is not reachable"** — launch via `debug-chrome.bat`, then check
`http://localhost:9222/json/version`. Only one Chrome can own a port.

**A breakpoint never fires** — `debugger_list_breakpoints` and look at `bound`. An
unbound breakpoint reports why.

**A selector finds nothing** — `dom_list_frames`; the content may be in an iframe.
Retry with `frame: 'all'`.

**Empty console or network right after attaching** — expected. Capture starts at
attach; `page_reload` replays the page with DevCDP watching.

**The page stops responding** — its main thread is blocked, usually a loop in app
JS. `page_interrupt` aborts the running script; reloading will not free it.

**A tab is unavailable** — `sessions_list` shows which session holds it.
