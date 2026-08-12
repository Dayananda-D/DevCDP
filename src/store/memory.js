// ─── Memory store ────────────────────────────────────────────────────────────
// v4 kept memory as one Markdown file rewritten with readFileSync + writeFileSync
// on every record. That is unsafe with concurrent sessions (F1) — two agents
// recording at once lose one entry — and it made "the more the team uses it, the
// smarter it gets" untrue, because the file lived next to server.js inside each
// person's own install (MEM-1).
//
// This is JSONL instead: append-only, one line per entry. Appends of a single
// short line are atomic in practice on both NTFS and POSIX, so parallel sessions
// cannot corrupt each other. An optional shared directory (a network share or a
// repo path) is read alongside the local one, which is what actually lets fixes
// pool across a team.
//
// MEM-2: v4 validated nothing, so its live memory file contained two entries
// reading literally "### [undefined] undefined". Validation now happens at the
// tool boundary and bad input is rejected with an explanation.

import fs   from "fs";
import path from "path";
import crypto from "crypto";
import { log } from "../core/log.js";

const FILE = "memory.jsonl";

const ensure = dir => { try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (_) { return false; } };

function readFile(file, scope) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch (_) { return []; }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && entry.failure && entry.pattern) out.push({ ...entry, scope });
    } catch (_) { /* skip a torn line rather than failing the read */ }
  }
  return out;
}

export class MemoryStore {
  constructor(cfg) {
    this.localDir  = cfg.memoryDir;
    this.sharedDir = cfg.sharedMemoryDir || null;
  }

  get localFile()  { return path.join(this.localDir, FILE); }
  get sharedFile() { return this.sharedDir ? path.join(this.sharedDir, FILE) : null; }

  all() {
    const local  = readFile(this.localFile, "local");
    const shared = this.sharedFile ? readFile(this.sharedFile, "shared") : [];

    // Same lesson recorded in both places: prefer the shared copy, drop the dup.
    const seen = new Set();
    const merged = [];
    for (const e of [...shared, ...local]) {
      const key = `${e.category}|${(e.failure || "").toLowerCase().slice(0, 80)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(e);
    }
    return merged.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  }

  search(query) {
    if (!query) return this.all();
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    return this.all()
      .map(e => {
        const haystack = [e.category, e.urlPattern, e.failure, e.recovery, e.pattern].join(" ").toLowerCase();
        const hits = terms.filter(t => haystack.includes(t)).length;
        return { entry: e, hits };
      })
      .filter(x => x.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map(x => x.entry);
  }

  add(entry, { shared = false } = {}) {
    const dir  = shared && this.sharedDir ? this.sharedDir : this.localDir;
    const file = path.join(dir, FILE);
    if (!ensure(dir)) return { ok: false, error: `Cannot create ${dir}` };

    const record = {
      id: crypto.randomBytes(5).toString("hex"),
      ts: new Date().toISOString(),
      ...entry,
    };

    try {
      fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
      log.info("memory", "recorded", { id: record.id, category: record.category, file });
      return { ok: true, record, file, scope: shared && this.sharedDir ? "shared" : "local" };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  stats() {
    const all = this.all();
    const byCategory = {};
    for (const e of all) byCategory[e.category || "other"] = (byCategory[e.category || "other"] || 0) + 1;
    return {
      total: all.length,
      local: all.filter(e => e.scope === "local").length,
      shared: all.filter(e => e.scope === "shared").length,
      byCategory,
      localFile: this.localFile,
      sharedFile: this.sharedFile,
    };
  }

  /**
   * One-time import of a v4 Markdown memory file, skipping the junk entries its
   * lack of validation produced.
   */
  migrateFromMarkdown(mdPath) {
    if (!fs.existsSync(mdPath)) return { migrated: 0, skipped: 0 };
    let text = "";
    try { text = fs.readFileSync(mdPath, "utf8"); } catch (_) { return { migrated: 0, skipped: 0 }; }

    let migrated = 0, skipped = 0;
    for (const block of text.split(/^###\s+/m).slice(1)) {
      const head = block.split("\n")[0] || "";
      const m = head.match(/^\[([^\]]+)\]\s*(.*)$/);
      const field = name => (block.match(new RegExp(`\\*\\*${name}\\*\\*:\\s*(.+)`, "i")) || [])[1]?.trim();

      const category = m?.[1];
      const failure  = field("Failure") || m?.[2];
      const recovery = field("Recovery");
      const pattern  = field("Pattern");

      // Exactly the "[undefined] undefined" rows v4 wrote.
      if (!category || category === "undefined" || !failure || failure === "undefined" || !pattern) { skipped++; continue; }

      this.add({ category, failure, recovery: recovery || "(not recorded)", pattern,
                 urlPattern: field("URL pattern")?.replace(/`/g, "") || null,
                 importedFrom: path.basename(mdPath) });
      migrated++;
    }
    return { migrated, skipped };
  }
}

export const CATEGORIES = ["navigation", "click", "fill", "auth", "debug", "network", "selector", "dialog", "timing", "other"];
