#!/usr/bin/env node
// Unit tests for the local Code Connect: TS props reading, suggestions,
// prop mapping + snippets, lint (each failure mode), connect-file lookup,
// the plugin/run_script node-info parity, and the bridge /code-connect route.
// No Figma needed.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), "figbridge-cc-"));
process.env.FIGBRIDGE_HOME = path.join(tmp, ".figbridge");
delete process.env.FIGBRIDGE_CONNECT;

const { readComponentProps, literalsOf, listExports, acceptsProp } = await import("../mcp/src/ts-props.js");
const cc = await import("../mcp/src/code-connect.js");

let passed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { passed++; console.log("  ✓", name); },
    (e) => { console.error("  ✗", name, "\n", e && e.stack || e); process.exitCode = 1; }
  );
}
const write = (rel, text) => { const f = path.join(tmp, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); return f; };

// ── Fixture repo ────────────────────────────────────────────────────────────
write("src/states.ts", `
export const SYNC_STATES = [
  'local',
  'synced',
  'needs_attention',
] as const
export type SyncState = (typeof SYNC_STATES)[number]
`);
write("src/components/Button.tsx", `import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/** Figma Button \`Style\`. */
export type ButtonVariant = 'primary' | 'secondary' | 'quiet'
export type ButtonSize = 'm' | 'l'

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** the style */
  variant?: ButtonVariant
  size?:
    | ButtonSize
    | undefined
  icon?: LucideIcon
  loading?: boolean
  testId: string
  children: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'm', icon: Icon, loading = false, testId, children, ...rest },
  ref
) {
  return <button ref={ref} data-testid={testId} {...rest}>{children}</button>
})
`);
write("src/components/Kbd.tsx", `import type { ReactNode } from 'react'
export type KbdTone = 'default' | 'on-accent'
export function Kbd({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: KbdTone
  // a comment with a colon: not a prop
}) {
  return <kbd data-testid="kbd" data-tone={tone}>{children}</kbd>
}
`);
write("src/components/StatusChip.tsx", `import { type SyncState } from '../states'
type Tone = 'neutral' | 'info'
interface BaseProps { onClick?: () => void }
type SyncStatusProps = BaseProps & { state: SyncState; count?: number }
export function StatusChip({ label, tone }: { label: string; tone?: Tone }) { return null }
export function SyncStatus({ state, count }: SyncStatusProps) { return <span data-testid="sync-status" /> }
`);
write("src/components/Toggle.tsx", `interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  label?: string
}
export function Toggle({ checked, onChange, label }: ToggleProps) { return null }
`);

const FILE_KEY = "AbCdEfGhIjKlMnOpQrStUv";
const figmaButton = {
  nodeId: "59:944", name: "Button", fileKey: FILE_KEY,
  description: "A capsule button.\nCode: src/components/Button.tsx (wraps .btn)\nTest id: passed in by the caller",
  properties: {
    "Label#59:128": { type: "TEXT", defaultValue: "Start" },
    "Show icon#59:129": { type: "BOOLEAN", defaultValue: false },
    "Icon#59:130": { type: "INSTANCE_SWAP", defaultValue: "59:689" },
    "Style": { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Secondary", "Quiet"] },
    "State": { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "Hover", "Disabled", "Loading"] },
    "Size": { type: "VARIANT", defaultValue: "M", variantOptions: ["M", "L"] },
  },
};
const figmaKeycap = {
  nodeId: "40:399", name: "Keycap", fileKey: FILE_KEY,
  description: "One key.\nCode: src/components/Kbd.tsx\nTest id: kbd",
  properties: { "Key#40:2": { type: "TEXT", defaultValue: "Enter" }, "Tone": { type: "VARIANT", defaultValue: "Default", variantOptions: ["Default", "On accent"] } },
};
const figmaSync = {
  nodeId: "40:671", name: "Sync status", fileKey: FILE_KEY,
  description: "Test id: sync-status",  // no Code: line → found through the data-testid index
  properties: { "State": { type: "VARIANT", defaultValue: "Synced", variantOptions: ["Synced", "Off", "Needs attention"] } },
};
const figmaToggle = {
  nodeId: "84:1823", name: "Toggle", fileKey: FILE_KEY, description: "Code: src/components/Toggle.tsx",
  properties: { "State": { type: "VARIANT", defaultValue: "Off", variantOptions: ["Off", "On"] } },
};

