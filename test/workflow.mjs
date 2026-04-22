// Realistic agent-workflow smoke test — chains multiple MCP tools the way
// an agent would: discover → inspect → export → diff → bundle.
// Uses a fake SSE plugin client so it runs entirely offline.
//
// Run: node test/workflow.mjs

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "mcp", "bin", "figbridge-mcp.js");
const PORT = 7337;
const BASE = `http://127.0.0.1:${PORT}`;

function ok(m) { process.stdout.write("  ✓ " + m + "\n"); }
function fail(m) { console.error("✗", m); process.exit(1); }

// ── Fake plugin with a richer model ───────────────────────────
const model = {
  pages: [
    { id: "0:1", name: "Screens", frameCount: 2, isCurrent: true },
    { id: "0:2", name: "Components", frameCount: 1, isCurrent: false }
  ],
  frames: {
    "0:1": [
      { id: "1:2", name: "Home", type: "FRAME", width: 390, height: 844, hasChildren: true },
      { id: "1:3", name: "Settings", type: "FRAME", width: 390, height: 844, hasChildren: true }
    ],
    "0:2": [{ id: "2:1", name: "Button", type: "COMPONENT_SET", width: 120, height: 40, hasChildren: true }]
  }
};

function fakePlugin() {
  const handlers = {
    "list-pages":   () => ({ ok: true, count: model.pages.length, pages: model.pages }),
    "list-frames":  (a) => {
      const pid = (a && a.pageId) || "0:1";
      const frs = model.frames[pid] || [];
      const p = model.pages.find((x) => x.id === pid);
      return { ok: true, pageId: pid, pageName: p ? p.name : "?", count: frs.length, frames: frs };
    },
    "select":       (a) => ({ ok: true, selected: { id: a.nodeId, name: "Home", type: "FRAME", pageName: "Screens" } }),
    "export-node":  async (a) => {
      // Simulate the plugin pushing to /push as the real plugin does.
      await fetch(`${BASE}/push`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileKey: "F", fileName: "Demo", pageName: "Screens",
          nodeNames: ["Home"], nodeIds: [a.nodeId],
          html: `<section data-node="${a.nodeId}"><h1>Home</h1></section>`,
          css: ".home{color:#ff7a29}", tailwindHtml: "",
          tokens: { colors: { "brand/primary": "#ff7a29" } },
          cssVars: ":root{--brand-primary:#ff7a29}",
          tailwindConfig: "module.exports={};",
          capturedAt: Date.now()
        })
      });
      return { ok: true, nodeId: a.nodeId, nodeName: "Home" };
    },
    "describe-screen": (a) => ({ ok: true, screen: { id: a.nodeId, name: "Home", textContent: "Welcome home" } }),
    "agent-bundle":    () => ({ ok: true, pageName: "Screens", fileCount: 8, files: [
      { path: "DESIGN.md", kind: "text" },
      { path: "hierarchy.md", kind: "text" },
      { path: "components.json", kind: "text" },
      { path: "tokens.json", kind: "text" },
      { path: "AGENTS.md", kind: "text" }
    ] }),
    "export-all": () => ({ ok: true, pageCount: 2, pages: [
      { pageId: "0:1", pageName: "Screens", frameCount: 2, nodeNames: ["Home","Settings"], html: "<div/>", css: "", tailwindHtml: "", tokens: {}, cssVars: "" },
      { pageId: "0:2", pageName: "Components", frameCount: 1, nodeNames: ["Button"], html: "<div/>", css: "", tailwindHtml: "", tokens: {}, cssVars: "" }
    ] })
  };
  const es = new EventSource(`${BASE}/events`);
  es.addEventListener("command", async (ev) => {
    try {
      const { cmdId, action, args } = JSON.parse(ev.data);
      const fn = handlers[action];
      const body = fn ? await fn(args) : { ok: false, error: "fake: unknown action " + action };
      await fetch(`${BASE}/command/${cmdId}/result`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
      });
    } catch {}
  });
  return es;
}

// ── MCP client ───────────────────────────────────────────────
const child = spawn("node", [BIN], { stdio: ["pipe","pipe","pipe"], env: { ...process.env, FIGBRIDGE_PORT: String(PORT) } });
child.stderr.on("data", () => {});
let buf = ""; const pending = new Map(); let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue;
    try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); } } catch {}
  }
});
function rpc(method, params, t = 15000) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { resolve: res, reject: rej });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error("rpc timeout")); } }, t);
  });
}
async function tool(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  return r.result?.content?.[0]?.text || "";
}

