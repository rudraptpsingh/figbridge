// spec-diff.js — structured, deterministic diff between two figbridge specs.
//
// A "spec" is the tree produced by urlToSpec() / window.domToSpec (see
// dom-to-spec.js). diffSpecs walks two specs in parallel and reports
// field-level differences bucketed into categories an agent can act on:
//
//   color       — text color, solid fill, stroke color, outline color
//   typography  — fontSize / fontWeight / fontFamily / lineHeight / letterSpacing / textAlign
//   copy        — text content (characters)
//   spacing     — layout direction, gap, padding, alignment, corner radius, size
//   elevation   — box-shadow (the depth/elevation ladder), opacity, backdrop blur
//   icon        — SVG glyph identity (wrong/missing icon)
//   structure   — nodes present on one side but not the other
//
// This generalizes the plugin-side `diff-frame-vs-spec` (Figma-node-vs-spec)
// to spec-vs-spec, so we can diff a rendered app against a mockup without a
// Figma round-trip. Pure function, no I/O — trivially unit-testable.

const SEVERITY = { high: 3, med: 2, low: 1 };

// Per-field category + severity. Anything not listed is ignored.
const FIELD_RULES = {
  // copy
  characters: { kind: "copy", severity: "high" },
  // color
  color: { kind: "color", severity: "high" },
  fill: { kind: "color", severity: "high" },
  stroke: { kind: "color", severity: "med" },
  outline: { kind: "color", severity: "med" },
  // elevation / depth — the redesign's elevation ladder + cinematic glow live here
  shadow: { kind: "elevation", severity: "med" },
  opacity: { kind: "elevation", severity: "low", tol: 0.02 },
  backdropBlur: { kind: "elevation", severity: "low", tol: 0.5 }, // glassmorphism
  textShadow: { kind: "elevation", severity: "low" }, // cinematic text glow
  // typography (incl. formatting: case, decoration)
  fontFamily: { kind: "typography", severity: "high" },
  fontSize: { kind: "typography", severity: "med", tol: 0.5 },
  fontWeight: { kind: "typography", severity: "med" },
  lineHeight: { kind: "typography", severity: "low", tol: 1 },
  letterSpacing: { kind: "typography", severity: "low", tol: 0.5 },
  textAlign: { kind: "typography", severity: "low" },
  textTransform: { kind: "typography", severity: "med" }, // UPPER labels etc.
  textDecoration: { kind: "typography", severity: "med" }, // underline / strikethrough
  // spacing / layout
  layout: { kind: "spacing", severity: "high" },
  spacing: { kind: "spacing", severity: "med", tol: 1 },
  padding: { kind: "spacing", severity: "med", tol: 1 },
  primaryAxisAlign: { kind: "spacing", severity: "med" },
  counterAxisAlign: { kind: "spacing", severity: "med" },
  cornerRadius: { kind: "spacing", severity: "med", tol: 0.5 },
  width: { kind: "spacing", severity: "low", tol: 2 },
  height: { kind: "spacing", severity: "low", tol: 2 },
};

function normHex(c) {
  if (c == null) return null;
  const s = String(c).trim().toLowerCase();
  return s || null;
}

// ── Perceptual colour (CIE Lab + ΔE76) ──────────────────────────────────────
// Exact-hex equality treats #ffffff vs #fafafa as a "difference" though it's
// imperceptible. ΔE gates on perceptibility instead, killing that false-positive
// noise. JND ≈ 2.3 in ΔE76.
const COLOR_JND = 2.3;
function hexToRgb(h) {
  const s = String(h).trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
function srgbToLin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgbToLab([r, g, b]) {
  const R = srgbToLin(r), G = srgbToLin(g), B = srgbToLin(b);
  let X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let Y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  X = f(X); Y = f(Y); Z = f(Z);
  return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)];
}
function deltaE76(l1, l2) {
  return Math.sqrt((l1[0] - l2[0]) ** 2 + (l1[1] - l2[1]) ** 2 + (l1[2] - l2[2]) ** 2);
}
// Two colour signatures differ *perceptibly*? When both are plain 6-hex, gate on
// ΔE; otherwise (alpha / gradient / structure in the sig) use exact inequality.
function perceptibleColorDiff(av, bv) {
  if (av === bv) return { differ: false, deltaE: null };
  const ra = hexToRgb(av), rb = hexToRgb(bv);
  if (ra && rb) {
    const dE = deltaE76(rgbToLab(ra), rgbToLab(rb));
    return { differ: dE > COLOR_JND, deltaE: dE };
  }
  return { differ: true, deltaE: null };
}

