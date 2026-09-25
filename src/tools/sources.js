// ─── Source tools ────────────────────────────────────────────────────────────
// SRC-1 lived in the connection layer (scriptParsed subscribed after enable), so
// this whole tool group returned nothing on any already-loaded page. With that
// fixed, these tools are what makes "find the exact line" possible.
// SRC-2: source maps are now genuinely resolved, including external .map files.

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";
import { loadSourceMap, loadAllSourceMaps, sourceContentFor, findSourceIndex } from "../debug/sourcemap.js";

const sliceLines = (text, from, to) => {
  const lines = String(text).split(/\r?\n/);
  const start = Math.max(1, from || 1);
  const end   = Math.min(lines.length, to || lines.length);
  return {
    text: lines.slice(start - 1, end).map((l, i) => `${start + i}\t${l}`).join("\n"),
    totalLines: lines.length,
    from: start,
    to: end,
  };
};

defineTool({
  name: "source_list_scripts",
  readOnly: true,
  description:
    "List the JavaScript files loaded in the page, with size and whether each has a source map. This is indexed the "
    + "moment DevCDP attaches, so it works on a page that was already open. Filter by URL substring to find the file "
    + "you need before setting a breakpoint.",
  args: {
    filter:            { type: "string",  description: "Only scripts whose URL contains this substring." },
    with_source_maps:  { type: "boolean", description: "Only scripts that carry a source map.", default: false },
    limit:             { type: "number",  description: "Maximum scripts to return.", default: 100, min: 1, max: 1000 },
  },
  async handler(args, ctx) {
    let list = [...ctx.scripts.values()];
    const held = list.length;

    if (args.filter)           list = list.filter(s => s.url.includes(args.filter));
    if (args.with_source_maps) list = list.filter(s => s.hasSourceMap);

    const matched = list.length;
    list = list.slice(0, args.limit);

    return {
      count: list.length,
      matched,
      totalLoaded: held,
      withSourceMaps: [...ctx.scripts.values()].filter(s => s.hasSourceMap).length,
      scripts: list.map(s => ({
        scriptId: s.scriptId, url: s.url,
        bytes: s.bytes ?? null,
        hasSourceMap: s.hasSourceMap,
      })),
      ...(held === 0
        ? { warning: "No scripts indexed. If the page has JavaScript, something is wrong with the attach — call devtools_status, then page_reload." }
        : {}),
      ...(matched === 0 && args.filter
        ? { hint: `Nothing matched "${args.filter}". ${held} scripts are loaded — drop the filter to see them, or use source_search to find code by content.` }
        : {}),
      // A framework that loads a class per file puts thousands of scripts here, and
      // a listing that long tells you nothing. Say so, and point at the way through.
      ...(matched > args.limit
        ? { hint: `Showing ${list.length} of ${matched} matching scripts. A list this long is rarely the way in — `
                + `use source_search to find code by content, or filter by URL substring.` }
        : {}),
    };
  },
});

