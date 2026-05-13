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
      while ((n = walker.nextNode())) {
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
  // Resize b to match a if dimensions differ (Figma exports may be 2x).
  if (a.width !== b.width || a.height !== b.height) {
    // Use sharp if present; else just bail with a note.
    try {
      const sharp = (await import("sharp")).default;
      const buf = await sharp(Buffer.isBuffer(pngB) ? pngB : Buffer.from(pngB))
        .resize(a.width, a.height, { fit: "fill" }).png().toBuffer();
      b = PNG.sync.read(buf);
    } catch (e) {
      return { ok: false, error: "Dimensions differ and sharp not installed. a=" + a.width + "x" + a.height + " b=" + b.width + "x" + b.height };
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
