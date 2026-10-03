// code-connect.js — Figma Code Connect, local and free.
//
// A connect file (`figbridge.connect.json`) committed in the consuming repo
// maps Figma components to code components:
//
//   {
//     "version": 1,
//     "fileKey": "WwO2ckSkwjOeusmEQwWrus",
//     "imports": { "src/": "@/" },               // optional path → alias rewrites
//     "components": [{
//       "figma": { "fileKey": "…", "nodeId": "59:944", "name": "Button",
//                  "properties": { "Style": { "type": "VARIANT", "options": ["Primary", …] }, … } },
//       "code":  { "source": "src/components/primitives/Button.tsx", "export": "Button",
//                  "import": "import { Button } from '@/components/primitives/Button'" },
//       "props": {
//         "variant":  { "figma": "Style", "type": "enum", "values": { "Primary": "primary" } },
//         "loading":  { "figma": "State", "type": "enum", "values": { "Loading": true } },
//         "icon":     { "figma": "Icon", "type": "instance", "as": "component", "when": "Show icon" },
//         "children": { "figma": "Label", "type": "text" },
//         "testId":   { "type": "static", "value": "start-culling" }
//       },
//       "example": "<Button{{props}}>{{children}}</Button>"   // optional template
//     }]
//   }
//
// Prop types mirror Code Connect's helpers: enum (figma.enum), boolean
// (figma.boolean), text (figma.string), instance (figma.instance), static.
// `when` gates a prop on a Figma boolean ("Show icon"). Figma property names
// are matched without their `#12:34` suffix.
//
// Pure functions + fs only. No Figma connection needed: the Figma side comes
// in as a plain "node info" object — from the plugin, from run_script, or
// from a test fixture.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { readComponentProps, acceptsProp, literalsOf, listExports } from "./ts-props.js";

export const CONNECT_FILE = "figbridge.connect.json";
const PROP_TYPES = new Set(["enum", "boolean", "text", "instance", "static"]);

/** "Label#59:128" → "Label" */
export function bareName(name) {
  return String(name || "").replace(/#[^#]*$/, "").trim();
}

function norm(s) {
  return String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
}

// ── Connect file I/O ────────────────────────────────────────────────────────

export function emptyConnect(fileKey) {
  return { version: 1, fileKey: fileKey || null, components: [] };
}

export function readConnect(file) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (!data || typeof data !== "object" || !Array.isArray(data.components)) {
    throw new Error(`${file}: not a figbridge connect file (needs a "components" array)`);
  }
  return data;
}

export function writeConnect(file, data) {
  const out = {
    version: data.version || 1,
    fileKey: data.fileKey || null,
    ...(data.imports ? { imports: data.imports } : {}),
    components: data.components.slice().sort((a, b) =>
      String(a.figma && a.figma.name).localeCompare(String(b.figma && b.figma.name)) ||
      String(a.figma && a.figma.nodeId).localeCompare(String(b.figma && b.figma.nodeId))),
  };
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  return out;
}

/** Insert or replace entries, keyed by Figma node id (then by name). */
export function upsertEntries(connect, entries) {
  const added = [], updated = [];
  for (const e of entries) {
    const i = connect.components.findIndex((c) => e.figma.nodeId
      ? c.figma.nodeId === e.figma.nodeId
      : norm(c.figma.name) === norm(e.figma.name));
    if (i >= 0) { connect.components[i] = e; updated.push(e.figma.name); }
    else { connect.components.push(e); added.push(e.figma.name); }
  }
  return { added, updated };
}

// Remember which connect file belongs to which Figma file, so the plugin UI
// (which only knows the file key) finds the map without a path.
const REGISTRY = () => path.join(process.env.FIGBRIDGE_HOME || path.join(os.homedir(), ".figbridge"), "connect-files.json");

export function rememberConnectFile(fileKey, file) {
  if (!fileKey || !file) return;
  const reg = REGISTRY();
  let map = {};
  try { map = JSON.parse(readFileSync(reg, "utf8")); } catch {}
  if (map[fileKey] === path.resolve(file)) return;
  map[fileKey] = path.resolve(file);
  try { mkdirSync(path.dirname(reg), { recursive: true }); writeFileSync(reg, JSON.stringify(map, null, 2) + "\n"); } catch {}
}

