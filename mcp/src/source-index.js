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
import path from "node:path";

const CODE_EXT = new Set([".tsx", ".jsx", ".ts", ".js", ".vue", ".svelte", ".mjs"]);
const SCAN_EXT = new Set([...CODE_EXT, ".css", ".scss"]); // css scanned for tokens only
const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "__snapshots__", ".cache", "vendor", "test-results"]);
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
    } else if (SCAN_EXT.has(path.extname(e.name))) {
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
    byTestid: {}, byComponent: {},
    tokens: { valToName: {}, nameToVal: {} }, cssFiles: [],
  };
  const files = [];
  await walk(sourceDir, files, 0);
  out.fileCount = files.length;

  const TESTID_RE = /\bdata-(?:testid|test-id|component)\s*=\s*[{]?\s*["'`]([^"'`]+)["'`]/g;
  const CSSVAR_RE = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;

  for (const file of files) {
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
      if (!out.byTestid[id]) out.byTestid[id] = { file: rel, line: lineOf(text, m.index) };
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
        // reverse map for resolvable literals (hex / rgb / px)
        if (/^#|^rgb|^\d/.test(val) && !out.tokens.valToName[val]) out.tokens.valToName[val] = name;
      }
    }
  }
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
  if (tid && index.byTestid[tid]) return { ...index.byTestid[tid], via: "data-testid" };
  // conservative name fallback: node label like ".conflict-card" → ConflictResolutionCard
  const label = normName((delta && delta.name) || "");
  if (label.length >= 5) {
    if (index.byComponent[label]) return { ...index.byComponent[label], via: "component-name" };
    for (const key of Object.keys(index.byComponent)) {
      if ((key.includes(label) || label.includes(key)) && Math.min(key.length, label.length) >= 6) {
        return { ...index.byComponent[key], via: "component-name~" };
      }
    }
  }
  return null;
}

/**
 * For a color/spacing delta, suggest the design token the mockup value maps to,
 * so the fix is a token edit rather than a hardcoded literal.
 * @returns {{ token, value } | null}
 */
export function tokenHint(delta, index) {
  if (!index || !delta) return null;
  if (delta.kind !== "color" && delta.kind !== "elevation" && delta.kind !== "spacing") return null;
  const want = typeof delta.a === "string" ? delta.a.trim().toLowerCase() : null;
  if (want && index.tokens.valToName[want]) return { token: index.tokens.valToName[want], value: want };
  return null;
}
