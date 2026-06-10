// image-tools.js — make a visual diff legible to an agent, and score it
// perceptually. Pure pngjs (no native binary, no sharp) so figbridge stays
// light and works offline in CI.
//
//   annotateDiff()  → writes three artifacts the agent can Read():
//                     *-overlay.png  onion-skin (mockup over app at 50%)
//                     *-montage.png  [mockup | app | overlay] side-by-side
//                     *-boxed.png    app with red boxes on the diff regions
//   ssim()          → structural-similarity score (0..1), a perceptual
//                     secondary to the raw-pixel score (filters AA/shift noise)

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

let _PNG = null;
async function PNGlib() {
  if (!_PNG) _PNG = (await import("pngjs")).PNG;
  return _PNG;
}

function decode(PNG, buf) {
  return PNG.sync.read(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "base64"));
}

// Small PNG utilities (used by callers/tests so they don't need pngjs directly).
export async function solidPng(w, h, [r, g, b]) {
  const PNG = await PNGlib();
  const p = new PNG({ width: w, height: h });
  for (let i = 0; i < p.data.length; i += 4) { p.data[i] = r; p.data[i + 1] = g; p.data[i + 2] = b; p.data[i + 3] = 255; }
  return PNG.sync.write(p);
}
export async function decodePng(buf) { return decode(await PNGlib(), buf); }
export async function encodePng(png) { return (await PNGlib()).sync.write(png); }

// nearest-neighbour resize into a new PNG of (w,h)
function resize(PNG, src, w, h) {
  if (src.width === w && src.height === h) return src;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    const sy = Math.min(src.height - 1, Math.floor(y * src.height / h));
    for (let x = 0; x < w; x++) {
      const sx = Math.min(src.width - 1, Math.floor(x * src.width / w));
      const si = (sy * src.width + sx) * 4, di = (y * w + x) * 4;
      out.data[di] = src.data[si]; out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2]; out.data[di + 3] = 255;
    }
  }
  return out;
}

function fillRect(c, x0, y0, w, h, [r, g, b]) {
  for (let y = y0; y < y0 + h && y < c.height; y++) {
    if (y < 0) continue;
    for (let x = x0; x < x0 + w && x < c.width; x++) {
      if (x < 0) continue;
      const i = (y * c.width + x) * 4;
      c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = 255;
    }
  }
}

// copy src into canvas at (ox,oy)
function blit(c, src, ox, oy) {
  for (let y = 0; y < src.height; y++) {
    const cy = oy + y; if (cy < 0 || cy >= c.height) continue;
    for (let x = 0; x < src.width; x++) {
      const cx = ox + x; if (cx < 0 || cx >= c.width) continue;
      const si = (y * src.width + x) * 4, di = (cy * c.width + cx) * 4;
      c.data[di] = src.data[si]; c.data[di + 1] = src.data[si + 1];
      c.data[di + 2] = src.data[si + 2]; c.data[di + 3] = 255;
    }
  }
}

// draw a hollow rectangle border (thickness t)
function strokeRect(c, x0, y0, w, h, [r, g, b], t = 3) {
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return;
    const i = (y * c.width + x) * 4;
    c.data[i] = r; c.data[i + 1] = g; c.data[i + 2] = b; c.data[i + 3] = 255;
  };
  for (let k = 0; k < t; k++) {
    for (let x = x0; x < x0 + w; x++) { set(x, y0 + k); set(x, y0 + h - 1 - k); }
    for (let y = y0; y < y0 + h; y++) { set(x0 + k, y); set(x0 + w - 1 - k, y); }
  }
}

const C_MOCKUP = [34, 197, 94];   // green
const C_APP = [59, 130, 246];     // blue
const C_OVERLAY = [245, 158, 11]; // amber
const C_DIFF = [239, 68, 68];     // red
const BG = [10, 10, 10];

// onion-skin: app base, mockup blended on top at `op`
function overlayPng(PNG, mock, app, op = 0.5) {
  const m = resize(PNG, mock, app.width, app.height);
  const out = new PNG({ width: app.width, height: app.height });
  for (let i = 0; i < app.data.length; i += 4) {
    out.data[i] = Math.round(app.data[i] * (1 - op) + m.data[i] * op);
    out.data[i + 1] = Math.round(app.data[i + 1] * (1 - op) + m.data[i + 1] * op);
    out.data[i + 2] = Math.round(app.data[i + 2] * (1 - op) + m.data[i + 2] * op);
    out.data[i + 3] = 255;
  }
  return out;
}

