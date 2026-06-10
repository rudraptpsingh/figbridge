// Server-side browser orchestrator. Loaded lazily — figbridge stays small
// for users who don't drive imports from URLs.
//
// Why this exists: every "import a webpage into Figma" flow used to need
// chrome-devtools-mcp + figbridge + a shell script. Now figbridge is the
// single mediator — one MCP call replaces the dance.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { existsSync } from "node:fs";
import { diffSpecs, styleProfile, compareStyleProfiles } from "./spec-diff.js";
import { buildSourceIndex, resolveSource, tokenHint } from "./source-index.js";
import { annotateDiff, ssim, demarcatePng } from "./image-tools.js";
import { layoutMetrics, diffLayoutMetrics, demarcationBoxes } from "./layout-metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR_PATHS = [
  path.join(__dirname, "dom-to-spec.js"),
  path.join(__dirname, "..", "..", "scripts", "dom-to-spec.js")
];

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
  let lastError = null;
  for (const candidate of EXTRACTOR_PATHS) {
    try {
      _extractor = await readFile(candidate, "utf8");
      return _extractor;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError || new Error("dom-to-spec extractor not found");
}

async function rasterizeImageDataUrl(dataUrl, opts = {}) {
  if (!dataUrl || typeof dataUrl !== "string") return null;
  const maxDimension = opts.maxDimension || 2048;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    return await page.evaluate(async ({ dataUrl, maxDimension, width, height }) => {
      function loadImage(src) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("image load failed"));
          img.src = src;
        });
      }
      const img = await loadImage(dataUrl);
      const naturalW = img.naturalWidth || width || 1;
      const naturalH = img.naturalHeight || height || 1;
      const scale = Math.min(1, maxDimension / Math.max(naturalW, naturalH));
      const outW = Math.max(1, Math.round(naturalW * scale));
      const outH = Math.max(1, Math.round(naturalH * scale));
      const canvas = document.createElement("canvas");
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, outW, outH);
      return canvas.toDataURL("image/png");
    }, { dataUrl, maxDimension, width: opts.width || 0, height: opts.height || 0 });
  } finally {
    try { await page.close(); } catch {}
  }
}

async function rasterizeSvgDataUrl(svg, opts = {}) {
  if (!svg) return null;
  const width = Math.max(1, Math.round(opts.width || 64));
  const height = Math.max(1, Math.round(opts.height || 64));
  const dataUrl = "data:image/svg+xml;base64," + Buffer.from(String(svg)).toString("base64");
  return await rasterizeImageDataUrl(dataUrl, { width, height, maxDimension: opts.maxDimension || 2048 });
}

async function rasterizeDataUrlBatch(items, opts = {}) {
  if (!items.length) return [];
  const maxDimension = opts.maxDimension || 2048;
  const unique = [];
  const keyToIndexes = new Map();
  for (const item of items) {
    const key = [item.dataUrl, item.width || 0, item.height || 0].join("\n");
    if (!keyToIndexes.has(key)) {
      keyToIndexes.set(key, []);
      unique.push({ ...item, index: unique.length, _originalKey: key });
    }
    keyToIndexes.get(key).push(item.index);
  }
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const uniqueResults = await page.evaluate(async ({ items, maxDimension }) => {
      function loadImage(src) {
        return new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = () => reject(new Error("image load failed"));
          img.src = src;
        });
      }
      const out = [];
      for (const item of items) {
        try {
          const img = await loadImage(item.dataUrl);
          const naturalW = img.naturalWidth || item.width || 1;
          const naturalH = img.naturalHeight || item.height || 1;
          const scale = Math.min(1, maxDimension / Math.max(naturalW, naturalH));
          const outW = Math.max(1, Math.round(naturalW * scale));
          const outH = Math.max(1, Math.round(naturalH * scale));
          const canvas = document.createElement("canvas");
          canvas.width = outW;
          canvas.height = outH;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0, outW, outH);
          out.push({ index: item.index, dataUrl: canvas.toDataURL("image/png") });
        } catch (e) {
          out.push({ index: item.index, error: e.message });
        }
      }
      return out;
    }, { items: unique, maxDimension });
    const expanded = [];
    for (const result of uniqueResults) {
      const src = unique[result.index];
      if (!src) continue;
      const indexes = keyToIndexes.get(src._originalKey) || [];
      for (const originalIndex of indexes) expanded.push({ ...result, index: originalIndex });
    }
    return expanded;
  } finally {
    try { await page.close(); } catch {}
  }
}

function shouldNormalizeImage(dataUrl, node) {
  if (!dataUrl || typeof dataUrl !== "string") return false;
  return true;
}

async function normalizeSpecMedia(spec) {
  const imageNodes = [];
  const svgNodes = [];
  (function collect(n) {
    if (!n) return;
    if (n._imageBytes) imageNodes.push(n);
    if (n.type === "svg" && n._svg) svgNodes.push(n);
    if (n.children) for (const c of n.children) collect(c);
  })(spec);
  const normalizeItems = [];
  for (let i = 0; i < imageNodes.length; i++) {
    const n = imageNodes[i];
    if (shouldNormalizeImage(n._imageBytes, n)) {
      normalizeItems.push({ index: i, dataUrl: n._imageBytes, width: n.width, height: n.height });
    }
  }
  const normalized = await rasterizeDataUrlBatch(normalizeItems);
  for (const item of normalized) {
    const n = imageNodes[item.index];
    if (!n) continue;
    if (item.dataUrl) n._imageBytes = item.dataUrl;
    else if (item.error) {
      n._imageWarn = "image normalization failed: " + item.error;
      delete n._imageBytes;
    }
  }

  // SVG fallbacks are only used after plugin-side vector parsing fails;
  // vector import remains the primary path for every SVG.
  const svgItems = svgNodes.map((n, i) => ({
    index: i,
    dataUrl: "data:image/svg+xml;base64," + Buffer.from(String(n._svg)).toString("base64"),
    width: n.width,
    height: n.height,
  }));
  const svgRasters = await rasterizeDataUrlBatch(svgItems);
  for (const item of svgRasters) {
    const n = svgNodes[item.index];
    if (!n) continue;
    if (item.dataUrl) n._svgImageBytes = item.dataUrl;
    else if (item.error) n._svgWarn = "svg raster fallback failed: " + item.error;
  }
}

export async function shutdown() {
  if (!_browser) return;
  const browser = _browser;
  _browser = null;
  let proc = null;
  try { proc = typeof browser.process === "function" ? browser.process() : null; } catch {}
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Chrome close timed out")), 2000))
    ]);
  } catch {
    try { if (proc && !proc.killed) proc.kill("SIGTERM"); } catch {}
    await new Promise(r => setTimeout(r, 300));
    try { if (proc && !proc.killed) proc.kill("SIGKILL"); } catch {}
  }
}

/**
 * Read source-of-truth files (HTML/CSS/JSON design tokens) from a local
 * directory to enrich the extracted spec. The agent's GitHub repo for
 * the site being imported is the ideal sourceDir — figbridge gets both
 * the rendered output AND the authored intent.
 *
 * Returns:
 *   - tokens: parsed tokens.json / design-tokens.json if present
 *   - cssVars: extracted from any .css with :root { --foo: bar }
 *   - fileList: top-level filenames for diagnostics
 */