async function main() {
  // Minimal EventSource polyfill
  if (typeof globalThis.EventSource === "undefined") {
    globalThis.EventSource = class {
      constructor(url) {
        this.listeners = {}; this._ac = new AbortController();
        (async () => {
          const r = await fetch(url, { signal: this._ac.signal });
          const reader = r.body.getReader(); const dec = new TextDecoder(); let b = "";
          while (true) {
            const { done, value } = await reader.read(); if (done) break;
            b += dec.decode(value, { stream: true }); let idx;
            while ((idx = b.indexOf("\n\n")) >= 0) {
              const chunk = b.slice(0, idx); b = b.slice(idx + 2);
              let evt = "message", data = "";
              chunk.split("\n").forEach((l) => { if (l.startsWith("event:")) evt = l.slice(6).trim(); else if (l.startsWith("data:")) data += l.slice(5).trim(); });
              (this.listeners[evt] || []).forEach((fn) => fn({ data }));
            }
          }
        })().catch(() => {});
      }
      addEventListener(e, fn) { (this.listeners[e] = this.listeners[e] || []).push(fn); }
      close() { try { this._ac.abort(); } catch {} }
    };
  }

  for (let i = 0; i < 40; i++) { await delay(75); try { if ((await fetch(`${BASE}/health`)).ok) break; } catch {} }
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "wf", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const es = fakePlugin(); await delay(200);

  // Step 1: agent discovers pages
  const t0 = Date.now();
  let txt = await tool("list_pages");
  if (!/Screens/.test(txt) || !/Components/.test(txt)) fail("list_pages missing expected pages: " + txt.slice(0,200));
  ok("step 1: list_pages → found Screens + Components");

  // Step 2: agent lists frames on Screens page
  txt = await tool("list_frames", { pageId: "0:1" });
  if (!/Home/.test(txt) || !/Settings/.test(txt)) fail("list_frames missing expected: " + txt.slice(0,200));
  ok("step 2: list_frames on 0:1 → found Home + Settings");

  // Step 3: agent selects a node
  txt = await tool("select_node", { nodeId: "1:2" });
  if (!/1:2/.test(txt)) fail("select_node lost nodeId: " + txt.slice(0,200));
  ok("step 3: select_node 1:2 → selection echoed");

  // Step 4: agent exports that node (plugin pushes to /push internally)
  txt = await tool("export_node", { nodeId: "1:2", format: "html" });
  if (!/data-node=\\?"1:2\\?"/.test(txt) || !/<h1>Home<\/h1>/.test(txt)) fail("export_node html mismatch: " + txt.slice(0,200));
  ok("step 4: export_node 1:2 → html came back from store via /push");

  // Step 5: diff_since finds the new entry
  txt = await tool("diff_since", { sinceMs: t0 });
  if (!/Home/.test(txt)) fail("diff_since missed the export: " + txt.slice(0,200));
  ok("step 5: diff_since → new entry captured");

  // Step 6: get_tokens reflects the pushed payload
  txt = await tool("get_tokens");
  if (!/ff7a29/.test(txt) || !/brand-primary/.test(txt)) fail("get_tokens missing pushed tokens: " + txt.slice(0,200));
  ok("step 6: get_tokens → pushed tokens surfaced");

  // Step 7: describe_screen
  txt = await tool("describe_screen", { nodeId: "1:2" });
  if (!/Welcome home/.test(txt)) fail("describe_screen missing: " + txt.slice(0,200));
  ok("step 7: describe_screen → summary returned");

  // Step 8: agent bundle
  txt = await tool("get_agent_bundle", { budget: "small" });
  if (!/DESIGN\.md/.test(txt) || !/AGENTS\.md/.test(txt)) fail("agent_bundle missing files: " + txt.slice(0,200));
  ok("step 8: get_agent_bundle → manifest lists bundle files");

  // Step 9: full-file export
  txt = await tool("export_all_pages");
  if (!/Screens/.test(txt) || !/Components/.test(txt) || !/pageCount/.test(txt)) fail("export_all_pages incomplete: " + txt.slice(0,200));
  ok("step 9: export_all_pages → both pages returned");

  // Step 10: bridge stays healthy
  txt = await tool("bridge_status");
  if (!/running/.test(txt) || !/pluginConnected.*true/s.test(txt)) fail("bridge not healthy: " + txt.slice(0,200));
  ok("step 10: bridge_status → running, plugin connected");

  process.stdout.write("• AGENT WORKFLOW PASSED (10 steps)\n");
  es.close(); child.kill(); process.exit(0);
}

main().catch((e) => fail(e && e.stack || e));
