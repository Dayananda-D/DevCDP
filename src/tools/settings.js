// ─── Settings tool ───────────────────────────────────────────────────────────
// Configuration that cannot be inspected is barely configuration: the usual
// failure is "I changed it and nothing happened", with no way to tell whether the
// file was found, the key was recognised, or something else overrode it.
//
// So this reports the effective value of every setting, where each one came from,
// which files were searched, which were loaded, and anything that failed to parse
// or was not recognised.

import fs from "fs";
import path from "path";
import { defineTool } from "../core/tools.js";
import { CODES, fail } from "../core/errors.js";
import { settingsCandidates } from "../core/config.js";

/** Grouped so the output reads like documentation rather than a flat dump. */
const GROUPS = {
  connection: ["host", "port", "portRange", "connectTimeoutMs"],
  browser: ["chromeProfile", "chromePath", "chromeProfileBase", "chromeFlags", "disableWebSecurity"],
  indicator: ["badge", "badgeCorner", "edgePulse", "badgeAutoCollapse", "badgeIdleMs", "showCursor", "highlightInspected"],
  toasts: ["toasts", "toastCorner", "toastMs", "toastOpacity", "toastMaxVisible"],
  tabs: ["tabGroupMode"],
  debugger: ["autoResumeDefault", "maxPauseMs"],
  liveness: ["evalTimeoutMs", "toolTimeoutMs", "retryOnDisconnect", "autoRecoverUnresponsive", "claimGraceMs"],
  budget: ["maxResponseBytes"],
  privacy: ["captureInputValues", "maxPostDataBytes"],
  knowledge: ["docsRoot", "sharedMemoryDir", "memoryDir", "apiProbePaths"],
  app: ["dialogSelectors", "testAttributes"],
  buffers: ["consoleBufferSize", "networkBufferSize", "mutationBufferSize", "activityBufferSize"],
};

defineTool({
  name: "devcdp_settings",
  description:
    "Show every DevCDP setting: its effective value, where that value came from (default, which settings file, or which "
    + "environment variable), which files were searched and loaded, and any that failed to parse or were not recognised. "
    + "Use it before changing configuration, and to check a change actually took effect.",
  needsClient: false,
  args: {
    group: { type: "string", description: "Only one group of settings.",
      enum: [...Object.keys(GROUPS), "all"], default: "all" },
    changed_only: { type: "boolean", description: "Only settings that are not at their default.", default: false },
  },
  async handler(args, ctx) {
    const cfg = ctx.cfg;
    const meta = cfg._meta || {};
    const prov = meta.provenance || {};

    const wanted = args.group === "all" ? Object.entries(GROUPS) : [[args.group, GROUPS[args.group]]];
    const settings = {};

    for (const [group, keys] of wanted) {
      const rows = {};
      for (const key of keys) {
        if (!(key in cfg)) continue;
        const source = prov[key] || "default";
        if (args.changed_only && source === "default") continue;
        // A default is just its value. Only a value that came from somewhere gets
        // the wrapper saying where — a wrapper per key, forty times over, was most
        // of this response.
        rows[key] = source === "default" ? cfg[key] : { value: cfg[key], from: source };
      }
      if (Object.keys(rows).length) settings[group] = rows;
    }

    return {
      settings,
      files: {
        loaded: meta.settingsFilesLoaded || [],
        searched: meta.settingsFilesSearched || settingsCandidates(),
        editThisOne: meta.recommendedSettingsPath,
        ...(meta.settingsProblems?.length ? { problems: meta.settingsProblems } : {}),
        ...(meta.unknownKeys?.length
          ? { unrecognisedKeys: meta.unknownKeys,
              warning: "These keys are in a settings file but are not settings DevCDP knows — most likely typos, and they are ignored." }
          : {}),
      },
      precedence: "defaults < install settings < project settings < DEVCDP_* environment variables < tool arguments",
      note: (meta.settingsFilesLoaded || []).length
        ? "Changes take effect when the MCP server restarts — reload your assistant after editing."
        : "No settings file exists yet. Call devcdp_settings_init to write a commented one you can edit.",
    };
  },
});

