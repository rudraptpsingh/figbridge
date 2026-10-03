// source-index.js — make figbridge codebase-aware.
//
// Scans the app's source directory once and builds the maps that let a
// mockup-vs-app diff "provide code accordingly": which file backs each piece
// of UI, and which design token a literal value should become.
//
//   byTestid     data-testid / data-component  → { file, line }   (strongest signal)
//   byComponent  normalized component name      → { file }         (filename-derived)
//   tokens       { valToName, nameToVal }        for color/spacing → var(--token)
//
// Pure Node (fs only); no browser. The resolvers are plain functions so the
// caller (match_mockup) can annotate each punch-list delta.

import { readdir, readFile, stat } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

const CODE_EXT = new Set([".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".mjs"]);
const SCAN_EXT = new Set([...CODE_EXT, ".css", ".scss"]); // css scanned for tokens only
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "__snapshots__", ".cache", "vendor", "test-results", "e2e", "test", "tests", "__tests__", "captures"]);
const MAX_FILES = 4000;
const MAX_BYTES = 400_000; // skip giant generated files

function normName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function lineOf(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function arrayLiteralAt(text, open) {
  if (text[open] !== "[") return null;
  let depth = 0, quote = null, escaped = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") { quote = c; continue; }
    if (c === "[") depth++;
    if (c === "]" && --depth === 0) return text.slice(open, i + 1);
  }
  return null;
}

async function walk(dir, files, depth) {
  if (files.length >= MAX_FILES || depth > 12) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (files.length >= MAX_FILES) return;
    if (e.name.startsWith(".") && e.name !== ".") continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      await walk(full, files, depth + 1);
    } else if (SCAN_EXT.has(path.extname(e.name)) || /^(?:v2Tokens|design-tokens|tokens)\.json$/i.test(e.name)) {
      files.push(full);
    }
  }
}

/**
 * Build the source index for a repo / app directory.
 * @param {string} sourceDir absolute path to the app source root
 * @returns {Promise<{ ok, sourceDir, fileCount, byTestid, byComponent, tokens, cssFiles }>}
 */
