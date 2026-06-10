#!/usr/bin/env node
// Unit tests for image-tools.js — SSIM + the legible diff artifacts. Pure pngjs.

import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ssim, annotateDiff, solidPng, decodePng, encodePng } from "../mcp/src/image-tools.js";

let passed = 0;
function assert(c, m, d) { if (!c) throw new Error("FAIL: " + m + (d ? "\n" + d : "")); passed++; }

const solid = (w, h, rgb) => solidPng(w, h, rgb);
// PNG with a coloured square in the middle
async function withSquare(w, h, bg, sq, [sx, sy, sw, sh]) {
  const p = await decodePng(await solid(w, h, bg));
  for (let y = sy; y < sy + sh; y++) for (let x = sx; x < sx + sw; x++) {
    const i = (y * w + x) * 4; p.data[i] = sq[0]; p.data[i + 1] = sq[1]; p.data[i + 2] = sq[2]; p.data[i + 3] = 255;
  }
  return encodePng(p);
}

const white = await solid(64, 64, [255, 255, 255]);
const black = await solid(64, 64, [0, 0, 0]);
const nearWhite = await solid(64, 64, [250, 250, 250]);

// ── SSIM ──
{
  const same = await ssim(white, white);
  assert(same >= 0.999, "ssim(identical) should be ~1", String(same));

  const opposite = await ssim(white, black);
  assert(opposite < 0.2, "ssim(white vs black) should be near 0", String(opposite));

  const close = await ssim(white, nearWhite);
  assert(close > 0.9, "ssim(white vs near-white) should stay high (perceptual)", String(close));

  // different sizes → resized, still runs
  const big = await solid(128, 96, [255, 255, 255]);
  assert((await ssim(white, big)) >= 0.999, "ssim handles mismatched sizes");
}

// ── annotateDiff artifacts ──
{
  const dir = await mkdtemp(path.join(tmpdir(), "imgtools-"));
  try {
    const a = await solid(120, 80, [240, 240, 240]);
    const b = await withSquare(120, 80, [240, 240, 240], [239, 68, 68], [40, 24, 40, 32]);
    const out = await annotateDiff({ mockPng: a, appPng: b, regions: [{ x: 40, y: 24, w: 40, h: 32 }], outDir: dir, prefix: "t" });

    for (const k of ["overlay", "montage", "boxed"]) {
      assert(out[k] && out[k].endsWith(`t-${k}.png`), `${k} path returned`, JSON.stringify(out));
      const s = await stat(out[k]);
      assert(s.size > 0, `${k} file written non-empty`);
      const png = await decodePng(await readFile(out[k])); // must be a valid PNG
      assert(png.width > 0 && png.height > 0, `${k} decodes as a valid PNG`);
    }
    // montage is wider than a single panel (3 panels side by side)
    const montage = await decodePng(await readFile(out.montage));
    assert(montage.width > 120, "montage is multi-panel (wider than one image)", String(montage.width));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

console.log(`PASS  image-tools unit tests (${passed} assertions).`);
process.exit(0);
