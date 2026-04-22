// ============================================================
// Figbridge  |  code.js  (main thread)
// Figma → HTML/CSS + Tailwind + Design Tokens, with a live bridge
// to the Figbridge MCP so agents can pull code from Figma.
// ES2017-safe: no ??, no ?., no object-spread, no .at()
// ============================================================

figma.showUI(__html__, { width: 680, height: 820, title: "Figbridge" });

// ── Page map ──────────────────────────────────────────────────
function sendPageMap() {
  var pages = figma.root.children.map(function (page) {
    return {
      id: page.id,
      name: page.name,
      frameCount: page.children.filter(function (n) {
        return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP";
      }).length,
      isCurrent: page.id === figma.currentPage.id
    };
  });
  figma.ui.postMessage({ type: "pages", pages: pages });
}

function _summarizeNode(n) {
  var hasChildren = ("children" in n) && n.children && n.children.length > 0;
  var w = (typeof n.width === "number") ? Math.round(n.width) : null;
  var h = (typeof n.height === "number") ? Math.round(n.height) : null;
  return { id: n.id, name: n.name || "(unnamed)", type: n.type, width: w, height: h, hasChildren: hasChildren };
}

async function sendFramesForPage(pageId) {
  var page = figma.root.children.find(function (p) { return p.id === pageId; });
  if (!page) {
    figma.ui.postMessage({ type: "error", message: "Page " + pageId + " not found." });
    return;
  }
  await figma.setCurrentPageAsync(page);
  var frames = page.children.map(_summarizeNode);
  figma.ui.postMessage({ type: "frames", pageId: pageId, pageName: page.name, frames: frames });
}

async function sendChildrenFor(nodeId) {
  try {
    var node = await figma.getNodeByIdAsync(nodeId);
    if (!node || !("children" in node)) {
      figma.ui.postMessage({ type: "children", parentId: nodeId, children: [] });
      return;
    }
    var kids = node.children.map(_summarizeNode);
    figma.ui.postMessage({ type: "children", parentId: nodeId, children: kids });
  } catch (e) {
    figma.ui.postMessage({ type: "error", message: "get-children failed: " + (e && e.message ? e.message : e) });
  }
}

// ── Color / CSS helpers ───────────────────────────────────────
function rgbaToCSS(c) {
  var r = c.r, g = c.g, b = c.b, a = c.a == null ? 1 : c.a;
  var t = function (v) { return Math.round(v * 255); };
  if (a < 1) return "rgba(" + t(r) + "," + t(g) + "," + t(b) + "," + parseFloat(a.toFixed(3)) + ")";
  return "#" + [r, g, b].map(function (v) { return t(v).toString(16).padStart(2, "0"); }).join("");
}

function paintToCSS(paints) {
  if (!paints || !paints.length) return null;
  var visibles = paints.filter(function (x) { return x.visible !== false; });
  if (!visibles.length) return null;
  var p = visibles[visibles.length - 1];
  if (p.type === "SOLID") {
    var tok = paintToTokenRef(p);
    if (tok) return "var(" + tok.cssName + ")";
    var sc = { r: p.color.r, g: p.color.g, b: p.color.b, a: p.opacity == null ? 1 : p.opacity };
    return rgbaToCSS(sc);
  }
  if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL") {
    var stops = p.gradientStops.map(function (s) {
      return rgbaToCSS(s.color) + " " + Math.round(s.position * 100) + "%";
    }).join(",");
    return p.type === "GRADIENT_LINEAR"
      ? "linear-gradient(90deg," + stops + ")"
      : "radial-gradient(circle," + stops + ")";
  }
  return null;
}

function shadowToCSS(effects) {
  if (!effects) return null;
  var list = effects
    .filter(function (e) { return (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible !== false; })
    .map(function (e) {
      var prefix = e.type === "INNER_SHADOW" ? "inset " : "";
      var spread = e.spread == null ? 0 : e.spread;
      return prefix + e.offset.x + "px " + e.offset.y + "px " + e.radius + "px " + spread + "px " + rgbaToCSS(e.color);
    });
  return list.length ? list.join(",") : null;
}

function blurToCSS(effects) {
  var b = (effects || []).find(function (e) { return e.type === "LAYER_BLUR" && e.visible !== false; });
  return b ? "blur(" + b.radius + "px)" : null;
}

function radiusToCSS(node) {
  if (node.cornerRadius !== undefined && node.cornerRadius !== figma.mixed) return node.cornerRadius + "px";
  if (node.topLeftRadius !== undefined) {
    return node.topLeftRadius + "px " + node.topRightRadius + "px " + node.bottomRightRadius + "px " + node.bottomLeftRadius + "px";
  }
  return null;
}

function strokeToCSS(node) {
  if (!node.strokes || !node.strokes.length) return null;
  var s = node.strokes.find(function (x) { return x.visible !== false; });
  if (!s) return null;
  var sw = node.strokeWeight == null ? 1 : node.strokeWeight;
  var dashed = node.dashPattern && node.dashPattern.length ? "dashed" : "solid";
  var sop = s.opacity == null ? 1 : s.opacity;
  var sc = { r: s.color.r, g: s.color.g, b: s.color.b, a: sop };
  return sw + "px " + dashed + " " + rgbaToCSS(sc);
}

function fontWeight(style) {
  var s = (style || "").toLowerCase();
  if (s.indexOf("thin") >= 0) return 100;
  if (s.indexOf("extralight") >= 0 || s.indexOf("ultra light") >= 0) return 200;
  if (s.indexOf("light") >= 0) return 300;
  if (s.indexOf("medium") >= 0) return 500;
  if (s.indexOf("semibold") >= 0 || s.indexOf("demi") >= 0) return 600;
  if (s.indexOf("extrabold") >= 0 || s.indexOf("ultra") >= 0 || s.indexOf("black") >= 0 || s.indexOf("heavy") >= 0) return 800;
  if (s.indexOf("bold") >= 0) return 700;
  return 400;
}

// ── CSS accumulator ───────────────────────────────────────────
var _counter = 0;
var _classMap = new Map();
var _rules = [];

function resetCSS() { _counter = 0; _classMap.clear(); _rules.length = 0; }

function cls(id) {
  if (!_classMap.has(id)) _classMap.set(id, "el-" + (++_counter));
  return _classMap.get(id);
}

function emitRule(selector, decls) {
  var body = Object.keys(decls)
    .filter(function (k) { return decls[k] != null; })
    .map(function (k) { return "  " + k + ": " + decls[k] + ";"; })
    .join("\n");
  if (body) _rules.push("." + selector + " {\n" + body + "\n}");
}

// ── HTML/CSS tree ─────────────────────────────────────────────
function nodeToHTML(node, depth) {
  depth = depth || 0;
  var c = cls(node.id);
  var ind = "  ".repeat(depth);
  var d = {};

  d["position"] = depth === 0 ? "relative" : "absolute";
  if (depth > 0) { d["left"] = Math.round(node.x) + "px"; d["top"] = Math.round(node.y) + "px"; }
  d["width"] = Math.round(node.width) + "px";
  d["height"] = Math.round(node.height) + "px";
  d["box-sizing"] = "border-box";

  if (node.opacity !== undefined && node.opacity < 1) d["opacity"] = parseFloat(node.opacity.toFixed(3));
  if (node.visible === false) d["display"] = "none";
  if (node.clipsContent) d["overflow"] = "hidden";

  if (node.fills) {
    var f = paintToCSS(node.fills);
    if (f) {
      if (f.indexOf("linear") === 0 || f.indexOf("radial") === 0) d["background"] = f;
      else d["background-color"] = f;
    }
  }

  var bdr = strokeToCSS(node); if (bdr) d["border"] = bdr;
  var rad = radiusToCSS(node); if (rad) d["border-radius"] = rad;
  var shd = shadowToCSS(node.effects); if (shd) d["box-shadow"] = shd;
  var blr = blurToCSS(node.effects); if (blr) d["filter"] = blr;

  if (node.type === "TEXT") {
    var ff = node.fontName !== figma.mixed ? node.fontName : null;
    var fs = node.fontSize !== figma.mixed ? node.fontSize : null;
    var lh = node.lineHeight !== figma.mixed ? node.lineHeight : null;
    var ls = node.letterSpacing !== figma.mixed ? node.letterSpacing : null;
    if (ff) {
      d["font-family"] = "'" + ff.family + "',sans-serif";
      d["font-weight"] = fontWeight(ff.style);
      if (ff.style.toLowerCase().indexOf("italic") >= 0) d["font-style"] = "italic";
    }
    if (fs) d["font-size"] = fs + "px";
    if (lh && lh.unit !== "AUTO") d["line-height"] = lh.unit === "PERCENT" ? (lh.value + "%") : (lh.value + "px");
    if (ls && ls.unit !== "PERCENT") d["letter-spacing"] = ls.value + "px";
    if (node.textAlignHorizontal) {
      var tam = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
      d["text-align"] = tam[node.textAlignHorizontal] || "left";
    }
    if (node.fills) {
      var tc = paintToCSS(node.fills);
      if (tc && tc.indexOf("linear") !== 0 && tc.indexOf("radial") !== 0) d["color"] = tc;
    }
    if (node.textDecoration === "UNDERLINE") d["text-decoration"] = "underline";
    if (node.textDecoration === "STRIKETHROUGH") d["text-decoration"] = "line-through";
    delete d["background-color"]; delete d["background"];
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    d["display"] = "flex";
    d["flex-direction"] = node.layoutMode === "VERTICAL" ? "column" : "row";
    var am = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
    if (node.primaryAxisAlignItems) d["justify-content"] = am[node.primaryAxisAlignItems] || "flex-start";
    if (node.counterAxisAlignItems) d["align-items"] = am[node.counterAxisAlignItems] || "flex-start";
    if (node.itemSpacing) d["gap"] = node.itemSpacing + "px";
    var pt = node.paddingTop == null ? 0 : node.paddingTop;
    var pr = node.paddingRight == null ? 0 : node.paddingRight;
    var pb = node.paddingBottom == null ? 0 : node.paddingBottom;
    var pl = node.paddingLeft == null ? 0 : node.paddingLeft;
    if (pt || pr || pb || pl) d["padding"] = pt + "px " + pr + "px " + pb + "px " + pl + "px";
  }

  emitRule(c, d);

  var children = "";
  if ("children" in node && node.children.length > 0) {
    for (var i = 0; i < node.children.length; i++) {
      children += "\n" + nodeToHTML(node.children[i], depth + 1);
    }
    children += "\n" + ind;
  }

  var tag = "div";
  var content = children;
  if (node.type === "TEXT") {
    tag = "p";
    var raw = typeof node.characters === "string" ? node.characters : "";
    content = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  }

  var safeName = String(node.name).replace(/"/g, "");
  return ind + "<" + tag + ' class="' + c + '" data-figma="' + safeName + '" data-type="' + node.type + '">' + content + "</" + tag + ">";
}

function buildHTML(nodes, pageTitle) {
  resetCSS();
  var bodies = nodes.map(function (n) { return { name: n.name, html: nodeToHTML(n, 0) }; });
  var css = "/* Figbridge — " + pageTitle + " */\n\n* { margin:0; padding:0; box-sizing:border-box; }\n\n" + _rules.join("\n\n");
  var htmlBody = bodies.map(function (b) { return b.html; }).join("\n\n");
  return {
    html: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width,initial-scale=1.0" />\n  <title>' + pageTitle + "</title>\n  <style>\n" + css + "\n  </style>\n</head>\n<body>\n" + htmlBody + "\n</body>\n</html>",
    css: css,
    rawHtml: htmlBody,
    nodeNames: nodes.map(function (n) { return n.name; })
  };
}

// ── Tailwind tree (deterministic arbitrary values) ────────────
function twPx(n) { return Math.round(n) + "px"; }

function nodeToTailwind(node, depth) {
  depth = depth || 0;
  var ind = "  ".repeat(depth);
  var cls = [];

  cls.push(depth === 0 ? "relative" : "absolute");
  if (depth > 0) { cls.push("left-[" + twPx(node.x) + "]"); cls.push("top-[" + twPx(node.y) + "]"); }
  cls.push("w-[" + twPx(node.width) + "]");
  cls.push("h-[" + twPx(node.height) + "]");
  cls.push("box-border");

  if (node.opacity !== undefined && node.opacity < 1) cls.push("opacity-[" + parseFloat(node.opacity.toFixed(3)) + "]");
  if (node.visible === false) cls.push("hidden");
  if (node.clipsContent) cls.push("overflow-hidden");

  if (node.fills) {
    var f = paintToCSS(node.fills);
    if (f && f.indexOf("linear") !== 0 && f.indexOf("radial") !== 0 && node.type !== "TEXT") {
      cls.push("bg-[" + f + "]");
    }
  }

  var rad = radiusToCSS(node);
  if (rad && rad.indexOf(" ") < 0) cls.push("rounded-[" + rad + "]");

  if (node.type === "TEXT") {
    var ff = node.fontName !== figma.mixed ? node.fontName : null;
    var fs = node.fontSize !== figma.mixed ? node.fontSize : null;
    if (fs) cls.push("text-[" + fs + "px]");
    if (ff) cls.push("font-[" + fontWeight(ff.style) + "]");
    if (node.fills) {
      var tc = paintToCSS(node.fills);
      if (tc && tc.indexOf("linear") !== 0 && tc.indexOf("radial") !== 0) cls.push("text-[" + tc + "]");
    }
    if (node.textAlignHorizontal) {
      var tam = { LEFT: "text-left", CENTER: "text-center", RIGHT: "text-right", JUSTIFIED: "text-justify" };
      var v = tam[node.textAlignHorizontal]; if (v) cls.push(v);
    }
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    cls.push("flex");
    cls.push(node.layoutMode === "VERTICAL" ? "flex-col" : "flex-row");
    var am = { MIN: "start", CENTER: "center", MAX: "end", SPACE_BETWEEN: "between" };
    if (node.primaryAxisAlignItems) cls.push("justify-" + (am[node.primaryAxisAlignItems] || "start"));
    if (node.counterAxisAlignItems) cls.push("items-" + (am[node.counterAxisAlignItems] || "start"));
    if (node.itemSpacing) cls.push("gap-[" + node.itemSpacing + "px]");
    var pt = node.paddingTop == null ? 0 : node.paddingTop;
    var pr = node.paddingRight == null ? 0 : node.paddingRight;
    var pb = node.paddingBottom == null ? 0 : node.paddingBottom;
    var pl = node.paddingLeft == null ? 0 : node.paddingLeft;
    if (pt === pr && pr === pb && pb === pl) { if (pt) cls.push("p-[" + pt + "px]"); }
    else {
      if (pt) cls.push("pt-[" + pt + "px]");
      if (pr) cls.push("pr-[" + pr + "px]");
      if (pb) cls.push("pb-[" + pb + "px]");
      if (pl) cls.push("pl-[" + pl + "px]");
    }
  }

  var children = "";
  if ("children" in node && node.children.length > 0) {
    for (var i = 0; i < node.children.length; i++) {
      children += "\n" + nodeToTailwind(node.children[i], depth + 1);
    }
    children += "\n" + ind;
  }

  var tag = "div";
  var content = children;
  if (node.type === "TEXT") {
    tag = "p";
    var raw = typeof node.characters === "string" ? node.characters : "";
    content = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>");
  }

  var safeName = String(node.name).replace(/"/g, "");
  return ind + "<" + tag + ' class="' + cls.join(" ") + '" data-figma="' + safeName + '">' + content + "</" + tag + ">";
}

function buildTailwind(nodes, pageTitle) {
  var htmlBody = nodes.map(function (n) { return nodeToTailwind(n, 0); }).join("\n\n");
  return {
    tailwindHtml: '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width,initial-scale=1.0" />\n  <title>' + pageTitle + '</title>\n  <script src="https://cdn.tailwindcss.com"></script>\n</head>\n<body>\n' + htmlBody + "\n</body>\n</html>",
    tailwindBody: htmlBody
  };
}

// ── Design tokens (variables + paint styles) ──────────────────
function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function extractTokens() {
  var tokens = { colors: {}, numbers: {}, strings: {}, booleans: {} };
  try {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      var modeId = col.defaultModeId;
      var modeName = col.modes.find(function (m) { return m.modeId === modeId; });
      modeName = modeName ? modeName.name : "default";
      for (var j = 0; j < col.variableIds.length; j++) {
        var v = await figma.variables.getVariableByIdAsync(col.variableIds[j]);
        if (!v) continue;
        var val = v.valuesByMode[modeId];
        if (val && val.type === "VARIABLE_ALIAS") continue;
        var key = slug(col.name) + "/" + slug(v.name);
        if (v.resolvedType === "COLOR" && val) tokens.colors[key] = rgbaToCSS(val);
        else if (v.resolvedType === "FLOAT") tokens.numbers[key] = val;
        else if (v.resolvedType === "STRING") tokens.strings[key] = val;
        else if (v.resolvedType === "BOOLEAN") tokens.booleans[key] = val;
      }
    }
  } catch (e) { /* variables API may be unavailable */ }

  try {
    var styles = await figma.getLocalPaintStylesAsync();
    for (var s = 0; s < styles.length; s++) {
      var st = styles[s];
      var css = paintToCSS(st.paints);
      if (css) tokens.colors["style/" + slug(st.name)] = css;
    }
  } catch (e2) { /* ignore */ }

  var cssVars = Object.keys(tokens.colors).map(function (k) {
    return "  --" + k.replace(/\//g, "-") + ": " + tokens.colors[k] + ";";
  }).concat(Object.keys(tokens.numbers).map(function (k) {
    return "  --" + k.replace(/\//g, "-") + ": " + tokens.numbers[k] + ";";
  }));
  var cssVarsFile = ":root {\n" + cssVars.join("\n") + "\n}\n";

  var twColors = {};
  Object.keys(tokens.colors).forEach(function (k) {
    var parts = k.split("/");
    var group = parts[0], name = parts.slice(1).join("-");
    if (!twColors[group]) twColors[group] = {};
    twColors[group][name] = tokens.colors[k];
  });
  var twConfig = "module.exports = {\n  theme: {\n    extend: {\n      colors: " + JSON.stringify(twColors, null, 8).replace(/\n/g, "\n      ") + "\n    }\n  }\n};\n";

  return { tokens: tokens, cssVars: cssVarsFile, tailwindConfig: twConfig };
}

// ── Export drivers ────────────────────────────────────────────
async function exportPayload(nodes, pageName) {
  var html = buildHTML(nodes, pageName);
  var tw = buildTailwind(nodes, pageName);
  var tok = await extractTokens();
  var fileKey = figma.fileKey || null;
  return {
    fileKey: fileKey,
    fileName: figma.root.name,
    pageName: pageName,
    nodeNames: html.nodeNames,
    nodeIds: nodes.map(function (n) { return n.id; }),
    html: html.html,
    css: html.css,
    rawHtml: html.rawHtml,
    tailwindHtml: tw.tailwindHtml,
    tailwindBody: tw.tailwindBody,
    tokens: tok.tokens,
    cssVars: tok.cssVars,
    tailwindConfig: tok.tailwindConfig,
    capturedAt: Date.now()
  };
}

async function exportSelection() {
  var sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: "error", message: "No selection. Select at least one frame." });
    return;
  }
  var payload = await exportPayload(sel.slice(), figma.currentPage.name);
  figma.ui.postMessage(Object.assign({ type: "result" }, payload));
}

async function exportNodes(pageId, nodeIds) {
  var page = figma.root.children.find(function (p) { return p.id === pageId; });
  if (page) await figma.setCurrentPageAsync(page);
  var nodes = [];
  for (var k = 0; k < nodeIds.length; k++) {
    var n = await figma.getNodeByIdAsync(nodeIds[k]);
    if (n) nodes.push(n);
  }
  if (!nodes.length) {
    figma.ui.postMessage({ type: "error", message: "No valid frames found on this page." });
    return;
  }
  var payload = await exportPayload(nodes, figma.currentPage.name);
  figma.ui.postMessage(Object.assign({ type: "result" }, payload));
}

async function exportAllPages() {
  var pageResults = [];
  var all = figma.root.children;
  for (var i = 0; i < all.length; i++) {
    var page = all[i];
    await figma.setCurrentPageAsync(page);
    var frames = page.children.filter(function (n) {
      return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP";
    });
    if (!frames.length) continue;
    var payload = await exportPayload(frames, page.name);
    pageResults.push(Object.assign({ pageId: page.id, frameCount: frames.length }, payload));
    figma.ui.postMessage({ type: "page-progress", pageName: page.name, done: pageResults.length, total: all.length });
  }
  figma.ui.postMessage({ type: "all-pages-result", pages: pageResults });
}

// ── Selection auto-push (for live bridge) ─────────────────────
var _liveBridge = false;
var _debounce = null;

function onSelectionChange() {
  if (!_liveBridge) return;
  if (_debounce) clearTimeout(_debounce);
  _debounce = setTimeout(async function () {
    var sel = figma.currentPage.selection;
    if (!sel.length) return;
    try {
      var payload = await exportPayload(sel.slice(), figma.currentPage.name);
      figma.ui.postMessage(Object.assign({ type: "auto-push" }, payload));
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: "auto-push failed: " + (e && e.message ? e.message : e) });
    }
  }, 400);
}

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  try { await figma.loadAllPagesAsync(); }
  catch (e) { figma.ui.postMessage({ type: "error", message: "loadAllPagesAsync failed: " + (e && e.message ? e.message : e) }); }
  try {
    var stored = await figma.clientStorage.getAsync("liveBridge");
    _liveBridge = !!stored;
  } catch (e2) { _liveBridge = false; }
  sendPageMap();
  figma.ui.postMessage({ type: "bridge-state", enabled: _liveBridge });
  figma.on("currentpagechange", sendPageMap);
  figma.on("selectionchange", onSelectionChange);
})();

