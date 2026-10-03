#!/usr/bin/env node
// Unit tests for source-index.js — the codebase-awareness layer that lets a
// mockup-vs-app diff name the file to edit and the token a literal should be.

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildSourceIndex, resolveSource, annotateDeltas, tokenHint, sourceEvidence, authoredStyle } from "../mcp/src/source-index.js";

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
  await mkdir(path.join(dir, "src", "design"), { recursive: true });
  await writeFile(path.join(dir, "src", "design", "v2Tokens.json"),
    JSON.stringify({ css: { "--v2-panel-width": "64px", "--v2-space-4": "18px" } }));
  await mkdir(path.join(dir, "docs", "design", "desktop-v2"), { recursive: true });
  await writeFile(path.join(dir, "docs", "design", "desktop-v2", "tokens.json"),
    JSON.stringify({ variables: { "space/4": { type: "float", value: 16 } } }));
  await writeFile(path.join(dir, "src", "components", "Align.tsx"),
    'export const Align = () => <section data-testid="align" className="w-[84px]">x</section>;\n');
  await writeFile(path.join(dir, "src", "components", "Stateful.tsx"),
    '<section data-testid="stateful" data-state="empty" className="p-v2-8" />\n' +
    '<section data-testid="stateful" data-state={ready ? \'matched\' : \'suggested\'} className="ml-10" />\n');
  await writeFile(path.join(dir, "src", "components", "First.tsx"),
    '<button data-testid="shared-control">One</button>\n');
  await writeFile(path.join(dir, "src", "components", "Second.tsx"),
    '<button data-testid="shared-control">Two</button>\n');
  await writeFile(path.join(dir, "src", "components", "Template.tsx"),
    'export const Count = ({ name }) => <span data-testid={`filter-${name}-count`}>1</span>;\n');
  await writeFile(path.join(dir, "src", "components", "Avatar.tsx"),
    'export const Avatar = ({ p }) => <span data-testid={p.testId ?? `avatar-stack-person-${p.id}`}>AK</span>;\n');
  await writeFile(path.join(dir, "figbridge.connect.json"), JSON.stringify({ version: 1, components: [
    { figma: { name: "Shot Select Card", nodeId: "1:2" }, code: { source: "src/components/PhotoCard.tsx", export: "PhotoCard" } },
  ] }));
  // a file that should NOT pollute the component-name map
  await writeFile(path.join(dir, "src", "components", "PhotoCard.test.tsx"),
    'test("x", () => { document.querySelector(\'[data-testid="photo-card"]\'); });\n');
  await mkdir(path.join(dir, "e2e", "specs"), { recursive: true });
  await writeFile(path.join(dir, "e2e", "specs", "photo.spec.ts"),
    'await page.locator(\'[data-testid="photo-card"]\').click();\n');
  // a giant generated file in node_modules must be skipped
  await writeFile(path.join(dir, "node_modules", "junk", "huge.js"),
    'data-testid="should-not-be-indexed"\n');

  const idx = await buildSourceIndex(dir);

  // testid → file:line
  assert(idx.byTestid["conflict-card"], "conflict-card testid not indexed", JSON.stringify(idx.byTestid));
  assert(idx.byTestid["conflict-card"].file.endsWith("ConflictResolutionCard.tsx"), "wrong file for conflict-card", JSON.stringify(idx.byTestid["conflict-card"]));
  assert(typeof idx.byTestid["conflict-card"].line === "number", "no line number for testid");
  assert(idx.byTestid["photo-card"], "photo-card testid not indexed");
  assert(resolveSource({ testid: "photo-card" }, idx)?.file.endsWith("src" + path.sep + "components" + path.sep + "PhotoCard.tsx"),
    "test and capture selectors must not steal source ownership", JSON.stringify(idx.byTestidVariants["photo-card"]));
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
  const connected = resolveSource({ name: "Shot Select Card" }, idx);
  assert(connected?.file.endsWith("PhotoCard.tsx") && connected.via === "figbridge.connect.json", "connect mapping not used", JSON.stringify(connected));
  const matched = resolveSource({ testid: "stateful", state: "matched" }, idx);
  assert(matched?.line === 2 && authoredStyle(idx, matched.file, matched.line)?.className === "ml-10", "matched state selected wrong JSX branch", JSON.stringify(matched));
  const unknown = resolveSource({ testid: "stateful", state: "unknown" }, idx);
  assert(unknown?.file.endsWith("Stateful.tsx") && !unknown.line && unknown.via === "data-testid-ambiguous", "unmatched state should not cite a guessed branch", JSON.stringify(unknown));
  const shared = annotateDeltas([{ name: "Shared", testid: "shared-control", kind: "color", field: "color", a: "#fff", b: "#000" }], idx)[0];
  assert(!shared.sourceFile && shared.sourceCandidates?.length === 2 &&
    shared.sourceCandidates.some(x => x.file.endsWith("First.tsx")) &&
    shared.sourceCandidates.some(x => x.file.endsWith("Second.tsx")),
    "ambiguous owners must remain unresolved but list each real source candidate", JSON.stringify(shared));
  assert(resolveSource({ testid: "filter-reception-count" }, idx)?.file.endsWith("Template.tsx"),
    "rendered test id should resolve through its authored template literal");
  assert(resolveSource({ testid: "avatar-stack-person-peer-ak" }, idx)?.file.endsWith("Avatar.tsx"),
    "fallback template test id should resolve through its authored source");

  // resolveSource: unknown → null
  assert(resolveSource({ name: "zzz" }, idx) === null, "unknown node should resolve to null");

  // tokenHint: mockup color value → token
  const th = tokenHint({ kind: "color", field: "fill", a: "#22c55e", b: "#16a34a" }, idx);
  assert(th && th.token === "--accent-success", "tokenHint did not map color to token", JSON.stringify(th));
  assert(tokenHint({ kind: "copy", a: "#22c55e" }, idx) === null, "tokenHint should ignore non-style kinds");

  // Exact code evidence requires a unique matching source literal; the target
  // token comes from the checked-in Figma-generated token file.
  const widthDelta = { kind: "spacing", field: "width", a: 64, b: 84 };
  const hint = tokenHint(widthDelta, idx);
  assert(hint?.token === "--v2-panel-width" && hint.source?.replaceAll("\\", "/") === "src/design/v2Tokens.json", "generated token not indexed", JSON.stringify(hint));
  assert(idx.tokenDrift.some(d => d.token === "--v2-space-4" && d.figma === "16px" && d.code === "18px"), "source/generated token drift missing", JSON.stringify(idx.tokenDrift));
  const evidence = sourceEvidence(widthDelta, idx, "src/components/Align.tsx");
  assert(evidence?.current === "w-[84px]" && evidence?.line === 1, "current code literal not identified", JSON.stringify(evidence));
  assert(evidence?.suggested === "w-[var(--v2-panel-width)]", "token-backed replacement missing", JSON.stringify(evidence));
  assert(authoredStyle(idx, "src/components/Align.tsx", 1)?.className === "w-[84px]", "current authored sizing rule missing");
  assert(sourceEvidence({ kind: "spacing", field: "x", a: 124, b: 84 }, idx, "src/components/Align.tsx") === null, "absolute x should not become a guessed local margin edit");
  assert(sourceEvidence({ ...widthDelta, b: 85 }, idx, "src/components/Align.tsx") === null, "must not guess when computed size has no source literal");

  console.log(`PASS  source-index unit tests (${passed} assertions, ${idx.fileCount} files indexed).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
process.exit(0);
