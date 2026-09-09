// ─── Debugger tools ──────────────────────────────────────────────────────────
// This group had no descriptions at all in v4 (TOOL-4) — eleven tools exposed to
// the model as bare names, for the capability the product called its
// differentiator.
//
// DBG-1 was the dangerous one: setBreakpointByUrl accepts any URL, so passing a
// filename that does not exist returned a breakpointId and a `resolvedLine` that
// echoed the requested line. A breakpoint that could never bind looked identical
// to one that had. Verified live: {url:'saveHandler.js', line:247} on an app with
// no such file reported success.
//
// Here a breakpoint is only "bound" if Chrome resolved it to a real location, the
// URL substring is resolved to an exact script URL first, and original file paths
// are translated through the source map (SRC-3).

import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";
import { captureFrameScope, expandRemote } from "../debug/scope.js";
import { loadAllSourceMaps, generatedPositionFor, originalPositionFor, findSourceIndex } from "../debug/sourcemap.js";

const requirePaused = ctx => {
  if (!ctx.pause.active || !ctx.pause.callFrames) {
    fail(CODES.NOT_PAUSED, "The debugger is not paused.",
      "Set a breakpoint, trigger the code path, then call this. debugger_get_capture holds the values from the last pause even after resuming.");
  }
};

defineTool({
  name: "debugger_set_breakpoint",
  destructive: false,
  description:
    "Set a breakpoint and report honestly whether Chrome could bind it. Accepts either a loaded script URL (a "
    + "substring is resolved to the exact script) or an original pre-bundling file path, which is translated through "
    + "the source map. Set auto_resume:true when the action is being driven by an automation tool, so the page does "
    + "not stay frozen and time that action out.",
  args: {
    url:         { type: "string",  description: "Script URL, URL substring, or original source path.", required: true },
    line:        { type: "number",  description: "1-based line number, as shown by source_get_script / source_get_file.", required: true },
    column:      { type: "number",  description: "1-based column, when several statements share a line.", min: 1 },
    condition:   { type: "string",  description: "JavaScript condition — pause only when it is truthy, e.g. 'id === 42'." },
    auto_resume: { type: "boolean", description:
      "Default true: capture scope/console/network on hit, then resume, so the page is never left frozen and the action "
      + "that tripped it completes. Pass false to hold the pause for stepping; released after maxPauseMs regardless.",
      default: true },
  },
  async handler(args, ctx) {
    const client = ctx.conn.client;
    let targetUrl = null, targetLine = args.line, translation = null;

    // ── 1. original source path? translate through the source map (SRC-3) ──
    const maps = await loadAllSourceMaps(ctx, client);
    for (const map of maps) {
      if (findSourceIndex(map, args.url) === -1) continue;
      const gen = generatedPositionFor(map, args.url, args.line);
      if (!gen) {
        fail(CODES.SOURCEMAP_MISSING,
          `"${args.url}" is in the source map but line ${args.line} has no generated mapping.`,
          "Pick a line with an executable statement — blank lines, comments and type-only lines are not mapped.");
      }
      targetUrl  = map.scriptUrl;
      targetLine = gen.generatedLine;
      translation = {
        from: { file: args.url, line: args.line },
        to:   { bundle: map.scriptUrl, line: gen.generatedLine, column: gen.generatedColumn },
        exact: gen.exact,
        ...(gen.exact ? {} : { note: `Line ${args.line} is not directly mapped; used the nearest mapped line (original ${gen.matchedOriginalLine}).` }),
      };
      break;
    }

    // ── 2. otherwise resolve the substring to an exact loaded script URL ──
    if (!targetUrl) {
      const exact = [...ctx.scripts.values()].find(s => s.url === args.url);
      if (exact) targetUrl = exact.url;
      else {
        const matches = [...ctx.scripts.values()].filter(s => s.url.includes(args.url));
        if (!matches.length) {
          fail(CODES.SCRIPT_NOT_FOUND,
            `No loaded script matches "${args.url}", and it is not an original file in any source map. A breakpoint here could never bind.`,
            "Find the file first: source_search('<function name>') or source_list_scripts('<partial url>').",
            { scriptsLoaded: ctx.scripts.size });
        }
        const byFilename = matches.filter(s => s.url.split("?")[0].split("/").pop() === args.url);
        const chosen = byFilename[0] || matches[0];
        targetUrl = chosen.url;
        if (matches.length > 1) {
          translation = { resolvedFrom: args.url, note: `${matches.length} scripts matched; used ${chosen.url}.`,
            alternatives: matches.filter(s => s.url !== chosen.url).slice(0, 5).map(s => s.url) };
        }
      }
    }

    let res;
    try {
      res = await client.Debugger.setBreakpointByUrl({
        url: targetUrl,
        lineNumber: targetLine - 1,
        columnNumber: args.column != null ? args.column - 1 : 0,
        ...(args.condition ? { condition: args.condition } : {}),
      });
    } catch (e) {
      // Setting the same breakpoint twice is a normal thing for an agent to do —
      // it should be idempotent, not a raw CDP error.
      if (/already exists/i.test(e.message || "")) {
        const existing = [...ctx.desired.breakpoints.values()]
          .find(b => b.url === targetUrl && b.line === targetLine);
        if (existing) {
          // The latest call wins, so re-setting the same breakpoint is how you
          // change whether it holds — otherwise a hold could never be revoked.
          existing.autoResume = args.auto_resume;
          return {
            breakpointId: existing.breakpointId,
            bound: existing.bound,
            alreadySet: true,
            url: existing.url,
            resolvedLine: existing.locations?.[0]?.line ?? existing.line,
            autoResume: existing.autoResume,
            note: "A breakpoint was already set at this location; returning the existing one.",
          };
        }
      }
      fail(CODES.INTERNAL, `Chrome rejected the breakpoint: ${e.message}`,
        "Call debugger_list_breakpoints to see what is already set, or debugger_remove_all_breakpoints to start clean.");
    }

    const locations = (res.locations || []).map(l => ({
      scriptId: l.scriptId, line: l.lineNumber + 1, column: l.columnNumber + 1,
    }));
    const bound = locations.length > 0;

    const key = `${targetUrl}:${targetLine}`;
    ctx.desired.breakpoints.set(key, {
      key, url: targetUrl, line: targetLine, column: args.column,
      condition: args.condition || null,
      autoResume: args.auto_resume,
      breakpointId: res.breakpointId, bound, locations,
      requestedAs: args.url, requestedLine: args.line,
    });

    // The overlay reports the same truth the tool does: a breakpoint that will never
    // fire says so on the page, rather than looking identical to one that will.
    const where = `${(targetUrl.split("/").pop() || targetUrl)}:${targetLine}`;
    ctx.conn.setBadge(
      bound ? `breakpoint set — ${where}` : `breakpoint UNBOUND — ${where} will never be hit`,
      bound ? "busy" : "err");

    if (!bound) {
      // DBG-1 — v4 reported success here. Never again.
      const near = [...ctx.scripts.values()].filter(s => s.url.includes(args.url.split("/").pop() || args.url)).slice(0, 5);
      return {
        breakpointId: res.breakpointId,
        bound: false,
        url: targetUrl,
        line: targetLine,
        warning: "Chrome accepted this breakpoint but could not resolve it to any executable location, so it will NEVER be hit.",
        likelyCauses: [
          `Line ${targetLine} has no executable statement (blank, comment, or a declaration only).`,
          "The URL does not exactly match a loaded script.",
          "The script has not loaded yet — it may be lazily imported.",
        ],
        suggestion: "Confirm the line with source_get_script(url, start_line, end_line) and pick a statement line, then set it again.",
        ...(near.length ? { similarScripts: near.map(s => s.url) } : {}),
        ...(translation ? { translation } : {}),
      };
    }

    // Map the bound location back to the original file, so the reply speaks the
    // same language the developer does.
    let originalLocation = null;
    for (const map of maps) {
      if (map.scriptUrl !== targetUrl) continue;
      originalLocation = originalPositionFor(map, locations[0].line, locations[0].column);
      if (originalLocation) break;
    }

    return {
      breakpointId: res.breakpointId,
      bound: true,
      url: targetUrl,
      requestedLine: args.line,
      resolvedLine: locations[0].line,
      ...(locations[0].line !== targetLine ? { note: `Chrome moved the breakpoint to line ${locations[0].line}, the next executable statement.` } : {}),
      locations,
      condition: args.condition || null,
      autoResume: args.auto_resume,
      ...(originalLocation ? { originalLocation } : {}),
      ...(translation ? { translation } : {}),
      nextStep: "Trigger the code path, then call debugger_get_capture for scope, logs and network from the pause.",
    };
  },
});