export async function buildSourceIndex(sourceDir) {
  const out = {
    ok: true, sourceDir, fileCount: 0,
    byTestid: {}, byTestidVariants: {}, byTestidPatterns: [], byComponent: {}, byConnectedComponent: {}, byConnectedNodeId: {},
    tokens: { valToName: {}, nameToVal: {}, nameToSource: {}, valToNames: {} }, cssFiles: [], tokenDrift: [],
  };
  const files = [];
  const figmaDimensions = {};
  const generatedTokens = new Set();
  await walk(sourceDir, files, 0);
  out.fileCount = files.length;

  const TESTID_RE = /\b(?:data-(?:testid|test-id|component)|testId)\s*=\s*[{]?\s*["'`]([^"'`]+)["'`]/g;
  const TESTID_TEMPLATE_RE = /\b(?:data-testid|testId)\s*=\s*\{[^\n`]{0,120}`([^`]+)`/g;
  const TESTID_CONDITIONAL_RE = /\bdata-testid\s*=\s*\{\s*[a-zA-Z_$][\w.$]*\s*\?\s*(['"])([^'"`]+)\1\s*:\s*(['"])([^'"`]+)\3\s*\}/g;
  const TESTID_PREFIX_RE = /\btestIdPrefix\s*=\s*['"]([^'"]+)['"]/g;
  const CSSVAR_RE = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;

  for (const file of files) {
    // Assertions and captures repeat production testids; indexing them can
    // make an exact app anchor resolve to an E2E selector instead of its JSX.
    if (/\.(?:test|spec|stories)\.[cm]?[jt]sx?$/.test(file)) continue;
    let text;
    try {
      const s = await stat(file);
      if (s.size > MAX_BYTES) continue;
      text = await readFile(file, "utf8");
    } catch { continue; }
    const rel = path.relative(sourceDir, file);

    // component name from filename (code files only; skip index/test/css)
    const base = path.basename(file).replace(/\.[^.]+$/, "");
    if (CODE_EXT.has(path.extname(file)) && !/\.(test|spec|stories)$/.test(base) && base !== "index") {
      const key = normName(base);
      if (key && !out.byComponent[key]) out.byComponent[key] = { file: rel, name: base };
    }

    // data-testid occurrences (first wins — usually the root)
    let m;
    while ((m = TESTID_RE.exec(text))) {
      const id = m[1];
      const candidate = { file: rel, line: lineOf(text, m.index), states: [] };
      const tagStart = text.lastIndexOf("<", m.index);
      const tagEnd = text.indexOf(">", m.index);
      if (tagStart >= 0 && tagEnd >= 0 && tagEnd - tagStart < 1000) {
        const tag = text.slice(tagStart, tagEnd + 1);
        const state = /\bdata-state\s*=\s*(?:"([^"]+)"|'([^']+)'|\{([^}]+)\})/.exec(tag);
        if (state) candidate.states = state[1] || state[2]
          ? [state[1] || state[2]]
          : [...state[3].matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
      }
      (out.byTestidVariants[id] ||= []).push(candidate);
      if (!out.byTestid[id]) out.byTestid[id] = { file: rel, line: candidate.line };
    }
    // Literal arms of a simple JSX ternary are exact production IDs. Treat
    // them as exact owners; a broad `${testId}-toggle` template must not win.
    while ((m = TESTID_CONDITIONAL_RE.exec(text))) {
      for (const id of [m[2], m[4]]) {
        const candidate = { file: rel, line: lineOf(text, m.index), states: [] };
        (out.byTestidVariants[id] ||= []).push(candidate);
        if (!out.byTestid[id]) out.byTestid[id] = { file: rel, line: candidate.line };
      }
    }
    // A segmented caller owns ids assembled from its literal prefix and the
    // option keys declared immediately above it. Resolve only those keys;
    // an arbitrary suffix would be a guess about a control that may not exist.
    while ((m = TESTID_PREFIX_RE.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 3000), m.index);
      const optionsAt = before.lastIndexOf("const options");
      if (optionsAt < 0) continue;
      const optionSource = before.slice(optionsAt);
      const declaration = /\boptions\b[^=]{0,180}=\s*\[/.exec(optionSource);
      if (!declaration) continue;
      const open = optionsAt + declaration.index + declaration[0].length - 1;
      const literal = arrayLiteralAt(before, open);
      if (!literal) continue;
      const keys = [...literal.matchAll(/\bkey\s*:\s*['"]([^'"]+)['"]/g)].map(x => x[1]);
      for (const key of new Set(keys)) {
        const id = `${m[1]}-${key}`;
        const candidate = { file: rel, line: lineOf(text, m.index), states: [] };
        (out.byTestidVariants[id] ||= []).push(candidate);
        if (!out.byTestid[id]) out.byTestid[id] = { file: rel, line: candidate.line };
      }
    }
    // A rendered row id often comes from a JSX template such as
    // `filter-${name}-count`. Index its fixed parts rather than treating the
    // source template itself as a literal id or guessing from a test file.
    while ((m = TESTID_TEMPLATE_RE.exec(text))) {
      const parts = m[1].split(/\$\{[^}]+\}/);
      if (parts.length < 2) continue;
      const staticChars = parts.join("").length;
      if (staticChars < 4) continue;
      const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp("^" + parts.map(escape).join(".+?") + "$");
      out.byTestidPatterns.push({ file: rel, line: lineOf(text, m.index),
        template: m[1], staticChars, re });
    }

    // css custom properties from :root (or any block) — token maps
    if (path.extname(file) === ".css" || /:root/.test(text)) {
      let cm;
      const seen = path.extname(file) === ".css";
      if (seen) out.cssFiles.push(rel);
      while ((cm = CSSVAR_RE.exec(text))) {
        const name = "--" + cm[1];
        const val = cm[2].trim().toLowerCase();
        if (!out.tokens.nameToVal[name]) out.tokens.nameToVal[name] = val;
        out.tokens.nameToSource[name] ||= rel;
        const names = (out.tokens.valToNames[val] ||= []);
        if (!names.includes(name)) names.push(name);
        // reverse map for resolvable literals (hex / rgb / px)
        if (/^#|^rgb|^\d/.test(val) && !out.tokens.valToName[val]) out.tokens.valToName[val] = name;
      }
    }
    // A checked-in generated token file is the Figma-derived source of truth
    // in projects such as ShotSelect. CSS aliases alone omit its dimensions.
    if (path.extname(file) === ".json") {
      let json;
      try { json = JSON.parse(text); } catch { continue; }
      if (json?.variables && typeof json.variables === "object") {
        for (const [name, spec] of Object.entries(json.variables)) {
          if (spec?.type !== "float" || typeof spec.value !== "number") continue;
          const token = "--v2-" + name.replace(/^desktop\//, "").replaceAll("/", "-").toLowerCase();
          figmaDimensions[token] = { value: `${spec.value}px`, source: rel };
        }
      }
      if (json && json.css && typeof json.css === "object") {
        for (const [name, raw] of Object.entries(json.css)) {
          if (!name.startsWith("--") || typeof raw !== "string") continue;
          const val = raw.trim().toLowerCase();
          out.tokens.nameToVal[name] = val;
          out.tokens.nameToSource[name] = rel;
          generatedTokens.add(name);
          if (!out.tokens.valToName[val]) out.tokens.valToName[val] = name;
          const names = (out.tokens.valToNames[val] ||= []);
          if (!names.includes(name)) names.push(name);
        }
      }
    }
  }
  for (const [token, figma] of Object.entries(figmaDimensions)) {
    if (!generatedTokens.has(token)) continue; // some Figma variables are intentionally unused
    const code = out.tokens.nameToVal[token];
    if (code !== figma.value) out.tokenDrift.push({ token, figma: figma.value, code,
      figmaSource: figma.source, codeSource: out.tokens.nameToSource[token] });
  }
  // Reuse explicit Code Connect mappings before filename guesses. This is
  // especially useful when the Figma component and TSX export have different
  // names (or the app has several similarly named files).
  try {
    const connect = JSON.parse(await readFile(path.join(sourceDir, "figbridge.connect.json"), "utf8"));
    for (const entry of connect.components || []) {
      const name = normName(entry.figma?.name);
      const file = entry.code?.source;
      if (name && typeof file === "string" && !out.byConnectedComponent[name]) {
        out.byConnectedComponent[name] = { file, name: entry.figma.name };
      }
      const nodeIds = [entry.figma?.nodeId, ...(Array.isArray(entry.figma?.variantNodeIds) ? entry.figma.variantNodeIds : [])];
      for (const nodeId of nodeIds) {
        if (typeof nodeId === "string" && typeof file === "string" && !out.byConnectedNodeId[nodeId]) {
          out.byConnectedNodeId[nodeId] = { file, name: entry.figma.name, nodeId };
        }
      }
    }
  } catch { /* Code Connect is optional. */ }
  return out;
}

/**
 * Resolve one diff delta to a source file. Prefers the app-side data-testid;
 * falls back to a conservative component-name match on the node label.
 * @returns {{ file, line?, via } | null}
 */
export function resolveSource(delta, index) {
  if (!index) return null;
  const tid = delta && delta.testid;
  if (tid && index.byTestid[tid]) {
    const variants = index.byTestidVariants?.[tid] || [];
    if (variants.length <= 1) return { ...index.byTestid[tid], via: "data-testid" };
    const matches = delta.state ? variants.filter((v) => v.states.includes(delta.state)) : [];
    if (matches.length === 1) return { file: matches[0].file, line: matches[0].line, via: "data-testid+state" };
    const files = [...new Set(variants.map((v) => v.file))];
    if (files.length === 1) return { file: files[0], via: "data-testid-ambiguous" };
    return null;
  }
  if (tid) {
    const patterns = matchingTestidPatterns(tid, index);
    if (patterns.length) {
      const files = [...new Set(patterns.map(p => p.file))];
      if (files.length === 1) return { file: files[0],
        line: patterns.length === 1 ? patterns[0].line : undefined,
        via: "data-testid-template" };
    }
  }
  const connected = index.byConnectedNodeId?.[delta?.figmaComponentId] || index.byConnectedNodeId?.[delta?.figmaNodeId];
  if (connected) return { file: connected.file, via: "figbridge.connect.json#nodeId" };
  // conservative name fallback: node label like ".conflict-card" → ConflictResolutionCard
  const label = normName((delta && delta.name) || "");
  if (label.length >= 5) {
    if (index.byConnectedComponent?.[label]) return { ...index.byConnectedComponent[label], via: "figbridge.connect.json" };
    if (index.byComponent[label]) return { ...index.byComponent[label], via: "component-name" };
    for (const key of Object.keys(index.byComponent)) {
      if ((key.includes(label) || label.includes(key)) && Math.min(key.length, label.length) >= 6) {
        return { ...index.byComponent[key], via: "component-name~" };
      }
    }
  }
  return null;
}

function matchingTestidPatterns(tid, index) {
  const matches = (index.byTestidPatterns || []).filter(p => p.re.test(tid));
  if (!matches.length) return [];
  const longest = Math.max(...matches.map(p => p.staticChars));
  return matches.filter(p => p.staticChars === longest);
}

/**
 * For a color/spacing delta, suggest the design token the mockup value maps to,
 * so the fix is a token edit rather than a hardcoded literal.
 * @returns {{ token, value } | null}
 */
export function tokenHint(delta, index) {
  if (!index || !delta) return null;
  if (delta.kind !== "color" && delta.kind !== "elevation" && delta.kind !== "spacing") return null;
  if (typeof delta.a === "number" && !["width", "height", "spacing", "cornerRadius"].includes(delta.field)) return null;
  const want = typeof delta.a === "number" ? `${delta.a}px` : typeof delta.a === "string" ? delta.a.trim().toLowerCase() : null;
  if (want && index.tokens.valToName[want]) {
    const token = index.tokens.valToName[want];
    return { token, value: want, source: index.tokens.nameToSource[token] || null,
      candidates: index.tokens.valToNames[want] || [token] };
  }
  return null;
}

/** Find a uniquely matching authored dimension literal. Computed dimensions
 * can come from flex/grid/parents, so absence of evidence is a valid result. */
export function sourceEvidence(delta, index, sourceFile, anchorLine = null) {
  if (!index || !sourceFile || !["width", "height"].includes(delta.field) || typeof delta.a !== "number" || typeof delta.b !== "number") return null;
  const root = path.resolve(index.sourceDir);
  const absolute = path.resolve(root, sourceFile);
  if (!absolute.startsWith(root + path.sep)) return null;
  let text;
  try { text = readFileSync(absolute, "utf8"); } catch { return null; }
  const prefix = delta.field === "width" ? "w" : "h";
  const expected = `${delta.b}px`;
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\b${prefix}-\\[${escaped}\\]`, "g"),
    new RegExp(`\\b${delta.field}\\s*:\\s*${escaped}\\b`, "g"),
  ];
  const hits = patterns.flatMap((re) => [...text.matchAll(re)].map((m) => ({ current: m[0], offset: m.index })));
  if (hits.length !== 1) return null;
  const hit = hits[0];
  const hitLine = lineOf(text, hit.offset);
  if (Number.isInteger(anchorLine) && Math.abs(hitLine - anchorLine) > 8) return null;
  const hint = tokenHint(delta, index);
  const uniqueToken = hint && hint.candidates.length === 1 && hint.token.includes(delta.field) ? hint.token : null;
  const replacement = uniqueToken ? `var(${uniqueToken})` : `${delta.a}px`;
  const suggested = hit.current.replace(expected, replacement);
  return { line: hitLine, current: hit.current, suggested,
    token: uniqueToken, tokenSource: uniqueToken ? hint.source : null,
    confidence: "unique-authored-literal" };
}

/** Show the authored JSX class near a resolved data-testid. This is useful
 * when computed geometry comes from a calc/flex rule and no literal edit can
 * be proposed safely. */
export function authoredStyle(index, sourceFile, anchorLine) {
  if (!index || !sourceFile || !Number.isInteger(anchorLine)) return null;
  const root = path.resolve(index.sourceDir);
  const absolute = path.resolve(root, sourceFile);
  if (!absolute.startsWith(root + path.sep)) return null;
  let lines;
  try { lines = readFileSync(absolute, "utf8").split(/\r?\n/); } catch { return null; }
  const start = Math.max(0, anchorLine - 1);
  const near = lines.slice(start, start + 8).join("\n");
  const match = /\bclassName\s*=\s*["']([^"']+)["']/.exec(near);
  if (!match) return null;
  return { line: start + 1 + near.slice(0, match.index).split("\n").length - 1,
    className: match[1] };
}

/** Attach only evidence grounded in the indexed code and design tokens. */
export function annotateDeltas(deltas, index, componentMap = null) {
  return deltas.map((d) => {
    const out = { ...d };
    const hit = componentMap && (componentMap[d.name] || componentMap[(d.name || "").replace(/^[.#]/, "")]);
    if (hit?.file) { out.sourceFile = hit.file; out.via = "componentMap"; }
    if (!out.sourceFile && index) {
      const src = resolveSource(d, index);
      if (src) {
        out.sourceFile = src.file;
        if (src.line) out.sourceLine = src.line;
        out.via = d.anchorVia || src.via;
      } else if (d.testid) {
        const exact = index.byTestidVariants?.[d.testid] || [];
        const variants = exact.length ? exact : matchingTestidPatterns(d.testid, index);
        if (new Set(variants.map(v => v.file)).size > 1) {
          out.sourceCandidates = variants.map(v => ({ file: v.file, line: v.line,
            states: v.states || [] }));
          out.via = "ambiguous-data-testid";
        }
      }
    }
    if (index) {
      const connected = index.byConnectedNodeId?.[d.figmaComponentId] || index.byConnectedNodeId?.[d.figmaNodeId];
      if (connected) out.connectedComponent = connected;
      const th = tokenHint(d, index);
      if (th?.candidates.length === 1) {
        out.tokenHint = `${th.token} (= ${th.value})`;
        if (th.source) out.tokenSource = th.source;
      } else if (th) out.tokenCandidates = th.candidates;
      if (out.sourceFile) {
        if (out.sourceLine) {
          const style = authoredStyle(index, out.sourceFile, out.sourceLine);
          if (style) out.authoredStyle = style;
        }
        const evidence = sourceEvidence(d, index, out.sourceFile, out.sourceLine);
        if (evidence) out.codeChange = evidence;
      }
    }
    return out;
  });
}