// ── Catalog helpers ───────────────────────────────────────────
function categorizeScreen(name) {
  var s = String(name || "").toLowerCase();
  if (/splash|launch/.test(s)) return "splash";
  if (/onboard|welcome|intro|tour/.test(s)) return "onboarding";
  if (/sign\s*in|log\s*in|login|sign\s*up|signup|register|forgot|reset|otp|verif|auth/.test(s)) return "auth";
  if (/home|feed|dashboard|explore|discover/.test(s)) return "home";
  if (/detail|view|read|post|article/.test(s)) return "detail";
  if (/profile|account|settings|preferences/.test(s)) return "settings";
  if (/modal|sheet|popup|dialog|alert|toast/.test(s)) return "overlay";
  if (/write|compose|edit|create|new/.test(s)) return "editor";
  if (/search|filter|sort/.test(s)) return "search";
  if (/empty|placeholder|skeleton/.test(s)) return "state";
  if (/paywall|subscribe|upgrade|billing|checkout/.test(s)) return "commerce";
  if (/error|404|offline|maintenance/.test(s)) return "error";
  return "other";
}

function orderHint(name) {
  var m = String(name || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 9999;
}

function collectTextContent(node, acc) {
  acc = acc || [];
  if (node.type === "TEXT" && typeof node.characters === "string") acc.push(node.characters);
  if ("children" in node) for (var i = 0; i < node.children.length; i++) collectTextContent(node.children[i], acc);
  return acc;
}

function dominantBackground(node) {
  if (node.fills && node.fills.length) {
    var c = paintToCSS(node.fills);
    if (c) return c;
  }
  return null;
}

async function countInstances(node, set) {
  set = set || {};
  if (node.type === "INSTANCE") {
    try {
      var mc = await node.getMainComponentAsync();
      if (mc) {
        var key = mc.name || mc.id;
        set[key] = (set[key] || 0) + 1;
      }
    } catch (e) {}
  }
  if ("children" in node) for (var i = 0; i < node.children.length; i++) await countInstances(node.children[i], set);
  return set;
}

async function listScreens(opts) {
  opts = opts || {};
  var pages = opts.pageId ? figma.root.children.filter(function (p) { return p.id === opts.pageId; }) : figma.root.children;
  var out = [];
  for (var i = 0; i < pages.length; i++) {
    var page = pages[i];
    await figma.setCurrentPageAsync(page);
    var screens = page.children.filter(function (n) {
      if (n.type !== "FRAME" && n.type !== "COMPONENT" && n.type !== "COMPONENT_SET") return false;
      // Skip tiny frames (icons, tokens chips, etc.). 200px floor covers phones (390), tablets, desktop.
      return Math.max(n.width || 0, n.height || 0) >= 200;
    });
    screens.sort(function (a, b) { return orderHint(a.name) - orderHint(b.name); });
    for (var j = 0; j < screens.length; j++) {
      var s = screens[j];
      out.push({
        nodeId: s.id,
        name: s.name,
        pageId: page.id,
        pageName: page.name,
        width: Math.round(s.width),
        height: Math.round(s.height),
        type: s.type,
        category: categorizeScreen(s.name),
        orderHint: orderHint(s.name)
      });
    }
  }
  return out;
}

async function listComponents(opts) {
  opts = opts || {};
  var includeVariants = !!opts.includeVariants;
  var out = [];
  var seen = {};
  var stack = figma.root.children.slice();
  while (stack.length) {
    var n = stack.shift();
    if (n.type === "COMPONENT_SET") {
      var variants = [];
      if (includeVariants && n.children) {
        for (var c = 0; c < n.children.length; c++) {
          var v = n.children[c];
          if (v.type === "COMPONENT") variants.push({ nodeId: v.id, name: v.name, width: Math.round(v.width), height: Math.round(v.height) });
        }
      }
      out.push({ nodeId: n.id, name: n.name, kind: "COMPONENT_SET", variantCount: (n.children || []).length, variants: includeVariants ? variants : undefined });
      seen[n.id] = true;
      continue;
    }
    if (n.type === "COMPONENT" && !seen[n.id]) {
      // Only top-level components (not children of COMPONENT_SET)
      if (!n.parent || n.parent.type !== "COMPONENT_SET") {
        out.push({ nodeId: n.id, name: n.name, kind: "COMPONENT", width: Math.round(n.width), height: Math.round(n.height) });
      }
      continue;
    }
    if ("children" in n && n.children) for (var k = 0; k < n.children.length; k++) stack.push(n.children[k]);
  }
  out.sort(function (a, b) { return String(a.name).localeCompare(String(b.name)); });
  return out;
}

async function describeScreen(nodeId) {
  var node = await figma.getNodeByIdAsync(nodeId);
  if (!node) return { error: "node not found: " + nodeId };
  var page = node;
  while (page && page.type !== "PAGE") page = page.parent;
  var texts = collectTextContent(node).slice(0, 40);
  var bg = dominantBackground(node);
  var instances = await countInstances(node);
  var category = categorizeScreen(node.name);
  var summary =
    "Screen \"" + node.name + "\"" +
    (page ? " on page \"" + page.name + "\"" : "") +
    " — " + Math.round(node.width) + "×" + Math.round(node.height) +
    (bg ? ", background " + bg : "") +
    ", category=" + category + "." +
    (texts.length ? " Text: " + texts.map(function (t) { return JSON.stringify(t); }).join(", ") + "." : "") +
    (Object.keys(instances).length
      ? " Components used: " + Object.keys(instances).map(function (k) { return k + "×" + instances[k]; }).join(", ") + "."
      : "");
  return {
    nodeId: node.id,
    name: node.name,
    pageName: page ? page.name : null,
    width: Math.round(node.width),
    height: Math.round(node.height),
    category: category,
    background: bg,
    textContent: texts,
    instances: instances,
    summary: summary
  };
}

async function exportAppSpec() {
  var screens = await listScreens({});
  var components = await listComponents({ includeVariants: true });
  var tok = await extractTokens();
  // Group screens by category
  var byCategory = {};
  for (var i = 0; i < screens.length; i++) {
    var s = screens[i];
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category].push(s);
  }
  // Inferred flows: contiguous ordered screens per page
  var flows = {};
  for (var j = 0; j < screens.length; j++) {
    var sc = screens[j];
    if (!flows[sc.pageName]) flows[sc.pageName] = [];
    flows[sc.pageName].push({ nodeId: sc.nodeId, name: sc.name, category: sc.category });
  }
  return {
    fileName: figma.root.name,
    generatedAt: Date.now(),
    screens: screens,
    components: components,
    tokens: tok.tokens,
    cssVars: tok.cssVars,
    tailwindConfig: tok.tailwindConfig,
    screensByCategory: byCategory,
    flowsByPage: flows,
    counts: {
      pages: figma.root.children.length,
      screens: screens.length,
      components: components.length
    }
  };
}

// ── Write-side helpers ────────────────────────────────────────
function normalizeHex(s) {
  if (!s) return null;
  var t = String(s).trim().toLowerCase().replace(/\s+/g, "");
  if (t.charAt(0) === "#") t = t.slice(1);
  if (t.length === 3) t = t.split("").map(function (c) { return c + c; }).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(t)) return null;
  return "#" + t;
}

function colorToHex(c) {
  var r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
  return "#" + [r, g, b].map(function (v) { return v.toString(16).padStart(2, "0"); }).join("");
}

function hexToRGB(hex) {
  var h = normalizeHex(hex); if (!h) return null;
  return { r: parseInt(h.slice(1, 3), 16) / 255, g: parseInt(h.slice(3, 5), 16) / 255, b: parseInt(h.slice(5, 7), 16) / 255 };
}

async function applyTextReplacements(root, replacements) {
  if (!replacements || !Object.keys(replacements).length) return 0;
  var keys = Object.keys(replacements);
  var changed = 0;
  var stack = [root];
  while (stack.length) {
    var n = stack.shift();
    if (n.type === "TEXT") {
      if (n.fontName === figma.mixed) continue;
      var txt = String(n.characters || "");
      var next = txt;
      for (var i = 0; i < keys.length; i++) { next = next.split(keys[i]).join(replacements[keys[i]]); }
      if (next !== txt) {
        try { await figma.loadFontAsync(n.fontName); n.characters = next; changed++; }
        catch (e) { /* skip unloadable font */ }
      }
    }
    if ("children" in n && n.children) for (var k = 0; k < n.children.length; k++) stack.push(n.children[k]);
  }
  return changed;
}

async function cloneScreen(args) {
  var src = await figma.getNodeByIdAsync(args.sourceNodeId);
  if (!src) return { ok: false, error: "source not found: " + args.sourceNodeId };
  if (typeof src.clone !== "function") return { ok: false, error: "node is not cloneable (type=" + src.type + ")" };
  var copy = src.clone();
  if (args.name) copy.name = args.name;
  // Place to the right of source if it has a parent frame with x/y
  if ("x" in copy && "x" in src) copy.x = src.x + src.width + 48;
  if ("y" in copy && "y" in src) copy.y = src.y;
  var textChanges = 0;
  if (args.textReplacements) textChanges = await applyTextReplacements(copy, args.textReplacements);
  try { figma.currentPage.selection = [copy]; figma.viewport.scrollAndZoomIntoView([copy]); } catch (e) {}
  return { ok: true, nodeId: copy.id, name: copy.name, textReplacements: textChanges };
}

function scopeToNodes(scope) {
  if (!scope) return figma.currentPage.selection.length ? figma.currentPage.selection : figma.currentPage.children;
  if (scope === "selection") return figma.currentPage.selection;
  if (scope === "page") return figma.currentPage.children;
  if (scope === "file") { var all = []; for (var i = 0; i < figma.root.children.length; i++) all = all.concat(figma.root.children[i].children); return all; }
  return [];
}

async function recolor(args) {
  var mapping = args && args.mapping ? args.mapping : {};
  var keys = Object.keys(mapping);
  if (!keys.length) return { ok: false, error: "mapping required: { '#oldHex': '#newHex', ... }" };
  var normMap = {};
  for (var i = 0; i < keys.length; i++) {
    var k = normalizeHex(keys[i]); var v = hexToRGB(mapping[keys[i]]);
    if (k && v) normMap[k] = v;
  }
  var roots = [];
  if (args && args.nodeId) {
    var n = await figma.getNodeByIdAsync(args.nodeId); if (n) roots.push(n);
  } else {
    roots = scopeToNodes(args && args.scope);
  }
  var changes = 0, visited = 0;
  var stack = roots.slice();
  while (stack.length) {
    var node = stack.shift(); visited++;
    if (node.fills && Array.isArray(node.fills) && node.fills !== figma.mixed) {
      var newFills = node.fills.map(function (p) {
        if (p.type === "SOLID" && p.color) {
          var hex = colorToHex(p.color);
          if (normMap[hex]) { changes++; return Object.assign({}, p, { color: normMap[hex] }); }
        }
        return p;
      });
      node.fills = newFills;
    }
    if (node.strokes && Array.isArray(node.strokes) && node.strokes !== figma.mixed) {
      var newStrokes = node.strokes.map(function (p) {
        if (p.type === "SOLID" && p.color) {
          var hex = colorToHex(p.color);
          if (normMap[hex]) { changes++; return Object.assign({}, p, { color: normMap[hex] }); }
        }
        return p;
      });
      node.strokes = newStrokes;
    }
    if ("children" in node && node.children) for (var c = 0; c < node.children.length; c++) stack.push(node.children[c]);
  }
  return { ok: true, changes: changes, nodesVisited: visited };
}

async function applyTokens(args) {
  // Bind loose SOLID colors to matching local color variables (by hex match).
  var varsByHex = {};
  try {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      for (var j = 0; j < col.variableIds.length; j++) {
        var v = await figma.variables.getVariableByIdAsync(col.variableIds[j]);
        if (!v || v.resolvedType !== "COLOR") continue;
        var val = v.valuesByMode[col.defaultModeId];
        if (!val || val.type === "VARIABLE_ALIAS") continue;
        var hex = colorToHex(val);
        if (!varsByHex[hex]) varsByHex[hex] = v;
      }
    }
  } catch (e) { return { ok: false, error: "variables API unavailable: " + (e && e.message ? e.message : e) }; }

  var root = args && args.nodeId ? await figma.getNodeByIdAsync(args.nodeId) : null;
  var roots = root ? [root] : (figma.currentPage.selection.length ? figma.currentPage.selection.slice() : figma.currentPage.children.slice());
  var bound = 0, unbound = 0;
  var stack = roots.slice();
  while (stack.length) {
    var node = stack.shift();
    if (node.fills && Array.isArray(node.fills) && node.fills !== figma.mixed) {
      var newFills = node.fills.map(function (p) {
        if (p.type !== "SOLID" || !p.color) return p;
        if (p.boundVariables && p.boundVariables.color) return p;
        var hex = colorToHex(p.color);
        var match = varsByHex[hex];
        if (match) { bound++; return figma.variables.setBoundVariableForPaint(p, "color", match); }
        unbound++; return p;
      });
      node.fills = newFills;
    }
    if ("children" in node && node.children) for (var k = 0; k < node.children.length; k++) stack.push(node.children[k]);
  }
  return { ok: true, bound: bound, unboundRemaining: unbound, availableColorVariables: Object.keys(varsByHex).length };
}

function isIconCandidate(node) {
  var name = String(node.name || "").toLowerCase();
  if (/^(ic|icon)[-_/]/.test(name)) return true;
  if (node.parent && node.parent.type === "PAGE" && /icons?/i.test(node.parent.name || "")) return true;
  if ((node.type === "FRAME" || node.type === "COMPONENT") && node.width <= 64 && node.height <= 64) return true;
  return false;
}

function hasImageFill(node) {
  if (!node.fills || !Array.isArray(node.fills)) return false;
  return node.fills.some(function (p) { return p.type === "IMAGE" && p.visible !== false; });
}

function bytesToBase64(u8) {
  var chunk = 0x8000, parts = [];
  for (var i = 0; i < u8.length; i += chunk) {
    parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + chunk)));
  }
  return figma.base64Encode ? figma.base64Encode(u8) : btoa(parts.join(""));
}

async function listAssets(args) {
  var kind = (args && args.kind) || "icon";
  var limit = args && typeof args.limit === "number" ? args.limit : 40;
  var results = [];
  var stack = figma.root.children.slice();
  while (stack.length && results.length < limit) {
    var n = stack.shift();
    var match = false, format = "SVG";
    if (kind === "icon" && isIconCandidate(n)) { match = true; format = "SVG"; }
    else if (kind === "image" && hasImageFill(n)) { match = true; format = "PNG"; }
    else if (kind === "illustration" && (n.type === "FRAME" || n.type === "COMPONENT") && n.width >= 200 && n.height >= 200) {
      var parentName = n.parent && n.parent.name ? String(n.parent.name).toLowerCase() : "";
      if (/illust|art|graphic|scene|empty/.test(parentName) || /illust|art|scene/.test(String(n.name).toLowerCase())) { match = true; format = "SVG"; }
    }
    if (match) {
      try {
        var bytes = await n.exportAsync({ format: format, constraint: format === "PNG" ? { type: "SCALE", value: 2 } : undefined });
        results.push({
          nodeId: n.id, name: n.name, format: format, bytes: bytes.length,
          data: bytesToBase64(bytes),
          width: Math.round(n.width), height: Math.round(n.height)
        });
      } catch (e) { /* skip un-exportable */ }
    }
    if (results.length >= limit) break;
    if ("children" in n && n.children) for (var i = 0; i < n.children.length; i++) stack.push(n.children[i]);
  }
  return { ok: true, kind: kind, count: results.length, limit: limit, assets: results };
}

