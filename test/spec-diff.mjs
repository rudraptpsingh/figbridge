#!/usr/bin/env node
// Unit tests for diffSpecs() — the structured spec-vs-spec diff that powers
// match_mockup / diff_specs. Pure function, no browser, always runnable.

import { diffSpecs, styleProfile, compareStyleProfiles } from "../mcp/src/spec-diff.js";

let passed = 0;
function assert(condition, message, detail) {
  if (!condition) throw new Error("FAIL: " + message + (detail ? "\n" + detail : ""));
  passed++;
}
function find(deltas, pred) { return deltas.find(pred); }

// ── Identical specs → no deltas ──
{
  const spec = {
    type: "frame", name: "Card", layout: "VERTICAL", spacing: 16,
    padding: { top: 24, right: 24, bottom: 24, left: 24 }, fill: "#ffffff", cornerRadius: 12,
    children: [
      { type: "text", name: "Title", characters: "Sunset Shoot", fontSize: 20, fontWeight: 700, fontFamily: "Inter", color: "#111111" },
      { type: "text", name: "Sub", characters: "24 photos", fontSize: 14, fontWeight: 400, fontFamily: "Inter", color: "#666666" },
    ],
  };
  const r = diffSpecs(spec, JSON.parse(JSON.stringify(spec)));
  assert(r.ok === true, "identical specs should produce ok:true");
  assert(r.summary.total === 0, "identical specs should produce zero deltas", JSON.stringify(r.summary));
}

// ── Field-level diffs across every category ──
{
  const A = {
    type: "frame", name: "Card", layout: "VERTICAL", spacing: 16,
    padding: { top: 24, right: 24, bottom: 24, left: 24 }, fill: "#ffffff", cornerRadius: 12,
    stroke: { color: "#e5e5e5", width: 1 },
    children: [
      { type: "text", name: "Title", characters: "Sunset Shoot", fontSize: 20, fontWeight: 700, fontFamily: "Inter", color: "#111111" },
      { type: "text", name: "Sub", characters: "24 photos", fontSize: 14, fontWeight: 400, fontFamily: "Inter", color: "#666666" },
    ],
  };
  const B = {
    type: "frame", name: "Card", layout: "HORIZONTAL", spacing: 8,
    padding: { top: 24, right: 24, bottom: 24, left: 16 }, fill: "#e0e0e0", cornerRadius: 12,
    stroke: { color: "#cccccc", width: 1 },
    children: [
      { type: "text", name: "Title", characters: "Sunset Shoot", fontSize: 18, fontWeight: 700, fontFamily: "Inter", color: "#111111" },
      { type: "text", name: "Sub", characters: "24 images", fontSize: 14, fontWeight: 400, fontFamily: "Roboto", color: "#666666" },
    ],
  };
  const r = diffSpecs(A, B, { labelA: "mockup", labelB: "app" });
  assert(r.ok === false, "differing specs should produce ok:false");

  // color: fill changed (perceptible)
  assert(find(r.deltas, d => d.kind === "color" && d.field === "fill" && d.a === "#ffffff" && d.b === "#e0e0e0"), "fill color delta missing", JSON.stringify(r.deltas));
  // color: stroke changed
  assert(find(r.deltas, d => d.kind === "color" && d.field === "stroke"), "stroke color delta missing", JSON.stringify(r.deltas));
  // copy changed
  assert(find(r.deltas, d => d.kind === "copy" && d.a === "24 photos" && d.b === "24 images"), "copy delta missing", JSON.stringify(r.deltas));
  // typography: fontFamily (high) + fontSize (med)
  assert(find(r.deltas, d => d.kind === "typography" && d.field === "fontFamily" && d.severity === "high"), "fontFamily delta missing", JSON.stringify(r.deltas));
  assert(find(r.deltas, d => d.kind === "typography" && d.field === "fontSize"), "fontSize delta missing", JSON.stringify(r.deltas));
  // spacing: layout direction (high), gap, padding
  assert(find(r.deltas, d => d.kind === "spacing" && d.field === "layout" && d.severity === "high"), "layout-direction delta missing", JSON.stringify(r.deltas));
  assert(find(r.deltas, d => d.kind === "spacing" && d.field === "spacing"), "gap delta missing", JSON.stringify(r.deltas));
  assert(find(r.deltas, d => d.kind === "spacing" && d.field === "padding"), "padding delta missing", JSON.stringify(r.deltas));

  // severity ordering: first delta is high
  assert(r.deltas[0].severity === "high", "deltas should be sorted high-severity first", JSON.stringify(r.deltas[0]));
}

