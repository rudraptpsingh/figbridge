// layout-metrics.js — turn a spec's exact geometry into MATHEMATICAL structure
// values an agent can reason over directly (more actionable than a picture):
//   grid       inferred column/row count, gutter, pitch, content width
//   alignment  number of shared vertical/horizontal edge lines + a snap score
//   spacing    detected base unit (4/8px), the spacing scale, % off-grid
//   components repeated-component groups: count, cell size, col/row pitch, regularity
//   xycut      recursive whitespace segmentation → block depth/leaves + the seams
// diffLayoutMetrics() reports the numeric mockup-vs-app deltas (6-col vs 4-col, …).
//
// Pure (operates on spec._rect added by dom-to-spec), deterministic, no LLM.

const round = (n, p = 1) => { const f = 10 ** p; return Math.round(n * f) / f; };
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; }
function stddev(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); }

// 1-D clustering: sort, break a new cluster when the gap to the previous value
// exceeds `tol`. Returns [{ value:mean, count }].
function cluster1d(values, tol) {
  const s = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const out = [];
  let cur = [];
  for (const v of s) {
    if (cur.length && v - cur[cur.length - 1] > tol) { out.push({ value: round(mean(cur)), count: cur.length }); cur = []; }
    cur.push(v);
  }
  if (cur.length) out.push({ value: round(mean(cur)), count: cur.length });
  return out;
}
function pitch(sortedVals) {
  if (sortedVals.length < 2) return null;
  const d = []; for (let i = 1; i < sortedVals.length; i++) d.push(sortedVals[i] - sortedVals[i - 1]);
  return Math.round(median(d));
}

function flatten(spec) {
  const nodes = [];
  (function walk(n, depth) {
    if (!n) return;
    const leaf = !n.children || n.children.length === 0;
    if (n._rect && n._rect.w >= 4 && n._rect.h >= 4) {
      nodes.push({ x: n._rect.x, y: n._rect.y, w: n._rect.w, h: n._rect.h, type: n.type, group: n._componentGroupId || null, depth, leaf });
    }
    if (n.children) for (const c of n.children) walk(c, depth + 1);
  })(spec, 0);
  return nodes;
}

function boundsOf(nodes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// largest uncovered gap of a set of 1-D intervals within [lo,hi]
function widestGap(intervals, lo, hi) {
  const iv = intervals.map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)]).filter(([a, b]) => b > a).sort((p, q) => p[0] - q[0]);
  let best = { size: 0, pos: lo }, cur = lo;
  for (const [a, b] of iv) { if (a > cur && a - cur > best.size) best = { size: a - cur, pos: cur + (a - cur) / 2 }; cur = Math.max(cur, b); }
  if (hi - cur > best.size) best = { size: hi - cur, pos: cur + (hi - cur) / 2 };
  return best;
}

// recursive XY-cut on non-overlapping leaf blocks → structural seams
function xyCut(nodes, region, depth, acc) {
  acc.maxDepth = Math.max(acc.maxDepth, depth);
  if (nodes.length <= 1 || depth >= 6) { acc.leaves++; return; }
  const v = widestGap(nodes.map((n) => [n.x, n.x + n.w]), region.x, region.x + region.w);
  const h = widestGap(nodes.map((n) => [n.y, n.y + n.h]), region.y, region.y + region.h);
  const MIN = 18;
  const useV = v.size >= h.size;
  const g = useV ? v : h;
  if (g.size < MIN) { acc.leaves++; return; }
  acc.seams.push({ axis: useV ? "x" : "y", pos: Math.round(g.pos), gap: Math.round(g.size) });
  if (useV) {
    xyCut(nodes.filter((n) => n.x + n.w / 2 < g.pos), { x: region.x, y: region.y, w: g.pos - region.x, h: region.h }, depth + 1, acc);
    xyCut(nodes.filter((n) => n.x + n.w / 2 >= g.pos), { x: g.pos, y: region.y, w: region.x + region.w - g.pos, h: region.h }, depth + 1, acc);
  } else {
    xyCut(nodes.filter((n) => n.y + n.h / 2 < g.pos), { x: region.x, y: region.y, w: region.w, h: g.pos - region.y }, depth + 1, acc);
    xyCut(nodes.filter((n) => n.y + n.h / 2 >= g.pos), { x: region.x, y: g.pos, w: region.w, h: region.y + region.h - g.pos }, depth + 1, acc);
  }
}

