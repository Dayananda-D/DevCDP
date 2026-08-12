// ─── Tool definition layer (ARCH-2) ──────────────────────────────────────────
// One declaration per tool owns: description, arg schema, defaults, validation
// and response shape. This exists because v4 let those drift apart:
//
//   TOOL-1  lean() stripped any key called `tabs` → list_tabs returned only a count
//   TOOL-3  `quiet` claimed to halve tokens but only removed 3 keys nothing emitted
//   TOOL-4  11 debugger_* tools shipped with no description at all
//   TOOL-5  schema said timeout 3000 / limit 20; code used 15000 / 50
//   MEM-2   required args were never validated → "### [undefined] undefined"
//
// Rules enforced here, at registration time (fails fast at startup, not in prod):
//   • every tool has a non-trivial description
//   • every arg has a type and a description
//   • defaults live in ONE place and are applied to incoming args
//   • required args are validated before the handler runs
//   • responses are shaped by an explicit `compact` projection, never by
//     blind key deletion

import { DevCdpError, CODES, fail } from "./errors.js";

const registry = new Map();

/**
 * @param {object} def
 * @param {string}  def.name
 * @param {string}  def.description   what it does + when to reach for it
 * @param {object=} def.args          { [name]: ArgSpec }
 * @param {Function} def.handler      (args, ctx) => object
 * @param {Function=} def.compact     (result) => result   applied when verbose:false
 * @param {boolean=} def.needsClient  auto-attach/reconnect before running
 * @param {boolean=} def.readOnly     does not mutate page or session state
 *
 * ArgSpec: { type, description, default?, required?, enum?, items?, min?, max? }
 */
export function defineTool(def) {
  const { name, description, args = {}, handler } = def;

  if (!name)                       throw new Error("defineTool: name is required");
  if (registry.has(name))          throw new Error(`defineTool: duplicate tool "${name}"`);
  if (typeof handler !== "function") throw new Error(`defineTool(${name}): handler must be a function`);
  if (!description || description.trim().length < 20)
    throw new Error(`defineTool(${name}): description must be a real sentence (TOOL-4)`);

  for (const [argName, spec] of Object.entries(args)) {
    if (!spec.type)
      throw new Error(`defineTool(${name}.${argName}): type is required`);
    if (!spec.description)
      throw new Error(`defineTool(${name}.${argName}): description is required`);
    if (spec.required && "default" in spec)
      throw new Error(`defineTool(${name}.${argName}): required args cannot have a default`);
  }

  registry.set(name, {
    needsClient: true,
    readOnly:    false,
    compact:     null,
    ...def,
    args,
  });
  return def;
}

/** Every tool has `verbose` — opt into the unabridged payload. */
const VERBOSE_ARG = {
  type: "boolean",
  description: "Return the full payload instead of the compact projection. Default false.",
  default: false,
};

function toJsonSchema(args, { includeVerbose = false } = {}) {
  const properties = {};
  const required   = [];

  // `verbose` is only advertised by tools that actually have a compact projection.
  // It was on all 60 tools while none had one: 7.4 KB of schema — about 2,000
  // tokens — paid in every conversation for an argument that did nothing.
  for (const [argName, spec] of Object.entries(includeVerbose ? { ...args, verbose: VERBOSE_ARG } : args)) {
    const p = { type: spec.type, description: spec.description };
    if (spec.enum)          p.enum    = spec.enum;
    if (spec.items)         p.items   = spec.items;
    if ("default" in spec)  p.default = spec.default;
    if (spec.min != null)   p.minimum = spec.min;
    if (spec.max != null)   p.maximum = spec.max;
    properties[argName] = p;
    if (spec.required) required.push(argName);
  }

  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** The list handed to the MCP client. */
export function listTools() {
  return [...registry.values()].map(t => ({
    name:        t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.args, { includeVerbose: typeof t.compact === "function" }),
  }));
}

export function getTool(name) { return registry.get(name) || null; }
export function allTools()    { return [...registry.values()]; }

const TYPE_OK = {
  string:  v => typeof v === "string",
  number:  v => typeof v === "number" && Number.isFinite(v),
  boolean: v => typeof v === "boolean",
  array:   v => Array.isArray(v),
  object:  v => v !== null && typeof v === "object" && !Array.isArray(v),
};

/**
 * Resolve incoming args against the declared schema.
 * MCP clients do NOT apply schema defaults, so we must (TOOL-5).
 */
