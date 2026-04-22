// End-to-end: for every plugin-dependent MCP tool, spin a fake plugin
// client on /events and respond to each command. Assert the tool returns
// the real payload the plugin sent back (not a timeout).
//
// Run: node test/tools-e2e.mjs

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "mcp", "bin", "figbridge-mcp.js");
const PORT = 7336;
const BASE = `http://127.0.0.1:${PORT}`;

function ok(m) { process.stdout.write("  ✓ " + m + "\n"); }
function fail(m) { console.error("✗", m); process.exit(1); }
function log(m) { process.stdout.write("• " + m + "\n"); }

// ── Fake plugin ──────────────────────────────────────────────
// Subscribes to SSE, responds to every "command" event with a canned body
// shaped like the real plugin's handleCommand return value.
function fakePlugin() {
  const handlers = {
    "select":          () => ({ ok: true, selected: [{ id: "1:2", name: "Card" }] }),
    "export-node":     () => ({ ok: true, exported: true }),
    "list-screens":    () => ({ ok: true, screens: [{ id: "1:2", name: "Home", category: "home" }] }),
    "list-components": () => ({ ok: true, components: [{ id: "c:1", name: "Button", variants: ["primary","secondary"], usageCount: 12 }] }),
    "describe-screen": () => ({ ok: true, screen: { id: "1:2", name: "Home", textContent: "Welcome" } }),
    "export-app-spec": () => ({ ok: true, spec: { screens: [], components: [], tokens: {} } }),
    "clone-screen":    () => ({ ok: true, cloned: { id: "1:99", name: "Home Copy" } }),
    "recolor":         () => ({ ok: true, changed: 5 }),
    "apply-tokens":    () => ({ ok: true, applied: 3 }),
    "list-assets":     () => ({ ok: true, assets: [{ id: "a:1", name: "icon", kind: "icon" }] }),
    "lint-ds":         () => ({ ok: true, issues: [] }),
    "agent-bundle":    () => ({ ok: true, pageName: "P", fileCount: 3, files: [{ path: "DESIGN.md", bytes: 10 }] }),
    "list-pages":      () => ({ ok: true, count: 2, pages: [{ id: "0:1", name: "Screens", frameCount: 5, isCurrent: true }, { id: "0:2", name: "Components", frameCount: 3, isCurrent: false }] }),
    "list-frames":     () => ({ ok: true, pageId: "0:1", pageName: "Screens", count: 2, frames: [{ id: "1:2", name: "Home", type: "FRAME", width: 390, height: 844, hasChildren: true }, { id: "1:3", name: "Settings", type: "FRAME", width: 390, height: 844, hasChildren: true }] }),
    "export-all":      () => ({ ok: true, pageCount: 1, pages: [{ pageId: "0:1", pageName: "Screens", frameCount: 1, nodeNames: ["Home"], html: "<section>home</section>", css: ".home{}", tailwindHtml: "", tokens: {}, cssVars: "" }] })
  };

  const es = new EventSource(`${BASE}/events`);
  es.addEventListener("command", async (ev) => {
    try {
      const { cmdId, action, args } = JSON.parse(ev.data);
      const fn = handlers[action];
      const body = fn ? fn(args) : { ok: false, error: "unknown action in fake: " + action };
      await fetch(`${BASE}/command/${cmdId}/result`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    } catch (e) {
      // swallow — the assertion happens on the MCP side
    }
  });
  return es;
}

// ── MCP client ──────────────────────────────────────────────
const child = spawn("node", [BIN], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, FIGBRIDGE_PORT: String(PORT) }
});
child.stderr.on("data", () => {});

let buf = "";
const pending = new Map();
let nextId = 1;
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const m = JSON.parse(line);
      if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
    } catch {}
  }
});

function rpc(method, params, timeoutMs = 10000) {
  const id = nextId++;
  const body = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(body);
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("rpc timeout: " + method)); } }, timeoutMs);
  });
}

async function callTool(name, args = {}) {
  const res = await rpc("tools/call", { name, arguments: args });
  const text = res.result?.content?.[0]?.text || "";
  return text;
}

