#!/usr/bin/env node
// Claude Code plugin launcher.
//
// A plugin is a git checkout without node_modules, so the server cannot be started
// from the plugin directory itself. Instead the published npm package is installed
// once into the plugin's persistent data directory, pinned to the version in
// plugin.json, and started from there. `node` is used as the command rather than
// `npx` because npx needs a `cmd /c` wrapper on Windows and a plugin has to work on
// every platform with one configuration.
//
// stdout is the MCP transport, so everything this file prints goes to stderr.

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const here     = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "..", ".claude-plugin", "plugin.json"), "utf8"));
const version  = manifest.version;
const dataDir  = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), ".devcdp", "plugin");
const pkgDir   = path.join(dataDir, "node_modules", "devcdp");

const installedVersion = () => {
  try { return JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version; }
  catch { return null; }
};

if (installedVersion() !== version) {
  process.stderr.write(`[devcdp plugin] installing devcdp@${version} into ${dataDir} (first run, or version changed)\n`);
  fs.mkdirSync(dataDir, { recursive: true });
  const win = process.platform === "win32";
  const r = spawnSync(win ? "npm.cmd" : "npm",
    ["install", "--no-save", "--no-audit", "--no-fund", "--loglevel=error", `devcdp@${version}`],
    { cwd: dataDir, shell: win, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0 || installedVersion() !== version) {
    process.stderr.write(`[devcdp plugin] install failed (exit ${r.status}). Check that npm is on PATH and can reach the registry.\n`);
    process.exit(1);
  }
}

await import(pathToFileURL(path.join(pkgDir, "index.js")).href);
