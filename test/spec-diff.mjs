#!/usr/bin/env node
// Unit tests for diffSpecs() — the structured spec-vs-spec diff that powers
// match_mockup / diff_specs. Pure function, no browser, always runnable.

import { diffSpecs, diffAnchoredSpecs, styleProfile, compareStyleProfiles } from "../mcp/src/spec-diff.js";

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

// An inserted sibling must not make every following component look changed.
{
  const target = { type: "frame", name: "Loupe", children: [
    { type: "frame", name: "Photo", _rect: { x: 320, y: 138 }, width: 900, height: 554 },
    { type: "text", name: "Caption", characters: "Reception" },
  ] };
  const app = { type: "frame", name: "Loupe", children: [
    { type: "frame", name: "Timeline", _testid: "trip-quick-nav", _rect: { x: 320, y: 56 }, width: 900, height: 45 },
    { type: "frame", name: "Photo", _testid: "loupe-photo", _rect: { x: 320, y: 165 }, width: 900, height: 554 },
    { type: "text", name: "Caption", characters: "Reception" },
  ] };
  const r = diffSpecs(target, app);
  assert(find(r.deltas, d => d.kind === "structure" && d.field === "extra" && d.name === "Timeline" && d.testid === "trip-quick-nav"), "inserted Timeline should be an extra structure issue", JSON.stringify(r.deltas));
  assert(find(r.deltas, d => d.field === "y" && d.a === 138 && d.b === 165 && d.testid === "loupe-photo"), "Photo should retain its identity and report 27px y shift", JSON.stringify(r.deltas));
  assert(!find(r.deltas, d => d.field === "characters" || d.name === "Caption"), "unchanged Caption should not be mispaired", JSON.stringify(r.deltas));
}

// A capped report must disclose every omitted issue; exactly-at-cap is complete.
{
  const a = { type: "frame", name: "Root", children: [
    { type: "text", name: "A", characters: "one" },
    { type: "text", name: "B", characters: "two" },
  ] };
  const b = { type: "frame", name: "Root", children: [
    { type: "text", name: "A", characters: "wrong one" },
    { type: "text", name: "B", characters: "wrong two" },
  ] };
  const capped = diffSpecs(a, b, { maxDeltas: 1 });
  assert(capped.summary.totalFound === 2 && capped.summary.omitted === 1 && capped.summary.truncated && capped.summary.byKind.copy === 2,
    "cap must disclose omitted issues and count all discovered categories", JSON.stringify(capped.summary));
  const exact = diffSpecs(a, b, { maxDeltas: 2 });
  assert(exact.summary.totalFound === 2 && exact.summary.omitted === 0 && !exact.summary.truncated, "exact cap should remain complete", JSON.stringify(exact.summary));
  const priority = diffSpecs({ type: "frame", name: "R", width: 100, children: [{ type: "text", name: "Copy", characters: "A" }] },
    { type: "frame", name: "R", width: 110, children: [{ type: "text", name: "Copy", characters: "B" }] }, { maxDeltas: 1 });
  assert(priority.deltas[0].kind === "copy", "cap should retain highest-severity issue even when found later", JSON.stringify(priority.deltas));
}

// Explicit state markers must be compared before a whole-screen verdict.
{
  const target = { type: "frame", name: "Review", _state: "synced", children: [] };
  const app = { type: "frame", name: "Review", _state: "signed-out", children: [] };
  const r = diffSpecs(target, app);
  assert(find(r.deltas, d => d.kind === "state" && d.field === "state" && d.a === "synced" && d.b === "signed-out"), "explicit unmatched state should be reported", JSON.stringify(r.deltas));
}