// Full fill signature — captures solid colour AND translucency (glass) AND
// gradients (cinematic/clay). Spec fills are a hex string, a gradient string,
// or an array of paint layers ([{kind:'solid',color,alpha}, {kind:'linear-gradient',value}, ...]).
function fillSig(fill) {
  if (fill == null) return null;
  if (typeof fill === "string") {
    if (/gradient/i.test(fill)) return "grad:" + fill.replace(/\s+/g, " ").trim().toLowerCase();
    return /^#|^rgb|^hsl/i.test(fill) ? normHex(fill) : null;
  }
  if (Array.isArray(fill)) {
    const parts = [];
    for (const layer of fill) {
      if (!layer) continue;
      if (layer.kind === "solid" && layer.color) {
        parts.push(normHex(layer.color) + (layer.alpha != null && layer.alpha < 0.999 ? "@" + (Math.round(layer.alpha * 100) / 100) : ""));
      } else if (layer.kind && /gradient/i.test(layer.kind)) {
        parts.push("grad:" + String(layer.value || layer.kind).replace(/\s+/g, " ").trim().toLowerCase());
      } else if (layer.kind === "image") {
        parts.push("image");
      }
    }
    return parts.length ? parts.join(" + ") : null;
  }
  return null;
}

// Full stroke/border signature — colour + alpha + width + style (not just the
// colour). Fine translucent borders (glass) and width changes now surface.
function strokeSig(stroke) {
  if (!stroke) return null;
  if (typeof stroke === "string") return normHex(stroke);
  const c = normHex(stroke.color);
  if (!c) return null;
  const a = stroke.alpha != null && stroke.alpha < 0.999 ? "@" + (Math.round(stroke.alpha * 100) / 100) : "";
  const w = stroke.width != null ? String(Math.round(stroke.width * 10) / 10) + "px" : "";
  const st = stroke.style && stroke.style !== "solid" ? stroke.style : "";
  return [c + a, w, st].filter((x) => x !== "").join("/");
}

// Padding can be a number or { top, right, bottom, left }. Normalize to a
// 4-tuple so we can compare per-side.
function padTuple(p) {
  if (p == null) return null;
  if (typeof p === "number") return [p, p, p, p];
  if (typeof p === "object") return [p.top || 0, p.right || 0, p.bottom || 0, p.left || 0];
  return null;
}

function normText(s) {
  return s == null ? null : String(s).replace(/\s+/g, " ").trim();
}

// Collapse a box-shadow array ([{x,y,blur,spread,color,alpha,inset}, …]) into a
// rounded, comparable signature. Elevation differences (a card that lost its
// shadow, a popover at the wrong depth) surface as a changed signature.
function shadowSig(shadow) {
  if (!shadow) return null;
  const arr = Array.isArray(shadow) ? shadow : [shadow];
  if (!arr.length) return null;
  return arr.map((s) => [
    Math.round(s.x || 0), Math.round(s.y || 0), Math.round(s.blur || 0),
    Math.round(s.spread || 0), normHex(s.color), Math.round((s.alpha == null ? 1 : s.alpha) * 100) / 100,
    s.inset ? "inset" : "",
  ].join(",")).join(" | ");
}

function outlineSig(o) {
  if (!o) return null;
  if (typeof o === "string") return normHex(o);
  return normHex(o.color) + "@" + (o.width == null ? "" : o.width);
}

