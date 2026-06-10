#!/usr/bin/env node
// Unit tests for layout-metrics.js — the mathematical structure values.

import { layoutMetrics, diffLayoutMetrics, demarcationBoxes } from "../mcp/src/layout-metrics.js";

let passed = 0;
function assert(c, m, d) { if (!c) throw new Error("FAIL: " + m + (d ? "\n" + d : "")); passed++; }

// Build a spec: a header + an N-col × M-row grid of cards (each in the same
// component group), cards sized cellW×cellH at pitch (cellW+gap)×(cellH+gap).
function gridSpec(cols, rows, { cellW = 200, cellH = 150, gap = 20, x0 = 0, y0 = 80 } = {}) {
  const children = [{ type: "text", name: "Header", _rect: { x: 0, y: 0, w: cols * (cellW + gap), h: 40 } }];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    children.push({
      type: "frame", name: "Card", _componentGroupId: "grid/g0",
      _rect: { x: x0 + c * (cellW + gap), y: y0 + r * (cellH + gap), w: cellW, h: cellH },
      children: [{ type: "text", name: "t", _rect: { x: x0 + c * (cellW + gap) + 8, y: y0 + r * (cellH + gap) + 8, w: 80, h: 16 } }],
    });
  }
  return { type: "frame", name: "root", _rect: { x: 0, y: 0, w: cols * (cellW + gap), h: y0 + rows * (cellH + gap) }, children };
}

// ── grid inference ──
{
  const m = layoutMetrics(gridSpec(3, 2));
  assert(m.ok, "metrics ok");
  assert(m.grid, "grid inferred");
  assert(m.grid.columns === 3, "3 columns inferred", JSON.stringify(m.grid));
  assert(m.grid.rows === 2, "2 rows inferred", JSON.stringify(m.grid));
  assert(m.grid.instances === 6, "6 component instances", JSON.stringify(m.grid));
  assert(m.grid.colPitch === 220, "column pitch = cellW+gap = 220", JSON.stringify(m.grid));
  assert(m.grid.rowPitch === 170, "row pitch = cellH+gap = 170", JSON.stringify(m.grid));
  assert(m.grid.cellW === 200 && m.grid.cellH === 150, "cell size", JSON.stringify(m.grid));
  assert(m.grid.sizeRegularity === 0, "uniform cells → regularity 0", JSON.stringify(m.grid));
  assert(m.componentGroups.length === 1 && m.componentGroups[0].count === 6, "component group count", JSON.stringify(m.componentGroups));
  assert(m.alignment.vLines >= 3, "≥3 vertical alignment lines (the columns)", JSON.stringify(m.alignment));
  assert(m.xycut.leaves >= 1 && m.xycut.depth >= 1, "xy-cut produced blocks", JSON.stringify(m.xycut));
}

// ── numeric diff: 6-col mockup vs 4-col app ──
{
  const mock = layoutMetrics(gridSpec(6, 2));
  const app = layoutMetrics(gridSpec(4, 3));
  const diff = diffLayoutMetrics(mock, app);
  assert(diff.grid.columns.mockup === 6 && diff.grid.columns.app === 4 && diff.grid.columns.delta === -2,
    "column delta reported (6 → 4)", JSON.stringify(diff.grid.columns));
  assert(diff.grid.instances.mockup === 12 && diff.grid.instances.app === 12, "instances", JSON.stringify(diff.grid.instances));
  assert(diff.notes.some(n => /grid columns: mockup 6 vs app 4/.test(n)), "human note for column mismatch", JSON.stringify(diff.notes));
}

// ── demarcation boxes ──
{
  const boxes = demarcationBoxes(gridSpec(3, 2));
  assert(boxes.length === 6, "one demarcation box per component instance", String(boxes.length));
  assert(boxes.every(b => Array.isArray(b.color) && b.color.length === 3), "boxes carry an RGB colour");
  assert(boxes.every(b => b.w === 200 && b.h === 150), "box geometry matches the cells");
}

// ── empty/degenerate ──
assert(layoutMetrics({ type: "frame", name: "x" }).ok === false, "spec with no _rect → ok:false");

console.log(`PASS  layout-metrics unit tests (${passed} assertions).`);
process.exit(0);
