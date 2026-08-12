// ─── Source maps ─────────────────────────────────────────────────────────────
// v4 claimed "reads the original file, not the minified bundle" but only ever
// handled inline `data:` maps: `sourceMapCache` was declared and read and never
// written, and external .map URLs hit a bare `continue` with the comment
// "Can't fetch external maps from here without HTTP; skip". (SRC-2)
//
// Two things make this work properly now:
//   1. the map is fetched *through the page* (Runtime.evaluate + fetch), so
//      cookies, auth headers and same-origin rules apply exactly as they do for
//      the app. Fetching from node would 401 on any protected asset.
//   2. mappings are decoded, so a bundle position can be translated to an
//      original file:line and back again — which is what makes source-mapped
//      breakpoints possible (SRC-3).
//
// No dependency is added for this; base64-VLQ is ~30 lines.

import { log } from "../core/log.js";

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_MAP = new Map([...B64].map((c, i) => [c, i]));

/** Decode one base64-VLQ segment list, e.g. "AAgBC". */
function decodeVLQ(str) {
  const out = [];
  let shift = 0, value = 0;
  for (const ch of str) {
    const digit = B64_MAP.get(ch);
    if (digit === undefined) return out;              // malformed; stop cleanly
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) { shift += 5; continue; }
    const negative = value & 1;
    value >>= 1;
    out.push(negative ? -value : value);
    value = 0; shift = 0;
  }
  return out;
}

/**
 * Decode the `mappings` field into a per-generated-line array of segments:
 *   { genCol, srcIndex, srcLine, srcCol, nameIndex }   (all 0-based)
 */
export function decodeMappings(mappings) {
  const lines = [];
  let srcIndex = 0, srcLine = 0, srcCol = 0, nameIndex = 0;

  for (const lineStr of String(mappings || "").split(";")) {
    const segments = [];
    let genCol = 0;
    if (lineStr) {
      for (const segStr of lineStr.split(",")) {
        if (!segStr) continue;
        const f = decodeVLQ(segStr);
        if (!f.length) continue;
        genCol += f[0];
        const seg = { genCol };
        if (f.length >= 4) {
          srcIndex += f[1]; srcLine += f[2]; srcCol += f[3];
          seg.srcIndex = srcIndex; seg.srcLine = srcLine; seg.srcCol = srcCol;
        }
        if (f.length >= 5) { nameIndex += f[4]; seg.nameIndex = nameIndex; }
        segments.push(seg);
      }
      segments.sort((a, b) => a.genCol - b.genCol);
    }
    lines.push(segments);
  }
  return lines;
}

function resolveMapUrl(sourceMapURL, scriptUrl) {
  if (!sourceMapURL) return null;
  if (sourceMapURL.startsWith("data:")) return sourceMapURL;
  try { return new URL(sourceMapURL, scriptUrl).href; }
  catch (_) { return sourceMapURL; }
}

function parseInline(dataUrl) {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return null;
  const meta = dataUrl.slice(0, comma);
  const body = dataUrl.slice(comma + 1);
  const raw = /base64/i.test(meta)
    ? Buffer.from(body, "base64").toString("utf8")
    : decodeURIComponent(body);
  return JSON.parse(raw);
}

/** Fetch text from inside the page so credentials/cookies apply. */
async function fetchViaPage(conn, url) {
  const { result, exceptionDetails } = await conn.eval(
    `fetch(${JSON.stringify(url)},{credentials:"include"})
      .then(r => r.ok ? r.text() : Promise.reject(new Error("HTTP "+r.status)))`,
    { awaitPromise: true, timeoutMs: 15000, label: "source map fetch" });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || "fetch failed");
  return result.value;
}

/**
 * Load (and cache) the source map for a script record.
 * @returns {Promise<object|null>} { url, sources, sourcesContent, decoded, raw }
 */
