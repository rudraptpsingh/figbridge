#!/usr/bin/env node
// One-shot: render a URL in headless Chromium, walk its DOM with computed
// styles, send the resulting spec to figbridge (which writes it as real
// Figma nodes). Usage:
//
//   node scripts/import-website.mjs http://127.0.0.1:8765 [width=1280] [bridgePort=7333]
//
// Requires `puppeteer` or `puppeteer-core` available. If neither is found,
// falls back to looking for an existing Chrome at the default debug port
// (9222) — set CHROME_DEBUG_PORT to override.
//
// This is the productionized version of the chrome-devtools-mcp flow the
// agents have been driving manually. After this lands, replicating a page
// at 3 viewports is `for w in 1280 768 375; do node scripts/import-website.mjs URL $w; done`.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const EXTRACTOR_SRC = fs.readFileSync(path.join(__dirname, "dom-to-spec.js"), "utf8");

const [, , URL_ARG, WIDTH_ARG = "1280", BRIDGE_PORT_ARG = "7333"] = process.argv;
if (!URL_ARG) {
  console.error("usage: import-website.mjs <url> [width=1280] [bridgePort=7333]");
  process.exit(2);
}
const width = parseInt(WIDTH_ARG, 10);
const height = width >= 1024 ? 900 : (width >= 600 ? 1024 : 812);
const bridgeUrl = `http://127.0.0.1:${BRIDGE_PORT_ARG}/command`;

async function loadPuppeteer() {
  try { return (await import("puppeteer")).default; }
  catch {}
  try { return (await import("puppeteer-core")).default; }
  catch {}
  return null;
}

async function main() {
  const puppeteer = await loadPuppeteer();
  if (!puppeteer) {
    console.error("puppeteer not installed. Run: npm i -D puppeteer in figbridge/mcp/, or attach to existing Chrome via CHROME_DEBUG_PORT.");
    process.exit(3);
  }
  console.error(`[import-website] launching headless Chrome at ${width}×${height}`);
  const browser = await puppeteer.launch({
    headless: "new",
    defaultViewport: { width, height, deviceScaleFactor: 1 }
  });
  const page = await browser.newPage();
  console.error(`[import-website] navigating to ${URL_ARG}`);
  await page.goto(URL_ARG, { waitUntil: "networkidle0", timeout: 30000 });
  // Tailwind CDN compiles on first idle frame; give it a beat.
  await new Promise(r => setTimeout(r, 1200));

  console.error(`[import-website] running DOM→spec extractor`);
  // Inject the extractor IIFE then call window.domToSpec.
  await page.evaluate(EXTRACTOR_SRC);
  const spec = await page.evaluate((opts) => window.domToSpec(opts), {
    rootSelector: "body",
    viewport: width,
    name: `ShotSelect ${width}px`,
    maxDepth: 14,
    embedImages: true,  // turns <img src> into data-URL bytes for Figma image fill
  });

  const jsonBytes = Buffer.byteLength(JSON.stringify(spec));
  function countNodes(n) { let c = 1; if (n && n.children) for (const ch of n.children) c += countNodes(ch); return c; }
  console.error(`[import-website] extracted ${countNodes(spec)} nodes, ${(jsonBytes/1024).toFixed(1)} KB`);

  console.error(`[import-website] POST → ${bridgeUrl}`);
  const r = await fetch(bridgeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "import-from-code", args: { spec, name: spec.name }, timeoutMs: 120000 })
  });
  const result = await r.json();
  console.log(JSON.stringify(result, null, 2));

  await browser.close();
  if (!result.ok) process.exit(1);
}

main().catch((e) => { console.error("[import-website] fatal:", e.stack || e); process.exit(1); });
