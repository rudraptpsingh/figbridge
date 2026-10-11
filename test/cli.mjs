#!/usr/bin/env node
// `figbridge-mcp call` / `tools`: run tools without an MCP client. Exercises
// JSON args (inline, @file, stdin), exit codes (0 ok, 1 ok:false, 2 usage),
// and a plugin-backed tool failing fast when no plugin is connected.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "mcp", "bin", "figbridge-mcp.js");
const tmp = mkdtempSync(path.join(tmpdir(), "figbridge-cli-"));
// Own port + own home: never attach to (or write into) a real session.
const env = { ...process.env, FIGBRIDGE_PORT: "7381", FIGBRIDGE_HOME: path.join(tmp, ".figbridge") };
delete env.FIGBRIDGE_CONNECT;

function run(args, stdin) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd: tmp, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
    child.stdin.end(stdin || "");
  });
}

mkdirSync(path.join(tmp, "src"), { recursive: true });
writeFileSync(path.join(tmp, "src", "Badge.tsx"), `export type Tone = 'info' | 'danger'
export function Badge({ tone, children }: { tone?: Tone; children: string }) { return null }
`);
const entry = (tone) => ({
  figma: { nodeId: "1:2", name: "Badge", properties: { Tone: { type: "VARIANT", options: ["Info", "Danger"] }, Text: { type: "TEXT" } } },
  code: { source: "src/Badge.tsx", export: "Badge" },
  props: { tone: { figma: "Tone", type: "enum", values: { Info: "info", Danger: tone } }, children: { figma: "Text", type: "text" } },
});
const good = path.join(tmp, "figbridge.connect.json");
writeFileSync(good, JSON.stringify({ version: 1, fileKey: null, components: [entry("danger")] }));
const bad = path.join(tmp, "bad.connect.json");
writeFileSync(bad, JSON.stringify({ version: 1, fileKey: null, components: [entry("error")] }));

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log("  ✓", name); }
  catch (e) { console.error("  ✗", name, "\n", e && e.stack || e); process.exitCode = 1; }
}

await t("tools lists the Code Connect tools", async () => {
  const r = await run(["tools"]);
  assert.equal(r.code, 0, r.err);
  for (const name of ["connect_components", "get_code_connect", "lint_connect", "map_components"]) assert.match(r.out, new RegExp(`^${name}\\t`, "m"));
});

await t("call lint_connect exits 0 and prints JSON for a clean map (connect file found from cwd)", async () => {
  const r = await run(["call", "lint_connect", "{}"]);
  assert.equal(r.code, 0, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.ok, true);
  assert.equal(j.checked, 1);
  assert.equal(path.resolve(j.connectFile), path.resolve(good));
});

await t("call lint_connect exits 1 when the map has rotted (CI gate)", async () => {
  const r = await run(["call", "lint_connect", JSON.stringify({ connectFile: bad })]);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.out);
  assert.equal(j.errors[0].code, "value-invalid");
});

await t("call get_code_connect reads args from @file and returns the snippet", async () => {
  const argsFile = path.join(tmp, "args.json");
  writeFileSync(argsFile, JSON.stringify({ node: JSON.stringify({ nodeId: "5:6", componentSet: { id: "1:2", name: "Badge" }, properties: { Tone: { type: "VARIANT", value: "Danger" }, "Text#1:3": { type: "TEXT", value: "Failed" } } }) }));
  const r = await run(["call", "get_code_connect", "@" + argsFile]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(JSON.parse(r.out).snippet, "import { Badge } from './src/Badge'\n\n<Badge tone=\"danger\">Failed</Badge>");
});

await t("call reads args from stdin with -", async () => {
  const r = await run(["call", "map_components", "-"], JSON.stringify({ sourceDir: path.join(tmp, "src") }));
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).fileCount, 1);
});

await t("a plugin-backed tool fails fast with ok:false and exit 1 when no plugin is connected", async () => {
  const started = Date.now();
  const r = await run(["call", "list_pages", "{}"]);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.out).error, /plugin is not connected/);
  assert.ok(Date.now() - started < 30000);
});

await t("usage errors exit 2", async () => {
  assert.equal((await run(["call"])).code, 2);
  assert.equal((await run(["call", "nope_tool", "{}"])).code, 2);
  const r = await run(["call", "lint_connect", "{not json"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /bad arguments/);
});

rmSync(tmp, { recursive: true, force: true });
if (process.exitCode) console.error(`\nFAIL  cli (${passed} passed)`);
else console.log(`\nPASS  figbridge-mcp call / tools (${passed} tests).`);
