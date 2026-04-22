import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}!${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}•${RESET} ${msg}`); }
function step(msg) { console.log(`\n${BOLD}${msg}${RESET}`); }

function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  }
  // Linux / other: Claude Desktop isn't officially supported there, but honor the mac path layout under ~/.config
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

function findNode() {
  try {
    const p = execSync(process.platform === "win32" ? "where node" : "which node", { encoding: "utf8" }).split(/\r?\n/)[0].trim();
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return process.execPath;
}

function findNpx() {
  // npx ships with npm, which ships with node — but users on volta/nvm may
  // have node without npx on PATH, or a wrapper that's not directly
  // executable by Claude Desktop. Walk the candidates in order.
  try {
    const cmd = process.platform === "win32" ? "where npx" : "which npx";
    const p = execSync(cmd, { encoding: "utf8" }).split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return null;
}

// Absolute paths written by an earlier `init` into the npx cache — these go
// stale when the cache is GC'd, so we silently upgrade them to npx form.
function looksLikeNpxCachePath(p) {
  return typeof p === "string" && /[\\/]_npx[\\/]/.test(p);
}
function looksLikeOwnInstalledBin(p) {
  // Path inside a node_modules/figbridge-mcp install (local or npx). Always
  // safe to rewrite: a later version may live at a different hash anyway.
  return typeof p === "string" && /[\\/]figbridge-mcp[\\/]bin[\\/]figbridge-mcp\.js$/.test(p);
}

function pluginDir() {
  // this file lives at <pkg>/src/init.js; plugin manifest ships separately under <repo>/plugin
  // when installed from npm we don't ship the plugin, so fall back to a URL.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "..", "..", "plugin");
  if (fs.existsSync(path.join(candidate, "manifest.json"))) return candidate;
  return null;
}

export async function runInit(opts = {}) {
  const pin = opts.pin === true || process.argv.includes("--pin");
  console.log(`\n${BOLD}Figbridge installer${RESET} ${DIM}— free, local MCP bridge for Figma${RESET}\n`);

  step("1. Patching Claude Desktop config");
  const cfgPath = claudeDesktopConfigPath();

  let cfg = {};
  try {
    if (fs.existsSync(cfgPath)) {
      cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      ok(`found existing config at ${cfgPath}`);
    } else {
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      info(`creating new config at ${cfgPath}`);
    }
  } catch (e) {
    warn(`couldn't parse existing config (${e.message}); starting fresh — a backup will be written`);
    try { fs.copyFileSync(cfgPath, cfgPath + ".bak"); } catch {}
    cfg = {};
  }

  cfg.mcpServers = cfg.mcpServers || {};
  const existing = cfg.mcpServers.figbridge;

  // Prefer the npx-as-command pattern so Claude Desktop always launches the
  // latest published version on startup. Absolute paths bake in the npx
  // cache directory, which silently ages out when a new release lands — so
  // users end up running stale code (or a dangling path) until they re-run
  // `init` manually. `npx -y figbridge-mcp@latest` self-updates.
  //
  // `--pin` forces the old absolute-path mode for users who want a
  // reproducible version locked to the currently installed copy.
  const npxBin = findNpx();
  let newEntry;
  if (pin || !npxBin) {
    const nodeBin = findNode();
    const binPath = fileURLToPath(new URL("../bin/figbridge-mcp.js", import.meta.url));
    newEntry = { command: nodeBin, args: [binPath] };
    if (pin) info("pinned: Claude will always run this exact copy (use without --pin for auto-updates)");
    else warn("npx not found on PATH — falling back to absolute path (install npm to enable auto-updates)");
  } else {
    newEntry = { command: npxBin, args: ["-y", "figbridge-mcp@latest"] };
  }

  cfg.mcpServers.figbridge = newEntry;

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  if (existing) {
    // Note if we just rescued a user from a stale absolute path.
    const oldCmd = existing.command || "";
    const oldArg = (existing.args && existing.args[0]) || "";
    if (looksLikeNpxCachePath(oldArg) || looksLikeOwnInstalledBin(oldArg)) {
      ok("upgraded figbridge entry — was pointing at a pinned path that can go stale");
    } else {
      ok("updated figbridge entry in mcpServers");
    }
  } else {
    ok("added figbridge entry to mcpServers");
  }
  info(`  command: ${newEntry.command}`);
  info(`  args:    ${JSON.stringify(newEntry.args)}`);
  if (!pin && npxBin) info(`  ${DIM}auto-updates: Claude pulls the latest figbridge-mcp on every launch${RESET}`);

  step("2. Figma plugin install");
  const plug = pluginDir();
  if (plug) {
    ok(`plugin manifest is at: ${plug}/manifest.json`);
    console.log(`  ${DIM}In Figma desktop: Plugins → Development → Import plugin from manifest…${RESET}`);
    console.log(`  ${DIM}Pick the file above, then run "Figbridge" on any frame.${RESET}`);
  } else {
    warn("plugin files aren't bundled with the npm package.");
    console.log(`  ${DIM}Clone the repo to get them:${RESET}`);
    console.log(`    git clone https://github.com/rudraptpsingh/figbridge`);
    console.log(`  ${DIM}Then in Figma: Plugins → Development → Import plugin from manifest…${RESET}`);
    console.log(`  ${DIM}→ figbridge/plugin/manifest.json${RESET}`);
  }

  step("3. Next steps");
  console.log(`  ${BOLD}1.${RESET} Quit and reopen Claude Desktop (it only reads config on launch).`);
  console.log(`  ${BOLD}2.${RESET} Open Figma, run the Figbridge plugin, toggle ${CYAN}Live bridge${RESET} on.`);
  console.log(`  ${BOLD}3.${RESET} In Claude, ask: ${CYAN}"What tools does figbridge expose?"${RESET}`);
  console.log(`     You should see 21 tools (get_current_selection, export_app_spec, clone_screen, get_agent_bundle, …).`);

  console.log(`\n${GREEN}Done.${RESET} Docs: https://rudraptpsingh.github.io/figbridge\n`);
}