async function lintDesignSystem(args) {
  args = args || {};
  var findings = [];
  var roots = args.pageId ? figma.root.children.filter(function (p) { return p.id === args.pageId; }) : figma.root.children;
  var nameCounts = {};
  var componentsUsed = {};
  var componentsDefined = [];
  for (var p = 0; p < roots.length; p++) {
    var page = roots[p];
    await figma.setCurrentPageAsync(page);
    var stack = page.children.slice();
    while (stack.length) {
      var n = stack.shift();
      if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") componentsDefined.push({ id: n.id, name: n.name });
      if (n.type === "INSTANCE") {
        try {
          var mc = await n.getMainComponentAsync();
          if (mc) componentsUsed[mc.id] = (componentsUsed[mc.id] || 0) + 1;
        } catch (e) {}
      }
      if (n.name) nameCounts[n.name] = (nameCounts[n.name] || 0) + 1;
      // unbound colors
      if (n.fills && Array.isArray(n.fills) && n.fills !== figma.mixed) {
        for (var f = 0; f < n.fills.length; f++) {
          var fp = n.fills[f];
          if (fp.type === "SOLID" && fp.visible !== false && (!fp.boundVariables || !fp.boundVariables.color)) {
            findings.push({ rule: "unbound-color", nodeId: n.id, name: n.name, detail: colorToHex(fp.color) });
          }
        }
      }
      // non-grid spacing (divisible by 4)
      if (n.layoutMode && n.layoutMode !== "NONE") {
        var vals = { paddingTop: n.paddingTop, paddingBottom: n.paddingBottom, paddingLeft: n.paddingLeft, paddingRight: n.paddingRight, itemSpacing: n.itemSpacing };
        Object.keys(vals).forEach(function (k) {
          var v = vals[k];
          if (typeof v === "number" && v > 0 && v % 4 !== 0) {
            findings.push({ rule: "non-grid-spacing", nodeId: n.id, name: n.name, detail: k + "=" + v });
          }
        });
      }
      if ("children" in n && n.children) for (var c = 0; c < n.children.length; c++) stack.push(n.children[c]);
    }
  }
  // orphan components
  for (var d = 0; d < componentsDefined.length; d++) {
    var def = componentsDefined[d];
    if (!componentsUsed[def.id]) findings.push({ rule: "orphan-component", nodeId: def.id, name: def.name, detail: "defined but not instanced" });
  }
  // duplicate names (>3 is suspicious for frames)
  Object.keys(nameCounts).forEach(function (name) {
    if (nameCounts[name] >= 3 && /[A-Za-z]/.test(name)) findings.push({ rule: "duplicate-name", nodeId: null, name: name, detail: "used " + nameCounts[name] + " times" });
  });
  // per-rule counts (computed over ALL findings, before truncation)
  var counts = {};
  for (var fi = 0; fi < findings.length; fi++) {
    var rr = findings[fi].rule;
    counts[rr] = (counts[rr] || 0) + 1;
  }
  var MAX = 1000;
  var truncated = findings.length > MAX;
  return { ok: true, findingsCount: findings.length, counts: counts, findings: findings.slice(0, MAX), truncated: truncated };
}