defineTool({
  name: "devcdp_settings_init",
  description:
    "Write a settings file containing every option with its current value and an explanation, so it can be edited by "
    + "hand. Refuses to overwrite an existing file unless you say so.",
  needsClient: false,
  args: {
    path: { type: "string", description: "Where to write it. Defaults to devcdp.settings.json in the install directory." },
    overwrite: { type: "boolean", description: "Replace the file if it already exists.", default: false },
  },
  async handler(args, ctx) {
    const target = args.path
      ? path.resolve(args.path)
      : path.join(ctx.cfg._meta?.installDir || process.cwd(), "devcdp.settings.json");

    if (fs.existsSync(target) && !args.overwrite) {
      fail(CODES.BAD_ARGS, `${target} already exists.`,
        "Pass overwrite:true to replace it, or edit it directly — devcdp_settings shows what is currently in effect.");
    }

    const cfg = ctx.cfg;
    const body = {
      "//": "DevCDP settings. Delete anything you do not want to change — every key is optional.",
      "//precedence": "defaults < install settings < project settings < DEVCDP_* env vars < tool arguments",

      "//browser": "chromeProfile: 'isolated' | 'default' | a path. 'default' reuses your everyday Chrome profile, but Chrome 136+ refuses remote debugging on it. disableWebSecurity hides the CORS bugs you would be debugging — leave it false unless you know you need it.",
      chromeProfile: cfg.chromeProfile,
      disableWebSecurity: cfg.disableWebSecurity,
      chromeFlags: cfg.chromeFlags,

      "//indicator": "The identity chip and the 1px edge border that mark a tab as driven by DevCDP. badge:false removes all of it. edgePulse makes the border breathe while DevCDP is driving; it always goes still and green when control is handed to you.",
      badge: cfg.badge,
      badgeCorner: cfg.badgeCorner,
      edgePulse: cfg.edgePulse,
      showCursor: cfg.showCursor,

      "//trust": "ownerTimeoutMs is how long an indicator keeps drawing itself without hearing from its session before it removes itself — so a killed or crashed server can never leave a tab looking driven. followNewTabs marks and holds tabs the application opens for itself, which is where a popup bug would otherwise be an unmarked blind spot.",
      ownerTimeoutMs: cfg.ownerTimeoutMs,
      followNewTabs: cfg.followNewTabs,

      "//toasts": "Live status messages. toasts:false hides them entirely. Translucent and self-fading; toastCorner is independent of badgeCorner so they can sit out of your way. tl | tr | bl | br.",
      toasts: cfg.toasts,
      toastCorner: cfg.toastCorner,
      toastMs: cfg.toastMs,
      toastOpacity: cfg.toastOpacity,
      toastMaxVisible: cfg.toastMaxVisible,

      "//tabs": "'session' gives each session its own Chrome tab group, titled with the session; 'single' puts every DevCDP tab in one group.",
      tabGroupMode: cfg.tabGroupMode,

      "//debugger": "Breakpoints capture and then resume themselves so the page is never left frozen. maxPauseMs releases a held pause even if nobody asks.",
      autoResumeDefault: cfg.autoResumeDefault,
      maxPauseMs: cfg.maxPauseMs,

      "//budget": "Ceiling on any single tool response, in bytes. Lower it to spend less of the model's context per call; responses say what they trimmed.",
      maxResponseBytes: cfg.maxResponseBytes,

      "//liveness": "evalTimeoutMs bounds every call into the page; toolTimeoutMs is the backstop for everything else. autoRecoverUnresponsive aborts a runaway script and retries once.",
      evalTimeoutMs: cfg.evalTimeoutMs,
      toolTimeoutMs: cfg.toolTimeoutMs,
      autoRecoverUnresponsive: cfg.autoRecoverUnresponsive,
      retryOnDisconnect: cfg.retryOnDisconnect,

      "//privacy": "captureInputValues records what is typed. Off by default; values are captured anyway while you are collaborating with the agent, and password-like fields stay redacted either way.",
      captureInputValues: cfg.captureInputValues,

      "//knowledge": "docsRoot lets it read your project's README for domain vocabulary. sharedMemoryDir pools learned fixes across a team.",
      docsRoot: cfg.docsRoot,
      sharedMemoryDir: cfg.sharedMemoryDir,

      "//app": "Only needed if structural dialog detection misses your app's modals.",
      dialogSelectors: cfg.dialogSelectors,
    };

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(body, null, 2) + "\n", "utf8");
    } catch (e) {
      fail(CODES.IO_FAILED, `Could not write ${target}: ${e.message}`, "Check the directory is writable.");
    }

    return {
      written: target,
      keys: Object.keys(body).filter(k => !k.startsWith("//")).length,
      note: "Edit it, then restart the MCP server (reload your assistant) for the changes to apply. "
          + "Comments and trailing commas are tolerated.",
    };
  },
});
