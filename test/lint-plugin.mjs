#!/usr/bin/env node
// Catch two classes of bugs that slip past Node harnesses but hit the
// Figma QuickJS sandbox:
//
//   1. Duplicate top-level `function F()` declarations. The later one
//      silently wins, so the earlier one becomes dead code — any
//      "fix" edited into it never runs. (We hit this with exportNodes.)
//
//   2. `function` declarations inside an IIFE (`(function(){...})()`)
//      that are referenced from code outside the IIFE. The classic
//      "X is not defined" trap — the inner decl is function-scoped
//      and invisible at the top level. (We hit this hard when the
//      bottom half of plugin/code.js was wrapped in `var X = (function
//      () { ... })()` and the top half called into it.)
//
// Note: we deliberately do NOT flag plain backward references within
// the same scope. `function` declarations hoist in every standards-
// compliant engine including QuickJS, so a call at line N to a
// function declared at line N+100 is fine.
//
// This lint is deliberately dumb and text-based: no AST, no deps. It
// flags suspects; run `node test/lint-plugin.mjs` before pushing.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FILE = path.join(__dirname, "..", "plugin", "code.js");
const src = fs.readFileSync(FILE, "utf8");
const lines = src.split("\n");

// ── 1. Duplicate top-level function declarations ───────────────────
// "Top-level" = column 0, i.e. line starts with `function X` or
// `async function X`. Nested functions are indented.
const decls = new Map(); // name → [lineNumbers]
const declRe = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/;
for (let i = 0; i < lines.length; i++) {
  const m = declRe.exec(lines[i]);
  if (!m) continue;
  const name = m[1];
  if (!decls.has(name)) decls.set(name, []);
  decls.get(name).push(i + 1);
}

const duplicates = [];
for (const [name, rows] of decls) {
  if (rows.length > 1) duplicates.push({ name, rows });
}

// ── 2. IIFE scope traps ─────────────────────────────────────────────
// Detect the `var X = (function () { ... })()` pattern at column 0,
// then warn that every `function` declared between its open and close
// is invisible to code outside. This does NOT walk AST — we just
// match the opener at column 0 and the closing `})();` at column 0,
// which is the exact pattern that bit us.
const iifeRanges = [];
for (let i = 0; i < lines.length; i++) {
  // `var X = (function () {` or `(function () {` at column 0
  if (/^(?:var\s+\w+\s*=\s*)?\(\s*(?:async\s+)?function\s*\(\s*\)\s*\{/.test(lines[i])) {
    // Find closing `})();` at column 0 at or after this line.
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\}\)\s*\(\s*\)\s*;?\s*$/.test(lines[j])) {
        iifeRanges.push({ start: i + 1, end: j + 1 });
        i = j;
        break;
      }
    }
  }
}

// Any top-level function declaration that lives inside an IIFE range
// is a scope trap if called from outside the range.
const iifeTraps = [];
for (const [name, rows] of decls) {
  for (const ln of rows) {
    const inside = iifeRanges.find(r => ln >= r.start && ln <= r.end);
    if (!inside) continue;
    // Already handled via duplicate check if both inside and outside.
    iifeTraps.push({ name, declLine: ln, range: inside });
  }
}

// ── Report ─────────────────────────────────────────────────────────
let exit = 0;
console.log(`lint-plugin ${path.relative(process.cwd(), FILE)}`);
console.log("─".repeat(68));

if (duplicates.length) {
  exit = 1;
  console.log(`\n✗ ${duplicates.length} duplicate top-level function declaration(s):`);
  for (const { name, rows } of duplicates) {
    console.log(`  ${name}  lines ${rows.join(", ")}  (later wins — earlier is dead)`);
  }
} else {
  console.log("\n✓ no duplicate top-level function declarations");
}

if (iifeTraps.length) {
  exit = 1;
  console.log(`\n✗ ${iifeTraps.length} function(s) declared inside an IIFE — invisible from the outer scope:`);
  for (const { name, declLine, range } of iifeTraps) {
    console.log(`  ${name}  line ${declLine}  (IIFE spans ${range.start}..${range.end})`);
  }
  console.log(`\n  fix: unwrap the IIFE, or move the function above it.`);
} else {
  console.log("✓ no IIFE-scoped function traps");
}

const total = duplicates.length + iifeTraps.length;
if (exit) {
  console.log(`\n${total} issue(s). exit 1.`);
} else {
  console.log("\nclean.");
}
process.exit(exit);