/**
 * Locate the connect file: explicit path → FIGBRIDGE_CONNECT → the file
 * remembered for this Figma file key → figbridge.connect.json in cwd or above.
 */
export function findConnectFile({ connectFile, fileKey, cwd } = {}) {
  if (connectFile) return path.resolve(cwd || process.cwd(), connectFile);
  if (process.env.FIGBRIDGE_CONNECT) return path.resolve(process.env.FIGBRIDGE_CONNECT);
  if (fileKey) {
    try {
      const map = JSON.parse(readFileSync(REGISTRY(), "utf8"));
      if (map[fileKey] && existsSync(map[fileKey])) return map[fileKey];
    } catch {}
  }
  let dir = path.resolve(cwd || process.cwd());
  for (;;) {
    const f = path.join(dir, CONNECT_FILE);
    if (existsSync(f)) return f;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

// ── Figma side: node info → entry ───────────────────────────────────────────

/**
 * Plugin-side script (run via run_script) that describes a node for code
 * connect: its main component, component set and current property values.
 * ES2017-safe on purpose — it runs in the Figma sandbox.
 */
export function nodeInfoScript(nodeId) {
  return `
var node = ${nodeId ? `await figma.getNodeByIdAsync(${JSON.stringify(nodeId)})` : "figma.currentPage.selection[0]"};
if (!node) return { ok: false, error: ${JSON.stringify(nodeId ? "node not found: " + nodeId : "nothing selected")} };
var info = { ok: true, nodeId: node.id, type: node.type, name: node.name, fileKey: figma.fileKey || null, properties: {} };
var comp = null, set = null;
if (node.type === "INSTANCE") comp = await node.getMainComponentAsync();
else if (node.type === "COMPONENT") comp = node;
else if (node.type === "COMPONENT_SET") { set = node; comp = node.defaultVariant; }
else return { ok: false, error: "not a component or instance: " + node.type, nodeId: node.id, name: node.name };
if (comp && comp.parent && comp.parent.type === "COMPONENT_SET") set = comp.parent;
if (comp) info.mainComponent = { id: comp.id, name: comp.name, key: comp.key };
if (set) info.componentSet = { id: set.id, name: set.name, key: set.key };
var defs = (set || comp) ? (set || comp).componentPropertyDefinitions : {};
var k;
if (node.type === "INSTANCE") {
  var cp = node.componentProperties || {};
  for (k in cp) info.properties[k] = { type: cp[k].type, value: cp[k].value };
} else {
  for (k in defs) info.properties[k] = { type: defs[k].type, value: defs[k].defaultValue };
  var vp = comp && comp.variantProperties ? comp.variantProperties : {};
  for (k in vp) info.properties[k] = { type: "VARIANT", value: vp[k] };
}
for (k in info.properties) {
  var p = info.properties[k];
  if (p.type === "INSTANCE_SWAP" && p.value) {
    var sw = await figma.getNodeByIdAsync(p.value);
    if (sw) p.name = sw.name;
  }
}
return info;`;
}

/** Find the connect entry for a node info object. */
export function resolveEntry(connect, info) {
  if (!connect || !info) return null;
  const ids = [info.componentSet && info.componentSet.id, info.mainComponent && info.mainComponent.id, info.nodeId].filter(Boolean);
  for (const id of ids) {
    const e = connect.components.find((c) => c.figma && c.figma.nodeId === id);
    if (e) return e;
  }
  for (const id of ids) {
    const e = connect.components.find((c) => Array.isArray(c.figma?.variantNodeIds) && c.figma.variantNodeIds.includes(id));
    if (e) return e;
  }
  const names = [info.componentSet && info.componentSet.name, info.mainComponent && info.mainComponent.name].filter(Boolean);
  for (const n of names) {
    const e = connect.components.find((c) => c.figma && norm(c.figma.name) === norm(n));
    if (e) return e;
  }
  return null;
}

// Figma property values by bare name.
function valuesByName(properties) {
  const out = {};
  for (const [k, v] of Object.entries(properties || {})) out[bareName(k)] = v && typeof v === "object" ? v : { value: v };
  return out;
}

function pascal(s) {
  const last = String(s || "").split(/[\/=,]/).map((x) => x.trim()).filter(Boolean).pop() || "";
  return last.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase()).replace(/[^A-Za-z0-9]/g, "");
}

/**
 * Map Figma property values to React props for one entry.
 * @returns {{ props: Array<[name, value]>, children: string|null, unmapped: string[] }}
 */
export function mapProps(entry, properties) {
  const vals = valuesByName(properties);
  const props = [];
  const imports = [];
  let children = null;
  const used = new Set();
  for (const [prop, spec] of Object.entries(entry.props || {})) {
    if (spec.when) {
      used.add(bareName(spec.when));
      const gate = vals[bareName(spec.when)];
      if (!gate || gate.value !== true) continue;
    }
    let value;
    if (spec.type === "static") value = spec.expr != null ? { $expr: String(spec.expr) } : spec.value;
    else {
      const key = bareName(spec.figma);
      used.add(key);
      const v = vals[key];
      if (!v) continue;
      if (spec.type === "enum") {
        if (spec.values) value = Object.prototype.hasOwnProperty.call(spec.values, v.value) ? spec.values[v.value] : undefined;
        else value = v.value;
      } else if (spec.type === "boolean") {
        if (spec.values) value = spec.values[String(v.value)];
        else value = v.value === true ? true : undefined;
      } else if (spec.type === "text") {
        value = v.value == null ? undefined : String(v.value);
      } else if (spec.type === "instance") {
        const name = spec.names && v.name && spec.names[v.name] !== undefined ? spec.names[v.name] : pascal(v.name || "");
        if (!name) continue;
        value = { [spec.as === "component" ? "$component" : "$element"]: name };
        if (spec.importFrom) imports.push([spec.importFrom, name]);
      }
    }
    if (value === undefined || value === null) continue;
    if (prop === "children") { children = value; continue; }
    // several enum rows may target one prop (e.g. State → loading, State → disabled)
    const at = props.findIndex(([p]) => p === prop);
    if (at >= 0) props[at] = [prop, value]; else props.push([prop, value]);
  }
  const unmapped = Object.keys(vals).filter((k) => !used.has(k));
  const raw = Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.type === "INSTANCE_SWAP" ? v.name : v.value]));
  return { props, children, unmapped, imports, raw };
}