// Icon identity from an inline SVG: the sorted set of path `d` geometries,
// ignoring size/color wrapper attrs. A different glyph → a different signature.
function iconSig(node) {
  const svg = node && node._svg;
  if (typeof svg !== "string") return null;
  const ds = (svg.match(/\bd=["']([^"']+)["']/g) || []).map((m) => m.replace(/\s+/g, " ").trim());
  if (!ds.length) {
    // No paths (circle/rect-based icon): fall back to a stripped markup hash.
    return svg.replace(/\s+/g, " ").replace(/(width|height|fill|stroke|class|style)=["'][^"']*["']/g, "").trim().slice(0, 200);
  }
  return ds.sort().join(" ");
}

// Compare one field on a paired (a, b). Returns a delta object or null.
function compareField(field, a, b, rule, path, name) {
  let av, bv;
  switch (field) {
    case "fill": av = fillSig(a.fill); bv = fillSig(b.fill); break;
    case "stroke": av = strokeSig(a.stroke); bv = strokeSig(b.stroke); break;
    case "outline": av = outlineSig(a.outline); bv = outlineSig(b.outline); break;
    case "shadow": av = shadowSig(a.shadow); bv = shadowSig(b.shadow); break;
    case "textShadow": av = shadowSig(a.textShadow); bv = shadowSig(b.textShadow); break;
    case "color": av = normHex(a.color); bv = normHex(b.color); break;
    // text formatting: coalesce null→"none" so present-vs-absent flips surface
    case "textTransform": av = a.textTransform || "none"; bv = b.textTransform || "none"; break;
    case "textDecoration": av = a.textDecoration || "none"; bv = b.textDecoration || "none"; break;
    case "characters": av = normText(a.characters); bv = normText(b.characters); break;
    case "padding": {
      const at = padTuple(a.padding), bt = padTuple(b.padding);
      if (!at && !bt) return null;
      const aa = at || [0, 0, 0, 0], bb = bt || [0, 0, 0, 0];
      const tol = rule.tol || 0;
      if (aa.every((v, i) => Math.abs(v - bb[i]) <= tol)) return null;
      av = aa.join("/"); bv = bb.join("/");
      return { path, name, kind: rule.kind, field, a: av, b: bv, severity: rule.severity };
    }
    default: av = a[field]; bv = b[field];
  }
  // One side missing the field entirely → not a field-mismatch (structure
  // diffs cover node presence; a present-vs-absent fill is usually noise).
  if (av == null || bv == null) {
    if (av == null && bv == null) return null;
    // Surface only meaningful presence flips: color/copy appearing/vanishing,
    // and elevation gained/lost (a card that lost its shadow, an element faded).
    if (rule.kind !== "color" && rule.kind !== "copy" && rule.kind !== "elevation") return null;
  }
  // Perceptual colour gate: suppress imperceptible colour diffs (ΔE < JND) and
  // report ΔE when both sides are plain hex.
  if (rule.kind === "color" && av != null && bv != null) {
    const pc = perceptibleColorDiff(av, bv);
    if (!pc.differ) return null;
    const d = { path, name, kind: rule.kind, field, a: av, b: bv, severity: rule.severity };
    if (pc.deltaE != null) d.deltaE = Math.round(pc.deltaE * 10) / 10;
    return d;
  }
  if (typeof av === "number" && typeof bv === "number") {
    if (Math.abs(av - bv) <= (rule.tol || 0)) return null;
  } else if (av === bv) {
    return null;
  }
  return { path, name, kind: rule.kind, field, a: av, b: bv, severity: rule.severity };
}