async function readSourceContext(sourceDir) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const out = { sourceDir, tokens: null, cssVars: {}, fileList: [] };
  try {
    out.fileList = (await fs.readdir(sourceDir)).slice(0, 40);
  } catch { return out; }
  // Tokens file (if any)
  for (const candidate of ["tokens.json", "design-tokens.json", "tokens/index.json"]) {
    try {
      const buf = await fs.readFile(path.join(sourceDir, candidate), "utf8");
      out.tokens = JSON.parse(buf);
      break;
    } catch {}
  }
  // CSS vars from any top-level .css file (greedy regex; good enough)
  for (const name of out.fileList) {
    if (!name.endsWith(".css")) continue;
    try {
      const css = await fs.readFile(path.join(sourceDir, name), "utf8");
      const rootMatch = css.match(/:root\s*\{([\s\S]*?)\}/);
      if (rootMatch) {
        for (const m of rootMatch[1].matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g)) {
          out.cssVars["--" + m[1]] = m[2].trim();
        }
      }
    } catch {}
  }
  return out;
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
    // prefers-color-scheme emulation: sites that auto-switch by system
    // (most modern landing pages) get captured in the requested theme.
    if (opts.colorScheme === "dark" || opts.colorScheme === "light") {
      try { await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: opts.colorScheme }]); } catch (e) {}
    }
    // Use domcontentloaded + a fixed settle wait. networkidle0/2 hangs on
    // sites with persistent beacon connections (analytics, web sockets).
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 2000));

    // Scroll-prime so IntersectionObserver reveals fire, wake lazy media,
    // then rescue opacity:0 elements (pre-fade-in DOM is real and we want it).
    await page.evaluate(async () => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      const wakeImages = () => {
        document.querySelectorAll("img").forEach((img) => {
          try { img.loading = "eager"; } catch {}
          const dataSrc = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original");
          const dataSrcset = img.getAttribute("data-srcset") || img.getAttribute("data-lazy-srcset");
          if (!img.getAttribute("src") && dataSrc) img.setAttribute("src", dataSrc);
          if (!img.getAttribute("srcset") && dataSrcset) img.setAttribute("srcset", dataSrcset);
          try { img.decoding = "sync"; } catch {}
        });
        document.querySelectorAll("source").forEach((source) => {
          const dataSrcset = source.getAttribute("data-srcset") || source.getAttribute("data-lazy-srcset");
          if (!source.getAttribute("srcset") && dataSrcset) source.setAttribute("srcset", dataSrcset);
        });
        document.querySelectorAll("video").forEach((video) => {
          try { video.preload = "auto"; } catch {}
          try { video.muted = true; } catch {}
          try { video.playsInline = true; } catch {}
          try { if (video.readyState < 2) video.load(); } catch {}
        });
      };
      wakeImages();
      const maxScroll = Math.min(document.body.scrollHeight || 0, 24000);
      for (let y = 0; y < maxScroll; y += 600) {
        window.scrollTo(0, y);
        wakeImages();
        await wait(50);
      }
      window.scrollTo(0, 0);
      await wait(500);
      const visibleImages = Array.from(document.images).filter(img => {
        const r = img.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && img.currentSrc;
      }).slice(0, 120);
      await Promise.allSettled(visibleImages.map(img => {
        try {
          if (img.complete && img.naturalWidth) return Promise.resolve();
          return img.decode ? img.decode() : new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
            setTimeout(resolve, 1500);
          });
        } catch { return Promise.resolve(); }
      }));
      const visibleVideos = Array.from(document.querySelectorAll("video")).filter(video => {
        const r = video.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }).slice(0, 80);
      await Promise.allSettled(visibleVideos.map(video => new Promise((resolve) => {
        try {
          if (video.readyState >= 2 && video.videoWidth) return resolve();
          const done = () => resolve();
          video.addEventListener("loadeddata", done, { once: true });
          video.addEventListener("canplay", done, { once: true });
          setTimeout(done, 2000);
          const p = video.play && video.play();
          if (p && p.then) p.then(() => { try { video.pause(); } catch {}; resolve(); }).catch(() => {});
        } catch { resolve(); }
      })));
      document.querySelectorAll("*").forEach(el => {
        if (getComputedStyle(el).opacity === "0") el.style.opacity = "1";
      });
      await wait(200);
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
    // Iframe substitution: open each iframe's src in its OWN dedicated
    // page and screenshot it at the iframe's rendered dimensions. Plain
    // iframeHandle.screenshot() and page.screenshot({clip}) both come back
    // blank for iframes because they render in separate compositing
    // layers. Resolving to a top-level page sidesteps that entirely.
    // Collect every iframe + every bg-url upfront, then resolve them all
    // in parallel. Serial fetching of a 3-iframe + 5-bgUrl page was
    // adding ~15s to imports for no good reason.
    const iframeMeta = await page.$$eval('iframe', els =>
      els.map(el => {
        const r = el.getBoundingClientRect();
        return { src: el.getAttribute('src'), width: Math.round(r.width), height: Math.round(r.height) };
      })
    );
    const bgUrls = [];
    (function collect(n) {
      if (n && n._bgUrl) bgUrls.push(n._bgUrl);
      if (n && n.children) for (const c of n.children) collect(c);
    })(spec);

    const iframeShotPromises = iframeMeta.map(async (m, i) => {
      if (!m.src || !m.width || !m.height) return [i, null];
      try {
        const absUrl = new URL(m.src, url).href;
        // Delegate to the known-working screenshotUrl path. The previous
        // hand-rolled iframe screenshot loop was returning 1×1 transparent
        // pixels — probably because the page had not finished JS-rendering
        // before the screenshot fired. screenshotUrl uses a longer settle
        // and the proven full-page capture path.
        const b64 = await screenshotUrl(absUrl, { width: m.width, height: m.height, fullPage: false, settleMs: 2500 });
        return [i, b64];
      } catch (e) { return [i, null]; }
    });
    const bgFetchPromises = bgUrls.map(async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) return [u, null];
        const ct = r.headers.get("content-type") || "image/png";
        if (!/^image\//i.test(ct)) return [u, null];
        const ab = await r.arrayBuffer();
        return [u, `data:${ct};base64,` + Buffer.from(ab).toString("base64")];
      } catch (e) { return [u, null]; }
    });

    const [iframePairs, bgPairs] = await Promise.all([
      Promise.all(iframeShotPromises),
      Promise.all(bgFetchPromises),
    ]);
    const shots = Object.fromEntries(iframePairs.filter(([, v]) => v != null));
    const bytesByUrl = Object.fromEntries(bgPairs.filter(([, v]) => v != null));

    (function walk(n) {
      if (n && n.type === "rect" && typeof n._iframeIdx === "number" && shots[n._iframeIdx]) {
        n._imageBytes = "data:image/png;base64," + shots[n._iframeIdx];
      }
      if (n && n._bgUrl && bytesByUrl[n._bgUrl] && !n._imageBytes) {
        n._imageBytes = bytesByUrl[n._bgUrl];
      }
      if (n && n.children) for (const c of n.children) walk(c);
    })(spec);
    await normalizeSpecMedia(spec);

    // Source-aware enrichment: if the agent passes a sourceDir (the
    // GitHub repo serving the URL), read tokens.json / :root css vars
    // and merge into the spec so the Figma file gets the authored
    // design-system intent, not just computed values.
    if (opts.sourceDir) {
      try {
        const ctx = await readSourceContext(opts.sourceDir);
        if (ctx.cssVars && Object.keys(ctx.cssVars).length) {
          spec._cssVariables = Object.assign({}, spec._cssVariables || {}, ctx.cssVars);
        }
        if (ctx.tokens) spec._sourceTokens = ctx.tokens;
      } catch (e) { /* non-fatal */ }
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

/**
 * Render URL and audit its CSS-feature usage. Returns counts of every
 * "is this thing on this page?" question that drives fidelity decisions:
 * tag mix, layout strategies, color palette, fonts, effects, etc.
 *
 * Use this before bigger fidelity pushes — tells us where the actual
 * coverage gaps are vs speculation.
 */
export async function fingerprintUrl(url, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || 900;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1500));
    return await page.evaluate(() => {
      const tags = {};
      const displays = {};
      const positions = {};
      const colors = new Set();
      const fonts = new Set();
      const features = {
        flexbox: 0, grid: 0,
        gradients: 0, bgImages: 0, multiBg: 0,
        shadows: 0, textShadows: 0, filters: 0,
        backdropFilters: 0, blendModes: 0, opacityLT1: 0,
        transforms: 0, animations: 0, transitions: 0,
        borderRadius: 0, borders: 0, outlines: 0,
        objectFit: 0, aspectRatio: 0, clipPath: 0, maskImage: 0,
        zIndex: 0, sticky: 0, fixed: 0, absolute: 0,
        pseudos: 0, iframes: 0, svgs: 0, imgs: 0, videos: 0,
      };
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const tag = el.tagName.toLowerCase();
        tags[tag] = (tags[tag] || 0) + 1;
        const cs = getComputedStyle(el);
        displays[cs.display] = (displays[cs.display] || 0) + 1;
        positions[cs.position] = (positions[cs.position] || 0) + 1;
        if (cs.color && cs.color !== 'rgba(0, 0, 0, 0)') colors.add(cs.color);
        if (cs.fontFamily) fonts.add(cs.fontFamily.split(',')[0].replace(/['"]/g, '').trim());
        if (cs.display.includes('flex')) features.flexbox++;
        if (cs.display.includes('grid')) features.grid++;
        if (cs.backgroundImage && cs.backgroundImage !== 'none') {
          features.bgImages++;
          if (cs.backgroundImage.includes('gradient')) features.gradients++;
          if (cs.backgroundImage.split(',').length > 1) features.multiBg++;
        }
        if (cs.boxShadow && cs.boxShadow !== 'none') features.shadows++;
        if (cs.textShadow && cs.textShadow !== 'none') features.textShadows++;
        if (cs.filter && cs.filter !== 'none') features.filters++;
        if (cs.backdropFilter && cs.backdropFilter !== 'none') features.backdropFilters++;
        if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') features.blendModes++;
        const op = parseFloat(cs.opacity);
        if (op > 0 && op < 1) features.opacityLT1++;
        if (cs.transform && cs.transform !== 'none') features.transforms++;
        if (cs.animationName && cs.animationName !== 'none') features.animations++;
        if (cs.transitionDuration && cs.transitionDuration !== '0s') features.transitions++;
        if (parseFloat(cs.borderTopLeftRadius) > 0) features.borderRadius++;
        if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== 'none') features.borders++;
        if (parseFloat(cs.outlineWidth) > 0 && cs.outlineStyle !== 'none') features.outlines++;
        if (cs.objectFit && cs.objectFit !== 'fill') features.objectFit++;
        if (cs.aspectRatio && cs.aspectRatio !== 'auto') features.aspectRatio++;
        if (cs.clipPath && cs.clipPath !== 'none') features.clipPath++;
        if (cs.maskImage && cs.maskImage !== 'none') features.maskImage++;
        const z = parseInt(cs.zIndex, 10);
        if (isFinite(z) && z !== 0) features.zIndex++;
        if (cs.position === 'sticky') features.sticky++;
        if (cs.position === 'fixed') features.fixed++;
        if (cs.position === 'absolute') features.absolute++;
        for (const side of ['::before', '::after']) {
          const ps = getComputedStyle(el, side);
          if (ps.content && ps.content !== 'none' && ps.content !== 'normal') features.pseudos++;
        }
      }
      features.iframes = document.querySelectorAll('iframe').length;
      features.svgs    = document.querySelectorAll('svg').length;
      features.imgs    = document.querySelectorAll('img').length;
      features.videos  = document.querySelectorAll('video').length;
      // @media breakpoint discovery: scan every loaded stylesheet for
      // @media rules with min-width / max-width and surface the px values.
      // Tells the agent "you should capture this site at widths X, Y, Z".
      const breakpoints = new Set();
      try {
        for (const sheet of document.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch (e) { continue; } // CORS
          if (!rules) continue;
          for (const rule of rules) {
            if (rule.type === CSSRule.MEDIA_RULE) {
              const t = rule.conditionText || rule.media.mediaText || '';
              for (const m of t.matchAll(/(min|max)-width:\s*(\d+)px/g)) breakpoints.add(parseInt(m[2], 10));
            }
          }
        }
      } catch (e) {}
      const bps = Array.from(breakpoints).sort((a, b) => a - b);
      // Top N tags
      const topTags = Object.entries(tags).sort((a,b) => b[1]-a[1]).slice(0, 12);
      return {
        url: location.href,
        title: document.title,
        totalElements: all.length,
        topTags: Object.fromEntries(topTags),
        displays,
        positions,
        features,
        breakpoints: bps,
        colors: Array.from(colors).slice(0, 30),
        fonts: Array.from(fonts),
      };
    });
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Discover hover/focus-capable elements on a page. This is the first step
 * toward generated prototype variants: before generating Figma
 * component variants, tell the agent which elements actually change state.
 */
export async function auditInteractions(url, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || 900;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1200));
    return await page.evaluate(() => {
      const interactiveSelector = [
        "a[href]",
        "button",
        "input",
        "select",
        "textarea",
        "[role=button]",
        "[tabindex]",
        "[onclick]",
        "[data-hover]",
        "[data-state]"
      ].join(",");
      const styleSheets = Array.from(document.styleSheets);
      const hoverSelectors = [];
      const focusSelectors = [];
      for (const sheet of styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch (e) { continue; }
        if (!rules) continue;
        const stack = Array.from(rules);
        while (stack.length) {
          const rule = stack.shift();
          if (rule.cssRules) {
            stack.push(...Array.from(rule.cssRules));
            continue;
          }
          const sel = rule.selectorText || "";
          if (!sel) continue;
          if (sel.includes(":hover")) hoverSelectors.push(sel);
          if (sel.includes(":focus")) focusSelectors.push(sel);
        }
      }
      for (const style of Array.from(document.querySelectorAll("style"))) {
        const text = style.textContent || "";
        for (const m of text.matchAll(/([^{}]+):hover[^{}]*\{/g)) hoverSelectors.push(m[1].trim() + ":hover");
        for (const m of text.matchAll(/([^{}]+):focus[^{}]*\{/g)) focusSelectors.push(m[1].trim() + ":focus");
      }
      const elements = Array.from(document.querySelectorAll(interactiveSelector)).slice(0, 100).map((el, index) => {
        const rect = el.getBoundingClientRect();
        const text = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
        const cs = getComputedStyle(el);
        return {
          index,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || null,
          type: el.getAttribute("type") || null,
          text: text.slice(0, 80),
          href: el.getAttribute("href") || null,
          className: String(el.className || "").slice(0, 120),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          cursor: cs.cursor,
          transition: cs.transitionDuration && cs.transitionDuration !== "0s" ? cs.transitionDuration : null,
        };
      });
      return {
        ok: true,
        url: location.href,
        title: document.title,
        interactiveCount: elements.length,
        elements,
        css: {
          hoverSelectorCount: hoverSelectors.length,
          focusSelectorCount: focusSelectors.length,
          hoverSelectors: hoverSelectors.slice(0, 30),
          focusSelectors: focusSelectors.slice(0, 30),
        }
      };
    });
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Preflight a URL for the common failure modes users report in website
 * to Figma importers: bot-protection pages, missing fonts, low-res
 * images, SVG-heavy pages, deep wrapper nesting / auto-layout noise,
 * and full-page capture surprises.
 */
export async function preflightImport(url, opts = {}) {
  const width = opts.width || 1280;
  const height = opts.height || 900;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1500));
    return await page.evaluate((status, viewportWidth, viewportHeight) => {
      const text = (document.body && document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 5000);
      const lower = text.toLowerCase();
      const botSignals = [
        "captcha", "verify you are human", "human verification", "checking your browser",
        "cloudflare", "access denied", "unusual traffic", "bot protection"
      ].filter(s => lower.includes(s));
      const fonts = {};
      const maxDepth = { value: 0 };
      function depth(el, d) {
        if (!el || !el.children) return;
        if (d > maxDepth.value) maxDepth.value = d;
        for (const child of el.children) depth(child, d + 1);
      }
      depth(document.body, 1);
      for (const el of document.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        const fam = (cs.fontFamily || "").split(",")[0].replace(/['"]/g, "").trim();
        if (fam) fonts[fam] = (fonts[fam] || 0) + 1;
      }
      const images = Array.from(document.images).map((img) => {
        const r = img.getBoundingClientRect();
        const renderedW = Math.round(r.width);
        const renderedH = Math.round(r.height);
        const naturalW = img.naturalWidth || 0;
        const naturalH = img.naturalHeight || 0;
        const ratio = renderedW && renderedH && naturalW && naturalH
          ? Math.min(naturalW / renderedW, naturalH / renderedH)
          : null;
        return {
          src: img.currentSrc || img.src || "",
          alt: img.alt || "",
          rendered: { width: renderedW, height: renderedH },
          natural: { width: naturalW, height: naturalH },
          scaleRatio: ratio == null ? null : Math.round(ratio * 100) / 100,
        };
      });
      const lowResImages = images.filter(img => img.scaleRatio != null && img.scaleRatio < 1.5 && img.rendered.width > 32 && img.rendered.height > 32);
      const largeImages = images.filter(img => img.natural.width >= 1600 || img.natural.height >= 1600);
      const fontFaces = [];
      const fontDownloadUrls = new Set();
      function absolutizeFontUrl(raw) {
        if (!raw) return null;
        try { return new URL(raw, document.baseURI).href; }
        catch { return raw; }
      }
      function collectFontFaceRule(rule) {
        if (!rule || !rule.style) return;
        const family = (rule.style.getPropertyValue("font-family") || "").replace(/['"]/g, "").trim();
        const weight = (rule.style.getPropertyValue("font-weight") || "").trim();
        const style = (rule.style.getPropertyValue("font-style") || "").trim();
        const src = rule.style.getPropertyValue("src") || "";
        const urls = [];
        for (const m of src.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
          const abs = absolutizeFontUrl(m[2]);
          if (abs) {
            urls.push(abs);
            fontDownloadUrls.add(abs);
          }
        }
        if (family || urls.length) fontFaces.push({ family, weight, style, urls });
      }
      function walkRules(rules) {
        if (!rules) return;
        for (const rule of Array.from(rules)) {
          try {
            if (rule.type === CSSRule.FONT_FACE_RULE) collectFontFaceRule(rule);
            if (rule.cssRules) walkRules(rule.cssRules);
          } catch {}
        }
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try { walkRules(sheet.cssRules); } catch {}
      }
      for (const style of Array.from(document.querySelectorAll("style"))) {
        const textCss = style.textContent || "";
        for (const block of textCss.matchAll(/@font-face\s*\{([\s\S]*?)\}/gi)) {
          const body = block[1] || "";
          const familyMatch = body.match(/font-family\s*:\s*([^;]+)/i);
          const weightMatch = body.match(/font-weight\s*:\s*([^;]+)/i);
          const styleMatch = body.match(/font-style\s*:\s*([^;]+)/i);
          const urls = [];
          for (const m of body.matchAll(/url\((['"]?)(.*?)\1\)/g)) {
            const abs = absolutizeFontUrl(m[2]);
            if (abs) {
              urls.push(abs);
              fontDownloadUrls.add(abs);
            }
          }
          if (familyMatch || urls.length) {
            fontFaces.push({
              family: familyMatch ? familyMatch[1].replace(/['"]/g, "").trim() : "",
              weight: weightMatch ? weightMatch[1].trim() : "",
              style: styleMatch ? styleMatch[1].trim() : "",
              urls,
            });
          }
        }
      }
      const svgs = document.querySelectorAll("svg").length;
      const inlineSvgWithImages = Array.from(document.querySelectorAll("svg image")).length;
      const pageW = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
      const pageH = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      const issues = [];
      if (status && status >= 400) issues.push({ severity: "error", type: "http-status", message: `HTTP status ${status}` });
      if (botSignals.length) issues.push({ severity: "error", type: "bot-protection", message: `Possible bot-protection page: ${botSignals.join(", ")}` });
      if (Object.keys(fonts).length > 6) issues.push({ severity: "warn", type: "many-fonts", message: `${Object.keys(fonts).length} font families detected; verify local Figma availability.` });
      if (fontDownloadUrls.size) issues.push({ severity: "info", type: "font-downloads", message: `${fontDownloadUrls.size} downloadable font asset(s) detected; review font download URLs and install missing families before import.` });
      if (lowResImages.length) issues.push({ severity: "warn", type: "low-res-images", message: `${lowResImages.length} image(s) may import soft; prefer high-res sources.` });
      if (svgs) issues.push({ severity: "info", type: "svg-heavy", message: `${svgs} inline SVG(s) detected; verify vector/image handling after import.` });
      if (maxDepth.value > 18) issues.push({ severity: "warn", type: "deep-dom", message: `DOM depth ${maxDepth.value}; expect nested layer/auto-layout noise.` });
      if (pageW > viewportWidth + 2) issues.push({ severity: "warn", type: "horizontal-scroll", message: `Page width ${pageW}px exceeds viewport ${viewportWidth}px.` });
      if (pageH > 30000) issues.push({ severity: "warn", type: "very-tall-page", message: `Page height ${pageH}px may be slow to import/export.` });
      return {
        ok: !issues.some(i => i.severity === "error"),
        url: location.href,
        title: document.title,
        status: status || null,
        viewport: { width: viewportWidth, height: viewportHeight },
        page: { width: pageW, height: pageH, maxDomDepth: maxDepth.value },
        fonts: Object.entries(fonts).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([family, count]) => ({ family, count })),
        fontFaces: fontFaces.slice(0, 60),
        fontDownloads: Array.from(fontDownloadUrls).slice(0, 60),
        images: { count: images.length, lowResCount: lowResImages.length, largeSourceCount: largeImages.length, lowRes: lowResImages.slice(0, 10) },
        svgs: { count: svgs, imageTagsInsideSvg: inlineSvgWithImages },
        botSignals,
        issues,
      };
    }, response && response.status ? response.status() : null, width, height);
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Verify that every visible text string from the live page also exists in
 * a freshly-extracted spec. Returns { matched, missing[], extra[] } — a
 * fast-feedback signal that the extractor didn't drop content.
 */
export async function verifyTextFidelity(url, spec, opts = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  let liveText = new Set();
  try {
    await page.setViewport({ width: opts.width || 1280, height: opts.height || 900, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1500));
    liveText = new Set(await page.evaluate(() => {
      const out = new Set();
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      function isVisibleTextNode(node) {
        const el = node.parentElement;
        if (!el) return false;
        let cur = el;
        while (cur && cur.nodeType === 1) {
          const cs = getComputedStyle(cur);
          if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse" || cs.opacity === "0") return false;
          cur = cur.parentElement;
        }
        const range = document.createRange();
        try {
          range.selectNodeContents(node);
          for (const r of Array.from(range.getClientRects())) {
            if (r.width > 0 && r.height > 0) return true;
          }
        } finally {
          range.detach();
        }
        return false;
      }
      while ((n = walker.nextNode())) {
        if (!isVisibleTextNode(n)) continue;
        const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 3) out.add(t);
      }
      return Array.from(out);
    }));
  } finally {
    try { await page.close(); } catch {}
  }
  const specText = new Set();
  (function walk(n) {
    if (n && n.type === 'text' && n.characters) {
      const t = n.characters.replace(/\s+/g, ' ').trim();
      if (t.length >= 3) specText.add(t);
    }
    if (n && n.children) for (const c of n.children) walk(c);
  })(spec);
  const missing = [];
  for (const t of liveText) {
    if (specText.has(t)) continue;
    // Allow partial: if any specText contains this t, ok.
    let found = false;
    for (const s of specText) if (s.includes(t) || t.includes(s)) { found = true; break; }
    if (!found) missing.push(t);
  }
  return {
    liveCount: liveText.size,
    specCount: specText.size,
    missing: missing.slice(0, 20),
    matchedPct: Math.round((1 - missing.length / Math.max(liveText.size, 1)) * 100),
  };
}

/**
 * Phase 6 fidelity measurement: capture the live URL + the Figma export
 * at matching dimensions, compute a pixel-similarity score and per-region
 * error rectangles. The first signal we've had that's NOT eyeballed.
 *
 * Returns:
 *   { score: 0-100,        // higher = more similar
 *     diffPercent: 0-1,    // fraction of pixels mismatched
 *     pixelsDiff: N,
 *     dimensions: { w, h },
 *     regions: [{x,y,w,h,errorPct}]  // top regions sorted by error
 *   }
 */
export async function measureFidelity(url, figmaPng, opts = {}) {
  const width = opts.width || 1280;
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: opts.height || 900, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1500));
    const livePng = await page.screenshot({ type: "png", fullPage: true });
    return await diffPngs(livePng, figmaPng);
  } finally {
    try { await page.close(); } catch {}
  }
}

// Use pngjs + pixelmatch to compute a similarity score + diff regions.
async function diffPngs(pngA, pngB) {
  const { PNG } = await import("pngjs");
  const pixelmatch = (await import("pixelmatch")).default;
  const a = PNG.sync.read(Buffer.isBuffer(pngA) ? pngA : Buffer.from(pngA));
  let b = PNG.sync.read(Buffer.isBuffer(pngB) ? pngB : Buffer.from(pngB));
  // Resize b to match a if dimensions differ (Figma exports may be 2x,
  // or pages can shift height between extraction and measurement).
  if (a.width !== b.width || a.height !== b.height) {
    // Use sharp if present; otherwise fall back to a tiny nearest-neighbor
    // resizer so fidelity measurement still returns a useful score.
    try {
      const sharp = (await import("sharp")).default;
      const buf = await sharp(Buffer.isBuffer(pngB) ? pngB : Buffer.from(pngB))
        .resize(a.width, a.height, { fit: "fill" }).png().toBuffer();
      b = PNG.sync.read(buf);
    } catch (e) {
      b = resizePngNearest(PNG, b, a.width, a.height);
    }
  }
  const diff = new PNG({ width: a.width, height: a.height });
  const totalPixels = a.width * a.height;
  const pixelsDiff = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const diffPercent = pixelsDiff / totalPixels;
  // Bucket diff pixels into a coarse grid to find error hotspots.
  const cols = 16, rows = 32;
  const cellW = Math.ceil(a.width / cols), cellH = Math.ceil(a.height / rows);
  const buckets = Array.from({ length: rows }, () => new Array(cols).fill(0));
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const idx = (y * a.width + x) * 4;
      // diff image has red pixels for mismatches
      if (diff.data[idx] === 255 && diff.data[idx + 1] === 0) {
        buckets[Math.floor(y / cellH)][Math.floor(x / cellW)]++;
      }
    }
  }
  const regions = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const cellPx = cellW * cellH;
    const errorPct = buckets[r][c] / cellPx;
    if (errorPct > 0.05) regions.push({ x: c * cellW, y: r * cellH, w: cellW, h: cellH, errorPct: Math.round(errorPct * 1000) / 1000 });
  }
  regions.sort((x, y) => y.errorPct - x.errorPct);
  return {
    ok: true,
    score: Math.round((1 - diffPercent) * 1000) / 10,
    diffPercent: Math.round(diffPercent * 1000) / 1000,
    pixelsDiff,
    dimensions: { w: a.width, h: a.height },
    regions: regions.slice(0, 10),
  };
}

function compareSets(a, b, limit = 30) {
  const aa = new Set(a || []);
  const bb = new Set(b || []);
  const missing = [];
  const added = [];
  for (const x of aa) {
    if (!bb.has(x)) missing.push(x);
    if (missing.length >= limit) break;
  }
  for (const x of bb) {
    if (!aa.has(x)) added.push(x);
    if (added.length >= limit) break;
  }
  return { missing, added, missingCount: [...aa].filter(x => !bb.has(x)).length, addedCount: [...bb].filter(x => !aa.has(x)).length };
}

function featureDrift(base, candidate) {
  const out = [];
  const a = base && base.features || {};
  const b = candidate && candidate.features || {};
  const keys = Array.from(new Set(Object.keys(a).concat(Object.keys(b)))).sort();
  for (const key of keys) {
    const before = Number(a[key] || 0);
    const after = Number(b[key] || 0);
    if (before === after) continue;
    out.push({ feature: key, before, after, delta: after - before });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta)).slice(0, 20);
}

function mobileSummaryDelta(base, candidate) {
  const a = base && base.summary || {};
  const b = candidate && candidate.summary || {};
  return {
    totalIssues: (b.totalIssues || 0) - (a.totalIssues || 0),
    overflowXCount: (b.overflowXCount || 0) - (a.overflowXCount || 0),
    tinyTouchTargetCount: (b.tinyTouchTargetCount || 0) - (a.tinyTouchTargetCount || 0),
    tinyTextCount: (b.tinyTextCount || 0) - (a.tinyTextCount || 0),
    fixedTrapCount: (b.fixedTrapCount || 0) - (a.fixedTrapCount || 0),
    horizontalScrollViewports: compareSets(a.horizontalScrollViewports || [], b.horizontalScrollViewports || [], 10),
  };
}

async function captureRegressionPage(url, width, opts = {}) {
  const height = opts.height || (width >= 1024 ? 900 : (width >= 600 ? 1024 : 812));
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs || 30000 });
    await new Promise(r => setTimeout(r, opts.settleMs || 1200));
    const screenshot = await page.screenshot({ fullPage: true, type: "png" });
    const metrics = await page.evaluate(() => {
      function visibleTextScript() {
        return Array.from(document.querySelectorAll("body *"))
          .filter(el => {
            const cs = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
          })
          .map(el => (el.textContent || "").replace(/\s+/g, " ").trim())
          .filter(t => t.length >= 3 && t.length <= 160);
      }
      const doc = document.documentElement;
      const body = document.body;
      return {
        title: document.title,
        url: location.href,
        width: Math.max(doc.scrollWidth, body ? body.scrollWidth : 0),
        height: Math.max(doc.scrollHeight, body ? body.scrollHeight : 0),
        text: visibleTextScript(),
      };
    });
    return { status: response && response.status ? response.status() : null, screenshot, metrics };
  } finally {
    try { await page.close(); } catch {}
  }
}