defineTool({
  name: "debugger_set_breakpoint_at_function",
  destructive: false,
  description:
    "Set a breakpoint on a function you can name, without knowing which file it lives in. Give any expression that "
    + "evaluates to a function — 'app.saveOrder', 'MyClass.prototype.load', a framework helper — and DevCDP finds its "
    + "definition and breaks at its first statement. Use this when you know what runs but not where it is defined; "
    + "use debugger_set_breakpoint when you already have a file and line.",
  args: {
    function_expression: { type: "string", required: true, description:
      "JavaScript evaluating to the function itself — no call parentheses. For example 'app.store.save', not 'app.store.save()'." },
    condition:   { type: "string", description: "JavaScript condition — pause only when it is truthy, e.g. 'id === 42'." },
    auto_resume: { type: "boolean", default: true, description:
      "Default true: capture scope/console/network on hit, then resume, so the page is never left frozen and the action "
      + "that tripped it completes. Pass false to hold the pause for stepping; released after maxPauseMs regardless." },
  },
  async handler(args, ctx) {
    // Why this exists: on a real application, finding a function by searching text
    // is unreliable. `Ext.getCmp` is defined as an assignment, so searching
    // "getCmp: function" finds four unrelated methods on other classes and none of
    // them is the one that runs. The engine already knows where every function was
    // defined — [[FunctionLocation]] is how the browser's own console offers "jump
    // to definition" — so ask it instead of guessing from source text.
    const client = ctx.conn.client;

    const { result, exceptionDetails } = await client.Runtime.evaluate({
      expression: args.function_expression, returnByValue: false, silent: true,
    });
    if (exceptionDetails) {
      fail(CODES.EVAL_FAILED,
        exceptionDetails.exception?.description?.split("\n")[0] || `Could not evaluate "${args.function_expression}".`,
        "Check the path exists in the page — console_evaluate('typeof " + args.function_expression + "') is a quick test.");
    }
    if (result?.type !== "function") {
      const what = result?.subtype || result?.type || "nothing";
      try { if (result?.objectId) await client.Runtime.releaseObject({ objectId: result.objectId }); } catch (_) {}
      fail(CODES.BAD_ARGS,
        `"${args.function_expression}" evaluated to ${what}, not a function.`,
        what === "undefined"
          ? "Check the spelling and that the code owning it has loaded. Pass the function itself, without call parentheses."
          : "Pass an expression that evaluates to the function itself, without call parentheses.");
    }

    let location = null;
    try {
      const props = await client.Runtime.getProperties({
        objectId: result.objectId, ownProperties: false, accessorPropertiesOnly: false, generatePreview: false,
      });
      location = (props.internalProperties || []).find(p => p.name === "[[FunctionLocation]]")?.value?.value || null;
    } finally {
      try { await client.Runtime.releaseObject({ objectId: result.objectId }); } catch (_) {}
    }

    if (!location) {
      fail(CODES.SCRIPT_NOT_FOUND,
        `"${args.function_expression}" is a built-in function, so it has no source line to break on.`,
        "Break on your own code that calls it instead — source_search('" + args.function_expression.split(".").pop() + "') finds the call sites.");
    }

    const script = ctx.scripts.get(String(location.scriptId));
    let res;
    try {
      // Break at the definition itself. Chrome slides it to the first executable
      // statement inside, which is where you want to be standing.
      res = await client.Debugger.setBreakpoint({
        location: {
          scriptId: String(location.scriptId),
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        },
        ...(args.condition ? { condition: args.condition } : {}),
      });
    } catch (e) {
      if (/already exists/i.test(e.message || "")) {
        const existing = [...ctx.desired.breakpoints.values()]
          .find(b => b.functionExpression === args.function_expression);
        if (existing) {
          existing.autoResume = args.auto_resume;
          return { breakpointId: existing.breakpointId, bound: existing.bound, alreadySet: true,
            url: existing.url, resolvedLine: existing.locations?.[0]?.line ?? existing.line,
            autoResume: existing.autoResume,
            note: "A breakpoint was already set on this function; returning the existing one." };
        }
      }
      fail(CODES.INTERNAL, `Chrome rejected the breakpoint: ${e.message}`,
        "Call debugger_list_breakpoints to see what is already set.");
    }

    const line = (res.actualLocation?.lineNumber ?? location.lineNumber) + 1;
    const url  = script?.url || null;
    const key  = `${url || location.scriptId}:${line}`;
    ctx.desired.breakpoints.set(key, {
      key, url: url || `scriptId:${location.scriptId}`, line,
      column: (res.actualLocation?.columnNumber ?? location.columnNumber) + 1,
      condition: args.condition || null,
      autoResume: args.auto_resume,
      breakpointId: res.breakpointId,
      bound: !!res.actualLocation,
      locations: res.actualLocation
        ? [{ scriptId: res.actualLocation.scriptId, line, column: res.actualLocation.columnNumber + 1 }]
        : [],
      functionExpression: args.function_expression,
      requestedAs: args.function_expression,
    });

    // Say it in the developer's own terms when a source map allows it.
    let originalLocation = null;
    if (url) {
      for (const map of await loadAllSourceMaps(ctx, client)) {
        if (map.scriptUrl !== url) continue;
        originalLocation = originalPositionFor(map, line, (res.actualLocation?.columnNumber ?? 0) + 1);
        if (originalLocation) break;
      }
    }

    return {
      breakpointId: res.breakpointId,
      bound: !!res.actualLocation,
      foundAt: { function: args.function_expression, url, line },
      resolvedLine: line,
      condition: args.condition || null,
      autoResume: args.auto_resume,
      ...(originalLocation ? { originalLocation } : {}),
      ...(res.actualLocation ? {} : {
        warning: "Chrome could not resolve this to an executable location, so it will never be hit.",
        suggestion: "Read the definition with source_get_script(url, start_line, end_line) and set a line breakpoint inside it.",
      }),
      nextStep: "Trigger the code path, then call debugger_get_capture for scope, logs and network from the pause.",
    };
  },
});

