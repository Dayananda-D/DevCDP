# Guidance templates

What `initialize_MCP.js` copies into your AI client so it knows how to use DevCDP.
Registering the server tells an assistant that seventy-odd tools exist; it does not
say which to reach for, in what order, or what the traps are. That is what these are.

| File | Used for |
|---|---|
| `AGENTS.md` | The default, used for every client. |
| `<client-id>.md` | Optional override for one client, used instead of `AGENTS.md`. |

Client ids are the `id` fields in `TARGETS` in `initialize_MCP.js`: `claude-code`,
`claude-desktop`, `cursor`, `windsurf`, `vscode`, `zed`, `opencode`. To give Cursor its
own wording, add `initialize/cursor.md`; everything else keeps using `AGENTS.md`.

**Edit these freely.** They are plain markdown, read at install time — nothing is
compiled in, so a change takes effect the next time anyone runs the installer. Team
conventions belong here: which app you debug, where its source lives, what usually
goes wrong.

## How it lands in the client

The installer writes the content inside a marked block:

```
<!-- devcdp:begin — managed by initialize_MCP.js; edits inside this block are overwritten -->
...
<!-- devcdp:end -->
```

Re-running replaces that block rather than appending a second copy, and anything you
wrote outside it is left alone. The existing file is backed up first.

Where it goes depends on what the client actually reads:

| Client | Destination |
|---|---|
| Claude Code | `~/.claude/CLAUDE.md` — written for you |
| Windsurf | `~/.codeium/windsurf/memories/global_rules.md` — written for you |
| opencode | `~/.config/opencode/AGENTS.md` — written for you |
| Cursor, Zed | `AGENTS.md` in each project — the installer prints the path to copy |
| VS Code | `.github/copilot-instructions.md` in each project — path printed |
| Claude Desktop | no instruction-file mechanism; nothing is written |

The project-scoped clients are not written to automatically on purpose. Instructions
for those are read from the repository being worked on, not from your home directory,
so the installer cannot know which projects you mean — and writing a plausible-looking
file the client never reads would leave you believing it was configured.