// ── Agent commands (from MCP via SSE → UI → here) ─────────────
async function handleCommand(cmdId, action, args) {
  try {
    if (action === "select") {
      var node = null;
      if (args && args.nodeId) {
        node = await figma.getNodeByIdAsync(args.nodeId);
      } else if (args && args.name) {
        var needle = String(args.name).toLowerCase();
        // Breadth-first scan across all pages
        var stack = figma.root.children.slice();
        while (stack.length) {
          var n = stack.shift();
          if (n.name && String(n.name).toLowerCase().indexOf(needle) >= 0
              && (n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP" || n.type === "INSTANCE" || n.type === "TEXT")) {
            node = n; break;
          }
          if ("children" in n && n.children) { for (var k = 0; k < n.children.length; k++) stack.push(n.children[k]); }
        }
      }
      if (!node) return { ok: false, error: "node not found" };
      var page = node;
      while (page && page.type !== "PAGE") page = page.parent;
      if (page) await figma.setCurrentPageAsync(page);
      if (node.type !== "PAGE") figma.currentPage.selection = [node];
      try { figma.viewport.scrollAndZoomIntoView([node]); } catch (e) {}
      return { ok: true, selected: { id: node.id, name: node.name, type: node.type, pageName: page ? page.name : null } };
    }
    if (action === "export-node") {
      if (!args || !args.nodeId) return { ok: false, error: "nodeId required" };
      var target = await figma.getNodeByIdAsync(args.nodeId);
      if (!target) return { ok: false, error: "node not found: " + args.nodeId };
      var p2 = target;
      while (p2 && p2.type !== "PAGE") p2 = p2.parent;
      if (p2) await figma.setCurrentPageAsync(p2);
      var payload = await exportPayload([target], p2 ? p2.name : figma.currentPage.name);
      // Tell the UI so it pushes to the bridge (which persists + broadcasts).
      figma.ui.postMessage(Object.assign({ type: "auto-push" }, payload));
      return { ok: true, nodeId: target.id, nodeName: target.name };
    }
    if (action === "list-screens") {
      var screens = await listScreens(args || {});
      return { ok: true, screens: screens, count: screens.length };
    }
    if (action === "list-components") {
      var comps = await listComponents(args || {});
      return { ok: true, components: comps, count: comps.length };
    }
    if (action === "describe-screen") {
      if (!args || !args.nodeId) return { ok: false, error: "nodeId required" };
      var desc = await describeScreen(args.nodeId);
      return Object.assign({ ok: true }, desc);
    }
    if (action === "export-app-spec") {
      var spec = await exportAppSpec();
      return { ok: true, spec: spec };
    }
    if (action === "clone-screen") {
      if (!args || !args.sourceNodeId) return { ok: false, error: "sourceNodeId required" };
      return await cloneScreen(args);
    }
    if (action === "recolor") return await recolor(args || {});
    if (action === "apply-tokens") return await applyTokens(args || {});
    if (action === "list-assets") return await listAssets(args || {});
    if (action === "lint-ds") return await lintDesignSystem(args || {});
    if (action === "list-pages") {
      var pages = figma.root.children.map(function (pp) {
        return {
          id: pp.id, name: pp.name,
          frameCount: pp.children.filter(function (n) { return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP"; }).length,
          isCurrent: pp.id === figma.currentPage.id
        };
      });
      return { ok: true, pages: pages, count: pages.length };
    }
    if (action === "list-frames") {
      var pageId = args && args.pageId;
      var page = pageId ? figma.root.children.find(function (pp) { return pp.id === pageId; }) : figma.currentPage;
      if (!page) return { ok: false, error: "page not found: " + pageId };
      await figma.setCurrentPageAsync(page);
      var frames = page.children.map(_summarizeNode);
      return { ok: true, pageId: page.id, pageName: page.name, frames: frames, count: frames.length };
    }
    if (action === "export-all") {
      var pageResults = [];
      var all = figma.root.children;
      for (var ai = 0; ai < all.length; ai++) {
        var pg = all[ai];
        await figma.setCurrentPageAsync(pg);
        var fr = pg.children.filter(function (n) { return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP"; });
        if (!fr.length) continue;
        var payload = await exportPayload(fr, pg.name);
        pageResults.push({ pageId: pg.id, pageName: pg.name, frameCount: fr.length, nodeNames: payload.nodeNames, html: payload.html, css: payload.css, tailwindHtml: payload.tailwindHtml, tokens: payload.tokens, cssVars: payload.cssVars });
      }
      return { ok: true, pageCount: pageResults.length, pages: pageResults };
    }
    if (action === "agent-bundle") {
      if (typeof FrameshiftAgent === "undefined") return { ok: false, error: "agent bundle module not loaded" };
      var roots;
      if (args && args.nodeId) {
        var n = await figma.getNodeByIdAsync(args.nodeId);
        if (!n) return { ok: false, error: "node not found: " + args.nodeId };
        roots = [n];
      } else {
        var sel = figma.currentPage.selection;
        roots = sel.length ? sel.slice() : figma.currentPage.children.filter(function (x) {
          return x.type === "FRAME" || x.type === "COMPONENT" || x.type === "COMPONENT_SET";
        });
      }
      if (!roots.length) return { ok: false, error: "no frames to export" };
      var files = await FrameshiftAgent.computeAgentBundle(roots, {
        budget: (args && args.budget) || "medium",
        screenshots: !!(args && args.screenshots),
        codePaths: (args && args.codePaths) || [],
      });
      // Serialize: text as string, binary (Uint8Array) as base64.
      var out = files.map(function (f) {
        if (typeof f.data === "string") return { path: f.path, kind: "text", data: f.data };
        var u8 = f.data;
        var chunk = 0x8000, parts = [];
        for (var i = 0; i < u8.length; i += chunk) parts.push(String.fromCharCode.apply(null, u8.subarray(i, i + chunk)));
        var b64 = (figma.base64Encode ? figma.base64Encode(u8) : btoa(parts.join("")));
        return { path: f.path, kind: "base64", data: b64, bytes: u8.length };
      });
      return { ok: true, pageName: figma.currentPage.name, fileCount: out.length, files: out };
    }
    return { ok: false, error: "unknown action: " + action };
  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

// ── Router ────────────────────────────────────────────────────
figma.ui.onmessage = async function (msg) {
  switch (msg.type) {
    case "get-pages":        sendPageMap(); break;
    case "get-frames":       await sendFramesForPage(msg.pageId); break;
    case "get-children":     await sendChildrenFor(msg.nodeId); break;
    case "export-selection": await exportSelection(); break;
    case "export-nodes":     await exportNodes(msg.pageId, msg.nodeIds); break;
    case "cmd": {
      var body = await handleCommand(msg.cmdId, msg.action, msg.args);
      figma.ui.postMessage({ type: "cmd-result", cmdId: msg.cmdId, body: body });
      break;
    }
    case "export-all":       await exportAllPages(); break;
    case "set-bridge":
      _liveBridge = !!msg.enabled;
      try { await figma.clientStorage.setAsync("liveBridge", _liveBridge); } catch (e) {}
      figma.ui.postMessage({ type: "bridge-state", enabled: _liveBridge });
      if (_liveBridge) onSelectionChange();
      break;
    case "export-agent":
      if (typeof FrameshiftAgent !== "undefined") await FrameshiftAgent.exportAgentBundle(msg);
      else figma.ui.postMessage({ type: "error", message: "Agent bundle module not loaded." });
      break;
    case "close": figma.closePlugin(); break;
  }
};

// ============================================================
// FRAMESHIFT AGENT BUNDLE (ported from figma2code)
// Self-contained IIFE — no name collisions with Figbridge code above.
// Exposes: FrameshiftAgent.exportAgentBundle(msg)
// ============================================================
var FrameshiftAgent = (function () {
// ── Page map ──────────────────────────────────────────────────
function sendPageMap() {
  var pages = figma.root.children.map(function (page) {
    return {
      id: page.id,
      name: page.name,
      frameCount: page.children.filter(function (n) {
        return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP";
      }).length,
      isCurrent: page.id === figma.currentPage.id
    };
  });
  figma.ui.postMessage({ type: "pages", pages: pages });
}

// ── Frames for a page ─────────────────────────────────────────
async function sendFramesForPage(pageId) {
  var page = figma.root.children.find(function (p) { return p.id === pageId; });
  if (!page) {
    figma.ui.postMessage({ type: "error", message: "Page " + pageId + " not found." });
    return;
  }
  await figma.setCurrentPageAsync(page);
  var frames = page.children
    .filter(function (n) { return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP"; })
    .map(function (n) {
      return { id: n.id, name: n.name, width: Math.round(n.width), height: Math.round(n.height), type: n.type };
    });
  figma.ui.postMessage({ type: "frames", pageId: pageId, pageName: page.name, frames: frames });
}

// ── CSS helpers ───────────────────────────────────────────────
function rgbaToCSS(c) {
  var r = c.r, g = c.g, b = c.b, a = c.a == null ? 1 : c.a;
  var t = function (v) { return Math.round(v * 255); };
  if (a < 1) return "rgba(" + t(r) + "," + t(g) + "," + t(b) + "," + parseFloat(a.toFixed(3)) + ")";
  return "#" + [r, g, b].map(function (v) { return t(v).toString(16).padStart(2, "0"); }).join("");
}

function paintToCSS(paints) {
  if (!paints || !paints.length) return null;
  var visibles = paints.filter(function (x) { return x.visible !== false; });
  if (!visibles.length) return null;
  var p = visibles[visibles.length - 1];
  if (p.type === "SOLID") {
    var tok = paintToTokenRef(p);
    if (tok) return "var(" + tok.cssName + ")";
    var sc = { r: p.color.r, g: p.color.g, b: p.color.b, a: p.opacity == null ? 1 : p.opacity };
    return rgbaToCSS(sc);
  }
  if (p.type === "GRADIENT_LINEAR" || p.type === "GRADIENT_RADIAL") {
    var stops = p.gradientStops.map(function (s) {
      return rgbaToCSS(s.color) + " " + Math.round(s.position * 100) + "%";
    }).join(",");
    if (p.type === "GRADIENT_LINEAR") {
      var angle = gradientAngle(p.gradientTransform);
      return "linear-gradient(" + angle + "deg," + stops + ")";
    }
    return "radial-gradient(circle," + stops + ")";
  }
  return null;
}

function gradientAngle(t) {
  if (!t || !t[0] || !t[1]) return 90;
  var a = t[0][0], c = t[1][0];
  var deg = Math.atan2(c, a) * 180 / Math.PI + 90;
  return Math.round(((deg % 360) + 360) % 360);
}

function shadowToCSS(effects) {
  if (!effects) return null;
  var list = effects
    .filter(function (e) { return (e.type === "DROP_SHADOW" || e.type === "INNER_SHADOW") && e.visible !== false; })
    .map(function (e) {
      var prefix = e.type === "INNER_SHADOW" ? "inset " : "";
      var spread = e.spread == null ? 0 : e.spread;
      return prefix + e.offset.x + "px " + e.offset.y + "px " + e.radius + "px " + spread + "px " + rgbaToCSS(e.color);
    });
  return list.length ? list.join(",") : null;
}

function blurToCSS(effects) {
  var b = (effects || []).find(function (e) { return e.type === "LAYER_BLUR" && e.visible !== false; });
  return b ? "blur(" + b.radius + "px)" : null;
}

function radiusToCSS(node) {
  var mixed = typeof figma !== "undefined" ? figma.mixed : null;
  if (typeof node.cornerRadius === "number") return node.cornerRadius + "px";
  if (node.cornerRadius === mixed || node.topLeftRadius !== undefined) {
    var tl = node.topLeftRadius || 0, tr = node.topRightRadius || 0;
    var br = node.bottomRightRadius || 0, bl = node.bottomLeftRadius || 0;
    if (tl === tr && tr === br && br === bl) return tl + "px";
    return tl + "px " + tr + "px " + br + "px " + bl + "px";
  }
  return null;
}

function strokeToCSS(node) {
  if (!node.strokes || !node.strokes.length) return null;
  var s = node.strokes.find(function (x) { return x.visible !== false; });
  if (!s) return null;
  var dashed = node.dashPattern && node.dashPattern.length ? "dashed" : "solid";
  var sop = s.opacity == null ? 1 : s.opacity;
  var sc = { r: s.color.r, g: s.color.g, b: s.color.b, a: sop };
  var stok = paintToTokenRef(s);
  var color = stok ? "var(" + stok.cssName + ")" : rgbaToCSS(sc);
  // Mixed per-side weights → per-side declarations
  var ind = node.individualStrokeWeights;
  if (ind && (ind.top !== ind.right || ind.right !== ind.bottom || ind.bottom !== ind.left)) {
    return {
      "border-top":    ind.top    + "px " + dashed + " " + color,
      "border-right":  ind.right  + "px " + dashed + " " + color,
      "border-bottom": ind.bottom + "px " + dashed + " " + color,
      "border-left":   ind.left   + "px " + dashed + " " + color,
    };
  }
  var sw = node.strokeWeight == null ? 1 : node.strokeWeight;
  return sw + "px " + dashed + " " + color;
}

function fontWeight(style) {
  var s = (style || "").toLowerCase();
  if (s.indexOf("thin") >= 0) return 100;
  if (s.indexOf("extralight") >= 0 || s.indexOf("ultra light") >= 0) return 200;
  if (s.indexOf("light") >= 0) return 300;
  if (s.indexOf("medium") >= 0) return 500;
  if (s.indexOf("semibold") >= 0 || s.indexOf("demi") >= 0) return 600;
  if (s.indexOf("extrabold") >= 0 || s.indexOf("ultra") >= 0 || s.indexOf("black") >= 0 || s.indexOf("heavy") >= 0) return 800;
  if (s.indexOf("bold") >= 0) return 700;
  return 400;
}

// ── CSS accumulator ───────────────────────────────────────────
var _counter = 0;
var _classMap = new Map();
var _nameUsed = new Map();
var _rules = [];
var _mode = "css"; // "css" | "tailwind" | "react"
var _minify = false;
var _varMap = {}; // { [variableId]: { cssName, value } }
var _varByHex = {}; // "#rrggbb" → { cssName, swiftName, name }
var _assetCache = {}; // { [nodeId]: { kind: 'svg'|'png', data: string } }
var _textStyleMap = {}; // { [styleId]: { className, decls } }
var _emittedSelectors = new Set();
var _slugMap = new Map();   // node.id → slug
var _slugUsed = new Map();  // slug → count
var _slugLock = {};         // persisted node.id → slug overrides
var _componentMap = {};     // figmaComponentName → code import path
var _mainCompCache = {};    // instanceNode.id → mainComponent.name (resolved async)

function mainComponentName(node) {
  if (!node || node.type !== "INSTANCE") return null;
  if (node.id && _mainCompCache[node.id]) return _mainCompCache[node.id];
  // In dynamic-page mode `node.mainComponent` throws — guard it.
  try {
    var mc = node.mainComponent;
    return mc && mc.name ? mc.name : null;
  } catch (e) { return null; }
}

async function prefetchMainComponents(roots) {
  var queue = (roots || []).slice();
  while (queue.length) {
    var n = queue.shift();
    if (!n) continue;
    if (n.type === "INSTANCE" && typeof n.getMainComponentAsync === "function") {
      try {
        var mc = await n.getMainComponentAsync();
        if (mc && mc.name) _mainCompCache[n.id] = mc.name;
      } catch (e) { /* ignore */ }
    }
    if (n.children && n.children.length) {
      for (var i = 0; i < n.children.length; i++) queue.push(n.children[i]);
    }
  }
}

function resetMainCompCache() { _mainCompCache = {}; }

function resetCSS(mode) { _counter = 0; _classMap.clear(); _nameUsed.clear(); _rules.length = 0; _mode = mode || "css"; _emittedSelectors.clear(); _slugMap.clear(); _slugUsed.clear(); }
function setSlugLock(lock) { _slugLock = lock || {}; }
function getSlugLock() {
  var out = {};
  _slugMap.forEach(function (v, k) { out[k] = v; });
  return out;
}
function setTextStyleMap(m) { _textStyleMap = m || {}; }

async function loadTextStyles(roots) {
  if (typeof figma === "undefined" || !figma.getStyleByIdAsync) return {};
  var ids = {};
  function walk(n) {
    if (!n) return;
    if (n.textStyleId && n.textStyleId !== figma.mixed) ids[n.textStyleId] = true;
    if (n.children) for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  }
  for (var r = 0; r < roots.length; r++) walk(roots[r]);
  var out = {};
  var keys = Object.keys(ids);
  for (var k = 0; k < keys.length; k++) {
    try {
      var s = await figma.getStyleByIdAsync(keys[k]);
      if (!s) continue;
      var decls = {};
      if (s.fontName) {
        decls["font-family"] = "'" + s.fontName.family + "',sans-serif";
        decls["font-weight"] = fontWeight(s.fontName.style);
        if (s.fontName.style && s.fontName.style.toLowerCase().indexOf("italic") >= 0) decls["font-style"] = "italic";
      }
      if (s.fontSize) decls["font-size"] = s.fontSize + "px";
      if (s.lineHeight && s.lineHeight.unit !== "AUTO") {
        decls["line-height"] = s.lineHeight.unit === "PERCENT" ? s.lineHeight.value + "%" : s.lineHeight.value + "px";
      }
      if (s.letterSpacing && s.letterSpacing.unit !== "PERCENT") decls["letter-spacing"] = s.letterSpacing.value + "px";
      if (s.textDecoration === "UNDERLINE") decls["text-decoration"] = "underline";
      if (s.textDecoration === "STRIKETHROUGH") decls["text-decoration"] = "line-through";
      out[keys[k]] = { className: "text-" + kebab(s.name), decls: decls };
    } catch (e) {}
  }
  return out;
}

var TEXT_STYLE_KEYS = ["font-family", "font-weight", "font-style", "font-size", "line-height", "letter-spacing", "text-decoration"];
function kebab(s) {
  // Insert dash at camelCase boundaries (SectionLabel → Section-Label) BEFORE
  // lowercasing so real word breaks survive in the slug. Preserve letter+digit
  // clusters (S1_Home → s1-home, ink2 → ink2) — screen prefixes and numbered
  // tokens read best glued together.
  var str = String(s || "").replace(/([a-z])([A-Z])/g, "$1-$2");
  var k = str.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  return k || "el";
}
function setVariableMap(map) {
  _varMap = map || {};
  // Reverse index: "#rrggbb" → variable cssName / swiftName, so a raw SOLID
  // fill (hex) gets emitted as var(--…) / Color("…") in ported output.
  _varByHex = {};
  var ids = Object.keys(_varMap);
  for (var i = 0; i < ids.length; i++) {
    var e = _varMap[ids[i]];
    if (!e) continue;
    var isColor = e.type === "color" || e.type === "COLOR" || (typeof e.value === "string" && e.value.charAt(0) === "#");
    if (!isColor) continue;
    var v = String(e.value || "").toLowerCase();
    var m = /^#([0-9a-f]{6})$/.exec(v);
    if (!m) continue;
    _varByHex["#" + m[1]] = {
      cssName: e.cssName,
      swiftName: sanitizeSwiftIdent(e.name || e.cssName),
      name: e.name || e.cssName,
    };
  }
}

function sanitizeSwiftIdent(raw) {
  var s = String(raw || "").replace(/^--/, "").replace(/^-+|-+$/g, "");
  s = s.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  s = s.replace(/[\/_\s]+/g, "-").replace(/-+/g, "-").toLowerCase();
  var parts = s.split("-").filter(Boolean);
  if (!parts.length) return "color";
  return parts[0] + parts.slice(1).map(function (p) { return p.charAt(0).toUpperCase() + p.slice(1); }).join("");
}

function paintToTokenRef(paint) {
  if (!paint || paint.type !== "SOLID" || !paint.color) return null;
  var op = paint.opacity == null ? 1 : paint.opacity;
  if (op < 1) return null;
  var t = function (v) { return Math.round(v * 255); };
  var hex = "#" + [paint.color.r, paint.color.g, paint.color.b]
    .map(function (v) { return t(v).toString(16).padStart(2, "0"); }).join("").toLowerCase();
  return _varByHex[hex] || null;
}
function setAssetCache(cache) { _assetCache = cache || {}; }

function isVectorLike(node) {
  var t = node && node.type;
  return t === "VECTOR" || t === "STAR" || t === "POLYGON" || t === "LINE" || t === "BOOLEAN_OPERATION" || t === "ELLIPSE";
}
function hasImageFill(node) {
  if (!node || !node.fills || node.fills === figma.mixed) return false;
  for (var i = 0; i < node.fills.length; i++) {
    if (node.fills[i].type === "IMAGE" && node.fills[i].visible !== false) return true;
  }
  return false;
}

function bytesToBase64(u8) {
  if (typeof figma !== "undefined" && figma.base64Encode) return figma.base64Encode(u8);
  if (typeof Buffer !== "undefined") return Buffer.from(u8).toString("base64");
  var s = "";
  for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return typeof btoa === "function" ? btoa(s) : s;
}

async function prefetchAssets(roots) {
  var cache = {};
  async function walk(node) {
    if (!node) return;
    if (isVectorLike(node)) {
      try {
        var sbytes = await node.exportAsync({ format: "SVG" });
        var svg = typeof TextDecoder !== "undefined" ? new TextDecoder().decode(sbytes) : "";
        cache[node.id] = { kind: "svg", data: svg };
        return;
      } catch (e) {}
    } else if (hasImageFill(node)) {
      try {
        var pbytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 2 } });
        cache[node.id] = { kind: "png", data: "data:image/png;base64," + bytesToBase64(pbytes) };
      } catch (e) {}
    }
    if (node.children && node.children.length) {
      for (var i = 0; i < node.children.length; i++) await walk(node.children[i]);
    }
  }
  for (var r = 0; r < roots.length; r++) await walk(roots[r]);
  return cache;
}

function sanitizeVarName(s) {
  return "--" + String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function resolveBoundVar(node, prop) {
  var bv = node && node.boundVariables && node.boundVariables[prop];
  if (!bv) return null;
  var id = null;
  if (Array.isArray(bv)) { if (bv[0] && bv[0].id) id = bv[0].id; }
  else if (bv.id) id = bv.id;
  if (!id) return null;
  var v = _varMap[id];
  return v ? "var(" + v.cssName + ")" : null;
}

async function loadVariables() {
  if (typeof figma === "undefined" || !figma.variables || !figma.variables.getLocalVariablesAsync) return {};
  try {
    var vars = await figma.variables.getLocalVariablesAsync();
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var colMap = {};
    cols.forEach(function (c) { colMap[c.id] = c; });
    var map = {};
    function valueToCSS(v, val) {
      if (v.resolvedType === "COLOR") return { css: rgbaToCSS({ r: val.r, g: val.g, b: val.b, a: val.a == null ? 1 : val.a }), type: "color", raw: null };
      if (v.resolvedType === "FLOAT")  return { css: val + "px", type: "dimension", raw: val + "px" };
      if (v.resolvedType === "BOOLEAN") return { css: String(val), type: "boolean", raw: !!val };
      return { css: String(val), type: "string", raw: String(val) };
    }
    vars.forEach(function (v) {
      var col = colMap[v.variableCollectionId];
      if (!col) return;
      var defaultMode = col.defaultModeId;
      var valuesByMode = {};
      if (col.modes && col.modes.length) {
        col.modes.forEach(function (m) {
          var raw = v.valuesByMode[m.modeId];
          if (raw == null) return;
          var c = valueToCSS(v, raw);
          valuesByMode[m.name] = c.css;
        });
      }
      var val = v.valuesByMode[defaultMode];
      if (val == null) return;
      var c = valueToCSS(v, val);
      map[v.id] = {
        cssName: sanitizeVarName(v.name), value: c.css, name: v.name,
        type: c.type, rawValue: c.type === "color" ? c.css : c.raw,
        valuesByMode: valuesByMode,
      };
    });
    return map;
  } catch (e) {
    return {};
  }
}

// ── Design tokens JSON (W3C DTCG format) ──────────────────────
function buildTokensJSON(varMap) {
  var root = {};
  var ids = Object.keys(varMap || {});
  ids.forEach(function (id) {
    var entry = varMap[id];
    if (!entry || !entry.name) return;
    var parts = String(entry.name).split("/").map(function (s) {
      return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    }).filter(Boolean);
    if (!parts.length) return;
    var node = root;
    for (var i = 0; i < parts.length - 1; i++) {
      if (!node[parts[i]] || typeof node[parts[i]] !== "object" || node[parts[i]].$value !== undefined) node[parts[i]] = {};
      node = node[parts[i]];
    }
    node[parts[parts.length - 1]] = {
      "$type": entry.type || "string",
      "$value": entry.rawValue != null ? entry.rawValue : entry.value,
    };
  });
  return JSON.stringify(root, null, 2);
}

// Deterministic slug: ancestor-kebab-path, stable across runs; survives renames via lockfile.
function slugFor(node, parentSlug) {
  if (!node || !node.id) return "";
  if (_slugMap.has(node.id)) return _slugMap.get(node.id);
  if (_slugLock[node.id]) {
    _slugMap.set(node.id, _slugLock[node.id]);
    return _slugLock[node.id];
  }
  var base = kebab(typeof node.name === "string" ? node.name : "node");
  var prefix = parentSlug ? parentSlug + "/" : "";
  var candidate = prefix + base;
  var count = _slugUsed.get(candidate) || 0;
  var final = count === 0 ? candidate : candidate + "-" + count;
  _slugUsed.set(candidate, count + 1);
  _slugMap.set(node.id, final);
  return final;
}

// Walk the tree assigning slugs top-down so children get path-based ids.
function assignSlugs(nodes, parentSlug) {
  if (!nodes) return;
  for (var i = 0; i < nodes.length; i++) {
    var n = nodes[i];
    if (!n || !n.id) continue;
    var s = slugFor(n, parentSlug);
    if (n.children && n.children.length) assignSlugs(n.children, s);
  }
}

function cls(node) {
  var id = typeof node === "string" ? node : node.id;
  if (_classMap.has(id)) return _classMap.get(id);
  var name;
  var mcn = node && node.type === "INSTANCE" ? mainComponentName(node) : null;
  if (mcn) {
    name = "i-" + kebab(mcn);
  } else {
    var base = kebab(typeof node === "string" ? "" : node.name);
    var count = _nameUsed.get(base) || 0;
    name = count === 0 ? base : base + "-" + count;
    _nameUsed.set(base, count + 1);
  }
  _counter++;
  _classMap.set(id, name);
  return name;
}

function emitRule(selector, decls) {
  if (_emittedSelectors.has(selector)) return;
  var body = Object.keys(decls)
    .filter(function (k) { return decls[k] != null; })
    .map(function (k) { return "  " + k + ": " + decls[k] + ";"; })
    .join("\n");
  if (body) {
    _rules.push({ selector: selector, body: body });
    _emittedSelectors.add(selector);
  }
}

function serializeRules() {
  var groups = [];
  var byBody = new Map();
  for (var i = 0; i < _rules.length; i++) {
    var r = _rules[i];
    if (byBody.has(r.body)) {
      groups[byBody.get(r.body)].selectors.push(r.selector);
    } else {
      byBody.set(r.body, groups.length);
      groups.push({ selectors: [r.selector], body: r.body });
    }
  }
  return groups.map(function (g) {
    return g.selectors.map(function (s) { return "." + s; }).join(",\n") + " {\n" + g.body + "\n}";
  }).join("\n\n");
}

// ── Tailwind translator ───────────────────────────────────────
function escArb(v) { return String(v).replace(/\s+/g, "_"); }
function declsToTailwind(d) {
  var out = [];
  var jmap = { "flex-start": "justify-start", "center": "justify-center", "flex-end": "justify-end", "space-between": "justify-between" };
  var amap = { "flex-start": "items-start", "center": "items-center", "flex-end": "items-end" };
  var tmap = { left: "text-left", center: "text-center", right: "text-right", justify: "text-justify" };
  for (var k in d) {
    var v = d[k];
    if (v == null) continue;
    switch (k) {
      case "position": if (v === "absolute" || v === "relative") out.push(v); break;
      case "left":   out.push("left-[" + v + "]"); break;
      case "top":    out.push("top-[" + v + "]"); break;
      case "width":  out.push("w-[" + v + "]"); break;
      case "height": out.push("h-[" + v + "]"); break;
      case "opacity": out.push("opacity-[" + v + "]"); break;
      case "overflow": if (v === "hidden") out.push("overflow-hidden"); break;
      case "display":
        if (v === "none") out.push("hidden");
        else if (v === "flex") out.push("flex");
        break;
      case "flex-direction": out.push(v === "column" ? "flex-col" : "flex-row"); break;
      case "justify-content": if (jmap[v]) out.push(jmap[v]); break;
      case "align-items":     if (amap[v]) out.push(amap[v]); break;
      case "gap": out.push("gap-[" + v + "]"); break;
      case "padding": {
        var p = String(v).split(/\s+/);
        if (p.length === 4) { out.push("pt-[" + p[0] + "]"); out.push("pr-[" + p[1] + "]"); out.push("pb-[" + p[2] + "]"); out.push("pl-[" + p[3] + "]"); }
        else out.push("p-[" + escArb(v) + "]");
        break;
      }
      case "background":       out.push("bg-[" + escArb(v) + "]"); break;
      case "background-color": out.push("bg-[" + v + "]"); break;
      case "border":           out.push("border border-[" + escArb(v) + "]"); break;
      case "border-radius":    out.push("rounded-[" + escArb(v) + "]"); break;
      case "box-shadow":       out.push("shadow-[" + escArb(v) + "]"); break;
      case "filter": {
        var m = /blur\(([^)]+)\)/.exec(v);
        if (m) out.push("blur-[" + m[1] + "]");
        break;
      }
      case "box-sizing": if (v === "border-box") out.push("box-border"); break;
      case "font-family": {
        var mf = /^'([^']+)'/.exec(v);
        if (mf) out.push("font-['" + mf[1].replace(/\s/g, "_") + "']");
        break;
      }
      case "font-weight": out.push("font-[" + v + "]"); break;
      case "font-style":  if (v === "italic") out.push("italic"); break;
      case "font-size":   out.push("text-[" + v + "]"); break;
      case "line-height": out.push("leading-[" + v + "]"); break;
      case "letter-spacing": out.push("tracking-[" + v + "]"); break;
      case "text-align":  if (tmap[v]) out.push(tmap[v]); break;
      case "color":       out.push("text-[" + v + "]"); break;
      case "text-decoration":
        if (v === "underline") out.push("underline");
        else if (v === "line-through") out.push("line-through");
        break;
    }
  }
  return out.join(" ");
}

// ── Semantic tag inference ────────────────────────────────────
var VOID_TAGS = { input: 1, img: 1, br: 1, hr: 1 };
function semanticTag(node) {
  var name = String(node && node.name || "").toLowerCase();
  var isText = node && node.type === "TEXT";
  var hasChildren = node && node.children && node.children.length > 0;
  var rules = isText ? [
    { re: /\bh1\b|\btitle\b|\bheading\b/, tag: "h1" },
    { re: /\bh2\b|\bsubtitle\b|\bsubheading\b/, tag: "h2" },
    { re: /\bh3\b/, tag: "h3" },
    { re: /\bh4\b/, tag: "h4" },
    { re: /\blabel\b/, tag: "label" },
    { re: /\blink\b/, tag: "a" },
  ] : [
    { re: /\b(button|btn|cta)\b/, tag: "button" },
    { re: /\b(input|textfield|search|searchbar)\b/, tag: "input" },
    { re: /\b(nav|navbar|navigation)\b/, tag: "nav" },
    { re: /\b(header|topbar|appbar)\b/, tag: "header" },
    { re: /\bfooter\b/, tag: "footer" },
    { re: /\b(aside|sidebar)\b/, tag: "aside" },
    { re: /\bsection\b/, tag: "section" },
    { re: /\barticle\b/, tag: "article" },
    { re: /\bmain\b/, tag: "main" },
    { re: /\blist\b/, tag: "ul" },
    { re: /\bcard\b/, tag: "article" },
    { re: /\blink\b/, tag: "a" },
  ];
  for (var i = 0; i < rules.length; i++) {
    if (rules[i].re.test(name)) {
      var t = rules[i].tag;
      if (hasChildren && VOID_TAGS[t]) return null;
      return t;
    }
  }
  return null;
}

// ── Node traversal ────────────────────────────────────────────
function nodeToHTML(node, depth, parent) {
  depth = depth || 0;
  var c = cls(node);
  var ind = "  ".repeat(depth);
  var d = {};

  var parentAuto = parent && parent.layoutMode && parent.layoutMode !== "NONE";
  var parentW = parent && typeof parent.width === "number" ? parent.width : null;
  var parentH = parent && typeof parent.height === "number" ? parent.height : null;

  if (parentAuto) {
    d["position"] = "relative";
    // Sizing
    var sh = node.layoutSizingHorizontal;
    var sv = node.layoutSizingVertical;
    if (sh === "FILL") {
      if (parent.layoutMode === "HORIZONTAL") { d["flex"] = "1 1 0"; d["min-width"] = "0"; }
      else d["align-self"] = "stretch";
    } else if (sh === "HUG") {
      // let content determine width
    } else {
      d["width"] = Math.round(node.width) + "px";
    }
    if (sv === "FILL") {
      if (parent.layoutMode === "VERTICAL") { d["flex"] = "1 1 0"; d["min-height"] = "0"; }
      else d["align-self"] = "stretch";
    } else if (sv === "HUG") {
      // let content determine height
    } else {
      d["height"] = Math.round(node.height) + "px";
    }
  } else {
    d["position"] = depth === 0 ? "relative" : "absolute";
    var cx = node.constraints && node.constraints.horizontal;
    var cy = node.constraints && node.constraints.vertical;
    if (depth > 0 && parentW != null && cx === "STRETCH") {
      d["left"] = Math.round(node.x) + "px";
      d["right"] = Math.round(parentW - node.x - node.width) + "px";
    } else if (depth > 0 && parentW != null && cx === "MAX") {
      d["right"] = Math.round(parentW - node.x - node.width) + "px";
    } else if (depth > 0 && parentW != null && cx === "CENTER") {
      d["left"] = "calc(50% - " + Math.round(node.width / 2) + "px)";
      d["width"] = Math.round(node.width) + "px";
    } else if (depth > 0) {
      d["left"] = Math.round(node.x) + "px";
    }
    if (depth > 0 && parentH != null && cy === "STRETCH") {
      d["top"] = Math.round(node.y) + "px";
      d["bottom"] = Math.round(parentH - node.y - node.height) + "px";
    } else if (depth > 0 && parentH != null && cy === "MAX") {
      d["bottom"] = Math.round(parentH - node.y - node.height) + "px";
    } else if (depth > 0 && parentH != null && cy === "CENTER") {
      d["top"] = "calc(50% - " + Math.round(node.height / 2) + "px)";
      d["height"] = Math.round(node.height) + "px";
    } else if (depth > 0) {
      d["top"] = Math.round(node.y) + "px";
    }
    if (d["width"] == null && !(cx === "STRETCH" && parentW != null)) d["width"] = Math.round(node.width) + "px";
    if (d["height"] == null && !(cy === "STRETCH" && parentH != null)) d["height"] = Math.round(node.height) + "px";
  }
  d["box-sizing"] = "border-box";

  if (node.opacity !== undefined && node.opacity < 1) d["opacity"] = parseFloat(node.opacity.toFixed(3));
  if (node.visible === false) d["display"] = "none";
  if (node.clipsContent) d["overflow"] = "hidden";

  if (node.fills) {
    var fillVar = resolveBoundVar(node, "fills");
    var f = fillVar || paintToCSS(node.fills);
    if (f) {
      if (f.indexOf("linear") === 0 || f.indexOf("radial") === 0) d["background"] = f;
      else d["background-color"] = f;
    }
  }

  var bdr = strokeToCSS(node);
  if (bdr) {
    if (typeof bdr === "string") d["border"] = bdr;
    else { d["border-top"] = bdr["border-top"]; d["border-right"] = bdr["border-right"]; d["border-bottom"] = bdr["border-bottom"]; d["border-left"] = bdr["border-left"]; }
  }
  var radVar = resolveBoundVar(node, "cornerRadius");
  var rad = radVar || radiusToCSS(node); if (rad) d["border-radius"] = rad;
  var shd = shadowToCSS(node.effects); if (shd) d["box-shadow"] = shd;
  var blr = blurToCSS(node.effects); if (blr) d["filter"] = blr;

  if (node.type === "TEXT") {
    var ff = node.fontName !== figma.mixed ? node.fontName : null;
    var fs = node.fontSize !== figma.mixed ? node.fontSize : null;
    var lh = node.lineHeight !== figma.mixed ? node.lineHeight : null;
    var ls = node.letterSpacing !== figma.mixed ? node.letterSpacing : null;
    if (ff) {
      d["font-family"] = "'" + ff.family + "',sans-serif";
      d["font-weight"] = fontWeight(ff.style);
      if (ff.style.toLowerCase().indexOf("italic") >= 0) d["font-style"] = "italic";
    }
    if (fs) d["font-size"] = fs + "px";
    if (lh && lh.unit !== "AUTO") d["line-height"] = lh.unit === "PERCENT" ? (lh.value + "%") : (lh.value + "px");
    if (ls && ls.unit !== "PERCENT") d["letter-spacing"] = ls.value + "px";
    if (node.textAlignHorizontal) {
      var tam = { LEFT: "left", CENTER: "center", RIGHT: "right", JUSTIFIED: "justify" };
      d["text-align"] = tam[node.textAlignHorizontal] || "left";
    }
    if (node.fills) {
      var textVar = resolveBoundVar(node, "fills");
      var tc = textVar || paintToCSS(node.fills);
      if (tc && tc.indexOf("linear") !== 0 && tc.indexOf("radial") !== 0) d["color"] = tc;
    }
    if (node.textDecoration === "UNDERLINE") d["text-decoration"] = "underline";
    if (node.textDecoration === "STRIKETHROUGH") d["text-decoration"] = "line-through";
    delete d["background-color"]; delete d["background"];
    if (node.textStyleId && _textStyleMap[node.textStyleId]) {
      for (var tsk = 0; tsk < TEXT_STYLE_KEYS.length; tsk++) delete d[TEXT_STYLE_KEYS[tsk]];
    }
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    d["display"] = "flex";
    d["flex-direction"] = node.layoutMode === "VERTICAL" ? "column" : "row";
    var am = { MIN: "flex-start", CENTER: "center", MAX: "flex-end", SPACE_BETWEEN: "space-between" };
    if (node.primaryAxisAlignItems) d["justify-content"] = am[node.primaryAxisAlignItems] || "flex-start";
    if (node.counterAxisAlignItems) d["align-items"] = am[node.counterAxisAlignItems] || "flex-start";
    var gapVar = resolveBoundVar(node, "itemSpacing");
    if (gapVar) d["gap"] = gapVar;
    else if (node.itemSpacing) d["gap"] = node.itemSpacing + "px";
    var pt = resolveBoundVar(node, "paddingTop")    || ((node.paddingTop    == null ? 0 : node.paddingTop)    + "px");
    var pr = resolveBoundVar(node, "paddingRight")  || ((node.paddingRight  == null ? 0 : node.paddingRight)  + "px");
    var pb = resolveBoundVar(node, "paddingBottom") || ((node.paddingBottom == null ? 0 : node.paddingBottom) + "px");
    var pl = resolveBoundVar(node, "paddingLeft")   || ((node.paddingLeft   == null ? 0 : node.paddingLeft)   + "px");
    if (pt !== "0px" || pr !== "0px" || pb !== "0px" || pl !== "0px") d["padding"] = pt + " " + pr + " " + pb + " " + pl;
  }

  var extraClasses = "";
  if (node.type === "TEXT" && node.textStyleId && _textStyleMap[node.textStyleId]) {
    extraClasses = " " + _textStyleMap[node.textStyleId].className;
  }
  var classAttr;
  if (_mode === "tailwind") {
    classAttr = declsToTailwind(d) + extraClasses;
  } else {
    classAttr = c + extraClasses;
    emitRule(c, d);
  }
  var classKey = _mode === "react" ? "className" : "class";

  var children = "";
  if ("children" in node && node.children.length > 0) {
    for (var i = 0; i < node.children.length; i++) {
      children += "\n" + nodeToHTML(node.children[i], depth + 1, node);
    }
    children += "\n" + ind;
  }

  var semTag = semanticTag(node);
  var tag = semTag || "div";
  var content = children;
  if (node.type === "TEXT") {
    if (!semTag) tag = "p";
    var raw = typeof node.characters === "string" ? node.characters : "";
    var brTag = _mode === "react" ? "<br />" : "<br>";
    content = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, brTag);
  }

  var safeName = String(node.name).replace(/"/g, "");
  var nodeSlug = _slugMap.get(node.id) || "";
  var slugAttr = nodeSlug ? ' data-figma-slug="' + nodeSlug + '"' : "";
  var _compName = mainComponentName(node);
  var compAttr = _compName
    ? ' data-component="' + String(_compName).replace(/"/g, "") + '"' : "";
  // Detect text content for a11y (icon-only buttons get aria-label)
  var hasTextDescendant = false;
  (function walk(n) {
    if (hasTextDescendant) return;
    if (n.type === "TEXT" && n.characters) { hasTextDescendant = true; return; }
    if (n.children) for (var i = 0; i < n.children.length; i++) walk(n.children[i]);
  })(node);
  var a11y = "";
  if (tag === "button") a11y += ' type="button"';
  if (tag === "a") a11y += ' href="#"';
  if ((tag === "button" || tag === "a") && !hasTextDescendant) a11y += ' aria-label="' + safeName + '"';
  var asset = _assetCache[node.id];
  if (asset) {
    if (asset.kind === "png") {
      var selfClose = _mode === "react" ? " />" : ">";
      return ind + '<img ' + classKey + '="' + classAttr + '" src="' + asset.data + '" alt="' + safeName + '" data-figma="' + safeName + '"' + slugAttr + selfClose;
    }
    if (asset.kind === "svg") {
      return ind + '<div ' + classKey + '="' + classAttr + '" role="img" aria-label="' + safeName + '" data-figma="' + safeName + '" data-type="' + node.type + '"' + slugAttr + ">" + asset.data + "</div>";
    }
  }
  if (VOID_TAGS[tag]) {
    var close = _mode === "react" ? " />" : ">";
    var extra = tag === "input" ? ' type="text" placeholder="' + safeName + '" aria-label="' + safeName + '"' : "";
    return ind + "<" + tag + " " + classKey + '="' + classAttr + '"' + extra + ' data-figma="' + safeName + '"' + slugAttr + close;
  }
  return ind + "<" + tag + " " + classKey + '="' + classAttr + '"' + a11y + ' data-figma="' + safeName + '" data-type="' + node.type + '"' + compAttr + slugAttr + ">" + content + "</" + tag + ">";
}

// ── Build full HTML file ──────────────────────────────────────
function modeSelector(modeName) {
  var n = String(modeName).toLowerCase();
  if (n === "dark" || n === "night") return '@media (prefers-color-scheme: dark)';
  return '[data-theme="' + n.replace(/[^a-z0-9-]+/g, "-") + '"]';
}

function rootVarsBlock() {
  var ids = Object.keys(_varMap);
  if (!ids.length) return "";
  var defaultLines = ids.map(function (id) { return "  " + _varMap[id].cssName + ": " + _varMap[id].value + ";"; });
  var out = ":root {\n" + defaultLines.join("\n") + "\n}\n\n";
  // Collect per-mode overrides
  var modeNames = {};
  ids.forEach(function (id) {
    var e = _varMap[id];
    if (!e.valuesByMode) return;
    Object.keys(e.valuesByMode).forEach(function (m) { modeNames[m] = true; });
  });
  var modes = Object.keys(modeNames);
  if (modes.length <= 1) return out;
  modes.forEach(function (m) {
    var lines = [];
    ids.forEach(function (id) {
      var e = _varMap[id];
      var v = e.valuesByMode && e.valuesByMode[m];
      if (v == null || v === e.value) return;
      lines.push("  " + e.cssName + ": " + v + ";");
    });
    if (!lines.length) return;
    var sel = modeSelector(m);
    if (sel.indexOf("@media") === 0) {
      out += sel + " {\n  :root {\n" + lines.map(function (l) { return "  " + l; }).join("\n") + "\n  }\n}\n\n";
    } else {
      out += sel + " {\n" + lines.join("\n") + "\n}\n\n";
    }
  });
  return out;
}

function textStylesBlock() {
  var ids = Object.keys(_textStyleMap);
  if (!ids.length) return "";
  return ids.map(function (id) {
    var e = _textStyleMap[id];
    var body = Object.keys(e.decls).map(function (k) { return "  " + k + ": " + e.decls[k] + ";"; }).join("\n");
    return "." + e.className + " {\n" + body + "\n}";
  }).join("\n\n") + "\n\n";
}

function pascal(s) {
  return String(s).replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/)
    .map(function (w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : ""; }).join("") || "Component";
}

function setMinify(v) { _minify = !!v; }

// Minimal store-method ZIP encoder. Returns Uint8Array.
var _crcTable = null;
function crcTable() {
  if (_crcTable) return _crcTable;
  _crcTable = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    _crcTable[n] = c >>> 0;
  }
  return _crcTable;
}
function crc32(bytes) {
  var t = crcTable(), c = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function strToBytes(s) {
  var enc = (typeof TextEncoder !== "undefined") ? new TextEncoder() : null;
  if (enc) return enc.encode(s);
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}
function buildZip(files) {
  var chunks = [], central = [], offset = 0;
  function w16(v) { return [v & 0xff, (v >> 8) & 0xff]; }
  function w32(v) { return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff]; }
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var nameB = strToBytes(f.path);
    var dataB = typeof f.data === "string" ? strToBytes(f.data) : f.data;
    var crc = crc32(dataB);
    var local = [].concat(w32(0x04034b50), w16(20), w16(0), w16(0), w16(0), w16(0),
      w32(crc), w32(dataB.length), w32(dataB.length), w16(nameB.length), w16(0));
    chunks.push(new Uint8Array(local), nameB, dataB);
    central.push([].concat(w32(0x02014b50), w16(20), w16(20), w16(0), w16(0), w16(0), w16(0),
      w32(crc), w32(dataB.length), w32(dataB.length), w16(nameB.length), w16(0), w16(0), w16(0), w16(0), w32(0), w32(offset)));
    central.push(nameB);
    offset += local.length + nameB.length + dataB.length;
  }
  var centralStart = offset, centralSize = 0;
  var centralChunks = [];
  for (var j = 0; j < central.length; j++) {
    var c = central[j];
    var u = c instanceof Uint8Array ? c : new Uint8Array(c);
    centralChunks.push(u);
    centralSize += u.length;
  }
  var end = [].concat(w32(0x06054b50), w16(0), w16(0), w16(files.length), w16(files.length),
    w32(centralSize), w32(centralStart), w16(0));
  var total = 0;
  for (var k = 0; k < chunks.length; k++) total += chunks[k].length;
  total += centralSize + end.length;
  var zip = new Uint8Array(total), pos = 0;
  for (var m = 0; m < chunks.length; m++) { zip.set(chunks[m], pos); pos += chunks[m].length; }
  for (var n2 = 0; n2 < centralChunks.length; n2++) { zip.set(centralChunks[n2], pos); pos += centralChunks[n2].length; }
  zip.set(end, pos);
  return zip;
}

// ── LLM handoff bundle ─────────────────────────────────────────
// Non-cryptographic, deterministic content hash (FNV-1a hex, 64-bit simulated).
function contentHash(s) {
  var bytes = typeof s === "string" ? strToBytes(s) : s;
  var h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
  for (var i = 0; i < bytes.length; i++) {
    h1 = (h1 ^ bytes[i]) >>> 0;
    h1 = Math.imul(h1, 16777619) >>> 0;
    h2 = (h2 ^ bytes[i]) >>> 0;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }
  var pad = function (n) { var s = n.toString(16); while (s.length < 8) s = "0" + s; return s; };
  return pad(h1) + pad(h2);
}

function estimateTokens(s) {
  // Rough: bytes/4. Cheap but good enough for budget gating.
  var b = typeof s === "string" ? strToBytes(s).length : (s && s.length) || 0;
  return Math.ceil(b / 4);
}

function nodeSummary(node) {
  var bits = [];
  if (typeof node.width === "number" && typeof node.height === "number") {
    bits.push(Math.round(node.width) + "×" + Math.round(node.height));
  }
  if (node.layoutMode === "HORIZONTAL") bits.push("row");
  else if (node.layoutMode === "VERTICAL") bits.push("col");
  if (node.type === "TEXT" && typeof node.characters === "string") {
    var t = node.characters.replace(/\s+/g, " ").slice(0, 40);
    bits.push('text="' + t + '"');
  }
  var _imcn = mainComponentName(node);
  if (_imcn) bits.push("instance=" + _imcn);
  return bits.join(" · ");
}

function hierarchyMd(nodes) {
  var lines = ["# Hierarchy", "", "Indented tree of every node with its slug, tag, and a summary.", ""];
  (function walk(arr, depth) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n || !n.id) continue;
      var slug = _slugMap.get(n.id) || "";
      var tag = (typeof semanticTag === "function" && semanticTag(n)) || (n.type === "TEXT" ? "p" : "div");
      var pad = "";
      for (var d = 0; d < depth; d++) pad += "  ";
      lines.push(pad + "- `" + slug + "` [" + tag + "] — " + nodeSummary(n));
      if (n.children && n.children.length) walk(n.children, depth + 1);
    }
  })(nodes, 0);
  lines.push("");
  return lines.join("\n");
}

function componentsJson(nodes, mappingOverride) {
  var mapping = mappingOverride || _componentMap || {};
  var components = {};
  var instanceUsage = {};
  (function walk(arr) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n) continue;
      if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") {
        components[n.name] = {
          id: n.id,
          slug: _slugMap.get(n.id) || "",
          type: n.type,
          propertyDefinitions: n.componentPropertyDefinitions || null,
          variants: (n.children || []).filter(function (c) { return c.type === "COMPONENT"; }).map(function (c) {
            return { name: c.name, variantProperties: c.variantProperties || null };
          }),
          usage: 0,
        };
      }
      var _usageName = mainComponentName(n);
      if (_usageName) {
        instanceUsage[_usageName] = (instanceUsage[_usageName] || 0) + 1;
      }
      if (n.children && n.children.length) walk(n.children);
    }
  })(nodes);
  var names = Object.keys(instanceUsage);
  for (var i = 0; i < names.length; i++) {
    if (!components[names[i]]) components[names[i]] = { id: null, slug: "", type: "INSTANCE_REFERENCE", propertyDefinitions: null, variants: [], usage: 0 };
    components[names[i]].usage = instanceUsage[names[i]];
  }
  // Attach code mapping (from A4/B1) when available.
  var allNames = Object.keys(components);
  for (var m = 0; m < allNames.length; m++) {
    if (mapping[allNames[m]]) components[allNames[m]].codePath = mapping[allNames[m]];
  }
  return JSON.stringify({ components: components, mapping: mapping }, null, 2);
}