defineTool({
  name: "debugger_list_breakpoints",
  readOnly: true,
  description:
    "List the breakpoints DevCDP has set, including whether each is actually bound to executable code. An unbound "
    + "breakpoint will never fire — check here first when a breakpoint 'is not hitting'.",
  needsClient: false,
  async handler(_args, ctx) {
    const list = [...ctx.desired.breakpoints.values()];
    const unbound = list.filter(b => !b.bound);
    return {
      count: list.length,
      bound: list.length - unbound.length,
      unbound: unbound.length,
      breakpoints: list.map(b => ({
        breakpointId: b.breakpointId, url: b.url, line: b.line,
        bound: b.bound, condition: b.condition, autoResume: b.autoResume,
        requestedAs: b.requestedAs !== b.url ? b.requestedAs : undefined,
        resolvedLine: b.locations?.[0]?.line,
      })),
      ...(unbound.length ? { warning: `${unbound.length} breakpoint(s) are not bound and will never fire.` } : {}),
    };
  },
});

defineTool({
  name: "debugger_remove_breakpoint",
  destructive: false,
  description: "Remove one breakpoint by its breakpointId. Use debugger_remove_all_breakpoints to clear them in one call.",
  args: { breakpoint_id: { type: "string", description: "breakpointId from debugger_set_breakpoint.", required: true } },
  async handler(args, ctx) {
    const entry = [...ctx.desired.breakpoints.values()].find(b => b.breakpointId === args.breakpoint_id);
    try { await ctx.conn.client.Debugger.removeBreakpoint({ breakpointId: args.breakpoint_id }); }
    catch (e) {
      fail(CODES.BAD_ARGS, `Chrome rejected that breakpointId: ${e.message}`, "Call debugger_list_breakpoints for the current ids.");
    }
    if (entry) ctx.desired.breakpoints.delete(entry.key);
    ctx.conn.setBadge(
      `breakpoint removed${entry ? ` — ${(entry.url.split("/").pop() || entry.url)}:${entry.line}` : ""}`, null);
    return { removed: args.breakpoint_id, remaining: ctx.desired.breakpoints.size };
  },
});

