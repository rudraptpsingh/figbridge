#!/usr/bin/env node
// Browser-level regression audit: baseline URL vs candidate URL.

import { createServer } from "node:http";
import { auditRegression, shutdown } from "../mcp/src/browser.js";

function assert(condition, message, detail) {
  if (!condition) throw new Error(message + (detail ? "\n" + detail : ""));
}

const baseline = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Baseline</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; color: #172033; background: #f7f7f4; }
    main { max-width: 960px; margin: 0 auto; padding: 32px; }
    .hero { display: grid; grid-template-columns: 1fr 260px; gap: 24px; align-items: center; }
    h1 { font-size: 44px; margin: 0 0 12px; }
    p { font-size: 18px; line-height: 1.5; }
    a, button { min-width: 48px; min-height: 48px; padding: 12px 18px; }
    .box { height: 180px; background: #d86f37; border-radius: 8px; }
    @media (max-width: 640px) {
      main { padding: 20px; }
      .hero { grid-template-columns: 1fr; }
      h1 { font-size: 32px; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>Reliable visual QA</h1>
        <p>Critical checkout copy stays visible across every viewport.</p>
        <button>Start audit</button>
      </div>
      <div class="box"></div>
    </section>
  </main>
</body>
</html>`;

const candidate = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Candidate</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; color: #172033; background: #ffffff; }
    main { width: 1200px; padding: 12px; }
    .hero { display: flex; gap: 4px; align-items: start; }
    h1 { font-size: 26px; margin: 0 0 4px; color: #8a1f1f; }
    p { font-size: 10px; line-height: 1.1; }
    button { width: 28px; height: 24px; padding: 0; font-size: 10px; }
    .box { width: 680px; height: 260px; background: #243b6b; border-radius: 0; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <h1>Visual QA changed</h1>
        <p>Something else is here now.</p>
        <button>Go</button>
      </div>
      <div class="box"></div>
    </section>
  </main>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(req.url && req.url.startsWith("/candidate") ? candidate : baseline);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

try {
  const result = await auditRegression(
    `http://127.0.0.1:${port}/baseline`,
    `http://127.0.0.1:${port}/candidate`,
    { widths: [390, 768], minScore: 99, settleMs: 100 }
  );

  assert(result.ok === false, "regression audit should fail candidate with missing text and responsive issues", JSON.stringify(result.summary));
  assert(result.summary.errors >= 1, "regression audit should report errors", JSON.stringify(result.summary));
  assert(result.issues.some(i => i.type === "missing-text"), "missing text regression was not reported", JSON.stringify(result.issues));
  assert(result.issues.some(i => i.type === "responsive-regression"), "responsive regression was not reported", JSON.stringify(result.issues));
  assert(result.visual.length === 2, "expected one visual result per viewport");
  assert(result.visual.some(v => v.score < 99), "visual score did not catch layout/color change", JSON.stringify(result.visual));
  assert(result.responsive.delta.totalIssues > 0, "responsive delta should show new issues", JSON.stringify(result.responsive.delta));

  console.log("PASS  frontend regression audit detects visual, text, and responsive regressions.");
} finally {
  await Promise.race([
    shutdown(),
    new Promise(resolve => setTimeout(resolve, 3000))
  ]);
  await Promise.race([
    new Promise(resolve => server.close(resolve)),
    new Promise(resolve => setTimeout(resolve, 1000))
  ]);
}

process.exit();