async function main() {
  // Import EventSource — Node 18+ has global EventSource since 22.
  if (typeof globalThis.EventSource === "undefined") {
    const mod = await import("node:events").catch(() => null);
    // Fallback: use a tiny SSE parser via fetch
    globalThis.EventSource = class {
      constructor(url) {
        this.listeners = {};
        this._ac = new AbortController();
        (async () => {
          const r = await fetch(url, { signal: this._ac.signal });
          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf("\n\n")) >= 0) {
              const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
              let event = "message", data = "";
              chunk.split("\n").forEach((l) => {
                if (l.startsWith("event:")) event = l.slice(6).trim();
                else if (l.startsWith("data:")) data += l.slice(5).trim();
              });
              (this.listeners[event] || []).forEach((fn) => fn({ data }));
            }
          }
        })().catch(() => {});
      }
      addEventListener(evt, fn) { (this.listeners[evt] = this.listeners[evt] || []).push(fn); }
      close() { try { this._ac.abort(); } catch {} }
    };
  }

  // Wait for bridge
  for (let i = 0; i < 40; i++) {
    await delay(75);
    try { const r = await fetch(`${BASE}/health`); if (r.ok) break; } catch {}
  }

  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  // Seed a push so read-side tools have data
  await fetch(`${BASE}/push`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileKey: "F", fileName: "F", pageName: "Home",
      nodeNames: ["Card"], nodeIds: ["1:2"],
      html: "<div>hi</div>", css: ".x{}", tailwindHtml: "",
      tokens: { colors: { "brand/primary": "#ff7a29" } },
      cssVars: ":root{--b:1}", tailwindConfig: "module.exports={};",
      capturedAt: Date.now()
    })
  });

  // Attach the fake plugin AFTER seed so SSE is live before commands fire
  const es = fakePlugin();
  await delay(200);

  // Validate each plugin-dependent tool gets a real body back
  const cases = [
    ["select_node",      { nodeId: "1:2" },                    /selected|1:2/ ],
    ["export_node",      { nodeId: "1:2" },                    /Home|<div>hi<\/div>/ ],
    ["list_screens",     {},                                   /Home/ ],
    ["list_components",  {},                                   /Button/ ],
    ["describe_screen",  { nodeId: "1:2" },                    /Welcome/ ],
    ["export_app_spec",  {},                                   /screens|spec/ ],
    ["clone_screen",     { sourceNodeId: "1:2" },              /1:99|Copy/ ],
    ["recolor",          { mapping: { "#000": "#fff" } },      /changed|5/ ],
    ["apply_tokens",     {},                                   /applied|3/ ],
    ["list_assets",      { kind: "icon" },                     /icon/ ],
    ["lint_ds",          {},                                   /issues/ ],
    ["get_agent_bundle", { budget: "small" },                  /DESIGN|files|fileCount/ ],
    ["list_pages",       {},                                   /Screens|Components/ ],
    ["list_frames",      {},                                   /Home|Settings/ ],
    ["export_all_pages", {},                                   /<section>home<\/section>|Screens/ ]
  ];

  for (const [name, args, re] of cases) {
    const text = await callTool(name, args);
    if (!re.test(text)) fail(`${name}: body did not match ${re}. Got: ${text.slice(0, 200)}`);
    ok(`${name} → real plugin response matched ${re}`);
  }

  // Also validate read-side tools
  for (const [name, args, re] of [
    ["get_current_selection", { format: "html" }, /<div>hi<\/div>/],
    ["get_tokens",            {},                 /ff7a29/],
    ["bridge_status",         {},                 /running/],
    ["get_last_export",       {},                 /Home/],
    ["list_history",          {},                 /Home|\[/],
    ["diff_since",            { sinceMs: 0 },     /Home|\[/]
  ]) {
    const t = await callTool(name, args);
    if (!re.test(t)) fail(`${name}: body did not match ${re}. Got: ${t.slice(0,200)}`);
    ok(`${name} → read-side response matched ${re}`);
  }

  log("ALL 21 MCP TOOLS VALIDATED END-TO-END");
  es.close();
  child.kill();
  process.exit(0);
}

main().catch((e) => fail(e && e.stack || e));