// spacing scale from vertical gaps between vertically-stacked, x-overlapping boxes
function spacingScale(nodes) {
  const gaps = [];
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    const xOverlap = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    if (xOverlap <= 0) continue;
    const g = (a.y < b.y) ? b.y - (a.y + a.h) : a.y - (b.y + b.h);
    if (g > 0 && g <= 80) gaps.push(Math.round(g));
  }
  if (!gaps.length) return { baseUnit: null, scale: [], offGridPct: null, samples: 0 };
  const clusters = cluster1d(gaps, 2).filter((c) => c.count >= 2).sort((a, b) => b.count - a.count);
  const scale = clusters.map((c) => Math.round(c.value)).sort((a, b) => a - b);
  // base unit = the divisor that most gaps are multiples of (try 8,4,6,10)
  let baseUnit = null, bestHit = 0;
  for (const u of [8, 4, 6, 10, 12]) {
    const hit = gaps.filter((g) => g % u === 0 || Math.abs((g % u) - u) <= 1 || (g % u) <= 1).length;
    if (hit > bestHit) { bestHit = hit; baseUnit = u; }
  }
  const offGrid = baseUnit ? gaps.filter((g) => !((g % baseUnit) <= 1 || (g % baseUnit) >= baseUnit - 1)).length : 0;
  return { baseUnit, scale, offGridPct: round((offGrid / gaps.length) * 100), samples: gaps.length };
}

/** @param {object} spec a spec tree whose nodes carry `_rect` */
export function layoutMetrics(spec) {
  const nodes = flatten(spec);
  if (!nodes.length) return { ok: false, nodeCount: 0 };
  const bounds = boundsOf(nodes);

  // component groups (figbridge already tags repeated structures with _componentGroupId)
  const groups = {};
  for (const n of nodes) if (n.group) (groups[n.group] = groups[n.group] || []).push(n);
  const groupList = Object.entries(groups).map(([id, ns]) => ({ id, count: ns.length, ns }))
    .filter((g) => g.count >= 2).sort((a, b) => b.count - a.count);

  // grid from the dominant repeated component (the contact-sheet / card grid)
  let grid = null;
  if (groupList.length) {
    const g = groupList[0];
    const cw = median(g.ns.map((n) => n.w)) || 1, ch = median(g.ns.map((n) => n.h)) || 1;
    const xs = cluster1d(g.ns.map((n) => n.x + n.w / 2), Math.max(6, cw * 0.4));
    const ys = cluster1d(g.ns.map((n) => n.y + n.h / 2), Math.max(6, ch * 0.4));
    grid = {
      component: g.id, instances: g.count,
      columns: xs.length, rows: ys.length,
      colPitch: pitch(xs.map((c) => c.value)), rowPitch: pitch(ys.map((c) => c.value)),
      cellW: Math.round(cw), cellH: Math.round(ch),
      sizeRegularity: round(stddev(g.ns.map((n) => n.w)) / (cw + 1), 2), // 0 = perfectly uniform
    };
  }

  // alignment: shared edge lines + snap score
  const vLines = cluster1d(nodes.map((n) => n.x), 6).filter((c) => c.count >= 2);
  const hLines = cluster1d(nodes.map((n) => n.y), 6).filter((c) => c.count >= 2);
  const aligned = nodes.filter((n) => vLines.some((l) => Math.abs(l.value - n.x) <= 6)).length;
  const alignment = { vLines: vLines.length, hLines: hLines.length, snapScore: round(aligned / nodes.length, 2) };

  // xy-cut on leaf (non-overlapping) blocks
  const acc = { maxDepth: 0, leaves: 0, seams: [] };
  xyCut(nodes.filter((n) => n.leaf), bounds, 0, acc);
  acc.seams.sort((a, b) => b.gap - a.gap);

  const area = nodes.filter((n) => n.leaf).reduce((s, n) => s + n.w * n.h, 0);
  const coverage = round(Math.min(1, area / (bounds.w * bounds.h + 1)), 2);

  return {
    ok: true,
    nodeCount: nodes.length,
    bounds: { w: bounds.w, h: bounds.h },
    contentWidth: bounds.w,
    grid,
    componentGroups: groupList.map((g) => ({ id: g.id, count: g.count })),
    alignment,
    spacing: spacingScale(nodes),
    xycut: { depth: acc.maxDepth, leaves: acc.leaves, topSeams: acc.seams.slice(0, 6) },
    density: { coverage },
  };
}