/**
 * Compare a baseline URL and candidate URL to find frontend/UI regressions.
 * This is intentionally deterministic: screenshot pixel diff, visible-text
 * changes, responsive issue deltas, and CSS-feature drift. Agents can layer
 * product judgment on top, but the measurements themselves are stable.
 */
export async function auditRegression(baselineUrl, candidateUrl, opts = {}) {
  const widths = opts.widths && opts.widths.length ? opts.widths : [1280, 768, 375];
  const minScore = opts.minScore == null ? 96 : Number(opts.minScore);
  const maxNewResponsiveIssues = opts.maxNewResponsiveIssues == null ? 0 : Number(opts.maxNewResponsiveIssues);
  const maxMissingText = opts.maxMissingText == null ? 0 : Number(opts.maxMissingText);
  const settleMs = opts.settleMs || 1200;
  const visual = [];
  const text = [];
  const issues = [];

  for (const width of widths) {
    const [base, candidate] = await Promise.all([
      captureRegressionPage(baselineUrl, width, { settleMs }),
      captureRegressionPage(candidateUrl, width, { settleMs }),
    ]);
    const diff = await diffPngs(base.screenshot, candidate.screenshot);
    const textDelta = compareSets(base.metrics.text, candidate.metrics.text);
    const heightDelta = Math.round((candidate.metrics.height || 0) - (base.metrics.height || 0));
    const widthDelta = Math.round((candidate.metrics.width || 0) - (base.metrics.width || 0));
    visual.push({
      width,
      score: diff.score,
      diffPercent: diff.diffPercent,
      pixelsDiff: diff.pixelsDiff,
      dimensions: diff.dimensions,
      regions: diff.regions,
      pageSizeDelta: { width: widthDelta, height: heightDelta },
    });
    text.push({ width, ...textDelta });
    if (diff.score < minScore) {
      issues.push({ severity: "warn", type: "visual-diff", width, message: `Visual score ${diff.score} is below ${minScore}.`, regions: diff.regions.slice(0, 5) });
    }
    if (textDelta.missingCount > maxMissingText) {
      issues.push({ severity: "error", type: "missing-text", width, message: `${textDelta.missingCount} visible text string(s) disappeared.`, missing: textDelta.missing.slice(0, 10) });
    }
    if (Math.abs(heightDelta) > 400) {
      issues.push({ severity: "info", type: "page-height-change", width, message: `Page height changed by ${heightDelta}px.` });
    }
    if (candidate.status && candidate.status >= 400) {
      issues.push({ severity: "error", type: "candidate-http-status", width, message: `Candidate returned HTTP ${candidate.status}.` });
    }
  }

  const viewports = widths.map(width => ({
    name: String(width),
    width,
    height: width >= 1024 ? 900 : (width >= 600 ? 1024 : 812),
  }));
  const [baselineMobile, candidateMobile, baselineFingerprint, candidateFingerprint] = await Promise.all([
    auditMobile(baselineUrl, { viewports, settleMs }),
    auditMobile(candidateUrl, { viewports, settleMs }),
    fingerprintUrl(baselineUrl, { width: Math.max(...widths), settleMs }),
    fingerprintUrl(candidateUrl, { width: Math.max(...widths), settleMs }),
  ]);
  const responsiveDelta = mobileSummaryDelta(baselineMobile, candidateMobile);
  if (responsiveDelta.totalIssues > maxNewResponsiveIssues) {
    issues.push({ severity: "error", type: "responsive-regression", message: `${responsiveDelta.totalIssues} new responsive issue(s).`, delta: responsiveDelta });
  }

  const drift = featureDrift(baselineFingerprint, candidateFingerprint);
  const errors = issues.filter(i => i.severity === "error").length;
  const warns = issues.filter(i => i.severity === "warn").length;
  return {
    ok: errors === 0,
    baselineUrl,
    candidateUrl,
    thresholds: { minScore, maxNewResponsiveIssues, maxMissingText },
    summary: {
      errors,
      warnings: warns,
      worstVisualScore: visual.reduce((min, v) => Math.min(min, v.score), 100),
      newResponsiveIssues: responsiveDelta.totalIssues,
      missingTextCount: text.reduce((n, t) => n + t.missingCount, 0),
    },
    visual,
    text,
    responsive: { baseline: baselineMobile.summary, candidate: candidateMobile.summary, delta: responsiveDelta },
    featureDrift: drift,
    issues,
  };
}

