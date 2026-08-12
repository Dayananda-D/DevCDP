// ─── Memory tools ────────────────────────────────────────────────────────────
// MEM-3: v4's connect message counted `###` headings, which included the nine
// headings of a static selector cheatsheet it had seeded itself — so a fresh
// install reported "13 past patterns" when it had learned nothing.
// MEM-4: memory_get() with no query returned every entry in full, and the workflow
// guide told the model to call it at session start — cheatsheet and an 8 KB help
// dump into context, every session.

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";
import { CATEGORIES } from "../store/memory.js";

const summarise = e => ({
  id: e.id,
  category: e.category,
  failure: (e.failure || "").slice(0, 120),
  pattern: (e.pattern || "").slice(0, 160),
  urlPattern: e.urlPattern || undefined,
  scope: e.scope,
  ts: e.ts,
});

defineTool({
  name: "memory_get",
  description:
    "Look up what previous sessions learned about this app — failures and the recovery that worked. Returns short "
    + "summaries so it is cheap to call at the start of a session; pass full:true or an id to read one in detail. "
    + "Search it whenever a step fails, before asking the user for help.",
  needsClient: false,
  args: {
    query: { type: "string",  description: "Words to match against category, failure, recovery, pattern or URL. Omit for the most recent." },
    id:    { type: "string",  description: "Return this single entry in full." },
    category: { type: "string", description: "Restrict to one category.", enum: CATEGORIES },
    limit: { type: "number",  description: "Maximum entries to return.", default: 12, min: 1, max: 100 },
    full:  { type: "boolean", description: "Return complete entries instead of summaries.", default: false },
  },
  async handler(args, ctx) {
    const store = ctx.memory;

    if (args.id) {
      const hit = store.all().find(e => e.id === args.id);
      if (!hit) fail(CODES.BAD_ARGS, `No memory entry with id ${args.id}.`, "Call memory_get with a query to list ids.");
      return { entry: hit };
    }

    let entries = args.query ? store.search(args.query) : store.all();
    if (args.category) entries = entries.filter(e => e.category === args.category);

    const matched = entries.length;
    entries = entries.slice(0, args.limit);
    const stats = store.stats();

    return {
      count: entries.length,
      matched,
      totalLearned: stats.total,
      entries: args.full ? entries : entries.map(summarise),
      ...(args.full ? {} : { note: "Summaries. Pass full:true, or an id, for the complete recovery steps." }),
      ...(stats.total === 0
        ? { hint: "Nothing has been learned yet. Call memory_record after any recovery so the next session does not repeat this." }
        : {}),
      storage: { local: stats.local, shared: stats.shared, sharedConfigured: !!stats.sharedFile },
    };
  },
});

defineTool({
  name: "memory_record",
  description:
    "Record a failure and the recovery that worked, so a later session can skip the dead end. Call it after any "
    + "user-assisted recovery or non-obvious workaround. All four fields are required and validated — a vague entry "
    + "is worse than none, because it costs context on every future lookup.",
  needsClient: false,
  args: {
    category:    { type: "string", description: "What kind of problem this was.", enum: CATEGORIES, required: true },
    failure:     { type: "string", description: "What went wrong, concretely. e.g. 'Clicking Save did nothing because the form was still validating.'", required: true },
    recovery:    { type: "string", description: "What actually resolved it, as steps someone could repeat.", required: true },
    pattern:     { type: "string", description: "The reusable rule for next time. e.g. 'Wait for the validation spinner to clear before clicking Save.'", required: true },
    url_pattern: { type: "string", description: "URL substring this applies to, so it can be matched to a page later." },
    shared:      { type: "boolean", description: "Write to the shared team store instead of local, if one is configured.", default: false },
  },
  async handler(args, ctx) {
    // MEM-2 — the validation v4 never did.
    const problems = [];
    for (const [field, min] of [["failure", 15], ["recovery", 10], ["pattern", 15]]) {
      const v = String(args[field] || "").trim();
      if (v.length < min) problems.push(`${field} is too short to be useful (${v.length} chars, need ${min}+)`);
      if (/^(undefined|null|n\/a|none|-)$/i.test(v)) problems.push(`${field} is a placeholder, not a description`);
    }
    if (problems.length) {
      fail(CODES.BAD_ARGS, `Refusing to record an unusable memory entry: ${problems.join("; ")}`,
        "Describe the concrete failure, what fixed it, and the rule to apply next time.");
    }

    const res = ctx.memory.add({
      category: args.category,
      failure: args.failure.trim(),
      recovery: args.recovery.trim(),
      pattern: args.pattern.trim(),
      urlPattern: args.url_pattern || (ctx.conn.targetUrl ? new URL(ctx.conn.targetUrl).pathname : null),
      sessionId: ctx.sessionId,
    }, { shared: args.shared });

    if (!res.ok) fail(CODES.IO_FAILED, `Could not write the memory entry: ${res.error}`, "Check the memory directory is writable.");

    if (args.shared && !ctx.memory.sharedDir) {
      return { recorded: true, id: res.record.id, scope: "local",
        note: "No shared store is configured, so this was saved locally. Set sharedMemoryDir in your settings file to pool entries across the team." };
    }
    return { recorded: true, id: res.record.id, scope: res.scope, total: ctx.memory.stats().total };
  },
});

defineTool({
  name: "memory_import_legacy",
  description:
    "One-off import of a v4 Markdown memory file into the current store, skipping the malformed entries v4's missing "
    + "validation produced. Run once after upgrading, then delete the old file.",
  needsClient: false,
  args: {
    path: { type: "string", description: "Full path to the old memorymanagement.md.", required: true },
  },
  async handler(args, ctx) {
    const res = ctx.memory.migrateFromMarkdown(args.path);
    return {
      ...res,
      total: ctx.memory.stats().total,
      note: res.skipped
        ? `${res.skipped} entr${res.skipped === 1 ? "y was" : "ies were"} skipped as unusable (missing category, failure or pattern).`
        : undefined,
    };
  },
});
