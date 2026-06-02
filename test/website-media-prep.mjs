#!/usr/bin/env node
// Regression coverage for website media capture:
// - lazy images using data-src are woken before extraction
// - paired <use href="#..."></use> SVGs are inlined without orphan </use>
// - baked SVG styles are standalone enough to rasterize as PNG fallback
// - Framer-style display:contents wrappers preserve deep visual children
//   instead of collapsing to a tiny text-only spec

import { createServer } from "node:http";
import { preflightImport, shutdown, urlToSpec } from "../mcp/src/browser.js";
import { startBridge } from "../mcp/src/bridge.js";

function assert(condition, message, detail) {
  if (!condition) {
    const suffix = detail ? "\n" + detail : "";
    throw new Error(message + suffix);
  }
}

const lazySvg = Buffer.from(
  "<svg xmlns='http://www.w3.org/2000/svg' width='48' height='48'><rect width='48' height='48' fill='#ff7a29'/></svg>"
).toString("base64");

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; background: #08090a; color: white; font-family: Arial; }
    @font-face {
      font-family: "Fixture Sans";
      font-style: normal;
      font-weight: 400;
      src: url("/fonts/fixture-sans.woff2") format("woff2");
    }
    .wrap { padding: 24px; }
    .brand svg { width: 64px; height: 64px; color: #5e6ad2; }
    .brand path { fill: currentColor; stroke: white; stroke-width: 2; }
    .lazy { width: 48px; height: 48px; object-fit: cover; }
    .framer-root { display: contents; }
    .framer-section { width: 360px; min-height: 120px; padding: 16px; background: #111827; }
    .framer-card { display: flex; gap: 12px; align-items: center; padding: 12px; background: rgba(255,255,255,.12); border-radius: 12px; }
    .framer-card img { width: 48px; height: 48px; object-fit: cover; }
    .framer-text { font-size: 22px; font-weight: 700; }
  </style>
</head>
<body>
  <div class="wrap">
    <svg width="0" height="0" style="position:absolute">
      <symbol id="mark" viewBox="0 0 64 64">
        <path d="M8 8h48v48H8z"></path>
      </symbol>
    </svg>
    <div class="brand">
      <svg viewBox="0 0 64 64"><use href="#mark"></use></svg>
    </div>
    <img class="lazy" data-src="data:image/svg+xml;base64,${lazySvg}" alt="lazy">
    <div class="framer-root">
      <style>.discard-me { color: red; }</style>
      <script>window.__discard_me__ = "this script must not become text";</script>
      <section class="framer-section">
        <div class="framer-card">
          <img data-src="data:image/svg+xml;base64,${lazySvg}" alt="deep lazy">
          <p class="framer-text">Framer deep media survived</p>
        </div>
      </section>
    </div>
  </div>
</body>
</html>`;

const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
let bridgeServer = null;

try {
  const spec = await urlToSpec(url, { width: 390, settleMs: 300, embedImages: true });
  let svg = null;
  let img = null;
  let framerText = null;
  let leakedScriptText = null;
  let framerImageCount = 0;
  (function walk(n) {
    if (!n) return;
    if (n.type === "svg" && n.width >= 60) svg = n;
    if (n.name && n.name.includes(":img")) img = n;
    if (n.type === "text" && n.characters === "Framer deep media survived") framerText = n;
    if (n.type === "text" && /discard_me|discard-me/.test(n.characters || "")) leakedScriptText = n;
    if (n.name && n.name.includes(":img") && n._imageBytes) framerImageCount++;
    for (const child of n.children || []) walk(child);
  })(spec);

  assert(svg, "expected visible SVG node");
  assert(!svg._svg.includes("</use>"), "paired <use> left an orphan closing tag", svg._svg);
  assert(svg._svg.includes("<g"), "symbol reference was not inlined", svg._svg);
  assert(/color="rgb\(94, 106, 210\)"/.test(svg._svg), "computed SVG color was not baked", svg._svg);
  assert(svg._svgImageBytes && svg._svgImageBytes.startsWith("data:image/png;base64,"), "SVG raster fallback was not generated");

  assert(img && img._imageBytes, "lazy data-src image was not captured");
  assert(img._imageBytes.startsWith("data:image/png;base64,"), "lazy image was not normalized to PNG");
  assert(framerText, "display:contents branch dropped deep Framer-like text");
  assert(framerImageCount >= 2, "display:contents branch dropped deep Framer-like media");
  assert(!leakedScriptText, "script/style text leaked into generated text nodes");

  const preflight = await preflightImport(url, { width: 390, settleMs: 300 });
  assert(preflight.fontFaces && preflight.fontFaces.some(f => f.family === "Fixture Sans"), "preflight did not detect @font-face family");
  assert(preflight.fontDownloads && preflight.fontDownloads.some(u => u.endsWith("/fonts/fixture-sans.woff2")), "preflight did not expose font download URL");
  assert(preflight.issues.some(i => i.type === "font-downloads"), "preflight did not add font-downloads issue");

  const bridge = await startBridge(7462, () => {}, 4);
  bridgeServer = bridge.server;
  const hybridRes = await fetch(`http://127.0.0.1:${bridge.port}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "import-url",
      args: { url, width: 390, dryRun: true, hybridSnapshot: true, name: "Hybrid regression" },
      timeoutMs: 120000,
    }),
  });
  const hybrid = await hybridRes.json();
  assert(hybrid.ok && hybrid.dryRun, "hybrid snapshot dry-run failed", JSON.stringify(hybrid));
  assert(hybrid.telemetry && hybrid.telemetry.images >= 1, "hybrid snapshot did not add image-backed reference", JSON.stringify(hybrid.telemetry));

  console.log("PASS  website media prep wakes lazy images and bakes SVGs.");
} finally {
  if (bridgeServer) await new Promise(resolve => bridgeServer.close(resolve));
  await shutdown();
  await new Promise(resolve => server.close(resolve));
}