// Pair children of two frames by (type, ordinal-within-type): 1st text ↔ 1st
// text, 2nd frame ↔ 2nd frame, etc. Stable when structure matches (the
// mockup-vs-app fidelity case) and naturally surfaces copy/colour/spacing
// diffs on otherwise-aligned nodes. Unpaired nodes become structure deltas.
function pairChildren(aChildren, bChildren) {
  const pairs = [], onlyA = [], onlyB = [];
  const bByType = {};
  (bChildren || []).forEach((n) => { (bByType[n.type] = bByType[n.type] || []).push({ n, used: false }); });
  const seen = {};
  for (const an of aChildren || []) {
    const t = an.type;
    const ord = (seen[t] = (seen[t] || 0)); seen[t]++;
    const bucket = bByType[t] || [];
    if (bucket[ord]) { pairs.push([an, bucket[ord].n]); bucket[ord].used = true; }
    else onlyA.push(an);
  }
  for (const t of Object.keys(bByType)) for (const e of bByType[t]) if (!e.used) onlyB.push(e.n);
  return { pairs, onlyA, onlyB };
}

function nodeLabel(n) {
  if (!n) return "?";
  return (n.name || n.type || "node").toString().slice(0, 48);
}

/**
 * Diff two figbridge specs.
 * @param {object} specA  e.g. the mockup spec (the ground truth)
 * @param {object} specB  e.g. the app spec
 * @param {object} [opts] { maxDeltas=500, maxDepth=24, labelA='mockup', labelB='app' }
 * @returns {{ ok, summary, deltas }}
 */
export function diffSpecs(specA, specB, opts = {}) {
  const maxDeltas = opts.maxDeltas || 500;
  const maxDepth = opts.maxDepth || 24;
  const labelA = opts.labelA || "a";
  const labelB = opts.labelB || "b";
  const deltas = [];
  let nodesCompared = 0;

  function emit(d) {
    if (deltas.length < maxDeltas) deltas.push(d);
  }

  function walk(a, b, path, depth) {
    if (!a || !b || depth > maxDepth) return;
    nodesCompared++;
    const name = nodeLabel(a);
    // The app-side (b) anchor lets the caller resolve a delta to its source file.
    const bTestid = b._testid || null;
    for (const field of Object.keys(FIELD_RULES)) {
      const rule = FIELD_RULES[field];
      const d = compareField(field, a, b, rule, path, name);
      if (d) { d.testid = bTestid; emit(d); }
    }
    // Icon identity: when both nodes are inline SVGs, compare glyph geometry.
    if (a.type === "svg" && b.type === "svg") {
      const ai = iconSig(a), bi = iconSig(b);
      if (ai && bi && ai !== bi) emit({ path, name, kind: "icon", field: "glyph", a: "(svg)", b: "(different svg)", severity: "med", testid: bTestid });
    }
    const { pairs, onlyA, onlyB } = pairChildren(a.children, b.children);
    for (const n of onlyA) emit({ path, name: nodeLabel(n), kind: "structure", field: "missing", a: nodeLabel(n) + (n.characters ? ' "' + normText(n.characters).slice(0, 32) + '"' : ""), b: null, severity: "high", detail: `present in ${labelA}, absent in ${labelB}`, testid: bTestid });
    for (const n of onlyB) emit({ path, name: nodeLabel(n), kind: "structure", field: "extra", a: null, b: nodeLabel(n) + (n.characters ? ' "' + normText(n.characters).slice(0, 32) + '"' : ""), severity: "high", detail: `present in ${labelB}, absent in ${labelA}`, testid: n._testid || bTestid });
    for (const [an, bn] of pairs) walk(an, bn, path + " > " + nodeLabel(an), depth + 1);
  }

  walk(specA, specB, nodeLabel(specA), 0);

  // Highest severity first, then by category, so the agent fixes the loudest
  // mismatches first.
  deltas.sort((x, y) => SEVERITY[y.severity] - SEVERITY[x.severity] || x.kind.localeCompare(y.kind));

  const byKind = { color: 0, typography: 0, copy: 0, spacing: 0, elevation: 0, icon: 0, structure: 0 };
  let high = 0, med = 0, low = 0;
  for (const d of deltas) {
    byKind[d.kind] = (byKind[d.kind] || 0) + 1;
    if (d.severity === "high") high++; else if (d.severity === "med") med++; else low++;
  }

  return {
    ok: deltas.length === 0,
    summary: {
      total: deltas.length,
      truncated: deltas.length >= maxDeltas,
      nodesCompared,
      byKind,
      high, med, low,
    },
    deltas,
  };
}

