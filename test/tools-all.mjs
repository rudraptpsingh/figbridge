// Exercise every MCP tool. Tools that need a live plugin will return
// a graceful error (timeout/not-connected); we assert the full public
// tool surface is registered and the server never crashes or hangs.
//
// Run: node test/tools-all.mjs

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "mcp", "bin", "figbridge-mcp.js");
const PORT = 7333;

function log(...a) { process.stdout.write("• " + a.join(" ") + "\n"); }
function fail(msg) { console.error("✗", msg); process.exit(1); }
function ok(msg) { process.stdout.write("  ✓ " + msg + "\n"); }

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
    } catch {}
  }
});

function rpc(method, params, timeoutMs = 3000) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(body);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`rpc timeout: ${method}`)); } }, timeoutMs);
  });
}

async function call(name, args = {}, timeoutMs = 3000) {
  try {
    const res = await rpc("tools/call", { name, arguments: args }, timeoutMs);
    const text = res.result?.content?.[0]?.text || "";
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  for (let i = 0; i < 20; i++) {
    await delay(100);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (r.ok) break;
    } catch {}
  }

  await rpc("initialize", {
    protocolVersion: "2024-11-05", capabilities: {},
    clientInfo: { name: "tools-all", version: "0.0.1" }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Seed bridge with an export so read-side tools have something to return.
  await fetch(`http://127.0.0.1:${PORT}/push`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileKey: "F", fileName: "F", pageName: "P1",
      nodeNames: ["Card"], nodeIds: ["1:2"],
      html: "<div>hi</div>", css: ".x{}", tailwindHtml: "",
      tokens: { colors: { "brand/primary": "#ff7a29" } },
      cssVars: ":root{--brand-primary:#ff7a29}",
      tailwindConfig: "module.exports={};",
      capturedAt: Date.now()
    })
  });

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools || [];
  const names = tools.map(t => t.name);
  log(`tools listed: ${names.length}`);
  const expected = [
    "get_current_selection", "get_last_export", "list_history", "get_tokens", "bridge_status",
    "select_node", "export_node", "list_screens", "list_components", "describe_screen",
    "export_app_spec", "clone_screen", "recolor", "apply_tokens", "list_assets",
    "lint_ds", "get_agent_bundle", "diff_since",
    "list_pages", "list_frames", "export_all_pages",
    "preflight_import", "import_url", "import_responsive_set", "import_url_batch",
    "verify_text_fidelity", "screenshot_url", "visual_diff", "fingerprint_url", "audit_interactions",
    "audit_mobile", "measure_fidelity", "audit_regression", "match_mockup", "diff_specs", "map_components", "probe_url",
    "diff_to_source", "generate_patch",
    "audit_palette", "audit_typography", "audit_a11y", "audit_whitespace", "export_frame",
    "import_from_code", "update_from_code", "run_script", "delete_node"
  ];
  for (const n of expected) if (!names.includes(n)) fail(`missing tool: ${n}`);
  const unexpected = names.filter((n) => !expected.includes(n));
  if (unexpected.length) fail(`unexpected tools: ${unexpected.join(", ")}`);
  ok(`all ${expected.length} expected tools registered`);

  // Read-side tools that should succeed against the pushed payload.
  const r1 = await call("get_current_selection", { format: "html" });
  if (!r1.ok || !r1.text.includes("<div>hi</div>")) fail("get_current_selection: " + JSON.stringify(r1));
  ok("get_current_selection returns pushed html");

  const r2 = await call("get_tokens", {});
  if (!r2.ok || !r2.text.includes("ff7a29")) fail("get_tokens: " + JSON.stringify(r2));
  ok("get_tokens returns pushed tokens");

  const r3 = await call("bridge_status", {});
  if (!r3.ok || !/running/.test(r3.text)) fail("bridge_status: " + JSON.stringify(r3));
  ok("bridge_status reports running");

  const r4 = await call("get_last_export", {});
  if (!r4.ok) fail("get_last_export: " + JSON.stringify(r4));
  ok("get_last_export returns a payload");

  const r5 = await call("list_history", {});
  if (!r5.ok) fail("list_history: " + JSON.stringify(r5));
  ok("list_history returns entries");

  const r6 = await call("diff_since", { sinceMs: 0 });
  if (!r6.ok) fail("diff_since: " + JSON.stringify(r6));
  ok("diff_since returns history");

  // Plugin-dependent tools: no plugin attached → they should TIME OUT gracefully
  // (returning an error string) rather than hang the server or crash it.
  // We use a very short timeout because sendCommand will never resolve.
  const pluginTools = [
    ["select_node", { name: "Card" }],
    ["export_node", { nodeId: "1:2" }],
    ["list_screens", {}],
    ["list_components", {}],
    ["describe_screen", { nodeId: "1:2" }],
    ["export_app_spec", {}],
    ["clone_screen", { sourceNodeId: "1:2" }],
    ["recolor", { mapping: { "#000000": "#ffffff" } }],
    ["apply_tokens", {}],
    ["list_assets", { kind: "icon" }],
    ["lint_ds", {}],
    ["get_agent_bundle", { budget: "small" }],
    ["list_pages", {}],
    ["list_frames", {}],
    ["export_all_pages", {}]
  ];
  for (const [name, args] of pluginTools) {
    // These call sendCommand which times out against the bridge's own sendCommand
    // timeout (5-60s server-side). We don't want to wait that long, so we use
    // a short client rpc timeout and accept either outcome as long as the
    // server itself stays alive.
    const r = await call(name, args, 2000);
    // Either the tool returned (likely with ok:false from a server-side timeout)
    // OR our rpc timed out waiting. Server must still be alive either way.
    ok(`${name} — ${r.ok ? "responded" : "rpc timeout (expected, no plugin attached)"}`);
  }

  // Confirm server is still alive with a follow-up call.
  const alive = await call("bridge_status", {});
  if (!alive.ok || !/running/.test(alive.text)) fail("server became unresponsive after plugin-tool calls");
  ok("server still responsive after all tool calls");

  log("ALL TOOL-SURFACE CHECKS PASSED");
  child.kill();
  process.exit(0);
}

main().catch((e) => { fail(e && e.stack || e); });