defineTool({
  name: "source_search",
  readOnly: true,
  description:
    "Search the text of every loaded script — and every original file recoverable from source maps — for a string or "
    + "regular expression. This is the fastest way to locate a handler when you know a function name, a message or a "
    + "field name but not the file. Returns file, 1-based line and the matching line.",
  args: {
    query:        { type: "string",  description: "Text or regular expression to find.", required: true },
    regex:        { type: "boolean", description: "Treat query as a regular expression.", default: false },
    ignore_case:  { type: "boolean", description: "Case-insensitive search.", default: true },
    url_filter:   { type: "string",  description: "Only search scripts whose URL contains this." },
    include_original_sources: { type: "boolean", description: "Also search original files from source maps.", default: true },
    max_results:  { type: "number",  description: "Stop after this many matches.", default: 40, min: 1, max: 300 },
    context_chars:{ type: "number",  description: "Characters of the matching line to return.", default: 200, min: 40, max: 1000 },
  },
  async handler(args, ctx) {
    let pattern;
    try {
      pattern = args.regex
        ? new RegExp(args.query, args.ignore_case ? "i" : "")
        : new RegExp(args.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), args.ignore_case ? "i" : "");
    } catch (e) {
      fail(CODES.BAD_ARGS, `Invalid regular expression: ${e.message}`, "Escape special characters, or set regex:false.");
    }

    const results = [];
    const searched = { scripts: 0, originalFiles: 0 };
    let stoppedEarly = false;

    // One enormous file must not spend the whole budget — a bundle mentioning the
    // term on 400 lines would otherwise hide every other file from view.
    const perFileCap = Math.max(3, Math.ceil(args.max_results / 4));
    let cappedFiles = 0;

    const scanText = (text, label, kind, extra = {}, cachedLines = null) => {
      const lines = cachedLines || String(text).split(/\r?\n/);
      let hereCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (results.length >= args.max_results) { stoppedEarly = true; return; }
        if (hereCount >= perFileCap) { cappedFiles++; return; }
        const at = pattern.exec(lines[i]);
        if (!at) continue;
        hereCount++;
        // Show the text AROUND the match, not the start of the line.
        //
        // Deployed applications ship minified bundles — one line, hundreds of kilobytes
        // long. Reporting "line 1" and the first 200 characters of that line meant every
        // hit on a real production build came back with the module preamble and no sign of
        // the thing being searched for. The line number alone is also useless there, so
        // the column is reported too (SRC-7).
        const line = lines[i];
        let text, column;
        if (line.length <= args.context_chars) {
          text = line.trim();
          column = at.index + 1;
        } else {
          const half = Math.floor(args.context_chars / 2);
          const from = Math.max(0, at.index - half);
          const to = Math.min(line.length, from + args.context_chars);
          text = (from > 0 ? "…" : "") + line.slice(from, to).trim() + (to < line.length ? "…" : "");
          column = at.index + 1;
        }
        results.push({
          kind, file: label, line: i + 1,
          ...(line.length > args.context_chars ? { column } : {}),
          text,
          ...extra,
        });
      }
    };

    // ── build one ranked work list, rather than draining one kind first ─────────
    //
    // Original files used to be searched to exhaustion before any script was
    // touched. On a real application that is backwards: a page with 1500 scripts and
    // one source-mapped third-party bundle answered every search out of that
    // bundle's vendor files and never looked at the application at all. So rank all
    // sources together and put likely application code first (SRC-5).
    const pageOrigin = (() => {
      try { return new URL(ctx.conn.targetUrl || "").origin; } catch (_) { return null; }
    })();
    const VENDOR = /node_modules|[/\\]vendor[/\\]|[/\\]bower_components[/\\]|_prelude|polyfill|\.min\.js/i;
    const score = url => {
      let n = 0;
      if (pageOrigin && String(url).startsWith(pageOrigin)) n += 2;
      if (VENDOR.test(url)) n -= 3;
      return n;
    };

    const sources = [];
    if (args.include_original_sources) {
      const maps = await loadAllSourceMaps(ctx, ctx.conn.client);
      for (const map of maps) {
        // A third-party bundle's original paths often look innocent — `lib/atob.js`
        // says nothing about being vendor code — so judge the bundle as a whole. If
        // its URL or any path inside it is vendor-ish, the whole map is.
        const mapIsVendor = VENDOR.test(map.scriptUrl) || (map.sources || []).some(s => VENDOR.test(s));
        for (let i = 0; i < map.sources.length; i++) {
          const content = map.sourcesContent?.[i];
          if (!content) continue;
          const label = map.sources[i];
          if (args.url_filter && !label.includes(args.url_filter) && !map.scriptUrl.includes(args.url_filter)) continue;
          // An original file is what a human wants to read, so it outranks any
          // bundle — a hit at column 40000 of minified output is nearly useless. The
          // vendor penalty still applies, which keeps a third-party bundle's original
          // files behind the application's own code.
          sources.push({ kind: "original", label, text: content,
            rank: score(label) + 3 + (mapIsVendor ? -3 : 0),
            extra: { bundle: map.scriptUrl } });
        }
      }
    }
    for (const s of ctx.scripts.values()) {
      if (args.url_filter && !s.url.includes(args.url_filter)) continue;
      sources.push({ kind: "bundle", label: s.url, scriptId: s.scriptId, rank: score(s.url), extra: { scriptId: s.scriptId } });
    }
    sources.sort((a, b) => b.rank - a.rank);

    // ── scan in ranked order, fetching ahead in parallel ───────────────────────
    // A full scan of 1500 scripts is one round trip each; serially that was five
    // seconds of waiting. Fetching a batch at a time cuts it without changing which
    // results come back, because scanning still follows the ranked order.
    const BATCH = 8;
    let index = 0;
    for (; index < sources.length && results.length < args.max_results; index += BATCH) {
      const batch = sources.slice(index, index + BATCH);
      await Promise.all(batch.map(async src => {
        if (src.text != null) return;
        try {
          src.text = await cachedSource(ctx, src.scriptId);
          src.lines = cachedSourceLines(ctx, src.scriptId, src.text);
        } catch (_) { src.text = null; }
      }));
      for (const src of batch) {
        if (results.length >= args.max_results) { stoppedEarly = true; break; }
        if (src.text == null) continue;
        if (src.kind === "original") searched.originalFiles++; else searched.scripts++;
        scanText(src.text, src.label, src.kind, src.extra, src.lines);
        src.text = null;            // scanned; let it go
      }
    }

    const unsearched = Math.max(0, sources.length - (searched.scripts + searched.originalFiles));

    return {
      query: args.query,
      count: results.length,
      searched,
      results,
      // Partial coverage has to be impossible to miss: "5 matches" reads like "there
      // are 5 places" unless it says otherwise, and acting on that is how you fix
      // the wrong file.
      ...(stoppedEarly && unsearched
        ? { truncated: true,
            note: `Stopped at max_results (${args.max_results}) — ${unsearched} of ${sources.length} sources were never searched. `
                + `These are the first matches in ranked order, not every match. Raise max_results, or narrow with url_filter.` }
        : stoppedEarly
          ? { truncated: true, note: "Hit max_results — narrow the query or raise the cap." }
          : {}),
      ...(cappedFiles
        ? { perFileCap, cappedFiles,
            note2: `${cappedFiles} file(s) had more matches than the ${perFileCap}-per-file cap that keeps results spread across files. `
                 + `Use url_filter to search one of them exhaustively.` }
        : {}),
      ...(!results.length
        ? { hint: `Searched all ${sources.length} sources and found nothing. The code may be in an eval'd chunk, a web `
                + `worker, or not loaded yet — trigger the feature once, then search again.` }
        : {}),
      nextStep: results.length
        ? "Read around a hit with source_get_script(url, start_line, end_line) or source_get_file(path), then set a breakpoint there."
        : undefined,
    };
  },
});

