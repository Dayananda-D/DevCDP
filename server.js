#!/usr/bin/env node
// ─── Compatibility shim ──────────────────────────────────────────────────────
// v4 was a single 1473-line server.js, and existing editor configs point node
// straight at this path. Rather than break every installed config, this forwards
// to the current implementation under src/.
//
// The v4 implementation is kept at legacy/server-v4.js for reference only — it is
// not loaded, and it contains the defects catalogued in BACKLOG.md.
//
// Re-run initialize_MCP.js to repoint your editor at index.js and drop this shim.

import { main } from "./src/server.js";

main().catch(err => {
  process.stderr.write(`[fatal] DevCDP failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