console.log("\n— ts-props —");

await t("reads forwardRef props through interface extends Omit<…HTMLAttributes>", () => {
  const info = readComponentProps(path.join(tmp, "src/components/Button.tsx"), "Button");
  assert.equal(info.exported, true);
  assert.equal(info.typeExpr, "ButtonProps");
  assert.deepEqual(Object.keys(info.members), ["variant", "size", "icon", "loading", "testId", "children"]);
  assert.equal(info.inheritsDom, true);
  assert.ok(info.omitted.has("children"));
  assert.ok(acceptsProp(info, "disabled"), "DOM prop inherited");
  assert.ok(acceptsProp(info, "aria-label"));
  assert.ok(!acceptsProp(info, "tone"));
  assert.deepEqual(literalsOf(info.members.variant.type, info.ctx), ["primary", "secondary", "quiet"]);
  assert.deepEqual(literalsOf(info.members.size.type, info.ctx), ["m", "l"], "multi-line union through an alias");
});

await t("reads an inline destructured param type and ignores comments", () => {
  const info = readComponentProps(path.join(tmp, "src/components/Kbd.tsx"), "Kbd");
  assert.deepEqual(Object.keys(info.members), ["children", "tone"]);
  assert.equal(info.inheritsDom, false);
  assert.deepEqual(literalsOf(info.members.tone.type, info.ctx), ["default", "on-accent"]);
});

await t("resolves a literal union imported from another module as (typeof CONST)[number]", () => {
  const info = readComponentProps(path.join(tmp, "src/components/StatusChip.tsx"), "SyncStatus");
  assert.deepEqual(Object.keys(info.members).sort(), ["count", "onClick", "state"]);
  assert.deepEqual(literalsOf(info.members.state.type, info.ctx), ["local", "synced", "needs_attention"]);
  assert.equal(literalsOf(info.members.count.type, info.ctx), null, "number is not a literal union");
});

await t("lists PascalCase value exports only", () => {
  assert.deepEqual(listExports(readFileSync(path.join(tmp, "src/components/StatusChip.tsx"), "utf8")), ["StatusChip", "SyncStatus"]);
});

console.log("\n— suggest —");

const { buildSourceIndex } = await import("../mcp/src/source-index.js");
const index = await buildSourceIndex(tmp);
const connect = cc.emptyConnect(FILE_KEY);
connect.imports = { "src/": "@/" };
const ctx = { root: tmp, index, fileKey: FILE_KEY, connect };

await t("suggests a full Button entry from the description's Code: line", () => {
  const s = cc.suggestEntry(figmaButton, ctx);
  assert.equal(s.confidence, "high");
  assert.equal(s.via, "description");
  const e = s.entry;
  assert.equal(e.code.source, "src/components/Button.tsx");
  assert.equal(e.code.export, "Button");
  assert.equal(e.code.import, "import { Button } from '@/components/Button'");
  assert.deepEqual(e.props.variant, { figma: "Style", type: "enum", values: { Primary: "primary", Secondary: "secondary", Quiet: "quiet" } });
  assert.deepEqual(e.props.size.values, { M: "m", L: "l" });
  assert.deepEqual(e.props.loading, { figma: "State", type: "enum", values: { Loading: true } });
  assert.deepEqual(e.props.disabled, { figma: "State", type: "enum", values: { Disabled: true } });
  assert.deepEqual(e.props.children, { figma: "Label", type: "text" });
  assert.equal(e.props.icon.as, "component", "LucideIcon prop takes the component");
  assert.equal(e.props.icon.when, "Show icon");
  assert.equal(e.props.icon.importFrom, "lucide-react");
  assert.deepEqual(e.figma.properties.Style, { type: "VARIANT", options: ["Primary", "Secondary", "Quiet"] });
  assert.deepEqual(e.figma.properties.Label, { type: "TEXT" }, "snapshot keys drop the #id suffix");
});

