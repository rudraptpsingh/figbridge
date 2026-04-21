// Figbridge demo — boots the bridge, attaches a fake Figma plugin with canned
// data, and walks through the three headline flows Claude users will run:
//   1. Spec-to-app   → export_app_spec
//   2. Rebrand       → recolor + apply_tokens
//   3. DS lint       → lint_ds
//
// Run:  node test/demo.mjs
// No Figma required.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(HERE, "..", "mcp", "bin", "figbridge-mcp.js");
const PORT = 7340; // different from 7331 to avoid clashing with a real install
const BASE = `http://127.0.0.1:${PORT}`;

const C = { dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m", green: "\x1b[32m", cyan: "\x1b[36m", yellow: "\x1b[33m", magenta: "\x1b[35m" };
const say = (who, msg) => console.log(`${C.bold}${who}${C.reset}  ${msg}`);
const user = (msg) => say(`${C.magenta}you${C.reset}`, msg);
const claude = (msg) => say(`${C.cyan}claude${C.reset}`, msg);
const tool = (name, body) => console.log(`${C.dim}  → ${name}${C.reset} ${C.dim}${body}${C.reset}`);
const scene = (title) => console.log(`\n${C.yellow}━━ ${title} ━━${C.reset}`);

// ── fake plugin: subscribes to /events and auto-answers commands ────────────
function attachFakePlugin() {
  const controller = new AbortController();
  const screens = [
    { nodeId: "1:9", name: "S01 Splash", pageName: "Onboarding", width: 390, height: 844, category: "splash", orderHint: 0 },
    { nodeId: "1:21", name: "S02 Welcome", pageName: "Onboarding", width: 390, height: 844, category: "onboarding", orderHint: 1 },
    { nodeId: "1:37", name: "S03 Sign in", pageName: "Onboarding", width: 390, height: 844, category: "auth", orderHint: 2 },
    { nodeId: "2:4", name: "H01 Home", pageName: "App", width: 390, height: 844, category: "home", orderHint: 0 },
    { nodeId: "2:88", name: "D01 Detail", pageName: "App", width: 390, height: 844, category: "detail", orderHint: 1 },
    { nodeId: "2:140", name: "ST01 Settings", pageName: "App", width: 390, height: 844, category: "settings", orderHint: 2 }
  ];
  const components = [
    { nodeId: "c:1", name: "Button", kind: "COMPONENT_SET", variantCount: 4, variants: ["primary/sm", "primary/lg", "ghost/sm", "ghost/lg"] },
    { nodeId: "c:2", name: "Card", kind: "COMPONENT" },
    { nodeId: "c:3", name: "Input", kind: "COMPONENT_SET", variantCount: 3, variants: ["default", "focus", "error"] }
  ];
  const tokens = {
    colors: { "brand/primary": "#ff7a29", "ink/0": "#0e0f12", "snow/0": "#ffffff", "muted/500": "#7a7f89" },
    numbers: { "spacing/sm": 8, "spacing/md": 16, "spacing/lg": 24, "radius/md": 12 },
    strings: {}, booleans: {}
  };
  const reply = {
    "list-screens": () => ({ count: screens.length, screens }),
    "list-components": () => ({ count: components.length, components }),
    "describe-screen": (args) => {
      const s = screens.find((x) => x.nodeId === args.nodeId) || screens[0];
      return {
        nodeId: s.nodeId, name: s.name, pageName: s.pageName, width: s.width, height: s.height,
        background: "#0e0f12", category: s.category,
        textContent: ["Draftr", "Design at the speed of thought", "Get started"],
        componentsUsed: ["Button/primary/lg"],
        summary: `Screen "${s.name}" on page "${s.pageName}" — ${s.width}×${s.height}, dark canvas, hero wordmark + CTA. Category: ${s.category}.`
      };
    },
    "export-app-spec": () => ({
      spec: {
        fileName: "Draftr — iOS App Design",
        capturedAt: Date.now(),
        screens, components, tokens,
        cssVars: `:root {\n  --color-brand-primary: #ff7a29;\n  --color-ink-0: #0e0f12;\n  --spacing-md: 16px;\n}`,
        tailwindConfig: `module.exports = { theme: { extend: { colors: { brand: { primary: '#ff7a29' } } } } };`,
        byCategory: { splash: ["1:9"], onboarding: ["1:21"], auth: ["1:37"], home: ["2:4"], detail: ["2:88"], settings: ["2:140"] },
        flows: { Onboarding: ["1:9", "1:21", "1:37"], App: ["2:4", "2:88", "2:140"] }
      }
    }),
    "recolor": (args) => ({ changes: 9, nodesVisited: 58, mapping: args.mapping }),
    "apply-tokens": () => ({ bound: 14, unboundRemaining: 1, availableColorVariables: 4 }),
    "lint-ds": () => ({
      findings: [
        { rule: "unbound-color", nodeId: "2:4", nodeName: "Home / banner", hex: "#ff7a29" },
        { rule: "unbound-color", nodeId: "2:88", nodeName: "Detail / price", hex: "#0e0f12" },
        { rule: "non-grid-spacing", nodeId: "2:140", nodeName: "Settings / row", padding: 13 },
        { rule: "orphan-component", nodeId: "c:3", nodeName: "Input" },
        { rule: "duplicate-name", name: "Card", nodeIds: ["c:2", "c:99"] }
      ],
      counts: { "unbound-color": 2, "non-grid-spacing": 1, "orphan-component": 1, "duplicate-name": 1 }
    }),
    "select": (args) => ({ selected: args.nodeId || screens.find((s) => s.name.toLowerCase().includes((args.name || "").toLowerCase()))?.nodeId || null })
  };

  (async () => {
    try {
      const res = await fetch(`${BASE}/events`, { signal: controller.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
          const lines = frame.split("\n");
          let ev = "message", data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) ev = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (ev !== "command") continue;
          let payload; try { payload = JSON.parse(data); } catch { continue; }
          const handler = reply[payload.action];
          const body = handler ? handler(payload.args || {}) : { ok: false, error: `unknown action: ${payload.action}` };
          await fetch(`${BASE}/command/${payload.cmdId}/result`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: true, result: body })
          });
        }
      }
    } catch {}
  })();
  return () => controller.abort();
}

// ── bring up the MCP server (stdio) ────────────────────────────────────────
function startServer() {
  const node = process.execPath;
  const child = spawn(node, [BIN], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, FIGBRIDGE_PORT: String(PORT) } });
  const state = { buf: "", pending: new Map(), nextId: 1 };
  child.stdout.on("data", (d) => {
    state.buf += d.toString();
    let idx;
    while ((idx = state.buf.indexOf("\n")) >= 0) {
      const line = state.buf.slice(0, idx).trim(); state.buf = state.buf.slice(idx + 1);
      if (!line) continue;
      try { const m = JSON.parse(line); if (m.id && state.pending.has(m.id)) { state.pending.get(m.id).resolve(m); state.pending.delete(m.id); } } catch {}
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = state.nextId++;
    state.pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (state.pending.has(id)) { state.pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, rpc, notify };
}

async function waitBridge() {
  for (let i = 0; i < 40; i++) { await delay(100); try { const r = await fetch(`${BASE}/health`); if (r.ok) return; } catch {} }
  throw new Error("bridge never came up");
}

async function callTool(s, name, args = {}) {
  const r = await s.rpc("tools/call", { name, arguments: args });
  const text = r.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return text; }
}

async function main() {
  console.log(`${C.bold}\nFigbridge demo — what Claude + Figma feels like, with zero Figma${C.reset}\n${C.dim}(boots a local bridge on :${PORT}, attaches a fake plugin, runs three flows)${C.reset}`);

  const server = startServer();
  await waitBridge();
  await server.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "figbridge-demo", version: "1" } });
  server.notify("notifications/initialized", {});
  const detach = attachFakePlugin();
  await delay(200);

  // ── Flow 1 ──────────────────────────────────────────────
  scene("Flow 1 — \"Build me this app\"");
  user("Use figbridge export_app_spec. Scaffold a Next.js app that matches every screen.");
  claude("Calling export_app_spec…");
  const spec = await callTool(server, "export_app_spec");
  tool("export_app_spec", `→ ${spec.screens.length} screens, ${spec.components.length} components, ${Object.keys(spec.byCategory).length} categories`);
  claude(`Got the full catalog — "${spec.fileName}". I'll generate:`);
  console.log(`    • ${spec.screens.length} routes (one per screen, grouped by category: ${Object.keys(spec.byCategory).join(", ")})`);
  console.log(`    • tailwind.config.js from ${Object.keys(spec.tokens.colors).length} colors + ${Object.keys(spec.tokens.numbers).length} spacing tokens`);
  console.log(`    • <Button /> (4 variants), <Card />, <Input /> (3 variants) from the component catalog`);
  console.log(`  ${C.dim}[in a real session, Claude now writes the app files]${C.reset}`);

  // ── Flow 2 ──────────────────────────────────────────────
  scene("Flow 2 — \"Rebrand in 30 seconds\"");
  user("Recolor the whole file #ff7a29 → #3ddc97, then bind loose fills to variables.");
  claude("Calling recolor…");
  const rec = await callTool(server, "recolor", { scope: "file", mapping: { "#ff7a29": "#3ddc97" } });
  tool("recolor", `→ ${rec.changes} fills updated across ${rec.nodesVisited} nodes`);
  claude("Calling apply_tokens to bind the new color to existing variables…");
  const ap = await callTool(server, "apply_tokens", {});
  tool("apply_tokens", `→ bound ${ap.bound}, ${ap.unboundRemaining} remain unbound (of ${ap.availableColorVariables} variables)`);
  claude(`Done. The brand color flipped everywhere and ${ap.bound} layers are now tied to \`--color-brand-primary\` — so the next swap is one variable edit.`);

  // ── Flow 3 ──────────────────────────────────────────────
  scene("Flow 3 — \"/design-review\"");
  user("/design-review");
  claude("Calling lint_ds on the whole file…");
  const lint = await callTool(server, "lint_ds", {});
  tool("lint_ds", `→ ${lint.findings.length} findings across ${Object.keys(lint.counts).length} rules`);
  console.log(`\n    ${C.bold}🧭 Figbridge design review${C.reset}`);
  console.log(`    ${C.dim}File: ${spec.fileName}${C.reset}`);
  for (const [rule, count] of Object.entries(lint.counts)) {
    console.log(`    • ${rule.padEnd(20)} ${String(count).padStart(2)}`);
  }
  console.log(`    ${C.dim}Suggested: run apply_tokens to bind 2 unbound colors, round 1 off-grid value to 12px.${C.reset}`);

  // ── Wrap ────────────────────────────────────────────────
  scene("That's it");
  console.log(`  17 MCP tools. 0 Figma Dev seats. Fully local.`);
  console.log(`  Install:  ${C.cyan}npx figbridge-mcp init${C.reset}`);
  console.log(`  Docs:     ${C.cyan}https://rudraptpsingh.github.io/figbridge${C.reset}\n`);

  detach();
  server.child.kill();
  await delay(100);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