// ── Structure: missing / extra nodes ──
{
  const A = { type: "frame", name: "List", children: [
    { type: "text", name: "A", characters: "one" },
    { type: "text", name: "B", characters: "two" },
    { type: "text", name: "C", characters: "three" },
  ] };
  const B = { type: "frame", name: "List", children: [
    { type: "text", name: "A", characters: "one" },
    { type: "text", name: "B", characters: "two" },
  ] };
  const r = diffSpecs(A, B, { labelA: "mockup", labelB: "app" });
  assert(find(r.deltas, d => d.kind === "structure" && d.field === "missing"), "missing-node structure delta absent", JSON.stringify(r.deltas));

  const r2 = diffSpecs(B, A);
  assert(find(r2.deltas, d => d.kind === "structure" && d.field === "extra"), "extra-node structure delta absent", JSON.stringify(r2.deltas));
}

// ── Numeric tolerance: sub-tolerance differences are ignored ──
{
  const A = { type: "text", name: "T", characters: "hi", fontSize: 16 };
  const B = { type: "text", name: "T", characters: "hi", fontSize: 16.3 }; // within fontSize tol 0.5
  const r = diffSpecs(A, B);
  assert(r.summary.total === 0, "sub-tolerance fontSize diff should be ignored", JSON.stringify(r.deltas));

  const C = { type: "frame", name: "F", width: 300, height: 200 };
  const D = { type: "frame", name: "F", width: 301, height: 200 }; // within width tol 2
  assert(diffSpecs(C, D).summary.total === 0, "sub-tolerance width diff should be ignored");
}

// ── Elevation: shadow gained/lost/changed + opacity ──
{
  const A = { type: "frame", name: "Card", shadow: [{ x: 0, y: 8, blur: 24, spread: 0, color: "#000000", alpha: 0.4 }], children: [] };
  const B = { type: "frame", name: "Card", shadow: null, children: [] }; // lost its shadow
  const r = diffSpecs(A, B);
  assert(find(r.deltas, d => d.kind === "elevation" && d.field === "shadow"), "lost-shadow elevation delta missing", JSON.stringify(r.deltas));

  const C = { type: "frame", name: "Pop", shadow: [{ x: 0, y: 2, blur: 8, spread: 0, color: "#000000", alpha: 0.2 }] };
  const D = { type: "frame", name: "Pop", shadow: [{ x: 0, y: 16, blur: 48, spread: 0, color: "#000000", alpha: 0.5 }] }; // wrong depth
  assert(find(diffSpecs(C, D).deltas, d => d.kind === "elevation" && d.field === "shadow"), "wrong-depth shadow delta missing");

  const E = { type: "frame", name: "X", opacity: 0.6 };
  const F = { type: "frame", name: "X" }; // opacity 1 (omitted)
  assert(find(diffSpecs(E, F).deltas, d => d.kind === "elevation" && d.field === "opacity"), "opacity elevation delta missing");

  // Sub-tolerance shadow (12 vs 12.4 px blur, rounds equal) → ignored
  const G = { type: "frame", name: "Y", shadow: [{ x: 0, y: 4, blur: 12, spread: 0, color: "#000000", alpha: 0.3 }] };
  const H = { type: "frame", name: "Y", shadow: [{ x: 0, y: 4, blur: 12.4, spread: 0, color: "#000000", alpha: 0.3 }] };
  assert(diffSpecs(G, H).summary.total === 0, "sub-pixel shadow diff should round-equal and be ignored", JSON.stringify(diffSpecs(G, H).deltas));
}