await t("suggests an export whose name differs (Keycap → Kbd) and maps a TEXT to children", () => {
  const s = cc.suggestEntry(figmaKeycap, ctx);
  assert.equal(s.entry.code.export, "Kbd");
  assert.equal(s.confidence, "medium");
  assert.deepEqual(s.entry.props.children, { figma: "Key", type: "text" });
  assert.deepEqual(s.entry.props.tone.values, { Default: "default", "On accent": "on-accent" });
});

await t("falls back to the data-testid index and picks the matching export in a multi-export file", () => {
  const s = cc.suggestEntry(figmaSync, ctx);
  assert.equal(s.via, "data-testid");
  assert.equal(s.entry.code.export, "SyncStatus");
  assert.deepEqual(s.entry.props.state.values, { Synced: "synced", "Needs attention": "needs_attention" }, "Off has no literal twin");
});

await t("maps a two-state variant to a required boolean both ways", () => {
  const s = cc.suggestEntry(figmaToggle, ctx);
  assert.deepEqual(s.entry.props.checked, { figma: "State", type: "enum", values: { On: true, Off: false } });
});

console.log("\n— map + snippet —");

const button = cc.suggestEntry(figmaButton, ctx).entry;
button.props.testId = { type: "static", expr: "testId" };
const instance = (props, extra = {}) => ({
  nodeId: "I120:3332;118:3300", type: "INSTANCE", name: "export", fileKey: FILE_KEY,
  mainComponent: { id: "59:776", name: "Style=Secondary, State=Default, Size=M" },
  componentSet: { id: "59:944", name: "Button" },
  properties: props, ...extra,
});
cc.upsertEntries(connect, [button, cc.suggestEntry(figmaKeycap, ctx).entry, cc.suggestEntry(figmaSync, ctx).entry]);