const d = (a, b) => (a == null || b == null ? null : Math.round((b - a) * 10) / 10);

/** Numeric mockup-vs-app structural delta. */
export function diffLayoutMetrics(mock, app) {
  const mg = mock.grid || {}, ag = app.grid || {};
  const notes = [];
  if (mg.columns != null && ag.columns != null && mg.columns !== ag.columns)
    notes.push(`grid columns: mockup ${mg.columns} vs app ${ag.columns}`);
  if (mg.colPitch != null && ag.colPitch != null && Math.abs(mg.colPitch - ag.colPitch) > 4)
    notes.push(`column pitch: mockup ${mg.colPitch}px vs app ${ag.colPitch}px`);
  if (mg.instances != null && ag.instances != null && mg.instances !== ag.instances)
    notes.push(`component instances: mockup ${mg.instances} vs app ${ag.instances}`);
  if (mock.spacing?.baseUnit && app.spacing?.baseUnit && mock.spacing.baseUnit !== app.spacing.baseUnit)
    notes.push(`spacing base unit: mockup ${mock.spacing.baseUnit}px vs app ${app.spacing.baseUnit}px`);
  if (Math.abs((mock.contentWidth || 0) - (app.contentWidth || 0)) > 24)
    notes.push(`content width: mockup ${mock.contentWidth}px vs app ${app.contentWidth}px`);
  return {
    grid: {
      columns: { mockup: mg.columns ?? null, app: ag.columns ?? null, delta: d(mg.columns, ag.columns) },
      rows: { mockup: mg.rows ?? null, app: ag.rows ?? null, delta: d(mg.rows, ag.rows) },
      colPitch: { mockup: mg.colPitch ?? null, app: ag.colPitch ?? null, delta: d(mg.colPitch, ag.colPitch) },
      instances: { mockup: mg.instances ?? null, app: ag.instances ?? null, delta: d(mg.instances, ag.instances) },
    },
    spacingBaseUnit: { mockup: mock.spacing?.baseUnit ?? null, app: app.spacing?.baseUnit ?? null },
    alignmentLines: { mockup: mock.alignment?.vLines ?? null, app: app.alignment?.vLines ?? null, delta: d(mock.alignment?.vLines, app.alignment?.vLines) },
    xycutLeaves: { mockup: mock.xycut?.leaves ?? null, app: app.xycut?.leaves ?? null, delta: d(mock.xycut?.leaves, app.xycut?.leaves) },
    contentWidth: { mockup: mock.contentWidth ?? null, app: app.contentWidth ?? null, delta: d(mock.contentWidth, app.contentWidth) },
    componentGroupCount: { mockup: (mock.componentGroups || []).length, app: (app.componentGroups || []).length },
    notes,
  };
}

// flat list of {rect,color} demarcation boxes for the visual `demarcate` overlay:
// every repeated-component instance shares a colour; the grid columns get lines.
export function demarcationBoxes(spec) {
  const nodes = flatten(spec);
  const groups = {};
  for (const n of nodes) if (n.group) (groups[n.group] = groups[n.group] || []).push(n);
  const palette = [[124, 108, 252], [34, 197, 94], [245, 158, 11], [59, 130, 246], [236, 72, 153], [20, 184, 166]];
  const boxes = [];
  let gi = 0;
  for (const id of Object.keys(groups)) {
    if (groups[id].length < 2) continue;
    const color = palette[gi++ % palette.length];
    for (const n of groups[id]) boxes.push({ x: n.x, y: n.y, w: n.w, h: n.h, color, group: id });
  }
  return boxes;
}