function designMd(nodes, pageTitle) {
  // Collect colors, font sizes, spacings, corner radii, counts.
  var colors = {}, fontSizes = {}, spacings = {}, radii = {};
  var textCount = 0, frameCount = 0, instanceCount = 0;
  (function walk(arr) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n) continue;
      if (n.type === "TEXT") textCount++;
      else if (n.type === "INSTANCE") instanceCount++;
      else if (n.type === "FRAME" || n.type === "COMPONENT") frameCount++;
      if (n.fills && n.fills.length) {
        n.fills.forEach(function (f) {
          if (f.type === "SOLID" && f.color) {
            var k = rgbaToCSS({ r: f.color.r, g: f.color.g, b: f.color.b, a: f.opacity == null ? 1 : f.opacity });
            colors[k] = (colors[k] || 0) + 1;
          }
        });
      }
      if (typeof n.fontSize === "number") fontSizes[n.fontSize] = (fontSizes[n.fontSize] || 0) + 1;
      if (typeof n.itemSpacing === "number") spacings[n.itemSpacing] = (spacings[n.itemSpacing] || 0) + 1;
      if (typeof n.paddingLeft === "number" && n.paddingLeft > 0) spacings[n.paddingLeft] = (spacings[n.paddingLeft] || 0) + 1;
      if (typeof n.cornerRadius === "number") radii[n.cornerRadius] = (radii[n.cornerRadius] || 0) + 1;
      if (n.children && n.children.length) walk(n.children);
    }
  })(nodes);
  function topN(obj, n) {
    return Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, n);
  }
  var lines = [];
  lines.push("# " + pageTitle);
  lines.push("");
  lines.push("Auto-generated design brief. Read this before implementing.");
  lines.push("");
  lines.push("## Inventory");
  lines.push("- **Frames:** " + frameCount);
  lines.push("- **Text nodes:** " + textCount);
  lines.push("- **Instances:** " + instanceCount);
  lines.push("");
  var topColors = topN(colors, 8);
  if (topColors.length) {
    lines.push("## Palette (most-used first)");
    topColors.forEach(function (c) { lines.push("- `" + c + "` (" + colors[c] + "×)"); });
    lines.push("");
  }
  var topFs = topN(fontSizes, 8);
  if (topFs.length) {
    lines.push("## Type scale");
    topFs.forEach(function (s) { lines.push("- `" + s + "px` (" + fontSizes[s] + "×)"); });
    lines.push("");
  }
  var topSp = topN(spacings, 8);
  if (topSp.length) {
    lines.push("## Spacing scale");
    topSp.forEach(function (s) { lines.push("- `" + s + "px` (" + spacings[s] + "×)"); });
    lines.push("");
  }
  var topRad = topN(radii, 6);
  if (topRad.length) {
    lines.push("## Corner radii");
    topRad.forEach(function (r) { lines.push("- `" + r + "px` (" + radii[r] + "×)"); });
    lines.push("");
  }
  return lines.join("\n");
}