export function resolveArgs(tool, raw = {}) {
  // Accepted whether advertised or not, so passing it is never an error.
  const spec = { ...tool.args, verbose: VERBOSE_ARG };
  const out  = {};
  const problems = [];

  const unknown = Object.keys(raw).filter(k => !(k in spec) && k !== "quiet");
  if (unknown.length) problems.push(`unknown argument(s): ${unknown.join(", ")}`);

  for (const [argName, s] of Object.entries(spec)) {
    const given = raw[argName];

    if (given === undefined || given === null) {
      if (s.required) { problems.push(`missing required argument "${argName}" (${s.description})`); continue; }
      if ("default" in s) out[argName] = s.default;
      continue;
    }

    if (TYPE_OK[s.type] && !TYPE_OK[s.type](given)) {
      problems.push(`"${argName}" must be a ${s.type}, got ${Array.isArray(given) ? "array" : typeof given}`);
      continue;
    }
    if (s.enum && !s.enum.includes(given)) {
      problems.push(`"${argName}" must be one of: ${s.enum.join(", ")} (got ${JSON.stringify(given)})`);
      continue;
    }
    if (s.type === "number") {
      if (s.min != null && given < s.min) { problems.push(`"${argName}" must be >= ${s.min}`); continue; }
      if (s.max != null && given > s.max) { problems.push(`"${argName}" must be <= ${s.max}`); continue; }
    }
    if (s.type === "string" && s.required && given.trim() === "") {
      problems.push(`"${argName}" must not be empty`); continue;
    }

    out[argName] = given;
  }

  if (problems.length) {
    fail(CODES.BAD_ARGS, `Invalid arguments for ${tool.name}: ${problems.join("; ")}`,
      `Check the tool schema — ${Object.keys(tool.args).length ? "expected: " + Object.keys(tool.args).join(", ") : "this tool takes no arguments"}.`);
  }
  return out;
}

/** Shape the response. Compaction is opt-out and never removes the payload. */
export function shape(tool, result, args) {
  if (result && result.ok === false) return result;               // errors pass through
  const body = result && typeof result === "object" ? result : { value: result };
  const projected = (!args?.verbose && tool.compact) ? tool.compact(body) : body;
  return { ok: true, ...projected };
}

/**
 * Keep a response within a byte budget.
 *
 * Individual tools have their own limits, but limits set per tool are limits a new
 * tool can forget. This is the one place every response passes through, so an
 * expensive payload is bounded by construction — and bounded *honestly*: what was
 * dropped is stated, along with the argument that would fetch it.
 *
 * Arrays are trimmed first (usually the bulk), then long strings, and scalar
 * fields — ok, code, message, hint — are never touched.
 */