await t("renders the Dev Mode style snippet for a real Button instance", () => {
  const r = cc.getCodeConnect(connect, instance({
    "Key hint#59:131": { type: "BOOLEAN", value: false },
    "Icon#59:130": { type: "INSTANCE_SWAP", value: "59:551", name: "Icon/download" },
    "Show icon#59:129": { type: "BOOLEAN", value: true },
    "Label#59:128": { type: "TEXT", value: "Export 186" },
    "Style": { type: "VARIANT", value: "Secondary" },
    "State": { type: "VARIANT", value: "Default" },
    "Size": { type: "VARIANT", value: "M" },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.props, { icon: "Download", variant: "secondary", size: "m", testId: "testId" });
  assert.equal(r.children, "Export 186");
  assert.deepEqual(r.unmappedFigmaProps, ["Key hint"]);
  assert.equal(r.snippet, [
    "import { Button } from '@/components/Button'",
    "import { Download } from 'lucide-react'",
    "",
    '<Button icon={Download} variant="secondary" size="m" testId={testId}>Export 186</Button>',
  ].join("\n"));
});

await t("gates props on Show icon and maps Loading/Disabled states", () => {
  const r = cc.getCodeConnect(connect, instance({
    "Icon#59:130": { type: "INSTANCE_SWAP", value: "59:551", name: "Icon/download" },
    "Show icon#59:129": { type: "BOOLEAN", value: false },
    "Label#59:128": { type: "TEXT", value: "Save {draft}" },
    "Style": { type: "VARIANT", value: "Primary" },
    "State": { type: "VARIANT", value: "Loading" },
    "Size": { type: "VARIANT", value: "L" },
  }));
  assert.equal(r.props.icon, undefined, "icon hidden when Show icon is off");
  assert.equal(r.props.loading, true);
  assert.ok(r.snippet.includes(" loading "), "true renders as a bare attribute");
  assert.ok(r.snippet.includes('>{"Save {draft}"}</Button>'), "JSX-unsafe text is escaped");
  assert.ok(!r.snippet.includes("lucide-react"), "no icon import without an icon");
});

await t("resolves by component-set name when ids differ (library copy), and reports unmapped", () => {
  const r = cc.getCodeConnect(connect, { nodeId: "9:9", componentSet: { id: "999:1", name: "keycap" }, properties: { "Key#40:2": { type: "TEXT", value: "⌘K" }, Tone: { type: "VARIANT", value: "On accent" } } });
  assert.equal(r.ok, true);
  assert.equal(r.snippet.split("\n").pop(), '<Kbd tone="on-accent">⌘K</Kbd>');
  const miss = cc.getCodeConnect(connect, { nodeId: "1:1", componentSet: { id: "1:2", name: "Slider" }, properties: {} });
  assert.equal(miss.ok, false);
  assert.match(miss.error, /no connect entry for "Slider"/);
});

await t("example templates fill {{props}}, {{children}} and {{figma.X}}", () => {
  const e = { figma: { nodeId: "40:606", name: "Segment" }, code: { source: "src/components/Kbd.tsx", export: "Kbd" },
    props: { tone: { figma: "Tone", type: "enum", values: { Default: "default" } } },
    example: "<Seg{{props}} options={[{ label: '{{figma.Label}}' }]} />" };
  const m = cc.mapProps(e, { "Label#40:95": { type: "TEXT", value: "Rock'n" }, Tone: { type: "VARIANT", value: "Default" } });
  const out = cc.renderSnippet(e, m, connect).split("\n").pop();
  assert.equal(out, "<Seg tone=\"default\" options={[{ label: 'Rock\\'n' }]} />");
});

console.log("\n— lint —");

const connectFile = path.join(tmp, cc.CONNECT_FILE);
cc.writeConnect(connectFile, connect);

await t("a fresh map lints clean; the file is written sorted by Figma name", () => {
  const data = cc.readConnect(connectFile);
  assert.deepEqual(data.components.map((c) => c.figma.name), ["Button", "Keycap", "Sync status"]);
  const r = cc.lintConnect(data, { root: tmp });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.checked, 3);
});

function lintWith(mutate) {
  const data = JSON.parse(readFileSync(connectFile, "utf8"));
  mutate(data.components);
  return cc.lintConnect(data, { root: tmp });
}
const codes = (r) => r.errors.map((e) => e.code);

await t("flags a missing source file", () => {
  assert.deepEqual(codes(lintWith((c) => { c[0].code.source = "src/components/Gone.tsx"; })), ["source-missing"]);
});
await t("flags a missing export", () => {
  const r = lintWith((c) => { c[0].code.export = "Buton"; c[0].code.import = "import { Buton } from '@/components/Button'"; });
  assert.deepEqual(codes(r), ["export-missing"]);
  assert.match(r.errors[0].message, /exports: Button/);
});
await t("flags a prop the component does not have", () => {
  const r = lintWith((c) => { c[0].props.tone = { figma: "Style", type: "enum", values: { Primary: "x" } }; });
  assert.deepEqual(codes(r), ["prop-missing"]);
});
await t("flags an enum value that left the prop's literal union (code drift)", () => {
  const r = lintWith((c) => { c[0].props.variant.values.Quiet = "ghost"; });
  assert.deepEqual(codes(r), ["value-invalid"]);
  assert.match(r.errors[0].message, /variant="ghost" is not one of 'primary' \| 'secondary' \| 'quiet'/);
});
await t("flags an imported-union value too (SyncState)", () => {
  assert.deepEqual(codes(lintWith((c) => { c[2].props.state.values.Off = "off"; })), ["value-invalid"]);
});
await t("flags a primitive type mismatch (boolean prop mapped to a string)", () => {
  assert.deepEqual(codes(lintWith((c) => { c[0].props.loading.values.Loading = "yes"; })), ["value-invalid"]);
});
await t("flags a Figma property or variant value missing from the snapshot (design drift)", () => {
  assert.deepEqual(codes(lintWith((c) => { c[0].props.size.figma = "Scale"; })), ["figma-prop-missing"]);
  assert.deepEqual(codes(lintWith((c) => { c[0].props.size.values.XL = "l"; })), ["figma-value-missing"]);
});
await t("flags duplicates and malformed node ids", () => {
  const r = lintWith((c) => { c.push(JSON.parse(JSON.stringify(c[0]))); c[1].figma.nodeId = "40-399"; });
  assert.deepEqual(codes(r).sort(), ["duplicate", "figma-node-id"]);
});

console.log("\n— connect file lookup —");

await t("finds the file upwards from cwd, and by remembered Figma file key", () => {
  const deep = path.join(tmp, "src", "components");
  assert.equal(cc.findConnectFile({ cwd: deep }), connectFile);
  assert.equal(cc.findConnectFile({ fileKey: FILE_KEY, cwd: path.parse(tmp).root }), null, "nothing remembered yet");
  cc.rememberConnectFile(FILE_KEY, connectFile);
  assert.equal(cc.findConnectFile({ fileKey: FILE_KEY, cwd: path.parse(tmp).root }), connectFile);
  assert.equal(cc.findConnectFile({ connectFile: "x.json", cwd: tmp }), path.join(tmp, "x.json"));
});

console.log("\n— plugin parity —");

// A tiny Figma API stand-in: one Button instance whose icon was swapped.
function fakeFigma() {
  const set = { id: "59:944", name: "Button", type: "COMPONENT_SET", key: "k-set",
    componentPropertyDefinitions: { Style: { type: "VARIANT", defaultValue: "Primary", variantOptions: ["Primary", "Secondary"] }, "Label#59:128": { type: "TEXT", defaultValue: "Start" } } };
  const variant = { id: "59:776", name: "Style=Secondary", type: "COMPONENT", key: "k-var", parent: set, variantProperties: { Style: "Secondary" } };
  set.defaultVariant = variant;
  const icon = { id: "59:551", name: "Icon/download", type: "COMPONENT" };
  const inst = { id: "I1:2;3:4", name: "export", type: "INSTANCE",
    getMainComponentAsync: async () => variant,
    componentProperties: { Style: { type: "VARIANT", value: "Secondary" }, "Label#59:128": { type: "TEXT", value: "Export" }, "Icon#59:130": { type: "INSTANCE_SWAP", value: "59:551" } } };
  const byId = { [set.id]: set, [variant.id]: variant, [icon.id]: icon, [inst.id]: inst };
  return { fileKey: FILE_KEY, currentPage: { selection: [inst] }, getNodeByIdAsync: async (id) => byId[id] || null };
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

await t("plugin codeConnectInfo() and the run_script nodeInfoScript() describe a node identically", async () => {
  const src = readFileSync(path.join(__dirname, "..", "plugin", "code.js"), "utf8");
  const start = src.indexOf("async function codeConnectInfo(");
  const end = src.indexOf("\n}\n", start) + 2;
  assert.ok(start > 0 && end > start, "codeConnectInfo is a top-level function in plugin/code.js");
  const pluginFn = new Function("figma", src.slice(start, end) + "\nreturn codeConnectInfo;");
  for (const target of [null, "59:944", "59:776"]) {
    const figma = fakeFigma();
    const node = target ? await figma.getNodeByIdAsync(target) : figma.currentPage.selection[0];
    const fromPlugin = await pluginFn(figma)(node);
    const fromScript = await new AsyncFunction("figma", cc.nodeInfoScript(target))(figma);
    delete fromScript.ok;
    for (const k of ["mainComponent", "componentSet"]) if (fromScript[k]) delete fromScript[k].key;
    assert.deepEqual(fromPlugin, fromScript, `target ${target || "selection"}`);
  }
  const info = await pluginFn(fakeFigma())(fakeFigma().currentPage.selection[0]);
  assert.equal(info.properties["Icon#59:130"].name, "Icon/download");
  assert.equal(info.componentSet.id, "59:944");
});

console.log("\n— bridge route —");

await t("POST /code-connect maps a node through the remembered connect file", async () => {
  const { startBridge } = await import("../mcp/src/bridge.js");
  const { server, port } = await startBridge(7391, () => {});
  try {
    const node = instance({ Style: { type: "VARIANT", value: "Quiet" }, "Label#59:128": { type: "TEXT", value: "Skip" }, State: { type: "VARIANT", value: "Default" }, Size: { type: "VARIANT", value: "M" } });
    const r = await fetch(`http://127.0.0.1:${port}/code-connect`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ node, fileKey: FILE_KEY }) }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.connectFile, connectFile);
    assert.ok(r.snippet.endsWith('<Button variant="quiet" size="m" testId={testId}>Skip</Button>'), r.snippet);
    const bad = await fetch(`http://127.0.0.1:${port}/code-connect`, { method: "POST", body: "{}" });
    assert.equal(bad.status, 400);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  }
});

rmSync(tmp, { recursive: true, force: true });
if (process.exitCode) { console.error(`\nFAIL  code-connect (${passed} passed)`); }
else console.log(`\nPASS  code-connect unit tests (${passed} tests).`);