function agentsMd(pageTitle, opts) {
  opts = opts || {};
  var issueSummary = "";
  if (opts.issues && opts.issues.length) {
    issueSummary = "\n## Known accessibility issues — DO NOT REINTRODUCE\n" +
      opts.issues.slice(0, 20).map(function (iss) {
        return "- [" + iss.level + " / " + iss.type + "] `" + (iss.slug || iss.nodeId || "?") + "`: " + iss.message;
      }).join("\n") +
      (opts.issues.length > 20 ? "\n- _…and " + (opts.issues.length - 20) + " more; see `ISSUES.md`._" : "") +
      "\n";
  }
  var mappingLines = opts.mappings && Object.keys(opts.mappings).length
    ? Object.keys(opts.mappings).map(function (k) { return "- When you see component `" + k + "`, use `" + opts.mappings[k] + "`"; }).join("\n")
    : "_(no code mappings provided — build components from the hierarchy and tokens)_";
  return [
    "# Agent instructions for " + pageTitle,
    "",
    "This bundle is a deterministic, offline handoff from a Figma design. You are consuming it to implement the design in code.",
    "",
    "## Rules",
    "1. **Prefer tokens over raw values.** Use variables from `tokens.css` / `tokens.json` — never hardcode a color or spacing that has a token.",
    "2. **Respect slugs.** Every element has a `data-figma-slug` equivalent in `hierarchy.md`. Use these as stable anchors when you make edits; do not invent new ids.",
    "3. **Use existing components.** Check `components.json` and the mapping block below before implementing a new component from scratch.",
    "4. **Do not invent interactions.** Only implement behavior described in `flow.mmd` (if present) or explicitly in the request.",
    "5. **Treat `CHANGES.md` as a surgical edit list.** When present, apply only the listed diffs rather than regenerating the whole file.",
    "",
    issueSummary,
    "## Component mappings",
    mappingLines,
    "",
    "## Files in this bundle (see manifest.json for hashes)",
    "- `DESIGN.md` — design brief and inventory.",
    "- `hierarchy.md` — indented tree of every slug.",
    "- `components.json` — component inventory with variants and usage.",
    "- `tokens.json` / `tokens.css` — design tokens (DTCG format + CSS vars).",
    "- `screenshots/` — PNG per top-level frame.",
    "- `manifest.json` — file list with hashes and estimated token counts.",
    "",
  ].join("\n");
}

function manifestJson(files) {
  var entries = files.map(function (f) {
    var bytes = typeof f.data === "string" ? strToBytes(f.data).length : (f.data && f.data.length) || 0;
    return {
      path: f.path,
      bytes: bytes,
      tokens_est: Math.ceil(bytes / 4),
      hash: typeof f.data === "string" ? contentHash(f.data) : contentHash(new Uint8Array(f.data || [])),
    };
  });
  var totalTokens = entries.reduce(function (a, b) { return a + b.tokens_est; }, 0);
  return JSON.stringify({ version: 1, generated: "frameshift", files: entries, tokens_est_total: totalTokens }, null, 2);
}

// Snapshot the tree as slug → { type, text, fingerprint } for diffing between exports.
function buildSnapshot(nodes) {
  var snap = {};
  (function walk(arr) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n || !n.id) continue;
      var slug = _slugMap.get(n.id);
      if (!slug) continue;
      var fp = {
        type: n.type,
        text: n.type === "TEXT" ? (n.characters || "") : null,
        size: (typeof n.width === "number" && typeof n.height === "number") ? Math.round(n.width) + "x" + Math.round(n.height) : null,
        padding: (typeof n.paddingLeft === "number") ? (n.paddingTop || 0) + "/" + (n.paddingRight || 0) + "/" + (n.paddingBottom || 0) + "/" + (n.paddingLeft || 0) : null,
        gap: typeof n.itemSpacing === "number" ? n.itemSpacing : null,
        radius: typeof n.cornerRadius === "number" ? n.cornerRadius : null,
        fontSize: typeof n.fontSize === "number" ? n.fontSize : null,
        fontWeight: n.fontName && n.fontName.style ? n.fontName.style : null,
        instance: mainComponentName(n),
      };
      snap[slug] = fp;
      if (n.children && n.children.length) walk(n.children);
    }
  })(nodes);
  return snap;
}

// Diff two snapshots → structured { added, removed, changed:[{slug, field, from, to}] }
function diffSnapshots(prev, cur) {
  prev = prev || {}; cur = cur || {};
  var added = [], removed = [], changed = [];
  var keys = {};
  Object.keys(prev).forEach(function (k) { keys[k] = 1; });
  Object.keys(cur).forEach(function (k) { keys[k] = 1; });
  var all = Object.keys(keys).sort();
  for (var i = 0; i < all.length; i++) {
    var k = all[i];
    if (prev[k] && !cur[k]) { removed.push({ slug: k, fp: prev[k] }); continue; }
    if (!prev[k] && cur[k]) { added.push({ slug: k, fp: cur[k] }); continue; }
    var p = prev[k], c = cur[k];
    var fields = Object.keys(p);
    for (var j = 0; j < fields.length; j++) {
      var f = fields[j];
      if (p[f] !== c[f] && !(p[f] == null && c[f] == null)) {
        changed.push({ slug: k, field: f, from: p[f], to: c[f] });
      }
    }
  }
  return { added: added, removed: removed, changed: changed };
}

function changesMd(diff) {
  var lines = ["# Changes since last export", ""];
  if (!diff.added.length && !diff.removed.length && !diff.changed.length) {
    lines.push("_No changes detected._");
    lines.push("");
    return lines.join("\n");
  }
  if (diff.added.length) {
    lines.push("## Added");
    diff.added.forEach(function (a) {
      var summary = a.fp.type + (a.fp.text ? ' text="' + a.fp.text.slice(0, 40) + '"' : "") + (a.fp.size ? " " + a.fp.size : "");
      lines.push("- `" + a.slug + "` — " + summary);
    });
    lines.push("");
  }
  if (diff.removed.length) {
    lines.push("## Removed");
    diff.removed.forEach(function (r) { lines.push("- `" + r.slug + "` (was " + r.fp.type + ")"); });
    lines.push("");
  }
  if (diff.changed.length) {
    lines.push("## Changed");
    // Group by slug for readability.
    var bySlug = {};
    diff.changed.forEach(function (c) { (bySlug[c.slug] = bySlug[c.slug] || []).push(c); });
    Object.keys(bySlug).forEach(function (slug) {
      lines.push("### `" + slug + "`");
      bySlug[slug].forEach(function (c) {
        lines.push("- " + c.field + ": `" + (c.from == null ? "—" : c.from) + "` → `" + (c.to == null ? "—" : c.to) + "`");
      });
      lines.push("");
    });
  }
  return lines.join("\n");
}

function pascalCase(s) {
  return String(s || "")
    .replace(/[^a-zA-Z0-9]+(.)/g, function (_, c) { return c.toUpperCase(); })
    .replace(/^(.)/, function (c) { return c.toUpperCase(); })
    .replace(/[^a-zA-Z0-9]/g, "");
}

function camelCase(s) {
  var p = pascalCase(s);
  return p ? p.charAt(0).toLowerCase() + p.slice(1) : "";
}

function propTypeForDef(def) {
  if (!def) return "any";
  switch (def.type) {
    case "BOOLEAN": return "boolean";
    case "TEXT": return "string";
    case "INSTANCE_SWAP": return "React.ReactNode";
    case "VARIANT":
      var opts = def.variantOptions || [];
      return opts.length ? opts.map(function (o) { return JSON.stringify(o); }).join(" | ") : "string";
  }
  return "any";
}

function propDefault(def) {
  if (!def || def.defaultValue === undefined || def.defaultValue === null) return "undefined";
  if (def.type === "BOOLEAN") return def.defaultValue ? "true" : "false";
  if (def.type === "INSTANCE_SWAP") return "undefined";
  return JSON.stringify(def.defaultValue);
}

function componentTsx(compName, propDefs) {
  var keys = Object.keys(propDefs || {});
  var propsIface = keys.map(function (k) {
    var d = propDefs[k];
    var optional = d && d.defaultValue !== undefined ? "?" : "";
    return "  " + camelCase(k) + optional + ": " + propTypeForDef(d) + ";";
  }).join("\n");
  var name = pascalCase(compName);
  var destructure = keys.map(function (k) {
    var cc = camelCase(k);
    var def = propDefault(propDefs[k]);
    return def !== "undefined" ? cc + " = " + def : cc;
  }).join(", ");
  var dataAttrs = keys.filter(function (k) { return propDefs[k] && propDefs[k].type === "VARIANT"; })
    .map(function (k) { return "data-" + camelCase(k) + "={" + camelCase(k) + "}"; }).join(" ");
  var children = keys.indexOf("label") !== -1 || keys.some(function (k) { return propDefs[k] && propDefs[k].type === "TEXT"; })
    ? "{label}" : "{children}";
  var childrenProp = children === "{children}" ? "  children?: React.ReactNode;" : "";
  return [
    '// Generated from Figma component "' + compName + '" — edit freely.',
    'import * as React from "react";',
    '',
    'export interface ' + name + 'Props {',
    propsIface,
    childrenProp,
    '}',
    '',
    'export function ' + name + '({' + destructure + (children === "{children}" ? ", children" : "") + '}: ' + name + 'Props) {',
    '  return (',
    '    <div className="' + kebab(compName) + '" ' + dataAttrs + '>',
    '      ' + children,
    '    </div>',
    '  );',
    '}',
    '',
  ].filter(function (l) { return l !== ""; }).join("\n") + "\n";
}

function variantCombinations(propDefs) {
  var keys = Object.keys(propDefs || {});
  var variantKeys = keys.filter(function (k) { return propDefs[k].type === "VARIANT" || propDefs[k].type === "BOOLEAN"; });
  if (!variantKeys.length) return [{}];
  var combos = [{}];
  variantKeys.forEach(function (k) {
    var opts = propDefs[k].type === "BOOLEAN" ? [true, false] : (propDefs[k].variantOptions || [propDefs[k].defaultValue]);
    var next = [];
    combos.forEach(function (c) {
      opts.forEach(function (o) {
        var clone = Object.assign({}, c);
        clone[k] = o;
        next.push(clone);
      });
    });
    combos = next;
  });
  return combos;
}

function componentStories(compName, propDefs) {
  var name = pascalCase(compName);
  var combos = variantCombinations(propDefs).slice(0, 24); // cap to avoid explosion
  var stories = combos.map(function (c, i) {
    var storyName = Object.keys(c).length
      ? Object.keys(c).map(function (k) { return String(c[k]); }).join("_").replace(/[^a-zA-Z0-9_]/g, "")
      : "Default";
    var args = Object.keys(c).map(function (k) {
      return "    " + camelCase(k) + ": " + JSON.stringify(c[k]);
    }).join(",\n");
    return "export const " + (storyName || "Story" + i) + ": Story = {\n  args: {\n" + args + "\n  },\n};\n";
  }).join("\n");
  return [
    '// Auto-generated Storybook stories for ' + name + '.',
    'import type { Meta, StoryObj } from "@storybook/react";',
    'import { ' + name + ' } from "./' + name + '";',
    '',
    'const meta: Meta<typeof ' + name + '> = { component: ' + name + ' };',
    'export default meta;',
    'type Story = StoryObj<typeof ' + name + '>;',
    '',
    stories,
  ].join("\n");
}

function buildComponentFiles(nodes) {
  var out = [];
  (function walk(arr) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n) continue;
      if ((n.type === "COMPONENT_SET" || n.type === "COMPONENT") && n.componentPropertyDefinitions) {
        var name = pascalCase(n.name);
        out.push({ path: "components/" + name + ".tsx", data: componentTsx(n.name, n.componentPropertyDefinitions) });
        out.push({ path: "components/" + name + ".stories.tsx", data: componentStories(n.name, n.componentPropertyDefinitions) });
      }
      if (n.children && n.children.length) walk(n.children);
    }
  })(nodes || []);
  return out;
}

function normalizeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function basenameNoExt(p) {
  var slash = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  var name = slash >= 0 ? p.slice(slash + 1) : p;
  var dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  var v0 = new Array(b.length + 1);
  var v1 = new Array(b.length + 1);
  for (var i = 0; i <= b.length; i++) v0[i] = i;
  for (var i2 = 0; i2 < a.length; i2++) {
    v1[0] = i2 + 1;
    for (var j = 0; j < b.length; j++) {
      var cost = a.charCodeAt(i2) === b.charCodeAt(j) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (var k = 0; k <= b.length; k++) v0[k] = v1[k];
  }
  return v1[b.length];
}

function collectFigmaComponentNames(nodes) {
  var names = {};
  (function walk(arr) {
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n) continue;
      if (n.type === "COMPONENT" || n.type === "COMPONENT_SET") names[n.name] = true;
      var _cmn = mainComponentName(n);
      if (_cmn) names[_cmn] = true;
      if (n.children && n.children.length) walk(n.children);
    }
  })(nodes || []);
  return Object.keys(names);
}

function fuzzyMatchComponents(figmaNames, codePaths, opts) {
  opts = opts || {};
  var threshold = typeof opts.threshold === "number" ? opts.threshold : 0.4;
  var result = {};
  var normPaths = (codePaths || []).map(function (p) {
    return { path: p, base: basenameNoExt(p), norm: normalizeName(basenameNoExt(p)) };
  });
  for (var i = 0; i < figmaNames.length; i++) {
    var name = figmaNames[i];
    var norm = normalizeName(name);
    if (!norm) continue;
    var best = null;
    for (var j = 0; j < normPaths.length; j++) {
      var cand = normPaths[j];
      if (!cand.norm) continue;
      if (cand.norm === norm) { best = { path: cand.path, score: 0 }; break; }
      var dist = levenshtein(norm, cand.norm);
      var rel = dist / Math.max(norm.length, cand.norm.length);
      if (rel <= threshold && (!best || rel < best.score)) best = { path: cand.path, score: rel };
    }
    if (best) result[name] = best.path;
  }
  return result;
}

function setComponentMap(map) { _componentMap = map || {}; }
function getComponentMap() { return _componentMap; }

function firstSolidFill(node) {
  if (!node || !node.fills || node.fills === figma.mixed) return null;
  for (var i = 0; i < node.fills.length; i++) {
    var f = node.fills[i];
    if (f && f.type === "SOLID" && f.visible !== false) {
      var op = typeof f.opacity === "number" ? f.opacity : 1;
      return { r: f.color.r, g: f.color.g, b: f.color.b, a: op };
    }
  }
  return null;
}

function blendOver(fg, bg) {
  var a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function relLum(c) {
  function chan(v) { return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
  return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
}

function contrastRatio(a, b) {
  var la = relLum(a), lb = relLum(b);
  var L1 = Math.max(la, lb), L2 = Math.min(la, lb);
  return (L1 + 0.05) / (L2 + 0.05);
}

function isLargeText(node) {
  var size = node.fontSize || 0;
  var weight = (node.fontName && /bold|black|heavy/i.test(node.fontName.style || "")) ? "bold" : "normal";
  // WCAG: 18pt (24px) or 14pt (18.66px) bold.
  return size >= 24 || (weight === "bold" && size >= 18.66);
}

function isInteractive(node) {
  if (!node) return false;
  var name = String(node.name || "").toLowerCase();
  if (/\b(button|btn|cta|link|tab|chip|toggle|switch)\b/.test(name)) return true;
  if (node.reactions && node.reactions.length) return true;
  return false;
}

function hasTextDescendant(node) {
  if (!node) return false;
  if (node.type === "TEXT" && node.characters && String(node.characters).trim()) return true;
  if (!node.children) return false;
  for (var i = 0; i < node.children.length; i++) {
    if (hasTextDescendant(node.children[i])) return true;
  }
  return false;
}

function auditA11y(nodes) {
  var issues = [];
  var lastHeading = 0;
  var BLACK = { r: 0, g: 0, b: 0, a: 1 };
  var WHITE = { r: 1, g: 1, b: 1, a: 1 };

  function push(level, node, type, message) {
    issues.push({
      level: level,
      type: type,
      nodeId: node && node.id || null,
      slug: node && _slugMap.get(node.id) || null,
      message: message,
    });
  }

  function walk(arr, bgStack) {
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n || n.visible === false) continue;
      var ownBg = firstSolidFill(n);
      var effectiveBg = ownBg ? (ownBg.a < 1 && bgStack.length ? blendOver(ownBg, bgStack[bgStack.length - 1]) : ownBg) : (bgStack.length ? bgStack[bgStack.length - 1] : WHITE);

      // Contrast — text nodes only.
      if (n.type === "TEXT") {
        var fg = firstSolidFill(n) || BLACK;
        var fgOnBg = fg.a < 1 ? blendOver(fg, effectiveBg) : fg;
        var bgForText = bgStack.length ? bgStack[bgStack.length - 1] : WHITE;
        var ratio = contrastRatio(fgOnBg, bgForText);
        var threshold = isLargeText(n) ? 3 : 4.5;
        if (ratio + 0.01 < threshold) {
          push("error", n, "contrast",
            "Text contrast " + ratio.toFixed(2) + ":1 is below WCAG AA (" + threshold + ":1) for " +
            (isLargeText(n) ? "large" : "normal") + " text.");
        }

        // Heading order.
        var tag = semanticTag(n);
        var m = tag && tag.match(/^h([1-4])$/);
        if (m) {
          var level = parseInt(m[1], 10);
          if (lastHeading && level > lastHeading + 1) {
            push("warn", n, "heading-order",
              "Heading jumps from h" + lastHeading + " to h" + level + " — insert intermediate levels.");
          }
          lastHeading = level;
        }
      }

      // Missing label on images.
      if (hasImageFill(n) || (isVectorLike(n) && !n.children)) {
        var nm = String(n.name || "").trim();
        if (!nm || /^(image|img|icon|vector|rectangle|frame|ellipse)\b/i.test(nm)) {
          push("warn", n, "missing-label",
            "Image/icon has no descriptive name — emitted alt/aria-label will be empty.");
        }
      }

      // Interactive without text.
      if (isInteractive(n) && !hasTextDescendant(n)) {
        var aria = String(n.name || "").trim();
        if (!aria || /^(button|btn|icon button)$/i.test(aria)) {
          push("error", n, "interactive-no-text",
            "Interactive element has no text or descriptive name — screen readers will announce it as unlabeled.");
        }
      }

      // Touch target size.
      if (isInteractive(n) && typeof n.width === "number" && typeof n.height === "number") {
        if (n.width < 44 || n.height < 44) {
          push("warn", n, "touch-target",
            "Interactive target is " + Math.round(n.width) + "×" + Math.round(n.height) + "px — below the 44×44 minimum.");
        }
      }

      if (n.children && n.children.length) {
        var nextStack = ownBg && ownBg.a >= 0.99 ? bgStack.concat([effectiveBg]) : bgStack;
        walk(n.children, nextStack);
      }
    }
  }
  walk(nodes || [], []);
  return issues;
}