// [mockup | app | overlay] panels, each with a colour-coded legend bar on top.
function montagePng(PNG, panels, panelH = 900) {
  const gap = 16, bar = 6;
  const sized = panels.map((p) => {
    const w = Math.max(1, Math.round(p.img.width * panelH / p.img.height));
    return { img: resize(PNG, p.img, w, panelH), color: p.color };
  });
  const totalW = sized.reduce((s, p) => s + p.img.width, 0) + gap * (sized.length + 1);
  const totalH = panelH + bar + gap * 2;
  const c = new PNG({ width: totalW, height: totalH });
  fillRect(c, 0, 0, totalW, totalH, BG);
  let x = gap;
  for (const p of sized) {
    fillRect(c, x, gap, p.img.width, bar, p.color); // legend bar
    blit(c, p.img, x, gap + bar);
    strokeRect(c, x, gap + bar, p.img.width, panelH, p.color, 2);
    x += p.img.width + gap;
  }
  return c;
}

// app copy with red boxes over diff regions (regions in app-pixel coords)
function boxedPng(PNG, app, regions) {
  const out = new PNG({ width: app.width, height: app.height });
  out.data.set(app.data);
  for (const r of (regions || [])) {
    strokeRect(out, Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h), C_DIFF, 3);
  }
  return out;
}

/**
 * Write the three legible diff artifacts to disk.
 * @returns {{ overlay, montage, boxed }} absolute paths
 */
export async function annotateDiff({ mockPng, appPng, regions, outDir, prefix }) {
  const PNG = await PNGlib();
  await mkdir(outDir, { recursive: true }).catch(() => {});
  const mock = decode(PNG, mockPng), app = decode(PNG, appPng);

  const overlay = overlayPng(PNG, mock, app, 0.5);
  const boxed = boxedPng(PNG, app, regions);
  const montage = montagePng(PNG, [
    { img: mock, color: C_MOCKUP },
    { img: app, color: C_APP },
    { img: overlay, color: C_OVERLAY },
  ]);

  const paths = {
    overlay: path.join(outDir, `${prefix}-overlay.png`),
    montage: path.join(outDir, `${prefix}-montage.png`),
    boxed: path.join(outDir, `${prefix}-boxed.png`),
  };
  await writeFile(paths.overlay, PNG.sync.write(overlay));
  await writeFile(paths.montage, PNG.sync.write(montage));
  await writeFile(paths.boxed, PNG.sync.write(boxed));
  return paths;
}

/**
 * Draw component-demarcation boxes (each repeated-component group its own
 * colour) + optional grid column lines onto a base screenshot. The visual
 * companion to layout-metrics' numbers.
 * @returns {string} outPath
 */
export async function demarcatePng({ basePng, boxes, gridX, outPath }) {
  const PNG = await PNGlib();
  const img = decode(PNG, basePng);
  if (gridX) for (const gx of gridX) {
    const x = Math.round(gx); if (x < 0 || x >= img.width) continue;
    for (let y = 0; y < img.height; y++) { const i = (y * img.width + x) * 4; img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = 255; }
  }
  for (const b of (boxes || [])) {
    strokeRect(img, Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h), b.color || C_DIFF, 2);
  }
  await mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
  await writeFile(outPath, PNG.sync.write(img));
  return outPath;
}

// ── SSIM ───────────────────────────────────────────────────────────────────
// Structural similarity over 8×8 non-overlapping blocks on the luma channel.
// Perceptual: tolerates anti-aliasing / sub-pixel shifts that wreck raw-pixel
// scores, while still catching genuine structural change. Returns 0..1.
function luma(png) {
  const g = new Float64Array(png.width * png.height);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j++) {
    g[j] = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
  }
  return g;
}

export async function ssim(aPng, bPng) {
  const PNG = await PNGlib();
  let a = decode(PNG, aPng), b = decode(PNG, bPng);
  if (a.width !== b.width || a.height !== b.height) b = resize(PNG, b, a.width, a.height);
  const W = a.width, H = a.height;
  const ga = luma(a), gb = luma(b);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  const win = 8;
  let total = 0, n = 0;
  for (let by = 0; by + win <= H; by += win) {
    for (let bx = 0; bx + win <= W; bx += win) {
      let ma = 0, mb = 0;
      for (let y = 0; y < win; y++) for (let x = 0; x < win; x++) {
        const idx = (by + y) * W + (bx + x); ma += ga[idx]; mb += gb[idx];
      }
      const cnt = win * win; ma /= cnt; mb /= cnt;
      let va = 0, vb = 0, cov = 0;
      for (let y = 0; y < win; y++) for (let x = 0; x < win; x++) {
        const idx = (by + y) * W + (bx + x);
        const da = ga[idx] - ma, db = gb[idx] - mb;
        va += da * da; vb += db * db; cov += da * db;
      }
      va /= cnt - 1; vb /= cnt - 1; cov /= cnt - 1;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      total += s; n++;
    }
  }
  return n ? Math.max(0, Math.min(1, Math.round((total / n) * 1000) / 1000)) : 1;
}