defineTool({
  name: "debugger_remove_all_breakpoints",
  destructive: false, idempotent: true,
  description:
    "Remove every breakpoint DevCDP set, and resume the page if it is currently paused. Call this before handing the "
    + "browser back to a human, so they do not find a frozen app.",
  async handler(_args, ctx) {
    const ids = [...ctx.desired.breakpoints.values()];
    let removed = 0;
    for (const bp of ids) {
      if (!bp.breakpointId) continue;
      try { await ctx.conn.client.Debugger.removeBreakpoint({ breakpointId: bp.breakpointId }); removed++; } catch (_) {}
    }
    ctx.desired.breakpoints.clear();

    let resumed = false;
    if (ctx.pause.active) {
      try { await ctx.conn.client.Debugger.resume(); resumed = true; } catch (_) {}
    }
    // Handing the browser back is exactly when the user needs to be told the app is
    // no longer going to freeze under them.
    ctx.conn.setBadge(
      removed ? `all ${removed} breakpoint(s) removed${resumed ? " — page resumed" : ""}` : "no breakpoints to remove",
      null);
    return { removed, resumed, note: resumed ? "Page was paused and has been resumed." : undefined };
  },
});

defineTool({
  name: "debugger_pause",
  destructive: false,
  description:
    "Pause JavaScript execution at the next statement the page runs, and hold it so you can inspect and step. The page "
    + "is frozen while held, so DevCDP releases it automatically after maxPauseMs if you have not resumed — no human "
    + "ever has to press resume in Chrome.",
  async handler(_args, ctx) {
    ctx.conn.holdUntilResumed = true;        // an explicit pause means "hold"
    await ctx.conn.client.Debugger.pause();
    return {
      pausing: true,
      heldUntilResumed: true,
      autoReleaseAfterMs: ctx.cfg.maxPauseMs,
      note: "Will pause on the next statement executed and stay there. Call debugger_resume when done; otherwise it is released automatically.",
    };
  },
});