function issuesMd(issues) {
  if (!issues || !issues.length) return "# Accessibility issues\n\n_No issues detected._\n";
  var lines = ["# Accessibility issues", "", "The agent should **not introduce new violations**. Existing issues are listed so they can be fixed or preserved deliberately.", ""];
  var groups = {};
  issues.forEach(function (iss) { (groups[iss.type] = groups[iss.type] || []).push(iss); });
  Object.keys(groups).forEach(function (type) {
    lines.push("## " + type + " (" + groups[type].length + ")");
    groups[type].forEach(function (iss) {
      lines.push("- **[" + iss.level + "]** `" + (iss.slug || iss.nodeId || "?") + "` — " + iss.message);
    });
    lines.push("");
  });
  return lines.join("\n");
}

var BREAKPOINT_PATTERNS = [
  { re: /\b(mobile|sm|small|phone)\b/i,            bp: "mobile",  minWidth: 0 },
  { re: /\b(tablet|md|medium)\b/i,                 bp: "tablet",  minWidth: 768 },
  { re: /\b(desktop|lg|large|xl|wide|web)\b/i,     bp: "desktop", minWidth: 1024 },
];

function detectBreakpoint(name, width) {
  var s = String(name || "");
  for (var i = 0; i < BREAKPOINT_PATTERNS.length; i++) {
    if (BREAKPOINT_PATTERNS[i].re.test(s)) return BREAKPOINT_PATTERNS[i];
  }
  // Fallback by width.
  if (typeof width === "number") {
    if (width < 600) return { bp: "mobile", minWidth: 0 };
    if (width < 1024) return { bp: "tablet", minWidth: 768 };
    return { bp: "desktop", minWidth: 1024 };
  }
  return null;
}

function stripBreakpointSuffix(name) {
  return String(name || "")
    .replace(/\s*[\/\-—–|]+\s*(mobile|tablet|desktop|sm|md|lg|xl|phone|wide|web)\s*$/i, "")
    .replace(/\s*\((mobile|tablet|desktop|sm|md|lg|xl|phone|wide|web)\)\s*$/i, "")
    .trim();
}

function groupResponsiveFrames(nodes) {
  var groups = {};
  for (var i = 0; i < (nodes || []).length; i++) {
    var n = nodes[i];
    if (!n || n.type !== "FRAME") continue;
    var base = stripBreakpointSuffix(n.name);
    var bp = detectBreakpoint(n.name, n.width);
    if (!base || !bp) continue;
    if (!groups[base]) groups[base] = [];
    groups[base].push({ breakpoint: bp.bp, minWidth: bp.minWidth, width: n.width, id: n.id, name: n.name, node: n });
  }
  var out = [];
  Object.keys(groups).forEach(function (base) {
    var variants = groups[base];
    if (variants.length < 2) return; // need at least two breakpoints to be a group
    variants.sort(function (a, b) { return a.minWidth - b.minWidth; });
    out.push({ baseName: base, variants: variants });
  });
  return out;
}

function responsiveMd(groups) {
  if (!groups.length) return "# Responsive groups\n\n_No multi-breakpoint frames detected._\n";
  var lines = ["# Responsive groups", "", "Frames sharing a base name across breakpoints. Merge them into one component with `@media` queries.", ""];
  groups.forEach(function (g) {
    lines.push("## " + g.baseName);
    g.variants.forEach(function (v) {
      var mq = v.minWidth === 0 ? "default (mobile-first)" : "@media (min-width: " + v.minWidth + "px)";
      lines.push("- **" + v.breakpoint + "** (" + Math.round(v.width) + "px) `" + (v.node && _slugMap.get(v.node.id) || v.id) + "` — " + mq);
    });
    lines.push("");
  });
  return lines.join("\n");
}

function responsiveJson(groups) {
  return JSON.stringify({
    groups: groups.map(function (g) {
      return {
        baseName: g.baseName,
        variants: g.variants.map(function (v) {
          return {
            breakpoint: v.breakpoint,
            minWidth: v.minWidth,
            width: v.width,
            slug: v.node && _slugMap.get(v.node.id) || v.id,
            name: v.name,
          };
        }),
      };
    }),
  }, null, 2);
}

function mermaidSafe(s) {
  return String(s || "").replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "") || "node";
}

