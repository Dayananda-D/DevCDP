// ─── Scope inspection ────────────────────────────────────────────────────────
// v4 read variables as `p.value?.value ?? p.value?.description` (DBG-4), so the
// one thing the deck promised to show you — "tell me what formData looks like" —
// came back as the string "Object". Capped at 3 frames / 4 scopes / 25 props with
// no indication anything had been cut.
//
// Here: bounded recursive expansion with an explicit property budget, and
// `_truncated` markers wherever we stopped, so the model is never guessing about
// whether it saw the whole value.

const SKIP_PROPS = /^(__proto__|constructor)$/;

/** Turn a CDP RemoteObject into a plain JS value, expanding objects/arrays. */
export async function expandRemote(client, remote, opts = {}) {
  const { depth = 2, maxProps = 30, budget = { calls: 60 } } = opts;

  if (!remote) return undefined;
  if (remote.type === "undefined") return undefined;
  if (remote.type === "function")  return `ƒ ${remote.description?.split("\n")[0]?.slice(0, 80) || "function"}`;
  if (remote.type === "symbol")    return remote.description;
  if (remote.type === "bigint")    return remote.description;

  // Primitives arrive by value.
  if (remote.type !== "object") return remote.value !== undefined ? remote.value : remote.description;

  if (remote.subtype === "null")  return null;
  if (remote.subtype === "error") return { _error: remote.description?.split("\n").slice(0, 3).join(" ") };
  if (remote.subtype === "date" || remote.subtype === "regexp") return remote.description;
  if (remote.subtype === "node")  return { _node: remote.description };

  if (remote.value !== undefined) return remote.value;      // already serialised
  if (!remote.objectId)           return remote.description;

  if (depth <= 0 || budget.calls <= 0) {
    return { _truncated: depth <= 0 ? "max depth reached" : "expansion budget exhausted",
             _preview: remote.description };
  }

  budget.calls--;

  let props;
  try {
    const res = await client.Runtime.getProperties({
      objectId: remote.objectId, ownProperties: true, generatePreview: false,
    });
    props = res.result || [];
  } catch (e) {
    return { _unreadable: e.message, _preview: remote.description };
  }

  const isArray = remote.subtype === "array";
  const usable  = props.filter(p => p.enumerable !== false && !SKIP_PROPS.test(p.name));
  const shown   = usable.slice(0, maxProps);

  const out = isArray ? [] : {};
  for (const p of shown) {
    const v = await expandRemote(client, p.value, { depth: depth - 1, maxProps, budget });
    if (isArray && /^\d+$/.test(p.name)) out[Number(p.name)] = v;
    else out[p.name] = v;
  }

  if (usable.length > shown.length) {
    const marker = `${usable.length - shown.length} more propert${usable.length - shown.length === 1 ? "y" : "ies"} not shown`;
    if (isArray) out.push({ _truncated: marker });
    else out._truncated = marker;
  }
  return out;
}

/**
 * Capture the scope chain of one call frame.
 * `global` is skipped by default — it is thousands of properties of noise.
 */
export async function captureFrameScope(client, frame, opts = {}) {
  // Depth 3 by default because real locals nest that far before they stop being
  // useful: an object holding an array of records needs object → array → record.
  // The call budget, not the depth, is what keeps this bounded.
  // The call budget bounds round trips, not size — and those are different limits.
  // Measured on a real application: one paused frame of framework code expanded to
  // 79 KB, because `this` was a framework singleton and the closure held most of the
  // library. Bounded, but useless to read and five times the response budget. So
  // there is a byte budget too: a variable too large to be worth printing is replaced
  // by what it is, which is the part you actually needed before deciding to look
  // inside it.
  const {
    depth = 3, maxProps = 30, includeGlobal = false,
    budget = { calls: 220 },
    maxBytes = 10000,       // the whole snapshot for this frame
    maxVarBytes = 3000,     // any single variable
  } = opts;

  const sizeOf = v => Buffer.byteLength(JSON.stringify(v ?? null), "utf8");

  /** What a value is, from metadata Chrome already sent — costs no round trip. */
  const summarise = (remote, why) => ({
    _summary: remote?.className || remote?.subtype || remote?.type || "unknown",
    ...(remote?.description && remote.description.length <= 120 ? { description: remote.description } : {}),
    _why: why,
  });

  const scopes = {};
  const summarised = [];
  let spent = 0;
  const chain  = (frame.scopeChain || []).filter(s => includeGlobal || s.type !== "global");

  for (const scope of chain) {
    if (!scope.object?.objectId) continue;
    const name = scopes[scope.type] ? `${scope.type}#${Object.keys(scopes).length}` : scope.type;
    try {
      // Expand the *variables*, not the scope container. Treating the scope object
      // itself as a depth level cost one level of every local, so a local holding
      // { lines: [ ... ] } came back with `lines` already truncated.
      const { result } = await client.Runtime.getProperties({
        objectId: scope.object.objectId, ownProperties: true, generatePreview: false,
      });
      const vars = {};
      for (const p of (result || []).filter(p => !SKIP_PROPS.test(p.name)).slice(0, maxProps)) {
        if (spent >= maxBytes) {
          vars[p.name] = summarise(p.value, "snapshot byte budget spent");
          summarised.push(`${name}.${p.name}`);
          continue;
        }
        const expanded = await expandRemote(client, p.value, { depth, maxProps, budget });
        const bytes = sizeOf(expanded);
        if (bytes > maxVarBytes) {
          vars[p.name] = summarise(p.value, `${bytes} bytes expanded — too large to print`);
          summarised.push(`${name}.${p.name}`);
          spent += 200;
        } else {
          vars[p.name] = expanded;
          spent += bytes;
        }
      }
      scopes[name] = vars;
    } catch (e) {
      scopes[name] = { _unreadable: e.message };
    }
  }

  // `this` is frequently the answer and was never captured in v4.
  if (frame.this?.objectId || frame.this?.value !== undefined) {
    try {
      const self = await expandRemote(client, frame.this, { depth: 1, maxProps, budget });
      const bytes = sizeOf(self);
      if (bytes > maxVarBytes) {
        scopes.this = summarise(frame.this, `${bytes} bytes expanded — too large to print`);
        summarised.push("this");
      } else {
        scopes.this = self;
      }
    } catch (_) {}
  }

  if (summarised.length) {
    scopes._summarised = summarised.slice(0, 20);
    scopes._note = `${summarised.length} variable(s) were too large to print and are shown as what they are. `
      + `Read one for real with debugger_evaluate_at_frame('<name>.<property>').`;
  }

  return scopes;
}