defineTool({
  name: "debugger_resume",
  destructive: false, idempotent: true,
  description:
    "Resume execution and drop any hold. Breakpoints resume themselves by default, so this is only needed after an "
    + "explicit pause, after stepping, or after a breakpoint set with auto_resume:false.",
  async handler(_args, ctx) {
    ctx.conn.holdUntilResumed = false;
    ctx.conn.clearPauseWatchdog();
    if (!ctx.pause.active) return { resumed: false, note: "Was not paused." };
    await ctx.conn.client.Debugger.resume();
    ctx.pause.active = false;
    return { resumed: true };
  },
});

for (const [name, method, label] of [
  ["debugger_step_over", "stepOver", "over"],
  ["debugger_step_into", "stepInto", "into"],
  ["debugger_step_out",  "stepOut",  "out"],
]) {
  defineTool({
    name,
    destructive: false,
    description:
      `Step ${label} from the current pause and stop at the next statement. Stepping implies you want the pause held, `
      + "so it will not auto-resume between steps — but it is still released automatically after maxPauseMs if you stop. "
      + "The new location and scope are available from debugger_get_state and debugger_get_scope once it settles.",
    async handler(_args, ctx) {
      requirePaused(ctx);
      ctx.conn.holdUntilResumed = true;      // stepping is inherently interactive
      await ctx.conn.client.Debugger[method]();
      return {
        stepped: label,
        heldUntilResumed: true,
        note: "Call debugger_get_state to see where execution landed, and debugger_resume when finished stepping.",
      };
    },
  });
}

defineTool({
  name: "debugger_get_state",
  readOnly: true,
  description:
    "Where execution is paused right now: the reason, and the full call stack with function names and 1-based "
    + "file positions. Returns paused:false when the page is running.",
  needsClient: false,
  async handler(_args, ctx) {
    if (!ctx.pause.active || !ctx.pause.callFrames) {
      return {
        paused: false,
        ...(ctx.pause.capture ? { lastPause: { pauseId: ctx.pause.capture.pauseId, at: ctx.pause.capture.capturedAt, stillReadable: "debugger_get_capture" } } : {}),
      };
    }
    return {
      paused: true,
      pauseId: ctx.pause.id,
      reason: ctx.pause.reason,
      callStack: ctx.pause.callFrames.map((f, i) => ({
        frameIndex: i,
        fn: f.functionName || "(anonymous)",
        url: ctx.conn.frameFile(f),      // frame.url is "" for source-mapped scripts
        line: f.location.lineNumber + 1,
        column: f.location.columnNumber + 1,
      })),
    };
  },
});