// ── Design-language fingerprint ───────────────────────────────────────────
// Each visual style (glassmorphism, cinematic/dark, neumorphism, claymorphism,
// bento, flat/material) has signature signals. Per-node diffs can match copy &
// colour yet still miss the *style*: no gradients, no glow, no glass blur. This
// counts the defining signals across a spec so a mockup-vs-app comparison can
// flag a style-level gap ("mockup is cinematic — 21 gradients, 6 glow shadows;
// app has 2 and 0 → depth missing").

const BIG_RADIUS = 24, GLOW_BLUR = 20;

function maxRadius(cr) {
  if (typeof cr === "number") return cr;
  if (cr && typeof cr === "object") { const v = Object.values(cr).filter((n) => typeof n === "number"); return v.length ? Math.max(...v) : 0; }
  return 0;
}

export function styleProfile(spec) {
  const p = { nodes: 0, gradients: 0, glowShadows: 0, insetShadows: 0, backdropBlur: 0, translucentFills: 0, bigRadius: 0, fineBorders: 0, uppercaseLabels: 0, textGlow: 0 };
  (function visit(n) {
    if (!n) return;
    p.nodes++;
    const f = n.fill;
    if (typeof f === "string" && /gradient/i.test(f)) p.gradients++;
    else if (Array.isArray(f)) for (const l of f) {
      if (l && /gradient/i.test(l.kind || "")) p.gradients++;
      if (l && l.kind === "solid" && l.alpha != null && l.alpha < 0.95) p.translucentFills++;
    }
    const shadows = Array.isArray(n.shadow) ? n.shadow : (n.shadow ? [n.shadow] : []);
    for (const s of shadows) { if (s && s.inset) p.insetShadows++; if (s && (s.blur || 0) >= GLOW_BLUR) p.glowShadows++; }
    if (n.backdropBlur) p.backdropBlur++;
    if (maxRadius(n.cornerRadius) >= BIG_RADIUS) p.bigRadius++;
    if (n.stroke && typeof n.stroke === "object" && (n.stroke.width || 0) <= 1.5 && n.stroke.alpha != null && n.stroke.alpha < 1) p.fineBorders++;
    if (n.type === "text" && n.textTransform === "UPPER") p.uppercaseLabels++;
    if (n.textShadow) p.textGlow++;
    if (n.children) for (const c of n.children) visit(c);
  })(spec);
  p.dominant = inferStyle(p);
  return p;
}

function inferStyle(p) {
  const tags = [];
  if (p.backdropBlur >= 1 && p.translucentFills >= 2) tags.push("glassmorphism");
  if (p.glowShadows >= 2 || (p.gradients >= 4 && (p.glowShadows >= 1 || p.textGlow >= 1))) tags.push("cinematic-dark");
  if (p.bigRadius >= 4 && p.insetShadows >= 1) tags.push("claymorphism");
  else if (p.insetShadows >= 2) tags.push("neumorphism");
  if (!tags.length) tags.push("flat/material");
  return tags;
}

// Compare two style profiles and surface signals the app under-delivers
// relative to the mockup (the ground truth). Returns ranked style-level gaps.
export function compareStyleProfiles(mockup, app) {
  const SIGNALS = ["gradients", "glowShadows", "insetShadows", "backdropBlur", "translucentFills", "bigRadius", "fineBorders", "uppercaseLabels", "textGlow"];
  const gaps = [];
  for (const k of SIGNALS) {
    const want = mockup[k] || 0, got = app[k] || 0;
    // flag when the app delivers under ~60% of a non-trivial mockup signal
    if (want >= 2 && got < Math.ceil(want * 0.6)) gaps.push({ signal: k, mockup: want, app: got, missing: want - got });
  }
  gaps.sort((x, y) => y.missing - x.missing);
  return { mockupStyle: mockup.dominant, appStyle: app.dominant, gaps };
}