// ── Color: outline (focus ring / border) change ──
{
  const A = { type: "frame", name: "Input", outline: { color: "#3d7dff", width: 2 } };
  const B = { type: "frame", name: "Input", outline: { color: "#ff0000", width: 2 } };
  assert(find(diffSpecs(A, B).deltas, d => d.kind === "color" && d.field === "outline"), "outline color delta missing");
}

// ── Icon: different SVG glyph geometry ──
{
  const A = { type: "svg", name: "icon", _svg: '<svg><path d="M3 6h18"/><path d="M7 12h10"/></svg>' };
  const B = { type: "svg", name: "icon", _svg: '<svg><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>' };
  assert(find(diffSpecs(A, B).deltas, d => d.kind === "icon" && d.field === "glyph"), "icon glyph delta missing", JSON.stringify(diffSpecs(A, B).deltas));

  // Same glyph, different size/color wrapper → no diff
  const C = { type: "svg", name: "icon", _svg: '<svg width="16" height="16" stroke="#fff"><path d="M3 6h18"/></svg>' };
  const D = { type: "svg", name: "icon", _svg: '<svg width="24" height="24" stroke="#000"><path d="M3 6h18"/></svg>' };
  assert(diffSpecs(C, D).summary.total === 0, "same glyph at different size/color should not diff", JSON.stringify(diffSpecs(C, D).deltas));
}

// ── Array (layered) fill resolves to first solid color ──
{
  const A = { type: "frame", name: "F", fill: [{ kind: "solid", color: "#112233" }] };
  const B = { type: "frame", name: "F", fill: "#445566" };
  const r = diffSpecs(A, B);
  assert(find(r.deltas, d => d.kind === "color" && d.field === "fill" && d.a === "#112233" && d.b === "#445566"), "layered-fill color not resolved", JSON.stringify(r.deltas));
}

// ── Style-defining signals: gradients, translucency, border width ──
{
  // gradient fill vs solid
  const A = { type: "frame", name: "Hero", fill: [{ kind: "linear-gradient", value: "linear-gradient(140deg,#2b333d,#0e1318)" }] };
  const B = { type: "frame", name: "Hero", fill: "#1a1a1a" };
  assert(find(diffSpecs(A, B).deltas, d => d.kind === "color" && d.field === "fill" && /grad:/.test(String(d.a))), "gradient-vs-solid fill delta missing", JSON.stringify(diffSpecs(A, B).deltas));

  // translucency (glass): same hex, different alpha
  const C = { type: "frame", name: "Glass", fill: [{ kind: "solid", color: "#ffffff", alpha: 0.1 }] };
  const D = { type: "frame", name: "Glass", fill: [{ kind: "solid", color: "#ffffff", alpha: 0.9 }] };
  assert(find(diffSpecs(C, D).deltas, d => d.kind === "color" && d.field === "fill"), "fill translucency delta missing");

  // border width (same colour, different width) — was invisible before
  const E = { type: "frame", name: "Card", stroke: { color: "#ffffff", width: 1 } };
  const F = { type: "frame", name: "Card", stroke: { color: "#ffffff", width: 3 } };
  assert(find(diffSpecs(E, F).deltas, d => d.kind === "color" && d.field === "stroke"), "stroke-width delta missing (same colour)", JSON.stringify(diffSpecs(E, F).deltas));
}

