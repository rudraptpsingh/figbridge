#!/usr/bin/env node
// Round-trip QA for Figbridge's own website.
//
// This exercises the real website importer against docs/index.html, then
// runs the exported spec through the same HTML/CSS exporter used by the
// Figma-to-code pipeline. It gives us a grounded signal for:
//   live page -> extracted spec -> generated code
//
// Run: node test/figbridge-site-roundtrip.mjs

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditInteractions, auditMobile, preflightImport, shutdown, urlToSpec, verifyTextFidelity } from "../mcp/src/browser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const docsDir = path.join(rootDir, "docs");
const require = createRequire(import.meta.url);
require("../test-agent/harness.js");
const exporter = require("../test-agent/code.js");

function assert(condition, message, detail) {
  if (!condition) {
    const suffix = detail ? "\n" + detail : "";
    throw new Error(message + suffix);
  }
}

function contentType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function startDocsServer() {
  const server = createServer(async (req, res) => {
    try {
      const parsed = new URL(req.url || "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(parsed.pathname);
      const safePath = path.normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
      const filePath = path.join(docsDir, safePath);
      if (!filePath.startsWith(docsDir)) throw new Error("bad path");
      const bytes = await readFile(filePath);
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(bytes);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function hexToPaint(hex) {
  if (!hex || typeof hex !== "string") return [];
  const clean = hex.replace("#", "");
  if (!/^[0-9a-f]{6,8}$/i.test(clean)) return [];
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  const a = clean.length === 8 ? parseInt(clean.slice(6, 8), 16) / 255 : 1;
  return [{ type: "SOLID", color: { r, g, b }, opacity: Math.round(a * 1000) / 1000 }];
}

function fillToPaint(fill) {
  if (!fill) return [];
  if (typeof fill === "string") return hexToPaint(fill);
  if (Array.isArray(fill)) {
    const solid = fill.find((f) => f && f.kind === "solid" && f.color);
    return solid ? hexToPaint(solid.color) : [];
  }
  if (fill.kind === "solid" && fill.color) return hexToPaint(fill.color);
  return [];
}

let nextId = 1;
function specToFigmaNode(node) {
  const type = node.type === "text" ? "TEXT" : (node.type === "svg" ? "VECTOR" : "FRAME");
  const out = {
    id: "roundtrip:" + nextId++,
    type,
    name: node.name || node.type || "Layer",
    x: Math.round(node.x || 0),
    y: Math.round(node.y || 0),
    width: Math.max(1, Math.round(node.width || 1)),
    height: Math.max(1, Math.round(node.height || 1)),
    visible: node.visible !== false,
    opacity: node.opacity == null ? 1 : node.opacity,
    fills: fillToPaint(node.fill),
    strokes: fillToPaint(node.stroke),
    strokeWeight: node.stroke ? 1 : 0,
    cornerRadius: typeof node.cornerRadius === "number" ? node.cornerRadius : 0,
    clipsContent: !!node.clipsContent,
    constraints: { horizontal: "MIN", vertical: "MIN" },
    layoutMode: node.layout === "VERTICAL" || node.layout === "HORIZONTAL" ? node.layout : "NONE",
    primaryAxisAlignItems: node.primaryAxisAlign || "MIN",
    counterAxisAlignItems: node.counterAxisAlign || "MIN",
    itemSpacing: Math.round(node.spacing || 0),
    paddingTop: typeof node.padding === "object" ? Math.round(node.padding.top || 0) : Math.round(node.padding || 0),
    paddingRight: typeof node.padding === "object" ? Math.round(node.padding.right || 0) : Math.round(node.padding || 0),
    paddingBottom: typeof node.padding === "object" ? Math.round(node.padding.bottom || 0) : Math.round(node.padding || 0),
    paddingLeft: typeof node.padding === "object" ? Math.round(node.padding.left || 0) : Math.round(node.padding || 0),
    layoutSizingHorizontal: node.layoutGrow ? "FILL" : "FIXED",
    layoutSizingVertical: "FIXED",
    children: [],
  };
  if (type === "TEXT") {
    out.characters = node.characters || "";
    out.fontSize = Math.round(node.fontSize || 16);
    out.fontName = { family: node.fontFamily || "Public Sans", style: node.fontWeight >= 700 ? "Bold" : "Regular" };
    out.lineHeight = node.lineHeight ? { unit: "PIXELS", value: Math.round(node.lineHeight) } : { unit: "AUTO" };
    out.letterSpacing = { unit: "PIXELS", value: 0 };
    out.textAlignHorizontal = "LEFT";
  }
  if (node.children && node.children.length) out.children = node.children.map(specToFigmaNode);
  return out;
}

function countNodes(node) {
  let count = 1;
  for (const child of node.children || []) count += countNodes(child);
  return count;
}

function reportLine(label, value) {
  console.log(label.padEnd(26) + String(value));
}

const requiredCopy = [
  "Convert websites into Figma",
  "Patch edits back to code",
  "MIT open source",
  "45 MCP tools",
  "From public page to Figma to pull request",
  "Free forever",
];

const { server, url } = await startDocsServer();
try {
  const widths = [1280, 768, 390];
  const summaries = [];
  for (const width of widths) {
    const spec = await urlToSpec(url, { width, maxDepth: 18, embedImages: true, settleMs: 600 });
    const text = await verifyTextFidelity(url, spec, { width, settleMs: 300 });
    summaries.push({ width, spec, text });
    assert(text.matchedPct === 100, `visible text fidelity fell below 100% at ${width}px`, JSON.stringify(text, null, 2));
    assert(countNodes(spec) > 250, `imported spec is unexpectedly small at ${width}px`);
    assert(spec.height > 6000, `imported spec height is unexpectedly short at ${width}px`);
  }

  const preflight = await preflightImport(url, { width: 1280, settleMs: 500 });
  assert(preflight.ok, "preflight unexpectedly found a blocking import issue", JSON.stringify(preflight.issues, null, 2));

  const mobile = await auditMobile(url, {});
  assert(mobile.ok, "mobile audit failed", JSON.stringify(mobile, null, 2));
  assert(mobile.summary.totalIssues === 0, "Figbridge website has mobile audit issues", JSON.stringify(mobile.summary, null, 2));

  const interactions = await auditInteractions(url, { width: 1280, settleMs: 300 });
  assert(interactions.interactiveCount >= 10, "expected nav/buttons/links to be discoverable");
  assert(interactions.css.hoverSelectorCount >= 1, "expected hover CSS to be discoverable");

  nextId = 1;
  const figmaNode = specToFigmaNode(summaries[0].spec);
  exporter.resetCSS("css");
  exporter.setVariableMap({});
  exporter.setAssetCache({});
  const generated = exporter.buildHTML([figmaNode], "Figbridge Roundtrip");
  for (const copy of requiredCopy) {
    assert(generated.html.includes(copy), `generated code is missing key copy: ${copy}`);
  }
  assert(generated.css.includes("display: flex"), "generated CSS lost flex layout");
  assert(generated.css.includes("position: absolute") || generated.css.includes("position:absolute"), "generated CSS lost absolute positioning");

  console.log("Figbridge website round-trip QA");
  reportLine("URL", url);
  for (const s of summaries) {
    reportLine(`${s.width}px text fidelity`, `${s.text.matchedPct}% (${s.text.liveCount} live strings)`);
    reportLine(`${s.width}px nodes`, countNodes(s.spec));
    reportLine(`${s.width}px height`, `${s.spec.height}px`);
  }
  reportLine("preflight issues", preflight.issues.length);
  reportLine("mobile issues", mobile.summary.totalIssues);
  reportLine("interactions", `${interactions.interactiveCount} elements, ${interactions.css.hoverSelectorCount} hover selectors`);
  reportLine("generated html", `${generated.html.length} bytes`);
  reportLine("generated css", `${generated.css.length} bytes`);
  console.log("PASS  Figbridge site imports cleanly and generated code preserves key content.");
} finally {
  await shutdown();
  await new Promise((resolve) => server.close(resolve));
}
