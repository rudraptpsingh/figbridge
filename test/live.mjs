// Live test — drives the REAL Figbridge plugin running inside Figma Desktop.
// No fakes. Prereqs:
//   1. Figma Desktop open, with any file that has a few frames.
//   2. Figbridge plugin running (Plugins → Development → Figbridge).
//   3. "Live bridge" toggled ON inside the plugin UI (green dot).
//   4. figbridge-mcp running on :7331 (or `node mcp/bin/figbridge-mcp.js` in another shell),
//      OR set FIGBRIDGE_SPAWN=1 to have this script boot it for you.
//
// Run:  node test/live.mjs
//       FIGBRIDGE_SPAWN=1 node test/live.mjs    # start the server here too

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "mcp", "bin", "figbridge-mcp.js");
const PORT = Number(process.env.FIGBRIDGE_PORT || 7331);
const BASE = `http://127.0.0.1:${PORT}`;
const SPAWN = process.env.FIGBRIDGE_SPAWN === "1";

const C = { bold: "\x1b[1m", dim: "\x1b[2m", reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m" };
const ok = (m) => console.log(`  ${C.green}✓${C.reset} ${m}`);
const warn = (m) => console.log(`  ${C.yellow}!${C.reset} ${m}`);
const err = (m) => console.log(`  ${C.red}✗${C.reset} ${m}`);
const scene = (t) => console.log(`\n${C.yellow}━━ ${t} ${C.reset}${C.dim}${"━".repeat(Math.max(0, 60 - t.length))}${C.reset}`);
const tool = (n, b) => console.log(`  ${C.dim}→ ${n}${C.reset} ${b ? C.dim + b + C.reset : ""}`);

function startServer() {
  if (!SPAWN) return null;
  const child = spawn(process.execPath, [BIN], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, FIGBRIDGE_PORT: String(PORT) } });
  const state = { buf: "", pending: new Map(), nextId: 1, child };
  child.stdout.on("data", (d) => {
    state.buf += d.toString();
    let idx;
    while ((idx = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, idx).trim(); state.buf = state.buf.slice(idx + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id && state.pending.has(m.id)) { state.pending.get(m.id).resolve(m); state.pending.delete(m.id); } } catch {}
    }
  });
  state.rpc = (method, params) => new Promise((resolve, reject) => {
    const id = state.nextId++;
    state.pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (state.pending.has(id)) { state.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); } }, 25000);
  });
  state.notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return state;
}

async function waitBridge() {
  for (let i = 0; i < 40; i++) { await delay(200); try { const r = await fetch(`${BASE}/health`); if (r.ok) return true; } catch {} }
  return false;
}

async function status() {
  const r = await fetch(`${BASE}/health`).catch(() => null);
  if (!r || !r.ok) return { running: false };
  const h = await r.json();
  return { running: true, ...h };
}