// JSON-friendly form of a mapped value: references and expressions as source text.
function exprOf(v) {
  if (!v || typeof v !== "object") return v;
  if (v.$component) return v.$component;
  if (v.$element) return `<${v.$element} />`;
  if (v.$expr) return v.$expr;
  return v;
}

function attr(name, value) {
  if (value === true) return name;
  if (typeof value === "string") return /["\n{}]/.test(value) ? `${name}={${JSON.stringify(value)}}` : `${name}="${value}"`;
  if (value && typeof value === "object" && value.$component) return `${name}={${value.$component}}`;
  if (value && typeof value === "object" && value.$element) return `${name}={<${value.$element} />}`;
  if (value && typeof value === "object" && value.$expr) return `${name}={${value.$expr}}`;
  return `${name}={${JSON.stringify(value)}}`;
}

function childText(c) {
  if (c && typeof c === "object" && c.$element) return `<${c.$element} />`;
  if (c && typeof c === "object" && c.$component) return `<${c.$component} />`;
  if (c && typeof c === "object" && c.$expr) return `{${c.$expr}}`;
  const s = String(c);
  return /[{}<>]/.test(s) ? `{${JSON.stringify(s)}}` : s;
}

/** Default import statement for an entry. */
export function importFor(entry, connect) {
  if (entry.code.import) return entry.code.import;
  let spec = entry.code.source.replace(/\\/g, "/").replace(/\.(tsx?|jsx?|mjs)$/, "").replace(/\/index$/, "");
  const rewrites = (connect && connect.imports) || {};
  let rewritten = false;
  for (const [from, to] of Object.entries(rewrites)) {
    if (spec.startsWith(from)) { spec = to + spec.slice(from.length); rewritten = true; break; }
  }
  if (!rewritten && !spec.startsWith(".")) spec = "./" + spec;
  return entry.code.export === "default"
    ? `import ${pascal(path.basename(spec))} from '${spec}'`
    : `import { ${entry.code.export} } from '${spec}'`;
}

/** JSX (plus import) for a mapped entry. */
export function renderSnippet(entry, mapped, connect) {
  const tag = entry.code.export === "default" ? pascal(path.basename(entry.code.source).replace(/\.[^.]+$/, "")) : entry.code.export;
  const attrs = mapped.props.map(([n, v]) => attr(n, v));
  let jsx;
  if (entry.example) {
    const byName = Object.fromEntries(mapped.props.map(([n, v]) => [n, attr(n, v)]));
    jsx = entry.example
      .replace(/\{\{props\}\}/g, attrs.length ? " " + attrs.join(" ") : "")
      .replace(/\{\{children\}\}/g, mapped.children != null ? childText(mapped.children) : "")
      .replace(/\{\{figma\.([^}]+)\}\}/g, (_, n) => {
        const v = (mapped.raw || {})[bareName(n)];
        return v == null ? "" : String(v).replace(/'/g, "\\'");
      })
      .replace(/\{\{([A-Za-z_$][\w$-]*)\}\}/g, (_, n) => byName[n] || "");
  } else {
    const oneLine = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}`;
    const multi = oneLine.length > 80 && attrs.length > 1;
    const open = multi ? `<${tag}\n${attrs.map((a) => "  " + a).join("\n")}\n` : oneLine;
    jsx = mapped.children != null
      ? (multi ? `${open}>\n  ${childText(mapped.children)}\n</${tag}>` : `${open}>${childText(mapped.children)}</${tag}>`)
      : `${open}${multi ? "" : " "}/>`;
  }
  const extra = {};
  for (const [mod, name] of mapped.imports || []) (extra[mod] = extra[mod] || new Set()).add(name);
  const lines = [importFor(entry, connect)].concat(
    Object.entries(extra).map(([mod, names]) => `import { ${[...names].sort().join(", ")} } from '${mod}'`));
  return `${lines.join("\n")}\n\n${jsx}`;
}

/**
 * The Code Connect answer for one node: which component, which props, and a
 * ready-to-paste snippet.
 */
export function getCodeConnect(connect, info) {
  const entry = resolveEntry(connect, info);
  const figmaName = (info.componentSet && info.componentSet.name) || (info.mainComponent && info.mainComponent.name) || info.name;
  if (!entry) {
    return { ok: false, mapped: false, nodeId: info.nodeId, figmaComponent: figmaName || null, error: `no connect entry for "${figmaName}". Add one with connect_components.` };
  }
  const mapped = mapProps(entry, info.properties);
  return {
    ok: true,
    mapped: true,
    nodeId: info.nodeId,
    figma: { name: entry.figma.name, nodeId: entry.figma.nodeId },
    code: { source: entry.code.source, export: entry.code.export, import: importFor(entry, connect) },
    props: Object.fromEntries(mapped.props.map(([n, v]) => [n, exprOf(v)])),
    ...(mapped.children != null ? { children: exprOf(mapped.children) } : {}),
    unmappedFigmaProps: mapped.unmapped,
    snippet: renderSnippet(entry, mapped, connect),
  };
}

// ── Lint ────────────────────────────────────────────────────────────────────

/**
 * Verify every entry still points at real code and real Figma properties.
 * Errors: missing source file / export / prop, a mapped enum value that is no
 * longer in the prop's literal union, a mapped Figma property or variant
 * value missing from the entry's Figma snapshot. Warnings: props the parser
 * could not resolve, Figma properties nobody mapped.
 */
export function lintConnect(connect, { root }) {
  const errors = [], warnings = [];
  const err = (e, code, message) => errors.push({ figma: e.figma && e.figma.name, nodeId: e.figma && e.figma.nodeId, code, message });
  const warn = (e, code, message) => warnings.push({ figma: e.figma && e.figma.name, nodeId: e.figma && e.figma.nodeId, code, message });
  const seen = new Map();
  for (const e of connect.components) {
    if (!e.figma || !e.figma.name || !e.figma.nodeId) { err(e || {}, "figma-missing", "entry needs figma.name and figma.nodeId"); continue; }
    if (!/^\d+:\d+$/.test(e.figma.nodeId)) err(e, "figma-node-id", `figma.nodeId "${e.figma.nodeId}" is not a node id like 59:944`);
    const dupKey = e.figma.nodeId;
    if (seen.has(dupKey)) err(e, "duplicate", `node ${dupKey} is mapped twice`);
    seen.set(dupKey, true);
    for (const variantId of e.figma.variantNodeIds || []) {
      if (typeof variantId !== "string" || !/^\d+:\d+$/.test(variantId)) err(e, "figma-node-id", `variant node id ${JSON.stringify(variantId)} is invalid`);
      else if (seen.has(variantId)) err(e, "duplicate", `node ${variantId} is mapped twice`);
      else seen.set(variantId, true);
    }
    if (!e.code || !e.code.source || !e.code.export) { err(e, "code-missing", "entry needs code.source and code.export"); continue; }
    const file = path.resolve(root, e.code.source);
    if (!existsSync(file)) { err(e, "source-missing", `source file not found: ${e.code.source}`); continue; }
    let info;
    try { info = readComponentProps(file, e.code.export); }
    catch (x) { err(e, "source-unreadable", `${e.code.source}: ${x.message}`); continue; }
    if (!info.exported) { err(e, "export-missing", `${e.code.source} has no export "${e.code.export}" (exports: ${listExports(readFileSync(file, "utf8")).join(", ") || "none"})`); continue; }
    if (e.code.import && e.code.export !== "default" && !new RegExp(`\\b${e.code.export}\\b`).test(e.code.import)) {
      err(e, "import-mismatch", `import "${e.code.import}" does not import ${e.code.export}`);
    }
    const propsKnown = info.found && info.unresolved.length === 0;
    if (!info.found) warn(e, "props-unparsed", `could not read the props type of ${e.code.export}; props unchecked`);
    else if (info.unresolved.length) warn(e, "props-partial", `props type of ${e.code.export} uses ${info.unresolved.join(", ")} which could not be resolved; missing props are warnings`);

    const snap = e.figma.properties || null;
    const snapByName = snap ? Object.fromEntries(Object.entries(snap).map(([k, v]) => [bareName(k), v])) : null;
    const mappedFigma = new Set();
    for (const [prop, spec] of Object.entries(e.props || {})) {
      if (!spec || !PROP_TYPES.has(spec.type)) { err(e, "prop-type", `${prop}: type must be one of ${[...PROP_TYPES].join(", ")}`); continue; }
      if (spec.type !== "static" && !spec.figma) { err(e, "prop-figma", `${prop}: needs a "figma" property name`); continue; }
      // code side
      if (info.found) {
        if (!acceptsProp(info, prop) && !(prop === "children" && info.inheritsDom && !info.omitted.has("children"))) {
          (propsKnown ? err : warn)(e, "prop-missing", `${e.code.export} has no prop "${prop}"`);
        } else if (info.members[prop]) {
          const lits = literalsOf(info.members[prop].type, info.ctx);
          const out = [];
          if (spec.type === "static" && spec.expr == null) out.push(spec.value);
          else if (spec.values) out.push(...Object.values(spec.values));
          if (lits) {
            for (const v of out) {
              if (v === null) continue;
              if (typeof v !== "string" || !lits.includes(v)) err(e, "value-invalid", `${prop}=${JSON.stringify(v)} is not one of ${lits.map((x) => `'${x}'`).join(" | ")}`);
            }
          } else {
            const t = info.members[prop].type.replace(/\s+/g, "");
            const prim = t === "boolean" ? "boolean" : t === "string" ? "string" : t === "number" ? "number" : null;
            if (prim) for (const v of out) if (v !== null && typeof v !== prim) err(e, "value-invalid", `${prop} is ${prim} but is mapped to ${JSON.stringify(v)}`);
          }
        }
      }
      // figma side (against the snapshot taken when the entry was seeded)
      for (const fname of [spec.figma, spec.when].filter(Boolean)) {
        const key = bareName(fname);
        mappedFigma.add(key);
        if (snapByName && !snapByName[key]) err(e, "figma-prop-missing", `${prop}: Figma property "${key}" is not on ${e.figma.name} (has: ${Object.keys(snapByName).join(", ")})`);
      }
      if (snapByName && spec.type === "enum" && spec.values && snapByName[bareName(spec.figma)]) {
        const opts = snapByName[bareName(spec.figma)].options || [];
        for (const k of Object.keys(spec.values)) if (opts.length && !opts.includes(k)) err(e, "figma-value-missing", `${prop}: "${bareName(spec.figma)}=${k}" is not a Figma option (${opts.join(", ")})`);
      }
    }
    // `{{figma.X}}` in an example template reads a Figma property too.
    for (const m of String(e.example || "").matchAll(/\{\{figma\.([^}]+)\}\}/g)) {
      const key = bareName(m[1]);
      mappedFigma.add(key);
      if (snapByName && !snapByName[key]) err(e, "figma-prop-missing", `example: Figma property "${key}" is not on ${e.figma.name}`);
    }
    if (snapByName) {
      const loose =Object.keys(snapByName).filter((k) => !mappedFigma.has(k));
      if (loose.length) warn(e, "figma-unmapped", `Figma properties not mapped to props: ${loose.join(", ")}`);
    }
  }
  return { ok: errors.length === 0, checked: connect.components.length, errors, warnings };
}

// ── Suggest ─────────────────────────────────────────────────────────────────

const CODE_RE = /\bCode:\s*`?([\w./@-]+\.(?:tsx|jsx|ts|js|vue|svelte))/i;
const TESTID_RE = /\bTest id:\s*`?([\w{}.-]+)/i;
const STATE_SYNONYMS = {
  on: ["checked", "active", "pressed", "on", "selected"],
  active: ["active", "selected", "pressed", "checked"],
  selected: ["selected", "active", "checked"],
  expanded: ["defaultOpen", "open", "expanded"],
  open: ["open", "defaultOpen", "expanded"],
  disabled: ["disabled"],
  loading: ["loading", "busy"],
  error: ["error", "invalid"],
  filled: ["filled"],
  checked: ["checked"],
  mixed: [],
};
const TEXT_SYNONYMS = {
  label: ["label", "children", "text", "title"],
  hint: ["hint", "text", "summary", "description"],
  message: ["message", "children", "text"],
  key: ["shortcut", "children", "keys"],
  value: ["value", "defaultValue", "children"],
  body: ["message", "body", "children"],
  helper: ["helper", "description", "hint"],
};

function snapshotProps(defs) {
  const out = {};
  for (const [k, d] of Object.entries(defs || {})) {
    const name = bareName(k);
    out[name] = d.variantOptions ? { type: d.type, options: d.variantOptions } : { type: d.type };
  }
  return out;
}

function pickExport(exportsList, figmaName) {
  const want = norm(figmaName);
  if (!exportsList.length) return null;
  return exportsList.find((x) => norm(x) === want) ||
    exportsList.find((x) => norm(x).includes(want) || want.includes(norm(x))) ||
    exportsList[0];
}

/**
 * Suggest a connect entry for one Figma component.
 * `component` = { nodeId, name, description?, properties?: componentPropertyDefinitions }
 * `ctx` = { root, index (from buildSourceIndex, optional), fileKey, connect }
 * Returns { entry, confidence: 'high'|'medium'|'low', notes[] } or null.
 */
export function suggestEntry(component, ctx) {
  const notes = [];
  let source = null, via = null;
  const desc = component.description || "";
  const cm = CODE_RE.exec(desc);
  if (cm && existsSync(path.resolve(ctx.root, cm[1]))) { source = cm[1]; via = "description"; }
  else if (cm) notes.push(`description names ${cm[1]}, which is not under ${ctx.root}`);
  if (!source && ctx.index) {
    const tm = TESTID_RE.exec(desc);
    const tid = tm && tm[1].replace(/\{[^}]*\}-?/g, "").replace(/-$/, "");
    const hit = tid && ctx.index.byTestid[tid];
    if (hit) { source = path.relative(ctx.root, path.resolve(ctx.index.sourceDir, hit.file)); via = "data-testid"; }
    const byName = !source && ctx.index.byComponent[norm(component.name)];
    if (byName) { source = path.relative(ctx.root, path.resolve(ctx.index.sourceDir, byName.file)); via = "component-name"; }
  }
  if (!source) return null;
  source = source.replace(/\\/g, "/");
  const file = path.resolve(ctx.root, source);
  const exportsList = listExports(readFileSync(file, "utf8"));
  const exp = pickExport(exportsList, component.name);
  if (!exp) { notes.push(`${source} has no PascalCase export`); return { entry: null, confidence: "low", notes }; }
  if (norm(exp) !== norm(component.name)) notes.push(`export ${exp} chosen for "${component.name}" (exports: ${exportsList.join(", ")})`);

  const info = readComponentProps(file, exp);
  const members = info.members;
  const has = (p) => acceptsProp(info, p) || (p === "children" && info.inheritsDom && !info.omitted.has("children"));
  const props = {};
  const defs = component.properties || {};
  const byBare = Object.fromEntries(Object.entries(defs).map(([k, d]) => [bareName(k), d]));
  const gates = Object.keys(byBare).filter((k) => byBare[k].type === "BOOLEAN" && /^show\s+/i.test(k));

  for (const [name, d] of Object.entries(byBare)) {
    if (d.type === "VARIANT") {
      const opts = d.variantOptions || [];
      // 1) a prop whose literal union covers the options
      let best = null;
      for (const [p, m] of Object.entries(members)) {
        const lits = literalsOf(m.type, info.ctx);
        if (!lits) continue;
        const values = {};
        for (const o of opts) { const hit = lits.find((l) => norm(l) === norm(o)); if (hit !== undefined) values[o] = hit; }
        const score = Object.keys(values).length + (norm(p) === norm(name) ? 0.5 : 0);
        if (Object.keys(values).length && (!best || score > best.score)) best = { p, values, score };
      }
      if (best && !props[best.p]) { props[best.p] = { figma: name, type: "enum", values: best.values }; continue; }
      // 2) interaction states that are booleans in code (Disabled → disabled)
      let any = false;
      // Own props first (only boolean ones), then inherited DOM props.
      const boolish = (c) => /^boolean$/.test(members[c].type.replace(/\s+/g, ""));
      for (const o of opts) {
        const cands = STATE_SYNONYMS[norm(o)] || [];
        const p = cands.find((c) => members[c] && boolish(c)) || cands.find((c) => !members[c] && has(c));
        if (p && !props[p]) {
          const values = { [o]: true };
          // two-state variants (Off/On) map both ways for a required boolean
          if (opts.length === 2 && members[p] && !members[p].optional) values[opts.find((x) => x !== o)] = false;
          props[p] = { figma: name, type: "enum", values };
          any = true;
        }
      }
      if (!any) notes.push(`variant "${name}" (${opts.join(", ")}) has no matching prop — interaction states are usually CSS`);
    } else if (d.type === "TEXT") {
      const cands = [name.charAt(0).toLowerCase() + name.slice(1).replace(/\s+(\w)/g, (_, c) => c.toUpperCase())].concat(TEXT_SYNONYMS[norm(name)] || []);
      const p = cands.find((c) => has(c) && !props[c]);
      const gate = gates.find((g) => norm(g.replace(/^show\s+/i, "")) === norm(name));
      if (p) props[p] = { figma: name, type: "text", ...(gate ? { when: gate } : {}) };
      else notes.push(`text "${name}" has no matching prop`);
    } else if (d.type === "INSTANCE_SWAP") {
      const p = ["icon", norm(name)].find((c) => has(c) && !props[c]);
      const gate = gates.find((g) => norm(g.replace(/^show\s+/i, "")) === norm(name));
      if (p) {
        const t = members[p] ? members[p].type : "";
        props[p] = { figma: name, type: "instance", as: /LucideIcon|ComponentType|ElementType|FC\b/.test(t) ? "component" : "element", ...(gate ? { when: gate } : {}) };
        if (/LucideIcon/.test(t) || /from\s+['"]lucide-react['"]/.test(readFileSync(file, "utf8"))) props[p].importFrom = "lucide-react";
      } else notes.push(`instance "${name}" has no matching prop`);
    } else if (d.type === "BOOLEAN") {
      if (gates.includes(name)) continue;
      const p = [name.charAt(0).toLowerCase() + name.slice(1).replace(/\s+(\w)/g, (_, c) => c.toUpperCase()), norm(name)].find((c) => has(c) && !props[c]);
      if (p) props[p] = { figma: name, type: "boolean" };
      else notes.push(`boolean "${name}" has no matching prop`);
    }
  }
  const entry = {
    figma: { fileKey: component.fileKey || ctx.fileKey || null, nodeId: component.nodeId, name: component.name, ...(component.properties ? { properties: snapshotProps(defs) } : {}) },
    code: { source, export: exp },
    props,
  };
  entry.code.import = importFor(entry, ctx.connect);
  const confidence = via === "description" && norm(exp) === norm(component.name) ? "high" : via === "description" ? "medium" : "low";
  return { entry, confidence, via, notes };
}