function flowMermaid(nodes) {
  // Build id → {slug, name} lookup + collect reactions with NAVIGATE actions.
  var index = {};
  var edges = [];
  (function walk(arr) {
    if (!arr) return;
    for (var i = 0; i < arr.length; i++) {
      var n = arr[i];
      if (!n) continue;
      index[n.id] = { slug: _slugMap.get(n.id) || n.id, name: n.name };
      if (n.reactions && n.reactions.length) {
        for (var r = 0; r < n.reactions.length; r++) {
          var rx = n.reactions[r];
          var trigger = rx.trigger && rx.trigger.type;
          var action = rx.action || rx.actions && rx.actions[0];
          if (!action) continue;
          if (action.navigation !== "NAVIGATE" && action.type !== "NODE") continue;
          if (!action.destinationId) continue;
          edges.push({ from: n.id, to: action.destinationId, trigger: trigger || "ON_CLICK", label: n.name });
        }
      }
      if (n.children && n.children.length) walk(n.children);
    }
  })(nodes || []);

  if (!edges.length) return "graph LR\n  %% No NAVIGATE reactions found in this tree.\n";

  var lines = ["graph LR"];
  var seenNodes = {};
  function declare(id) {
    if (seenNodes[id]) return seenNodes[id];
    var entry = index[id] || { slug: id, name: id };
    var mid = mermaidSafe(entry.slug);
    // ensure uniqueness across slugs that normalize to the same string
    var counter = 1;
    var base = mid;
    while (Object.keys(seenNodes).some(function (k) { return seenNodes[k] === mid; })) {
      mid = base + "_" + (++counter);
    }
    seenNodes[id] = mid;
    lines.push("  " + mid + '["' + String(entry.name).replace(/"/g, "'") + '"]');
    return mid;
  }
  for (var i = 0; i < edges.length; i++) {
    var f = declare(edges[i].from);
    var tgt = declare(edges[i].to);
    var label = String(edges[i].label || edges[i].trigger).replace(/"/g, "'").replace(/\|/g, "/");
    lines.push("  " + f + ' -->|' + label + '| ' + tgt);
  }
  return lines.join("\n") + "\n";
}

var BUDGETS = { small: 8000, medium: 32000, large: 128000 };

// Priority order (keep first, drop last) when the budget is exceeded.
function priorityRank(path) {
  if (path === "tokens.json") return 0;
  if (path === "tokens.css") return 1;
  if (path === "hierarchy.md") return 2;
  if (path === "AGENTS.md") return 3;
  if (path === "components.json") return 4;
  if (path === "ISSUES.md" || path === "issues.json") return 5;
  if (path === "DESIGN.md") return 6;
  if (path === "flow.mmd") return 6;
  if (path === "responsive.md" || path === "responsive.json") return 5;
  if (path === "CHANGES.md" || path === "changes.json") return 7;
  if (path === "snapshot.json") return 8;
  if (/^components\//.test(path)) return 9;
  if (/^screenshots\//.test(path)) return 10;
  return 11;
}

function applyBudget(files, tier) {
  var cap = BUDGETS[tier] || BUDGETS.large;
  // Sort a working copy by priority ascending; add until cap hit.
  var ranked = files.map(function (f, i) { return { f: f, rank: priorityRank(f.path), order: i }; });
  ranked.sort(function (a, b) { return a.rank - b.rank || a.order - b.order; });
  var kept = {};
  var total = 0;
  for (var i = 0; i < ranked.length; i++) {
    var f = ranked[i].f;
    var tokens = typeof f.data === "string" ? estimateTokens(f.data) : (f.data && f.data.length ? Math.ceil(f.data.length / 4) : 0);
    // Always keep the top two files (tokens.json, tokens.css) even if they'd exceed.
    if (ranked[i].rank <= 1 || total + tokens <= cap) {
      kept[f.path] = true;
      total += tokens;
    }
  }
  return files.filter(function (f) { return kept[f.path]; });
}

function buildAgentBundle(nodes, pageTitle, opts) {
  opts = opts || {};
  resetCSS("css");
  assignSlugs(nodes, "");
  var files = [];
  // Stable-first ordering for prompt-cache friendliness.
  files.push({ path: "tokens.json", data: buildTokensJSON(_varMap) });
  files.push({ path: "tokens.css", data: rootVarsBlock() });
  var _swiftExt = buildSwiftColorExtension(_varMap);
  if (_swiftExt) files.push({ path: "ios/Colors.swift", data: _swiftExt });
  // Resolve component mapping: explicit opts.mappings wins; otherwise fuzzy-match
  // user-supplied opts.codePaths (array of file paths) against Figma components.
  var mapping = opts.mappings || {};
  if (!opts.mappings && opts.codePaths && opts.codePaths.length) {
    mapping = fuzzyMatchComponents(collectFigmaComponentNames(nodes), opts.codePaths, { threshold: opts.matchThreshold });
  }
  opts = Object.assign({}, opts, { mappings: mapping });
  files.push({ path: "components.json", data: componentsJson(nodes, mapping) });
  files.push({ path: "hierarchy.md", data: hierarchyMd(nodes) });
  files.push({ path: "DESIGN.md", data: designMd(nodes, pageTitle) });
  // Accessibility audit — include findings + a dedicated issues doc.
  var issues = auditA11y(nodes);
  opts = Object.assign({}, opts, { issues: issues });
  files.push({ path: "AGENTS.md", data: agentsMd(pageTitle, opts) });
  files.push({ path: "issues.json", data: JSON.stringify(issues, null, 2) });
  files.push({ path: "ISSUES.md", data: issuesMd(issues) });
  // Responsive frame groups.
  var rgroups = groupResponsiveFrames(nodes);
  if (rgroups.length) {
    files.push({ path: "responsive.md", data: responsiveMd(rgroups) });
    files.push({ path: "responsive.json", data: responsiveJson(rgroups) });
  }
  // Flow graph from prototype reactions.
  var flow = flowMermaid(nodes);
  if (flow && flow.indexOf("-->") !== -1) files.push({ path: "flow.mmd", data: flow });
  // Emit typed React + Storybook files for each COMPONENT_SET.
  var compFiles = buildComponentFiles(nodes);
  for (var cf = 0; cf < compFiles.length; cf++) files.push(compFiles[cf]);
  // Screenshots, if provided via opts.screenshots = { [nodeId]: Uint8Array }.
  if (opts.screenshots) {
    var ids = Object.keys(opts.screenshots);
    for (var i = 0; i < ids.length; i++) {
      var slug = _slugMap.get(ids[i]) || ids[i].replace(/[:/]/g, "_");
      files.push({ path: "screenshots/" + slug + ".png", data: opts.screenshots[ids[i]] });
    }
  }
  // Snapshot current tree for the caller to persist (used by next run's diff).
  var snapshot = buildSnapshot(nodes);
  files.push({ path: "snapshot.json", data: JSON.stringify(snapshot, null, 2) });
  // If a prior snapshot was provided, emit CHANGES.md + changes.json.
  if (opts.priorSnapshot) {
    var diff = diffSnapshots(opts.priorSnapshot, snapshot);
    files.push({ path: "CHANGES.md", data: changesMd(diff) });
    files.push({ path: "changes.json", data: JSON.stringify(diff, null, 2) });
  }
  // Extra files passed in.
  if (opts.extraFiles) {
    for (var j = 0; j < opts.extraFiles.length; j++) files.push(opts.extraFiles[j]);
  }
  // Apply token budget — drop low-priority files past the cap.
  if (opts.budget) files = applyBudget(files, opts.budget);
  files.push({ path: "manifest.json", data: manifestJson(files) });
  return files;
}

function buildSwiftColorExtension(varMap) {
  var ids = Object.keys(varMap || {});
  var lines = [];
  for (var i = 0; i < ids.length; i++) {
    var e = varMap[ids[i]];
    if (!e) continue;
    var isColor = e.type === "color" || e.type === "COLOR" || (typeof e.value === "string" && e.value.charAt(0) === "#");
    if (!isColor) continue;
    var m = /^#([0-9a-f]{6})$/i.exec(String(e.value || ""));
    if (!m) continue;
    var r = parseInt(m[1].slice(0, 2), 16) / 255;
    var g = parseInt(m[1].slice(2, 4), 16) / 255;
    var b = parseInt(m[1].slice(4, 6), 16) / 255;
    var name = sanitizeSwiftIdent(e.name || e.cssName);
    lines.push("  /// " + (e.name || e.cssName) + " — " + String(e.value).toLowerCase());
    lines.push("  static let " + name +
      " = Color(red: " + r.toFixed(3) + ", green: " + g.toFixed(3) + ", blue: " + b.toFixed(3) + ")");
  }
  if (!lines.length) return null;
  return "// Auto-generated by Figbridge — design tokens as SwiftUI Colors.\n" +
         "import SwiftUI\n\nextension Color {\n" + lines.join("\n") + "\n}\n";
}

function buildTailwindConfig(varMap) {
  var buckets = { colors: {}, spacing: {}, borderRadius: {}, fontSize: {} };
  var ids = Object.keys(varMap || {});
  ids.forEach(function (id) {
    var e = varMap[id];
    if (!e || !e.name) return;
    var parts = String(e.name).split("/").map(function (s) {
      return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    }).filter(Boolean);
    if (!parts.length) return;
    var key = parts.join("-");
    var first = parts[0];
    var bucket;
    if (e.type === "color" || first === "colors" || first === "color") bucket = "colors";
    else if (first === "spacing" || first === "space" || first === "padding" || first === "gap") bucket = "spacing";
    else if (first === "radius" || first === "rounded") bucket = "borderRadius";
    else if (first === "font-size" || first === "text" || first === "typography") bucket = "fontSize";
    else if (e.type === "dimension") bucket = "spacing";
    else return;
    buckets[bucket][key] = "var(" + e.cssName + ")";
  });
  function bucketStr(b) {
    var keys = Object.keys(buckets[b]);
    if (!keys.length) return "";
    var lines = keys.map(function (k) { return '        "' + k + '": "' + buckets[b][k] + '"'; });
    return "      " + b + ": {\n" + lines.join(",\n") + "\n      },\n";
  }
  var body = bucketStr("colors") + bucketStr("spacing") + bucketStr("borderRadius") + bucketStr("fontSize");
  return '/** @type {' + 'import' + '("tailwindcss").Config} */\nmodule.exports = {\n'
    + '  content: ["./**/*.{html,js,jsx,ts,tsx}"],\n'
    + '  theme: {\n    extend: {\n'
    + body
    + '    },\n  },\n  plugins: [],\n};\n';
}

function htmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildStackblitzHTML(files, title) {
  var inputs = files.map(function (f) {
    return '<textarea name="project[files][' + htmlEscape(f.path) + ']">' + htmlEscape(f.data) + '</textarea>';
  }).join("");
  inputs += '<input name="project[title]" value="' + htmlEscape(title || "Frameshift Export") + '">';
  inputs += '<input name="project[description]" value="Generated by Frameshift">';
  inputs += '<input name="project[template]" value="html">';
  return '<!doctype html><html><body><form id="f" method="post" action="https://stackblitz.com/run" target="_self">'
    + inputs + '</form><script>document.getElementById("f").submit()</script></body></html>';
}

function buildBundle(nodes, pageTitle) {
  var out = buildOutput(nodes, pageTitle);
  var files = [];
  var name = pascal(pageTitle);
  if (_mode === "tailwind") {
    files.push({ path: "index.html", data: out.html });
    if (Object.keys(_varMap).length) files.push({ path: "tailwind.config.js", data: buildTailwindConfig(_varMap) });
  } else if (_mode === "react") {
    files.push({ path: name + ".jsx", data: out.jsx });
    files.push({ path: name + ".css", data: out.css });
    files.push({ path: "index.html", data: out.html });
  } else if (_mode === "swiftui") {
    files.push({ path: name + ".swift", data: out.code });
  } else if (_mode === "compose") {
    files.push({ path: name + ".kt", data: out.code });
  } else {
    files.push({ path: "index.html", data: out.html });
    files.push({ path: "styles.css", data: out.css });
  }
  var assetIds = Object.keys(_assetCache);
  for (var i = 0; i < assetIds.length; i++) {
    var a = _assetCache[assetIds[i]];
    if (a.kind === "svg") files.push({ path: "assets/" + assetIds[i].replace(/[:/]/g, "_") + ".svg", data: a.data });
  }
  return files;
}
function minifyCSS(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").replace(/\s*([{}:;,>])\s*/g, "$1").replace(/;}/g, "}").trim();
}
function minifyHTML(s) {
  return s.replace(/>\s+</g, "><").replace(/\n\s*/g, "").trim();
}

function buildHTML(nodes, pageTitle) {
  assignSlugs(nodes, "");
  var bodies = nodes.map(function (n) { return { name: n.name, html: nodeToHTML(n, 0) }; });
  var htmlBody = bodies.map(function (b) { return b.html; }).join("\n\n");
  var isTw = _mode === "tailwind";
  var isReact = _mode === "react";
  var rootBlock = rootVarsBlock();
  var css = isTw
    ? "/* Frameshift — Tailwind mode\n   Page: " + pageTitle + " — utilities are inline on elements. */\n\n" + rootBlock
    : "/* Figma → HTML/CSS Exporter v2\n   Page: " + pageTitle + " */\n\n" + rootBlock + "* { margin:0; padding:0; box-sizing:border-box; }\n\n" + textStylesBlock() + serializeRules();

  var jsx = null;
  if (isReact) {
    var name = pascal(pageTitle);
    jsx = 'import "./' + name + '.css";\n\nexport default function ' + name + '() {\n  return (\n    <>\n' +
          htmlBody.split("\n").map(function (l) { return l ? "      " + l : l; }).join("\n") +
          "\n    </>\n  );\n}\n";
  }

  var head = '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8" />\n  <meta name="viewport" content="width=device-width,initial-scale=1.0" />\n  <title>' + pageTitle + "</title>\n";
  var previewBody = htmlBody.replace(/className=/g, 'class=').replace(/<br \/>/g, "<br>");
  var body = isTw
    ? "  <style>\n" + rootBlock + "  </style>\n  <script src=\"https://cdn.tailwindcss.com\"></script>\n</head>\n<body>\n" + previewBody + "\n</body>\n</html>"
    : "  <style>\n" + css + "\n  </style>\n</head>\n<body>\n" + previewBody + "\n</body>\n</html>";
  var outHtml = head + body;
  var outCss = css;
  var outRaw = htmlBody;
  if (_minify) {
    outCss = minifyCSS(outCss);
    outRaw = minifyHTML(outRaw);
    outHtml = minifyHTML(head) + (isTw
      ? "<style>" + minifyCSS(rootBlock) + "</style><script src=\"https://cdn.tailwindcss.com\"></script></head><body>" + minifyHTML(previewBody) + "</body></html>"
      : "<style>" + minifyCSS(css) + "</style></head><body>" + minifyHTML(previewBody) + "</body></html>");
  }
  return {
    html: outHtml,
    css: outCss,
    rawHtml: outRaw,
    jsx: jsx,
    nodeNames: nodes.map(function (n) { return n.name; })
  };
}

// ── SwiftUI emitter ───────────────────────────────────────────
function swiftColor(paint) {
  if (!paint || paint.type !== "SOLID") return null;
  var tok = paintToTokenRef(paint);
  if (tok) return "Color." + tok.swiftName; // resolves via ios/Colors.swift extension in the bundle
  var c = paint.color, o = paint.opacity == null ? 1 : paint.opacity;
  return "Color(red: " + c.r.toFixed(3) + ", green: " + c.g.toFixed(3) + ", blue: " + c.b.toFixed(3) + ", opacity: " + o.toFixed(3) + ")";
}
function swiftFontWeight(style) {
  var s = (style || "").toLowerCase();
  if (s.indexOf("thin") >= 0) return ".thin";
  if (s.indexOf("light") >= 0) return ".light";
  if (s.indexOf("medium") >= 0) return ".medium";
  if (s.indexOf("semibold") >= 0) return ".semibold";
  if (s.indexOf("bold") >= 0) return ".bold";
  if (s.indexOf("black") >= 0 || s.indexOf("heavy") >= 0) return ".black";
  return ".regular";
}
function nodeToSwift(node, depth) {
  depth = depth || 0;
  var ind = "  ".repeat(depth + 2);
  var childInd = "  ".repeat(depth + 3);
  var modifiers = [];
  var w = Math.round(node.width), h = Math.round(node.height);

  if (node.type === "TEXT") {
    var text = "Text(\"" + String(node.characters || "").replace(/"/g, "\\\"") + "\")";
    var ff = node.fontName !== figma.mixed ? node.fontName : null;
    var fs = node.fontSize !== figma.mixed ? node.fontSize : 16;
    if (ff) modifiers.push(".font(.system(size: " + fs + ", weight: " + swiftFontWeight(ff.style) + "))");
    if (node.fills && node.fills.length) {
      var tc = swiftColor(node.fills[node.fills.length - 1]);
      if (tc) modifiers.push(".foregroundColor(" + tc + ")");
    }
    return ind + text + modifiers.map(function (m) { return "\n" + childInd + m; }).join("");
  }

  var stackKind = "ZStack";
  var stackArgs = "";
  if (node.layoutMode === "HORIZONTAL") { stackKind = "HStack"; stackArgs = "(spacing: " + (node.itemSpacing || 0) + ")"; }
  else if (node.layoutMode === "VERTICAL") { stackKind = "VStack"; stackArgs = "(spacing: " + (node.itemSpacing || 0) + ")"; }

  var kids = "";
  if (node.children && node.children.length) {
    kids = "\n" + node.children.map(function (c) { return nodeToSwift(c, depth + 1); }).join("\n") + "\n" + ind;
  }

  if (node.layoutMode && node.layoutMode !== "NONE") {
    var pt = node.paddingTop || 0, pr = node.paddingRight || 0, pb = node.paddingBottom || 0, pl = node.paddingLeft || 0;
    if (pt || pr || pb || pl) {
      modifiers.push(".padding(EdgeInsets(top: " + pt + ", leading: " + pl + ", bottom: " + pb + ", trailing: " + pr + "))");
    }
  }
  modifiers.push(".frame(width: " + w + ", height: " + h + ")");
  if (node.fills && node.fills.length) {
    var bg = swiftColor(node.fills[node.fills.length - 1]);
    if (bg) modifiers.push(".background(" + bg + ")");
  }
  if (node.cornerRadius && node.cornerRadius !== figma.mixed) {
    modifiers.push(".cornerRadius(" + node.cornerRadius + ")");
  }
  if (node.opacity !== undefined && node.opacity < 1) {
    modifiers.push(".opacity(" + node.opacity.toFixed(3) + ")");
  }

  return ind + stackKind + stackArgs + " {" + kids + "}" +
    modifiers.map(function (m) { return "\n" + childInd + m; }).join("");
}

function buildSwiftUI(nodes, pageTitle) {
  var name = pascal(pageTitle);
  var body = nodes.map(function (n) { return nodeToSwift(n, 0); }).join("\n");
  var code = "import SwiftUI\n\nstruct " + name + ": View {\n  var body: some View {\n" + body + "\n  }\n}\n\n" +
             "#Preview {\n  " + name + "()\n}\n";
  return {
    code: code,
    codeLanguage: "swift",
    html: "<!-- SwiftUI output — no HTML preview -->\n<pre style='font-family:monospace;padding:16px;'>" + code.replace(/</g, "&lt;") + "</pre>",
    css: "",
    rawHtml: "",
    jsx: null,
    nodeNames: nodes.map(function (n) { return n.name; })
  };
}

// ── Jetpack Compose emitter ───────────────────────────────────
function kotlinColor(paint) {
  if (!paint || paint.type !== "SOLID") return null;
  var tok = paintToTokenRef(paint);
  var c = paint.color, o = paint.opacity == null ? 1 : paint.opacity;
  var toHex = function (v) { return Math.round(v * 255).toString(16).padStart(2, "0").toUpperCase(); };
  var a = Math.round(o * 255).toString(16).padStart(2, "0").toUpperCase();
  var lit = "Color(0x" + a + toHex(c.r) + toHex(c.g) + toHex(c.b) + ")";
  return tok ? lit + " /* " + tok.name + " */" : lit;
}
function kotlinFontWeight(style) {
  var s = (style || "").toLowerCase();
  if (s.indexOf("thin") >= 0) return "FontWeight.Thin";
  if (s.indexOf("light") >= 0) return "FontWeight.Light";
  if (s.indexOf("medium") >= 0) return "FontWeight.Medium";
  if (s.indexOf("semibold") >= 0) return "FontWeight.SemiBold";
  if (s.indexOf("bold") >= 0) return "FontWeight.Bold";
  if (s.indexOf("black") >= 0) return "FontWeight.Black";
  return "FontWeight.Normal";
}
function nodeToKotlin(node, depth) {
  depth = depth || 0;
  var ind = "  ".repeat(depth + 1);
  var w = Math.round(node.width), h = Math.round(node.height);

  if (node.type === "TEXT") {
    var ff = node.fontName !== figma.mixed ? node.fontName : null;
    var fs = node.fontSize !== figma.mixed ? node.fontSize : 16;
    var parts = ["\"" + String(node.characters || "").replace(/"/g, "\\\"") + "\""];
    parts.push("fontSize = " + fs + ".sp");
    if (ff) parts.push("fontWeight = " + kotlinFontWeight(ff.style));
    if (node.fills && node.fills.length) {
      var tc = kotlinColor(node.fills[node.fills.length - 1]);
      if (tc) parts.push("color = " + tc);
    }
    return ind + "Text(" + parts.join(", ") + ")";
  }

  var container = "Box";
  if (node.layoutMode === "HORIZONTAL") container = "Row";
  else if (node.layoutMode === "VERTICAL") container = "Column";

  var modParts = ["Modifier.size(" + w + ".dp, " + h + ".dp)"];
  if (node.fills && node.fills.length) {
    var bg = kotlinColor(node.fills[node.fills.length - 1]);
    if (bg && node.cornerRadius && node.cornerRadius !== figma.mixed) {
      modParts.push(".background(" + bg + ", RoundedCornerShape(" + node.cornerRadius + ".dp))");
    } else if (bg) {
      modParts.push(".background(" + bg + ")");
    }
  }
  if (node.layoutMode && node.layoutMode !== "NONE") {
    var pt = node.paddingTop || 0, pr = node.paddingRight || 0, pb = node.paddingBottom || 0, pl = node.paddingLeft || 0;
    if (pt || pr || pb || pl) {
      modParts.push(".padding(start = " + pl + ".dp, top = " + pt + ".dp, end = " + pr + ".dp, bottom = " + pb + ".dp)");
    }
  }

  var argList = ["modifier = " + modParts.join("")];
  if (container === "Row" || container === "Column") {
    if (node.itemSpacing) argList.push("horizontalArrangement = Arrangement.spacedBy(" + node.itemSpacing + ".dp)");
  }

  var kids = "";
  if (node.children && node.children.length) {
    kids = "\n" + node.children.map(function (c) { return nodeToKotlin(c, depth + 1); }).join("\n") + "\n" + ind;
  }
  return ind + container + "(" + argList.join(", ") + ") {" + kids + "}";
}

function buildCompose(nodes, pageTitle) {
  var name = pascal(pageTitle);
  var body = nodes.map(function (n) { return nodeToKotlin(n, 0); }).join("\n");
  var code = "import androidx.compose.foundation.background\n" +
             "import androidx.compose.foundation.layout.*\n" +
             "import androidx.compose.foundation.shape.RoundedCornerShape\n" +
             "import androidx.compose.material3.Text\n" +
             "import androidx.compose.runtime.Composable\n" +
             "import androidx.compose.ui.Modifier\n" +
             "import androidx.compose.ui.graphics.Color\n" +
             "import androidx.compose.ui.text.font.FontWeight\n" +
             "import androidx.compose.ui.unit.dp\n" +
             "import androidx.compose.ui.unit.sp\n\n" +
             "@Composable\n" +
             "fun " + name + "() {\n" + body + "\n}\n";
  return {
    code: code,
    codeLanguage: "kotlin",
    html: "<!-- Compose output — no HTML preview -->\n<pre style='font-family:monospace;padding:16px;'>" + code.replace(/</g, "&lt;") + "</pre>",
    css: "",
    rawHtml: "",
    jsx: null,
    nodeNames: nodes.map(function (n) { return n.name; })
  };
}

// ── Dispatch by mode ──────────────────────────────────────────
function buildOutput(nodes, pageTitle) {
  if (_mode === "swiftui") return buildSwiftUI(nodes, pageTitle);
  if (_mode === "compose") return buildCompose(nodes, pageTitle);
  return buildHTML(nodes, pageTitle);
}

// ── Export selected nodes on current page ─────────────────────
async function exportSelection(mode) {
  var sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: "error", message: "No selection. Select at least one frame." });
    return;
  }
  resetCSS(mode);
  setVariableMap(await loadVariables());
  setAssetCache(await prefetchAssets(sel.slice()));
  resetMainCompCache();
  setTextStyleMap(await loadTextStyles(sel.slice()));
  await prefetchMainComponents(sel.slice());
  var result = buildOutput(sel.slice(), figma.currentPage.name);
  figma.ui.postMessage(Object.assign({ type: "result", pageName: figma.currentPage.name, mode: mode || "css" }, result));
}

// ── Export specific node IDs (from picker) ────────────────────
async function exportNodes(pageId, nodeIds, mode) {
  var page = figma.root.children.find(function (p) { return p.id === pageId; });
  if (page) await figma.setCurrentPageAsync(page);

  var nodes = [];
  for (var k = 0; k < nodeIds.length; k++) {
    var n = await figma.getNodeByIdAsync(nodeIds[k]);
    if (n) nodes.push(n);
  }
  if (!nodes.length) {
    figma.ui.postMessage({ type: "error", message: "No valid frames found on this page." });
    return;
  }
  resetCSS(mode);
  setVariableMap(await loadVariables());
  setAssetCache(await prefetchAssets(nodes));
  resetMainCompCache();
  setTextStyleMap(await loadTextStyles(nodes));
  await prefetchMainComponents(nodes);
  var result = buildOutput(nodes, figma.currentPage.name);
  figma.ui.postMessage(Object.assign({ type: "result", pageName: figma.currentPage.name, mode: mode || "css" }, result));
}

// ── Export all frames across ALL pages ────────────────────────
async function exportAllPages(mode) {
  var pageResults = [];
  var all = figma.root.children;
  for (var i = 0; i < all.length; i++) {
    var page = all[i];
    await figma.setCurrentPageAsync(page);
    var frames = page.children.filter(function (n) { return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP"; });
    if (!frames.length) continue;
    resetCSS(mode);
    setVariableMap(await loadVariables());
    setAssetCache(await prefetchAssets(frames));
    resetMainCompCache();
    setTextStyleMap(await loadTextStyles(frames));
    await prefetchMainComponents(frames);
    var result = buildOutput(frames, page.name);
    pageResults.push(Object.assign({ pageName: page.name, pageId: page.id, frameCount: frames.length }, result));
    figma.ui.postMessage({ type: "page-progress", pageName: page.name, done: pageResults.length, total: all.length });
  }
  figma.ui.postMessage({ type: "all-pages-result", pages: pageResults, mode: mode || "css" });
}

async function exportAgentBundle(msg) {
  try {
    var sel = figma.currentPage.selection;
    var roots = sel.length
      ? sel.slice()
      : figma.currentPage.children.filter(function (n) {
          return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "COMPONENT_SET";
        });
    if (!roots.length) {
      figma.ui.postMessage({ type: "error", message: "Select at least one frame, or open a page that has frames." });
      return;
    }

    resetCSS("css");
    resetMainCompCache();
    setVariableMap(await loadVariables());
    setAssetCache(await prefetchAssets(roots));
    setTextStyleMap(await loadTextStyles(roots));
    await prefetchMainComponents(roots);

    // Load persisted slug lockfile + prior snapshot.
    var slugLock = {};
    var priorSnapshot = null;
    if (figma.clientStorage) {
      try { slugLock = (await figma.clientStorage.getAsync("frameshift:slugLock")) || {}; } catch (e) {}
      try { priorSnapshot = (await figma.clientStorage.getAsync("frameshift:snapshot")) || null; } catch (e) {}
    }
    setSlugLock(slugLock);

    // Optional screenshots per top-level root frame.
    var screenshots = null;
    if (msg.screenshots) {
      screenshots = {};
      for (var i = 0; i < roots.length; i++) {
        try {
          var bytes = await roots[i].exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } });
          screenshots[roots[i].id] = bytes;
        } catch (e) { /* skip unexportable nodes */ }
      }
    }

    var files = buildAgentBundle(roots, figma.currentPage.name, {
      budget: msg.budget || "medium",
      screenshots: screenshots,
      codePaths: msg.codePaths || [],
      priorSnapshot: priorSnapshot,
    });

    // Persist new slug lockfile + snapshot for next run.
    if (figma.clientStorage) {
      try { await figma.clientStorage.setAsync("frameshift:slugLock", getSlugLock()); } catch (e) {}
      var snapFile = files.find(function (f) { return f.path === "snapshot.json"; });
      if (snapFile) {
        try { await figma.clientStorage.setAsync("frameshift:snapshot", JSON.parse(snapFile.data)); } catch (e) {}
      }
    }

    var zipBytes = buildZip(files);
    figma.ui.postMessage({
      type: "agent-bundle-result",
      zip: Array.from(zipBytes),
      pageName: figma.currentPage.name,
      fileCount: files.length,
    });
  } catch (err) {
    figma.ui.postMessage({ type: "error", message: "Agent bundle failed: " + (err && err.message ? err.message : err) });
  }
}


  async function computeAgentBundle(roots, opts) {
    opts = opts || {};
    resetCSS("css");
    resetMainCompCache();
    setVariableMap(await loadVariables());
    setAssetCache(await prefetchAssets(roots));
    setTextStyleMap(await loadTextStyles(roots));
    await prefetchMainComponents(roots);
    var slugLock = {};
    var priorSnapshot = null;
    if (figma.clientStorage) {
      try { slugLock = (await figma.clientStorage.getAsync("frameshift:slugLock")) || {}; } catch (e) {}
      try { priorSnapshot = (await figma.clientStorage.getAsync("frameshift:snapshot")) || null; } catch (e) {}
    }
    setSlugLock(slugLock);
    var screenshots = null;
    if (opts.screenshots) {
      screenshots = {};
      for (var i = 0; i < roots.length; i++) {
        try { screenshots[roots[i].id] = await roots[i].exportAsync({ format: "PNG", constraint: { type: "SCALE", value: 1 } }); } catch (e) {}
      }
    }
    var files = buildAgentBundle(roots, figma.currentPage.name, {
      budget: opts.budget || "medium",
      screenshots: screenshots,
      codePaths: opts.codePaths || [],
      priorSnapshot: priorSnapshot,
    });
    if (figma.clientStorage) {
      try { await figma.clientStorage.setAsync("frameshift:slugLock", getSlugLock()); } catch (e) {}
      var snapFile = files.find(function (f) { return f.path === "snapshot.json"; });
      if (snapFile) { try { await figma.clientStorage.setAsync("frameshift:snapshot", JSON.parse(snapFile.data)); } catch (e) {} }
    }
    return files;
  }
  return {
    exportAgentBundle: exportAgentBundle,
    buildAgentBundle: buildAgentBundle,
    computeAgentBundle: computeAgentBundle,
  };
})();
