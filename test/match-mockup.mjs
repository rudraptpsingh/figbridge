#!/usr/bin/env node
// Integration test for matchMockup() — the closed visual-diff loop. Serves a
// "mockup" (ground truth) and an "app" with known differences, then asserts
// the punch-list catches them and the pass flag is correct. Mirrors
// regression-audit.mjs (local HTTP server + headless Chrome).

import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { matchMockup, shutdown } from "../mcp/src/browser.js";

let passed = 0;
function assert(condition, message, detail) {
  if (!condition) throw new Error("FAIL: " + message + (detail ? "\n" + detail : ""));
  passed++;
}

// Same structure (so nodes pair) but differing copy, button color, and gap.
// The card carries a data-testid — the app's own component anchor — so the
// codebase-aware path can resolve deltas on it to a source file.
const page = (title, heading, gap, btnColor) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { margin: 0; font-family: Arial, sans-serif; background: #ffffff; color: #111111; }
  main { width: 900px; padding: 32px; }
  .card { display: flex; flex-direction: column; gap: ${gap}px; padding: 24px; background: #f5f5f5; border-radius: 12px; }
  h1 { font-size: 24px; margin: 0; }
  p { font-size: 14px; margin: 0; color: #666666; }
  button { padding: 12px 18px; border: 0; border-radius: 8px; color: #fff; background: ${btnColor}; font-size: 14px; }
</style></head>
<body><main><section class="card" data-testid="shot-card">
  <h1>${heading}</h1>
  <p>Pick your best shots from the session.</p>
  <button>Select shots</button>
</section></main></body></html>`;

const mockup = page("Mockup", "Sunset Shoot", 16, "#3d7dff");
const app = page("App", "Sunset Session", 8, "#ff5a3d"); // copy + gap + button color differ

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url && req.url.startsWith("/app") ? app : mockup);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const url = (p) => `http://127.0.0.1:${port}${p}`;
let srcDir = null;

try {
  // ── Differing app: should NOT pass and should surface the real deltas ──
  const r = await matchMockup(url("/mockup"), url("/app"), { widths: [768], minScore: 96, settleMs: 150 });
  assert(r.ok === true, "matchMockup should run without error", JSON.stringify(r.specError));
  assert(r.pass === false, "app differs from mockup → pass should be false", JSON.stringify(r.summary));
  assert(r.visual.length === 1, "expected one visual block for one viewport");
  assert(typeof r.visual[0].score === "number", "visual score should be numeric");
  assert(r.visual[0].mockupPng && r.visual[0].appPng, "comparison PNG paths should be returned", JSON.stringify(r.visual[0]));

  const pl = r.punchList || [];
  assert(pl.some(d => d.kind === "copy"), "punch-list should catch the heading copy change", JSON.stringify(pl));
  assert(pl.some(d => d.kind === "color" && d.field === "fill"), "punch-list should catch the button color change", JSON.stringify(pl));
  assert(pl.some(d => d.kind === "spacing"), "punch-list should catch the gap change", JSON.stringify(pl));
  assert(/match_mockup again|NOT a match/.test(r.nextAction), "nextAction should prescribe the loop when not matching", r.nextAction);

  // ── Identical pages: should pass cleanly ──
  const same = await matchMockup(url("/mockup"), url("/mockup"), { widths: [768], minScore: 96, settleMs: 150 });
  assert((same.punchList || []).length === 0, "identical pages should yield an empty punch-list", JSON.stringify(same.punchList));
  assert(same.summary.worstVisualScore >= 96, "identical pages should score >= threshold", JSON.stringify(same.summary));
  assert(same.pass === true, "identical pages should pass", JSON.stringify(same.summary));

  // ── Codebase-aware: sourceDir resolves deltas to files + token hints ──
  srcDir = await mkdtemp(path.join(tmpdir(), "figapp-"));
  await mkdir(path.join(srcDir, "components"), { recursive: true });
  await writeFile(path.join(srcDir, "index.css"), ":root { --accent: #3d7dff; }\n");
  await writeFile(path.join(srcDir, "components", "ShotCard.tsx"),
    'export const ShotCard = () => <section data-testid="shot-card">x</section>;\n');

  const mapped = await matchMockup(url("/mockup"), url("/app"), { widths: [768], minScore: 96, settleMs: 150, sourceDir: srcDir });
  assert(mapped.source && mapped.source.fileCount >= 2, "source index should report indexed files", JSON.stringify(mapped.source));
  const mp = mapped.punchList || [];
  assert(mp.some(d => d.sourceFile && d.sourceFile.endsWith("ShotCard.tsx") && d.via === "data-testid"),
    "a delta on the testid'd card should resolve to ShotCard.tsx via data-testid",
    JSON.stringify(mp.map(d => ({ kind: d.kind, field: d.field, testid: d.testid, sourceFile: d.sourceFile }))));
  assert(mp.some(d => d.tokenHint && d.tokenHint.includes("--accent")),
    "the mockup button colour should map to the --accent token hint",
    JSON.stringify(mp.map(d => ({ kind: d.kind, field: d.field, a: d.a, tokenHint: d.tokenHint }))));

  console.log(`PASS  matchMockup closed visual-diff loop + codebase-aware mapping (${passed} assertions).`);
} finally {
  if (srcDir) await rm(srcDir, { recursive: true, force: true }).catch(() => {});
  await Promise.race([shutdown(), new Promise(resolve => setTimeout(resolve, 3000))]);
  await Promise.race([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => setTimeout(resolve, 1000)),
  ]);
}

process.exit();