/**
 * Closed visual-diff loop: render an HTML mockup and the running app, then
 * report (a) per-viewport pixel similarity + hotspot regions ("where") and
 * (b) a structured, categorized punch-list of field-level differences from
 * a spec-vs-spec diff ("what exactly"). This is the grounded feedback signal
 * an agent iterates against to make the app match the mockup — the missing
 * piece that turns blind retries into a convergent refine loop.
 *
 * Both inputs are URLs: serve the mockup over file:// or a local static
 * server, and point appUrl at the dev build. The mockup is the ground truth.
 *
 * @param {string} mockupUrl  URL of the target HTML mockup (ground truth).
 * @param {string} appUrl     URL of the running app to bring into alignment.
 * @param {object} [opts]     { widths, minScore, outDir, prefix, settleMs,
 *                              specWidth, rootSelector, maxDeltas, componentMap }
 */
export async function matchMockup(mockupUrl, appUrl, opts = {}) {
  const widths = opts.widths && opts.widths.length ? opts.widths : [1280, 768, 375];
  const minScore = opts.minScore == null ? 96 : Number(opts.minScore);
  const settleMs = opts.settleMs || 1200;
  const outDir = opts.outDir || "/tmp";
  const prefix = opts.prefix || "match";
  const specWidth = opts.specWidth || Math.max(...widths);
  const componentMap = opts.componentMap || null; // { sigOrName: { file } } override

  // Codebase awareness: index the app source so each punch-list item can name
  // the file to edit and the token a literal should become.
  let sourceIndex = null;
  if (opts.sourceDir) {
    try { sourceIndex = await buildSourceIndex(opts.sourceDir); } catch (e) { sourceIndex = null; }
  }

  await mkdir(outDir, { recursive: true }).catch(() => {});

  // ── Pixel layer: screenshot both at each viewport, diff, write PNGs ──
  const visual = [];
  for (const width of widths) {
    const [mock, app] = await Promise.all([
      captureRegressionPage(mockupUrl, width, { settleMs }),
      captureRegressionPage(appUrl, width, { settleMs }),
    ]);
    const diff = await diffPngs(mock.screenshot, app.screenshot);
    const mockPath = path.join(outDir, `${prefix}-${width}-mockup.png`);
    const appPath = path.join(outDir, `${prefix}-${width}-app.png`);
    await writeFile(mockPath, mock.screenshot).catch(() => {});
    await writeFile(appPath, app.screenshot).catch(() => {});
    // Perceptual SSIM (filters AA/shift noise) + legible diff artifacts the
    // agent can Read(): onion-skin overlay, side-by-side montage, boxed regions.
    let ssimScore = null, artifacts = {};
    try { ssimScore = await ssim(mock.screenshot, app.screenshot); } catch (e) {}
    try { artifacts = await annotateDiff({ mockPng: mock.screenshot, appPng: app.screenshot, regions: diff.regions, outDir, prefix: `${prefix}-${width}` }); } catch (e) {}
    visual.push({
      width,
      score: diff.score,
      ssim: ssimScore,
      diffPercent: diff.diffPercent,
      regions: diff.regions,
      pageSizeDelta: {
        width: Math.round((app.metrics.width || 0) - (mock.metrics.width || 0)),
        height: Math.round((app.metrics.height || 0) - (mock.metrics.height || 0)),
      },
      mockupPng: mockPath,
      appPng: appPath,
      overlayPng: artifacts.overlay || null,
      montagePng: artifacts.montage || null,
      boxedPng: artifacts.boxed || null,
    });
  }

  // ── Structured layer: spec-vs-spec diff at the primary width ──
  let punchList = [];
  let specSummary = null;
  let specError = null;
  let styleGap = null;
  let layoutGap = null;
  try {
    const [mockSpec, appSpec] = await Promise.all([
      urlToSpec(mockupUrl, { width: specWidth, rootSelector: opts.rootSelector, embedImages: false, settleMs }),
      urlToSpec(appUrl, { width: specWidth, rootSelector: opts.rootSelector, embedImages: false, settleMs }),
    ]);
    // Design-language fingerprint: does the app reproduce the mockup's *style*
    // (gradients, glow, glass blur), not just its copy/colour/spacing?
    styleGap = compareStyleProfiles(styleProfile(mockSpec), styleProfile(appSpec));
    // Mathematical structure: grid columns / pitch / alignment / spacing-unit
    // deltas — numbers the agent acts on directly.
    try { layoutGap = diffLayoutMetrics(layoutMetrics(mockSpec), layoutMetrics(appSpec)); } catch (e) {}
    const sd = diffSpecs(mockSpec, appSpec, { labelA: "mockup", labelB: "app", maxDeltas: opts.maxDeltas || 300 });
    specSummary = sd.summary;
    punchList = sd.deltas.map((d) => {
      const out = { ...d };
      // explicit override map first, then the auto-built source index
      if (componentMap) {
        const hit = componentMap[d.name] || componentMap[(d.name || "").replace(/^[.#]/, "")];
        if (hit && hit.file) { out.sourceFile = hit.file; out.via = "componentMap"; }
      }
      if (!out.sourceFile && sourceIndex) {
        const src = resolveSource(d, sourceIndex);
        if (src) { out.sourceFile = src.file; if (src.line) out.sourceLine = src.line; out.via = src.via; }
      }
      if (sourceIndex) {
        const th = tokenHint(d, sourceIndex);
        if (th) out.tokenHint = `${th.token} (= ${th.value})`;
      }
      return out;
    });
  } catch (e) {
    specError = e.message;
  }

  const worstVisualScore = visual.reduce((min, v) => Math.min(min, v.score), 100);
  const ssimVals = visual.map((v) => v.ssim).filter((s) => s != null);
  const worstSsim = ssimVals.length ? Math.min(...ssimVals) : null;
  const pass = worstVisualScore >= minScore && punchList.length === 0;
  const mappedCount = punchList.filter((d) => d.sourceFile).length;
  const source = sourceIndex
    ? { sourceDir: opts.sourceDir, fileCount: sourceIndex.fileCount, testids: Object.keys(sourceIndex.byTestid).length, tokens: Object.keys(sourceIndex.tokens.nameToVal).length, mappedDeltas: mappedCount }
    : null;

  return {
    ok: true,
    pass,
    mockupUrl,
    appUrl,
    threshold: { minScore },
    summary: {
      worstVisualScore,
      worstSsim,
      visualPass: worstVisualScore >= minScore,
      punchListItems: punchList.length,
      byKind: specSummary ? specSummary.byKind : null,
      high: specSummary ? specSummary.high : null,
      mappedToSource: source ? mappedCount : null,
    },
    visual,
    punchList,
    specSummary,
    specError,
    styleGap,
    layoutGap,
    source,
    // Tell the agent exactly what to do next — this is the loop instruction.
    nextAction: pass
      ? "MATCH. Worst visual score ≥ threshold and punch-list empty. Done."
      : `NOT a match yet. Read visual[].montagePng (mockup | app | overlay onion-skin) and boxedPng to SEE the drift, then fix the highest-severity punchList items (copy/color/structure first) — each item names its sourceFile to edit${source ? "" : " (pass sourceDir to resolve files automatically)"}, and tokenHint when a literal should become a design token. Rebuild, then call match_mockup again. Repeat until pass=true (worst visual score ≥ ${minScore} AND punchList empty).`,
  };
}

/**
 * Diff two image FILES (any PNGs — Figma exports, mockup screenshots, etc.):
 * raw-pixel score + perceptual SSIM + hotspot regions, and write the three
 * legible artifacts (overlay / montage / boxed). The general-purpose,
 * ImageMagick-style image comparator.
 */
export async function diffImages(pathA, pathB, opts = {}) {
  const a = await readFile(pathA), b = await readFile(pathB);
  const diff = await diffPngs(a, b);
  let ssimScore = null, artifacts = {};
  try { ssimScore = await ssim(a, b); } catch (e) {}
  const outDir = opts.outDir || "/tmp", prefix = opts.prefix || "imgdiff";
  try { artifacts = await annotateDiff({ mockPng: a, appPng: b, regions: diff.regions, outDir, prefix }); } catch (e) {}
  return {
    ok: true, score: diff.score, ssim: ssimScore, diffPercent: diff.diffPercent,
    dimensions: diff.dimensions, regions: diff.regions,
    overlay: artifacts.overlay || null, montage: artifacts.montage || null, boxed: artifacts.boxed || null,
  };
}

/**
 * Mathematical layout metrics for one URL — inferred grid (columns / rows /
 * pitch / gutter), alignment lines, spacing base-unit + scale, repeated-
 * component groups, and an XY-cut block segmentation. Numbers, not pixels.
 */
export async function measureLayout(url, opts = {}) {
  const spec = await urlToSpec(url, { width: opts.width || 1280, rootSelector: opts.rootSelector, embedImages: false, settleMs: opts.settleMs });
  return layoutMetrics(spec);
}

/**
 * Demarcate components visually + numerically: returns the layout metrics AND
 * writes a PNG with each repeated-component group boxed in its own colour and
 * the inferred grid columns drawn as lines.
 */
export async function demarcate(url, opts = {}) {
  const width = opts.width || 1280;
  const [png, spec] = await Promise.all([
    screenshotUrl(url, { width, fullPage: true, settleMs: opts.settleMs }),
    urlToSpec(url, { width, rootSelector: opts.rootSelector, embedImages: false, settleMs: opts.settleMs }),
  ]);
  const metrics = layoutMetrics(spec);
  const boxes = demarcationBoxes(spec);
  const outDir = opts.outDir || "/tmp", prefix = opts.prefix || "demarcate";
  const outPath = path.join(outDir, `${prefix}.png`);
  let demarcationPng = null;
  try { demarcationPng = await demarcatePng({ basePng: png, boxes, outPath }); } catch (e) {}
  return { ok: true, metrics, componentBoxes: boxes.length, demarcationPng };
}

function resizePngNearest(PNG, src, width, height) {
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * src.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * src.width / width));
      const si = (sy * src.width + sx) * 4;
      const di = (y * width + x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/** Render URL and return a base64 PNG screenshot (full page). */
/**
 * Audit how a URL behaves across mobile / tablet / desktop viewports.
 * For each viewport: loads the page, then in-page measures:
 *  - horizontal page scroll (body wider than viewport — classic "broken mobile")
 *  - elements overflowing their parents on the x-axis
 *  - elements whose computed touch target (button / a / input) is smaller than 44×44 (Fitts)
 *  - elements with `position:fixed` taller than 50% of the viewport (mobile traps)
 *  - text nodes whose font-size < 12px (unreadable on phone)
 *
 * Pure deterministic measurement — no LLM. Output shape mirrors the other
 * Pillar 2 audits: one block per viewport, plus a flat issue list.
 */
export async function auditMobile(url, opts = {}) {
  const viewports = opts.viewports || [
    { name: "mobile", width: 375, height: 812 },
    { name: "tablet", width: 768, height: 1024 },
    { name: "desktop", width: 1280, height: 900 },
  ];
  const results = [];
  const browser = await getBrowser();
  for (const vp of viewports) {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await new Promise(r => setTimeout(r, opts.settleMs || 1200));
      const r = await page.evaluate((vpName, vpW, vpH) => {
        const out = {
          viewport: vpName,
          width: vpW,
          height: vpH,
          pageScrollX: false,
          docWidth: 0,
          overflowX: [],
          tinyTouchTargets: [],
          tinyText: [],
          fixedTraps: [],
        };
        const doc = document.documentElement;
        out.docWidth = Math.max(doc.scrollWidth, doc.offsetWidth);
        out.pageScrollX = out.docWidth > vpW + 1;

        const all = document.querySelectorAll("*");
        let i = 0;
        for (const el of all) {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") continue;
          const r = el.getBoundingClientRect();
          if (r.width < 1 || r.height < 1) continue;

          // Overflow-x: element extends past viewport right edge.
          if (r.right > vpW + 1 && i < 50) {
            out.overflowX.push({
              tag: el.tagName.toLowerCase(),
              cls: (el.className && typeof el.className === "string" ? el.className : "").slice(0, 60),
              right: Math.round(r.right),
              w: Math.round(r.width),
            });
            i++;
          }

          // Tiny touch targets — only on mobile/tablet.
          if (vpW <= 1024) {
            const tag = el.tagName.toLowerCase();
            const isTouch = tag === "button" || tag === "a" || tag === "input" || tag === "select" || tag === "textarea" || el.getAttribute("role") === "button";
            if (isTouch && (r.width < 44 || r.height < 44) && out.tinyTouchTargets.length < 30) {
              out.tinyTouchTargets.push({
                tag, w: Math.round(r.width), h: Math.round(r.height),
                text: (el.textContent || "").trim().slice(0, 40),
              });
            }
          }

          // Tiny text — only on mobile.
          if (vpW <= 480) {
            const fs = parseFloat(cs.fontSize);
            if (fs > 0 && fs < 12 && el.textContent && el.textContent.trim().length > 4 && out.tinyText.length < 30) {
              out.tinyText.push({
                tag: el.tagName.toLowerCase(),
                fontSize: fs,
                text: el.textContent.trim().slice(0, 40),
              });
            }
          }

          // Fixed-position elements taller than 50% of viewport on mobile.
          if (vpW <= 480 && cs.position === "fixed" && r.height > vpH * 0.5 && out.fixedTraps.length < 10) {
            out.fixedTraps.push({
              tag: el.tagName.toLowerCase(),
              h: Math.round(r.height),
              cls: (el.className && typeof el.className === "string" ? el.className : "").slice(0, 60),
            });
          }
        }
        return out;
      }, vp.name, vp.width, vp.height);
      results.push(r);
    } finally {
      try { await page.close(); } catch {}
    }
  }

  // Roll up a flat issue summary.
  const summary = {
    horizontalScrollViewports: results.filter(r => r.pageScrollX).map(r => r.viewport),
    overflowXCount: results.reduce((a, r) => a + r.overflowX.length, 0),
    tinyTouchTargetCount: results.reduce((a, r) => a + r.tinyTouchTargets.length, 0),
    tinyTextCount: results.reduce((a, r) => a + r.tinyText.length, 0),
    fixedTrapCount: results.reduce((a, r) => a + r.fixedTraps.length, 0),
  };
  summary.totalIssues = summary.horizontalScrollViewports.length + summary.overflowXCount + summary.tinyTouchTargetCount + summary.tinyTextCount + summary.fixedTrapCount;
  return { ok: true, url, viewports: results, summary };
}

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
