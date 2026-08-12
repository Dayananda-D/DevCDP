# Getting started with DevCDP

DevCDP gives your AI assistant real Chrome DevTools access — console, network, DOM,
source maps, breakpoints and live variables. Instead of pasting an error and having
the assistant guess, it watches your app run and reports the actual value at the
actual line.

It works with any web app and any MCP-capable assistant. There is nothing
app-specific in it: it learns your app by inspecting it.

---

## One-time setup — about two minutes

1. **Run `initialize_MCP.bat`** (or `node initialize_MCP.js`).
   It installs dependencies, detects your editors, asks which to configure, and
   writes a `debug-chrome.bat` launcher.

   It will not touch a config file it cannot parse — it prints the snippet for you
   to paste. Anything it does write is backed up first.

   It also offers to write **usage guidance** into the file your assistant already
   reads, so it knows which tools to reach for and what the traps are without being
   told each session. The text comes from `initialize/AGENTS.md` — edit that file and
   re-run the installer to change what your assistant is told, and add
   `initialize/<client-id>.md` to word it differently for one client. See
   `initialize/README.md`.

2. **Fully quit and reopen your assistant** so it re-reads its config. For desktop
   apps that means quitting from the tray or menu bar, not just closing the window.

3. *(Optional, 30 seconds)* For coloured tab groups per session:
   `chrome://extensions` → Developer mode → **Load unpacked** → select the
   `extension/` folder. Recent Chrome versions ignore command-line extension
   loading, so this may be needed. Everything except grouping works without it.

---

## Every session — three steps

1. **Double-click `debug-chrome.bat`.** A separate Chrome profile on port 9222; your
   normal browsing is untouched.
2. **Open your app** and sign in if needed.
3. **Describe the bug**, e.g.
   > "Debug why the save button does nothing and find the exact line."

---

## Reading the tab

A claimed tab gets a thin border. The border is the status:

| | |
|---|---|
| **breathing glow** | DevCDP is working — leave it to it |
| **still and green** | it has handed control to you; go ahead |
| **still and red** | something failed |

Short status messages appear as fading toasts in the corner. A ring and a ripple
show where it is clicking. When it pauses at a breakpoint, Chrome's own "Paused in
debugger" bar appears.

None of it can absorb a click meant for your app.

---

## Stepping in yourself

**You do not have to wait to be asked.** If it is slow, or heading the wrong way,
just do the thing yourself — click, type, choose. It is recorded, and the assistant
can read exactly which element you touched and which option you picked.

**Ctrl+Shift+D** in the tab says "I'm driving". That also starts capturing the
values you type, so telling it *which* reference or *which* customer actually
reaches it. Outside that, typed values stay private and password-like fields are
always redacted.

When it needs something only you can do — an SSO login, a choice it cannot make —
it asks on the page and waits for the **I've done it ✓** button.

---

## Worth knowing on day one

**Reload after attaching, or reproduce the action.** Chrome cannot replay console
history to a debugger that attaches afterwards, and network capture starts at
attach. If the failure already happened, tell it to reload — it says so itself when
it attaches.

**Breakpoints resume themselves.** The page is not left frozen, and the click that
tripped the breakpoint still completes. If it deliberately holds a pause to step
through, that is released automatically too.

**Breakpoints report whether they bound.** If one cannot resolve to executable
code, it says so instead of pretending to be armed.

**A frozen page is recoverable.** If your app hits an infinite loop, tools that need
the page fail in seconds rather than hanging, and it can abort the runaway script
itself. Reloading does *not* free it — `page_interrupt` does.

**Content in an iframe needs `frame: 'all'`.** If a selector finds nothing, that is
usually why.

---

## Things worth asking for

- *"Why does this button do nothing? Find the exact line."*
- *"This list is empty after I filter — is the API failing?"*
- *"Show me the request and response for the call that fails."*
- *"Set a breakpoint where the form is validated and tell me what the payload holds."*
- *"What does this app actually expose — buttons, fields, endpoints?"*
- *"What does this term mean in our system?"* (with `docsRoot` set)
- *"What have we learned about this screen before?"*

---

## Making it better for your team

Ask the assistant to run `devcdp_settings_init`, then edit the file it writes. The
two that matter most:

- **`docsRoot`** — points at your project so it can read your README and docs
  instead of inferring your vocabulary from the UI.
- **`sharedMemoryDir`** — a shared or in-repo folder. After any recovery it records
  what worked; with this set, everyone's DevCDP reads those entries. Without it,
  memory stays on one machine.

The badge starts at the top centre and is draggable — grab it and drop it wherever it
is out of your way, and it stays there. The messages move with it.

Other things people commonly change: `badgeCorner` for a different starting position,
`toasts: false` if the messages distract, `badge: false` for visual regression work,
`chromeProfile: "default"` to
reuse your signed-in Chrome (note Chrome 136+ refuses remote debugging on the
default profile).

`devcdp_settings` shows every value and where it came from, which is the quickest
way to check a change actually took effect.

---

## Several people, or several agents

Each session claims its own tab, and a claimed tab is never handed to another
session. If every tab is taken, a new session opens its own — on the page you
wanted, and it tells you why. Ask for `browser: 'new'` to get an entirely separate
Chrome. `sessions_list` shows who holds what.

---

## Troubleshooting

**Tools missing** — fully quit and reopen the assistant. Re-run the wizard if needed.

**"Chrome is not reachable"** — launch through `debug-chrome.bat`, then open
`http://localhost:9222/json/version` to confirm. Only one Chrome per port.

**Console and network look empty** — capture starts at attach; reload.

**A breakpoint never fires** — ask it to check `debugger_list_breakpoints`; an
unbound breakpoint explains itself.

**The page has stopped responding** — its main thread is blocked. Ask for
`page_interrupt`; reloading will not free it.

**A blank or extra tab appeared** — that meant every tab was claimed. It should now
reattach instead; if it persists, `sessions_list` will show a second session, which
usually means the server is registered twice — re-run the wizard, which removes
duplicates.

**On a managed device and it will not load** — local MCP servers may be restricted
by policy. Ask for DevCDP to be approved.

---

## Safety

`debug-chrome.bat` uses an isolated profile and leaves **web security enabled** —
turning it off would hide the cross-origin bugs you are trying to find.

Remote debugging gives full control over that browser profile to anything that can
reach the port, so keep the debug profile for development and do not sign into
personal accounts in it.

---

Full tool reference: [docs/TOOLS.md](docs/TOOLS.md). Token costs and how to lower
them: [docs/PERFORMANCE.md](docs/PERFORMANCE.md). Known issues and everything
that was fixed: [BACKLOG.md](BACKLOG.md). Hit an edge case it handles badly? Bring
it back — that is how the backlog got this short.