export function capResponse(payload, maxBytes, toolName) {
  if (!maxBytes || maxBytes <= 0) return payload;
  const size = v => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");
  if (size(payload) <= maxBytes) return payload;

  // Deep copy, not a spread: pruning now reaches into nested objects, and some
  // responses hand back state the context keeps — `debugger_get_capture` returns the
  // stored capture — so trimming in place would quietly damage the original and every
  // later read of it. Only paid on the rare oversized response.
  const out = JSON.parse(JSON.stringify(payload));
  const dropped = [];

  // Largest arrays first — one big list is usually the whole problem.
  const arrays = Object.entries(out)
    .filter(([, v]) => Array.isArray(v) && v.length > 1)
    .sort((a, b) => size(b[1]) - size(a[1]));

  for (const [key, arr] of arrays) {
    if (size(out) <= maxBytes) break;
    let kept = arr.length;
    while (kept > 1 && size(out) > maxBytes) {
      kept = Math.max(1, Math.floor(kept * 0.6));
      out[key] = arr.slice(0, kept);
    }
    if (kept < arr.length) dropped.push({ field: key, kept, of: arr.length });
  }

  // Then the longest string, which is how a whole-file read blows the budget.
  if (size(out) > maxBytes) {
    const strings = Object.entries(out)
      .filter(([, v]) => typeof v === "string" && v.length > 400)
      .sort((a, b) => b[1].length - a[1].length);
    for (const [key, str] of strings) {
      if (size(out) <= maxBytes) break;
      const room = Math.max(400, str.length - (size(out) - maxBytes) - 200);
      out[key] = str.slice(0, room);
      dropped.push({ field: key, keptChars: room, ofChars: str.length });
    }
  }

  // ── nested content, which is where the cap used to fail silently ───────────
  //
  // The two passes above only see top-level keys. Measured against a real
  // application, a single paused frame of framework code weighed 79 KB — one object,
  // nested — so trimming the frames array from two to one "capped" an 83 KB response
  // to 82 KB and reported success. A budget that holds only for flat lists of small
  // rows is not a budget. Prune the heaviest node anywhere in the tree, repeatedly,
  // until the whole payload fits.
  if (size(out) > maxBytes) {
    const getAt = p => p.reduce((n, k) => (n == null ? n : n[k]), out);
    const setAt = (p, v) => { const parent = getAt(p.slice(0, -1)); if (parent) parent[p.at(-1)] = v; };
    const show = p => p.reduce((s, k) => s + (typeof k === "number" ? `[${k}]` : (s ? `.${k}` : k)), "");

    const candidates = () => {
      const acc = [];
      const walk = (node, path) => {
        if (Array.isArray(node)) {
          if (node.length > 1 && path.length) acc.push({ path, kind: "array", bytes: size(node), count: node.length });
          node.forEach((v, i) => walk(v, path.concat(i)));
        } else if (node && typeof node === "object") {
          const keys = Object.keys(node);
          if (path.length && keys.length > 1) acc.push({ path, kind: "object", bytes: size(node), count: keys.length });
          for (const k of keys) if (k !== "_truncated") walk(node[k], path.concat(k));
        } else if (typeof node === "string" && node.length > 200 && path.length) {
          acc.push({ path, kind: "string", bytes: size(node), count: node.length });
        }
      };
      walk(out, []);
      return acc.sort((a, b) => b.bytes - a.bytes);
    };

    const pruned = [];
    for (let pass = 0; pass < 200 && size(out) > maxBytes; pass++) {
      const list = candidates();
      if (!list.length) break;
      // A parent always weighs more than the child inside it, so "heaviest" alone
      // would prune `frames[0]` and throw away the file, line and function name along
      // with the bulk. Among nodes of comparable weight, take the deepest: the shell
      // that tells you where you are survives, and only the deep detail is summarised.
      const heaviest = list[0];
      const worst = list.filter(c => c.bytes >= heaviest.bytes * 0.5)
        .sort((a, b) => b.path.length - a.path.length)[0] || heaviest;
      const at = show(worst.path);
      if (worst.kind === "array") {
        const arr = getAt(worst.path);
        const kept = Math.max(1, Math.floor(arr.length / 2));
        setAt(worst.path, arr.slice(0, kept));
        pruned.push({ at, kept, of: worst.count });
      } else if (worst.kind === "string") {
        setAt(worst.path, String(getAt(worst.path)).slice(0, 200));
        pruned.push({ at, keptChars: 200, ofChars: worst.count });
      } else {
        // Replace a heavy object with something that still says what was there, so
        // the model can go and fetch the part it actually needs.
        const node = getAt(worst.path);
        const keys = Object.keys(node);
        const keep = {};
        for (const k of keys) {
          const v = node[k];
          if (v == null || typeof v === "number" || typeof v === "boolean") keep[k] = v;
          else if (typeof v === "string" && v.length <= 80) keep[k] = v;
          if (Object.keys(keep).length >= 4) break;
        }
        setAt(worst.path, { ...keep, _omitted: `${keys.length} properties, ${worst.bytes} bytes` });
        pruned.push({ at, replacedWith: "summary", of: `${keys.length} properties` });
      }
    }

    if (pruned.length) {
      dropped.push(...pruned.slice(0, 12));
      if (pruned.length > 12) dropped.push({ andFurther: pruned.length - 12 });
    }

    // Backstop. Nothing realistic reaches this, but the cap must be a fact rather
    // than an intention, so a pathological payload loses its nested content entirely
    // instead of being sent oversized.
    if (size(out) > maxBytes) {
      for (const k of Object.keys(out)) {
        const v = out[k];
        if (k === "_truncated") continue;
        if (v && typeof v === "object") { delete out[k]; dropped.push({ field: k, removed: "did not fit" }); }
      }
    }
  }

  if (dropped.length) {
    out._truncated = {
      reason: `response exceeded maxResponseBytes (${maxBytes})`,
      dropped,
      hint: "Narrow the request instead of raising the cap: use a filter, a smaller limit, "
          + "start_line/end_line, or paging via offset/cursor. Raise maxResponseBytes in settings only if you must.",
      tool: toolName,
    };
  }
  return out;
}

/** Startup self-check so a bad definition can never reach a user. */
export function assertRegistryHealthy() {
  const problems = [];
  for (const t of registry.values()) {
    if (!t.description) problems.push(`${t.name}: no description`);
    for (const [a, s] of Object.entries(t.args)) {
      if (!s.description) problems.push(`${t.name}.${a}: no description`);
    }
  }
  if (problems.length) throw new Error("Tool registry unhealthy:\n  " + problems.join("\n  "));
  return { tools: registry.size };
}
