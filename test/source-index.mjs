#!/usr/bin/env node
// Unit tests for source-index.js — the codebase-awareness layer that lets a
// mockup-vs-app diff name the file to edit and the token a literal should be.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSourceIndex, resolveSource, tokenHint } from "../mcp/src/source-index.js";

let passed = 0;
function assert(c, m, d) { if (!c) throw new Error("FAIL: " + m + (d ? "\n" + d : "")); passed++; }

const dir = await mkdtemp(path.join(tmpdir(), "figsrc-"));
try {
  await mkdir(path.join(dir, "src", "components", "collab"), { recursive: true });
  await mkdir(path.join(dir, "node_modules", "junk"), { recursive: true });

  await writeFile(path.join(dir, "src", "index.css"),
    ':root {\n  --accent-success: #22c55e;\n  --space-2: 8px;\n}\n');
  await writeFile(path.join(dir, "src", "components", "collab", "ConflictResolutionCard.tsx"),
    'export function ConflictResolutionCard() {\n  return <div data-testid="conflict-card" className="conflict">…</div>;\n}\n');
  await writeFile(path.join(dir, "src", "components", "PhotoCard.tsx"),
    'export const PhotoCard = () => <article data-testid="photo-card">x</article>;\n');
  // a file that should NOT pollute the component-name map
  await writeFile(path.join(dir, "src", "components", "PhotoCard.test.tsx"),
    'test("x", () => { expect(1).toBe(1); });\n');
  // a giant generated file in node_modules must be skipped
  await writeFile(path.join(dir, "node_modules", "junk", "huge.js"),
    'data-testid="should-not-be-indexed"\n');

  const idx = await buildSourceIndex(dir);

  // testid → file:line
  assert(idx.byTestid["conflict-card"], "conflict-card testid not indexed", JSON.stringify(idx.byTestid));
  assert(idx.byTestid["conflict-card"].file.endsWith("ConflictResolutionCard.tsx"), "wrong file for conflict-card", JSON.stringify(idx.byTestid["conflict-card"]));
  assert(typeof idx.byTestid["conflict-card"].line === "number", "no line number for testid");
  assert(idx.byTestid["photo-card"], "photo-card testid not indexed");
  assert(!idx.byTestid["should-not-be-indexed"], "node_modules was indexed (should be skipped)");

  // component-name map (test files excluded)
  assert(idx.byComponent["conflictresolutioncard"], "component name not indexed");
  assert(idx.byComponent["photocard"].file.endsWith("PhotoCard.tsx"), "PhotoCard file wrong");

  // tokens: value ↔ name
  assert(idx.tokens.nameToVal["--accent-success"] === "#22c55e", "token nameToVal wrong", JSON.stringify(idx.tokens));
  assert(idx.tokens.valToName["#22c55e"] === "--accent-success", "token valToName (reverse) wrong");

  // resolveSource: testid wins
  const r1 = resolveSource({ testid: "conflict-card", name: ".conflict" }, idx);
  assert(r1 && r1.file.endsWith("ConflictResolutionCard.tsx") && r1.via === "data-testid", "resolveSource via testid failed", JSON.stringify(r1));

  // resolveSource: fallback to component-name when no testid
  const r2 = resolveSource({ name: "PhotoCard" }, idx);
  assert(r2 && r2.file.endsWith("PhotoCard.tsx"), "resolveSource via component name failed", JSON.stringify(r2));

  // resolveSource: unknown → null
  assert(resolveSource({ name: "zzz" }, idx) === null, "unknown node should resolve to null");

  // tokenHint: mockup color value → token
  const th = tokenHint({ kind: "color", field: "fill", a: "#22c55e", b: "#16a34a" }, idx);
  assert(th && th.token === "--accent-success", "tokenHint did not map color to token", JSON.stringify(th));
  assert(tokenHint({ kind: "copy", a: "#22c55e" }, idx) === null, "tokenHint should ignore non-style kinds");

  console.log(`PASS  source-index unit tests (${passed} assertions, ${idx.fileCount} files indexed).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.exit(0);
