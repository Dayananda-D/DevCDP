# Publishing DevCDP

Where DevCDP can be listed, what each listing needs, and the exact steps. DevCDP is a
**local stdio server** (it talks to a Chrome on the user's own machine), which decides
the split below: registries that list local servers are one publish away; the two
consumer directories need a hosted server first.

| Where | Reaches | Transport accepted | Status |
|---|---|---|---|
| npm | everything below pulls from here | n/a | ready to publish |
| Official MCP Registry | GitHub MCP Registry, VS Code, Copilot CLI, Cursor and other client pickers | stdio, remote | `server.json` ready |
| Claude Code plugin marketplace | Claude Code (`/plugin install`) | stdio | `plugins/devcdp` ready |
| Community directories (Smithery, Glama, PulseMCP, mcp.so) | discovery | stdio | index automatically from GitHub / the registry |
| Claude Connectors Directory (claude.ai, desktop, mobile) | Claude consumer apps | Streamable HTTP only | needs a hosted relay first |
| ChatGPT app directory | ChatGPT | Streamable HTTP only | needs a hosted relay first |

## One-time setup

1. **npm account** with 2FA. Check the name is still free: `npm view devcdp` should 404.
2. **GitHub**: the repo is public, the `mcpName` in `package.json` is
   `io.github.Dayananda-D/devcdp`, so the publish must be done by the GitHub account
   that owns `Dayananda-D/DevCDP` (namespace = your GitHub login).
3. For the workflow in `.github/workflows/publish.yml`: add an npm **Automation**
   token as the `NPM_TOKEN` repository secret, or set up npm Trusted Publishing for this
   repository and remove the token step.

## Release checklist

Every version bump touches four files, and `npm run validate` fails if they disagree:
`package.json`, `server.json` (twice: top level and `packages[0]`),
`plugins/devcdp/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`.
`src/server.js` also reports a version string to MCP clients.

```
npm test                       all three suites (integration needs Chrome)
npm run docs                   regenerate docs/TOOLS.md and the plugin skill
npm pack --dry-run             eyeball exactly what ships
```

## 1. npm

```
npm login
npm publish --access public
```

Verify at https://www.npmjs.com/package/devcdp, then try it from a clean directory:

```
npx -y devcdp
```

It should start and wait on stdin (that is the MCP transport). Ctrl+C.

## 2. Official MCP Registry

Install `mcp-publisher` (Windows, PowerShell):

```powershell
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture -eq "Arm64") { "arm64" } else { "amd64" }
Invoke-WebRequest -Uri "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_windows_$arch.tar.gz" -OutFile mcp-publisher.tar.gz
tar xf mcp-publisher.tar.gz mcp-publisher.exe
Remove-Item mcp-publisher.tar.gz
# move mcp-publisher.exe somewhere on PATH
```

Then, from the repo root:

```
mcp-publisher login github        # device-code flow in the browser
mcp-publisher publish             # reads ./server.json
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.Dayananda-D/devcdp"
```

The registry checks that the npm package's `mcpName` matches `server.json`'s `name`, so
step 1 must be done first. Once listed, the server appears in the GitHub MCP Registry,
which VS Code's "Browse MCP Servers" picker and Copilot CLI's `/mcp search` read from.

**Automated:** after the one-time setup above, `git tag v5.0.1 && git push --tags`
runs both publishes from GitHub Actions.

## 3. Claude Code plugin

The repo is already a marketplace. Anyone can install today with:

```
/plugin marketplace add Dayananda-D/DevCDP
/plugin install devcdp@devcdp
```

The plugin's launcher (`plugins/devcdp/scripts/launch.mjs`) installs the npm package into
the plugin's data directory on first run, so step 1 must be done first, and the
plugin version must exist on npm.

Anthropic runs two public marketplaces. `claude-plugins-official` is curated by Anthropic
at its discretion with no application process. `claude-community`
(https://github.com/anthropics/claude-plugins-community) takes third-party submissions
after review; users add it with `/plugin marketplace add anthropics/claude-plugins-community`.

Before submitting, run the same check the review pipeline runs:

```
claude plugin validate ./plugins/devcdp --strict
```

Then submit through the Console form at https://platform.claude.com/plugins/submit
(the claude.ai form needs a Team or Enterprise organization). Give it this repository,
the plugin path `plugins/devcdp`, and the description above. Approved plugins are
pinned to a commit SHA in the community catalog and re-pinned automatically as you push;
the catalog syncs nightly. Note that a plugin's `bin/` directory is added to the Bash
tool's PATH and blocks claude.ai org distribution, which is why the launcher lives in
`scripts/`, not `bin/`.

Also list the marketplace on https://claudecodemarketplace.com (community index).

## 4. Community directories

- **Smithery**: https://smithery.ai — sign in with GitHub, add the repo.
- **Glama**: https://glama.ai/mcp/servers — claim the auto-indexed listing.
- **PulseMCP** and **mcp.so**: submit the GitHub URL through their forms.
- **Cursor**: https://cursor.com/directory — submission form, needs a logo.

## 5. Claude Connectors Directory and ChatGPT (later)

Both accept only remote servers over **Streamable HTTP**, with OAuth or no auth, and
both review:

- every tool annotated (`readOnlyHint`, `destructiveHint`, `openWorldHint`,
  `idempotentHint`) — done, see `src/core/tools.js`;
- a public privacy policy — `PRIVACY.md`, publish it at a stable URL;
- a square PNG logo and retina screenshots (ChatGPT), test cases per tool (ChatGPT);
- no SSE transport.

Because DevCDP must reach the developer's local Chrome, a directory listing means a
thin hosted Streamable HTTP endpoint that relays to a local agent on the user's machine.
That is a real project, not a config change, so it is deliberately out of scope for the
first release.

- Anthropic: https://claude.com/docs/connectors/building/submission
- OpenAI: https://developers.openai.com/apps-sdk/app-submission-guidelines