// ── Text formatting: transform, decoration, glow ──
{
  const A = { type: "text", name: "L", characters: "Folders", textTransform: "UPPER" };
  const B = { type: "text", name: "L", characters: "Folders" }; // app forgot uppercase
  assert(find(diffSpecs(A, B).deltas, d => d.kind === "typography" && d.field === "textTransform" && d.a === "UPPER" && d.b === "none"), "textTransform delta missing", JSON.stringify(diffSpecs(A, B).deltas));

  const C = { type: "text", name: "Link", characters: "Privacy", textDecoration: "UNDERLINE" };
  const D = { type: "text", name: "Link", characters: "Privacy" };
  assert(find(diffSpecs(C, D).deltas, d => d.kind === "typography" && d.field === "textDecoration"), "textDecoration delta missing");

  // cinematic text glow
  const E = { type: "text", name: "H", characters: "Title", textShadow: [{ x: 0, y: 0, blur: 8, spread: 0, color: "#ffffff", alpha: 0.6 }] };
  const F = { type: "text", name: "H", characters: "Title" };
  assert(find(diffSpecs(E, F).deltas, d => d.kind === "elevation" && d.field === "textShadow"), "text-glow elevation delta missing");
}

// ── Design-language fingerprint ──
{
  const grad = (v) => ({ type: "frame", fill: [{ kind: "linear-gradient", value: v }] });
  const glow = { x: 0, y: 0, blur: 40, spread: 0, color: "#000000", alpha: 0.5 };
  const cine = { type: "frame", name: "root", children: [
    { ...grad("a"), shadow: [glow] }, grad("b"), grad("c"), { ...grad("d"), shadow: [glow] },
  ] };
  const prof = styleProfile(cine);
  assert(prof.gradients === 4, "styleProfile gradient count wrong", JSON.stringify(prof));
  assert(prof.glowShadows === 2, "styleProfile glow count wrong", JSON.stringify(prof));
  assert(prof.dominant.includes("cinematic-dark"), "cinematic style not inferred", JSON.stringify(prof.dominant));

  const flat = { type: "frame", name: "root", children: [{ type: "frame", fill: "#ffffff" }, { type: "frame", fill: "#eeeeee" }] };
  assert(styleProfile(flat).dominant.includes("flat/material"), "flat style not inferred");

  // glass
  const glass = { type: "frame", name: "g", backdropBlur: 18, children: [
    { type: "frame", fill: [{ kind: "solid", color: "#ffffff", alpha: 0.1 }] },
    { type: "frame", fill: [{ kind: "solid", color: "#ffffff", alpha: 0.15 }] },
  ] };
  assert(styleProfile(glass).dominant.includes("glassmorphism"), "glass style not inferred", JSON.stringify(styleProfile(glass)));

  // gap: cinematic mockup vs flat app → flags missing gradients + glow
  const cmp = compareStyleProfiles(styleProfile(cine), styleProfile(flat));
  assert(cmp.gaps.some(g => g.signal === "gradients"), "style gap should flag missing gradients", JSON.stringify(cmp.gaps));
  assert(cmp.gaps.some(g => g.signal === "glowShadows"), "style gap should flag missing glow");
}

// ── Perceptual colour gate (ΔE) ──
{
  // imperceptible: #ffffff vs #fafafa (ΔE < JND) → suppressed
  const A = { type: "text", name: "T", characters: "x", color: "#ffffff" };
  const B = { type: "text", name: "T", characters: "x", color: "#fafafa" };
  assert(diffSpecs(A, B).summary.total === 0, "imperceptible colour diff (#ffffff vs #fafafa) should be suppressed", JSON.stringify(diffSpecs(A, B).deltas));

  // perceptible: #111111 vs #777777 → fires, reports deltaE above JND
  const C = { type: "text", name: "T", characters: "x", color: "#111111" };
  const D = { type: "text", name: "T", characters: "x", color: "#777777" };
  const cd = find(diffSpecs(C, D).deltas, d => d.kind === "color" && d.field === "color");
  assert(cd, "perceptible colour diff should fire", JSON.stringify(diffSpecs(C, D).deltas));
  assert(typeof cd.deltaE === "number" && cd.deltaE > 2.3, "should report deltaE above JND", JSON.stringify(cd));
}

console.log(`PASS  diffSpecs unit tests (${passed} assertions).`);
process.exit(0);