// ── Exact values by default; tolerance is an explicit opt-in ──
{
  const A = { type: "text", name: "T", characters: "hi", fontSize: 16 };
  const B = { type: "text", name: "T", characters: "hi", fontSize: 16.3 }; // within fontSize tol 0.5
  assert(find(diffSpecs(A, B).deltas, d => d.field === "fontSize"), "exact mode should report a 0.3px font difference");
  assert(diffSpecs(A, B, { tolerant: true }).summary.total === 0, "tolerant mode should suppress a 0.3px font difference");

  const C = { type: "frame", name: "F", width: 300, height: 200 };
  const D = { type: "frame", name: "F", width: 301, height: 200 }; // within width tol 2
  assert(find(diffSpecs(C, D).deltas, d => d.field === "width"), "exact mode should report a 1px width difference");
  assert(diffSpecs(C, D, { tolerant: true }).summary.total === 0, "tolerant mode should suppress a 1px width difference");
}

// ── Matched viewport geometry: placement drift is actionable ──
{
  const target = { type: "frame", name: "Page", children: [
    { type: "frame", name: "Align", width: 560, height: 300, _rect: { x: 124, y: 90, w: 560, h: 300 } },
  ] };
  const app = { type: "frame", name: "Page", _testid: "page-root", children: [
    { type: "frame", name: "Align", width: 644, height: 300, _state: "matched", _rect: { x: 84, y: 90, w: 644, h: 300 } },
  ] };
  const ds = diffSpecs(target, app).deltas;
  assert(find(ds, d => d.field === "x" && d.a === 124 && d.b === 84 && d.testid === "page-root" && d.state === "matched" && d.anchorVia === "ancestor-data-testid"), "40px x drift with source/state anchor missing", JSON.stringify(ds));
  assert(find(ds, d => d.field === "width" && d.a === 560 && d.b === 644), "width drift missing", JSON.stringify(ds));
  assert(!find(ds, d => d.field === "y"), "same y should not be reported", JSON.stringify(ds));
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

  // A fractional blur differs in exact mode and is ignorable only on request.
  const G = { type: "frame", name: "Y", shadow: [{ x: 0, y: 4, blur: 12, spread: 0, color: "#000000", alpha: 0.3 }] };
  const H = { type: "frame", name: "Y", shadow: [{ x: 0, y: 4, blur: 12.4, spread: 0, color: "#000000", alpha: 0.3 }] };
  assert(find(diffSpecs(G, H).deltas, d => d.field === "shadow"), "exact mode should report fractional shadow blur", JSON.stringify(diffSpecs(G, H).deltas));
  assert(diffSpecs(G, H, { tolerant: true }).summary.total === 0, "tolerant mode should round fractional shadow blur");
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

  const fineA = { type: "frame", name: "Fine", stroke: { color: "#ffffff", width: 1.01 }, fill: [{ kind: "solid", color: "#ffffff", alpha: 0.101 }] };
  const fineB = { type: "frame", name: "Fine", stroke: { color: "#ffffff", width: 1.04 }, fill: [{ kind: "solid", color: "#ffffff", alpha: 0.104 }] };
  assert(find(diffSpecs(fineA, fineB).deltas, d => d.field === "stroke"), "exact mode should report fractional stroke-width difference");
  assert(find(diffSpecs(fineA, fineB).deltas, d => d.field === "fill"), "exact mode should report fractional alpha difference");
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
  assert(find(diffSpecs(A, B).deltas, d => d.field === "color"), "exact mode should report a subtle authored colour change", JSON.stringify(diffSpecs(A, B).deltas));
  assert(diffSpecs(A, B, { tolerant: true }).summary.total === 0, "tolerant mode should suppress a sub-JND colour change");

  // perceptible: #111111 vs #777777 → fires, reports deltaE above JND
  const C = { type: "text", name: "T", characters: "x", color: "#111111" };
  const D = { type: "text", name: "T", characters: "x", color: "#777777" };
  const cd = find(diffSpecs(C, D).deltas, d => d.kind === "color" && d.field === "color");
  assert(cd, "perceptible colour diff should fire", JSON.stringify(diffSpecs(C, D).deltas));
  assert(typeof cd.deltaE === "number" && cd.deltaE > 2.3, "should report deltaE above JND", JSON.stringify(cd));
}