/**
 * Script text, remembered between calls.
 *
 * A script's contents cannot change under a given scriptId, so this is safe to keep
 * — and worth keeping: searching a real application means fetching every script it
 * loaded, which is megabytes and seconds. The second search should not pay that
 * again. Bounded by total bytes, oldest evicted first, so a long session on a large
 * app cannot grow without limit.
 */
const SOURCE_CACHE_BYTES = 32 * 1024 * 1024;

async function cachedSource(ctx, scriptId) {
  if (!scriptId) return null;
  if (!ctx.sourceCache) ctx.sourceCache = { map: new Map(), bytes: 0 };
  const cache = ctx.sourceCache;

  const hit = cache.map.get(scriptId);
  if (hit !== undefined) return hit;

  const { scriptSource } = await ctx.conn.client.Debugger.getScriptSource({ scriptId });
  const text = scriptSource || "";
  cache.map.set(scriptId, text);
  cache.bytes += text.length;
  while (cache.bytes > SOURCE_CACHE_BYTES && cache.map.size > 1) {
    const oldest = cache.map.keys().next().value;
    cache.bytes -= (cache.map.get(oldest) || "").length;
    cache.map.delete(oldest);
  }
  return text;
}
function cachedSourceLines(ctx, scriptId, text) {
  const cache = ctx.sourceCache;
  cache.lines ||= new Map();
  const hit = cache.lines.get(scriptId);
  if (hit) return hit;
  const lines = String(text).split(/\r?\n/);
  cache.lines.set(scriptId, lines);
  while (cache.lines.size > cache.map.size) cache.lines.delete(cache.lines.keys().next().value);
  return lines;
}

defineTool({
  name: "source_get_script",
  readOnly: true,
  description:
    "Read the source Chrome actually loaded, by scriptId or URL substring, optionally a line range. Lines come back "
    + "numbered so the numbers you quote to a breakpoint are the numbers you saw.",
  args: {
    script_id:  { type: "string", description: "scriptId from source_list_scripts." },
    url:        { type: "string", description: "URL substring identifying the script." },
    start_line: { type: "number", description: "First line to return (1-based).", min: 1 },
    end_line:   { type: "number", description: "Last line to return (1-based).", min: 1 },
  },
  async handler(args, ctx) {
    let script = null;
    if (args.script_id) script = ctx.scripts.get(args.script_id) || null;
    if (!script && args.url) {
      const matches = [...ctx.scripts.values()].filter(s => s.url.includes(args.url));
      if (matches.length > 1) {
        // Prefer an exact filename match over an arbitrary substring hit.
        script = matches.find(s => s.url.split("/").pop() === args.url) || matches[0];
      } else script = matches[0] || null;
    }
    if (!script) {
      fail(CODES.SCRIPT_NOT_FOUND,
        args.script_id ? `No script with id ${args.script_id}.` : `No loaded script URL contains "${args.url}".`,
        "Call source_list_scripts to see what is loaded, or source_search to find the code by content.");
    }

    const { scriptSource } = await ctx.conn.client.Debugger.getScriptSource({ scriptId: script.scriptId });
    const cut = sliceLines(scriptSource, args.start_line, args.end_line);

    return {
      scriptId: script.scriptId,
      url: script.url,
      hasSourceMap: script.hasSourceMap,
      totalLines: cut.totalLines,
      from: cut.from, to: cut.to,
      source: cut.text,
      ...(script.hasSourceMap
        ? { note: "This script has a source map — source_get_file(path) will give you the original, more readable file." }
        : {}),
    };
  },
});

