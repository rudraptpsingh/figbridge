import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
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

// Probe localhost:7331..7340 for live figbridge bridges so `init` can flag
// stragglers — the top cause of "Server disconnected" after restart.
function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}
async function scanBridges() {
  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => probePort(7331 + i).then((b) => ({ port: 7331 + i, body: b })))
  );
  return results.filter((r) => r.body && r.body.name === "figbridge-bridge");
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
  warn(`The plugin is ${BOLD}not on Figma Community${RESET} yet — you need the manifest file from this repo.`);
  const plug = pluginDir();
  if (plug) {
    ok(`plugin manifest: ${BOLD}${plug}/manifest.json${RESET}`);
    console.log(`  In Figma desktop: ${CYAN}Plugins → Development → Import plugin from manifest…${RESET}`);
    console.log(`  ${DIM}Pick that file. Then run "Figbridge" from the plugin menu on any frame.${RESET}`);
  } else {
    warn("plugin files aren't bundled with the npm package — clone the repo:");
    console.log(`    ${CYAN}git clone https://github.com/rudraptpsingh/figbridge${RESET}`);
    console.log(`  Then in Figma: ${CYAN}Plugins → Development → Import plugin from manifest…${RESET}`);
    console.log(`  Pick: ${BOLD}<clone-path>/figbridge/plugin/manifest.json${RESET}`);
  }

  // Bridge health check — top cause of "Server disconnected" is a stale
  // instance holding :7331 from a previous Claude launch. Surface it.
  step("3. Bridge health");
  try {
    const bridges = await scanBridges();
    if (bridges.length === 0) {
      ok("no stale figbridge bridges running — clean slate.");
    } else if (bridges.length === 1) {
      const b = bridges[0];
      info(`1 bridge already running on :${b.port} (plugin will find it once reloaded).`);
    } else {
      warn(`${bridges.length} bridges already running (${bridges.map(b => ":" + b.port).join(", ")}) — this is the split-brain state.`);
      console.log(`  Run ${CYAN}npx figbridge-mcp doctor${RESET} to reap them, then restart Claude Desktop.`);
    }
  } catch { /* health probe is best-effort */ }

  step("4. Next steps — do these in order");
  console.log(`  ${BOLD}1.${RESET} Quit and reopen Claude Desktop. ${DIM}(It only reads MCP config on launch.)${RESET}`);
  console.log(`  ${BOLD}2.${RESET} In Figma: ${CYAN}Plugins → Development → Import plugin from manifest…${RESET} ${DIM}(skip if you've already imported)${RESET}`);
  console.log(`  ${BOLD}3.${RESET} Run the Figbridge plugin on a frame, toggle ${CYAN}Live bridge${RESET} on.`);
  console.log(`     ${DIM}Green dot in the plugin header = connected to the bridge. Port shows in the footer.${RESET}`);
  console.log(`  ${BOLD}4.${RESET} In Claude, ask: ${CYAN}"What tools does figbridge expose?"${RESET}`);
  console.log(`     ${DIM}You should see 21 tools (get_current_selection, export_app_spec, get_agent_bundle, …).${RESET}`);

  console.log(`\n${GREEN}${BOLD}Done.${RESET}  Stuck? ${CYAN}npx figbridge-mcp doctor${RESET} reaps orphan processes and probes ports 7331–7340.`);
  console.log(`       Docs: ${CYAN}https://rudraptpsingh.github.io/figbridge${RESET}\n`);
}
