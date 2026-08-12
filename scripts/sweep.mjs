// Remove DevCDP overlays from tabs that no live session owns.
//
// Overlays now expire on their own when their session stops beating, so this is a
// recovery tool for two cases the watchdog cannot cover: a tab still carrying an
// overlay drawn by an older build, and a tab you want cleaned immediately rather
// than at the end of the grace period. It never touches a tab that a live session
// legitimately holds.
//
//   node scripts/sweep.mjs [--port 9222] [--dry]
import CDP from "chrome-remote-interface";
import { liveClaims } from "../src/cdp/registry.js";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : dflt;
};
const port = Number(arg("port", 9222));
const dry  = process.argv.includes("--dry");

const claimed = new Set(liveClaims().filter(c => c.port === port).map(c => c.targetId));
console.log(`port ${port}: ${claimed.size} tab(s) held by live sessions`);

let tabs;
try {
  tabs = (await CDP.List({ host: "127.0.0.1", port })).filter(t => t.type === "page");
} catch (e) {
  console.error(`Chrome is not reachable on port ${port}: ${e.message}`);
  process.exit(1);
}

const CLEAN = `(function(){
  var found = !!(document.getElementById("devcdp-badge-host")
              || document.documentElement.getAttribute("data-devcdp-session"));
  if (!found) return "none";
  try { window.__devcdp && window.__devcdp.teardown && window.__devcdp.teardown(); } catch (e) {}
  try {
    var h = document.getElementById("devcdp-badge-host");
    if (h && h.parentNode) h.parentNode.removeChild(h);
    var de = document.documentElement;
    ["data-devcdp-session","data-devcdp-session-id","data-devcdp-session-no","data-devcdp-group-mode"]
      .forEach(function(a){ de.removeAttribute(a); });
  } catch (e) {}
  return "removed";
})()`;

let removed = 0, skipped = 0, clean = 0;
for (const t of tabs) {
  if (claimed.has(t.id)) { skipped++; continue; }
  let c;
  try {
    c = await CDP({ host: "127.0.0.1", port, target: t.id });
    const expr = dry
      ? `(!!(document.getElementById("devcdp-badge-host") || document.documentElement.getAttribute("data-devcdp-session"))) ? "stale" : "none"`
      : CLEAN;
    const { result } = await c.Runtime.evaluate({ expression: expr, returnByValue: true });
    if (result.value === "none") { clean++; continue; }
    removed++;
    console.log(`  ${dry ? "would clean" : "cleaned"}: ${t.url.slice(0, 78)}`);
  } catch (_) {
    // A tab we cannot reach cannot be carrying a live overlay we can remove.
  } finally { try { if (c) await c.close(); } catch (_) {} }
}

console.log(`\n${removed} stale overlay(s) ${dry ? "found" : "removed"}, ${skipped} left alone (owned), ${clean} already clean`);
process.exit(0);