defineTool({
  name: "debugger_get_scope",
  readOnly: true,
  description:
    "Read the variables in scope at a paused call frame, with objects and arrays expanded rather than printed as "
    + "'Object'. Includes `this`. Anything omitted for size is explicitly marked, so you never have to guess whether "
    + "you saw the whole value.",
  args: {
    frame_index:    { type: "number",  description: "0 is the innermost frame; see debugger_get_state for the stack.", default: 0, min: 0 },
    depth:          { type: "number",  description: "How many levels of nested objects to expand. 3 covers object → array → record.", default: 3, min: 0, max: 6 },
    max_properties: { type: "number",  description: "Maximum properties per object.", default: 30, min: 1, max: 200 },
    include_global: { type: "boolean", description: "Include the global scope (thousands of properties).", default: false },
  },
  async handler(args, ctx) {
    requirePaused(ctx);
    const frame = ctx.pause.callFrames[args.frame_index];
    if (!frame) {
      fail(CODES.BAD_ARGS, `No frame at index ${args.frame_index}; the stack is ${ctx.pause.callFrames.length} deep.`,
        "Call debugger_get_state to see valid frame indices.");
    }
    const scope = await captureFrameScope(ctx.conn.client, frame, {
      depth: args.depth, maxProps: args.max_properties, includeGlobal: args.include_global,
    });
    return {
      pauseId: ctx.pause.id,
      frame: {
        index: args.frame_index,
        fn: frame.functionName || "(anonymous)",
        url: ctx.conn.frameFile(frame),
        line: frame.location.lineNumber + 1,
      },
      scope,
    };
  },
});

defineTool({
  name: "debugger_evaluate_at_frame",
  openWorld: true,
  description:
    "Evaluate an expression in the scope of a paused call frame, so local variables and closures are in scope. This "
    + "is how you confirm a hypothesis with a real value rather than inferring one.",
  args: {
    expression:  { type: "string", description: "JavaScript evaluated in the frame's scope.", required: true },
    frame_index: { type: "number", description: "Which frame; 0 is innermost.", default: 0, min: 0 },
    depth:       { type: "number", description: "How deep to expand an object result.", default: 2, min: 0, max: 5 },
  },
  async handler(args, ctx) {
    requirePaused(ctx);
    const frame = ctx.pause.callFrames[args.frame_index];
    if (!frame) fail(CODES.BAD_ARGS, `No frame at index ${args.frame_index}.`, "See debugger_get_state.");

    const { result, exceptionDetails } = await ctx.conn.client.Debugger.evaluateOnCallFrame({
      callFrameId: frame.callFrameId, expression: args.expression, returnByValue: false, silent: true,
    });
    if (exceptionDetails) {
      fail(CODES.EVAL_FAILED,
        exceptionDetails.exception?.description?.split("\n")[0] || exceptionDetails.text || "Evaluation failed in frame",
        "Check the identifier exists in this frame — debugger_get_scope lists what is available.");
    }
    const value = await expandRemote(ctx.conn.client, result, { depth: args.depth, maxProps: 50 });
    return { expression: args.expression, frameIndex: args.frame_index, type: result.type, value };
  },
});

defineTool({
  name: "debugger_get_capture",
  readOnly: true,
  description:
    "Everything captured automatically at the last breakpoint hit — scope for the top frames, recent console output "
    + "and recent network requests — in one call instead of four. Tells you whether the pause is still current or has "
    + "already resumed, so a stale snapshot is never mistaken for live state.",
  needsClient: false,
  async handler(_args, ctx) {
    const cap = ctx.pause.capture;
    if (!cap) {
      return {
        ready: false,
        note: "No breakpoint has been hit yet.",
        nextStep: "debugger_set_breakpoint(url, line, auto_resume:true), then trigger the code path.",
        ...(ctx.desired.breakpoints.size
          ? { breakpointsSet: ctx.desired.breakpoints.size,
              unbound: [...ctx.desired.breakpoints.values()].filter(b => !b.bound).length }
          : { warning: "No breakpoints are set either." }),
      };
    }
    // DBG-5 — v4 kept returning paused:true forever after a resume.
    const live = cap.isCurrent === true && ctx.pause.active;
    const { isCurrent, pauseId, capturedAt, ...rest } = cap;
    return {
      ready: true,
      live,
      ...(live ? {} : { note: "Execution has resumed. These are the values at that pause, not now." }),
      ...rest,
    };
  },
});
