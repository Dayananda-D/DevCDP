#!/usr/bin/env node
// DevCDP entry point. Kept trivial so the interesting code is all under src/.
import { main } from "./src/server.js";

main().catch(err => {
  process.stderr.write(`[fatal] DevCDP failed to start: ${err?.stack || err}\n`);
  process.exit(1);
});
