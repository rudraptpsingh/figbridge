// Integration test — runs the server EXACTLY as Claude Desktop would,
// pushes a realistic Figma-shaped payload, exercises every tool,
// and verifies persistence across restarts.
//
// Run: node test/integration.mjs

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const BIN = "/Users/rp/github/figbridge/mcp/bin/figbridge-mcp.js";
const NODE = "/opt/homebrew/bin/node";
const PORT = 7331;
const STORE = path.join(os.homedir(), ".figbridge", "last.json");

function log(...a) { process.stdout.write("• " + a.join(" ") + "\n"); }
function ok(label) { process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`); }
function fail(msg) { console.error("\n\x1b[31m✗\x1b[0m", msg); process.exit(1); }

try { fs.rmSync(STORE, { force: true }); } catch {}
try { fs.rmSync(path.join(os.homedir(), ".figbridge", "history.json"), { force: true }); } catch {}

function startServer() {
  const child = spawn(NODE, [BIN], { stdio: ["pipe", "pipe", "pipe"] });
  const state = { stdoutBuf: "", stderrBuf: "", pending: new Map(), nextId: 1, child };
  child.stderr.on("data", (d) => { state.stderrBuf += d.toString(); });
  child.stdout.on("data", (d) => {
    state.stdoutBuf += d.toString();
    let idx;
    while ((idx = state.stdoutBuf.indexOf("\n")) >= 0) {
      const line = state.stdoutBuf.slice(0, idx).trim();
      state.stdoutBuf = state.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && state.pending.has(msg.id)) {
          const { resolve } = state.pending.get(msg.id);
          state.pending.delete(msg.id);
          resolve(msg);
        }
      } catch {}
    }
  });
  state.rpc = (method, params) => {
    const id = state.nextId++;
    return new Promise((resolve, reject) => {
      state.pending.set(id, { resolve, reject });
      state.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => { if (state.pending.has(id)) { state.pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); } }, 5000);
    });
  };
  state.notify = (method, params) => {
    state.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };
  return state;
}

async function waitBridge() {
  for (let i = 0; i < 30; i++) {
    await delay(100);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return true; } catch {}
  }
  return false;
}

// A realistic payload that mimics what plugin/code.js would send.
const payload = {
  fileKey: "abc123", fileName: "Draftr — iOS App Design", pageName: "Onboarding",
  nodeNames: ["S09 — Splash"], nodeIds: ["49:137"],
  html: `<!DOCTYPE html><html><head><title>Onboarding</title><style>.el-1{width:390px;height:844px;background:#0e0f12;}</style></head><body><div class="el-1" data-figma="S09 — Splash"><p class="el-2">Draftr</p></div></body></html>`,
  css: `.el-1 { width:390px; height:844px; background:#0e0f12; }\n.el-2 { font-size:48px; font-weight:700; color:#ff7a29; }`,
  rawHtml: `<div class="el-1"><p class="el-2">Draftr</p></div>`,
  tailwindHtml: `<div class="relative w-[390px] h-[844px] bg-[#0e0f12]"><p class="absolute text-[48px] font-[700] text-[#ff7a29]">Draftr</p></div>`,
  tailwindBody: `<div class="relative w-[390px] h-[844px] bg-[#0e0f12]"><p class="absolute text-[48px] font-[700] text-[#ff7a29]">Draftr</p></div>`,
  tokens: {
    colors: { "snow/default": "#ffffff", "ink/0": "#0e0f12", "amber/default": "#ff7a29" },
    numbers: { "spacing/sm": 8, "spacing/md": 16, "spacing/lg": 24 },
    strings: {}, booleans: {}
  },
  cssVars: `:root {\n  --snow-default: #ffffff;\n  --ink-0: #0e0f12;\n  --amber-default: #ff7a29;\n  --spacing-sm: 8;\n  --spacing-md: 16;\n  --spacing-lg: 24;\n}\n`,
  tailwindConfig: `module.exports = {\n  theme: {\n    extend: {\n      colors: {"snow":{"default":"#ffffff"},"ink":{"0":"#0e0f12"},"amber":{"default":"#ff7a29"}}\n    }\n  }\n};\n`,
  capturedAt: Date.now()
};

async function main() {
  // Phase 1 ─────────────────────────────────────────────────────
  log("phase 1: start server, prove it's ready");
  const s1 = startServer();
  if (!(await waitBridge())) fail(`bridge never came up\nstderr:\n${s1.stderrBuf}`);
  ok("bridge on :7331 is up");

  const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
  if (!health.ok) fail("health check failed");
  ok(`health OK — hasLatest=${health.hasLatest} (expected false on cold start)`);

  // Phase 2 ─────────────────────────────────────────────────────
  log("phase 2: MCP handshake");
  const init = await s1.rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {}, clientInfo: { name: "figbridge-integration", version: "0.0.1" }
  });
  if (init.result?.serverInfo?.name !== "figbridge") fail("initialize name mismatch: " + JSON.stringify(init));
  ok(`initialize → name=${init.result.serverInfo.name} version=${init.result.serverInfo.version}`);
  s1.notify("notifications/initialized");

  const list = await s1.rpc("tools/list", {});
  const tools = (list.result?.tools || []).map(t => t.name);
  const expected = ["get_current_selection", "get_last_export", "list_history", "get_tokens", "bridge_status"];
  for (const n of expected) if (!tools.includes(n)) fail(`missing tool: ${n}`);
  ok(`tools/list → ${tools.join(", ")}`);

  // Phase 3 ─────────────────────────────────────────────────────
  log("phase 3: simulate plugin push (POST /push)");
  const pushRes = await fetch(`http://127.0.0.1:${PORT}/push`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!pushRes.ok) fail(`push failed: ${pushRes.status}`);
  ok(`pushed: page="${payload.pageName}" node="${payload.nodeNames[0]}"`);

  const latest = await (await fetch(`http://127.0.0.1:${PORT}/latest`)).json();
  if (latest.pageName !== "Onboarding") fail("/latest did not reflect the push");
  ok(`/latest reflects push — pageName=${latest.pageName}`);

  // Phase 4 ─────────────────────────────────────────────────────
  log("phase 4: call every MCP tool");

  // get_current_selection default (all)
  let call = await s1.rpc("tools/call", { name: "get_current_selection", arguments: {} });
  let text = call.result?.content?.[0]?.text || "";
  let parsed = JSON.parse(text);
  if (parsed.format !== "all") fail("default format should be 'all'");
  if (parsed.pageName !== "Onboarding") fail("default result missing pageName");
  ok(`get_current_selection (all) → pageName="${parsed.pageName}" formats:html,css,tailwindHtml,tokens`);

  // get_current_selection html
  call = await s1.rpc("tools/call", { name: "get_current_selection", arguments: { format: "html" } });
  text = call.result?.content?.[0]?.text || "";
  parsed = JSON.parse(text);
  if (!parsed.content.includes("Draftr") || !parsed.content.includes("<!DOCTYPE")) fail("html payload wrong");
  ok(`get_current_selection (html) → ${parsed.content.length} bytes, includes "Draftr"`);

  // get_current_selection css
  call = await s1.rpc("tools/call", { name: "get_current_selection", arguments: { format: "css" } });
  parsed = JSON.parse(call.result.content[0].text);
  if (!parsed.content.includes("#ff7a29")) fail("css payload wrong");
  ok(`get_current_selection (css) → ${parsed.content.length} bytes`);

  // get_current_selection tailwind
  call = await s1.rpc("tools/call", { name: "get_current_selection", arguments: { format: "tailwind" } });
  parsed = JSON.parse(call.result.content[0].text);
  if (!parsed.content.includes("w-[390px]")) fail("tailwind payload wrong");
  ok(`get_current_selection (tailwind) → includes arbitrary-value class w-[390px]`);

  // get_current_selection tokens
  call = await s1.rpc("tools/call", { name: "get_current_selection", arguments: { format: "tokens" } });
  parsed = JSON.parse(call.result.content[0].text);
  if (!parsed.content.includes("amber/default")) fail("tokens payload wrong");
  ok(`get_current_selection (tokens) → ${Object.keys(JSON.parse(parsed.content).colors).length} colors`);

  // get_last_export
  call = await s1.rpc("tools/call", { name: "get_last_export", arguments: { format: "cssVars" } });
  parsed = JSON.parse(call.result.content[0].text);
  if (!parsed.content.includes("--amber-default: #ff7a29")) fail("get_last_export cssVars wrong");
  ok(`get_last_export (cssVars) → contains --amber-default`);

  // get_tokens (dedicated)
  call = await s1.rpc("tools/call", { name: "get_tokens", arguments: {} });
  parsed = JSON.parse(call.result.content[0].text);
  if (!parsed.tokens?.colors?.["amber/default"]) fail("get_tokens missing amber/default");
  if (!parsed.tailwindConfig.includes("amber")) fail("get_tokens missing tailwind config");
  ok(`get_tokens → tokens + cssVars + tailwindConfig returned`);

  // list_history
  call = await s1.rpc("tools/call", { name: "list_history", arguments: {} });
  parsed = JSON.parse(call.result.content[0].text);
  if (parsed.history.length !== 1) fail(`history length: ${parsed.history.length}`);
  ok(`list_history → 1 entry: "${parsed.history[0].pageName}"`);

  // bridge_status
  call = await s1.rpc("tools/call", { name: "bridge_status", arguments: {} });
  parsed = JSON.parse(call.result.content[0].text);
  if (!parsed.hasLatest) fail("bridge_status hasLatest should be true");
  if (parsed.bridge.port !== PORT) fail("bridge_status port wrong");
  ok(`bridge_status → running=${parsed.bridge.running} port=${parsed.bridge.port} hasLatest=${parsed.hasLatest}`);

  // Phase 5 ─────────────────────────────────────────────────────
  log("phase 5: kill server, restart, verify persistence");
  s1.child.kill();
  await delay(300);
  if (!fs.existsSync(STORE)) fail("~/.figbridge/last.json not persisted");
  const persisted = JSON.parse(fs.readFileSync(STORE, "utf8"));
  if (persisted.pageName !== "Onboarding") fail("persisted pageName wrong");
  ok(`persisted to ${STORE} — pageName="${persisted.pageName}"`);

  const s2 = startServer();
  if (!(await waitBridge())) fail("bridge didn't come back up after restart");
  await s2.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } });
  s2.notify("notifications/initialized");
  const survived = await s2.rpc("tools/call", { name: "get_current_selection", arguments: { format: "html" } });
  const survivedText = JSON.parse(survived.result.content[0].text).content;
  if (!survivedText.includes("Draftr")) fail("data did not survive restart");
  ok("after restart, get_current_selection still returns the pushed payload");

  // Phase 6 ─────────────────────────────────────────────────────
  log("phase 6: push a second payload, list_history grows");
  await fetch(`http://127.0.0.1:${PORT}/push`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...payload, pageName: "Dashboard", nodeNames: ["S10 — Write"], capturedAt: Date.now() })
  });
  const hist = await s2.rpc("tools/call", { name: "list_history", arguments: {} });
  const histParsed = JSON.parse(hist.result.content[0].text);
  if (histParsed.history.length !== 2) fail(`history should have 2, got ${histParsed.history.length}`);
  if (histParsed.history[0].pageName !== "Dashboard") fail("history order wrong (newest first)");
  ok(`list_history → ${histParsed.history.length} entries, newest="${histParsed.history[0].pageName}"`);

  s2.child.kill();
  log("\n\x1b[32mALL INTEGRATION TESTS PASSED\x1b[0m");
  process.exit(0);
}

main().catch((e) => fail(e && e.stack || e));
