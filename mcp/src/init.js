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

function pluginDir() {
  // this file lives at <pkg>/src/init.js; plugin manifest ships separately under <repo>/plugin
  // when installed from npm we don't ship the plugin, so fall back to a URL.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(here, "..", "..", "plugin");
  if (fs.existsSync(path.join(candidate, "manifest.json"))) return candidate;
  return null;
}

export async function runInit() {
  console.log(`\n${BOLD}Figbridge installer${RESET} ${DIM}— free, local MCP bridge for Figma${RESET}\n`);

  step("1. Patching Claude Desktop config");
  const cfgPath = claudeDesktopConfigPath();
  const nodeBin = findNode();
  const binPath = fileURLToPath(new URL("../bin/figbridge-mcp.js", import.meta.url));

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
  cfg.mcpServers.figbridge = {
    command: nodeBin,
    args: [binPath]
  };

  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  if (existing) ok("updated figbridge entry in mcpServers");
  else ok("added figbridge entry to mcpServers");
  info(`  node: ${nodeBin}`);
  info(`  bin:  ${binPath}`);

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
  console.log(`     You should see 17 tools (get_current_selection, export_app_spec, clone_screen, …).`);

  console.log(`\n${GREEN}Done.${RESET} Docs: https://rudraptpsingh.github.io/figbridge\n`);
}