export async function loadSourceMap(ctx, client, script) {
  if (!script?.sourceMapURL) return null;

  const mapUrl = resolveMapUrl(script.sourceMapURL, script.url);
  if (ctx.sourceMaps.has(mapUrl)) return ctx.sourceMaps.get(mapUrl);

  let parsed;
  try {
    parsed = mapUrl.startsWith("data:") ? parseInline(mapUrl) : JSON.parse(await fetchViaPage(ctx.conn, mapUrl));
  } catch (e) {
    log.warn("sourcemap", `could not load ${String(mapUrl).slice(0, 120)}: ${e.message}`);
    ctx.sourceMaps.set(mapUrl, null);
    return null;
  }

  if (!parsed || !Array.isArray(parsed.sources)) {
    ctx.sourceMaps.set(mapUrl, null);
    return null;
  }

  const entry = {
    url: mapUrl,
    scriptUrl: script.url,
    sourceRoot: parsed.sourceRoot || "",
    sources: parsed.sources.map(s => (parsed.sourceRoot ? joinRoot(parsed.sourceRoot, s) : s)),
    sourcesContent: parsed.sourcesContent || [],
    names: parsed.names || [],
    decoded: decodeMappings(parsed.mappings),
    hasContent: Array.isArray(parsed.sourcesContent) && parsed.sourcesContent.some(Boolean),
  };
  ctx.sourceMaps.set(mapUrl, entry);
  log.info("sourcemap", `loaded ${entry.sources.length} sources`, { map: mapUrl.slice(0, 100), inlineContent: entry.hasContent });
  return entry;
}

const joinRoot = (root, s) =>
  /^([a-z]+:)?\/\//i.test(s) ? s : `${String(root).replace(/\/$/, "")}/${String(s).replace(/^\//, "")}`;

/** Every source map we can reach for the current page. */
export async function loadAllSourceMaps(ctx, client) {
  const withMaps = [...ctx.scripts.values()].filter(s => s.sourceMapURL);
  const maps = [];
  for (const script of withMaps) {
    const m = await loadSourceMap(ctx, client, script);
    if (m) maps.push(m);
  }
  return maps;
}

/** Bundle position → original position. Lines in, lines out, all 1-based. */
export function originalPositionFor(map, generatedLine1, generatedColumn1 = 1) {
  const line0 = generatedLine1 - 1, col0 = generatedColumn1 - 1;
  const segments = map.decoded?.[line0];
  if (!segments?.length) return null;

  let best = null;
  for (const seg of segments) {
    if (seg.srcIndex === undefined) continue;
    if (seg.genCol <= col0) best = seg;
    else break;
  }
  best = best || segments.find(s => s.srcIndex !== undefined);
  if (!best) return null;

  return {
    source: map.sources[best.srcIndex] || null,
    line: best.srcLine + 1,
    column: best.srcCol + 1,
    name: best.nameIndex != null ? map.names[best.nameIndex] : undefined,
  };
}

/**
 * Original position → bundle position (SRC-3). Picks the closest mapping at or
 * after the requested original line, which is what a breakpoint needs.
 */
export function generatedPositionFor(map, sourcePath, originalLine1) {
  const srcIndex = findSourceIndex(map, sourcePath);
  if (srcIndex === -1) return null;

  const wanted = originalLine1 - 1;
  let best = null;

  for (let genLine = 0; genLine < map.decoded.length; genLine++) {
    for (const seg of map.decoded[genLine]) {
      if (seg.srcIndex !== srcIndex || seg.srcLine === undefined) continue;
      if (seg.srcLine < wanted) continue;
      const candidate = { generatedLine: genLine + 1, generatedColumn: seg.genCol + 1, srcLine: seg.srcLine };
      if (!best
        || seg.srcLine < best.srcLine
        || (seg.srcLine === best.srcLine && candidate.generatedLine < best.generatedLine)) {
        best = candidate;
      }
    }
  }
  if (!best) return null;
  return {
    generatedLine: best.generatedLine,
    generatedColumn: best.generatedColumn,
    matchedOriginalLine: best.srcLine + 1,
    exact: best.srcLine === wanted,
  };
}

export function findSourceIndex(map, sourcePath) {
  if (!map?.sources) return -1;
  const needle = String(sourcePath).replace(/\\/g, "/").toLowerCase();
  let exact = -1, suffix = -1, loose = -1;
  map.sources.forEach((s, i) => {
    const norm = String(s).replace(/\\/g, "/").toLowerCase();
    if (norm === needle) exact = i;
    else if (norm.endsWith("/" + needle) || norm.endsWith(needle)) { if (suffix === -1) suffix = i; }
    else if (norm.includes(needle)) { if (loose === -1) loose = i; }
  });
  return exact !== -1 ? exact : suffix !== -1 ? suffix : loose;
}

/** Original file content, if the map carries it. */
export function sourceContentFor(map, sourcePath) {
  const i = findSourceIndex(map, sourcePath);
  if (i === -1) return null;
  const content = map.sourcesContent?.[i];
  return content ? { source: map.sources[i], content, index: i } : null;
}
