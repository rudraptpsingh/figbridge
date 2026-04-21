// End-to-end smoke test:
//   1. spawn bin/figbridge-mcp.js
//   2. POST a fake payload to the HTTP bridge on :7331
//   3. speak MCP over stdio: initialize → tools/list → call get_current_selection
//   4. assert the pushed payload comes back
//
// Run: node test/smoke.mjs

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "mcp", "bin", "figbridge-mcp.js");
const PORT = 7332; // off-default to avoid clashing with a running instance

function log(...a) { process.stdout.write("• " + a.join(" ") + "\n"); }
function fail(msg) { console.error("✗", msg); process.exit(1); }

const child = spawn("node", [BIN], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, FIGBRIDGE_PORT: String(PORT) }
});

let stderrBuf = "";
child.stderr.on("data", (d) => { stderrBuf += d.toString(); });

let stdoutBuf = "";
const pending = new Map();
let nextId = 1;

child.stdout.on("data", (d) => {
  stdoutBuf += d.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      log("non-JSON stdout:", line);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(body);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); } }, 4000);
  });
}

async function main() {
  log("waiting for bridge to come up...");
  let up = false;
  for (let i = 0; i < 20; i++) {
    await delay(100);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) { up = true; break; }
    } catch {}
  }
  if (!up) fail(`bridge never came up on :${PORT}\nstderr:\n${stderrBuf}`);
  log("bridge up");

  const payload = {
    fileKey: "TEST_FILE", fileName: "Test File", pageName: "Page 1",
    nodeNames: ["Card"], nodeIds: ["1:2"],
    html: "<div>hi</div>", css: ".x{}", tailwindHtml: '<div class="w-[10px]"></div>',
    tokens: { colors: { "brand/primary": "#ff7a29" } },
    cssVars: ":root { --brand-primary: #ff7a29; }",
    tailwindConfig: "module.exports = {};",
    capturedAt: Date.now()
  };
  const pushRes = await fetch(`http://127.0.0.1:${PORT}/push`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
  });
  if (!pushRes.ok) fail(`push failed: ${pushRes.status}`);
  log("push ok");

  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {}, clientInfo: { name: "figbridge-smoke", version: "0.0.1" }
  });
  if (!init.result) fail("initialize returned no result: " + JSON.stringify(init));
  log("initialize ok:", init.result.serverInfo?.name);

  // MCP requires the initialized notification after initialize
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools || [];
  log("tools:", tools.map(t => t.name).join(", "));
  const expected = ["get_current_selection", "get_last_export", "list_history", "get_tokens", "bridge_status"];
  for (const name of expected) if (!tools.find(t => t.name === name)) fail(`missing tool: ${name}`);

  const call = await rpc("tools/call", {
    name: "get_current_selection",
    arguments: { format: "html" }
  });
  const text = call.result?.content?.[0]?.text || "";
  if (!text.includes("<div>hi</div>")) fail(`get_current_selection did not return pushed html. Got: ${text}`);
  log("get_current_selection/html ok");

  const call2 = await rpc("tools/call", { name: "get_tokens", arguments: {} });
  const text2 = call2.result?.content?.[0]?.text || "";
  if (!text2.includes("brand/primary") && !text2.includes("brand-primary") && !text2.includes("#ff7a29")) {
    fail(`get_tokens did not return expected tokens. Got: ${text2}`);
  }
  log("get_tokens ok");

  const status = await rpc("tools/call", { name: "bridge_status", arguments: {} });
  const text3 = status.result?.content?.[0]?.text || "";
  if (!text3.includes(`"running": true`) && !text3.includes('"running":true')) fail("bridge_status did not report running");
  log("bridge_status ok");

  log("ALL TESTS PASSED");
  child.kill();
  process.exit(0);
}

main().catch((e) => { fail(e && e.stack || e); });