defineTool({
  name: "source_list_files",
  readOnly: true,
  description:
    "List the original source files recoverable from the page's source maps — the pre-bundling file tree. Use it to "
    + "discover real file paths before calling source_get_file or setting a breakpoint on an original file.",
  args: {
    filter: { type: "string", description: "Only paths containing this substring." },
    limit:  { type: "number", description: "Maximum paths to return.", default: 200, min: 1, max: 2000 },
  },
  async handler(args, ctx) {
    const maps = await loadAllSourceMaps(ctx, ctx.conn.client);
    const files = [];
    for (const map of maps) {
      map.sources.forEach((src, i) => {
        if (args.filter && !src.includes(args.filter)) return;
        files.push({ path: src, hasContent: !!map.sourcesContent?.[i], bundle: map.scriptUrl });
      });
    }

    const scriptsWithMaps = [...ctx.scripts.values()].filter(s => s.hasSourceMap).length;
    return {
      count: Math.min(files.length, args.limit),
      matched: files.length,
      sourceMapsLoaded: maps.length,
      scriptsDeclaringSourceMaps: scriptsWithMaps,
      files: files.slice(0, args.limit),
      ...(!maps.length
        ? { warning: scriptsWithMaps
              ? "Scripts declare source maps but none could be fetched — the .map files may not be deployed. You will be reading bundled code."
              : "No script on this page ships a source map, so there are no original files to recover. source_get_script gives you what the browser actually loaded." }
        : {}),
    };
  },
});

defineTool({
  name: "source_get_file",
  readOnly: true,
  description:
    "Read an original pre-bundling source file via the page's source maps. Falls back to the loaded script when no "
    + "map is available, and always tells you which of the two you got, so a bundle line is never mistaken for an "
    + "original one.",
  args: {
    path:       { type: "string", description: "Original file path or a suffix of it, e.g. 'components/SaveButton.tsx'.", required: true },
    start_line: { type: "number", description: "First line to return (1-based).", min: 1 },
    end_line:   { type: "number", description: "Last line to return (1-based).", min: 1 },
  },
  async handler(args, ctx) {
    const maps = await loadAllSourceMaps(ctx, ctx.conn.client);

    for (const map of maps) {
      const found = sourceContentFor(map, args.path);
      if (!found) continue;
      const cut = sliceLines(found.content, args.start_line, args.end_line);
      return {
        via: "sourceMap",
        file: found.source,
        bundle: map.scriptUrl,
        sourceMap: map.url,
        totalLines: cut.totalLines,
        from: cut.from, to: cut.to,
        source: cut.text,
        note: "Original file. debugger_set_breakpoint accepts this path with original line numbers — it maps them to the bundle for you.",
      };
    }

    // Named in a map but content not inlined.
    for (const map of maps) {
      if (findSourceIndex(map, args.path) !== -1) {
        fail(CODES.SOURCEMAP_MISSING,
          `"${args.path}" is listed in ${map.url} but the map has no sourcesContent for it.`,
          "The build stripped inline sources. Read the bundle with source_get_script, or rebuild with sourcesContent enabled.",
          { bundle: map.scriptUrl });
      }
    }

    // Fall back to a loaded script with a matching URL — clearly labelled.
    const script = [...ctx.scripts.values()].find(s => s.url.includes(args.path));
    if (script) {
      const { scriptSource } = await ctx.conn.client.Debugger.getScriptSource({ scriptId: script.scriptId });
      const cut = sliceLines(scriptSource, args.start_line, args.end_line);
      return {
        via: "loadedScript",
        file: script.url,
        scriptId: script.scriptId,
        totalLines: cut.totalLines,
        from: cut.from, to: cut.to,
        source: cut.text,
        sourceMapAvailable: false,
        warning: "This is the script as the browser loaded it, NOT an original pre-bundling file. Line numbers here are bundle line numbers.",
      };
    }

    fail(CODES.SCRIPT_NOT_FOUND, `Nothing matches "${args.path}".`,
      maps.length
        ? "Call source_list_files to see the recoverable original paths."
        : "This page ships no usable source maps. Use source_search to find the code, then source_get_script to read it.");
  },
});