// Different Figma and DOM trees must be compared by explicit, unique anchors.
{
  const figma = { type: "frame", name: "Loupe", children: [
    { type: "frame", name: "stage", _figmaId: "21:409", x: 240, y: 48, width: 828, height: 734, fill: "#141414" },
    { type: "frame", name: "filmstrip", _figmaId: "21:457", x: 240, y: 782, width: 828, height: 86 },
  ] };
  const app = { type: "frame", name: "body", children: [
    { type: "frame", name: "wrapper", children: [
      { type: "frame", name: "div", _testid: "cull-center-column", _rect: { x: 240, y: 48, w: 828, h: 820 }, fill: "#202020" },
      { type: "frame", name: "div", _testid: "cull-loupe-filmstrip", _rect: { x: 241, y: 782, w: 828, h: 86 } },
    ] },
  ] };
  const anchors = [
    { name: "stage", mockupId: "21:409", appTestid: "cull-center-column" },
    { name: "filmstrip", mockupId: "21:457", appTestid: "cull-loupe-filmstrip" },
  ];
  const r = diffAnchoredSpecs(figma, app, anchors);
  assert(r.coverage.matched === 2, "both anchors should match");
  assert(r.coverage.scope === "selected-anchors" && r.coverage.wholeScreenCertified === false,
    "an anchored subset must disclose that it cannot certify the whole screen", JSON.stringify(r.coverage));
  assert(r.coverage.captureNodes.mockup === 3 && r.coverage.captureNodes.app === 4,
    "coverage must disclose both captured tree sizes", JSON.stringify(r.coverage));
  assert(r.coverage.unpairedNodes.mockup === 1 && r.coverage.unpairedNodes.app === 2,
    "coverage must disclose nodes outside the paired subset", JSON.stringify(r.coverage));
  assert(r.coverage.unpairedInventory.mockup[0].path === "Loupe" &&
    r.coverage.unpairedInventory.app.some(n => n.path === "body > wrapper"),
    "coverage must identify the unpaired nodes so reviewers can map them", JSON.stringify(r.coverage));
  assert(r.coverage.unpairedInventory.app.every(n => n.testid == null || typeof n.testid === "string"),
    "app inventory must retain test ids for source lookup", JSON.stringify(r.coverage));
  assert(find(r.deltas, d => d.path.includes("stage") && d.field === "height" && d.a === 734 && d.b === 820), "stage delta must use the named anchor", JSON.stringify(r.deltas));
  assert(find(r.deltas, d => d.path.includes("stage") && d.field === "fill"), "default anchor must compare inspected paint", JSON.stringify(r.deltas));
  assert(find(r.deltas, d => d.path.includes("filmstrip") && d.field === "x" && d.a === 240 && d.b === 241), "viewport x drift must be reported", JSON.stringify(r.deltas));
  const geometry = diffAnchoredSpecs(figma, app, anchors.map(a => ({ ...a, fields: ["x", "y", "width", "height"] })));
  assert(!geometry.deltas.some(d => d.field === "fill"), "geometry-only anchors must not report uninspected paint", JSON.stringify(geometry.deltas));
  const missing = diffAnchoredSpecs(figma, app, [...anchors, { name: "People", mockupId: "279:3650", appTestid: "people" }]);
  assert(missing.coverage.matched === 2, "missing anchor must not reduce matched coverage");
  assert(missing.coverage.unmatched.length === 1, "missing anchor must be reported");
  assert(missing.ok === false, "missing anchor must keep result non-PASS");
  const unmeasured = diffAnchoredSpecs(figma, app, [
    { name: "stage", mockupId: "21:409", appTestid: "cull-center-column", fields: ["width", "fontSize"] },
  ]);
  assert(unmeasured.coverage.unmeasured.length === 1, "requested value missing on both sides must be reported", JSON.stringify(unmeasured.coverage));
  assert(unmeasured.coverage.unmeasured[0].field === "fontSize", "identify the requested field");
  assert(unmeasured.ok === false, "unmeasured explicit field must keep result non-PASS");
  const autoFields = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [
      { type: "text", name: "title", _figmaId: "1:2", characters: "Reception", fontFamily: "Inter", fontSize: 15, x: 12 },
    ] },
    { type: "frame", name: "App", children: [
      { type: "text", name: "title", _testid: "title", characters: "Reception", x: 12 },
    ] },
    [{ name: "title", mockupId: "1:2", appTestid: "title" }]
  );
  assert(autoFields.coverage.requestedFields === 4, "default anchor must request all captured fields", JSON.stringify(autoFields.coverage));
  assert(autoFields.coverage.unmeasured.some(d => d.field === "fontFamily" && d.mockupMeasured && !d.appMeasured), "missing app font must be visible", JSON.stringify(autoFields.coverage));
  assert(autoFields.coverage.unmeasured.some(d => d.field === "fontSize" && d.mockupMeasured && !d.appMeasured), "missing app size must be visible", JSON.stringify(autoFields.coverage));
  assert(autoFields.ok === false, "default anchor must not pass when measured design fields are missing in app");
  const partialGeometry = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [{ type: "frame", name: "partial", _figmaId: "1:3", x: 10, width: 99 }] },
    { type: "frame", name: "App", children: [{ type: "frame", name: "partial", _testid: "partial", _rect: { x: 14, w: 120 } }] },
    [{ name: "partial", mockupId: "1:3", appTestid: "partial", fields: ["x"] }]
  );
  assert(partialGeometry.deltas.some(d => d.field === "x" && d.a === 10 && d.b === 14), "partial captured x must be compared", JSON.stringify(partialGeometry.deltas));
  assert(!partialGeometry.deltas.some(d => d.field === "width"), "explicit x-only anchor must not compare width", JSON.stringify(partialGeometry.deltas));
  const nullMeasurement = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [{ type: "text", name: "title", _figmaId: "1:4", fontFamily: "Inter" }] },
    { type: "frame", name: "App", children: [{ type: "text", name: "title", _testid: "title", fontFamily: null }] },
    [{ name: "title", mockupId: "1:4", appTestid: "title", fields: ["fontFamily"] }]
  );
  assert(nullMeasurement.coverage.unmeasured.some(d => d.field === "fontFamily" && !d.appMeasured), "null app values must remain unmeasured", JSON.stringify(nullMeasurement.coverage));
  assert(nullMeasurement.ok === false, "null measurement must keep the comparison non-PASS");
  const textPairs = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [
      { type: "text", name: "heading", _figmaId: "1:8", characters: "Reception", fontSize: 15 },
      { type: "text", name: "repeated a", _figmaId: "1:9", characters: "Open" },
      { type: "text", name: "repeated b", _figmaId: "1:10", characters: "Open" },
    ] },
    { type: "frame", name: "App", children: [
      { type: "frame", name: "container", _testid: "heading-shell", children: [
        { type: "text", name: "heading", characters: "Reception", fontSize: 13 },
        { type: "text", name: "button", characters: "Open" },
      ] },
    ] },
    [], { autoTextAnchors: true }
  );
  assert(textPairs.coverage.generatedAnchors === 1 && textPairs.coverage.matched === 1,
    "unique exact text should pair automatically; repeated copy must remain unpaired", JSON.stringify(textPairs.coverage));
  assert(textPairs.deltas.some(d => d.field === "fontSize" && d.a === 15 && d.b === 13),
    "automatic text pair must compare authored typography", JSON.stringify(textPairs.deltas));
  assert(textPairs.deltas.some(d => d.testid === "heading-shell"),
    "automatic pair should retain its nearest source test id", JSON.stringify(textPairs.deltas));
  const familyAlias = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [{ type: "text", _figmaId: "1:11", characters: "Label", fontFamily: "Inter" }] },
    { type: "frame", name: "App", children: [{ type: "text", _testid: "label", characters: "Label", fontFamily: "Inter Variable" }] },
    [{ name: "Label", mockupId: "1:11", appTestid: "label", fields: ["fontFamily"] }]
  );
  assert(familyAlias.ok && !familyAlias.deltas.length, "Inter Variable must compare as the authored Inter family", JSON.stringify(familyAlias.deltas));
  const weightAlias = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [{ type: "text", _figmaId: "1:12", fontWeight: 600 }] },
    { type: "frame", name: "App", children: [{ type: "text", _testid: "label", fontWeight: "Semi Bold" }] },
    [{ name: "weight", mockupId: "1:12", appTestid: "label", fields: ["fontWeight"] }]
  );
  assert(weightAlias.ok, "numeric and named equivalents of font weight must compare equally", JSON.stringify(weightAlias.deltas));
  const weightMismatch = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [{ type: "text", _figmaId: "1:12", fontWeight: 500 }] },
    { type: "frame", name: "App", children: [{ type: "text", _testid: "label", fontWeight: "Regular" }] },
    [{ name: "weight", mockupId: "1:12", appTestid: "label", fields: ["fontWeight"] }]
  );
  assert(weightMismatch.deltas.some(d => d.field === "fontWeight" && d.a === 500 && d.b === 400),
    "actual weight drift should report normalized numeric values", JSON.stringify(weightMismatch.deltas));
  const mappingHelp = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [
      { type: "frame", name: "view switch", _figmaId: "2:1", _rect: { x: 10, y: 10, w: 100, h: 40 }, fill: "#222222" },
      { type: "frame", name: "new control", _figmaId: "2:2", _rect: { x: 200, y: 10, w: 100, h: 40 } },
    ] },
    { type: "frame", name: "App", children: [
      { type: "frame", name: "wrapper", _testid: "view-switch-wrapper", _rect: { x: 10, y: 10, w: 100, h: 40 }, children: [
        { type: "frame", name: "painted", _testid: "view-switch-control", _rect: { x: 10, y: 10, w: 100, h: 40 }, fill: "#222222" },
      ] },
      { type: "frame", name: "new", _testid: "new-control", _rect: { x: 200, y: 10, w: 100, h: 40 } },
    ] },
    [{ name: "view switch", mockupId: "2:1", appTestid: "view-switch-wrapper", fields: ["x", "y", "width", "height"] }]
  );
  assert(mappingHelp.coverage.anchorAlternatives.some(a => a.name === "view switch" &&
    a.candidates[0].appTestid === "view-switch-control"),
    "painted child should be suggested over an unpainted wrapper", JSON.stringify(mappingHelp.coverage));
  assert(mappingHelp.coverage.candidatePairs.some(p => p.mockupId === "2:2" &&
    p.candidates[0].appTestid === "new-control"),
    "unpaired design control should have a geometry candidate, not an automatic PASS", JSON.stringify(mappingHelp.coverage));
  assert(mappingHelp.coverage.regions.some(r => r.mockupId === "2:2" && r.unpairedNodes === 1),
    "region inventory must show which design area still needs mapping", JSON.stringify(mappingHelp.coverage));
  const differentStates = diffAnchoredSpecs(
    { type: "frame", name: "Figma", children: [{ type: "frame", name: "focus", _state: "on", children: [
      { type: "text", name: "label", _figmaId: "3:1", characters: "Focus point", color: "#ffffff", fontWeight: 500 },
    ] }] },
    { type: "frame", name: "App", children: [{ type: "frame", name: "focus", _testid: "focus", _state: "off", children: [
      { type: "text", name: "label", characters: "Focus point", color: "#999999", fontWeight: 400 },
    ] }] },
    [], { autoTextAnchors: true }
  );
  assert(differentStates.coverage.stateMismatched.length === 1 &&
    differentStates.deltas.some(d => d.field === "state" && d.a === "on" && d.b === "off") &&
    !differentStates.deltas.some(d => d.field === "color" || d.field === "fontWeight"),
    "unmatched control states must block style verdicts instead of producing false defects", JSON.stringify(differentStates));
  let duplicateRejected = false;
  try { diffAnchoredSpecs(figma, app, [anchors[0], anchors[0]]); }
  catch { duplicateRejected = true; }
  assert(duplicateRejected, "duplicate anchors must not silently certify the same node twice");
}

console.log(`PASS  diffSpecs unit tests (${passed} assertions).`);
process.exit(0);
