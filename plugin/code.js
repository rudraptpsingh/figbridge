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

function countInstances(node, set) {
  set = set || {};
  if (node.type === "INSTANCE" && node.mainComponent) {
    var key = node.mainComponent.name || node.mainComponent.id;
    set[key] = (set[key] || 0) + 1;
  }
  if ("children" in node) for (var i = 0; i < node.children.length; i++) countInstances(node.children[i], set);
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
      return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "COMPONENT_SET";
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
  var instances = countInstances(node);
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
      if (n.type === "INSTANCE" && n.mainComponent) componentsUsed[n.mainComponent.id] = (componentsUsed[n.mainComponent.id] || 0) + 1;
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
  // cap findings
  var MAX = 500;
  var truncated = findings.length > MAX;
  return { ok: true, findingsCount: findings.length, findings: findings.slice(0, MAX), truncated: truncated };
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
