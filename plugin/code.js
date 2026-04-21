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
    case "close": figma.closePlugin(); break;
  }
};