async function waitForPlugin(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastPrinted = false;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE}/health`).catch(() => null);
    if (r && r.ok) {
      const h = await r.json();
      if (h.clients > 0) { if (!lastPrinted) ok(`plugin connected (${h.clients} client)`); return true; }
      if (!lastPrinted) { process.stdout.write(`  ${C.dim}waiting for Figbridge plugin to connect (open Figma → run plugin → toggle Live bridge)…${C.reset} `); lastPrinted = true; }
      else process.stdout.write(".");
    }
    await delay(1000);
  }
  console.log("");
  return false;
}

// Direct HTTP command to the plugin (bypasses MCP stdio entirely).
// Lets us drive the plugin even when the server is hosted externally (e.g. Claude Desktop).
async function httpCommand(action, args = {}, timeoutMs = 20000) {
  // The MCP server owns the command queue; the only public path is via an MCP client.
  // So we spin up a short-lived MCP stdio client here and route through it.
  throw new Error("httpCommand: call via MCP client (use server.rpc tools/call)");
}

async function mcpClient() {
  // Always launch a fresh MCP client against the SAME bridge port (the server will see the
  // bridge is already up and skip re-binding, then route commands through the HTTP side).
  // Simpler: just spawn our own server + client pair.
  if (!SPAWN) {
    warn("Not spawning a server here — you must already have figbridge-mcp running, and we'll use a fresh MCP client stdio pair to talk to it.");
  }
  // Re-use startServer() — with SPAWN=0 it returns null, so force-spawn our own instance
  // on a SIDE port. But then the plugin (connected to :7331) wouldn't see its commands.
  // Resolution: require SPAWN=1, OR the user runs the server via this script.
  return null;
}

// ── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`${C.bold}Figbridge live test${C.reset} ${C.dim}— no fakes, real Figma${C.reset}`);
  console.log(`  bridge: ${BASE}   spawn-server: ${SPAWN ? "yes" : "no"}`);

  let server = null;
  const pre = await status();
  if (pre.running) {
    ok(`bridge already up on :${PORT}`);
    if (SPAWN) warn("FIGBRIDGE_SPAWN=1 but a bridge is already running — will reuse it instead of spawning.");
  } else {
    if (!SPAWN) { err(`no bridge on :${PORT}. Either start it (\`node mcp/bin/figbridge-mcp.js\`) or re-run with FIGBRIDGE_SPAWN=1.`); process.exit(2); }
    server = startServer();
    if (!(await waitBridge())) { err("bridge never came up"); process.exit(2); }
    ok(`bridge spawned on :${PORT}`);
    await server.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "figbridge-live", version: "1" } });
    server.notify("notifications/initialized", {});
  }

  // If we didn't spawn our own server, we still need an MCP client to send tools/call.
  // Easiest: spawn a *second* figbridge-mcp process that points at the SAME port as a client only.
  // But our server tries to bind the port on start. Detect conflict: if already bound, the new
  // process will fail. Workaround: set FIGBRIDGE_PORT to a throwaway port for the client-side
  // process — its bridge is unused; it talks to the plugin only through its own command queue.
  //
  // BUT the plugin is connected to the ORIGINAL bridge, not our client-side one. So commands we
  // fire here would never reach the plugin.
  //
  // ⇒ The only correct setup is: this script is the process that hosts the bridge the plugin
  //   connects to. So we REQUIRE SPAWN=1 (or prior-running but no duplicate).
  if (!server) {
    if (pre.clients > 0) {
      warn("bridge is running externally AND a plugin is already connected to it.");
      warn("To drive commands from this script we need to own the bridge. Stop the other instance and re-run with FIGBRIDGE_SPAWN=1.");
      process.exit(3);
    }
    err("no in-process MCP client available. Re-run with FIGBRIDGE_SPAWN=1.");
    process.exit(3);
  }

  const call = async (name, args = {}) => {
    const r = await server.rpc("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? "";
    try { return JSON.parse(text); } catch { return text; }
  };

  scene("0. Plugin connection");
  const connected = await waitForPlugin(90_000);
  if (!connected) { err("timed out waiting for the plugin. Is Live bridge toggled on?"); process.exit(4); }

  const bs = await call("bridge_status");
  ok(`bridge_status → pluginConnected=${bs.pluginConnected}, clients=${bs.connectedClients}, hasLatest=${bs.hasLatest}`);

  // ── 1. Catalog ────────────────────────────────────────────
  scene("1. list_screens");
  const screens = await call("list_screens", {});
  if (screens.ok === false) { err(`list_screens failed: ${screens.error}`); process.exit(5); }
  ok(`${screens.count} screens found`);
  const sample = (screens.screens || []).slice(0, 8);
  for (const s of sample) console.log(`    ${s.nodeId.padEnd(10)} ${s.category.padEnd(12)} ${s.width}×${s.height}  ${s.name}`);
  if ((screens.screens || []).length > sample.length) console.log(`    ${C.dim}… +${screens.screens.length - sample.length} more${C.reset}`);

  scene("2. list_components");
  const comps = await call("list_components", { includeVariants: true });
  if (comps.ok === false) { err(`list_components failed: ${comps.error}`); }
  else {
    ok(`${comps.count} components`);
    for (const c of (comps.components || []).slice(0, 8)) {
      const variants = c.variants ? ` (${c.variants.length} variants)` : "";
      console.log(`    ${c.nodeId.padEnd(10)} ${c.kind.padEnd(14)} ${c.name}${variants}`);
    }
  }

  scene("3. describe_screen on first screen");
  if (screens.screens && screens.screens[0]) {
    const d = await call("describe_screen", { nodeId: screens.screens[0].nodeId });
    if (d.ok === false) err(`describe_screen failed: ${d.error}`);
    else {
      ok(`${d.name} — ${d.width}×${d.height}, bg=${d.background}, category=${d.category}`);
      console.log(`    ${C.dim}${(d.summary || "").slice(0, 220)}${C.reset}`);
      if (d.textContent?.length) console.log(`    text samples: ${d.textContent.slice(0, 4).map((t) => JSON.stringify(t)).join(", ")}`);
    }
  }

  scene("4. export_app_spec");
  const spec = await call("export_app_spec");
  if (spec.ok === false) err(`export_app_spec failed: ${spec.error}`);
  else {
    ok(`fileName=${JSON.stringify(spec.fileName)}`);
    console.log(`    screens: ${spec.screens?.length || 0}   components: ${spec.components?.length || 0}`);
    console.log(`    categories: ${Object.keys(spec.byCategory || {}).join(", ")}`);
    console.log(`    tokens.colors: ${Object.keys(spec.tokens?.colors || {}).length}   tokens.numbers: ${Object.keys(spec.tokens?.numbers || {}).length}`);
  }

  scene("5. get_current_selection (whatever you have selected)");
  const cur = await call("get_current_selection", { format: "all" });
  if (cur.error) warn(cur.error);
  else {
    ok(`${cur.nodeNames?.join(", ") || "(unnamed)"} — html=${(cur.html || "").length}B css=${(cur.css || "").length}B tailwind=${(cur.tailwindHtml || "").length}B`);
  }

  scene("6. lint_ds");
  const lint = await call("lint_ds", {});
  if (lint.ok === false) err(`lint_ds failed: ${lint.error}`);
  else {
    const total = (lint.findings || []).length;
    ok(`${total} findings`);
    for (const [rule, count] of Object.entries(lint.counts || {})) console.log(`    ${rule.padEnd(22)} ${count}`);
  }

  scene("7. list_assets (icons, limit 6)");
  const assets = await call("list_assets", { kind: "icon", limit: 6 });
  if (assets.ok === false) warn(`list_assets: ${assets.error}`);
  else if (!assets.assets?.length) warn("no assets found — try a file with icon frames or ic-* named layers");
  else { ok(`${assets.assets.length} assets`); for (const a of assets.assets.slice(0, 6)) console.log(`    ${a.name.padEnd(24)} ${a.format.padEnd(4)} ${a.bytes}B`); }

  // ── Write-side: GATED behind WRITES=1 so we don't mutate unless asked ────
  if (process.env.WRITES === "1") {
    scene("8. WRITE — recolor test swap (gated by WRITES=1)");
    const mapping = { "#ff7a29": "#3ddc97" };
    const r = await call("recolor", { scope: "selection", mapping });
    if (r.ok === false) err(`recolor: ${r.error}`);
    else ok(`recolor → ${r.changes} fills / ${r.nodesVisited} nodes`);

    scene("9. WRITE — apply_tokens on current selection");
    const ap = await call("apply_tokens", {});
    if (ap.ok === false) err(`apply_tokens: ${ap.error}`);
    else ok(`apply_tokens → bound ${ap.bound}, remaining ${ap.unboundRemaining} (of ${ap.availableColorVariables})`);

    scene("10. WRITE — clone_screen on first screen");
    if (screens.screens && screens.screens[0]) {
      const cl = await call("clone_screen", { sourceNodeId: screens.screens[0].nodeId, name: `${screens.screens[0].name} (figbridge clone)` });
      if (cl.ok === false) err(`clone_screen: ${cl.error}`);
      else ok(`cloned → ${cl.nodeId} ${cl.name}`);
    }
  } else {
    scene("8-10. Write-side tools (skipped)");
    console.log(`  ${C.dim}re-run with${C.reset} ${C.cyan}WRITES=1 node test/live.mjs${C.reset} ${C.dim}to exercise recolor / apply_tokens / clone_screen${C.reset}`);
  }

  scene("Done");
  console.log(`  Every tool above talked to your real Figma file. No mocks.\n`);

  if (server) server.child.kill();
  await delay(200);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
