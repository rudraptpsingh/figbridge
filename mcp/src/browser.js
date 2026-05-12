// Server-side browser orchestrator. Loaded lazily — figbridge stays small
// for users who don't drive imports from URLs.
//
// Why this exists: every "import a webpage into Figma" flow used to need
// chrome-devtools-mcp + figbridge + a shell script. Now figbridge is the
// single mediator — one MCP call replaces the dance.

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR_PATH = path.join(__dirname, "..", "..", "scripts", "dom-to-spec.js");

const CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

let _puppeteer = null;
let _browser = null; // reused across calls in one MCP session
let _extractor = null;

async function loadPuppeteer() {
  if (_puppeteer) return _puppeteer;
  try {
    _puppeteer = (await import("puppeteer-core")).default;
    return _puppeteer;
  } catch (e) {
    throw new Error(
      "puppeteer-core not installed. From figbridge/mcp/ run: npm i puppeteer-core"
    );
  }
}

function findChrome() {
  if (process.env.FIGBRIDGE_CHROME) return process.env.FIGBRIDGE_CHROME;
  for (const p of CHROME_PATHS) if (existsSync(p)) return p;
  throw new Error(
    "No Chrome/Chromium found. Install Google Chrome or set FIGBRIDGE_CHROME=/path/to/chrome."
  );
}

async function getBrowser() {
  if (_browser && _browser.connected !== false) return _browser;
  const puppeteer = await loadPuppeteer();
  _browser = await puppeteer.launch({
    headless: "shell",
    executablePath: findChrome(),
    args: ["--disable-gpu", "--no-sandbox"],
    defaultViewport: { width: 1280, height: 900 },
  });
  return _browser;
}

async function getExtractor() {
  if (_extractor) return _extractor;
  _extractor = await readFile(EXTRACTOR_PATH, "utf8");
  return _extractor;
}

export async function shutdown() {
  if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
}

/**
 * Render a URL in headless Chrome, scroll-prime to fire IntersectionObserver
 * reveals, hoist any opacity:0 elements (pre-fade-in DOM), then walk the
 * DOM with the canonical extractor. Returns the figbridge spec.
 */
export async function urlToSpec(url, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || (width >= 1024 ? 900 : (width >= 600 ? 1024 : 812));
  const maxDepth = opts.maxDepth || 18;
  const embedImages = opts.embedImages !== false;

  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    // Use domcontentloaded + a fixed settle wait. networkidle0/2 hangs on
    // sites with persistent beacon connections (analytics, web sockets).
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 2000));

    // Scroll-prime so IntersectionObserver reveals fire, then rescue any
    // opacity:0 elements (pre-fade-in DOM is real and we want it).
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 600) {
        window.scrollTo(0, y);
        await new Promise(r => setTimeout(r, 50));
      }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 500));
      document.querySelectorAll("*").forEach(el => {
        if (getComputedStyle(el).opacity === "0") el.style.opacity = "1";
      });
      await new Promise(r => setTimeout(r, 200));
    });

    const extractor = await getExtractor();
    await page.evaluate(extractor);
    const spec = await page.evaluate(
      (o) => window.domToSpec(o),
      { rootSelector: opts.rootSelector || "body", maxDepth, embedImages, viewport: width, name: opts.name || null }
    );

    // Iframe substitution: walk the spec for any rect tagged _iframeIdx
    // and replace its placeholder with a real puppeteer screenshot. Wait
    // for each iframe's content to load (DOM ready + a fixed settle) so
    // we don't capture a blank state.
    const iframeHandles = await page.$$('iframe');
    if (iframeHandles.length) {
      const shots = {};
      for (let i = 0; i < iframeHandles.length; i++) {
        try {
          // contentFrame() returns the Frame inside the iframe — wait for
          // its DOM ready so we don't capture a still-loading blank.
          const cf = await iframeHandles[i].contentFrame();
          if (cf) {
            try { await cf.waitForSelector('body', { timeout: 5000 }); } catch {}
            await new Promise(r => setTimeout(r, 1500)); // settle CSS/images
          }
          const buf = await iframeHandles[i].screenshot({ type: "png" });
          shots[i] = Buffer.from(buf).toString("base64");
        } catch (e) { /* tainted / cross-origin → skip */ }
      }
      (function walk(n) {
        if (n && n.type === "rect" && typeof n._iframeIdx === "number" && shots[n._iframeIdx]) {
          n._imageBytes = "data:image/png;base64," + shots[n._iframeIdx];
        }
        if (n && n.children) for (const c of n.children) walk(c);
      })(spec);
    }

    // background-image: url() substitution. Walk the spec for any frame
    // with _bgUrl, fetch the bytes (server-side, no CORS), inline as
    // _imageBytes so the plugin renders an image fill.
    const bgUrls = new Set();
    (function collect(n) {
      if (n && n._bgUrl) bgUrls.add(n._bgUrl);
      if (n && n.children) for (const c of n.children) collect(c);
    })(spec);
    if (bgUrls.size) {
      const bytesByUrl = {};
      for (const u of bgUrls) {
        try {
          const r = await fetch(u);
          if (!r.ok) continue;
          const ct = r.headers.get("content-type") || "image/png";
          const ab = await r.arrayBuffer();
          bytesByUrl[u] = `data:${ct};base64,` + Buffer.from(ab).toString("base64");
        } catch (e) { /* skip */ }
      }
      (function walk(n) {
        if (n && n._bgUrl && bytesByUrl[n._bgUrl] && !n._imageBytes) {
          n._imageBytes = bytesByUrl[n._bgUrl];
        }
        if (n && n.children) for (const c of n.children) walk(c);
      })(spec);
    }
    return spec;
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Render URL and run a JS snippet inside the page. The snippet is wrapped
 * as an async body and its return value is shipped back as JSON. This is
 * the diagnostic "evaluate-some-JS-in-the-page" tool — figbridge replaces
 * chrome-devtools-mcp.evaluate_script for one-off DOM probes.
 */
export async function probeUrl(url, script, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || 900;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1000));
    return await page.evaluate(new Function(`return (async () => { ${script} })()`));
  } finally {
    try { await page.close(); } catch {}
  }
}

/** Render URL and return a base64 PNG screenshot (full page). */
export async function screenshotUrl(url, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || (width >= 1024 ? 900 : (width >= 600 ? 1024 : 812));
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1500));
    const png = await page.screenshot({ fullPage: opts.fullPage !== false, type: "png" });
    return Buffer.from(png).toString("base64");
  } finally {
    try { await page.close(); } catch {}
  }
}
