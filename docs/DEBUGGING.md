# Debugging DevCDP itself

DevCDP debugs *pages*. DevCDP is a **Node process**, so its own tools do not point at
it — you need a different set. All of the below is verified working on this repo.

Pick by symptom:

| Symptom | Start here |
|---|---|
| A tool returns the wrong thing | [1. Call it directly](#1-call-a-tool-directly) |
| Works standalone, not in my assistant | [2. Look at the wire](#2-look-at-the-wire) |
| I need to stop inside the code | [3. Breakpoints](#3-breakpoints-in-the-server) |
| Something is wrong and I can't tell what | [4. Logs](#4-logs) |
| Behaviour depends on the browser | [5. Drive a real browser](#5-drive-a-real-browser) |
| I changed something — did I break it? | [6. Tests](#6-tests-as-the-loop) |

---

## 1. Call a tool directly

The fastest loop. No assistant, no MCP client — the handler, and the exact response a
model would receive, with what it costs.

```bash
node scripts/call.mjs                                  # list every tool
node scripts/call.mjs list_tabs
node scripts/call.mjs dom_query '{"selector":"button","limit":3}'
node scripts/call.mjs source_search '{"query":"saveOrder"}'
node scripts/call.mjs devcdp_settings --no-connect      # tools needing no page
```

It attaches first when the tool needs a page, prints timing and token cost, and
releases the tab afterwards. Flags: `--port N`, `--no-connect`, `--raw` (response
only, good for piping to `jq`), `--quiet` (hide server logs).

This is what every investigation in this project's history was built on. If you find
yourself writing a throwaway script, use this instead.

---

## 2. Look at the wire

`call.mjs` bypasses the protocol. When a tool works there but not through your
assistant, the difference is always in the MCP layer:

```bash
node scripts/mcp-probe.mjs                       # handshake + tool list
node scripts/mcp-probe.mjs workflow_guide        # and call one tool
node scripts/mcp-probe.mjs list_tabs '{"port":9222}'
```

It spawns the real server over stdio, performs the real handshake, and prints raw
JSON-RPC. It also reports the tool-list size in tokens, and warns about any tool
missing a description.

---

## 3. Breakpoints in the server

Node's inspector speaks the **same** Chrome DevTools Protocol that DevCDP itself
uses, so Chrome's debugger works on the server directly.

### Standalone

```bash
node --inspect-brk index.js
```

Then open `chrome://inspect` → **inspect** under Remote Target. Full breakpoints,
stepping, and scope, over your own source.

With stdio transport the process exits when stdin closes, so drive it from another
terminal with `scripts/mcp-probe.mjs`, or hold stdin open:

```bash
node --inspect index.js < /dev/tty       # macOS/Linux
```

### While your assistant drives it — the useful one

Add `NODE_OPTIONS` to the server's entry in your MCP config:

```json
"devcdp": {
  "command": "node",
  "args": ["C:/Users/dd/Project/DevCDP/index.js"],
  "env": { "NODE_OPTIONS": "--inspect=9230" }
}
```

Restart the assistant, open `chrome://inspect`, and you can stop inside a tool
handler *while the model is calling it*. The websocket URL is printed to the server's
stderr log (see below) if you need it directly.

Use a port you are not already using for the browser — 9230 rather than 9222 — and
note that two server processes would collide on it; `--inspect=0` picks a free port
and prints it.

---

## 4. Logs

Everything goes to **stderr**, which your MCP client captures:

- Claude Desktop: `%APPDATA%\Claude\logs\mcp-server-devcdp.log`
- Claude Code: shown with `/mcp`, or the session log
- Cursor / Windsurf: the MCP output panel

Raise the level:

```json
"env": { "DEVCDP_LOG_LEVEL": "debug" }
```

`debug` adds a line per tool call with its duration. Levels: `debug`, `info` (default),
`warn`, `error`.

The lines worth knowing:

| Line | Meaning |
|---|---|
| `registry — claimed tab` | which tab this session owns |
| `connection — attached … scripts: N` | **N should not be 0**; 0 means the attach missed the script index |
| `a departing session released the tab` | the reload overlap, handled |
| `debugger — captured and resumed automatically` | normal breakpoint behaviour |
| `pause held for Nms — resuming automatically` | a hold was forgotten; the watchdog fired |
| `connection — aborted the page's running script` | the page was wedged and was recovered |
| `agent — in-page feature failed: X` | the injected agent lost a feature, and which |

---

## 5. Drive a real browser

Two of the three test suites need Chrome. To reproduce something by hand:

```bash
node scripts/call.mjs devtools_connect '{"port":9222,"target":"visible"}'
```

…or use the fixture app, which has a staged bug, a real external source map, a modal
and a failing endpoint:

```js
import { startFixture } from "./test/fixture-app/server.mjs";
const fixture = await startFixture();     // prints an origin to open
```

`test/integration.mjs` is the worked example: it launches its own Chrome on a free
port with an isolated profile, so it never touches your browser.

---

## 6. Tests as the loop

```bash
npm run validate          # 32 checks, no browser, ~1s
npm run test:installer    # 23 checks against real files, ~1s
npm run test:integration   # 71 checks against real Chrome, ~90s
npm test                  # all three
```

For logic changes, `npm run validate` is fast enough to run on every save.

**Two traps this suite has already fallen into — check for them in anything you add:**

- **The offline harness must `await` your test.** It once recorded a pass and let the
  assertion reject afterwards, so every async test silently passed. If you add an
  async check, make sure it can actually fail: break it deliberately once.
- **Assert on behaviour reaching the page, not on the source text.** Several settings
  are interpolated in the browser from `CFG`, so a string search over the generated
  agent source "passes" while the feature does nothing. Read the value back out of
  the page, or out of the embedded `CFG`.

---

## Where things live

| Looking for | File |
|---|---|
| Attach, reconnect, pause handling, teardown | `src/cdp/connection.js` |
| Tab selection and the claim registry | `src/cdp/targets.js`, `src/cdp/registry.js` |
| The injected page agent (indicator, cursor, dialogs) | `src/browser/agent.js` |
| Argument validation, defaults, response cap | `src/core/tools.js` |
| Settings discovery and provenance | `src/core/config.js` |
| Source maps, scope expansion | `src/debug/` |
| One module per tool group | `src/tools/` |

The agent is a **string of browser JavaScript** built in Node, so:

- a backtick anywhere in it terminates the template literal — this has broken the
  build three times
- `${...}` is evaluated in Node at build time; anything meant for the browser must be
  escaped or passed through `CFG`
- `npm run validate` parses the built source with `new Function`, so a syntax error is
  caught without a browser

---

## Could DevCDP debug itself?

Nearly. Node's inspector is a CDP endpoint — verified on this repo:

```
targets: 1 | types: node
Runtime.evaluate in the server process -> v24.12.0
Debugger.enable -> ok
```

So the protocol, the source-map code and the scope expansion in `src/debug/` would all
work against a Node process. The blocker is deliberate: `listPageTargets` accepts only
`type === "page"`, and attach then does page-only work — `Page.enable`,
`addScriptToEvaluateOnNewDocument`, injecting the indicator — none of which exists in
Node.

Supporting it would mean a "node target" mode that skips those steps. It is a genuine
feature, not a bug, and it is not implemented. For now `chrome://inspect` gives you the
same debugger with no code at all.
