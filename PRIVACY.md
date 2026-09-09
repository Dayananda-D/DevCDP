# Privacy

DevCDP is a local tool. It runs on your machine, talks to a Chrome instance on your
machine over the DevTools Protocol, and talks to your AI assistant over MCP on
standard input and output. It has no server of its own and phones nothing home.

## What it reads

While attached to a tab, DevCDP reads whatever Chrome exposes for that tab: console
output, network requests and (on request) their response bodies, the DOM, loaded
scripts and source maps, and, when paused at a breakpoint, the values of variables in
scope. That is the point of the tool, and it can include personal or sensitive data
if the page you are debugging contains any.

## Where it goes

Everything DevCDP reads is returned to the MCP client you connected it to, and only
there. What that client then sends to a model is governed by that client's own privacy
policy, not this one. Nothing is sent to the DevCDP author or to any third party by
DevCDP itself.

The only outbound requests DevCDP makes on its own are to the page's origin: fetching
external source-map files the page references, and probing a short list of well-known
OpenAPI paths when you ask it to map an API. Both stay inside the browser session you
are already in.

## What it stores

- **Learned memory** (`memory_record`): notes an assistant chooses to save about fixes
  that worked. Stored as local files under `.devcdp/` in the working directory, or in
  `sharedMemoryDir` if you configure one. These can quote data from the app being
  debugged, which is why the directory is gitignored by default.
- **Session claim registry**: which DevCDP session holds which tab, so two sessions
  do not fight over one. Local JSON, no page content.
- **Settings**: `devcdp.settings.json`, written only when you ask for it.
- **Setup backups**: one timestamped backup of any editor config the installer
  edits.

Typed values are not recorded unless you enable it or are actively collaborating
through the on-page badge, and password-like fields are redacted regardless.

## Telemetry

None. There is no analytics, crash reporting, or update check.

## Chrome remote debugging

Remote debugging gives full control of the browser profile to anything that can reach
the port. The launcher uses a separate profile for this reason. Use it for the app you
are developing, not for personal accounts.

## Contact

Questions and reports: https://github.com/Dayananda-D/DevCDP/issues
