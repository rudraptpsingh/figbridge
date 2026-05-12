// ============================================================
// Figbridge  |  code.js  (main thread)
// Figma → HTML/CSS + Tailwind + Design Tokens, with a live bridge
// to the Figbridge MCP so agents can pull code from Figma.
// ES2017-safe: no ??, no ?., no object-spread, no .at()
// ============================================================

figma.showUI(__html__, { width: 680, height: 820, title: "Figbridge" });

// ── Token reverse lookup (hex → variable) ────────────────────
// Declared at the very top so every emitter (paintToCSS, strokeToCSS,
// swiftColor, kotlinColor) can reach it regardless of source order.
// `_varByHex` is populated by setVariableMap() later in the file.
var _varByHex = {};
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

// ── Page map ──────────────────────────────────────────────────
function _summarizeNode(n) {
  var hasChildren = ("children" in n) && n.children && n.children.length > 0;
  var w = (typeof n.width === "number") ? Math.round(n.width) : null;
  var h = (typeof n.height === "number") ? Math.round(n.height) : null;
  return { id: n.id, name: n.name || "(unnamed)", type: n.type, width: w, height: h, hasChildren: hasChildren };
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
// ── CSS accumulator ───────────────────────────────────────────
var _counter = 0;
var _classMap = new Map();
var _rules = [];

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

// Token extraction is the slow part of an export on large files — every
// variable is fetched via an async round-trip. Cache the result across
// rapid-fire exports (tokens don't change when the user just clicks between
// screens). Invalidation happens via `invalidateTokenCache()` when documents
// change or on explicit refresh.
var _tokenCache = null;
var _tokenCacheInflight = null;
var _varMapCache = null;
var _varMapInflight = null;
function invalidateTokenCache() {
  _tokenCache = null; _tokenCacheInflight = null;
  _varMapCache = null; _varMapInflight = null;
}
// Inlined copy of loadVariables() — Figma's plugin sandbox doesn't always
// hoist function declarations at file scope reliably, so referencing the
// late-declared loadVariables() from here during auto-push throws
// "'loadVariables' is not defined". Self-contained version avoids that.
async function _loadVariablesInline() {
  if (typeof figma === "undefined" || !figma.variables || !figma.variables.getLocalVariablesAsync) return {};
  try {
    var vars = await figma.variables.getLocalVariablesAsync();
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    var colMap = {};
    cols.forEach(function (c) { colMap[c.id] = c; });
    var sanitize = function (s) {
      return "--" + String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    };
    var toCSS = function (v, val) {
      if (v.resolvedType === "COLOR") {
        var t = function (x) { return Math.round((x == null ? 0 : x) * 255); };
        var a = val.a == null ? 1 : val.a;
        var hex = "#" + [val.r, val.g, val.b].map(function (x) { return t(x).toString(16).padStart(2, "0"); }).join("");
        return { css: a < 1 ? "rgba(" + t(val.r) + "," + t(val.g) + "," + t(val.b) + "," + a + ")" : hex, type: "color" };
      }
      if (v.resolvedType === "FLOAT")   return { css: val + "px", type: "dimension" };
      if (v.resolvedType === "BOOLEAN") return { css: String(val), type: "boolean" };
      return { css: String(val), type: "string" };
    };
    var map = {};
    vars.forEach(function (v) {
      var col = colMap[v.variableCollectionId]; if (!col) return;
      var val = v.valuesByMode[col.defaultModeId]; if (val == null) return;
      var c = toCSS(v, val);
      map[v.id] = { cssName: sanitize(v.name), value: c.css, name: v.name, type: c.type,
                    rawValue: c.type === "color" ? c.css : c.css, valuesByMode: {} };
    });
    return map;
  } catch (e) { return {}; }
}
function loadVariablesCached() {
  if (_varMapCache) return Promise.resolve(_varMapCache);
  if (_varMapInflight) return _varMapInflight;
  _varMapInflight = _loadVariablesInline().then(function (m) {
    _varMapCache = m || {}; _varMapInflight = null; return _varMapCache;
  });
  return _varMapInflight;
}
// Inline equivalent of setVariableMap() — Figma's QuickJS sandbox does
// not hoist later `function` declarations backward, so code in this
// upper half of the file cannot call the canonical setVariableMap()
// declared near line 1538. Keep this in sync with it.
function _setVariableMapInline(map) {
  _varMap = map || {};
  _varByHex = {};
  var ids = Object.keys(_varMap);
  for (var i = 0; i < ids.length; i++) {
    var e = _varMap[ids[i]];
    if (!e) continue;
    var isColor = e.type === "color" || e.type === "COLOR" ||
      (typeof e.value === "string" && String(e.value).charAt(0) === "#");
    if (!isColor) continue;
    var v = String(e.value || "").toLowerCase();
    var m = /^#([0-9a-f]{6})$/.exec(v);
    if (!m) continue;
    _varByHex["#" + m[1]] = {
      cssName: e.cssName,
      swiftName: sanitizeSwiftIdent(e.name || e.cssName),
      name: e.name || e.cssName
    };
  }
}

async function extractTokens() {
  if (_tokenCache) return _tokenCache;
  if (_tokenCacheInflight) return _tokenCacheInflight;
  _tokenCacheInflight = (async function () {
  var tokens = { colors: {}, numbers: {}, strings: {}, booleans: {} };
  try {
    var cols = await figma.variables.getLocalVariableCollectionsAsync();
    // Resolve every variable in parallel — serial awaits were dominant cost
    // on files with 50+ tokens (50 sequential plugin-sandbox round-trips).
    var all = [];
    for (var i = 0; i < cols.length; i++) {
      var col = cols[i];
      for (var j = 0; j < col.variableIds.length; j++) {
        all.push({ col: col, varId: col.variableIds[j] });
      }
    }
    var vars = await Promise.all(all.map(function (x) {
      return figma.variables.getVariableByIdAsync(x.varId).catch(function () { return null; });
    }));
    for (var k = 0; k < all.length; k++) {
      var col2 = all[k].col, v = vars[k];
      if (!v) continue;
      var modeId = col2.defaultModeId;
      var val = v.valuesByMode[modeId];
      if (val && val.type === "VARIABLE_ALIAS") continue;
      var key = slug(col2.name) + "/" + slug(v.name);
      if (v.resolvedType === "COLOR" && val) tokens.colors[key] = rgbaToCSS(val);
      else if (v.resolvedType === "FLOAT") tokens.numbers[key] = val;
      else if (v.resolvedType === "STRING") tokens.strings[key] = val;
      else if (v.resolvedType === "BOOLEAN") tokens.booleans[key] = val;
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

    var out = { tokens: tokens, cssVars: cssVarsFile, tailwindConfig: twConfig };
    _tokenCache = out;
    _tokenCacheInflight = null;
    return out;
  })();
  return _tokenCacheInflight;
}

// ── Export drivers ────────────────────────────────────────────
async function exportPayload(nodes, pageName) {
  // Prefer the selected node's name as the document title when the user is
  // exporting a single frame — otherwise the page label ("04 · Screens")
  // leaks into <title> even when only one screen was picked.
  var label = (nodes && nodes.length === 1 && nodes[0] && nodes[0].name)
    ? (pageName ? pageName + " · " + nodes[0].name : nodes[0].name)
    : pageName;
  // Populate the hex→variable index so CSS/Tailwind/Swift can emit token
  // references. Cached across exports for cheap re-runs.
  var vmapPromise = loadVariablesCached().then(_setVariableMapInline);
  // Kick off the (potentially slow, async) token extraction before the
  // synchronous tree walks so it runs in parallel with them.
  var tokPromise = extractTokens();
  await vmapPromise; // needed before tree walk so color emitters see tokens
  // HTML+CSS is the default tab — always build it. Tailwind and SwiftUI
  // each walk the full node tree independently and every property read is
  // a sandbox round-trip; on a 200-node screen that alone dominates. Build
  // them lazily when the user actually clicks those tabs (see `build-format`
  // message handler).
  var html = buildHTML(nodes, label);
  var tok = await tokPromise;
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
    tailwindHtml: null, // lazy — UI requests on tab switch
    swift: null,        // lazy — UI requests on tab switch
    tokens: tok.tokens,
    cssVars: tok.cssVars,
    tailwindConfig: tok.tailwindConfig,
    capturedAt: Date.now()
  };
}

// Monotonic export token — any new exportNodes/exportSelection call bumps
// this. If a slow export finishes after a newer one has started, its result
// is silently dropped instead of stomping fresh output in the UI.
var _exportTok = 0;
// Build a single format (tailwind | swift) on demand when the user opens
// that tab. Keeps export-nodes fast by skipping redundant tree walks.
async function buildFormatOnDemand(pageId, nodeIds, format, reqId) {
  try {
    var page = figma.root.children.find(function (p) { return p.id === pageId; });
    if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
    var resolved = await Promise.all((nodeIds || []).map(function (id) {
      return figma.getNodeByIdAsync(id).catch(function () { return null; });
    }));
    var nodes = []; for (var k = 0; k < resolved.length; k++) if (resolved[k]) nodes.push(resolved[k]);
    if (!nodes.length) {
      figma.ui.postMessage({ type: "format-result", reqId: reqId, format: format, error: "node not found" });
      return;
    }
    await loadVariablesCached().then(_setVariableMapInline);
    var label = (nodes.length === 1 && nodes[0].name) ? nodes[0].name : figma.currentPage.name;
    var payload = {};
    if (format === "tailwind") {
      var tw = buildTailwind(nodes, label);
      payload.tailwindHtml = tw.tailwindHtml;
      payload.tailwindBody = tw.tailwindBody;
    } else if (format === "swift") {
      try { payload.swift = buildSwiftUI(nodes, label).code || ""; }
      catch (e) { payload.swift = "// SwiftUI emit failed: " + (e && e.message ? e.message : e); }
    }
    figma.ui.postMessage(Object.assign({ type: "format-result", reqId: reqId, format: format }, payload));
  } catch (e) {
    figma.ui.postMessage({ type: "format-result", reqId: reqId, format: format, error: String(e && e.message || e) });
  }
}

// ── Selection auto-push (for live bridge) ─────────────────────
var _liveBridge = false;
var _debounce = null;
var _selSeq = 0;

function onSelectionChange() {
  if (!_liveBridge) return;
  var mySeq = ++_selSeq;
  // Immediately notify UI that a new selection is being computed so it can
  // clear stale output — without this the previous page/frame's code stays
  // visible for ~400ms+ while we debounce + export.
  var sel = figma.currentPage.selection;
  var selNames = sel.map(function (n) { return n.name; });
  figma.ui.postMessage({ type: "selection-pending", pageName: figma.currentPage.name, nodeNames: selNames });
  if (_debounce) clearTimeout(_debounce);
  _debounce = setTimeout(async function () {
    if (mySeq !== _selSeq) return; // superseded before compute
    var sel2 = figma.currentPage.selection;
    if (!sel2.length) { figma.ui.postMessage({ type: "selection-empty" }); return; }
    var tok = ++_exportTok;
    try {
      var payload = await exportPayload(sel2.slice(), figma.currentPage.name);
      if (mySeq !== _selSeq || tok !== _exportTok) return; // superseded
      figma.ui.postMessage(Object.assign({ type: "auto-push" }, payload));
    } catch (e) {
      figma.ui.postMessage({ type: "error", message: "auto-push failed: " + (e && e.message ? e.message : e) });
    }
  }, 400);
}

function onPageChange() {
  // Bump seq so any in-flight auto-push from the previous page is dropped.
  _selSeq++;
  sendPageMap();
  figma.ui.postMessage({ type: "page-changed", pageName: figma.currentPage.name });
}

// ── Init ──────────────────────────────────────────────────────
(async function init() {
  try { await figma.loadAllPagesAsync(); }
  catch (e) { figma.ui.postMessage({ type: "error", message: "loadAllPagesAsync failed: " + (e && e.message ? e.message : e) }); }
  try {
    var stored = await figma.clientStorage.getAsync("liveBridge");
    // Default-on: only off if the user has explicitly turned it off.
    _liveBridge = stored == null ? true : !!stored;
  } catch (e2) { _liveBridge = true; }
  sendPageMap();
  figma.ui.postMessage({ type: "bridge-state", enabled: _liveBridge });
  figma.on("currentpagechange", onPageChange);
  figma.on("selectionchange", onSelectionChange);
  // Invalidate token cache when anything changes in the document — cheap
  // signal; exportPayload will lazy-refill on next export.
  try { figma.on("documentchange", function () { invalidateTokenCache(); }); } catch (e3) {}
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

// ── import-from-code ─────────────────────────────────────────
// Build a real, editable Figma frame tree from either a deterministic
// JSON spec or a best-effort HTML parse. ES2017-safe (no spread / ?? / ?.)
// because the Figma plugin sandbox runs QuickJS.

function _ifcWarn(warnings, msg) { warnings.push(msg); }

function _ifcFillFromValue(val) {
  if (!val) return null;
  if (typeof val === "string") {
    // Linear gradient: linear-gradient([angle,] color stop, color stop, ...)
    if (/^linear-gradient\(/i.test(val)) {
      var grad = _ifcParseLinearGradient(val);
      if (grad) return [grad];
      return null;
    }
    var rgb = hexToRGB(val);
    if (rgb) return [{ type: "SOLID", color: { r: rgb.r, g: rgb.g, b: rgb.b }, opacity: rgb.a == null ? 1 : rgb.a }];
    return null;
  }
  return null;
}

// Parses CSS `linear-gradient(angleOrSide, c1 stop1, c2 stop2, ...)` into a
// Figma GRADIENT_LINEAR paint. Best-effort: handles deg, "to bottom" / "to
// top" / "to right" / "to left", and 2+ stops. Falls back to null on
// unknown forms.
function _ifcParseLinearGradient(s) {
  var body = s.replace(/^linear-gradient\(/i, "").replace(/\)\s*$/, "");
  // Split on commas NOT inside parens (rgba() etc.)
  var parts = []; var depth = 0; var buf = "";
  for (var i = 0; i < body.length; i++) {
    var ch = body[i];
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(buf.trim()); buf = ""; }
    else buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  if (parts.length < 2) return null;
  // Direction: first part if it doesn't start with a color.
  var angleDeg = 180; // default: top → bottom
  var first = parts[0];
  var colorRe = /^#|^rgba?\(|^hsla?\(/i;
  if (!colorRe.test(first)) {
    parts.shift();
    var m = first.match(/(-?[\d.]+)deg/);
    if (m) angleDeg = Number(m[1]);
    else if (/to\s+top/i.test(first))    angleDeg = 0;
    else if (/to\s+right/i.test(first))  angleDeg = 90;
    else if (/to\s+bottom/i.test(first)) angleDeg = 180;
    else if (/to\s+left/i.test(first))   angleDeg = 270;
  }
  var stops = [];
  for (var j = 0; j < parts.length; j++) {
    var p = parts[j].trim();
    var posMatch = p.match(/\s+(-?[\d.]+)%\s*$/);
    var pos = posMatch ? Number(posMatch[1]) / 100 : (j / (parts.length - 1 || 1));
    var colorPart = posMatch ? p.replace(/\s+-?[\d.]+%\s*$/, "") : p;
    var rgb = hexToRGB(colorPart) || _ifcParseRgbString(colorPart);
    if (!rgb) continue;
    stops.push({ position: pos, color: { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a == null ? 1 : rgb.a } });
  }
  if (stops.length < 2) return null;
  // Figma's gradientTransform: 3x2 matrix; convert CSS angle to gradient handles.
  // CSS angle = direction the gradient *goes* (0deg = up). Figma uses the
  // gradient line; map by rotating the start/end points around the unit center.
  var rad = (angleDeg - 90) * Math.PI / 180;
  var cos = Math.cos(rad), sin = Math.sin(rad);
  // Standard Figma identity transform: [[1,0,0],[0,1,0]] (start at left, end at right).
  // Rotate it by `rad` around the center (0.5, 0.5).
  var tx = 0.5 - 0.5 * cos + 0.5 * sin;
  var ty = 0.5 - 0.5 * sin - 0.5 * cos;
  var transform = [[cos, -sin, tx], [sin, cos, ty]];
  return { type: "GRADIENT_LINEAR", gradientTransform: transform, gradientStops: stops };
}

function _ifcParseRgbString(s) {
  var m = String(s).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
  if (!m) return null;
  return { r: Number(m[1]) / 255, g: Number(m[2]) / 255, b: Number(m[3]) / 255, a: m[4] != null ? parseFloat(m[4]) : 1 };
}

// Resolve padding from spec — accept either a single number (all sides) OR
// an object { top, right, bottom, left } for per-side fidelity.
function _ifcResolvePadding(pad) {
  if (pad == null) return null;
  if (typeof pad === "number") return { top: pad, right: pad, bottom: pad, left: pad };
  if (typeof pad === "object") {
    return {
      top:    Number(pad.top    || 0),
      right:  Number(pad.right  || 0),
      bottom: Number(pad.bottom || 0),
      left:   Number(pad.left   || 0),
    };
  }
  return null;
}

// Convert a spec.shadow array (from the extractor) into Figma effects.
// Each shadow has { x, y, blur, spread, color, inset }. Inset → INNER_SHADOW.
function _ifcShadowToEffects(shadows) {
  if (!shadows || !shadows.length) return null;
  var out = [];
  for (var i = 0; i < shadows.length; i++) {
    var s = shadows[i];
    var rgb = hexToRGB(s.color);
    if (!rgb) continue;
    out.push({
      type: s.inset ? "INNER_SHADOW" : "DROP_SHADOW",
      color: { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a == null ? 1 : rgb.a },
      offset: { x: Number(s.x) || 0, y: Number(s.y) || 0 },
      radius: Number(s.blur) || 0,
      spread: Number(s.spread) || 0,
      visible: true,
      blendMode: "NORMAL",
    });
  }
  return out.length ? out : null;
}

// Convert a spec.stroke { color, width } into a Figma SOLID stroke array.
function _ifcStrokeToFills(stroke) {
  if (!stroke || !stroke.color) return null;
  var rgb = hexToRGB(stroke.color);
  if (!rgb) return null;
  return [{ type: "SOLID", color: { r: rgb.r, g: rgb.g, b: rgb.b }, opacity: rgb.a == null ? 1 : rgb.a }];
}

// Apply common visual props to any node that supports them. Safe — checks
// each property exists before assigning.
function _ifcApplyCommonProps(node, spec) {
  // Per-corner radius { tl, tr, br, bl } takes priority over uniform radius.
  if (spec.cornerRadius && typeof spec.cornerRadius === "object" && "topLeftRadius" in node) {
    node.topLeftRadius     = Number(spec.cornerRadius.tl) || 0;
    node.topRightRadius    = Number(spec.cornerRadius.tr) || 0;
    node.bottomRightRadius = Number(spec.cornerRadius.br) || 0;
    node.bottomLeftRadius  = Number(spec.cornerRadius.bl) || 0;
  }
  if (spec.stroke && "strokes" in node) {
    var sFills = _ifcStrokeToFills(spec.stroke);
    if (sFills) { node.strokes = sFills; node.strokeWeight = Number(spec.stroke.width) || 1; }
  }
  // Outline → outer stroke. Skipped when a border is already set (Figma
  // doesn't natively support both).
  if (!spec.stroke && spec.outline && "strokes" in node) {
    var oFills = _ifcStrokeToFills(spec.outline);
    if (oFills) {
      node.strokes = oFills;
      node.strokeWeight = Number(spec.outline.width) || 1;
      try { node.strokeAlign = "OUTSIDE"; } catch (e) {}
    }
  }
  // Combine drop-shadow + backdrop-blur + CSS-filter effects into one list.
  var fx = spec.shadow ? (_ifcShadowToEffects(spec.shadow) || []) : [];
  if (typeof spec.backdropBlur === "number" && spec.backdropBlur > 0) {
    fx.push({ type: "BACKGROUND_BLUR", radius: Number(spec.backdropBlur), visible: true, blendMode: "NORMAL" });
  }
  // CSS filter: blur(...) / drop-shadow(...) — already pre-shaped by the
  // extractor. Convert to Figma effects.
  if (Array.isArray(spec.filterEffects)) {
    for (var fi = 0; fi < spec.filterEffects.length; fi++) {
      var fe = spec.filterEffects[fi];
      if (fe.type === "LAYER_BLUR") {
        fx.push({ type: "LAYER_BLUR", radius: Number(fe.radius) || 0, visible: true, blendMode: "NORMAL" });
      } else if (fe.type === "DROP_SHADOW") {
        var rgb = hexToRGB(fe.color);
        if (rgb) fx.push({
          type: "DROP_SHADOW",
          color: { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a == null ? 1 : rgb.a },
          offset: { x: Number(fe.x) || 0, y: Number(fe.y) || 0 },
          radius: Number(fe.blur) || 0,
          spread: Number(fe.spread) || 0,
          visible: true, blendMode: "NORMAL",
        });
      }
    }
  }
  if (fx.length && "effects" in node) node.effects = fx;
  // CSS mix-blend-mode → Figma blendMode.
  if (spec.blendMode && "blendMode" in node) {
    try { node.blendMode = spec.blendMode; } catch (e) {}
  }

  if (typeof spec.opacity === "number" && spec.opacity > 0 && spec.opacity < 1 && "opacity" in node) {
    node.opacity = spec.opacity;
  }
  // Transform: Figma supports rotation directly. translate is applied as a
  // delta on x/y. Scale is hard to round-trip cleanly, so we skip when not
  // identity but log a warning.
  if (spec.transform) {
    if (typeof spec.transform.translateX === "number" && "x" in node) node.x += spec.transform.translateX;
    if (typeof spec.transform.translateY === "number" && "y" in node) node.y += spec.transform.translateY;
    if (typeof spec.transform.rotation === "number" && Math.abs(spec.transform.rotation) > 0.01 && "rotation" in node) {
      try { node.rotation = spec.transform.rotation; } catch (e) {}
    }
  }
}

function _ifcSetSize(node, w, h) {
  if (w != null && h != null) {
    try { node.resizeWithoutConstraints(Math.max(1, w), Math.max(1, h)); } catch (e) {
      try { node.resize(Math.max(1, w), Math.max(1, h)); } catch (e2) {}
    }
  }
}

async function _ifcCreateNode(spec, warnings) {
  var type = (spec && spec.type) || "frame";
  if (type === "svg") {
    // figma.createNodeFromSvg() parses the SVG string and returns a real
    // FRAME containing vector children. Massive fidelity bump vs. a flat rect.
    try {
      var svgSrc = String(spec._svg || "");
      // Ensure 'currentColor' resolves — embed the CSS color into the SVG.
      if (spec._color) svgSrc = svgSrc.replace(/currentColor/g, spec._color);
      var node = figma.createNodeFromSvg(svgSrc);
      if (spec.name) node.name = spec.name;
      _ifcSetSize(node, spec.width, spec.height);
      _ifcApplyCommonProps(node, spec);
      return node;
    } catch (e) {
      _ifcWarn(warnings, "svg parse failed: " + e.message);
      // Fall back to a flat rect.
      var fb = figma.createRectangle();
      _ifcSetSize(fb, spec.width, spec.height);
      var c = _ifcFillFromValue(spec._color || "#94a3b8");
      if (c) fb.fills = c;
      if (spec.name) fb.name = spec.name;
      return fb;
    }
  }
  if (type === "text") {
    var t = figma.createText();
    var fontName = { family: (spec.fontFamily || "Inter"), style: _ifcFontStyle(spec.fontWeight) };
    try { await figma.loadFontAsync(fontName); }
    catch (e) {
      fontName = { family: "Inter", style: "Regular" };
      try { await figma.loadFontAsync(fontName); } catch (e2) { _ifcWarn(warnings, "font load failed: " + e2.message); }
    }
    t.fontName = fontName;
    if (spec.fontSize) t.fontSize = Number(spec.fontSize) || 16;
    t.characters = String(spec.characters != null ? spec.characters : (spec.text || ""));
    var col = _ifcFillFromValue(spec.color || spec.fill);
    if (col) t.fills = col;
    if (spec.textAlign === "LEFT" || spec.textAlign === "CENTER" || spec.textAlign === "RIGHT" || spec.textAlign === "JUSTIFIED") {
      t.textAlignHorizontal = spec.textAlign;
    }
    if (typeof spec.lineHeight === "number" && spec.lineHeight > 0) {
      try { t.lineHeight = { value: spec.lineHeight, unit: "PIXELS" }; } catch (e) {}
    }
    if (typeof spec.letterSpacing === "number" && spec.letterSpacing !== 0) {
      try { t.letterSpacing = { value: spec.letterSpacing, unit: "PIXELS" }; } catch (e) {}
    }
    if (spec.textDecoration === "UNDERLINE" || spec.textDecoration === "STRIKETHROUGH") {
      try { t.textDecoration = spec.textDecoration; } catch (e) {}
    }
    if (spec.textTransform === "UPPER" || spec.textTransform === "LOWER" || spec.textTransform === "TITLE") {
      try { t.textCase = spec.textTransform; } catch (e) {}
    }
    if (spec.whiteSpace === "NOWRAP") {
      try { t.textAutoResize = "WIDTH_AND_HEIGHT"; } catch (e) {}
    } else if (typeof spec.width === "number" && spec.width > 0) {
      // Wrap to the rendered width so multi-line text matches the page.
      try { t.textAutoResize = "HEIGHT"; t.resize(spec.width, t.height); } catch (e) {}
    }
    if (Array.isArray(spec.textShadow) && spec.textShadow.length && "effects" in t) {
      var tfx = _ifcShadowToEffects(spec.textShadow);
      if (tfx) t.effects = tfx;
    }
    if (typeof spec.opacity === "number" && spec.opacity > 0 && spec.opacity < 1) {
      t.opacity = spec.opacity;
    }
    // Inline-span style ranges: setRange*() for any segment whose computed
    // style differs from the parent. Each range needs the font loaded.
    if (Array.isArray(spec.ranges) && spec.ranges.length) {
      var charLen = t.characters.length;
      for (var ri = 0; ri < spec.ranges.length; ri++) {
        var rg = spec.ranges[ri];
        var s = Math.max(0, Math.min(rg.start || 0, charLen));
        var e = Math.max(s, Math.min(rg.end || 0, charLen));
        if (s >= e) continue;
        if (rg.color) {
          var rgb = hexToRGB(rg.color);
          if (rgb) try { t.setRangeFills(s, e, [{ type: "SOLID", color: { r: rgb.r, g: rgb.g, b: rgb.b }, opacity: rgb.a == null ? 1 : rgb.a }]); } catch (er) {}
        }
        if (typeof rg.fontSize === "number") try { t.setRangeFontSize(s, e, rg.fontSize); } catch (er) {}
        if (rg.fontWeight) {
          var fn = { family: (spec.fontFamily || "Inter"), style: _ifcFontStyle(rg.fontWeight) };
          try { await figma.loadFontAsync(fn); t.setRangeFontName(s, e, fn); } catch (er) {}
        }
        if (rg.textDecoration === "UNDERLINE" || rg.textDecoration === "STRIKETHROUGH") {
          try { t.setRangeTextDecoration(s, e, rg.textDecoration); } catch (er) {}
        }
      }
    }
    if (spec.name) t.name = spec.name;
    return t;
  }
  if (type === "rect") {
    var r = figma.createRectangle();
    _ifcSetSize(r, spec.width, spec.height);
    if (spec.cornerRadius != null) r.cornerRadius = Number(spec.cornerRadius) || 0;
    if (spec.name) r.name = spec.name;
    // Image fill takes priority over solid fill if `_imageBytes` (base64 PNG/JPG) was inlined.
    if (spec._imageBytes) {
      try {
        var raw = spec._imageBytes.replace(/^data:[^;]+;base64,/, "");
        var bin = atob(raw);
        var u8 = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        var img = figma.createImage(u8);
        r.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
        return r;
      } catch (e) { _ifcWarn(warnings, "image decode failed: " + e.message); }
    }
    var f = _ifcFillFromValue(spec.fill);
    if (f) r.fills = f; else r.fills = [];
    _ifcApplyCommonProps(r, spec);
    return r;
  }
  // frame (default)
  var fr = figma.createFrame();
  if (spec.name) fr.name = spec.name;
  // Background-image url() takes priority over solid/gradient if present
  // and was server-side-fetched into _imageBytes.
  var fillApplied = false;
  if (spec._imageBytes) {
    try {
      var raw = spec._imageBytes.replace(/^data:[^;]+;base64,/, "");
      var bin = atob(raw);
      var u8 = new Uint8Array(bin.length);
      for (var bi = 0; bi < bin.length; bi++) u8[bi] = bin.charCodeAt(bi);
      var img = figma.createImage(u8);
      fr.fills = [{ type: "IMAGE", scaleMode: "FILL", imageHash: img.hash }];
      fillApplied = true;
    } catch (e) { _ifcWarn(warnings, "frame image decode failed: " + e.message); }
  }
  if (!fillApplied) {
    var ff = _ifcFillFromValue(spec.fill);
    if (ff) fr.fills = ff; else fr.fills = [];
  }
  if (spec.cornerRadius != null) fr.cornerRadius = Number(spec.cornerRadius) || 0;
  _ifcApplyCommonProps(fr, spec);
  // auto-layout
  var layout = spec.layout || "NONE";
  if (layout === "VERTICAL" || layout === "HORIZONTAL") {
    fr.layoutMode = layout;
    var pad = _ifcResolvePadding(spec.padding);
    if (pad) {
      fr.paddingTop = pad.top; fr.paddingBottom = pad.bottom;
      fr.paddingLeft = pad.left; fr.paddingRight = pad.right;
    }
    if (spec.spacing != null) fr.itemSpacing = Number(spec.spacing) || 0;
    if (spec.layoutWrap === "WRAP" && "layoutWrap" in fr) {
      try { fr.layoutWrap = "WRAP"; } catch (e) {}
    }
    // When an explicit dimension is provided, lock that axis to FIXED so the
    // resize call below sticks. Otherwise auto-layout hugs content and the
    // resize gets immediately reverted on the next layout pass.
    var primaryIsVertical = layout === "VERTICAL";
    var primaryExplicit  = primaryIsVertical ? spec.height != null : spec.width  != null;
    var counterExplicit  = primaryIsVertical ? spec.width  != null : spec.height != null;
    fr.primaryAxisSizingMode = primaryExplicit ? "FIXED" : "AUTO";
    fr.counterAxisSizingMode = counterExplicit ? "FIXED" : "AUTO";
  }
  _ifcSetSize(fr, spec.width, spec.height);
  // Apply min/max sizing constraints — useful when downstream auto-layout
  // resizes things. Figma supports these via minWidth/maxWidth/etc.
  if (typeof spec.minWidth === "number" && "minWidth" in fr) try { fr.minWidth = spec.minWidth; } catch (e) {}
  if (typeof spec.maxWidth === "number" && "maxWidth" in fr) try { fr.maxWidth = spec.maxWidth; } catch (e) {}
  if (typeof spec.minHeight === "number" && "minHeight" in fr) try { fr.minHeight = spec.minHeight; } catch (e) {}
  if (typeof spec.maxHeight === "number" && "maxHeight" in fr) try { fr.maxHeight = spec.maxHeight; } catch (e) {}
  var children = spec.children || [];
  var isAutoLayout = (layout === "VERTICAL" || layout === "HORIZONTAL");
  for (var i = 0; i < children.length; i++) {
    try {
      var child = await _ifcCreateNode(children[i], warnings);
      if (!child) continue;
      fr.appendChild(child);
      // For non-auto-layout parents the extractor emits per-child x/y
      // (relative to the parent). Without these every child would land at
      // (0,0) and the page would visually collapse into the top-left.
      if (!isAutoLayout && "x" in child) {
        var cs = children[i];
        if (cs && typeof cs.x === "number") child.x = cs.x;
        if (cs && typeof cs.y === "number") child.y = cs.y;
      }
    } catch (e) { _ifcWarn(warnings, "child[" + i + "] failed: " + (e && e.message || e)); }
  }
  return fr;
}

function _ifcFontStyle(weight) {
  if (!weight) return "Regular";
  var w = String(weight).toLowerCase();
  if (w === "bold" || w === "700" || w === "800" || w === "900") return "Bold";
  if (w === "600" || w === "semibold" || w === "semi-bold") return "Semi Bold";
  if (w === "500" || w === "medium") return "Medium";
  if (w === "300" || w === "light") return "Light";
  return "Regular";
}

// Minimal HTML → spec converter. Not a real parser — handles the common
// cases (semantic tags, inline styles for color/background/font-size/
// padding/gap/border-radius/width/height/flex direction). Anything fancier,
// pass `spec` instead.
function _ifcHtmlToSpec(html, warnings) {
  // Strip <head> / <script> / <style> blocks for the body walk.
  var headMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var title = headMatch ? headMatch[1].trim() : null;
  var body = html.replace(/<script[\s\S]*?<\/script>/gi, "")
                 .replace(/<style[\s\S]*?<\/style>/gi, "")
                 .replace(/<head[\s\S]*?<\/head>/gi, "");
  var rootMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  var inner = rootMatch ? rootMatch[1] : body;
  // Tokenize into a tree.
  var voidTags = { img: 1, hr: 1, br: 1, input: 1, meta: 1, link: 1 };
  var frameTags = { div: 1, section: 1, header: 1, footer: 1, nav: 1, article: 1, aside: 1, main: 1, ul: 1, ol: 1, li: 1, form: 1, figure: 1 };
  var textTags = { h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, p: 1, span: 1, a: 1, button: 1, label: 1, strong: 1, em: 1 };
  var rectTags = { img: 1, hr: 1 };
  var pos = 0;
  function parseChildren(stopTag) {
    var out = [];
    while (pos < inner.length) {
      // closing tag?
      if (stopTag) {
        var closeRe = new RegExp("^</" + stopTag + "\\s*>", "i");
        var rest = inner.slice(pos);
        var cm = rest.match(closeRe);
        if (cm) { pos += cm[0].length; return out; }
      }
      var lt = inner.indexOf("<", pos);
      if (lt < 0) {
        var tail = inner.slice(pos).trim();
        if (tail) out.push({ type: "text", characters: _ifcDecode(tail) });
        pos = inner.length; break;
      }
      if (lt > pos) {
        var txt = inner.slice(pos, lt).replace(/\s+/g, " ").trim();
        if (txt) out.push({ type: "text", characters: _ifcDecode(txt) });
      }
      pos = lt;
      var tagMatch = inner.slice(pos).match(/^<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/);
      if (!tagMatch) { pos++; continue; }
      var tagName = tagMatch[1].toLowerCase();
      var attrs = tagMatch[2];
      var isClose = inner[pos + 1] === "/";
      pos += tagMatch[0].length;
      if (isClose) {
        // unexpected close — bail to caller
        return out;
      }
      var selfClose = /\/\s*>$/.test(tagMatch[0]) || voidTags[tagName];
      var style = _ifcParseStyle(_ifcAttr(attrs, "style"));
      var node;
      if (rectTags[tagName]) {
        node = { type: "rect", name: tagName };
        if (style.width) node.width = style.width;
        if (style.height) node.height = style.height;
        if (style.background) node.fill = style.background;
        if (style.borderRadius != null) node.cornerRadius = style.borderRadius;
      } else if (textTags[tagName]) {
        // Treat as text — collect inner text only (drop nested tags).
        var inside = "";
        if (!selfClose) {
          var endIdx = inner.toLowerCase().indexOf("</" + tagName + ">", pos);
          if (endIdx >= 0) { inside = inner.slice(pos, endIdx); pos = endIdx + tagName.length + 3; }
        }
        var plain = inside.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        node = { type: "text", name: tagName, characters: _ifcDecode(plain) };
        if (tagName === "h1") node.fontSize = 32; else if (tagName === "h2") node.fontSize = 24;
        else if (tagName === "h3") node.fontSize = 20; else if (tagName === "h4") node.fontSize = 18;
        else if (tagName === "button") { node.fontSize = 14; node.fontWeight = "600"; }
        if (style.fontSize) node.fontSize = style.fontSize;
        if (style.fontWeight) node.fontWeight = style.fontWeight;
        if (style.color) node.color = style.color;
      } else if (frameTags[tagName] || true) {
        node = { type: "frame", name: tagName, layout: style.flexDirection === "row" ? "HORIZONTAL" : (style.display === "flex" ? "VERTICAL" : "VERTICAL") };
        if (style.padding != null) node.padding = style.padding;
        if (style.gap != null) node.spacing = style.gap;
        if (style.background) node.fill = style.background;
        if (style.borderRadius != null) node.cornerRadius = style.borderRadius;
        if (style.width) node.width = style.width;
        if (style.height) node.height = style.height;
        if (!selfClose) node.children = parseChildren(tagName);
      }
      out.push(node);
    }
    return out;
  }
  var kids = parseChildren(null);
  return { type: "frame", name: title || "Imported design", layout: "VERTICAL", padding: 0, spacing: 0, fill: "#ffffff", children: kids };
}
function _ifcAttr(attrs, key) {
  if (!attrs) return null;
  var m = attrs.match(new RegExp(key + "\\s*=\\s*\"([^\"]*)\"", "i"));
  if (m) return m[1];
  m = attrs.match(new RegExp(key + "\\s*=\\s*'([^']*)'", "i"));
  return m ? m[1] : null;
}
function _ifcDecode(s) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}
function _ifcParseStyle(str) {
  var out = {};
  if (!str) return out;
  var parts = str.split(";");
  for (var i = 0; i < parts.length; i++) {
    var kv = parts[i].split(":");
    if (kv.length < 2) continue;
    var k = kv[0].trim().toLowerCase();
    var v = kv.slice(1).join(":").trim();
    if (k === "background" || k === "background-color") out.background = _ifcColor(v);
    else if (k === "color") out.color = _ifcColor(v);
    else if (k === "font-size") out.fontSize = _ifcPx(v);
    else if (k === "font-weight") out.fontWeight = v;
    else if (k === "padding") out.padding = _ifcPx(v);
    else if (k === "gap") out.gap = _ifcPx(v);
    else if (k === "border-radius") out.borderRadius = _ifcPx(v);
    else if (k === "width") out.width = _ifcPx(v);
    else if (k === "height") out.height = _ifcPx(v);
    else if (k === "display") out.display = v;
    else if (k === "flex-direction") out.flexDirection = v;
  }
  return out;
}
function _ifcColor(v) {
  v = v.trim();
  if (/^#/.test(v)) return v;
  var m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
  if (m) {
    var hx = function (n) { var s = parseInt(n, 10).toString(16); return s.length === 1 ? "0" + s : s; };
    return "#" + hx(m[1]) + hx(m[2]) + hx(m[3]);
  }
  return null;
}
function _ifcPx(v) {
  var m = String(v).match(/(-?[\d.]+)/);
  return m ? Number(m[1]) : null;
}

// Ensure each `--foo: value` from spec._cssVariables exists as a Figma
// Variable in a collection named "CSS Variables" — handed off to designers
// for design-system editing without auto-binding fills (too lossy).
async function _ifcSyncCssVariables(vars, warnings) {
  if (!vars || !Object.keys(vars).length) return 0;
  if (!figma.variables) return 0;
  var collections = await figma.variables.getLocalVariableCollectionsAsync();
  var col = null;
  for (var i = 0; i < collections.length; i++) {
    if (collections[i].name === "CSS Variables") { col = collections[i]; break; }
  }
  if (!col) {
    try { col = figma.variables.createVariableCollection("CSS Variables"); }
    catch (e) { _ifcWarn(warnings, "could not create variable collection: " + e.message); return 0; }
  }
  var modeId = col.modes[0].modeId;
  var existing = await figma.variables.getLocalVariablesAsync();
  var byName = {};
  for (var ei = 0; ei < existing.length; ei++) byName[existing[ei].name] = existing[ei];
  var created = 0;
  var keys = Object.keys(vars);
  for (var k = 0; k < keys.length; k++) {
    var name = keys[k];
    var val = vars[name];
    var rgb = hexToRGB(val);
    var v = byName[name];
    try {
      if (rgb) {
        if (!v) { v = figma.variables.createVariable(name, col, "COLOR"); created++; }
        if (v.resolvedType === "COLOR") v.setValueForMode(modeId, { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a == null ? 1 : rgb.a });
      } else if (/^-?[\d.]+(px|rem|em)?$/.test(String(val).trim())) {
        if (!v) { v = figma.variables.createVariable(name, col, "FLOAT"); created++; }
        var n = parseFloat(val);
        if (isFinite(n) && v.resolvedType === "FLOAT") v.setValueForMode(modeId, n);
      } else {
        if (!v) { v = figma.variables.createVariable(name, col, "STRING"); created++; }
        if (v.resolvedType === "STRING") v.setValueForMode(modeId, String(val));
      }
    } catch (e) { _ifcWarn(warnings, "var " + name + ": " + e.message); }
  }
  return created;
}

async function importFromCode(args) {
  var warnings = [];
  var spec = args.spec;
  if (!spec && args.html) {
    spec = _ifcHtmlToSpec(args.html, warnings);
  }
  if (!spec) return { ok: false, error: "Provide spec or html." };
  // Side-effect: create/update Figma Variables from any CSS custom
  // properties carried on the spec (designer-friendly handoff).
  if (spec._cssVariables) {
    try { await _ifcSyncCssVariables(spec._cssVariables, warnings); } catch (e) { _ifcWarn(warnings, "cssVars: " + e.message); }
  }
  // Resolve page
  var page = figma.currentPage;
  if (args.pageId) {
    var p = figma.root.children.find(function (pp) { return pp.id === args.pageId; });
    if (p) { await figma.setCurrentPageAsync(p); page = p; }
    else _ifcWarn(warnings, "pageId not found, using current page");
  }
  if (args.name) spec.name = args.name;
  var root;
  try { root = await _ifcCreateNode(spec, warnings); }
  catch (e) { return { ok: false, error: "create failed: " + (e && e.message || e), warnings: warnings }; }
  // Place to the right of any existing top-level frame on the page.
  var maxRight = 0;
  for (var i = 0; i < page.children.length; i++) {
    var ch = page.children[i];
    if ("x" in ch && "width" in ch && ch !== root) {
      var r = ch.x + ch.width;
      if (r > maxRight) maxRight = r;
    }
  }
  if ("x" in root) root.x = maxRight ? maxRight + 80 : 0;
  if ("y" in root) root.y = 0;
  try { figma.currentPage.selection = [root]; figma.viewport.scrollAndZoomIntoView([root]); } catch (e) {}
  // Count nodes recursively.
  function count(n) {
    var c = 1;
    if ("children" in n && n.children) for (var i = 0; i < n.children.length; i++) c += count(n.children[i]);
    return c;
  }
  return { ok: true, nodeId: root.id, name: root.name, createdCount: count(root), warnings: warnings };
}

async function updateFromCode(args) {
  var warnings = [];
  var spec = args.spec;
  if (!spec && args.html) spec = _ifcHtmlToSpec(args.html, warnings);
  if (!spec) return { ok: false, error: "Provide spec or html." };
  var target = null;
  if (args.nodeId) target = await figma.getNodeByIdAsync(args.nodeId);
  if (!target && args.name) {
    var nm = args.name;
    var page = figma.currentPage;
    for (var i = 0; i < page.children.length; i++) {
      if (page.children[i].name === nm) { target = page.children[i]; break; }
    }
  }
  if (!target) {
    // No match — degrade gracefully to a fresh import.
    return await importFromCode(args);
  }
  if (target.type !== "FRAME" && typeof target.appendChild !== "function") {
    return { ok: false, error: "target is not a frame: " + target.type };
  }
  // Remove existing children before rebuilding.
  var existing = target.children.slice();
  for (var j = 0; j < existing.length; j++) {
    try { existing[j].remove(); } catch (e) {}
  }
  // Build new subtree and append.
  var newRoot;
  try { newRoot = await _ifcCreateNode(spec, warnings); }
  catch (e) { return { ok: false, error: "rebuild failed: " + e.message, warnings: warnings }; }
  // Copy properties from new root to the existing one (so id stays stable),
  // then move new root's children into it.
  if (spec.fill) {
    var f = _ifcFillFromValue(spec.fill);
    if (f) target.fills = f;
  }
  if (spec.layout === "VERTICAL" || spec.layout === "HORIZONTAL") {
    target.layoutMode = spec.layout;
    var pad = _ifcResolvePadding(spec.padding);
    if (pad) {
      target.paddingTop = pad.top; target.paddingBottom = pad.bottom;
      target.paddingLeft = pad.left; target.paddingRight = pad.right;
    }
    if (spec.spacing != null) target.itemSpacing = Number(spec.spacing) || 0;
  }
  _ifcSetSize(target, spec.width, spec.height);
  var newChildren = (newRoot.children || []).slice();
  for (var k = 0; k < newChildren.length; k++) target.appendChild(newChildren[k]);
  try { newRoot.remove(); } catch (e) {}
  try { figma.currentPage.selection = [target]; figma.viewport.scrollAndZoomIntoView([target]); } catch (e) {}
  function ncount(n) { var c = 1; if ("children" in n && n.children) for (var i = 0; i < n.children.length; i++) c += ncount(n.children[i]); return c; }
  return { ok: true, nodeId: target.id, name: target.name, replacedCount: ncount(target), warnings: warnings };
}

async function deleteNodes(args) {
  var ids = [];
  if (args.nodeId) ids.push(args.nodeId);
  if (Array.isArray(args.nodeIds)) ids = ids.concat(args.nodeIds);
  // Allow deleting by exact name(s) on the current page.
  var byName = args.name ? (Array.isArray(args.name) ? args.name : [args.name]) : [];
  if (byName.length) {
    var ch = figma.currentPage.children;
    for (var i = 0; i < ch.length; i++) {
      if (byName.indexOf(ch[i].name) !== -1) ids.push(ch[i].id);
    }
  }
  var deleted = [];
  var errors = [];
  for (var j = 0; j < ids.length; j++) {
    try {
      var n = await figma.getNodeByIdAsync(ids[j]);
      if (!n) { errors.push({ id: ids[j], error: "not found" }); continue; }
      n.remove();
      deleted.push(ids[j]);
    } catch (e) { errors.push({ id: ids[j], error: e.message }); }
  }
  return { ok: true, deleted: deleted, errors: errors };
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
    if (action === "import-from-code") {
      return await importFromCode(args || {});
    }
    if (action === "update-from-code") {
      // Find an existing frame by name (or nodeId) and replace its children
      // with the new spec's children. Preserves the parent frame's id so
      // selection / references survive — closes the iteration loop.
      return await updateFromCode(args || {});
    }
    if (action === "delete-node") {
      // Delete a node by id (or list of ids, or by name). Returns the
      // ids that were actually removed.
      return await deleteNodes(args || {});
    }
    if (action === "export-frame") {
      var node = await figma.getNodeByIdAsync(args.nodeId);
      if (!node) return { ok: false, error: "node not found: " + args.nodeId };
      if (typeof node.exportAsync !== "function") return { ok: false, error: "node is not exportable: " + node.type };
      try {
        var bytes = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: args.scale || 1 } });
        var chunk = 0x8000, parts = [];
        for (var ei = 0; ei < bytes.length; ei += chunk) parts.push(String.fromCharCode.apply(null, bytes.subarray(ei, ei + chunk)));
        var b64 = (figma.base64Encode ? figma.base64Encode(bytes) : btoa(parts.join("")));
        return { ok: true, nodeId: node.id, name: node.name, width: node.width, height: node.height, bytes: bytes.length, base64: b64 };
      } catch (e) { return { ok: false, error: "export failed: " + e.message }; }
    }
    if (action === "run-script") {
      // Generic escape hatch — evaluate arbitrary JS in the plugin sandbox
      // with the figma API in scope. Lets the agent ship new Figma
      // behaviors without rebuilding/reloading the plugin. Trust model:
      // bridge is 127.0.0.1-only, same as every other write action.
      // Returns { ok, result, error? }.
      var src = args && args.script;
      if (!src || typeof src !== "string") return { ok: false, error: "script (string) required" };
      try {
        // The script body is async; wrap to await it. `figma` is already global.
        var wrapped = "(async () => { " + src + " })()";
        // eslint-disable-next-line no-eval
        var p = eval(wrapped);
        var result = await Promise.resolve(p);
        // Try JSON-serialize; if non-serializable, stringify shallowly.
        var out;
        try { out = JSON.parse(JSON.stringify(result)); }
        catch (e) { out = String(result); }
        return { ok: true, result: out };
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e), stack: e && e.stack };
      }
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
      var files = await computeAgentBundle(roots, {
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
    case "build-format":     await buildFormatOnDemand(msg.pageId, msg.nodeIds, msg.format, msg.reqId); break;
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
      await exportAgentBundle(msg);
      break;
    case "close": figma.closePlugin(); break;
  }
};

// ============================================================
// FRAMESHIFT AGENT BUNDLE (ported from figma2code)
// Top-level helpers — formerly wrapped in a `FrameshiftAgent` IIFE,
// unwrapped so the router above can actually see them. QuickJS
// function-scopes everything inside an IIFE.
// ============================================================
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
  if (!paints || paints === figma.mixed || !paints.length) return null;
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
  // Guard figma.mixed (Symbol) on any stroke-related property.
  if (!node.strokes || node.strokes === figma.mixed || !node.strokes.length) return null;
  var s = node.strokes.find(function (x) { return x.visible !== false; });
  if (!s || !s.color) return null;
  var dashPattern = node.dashPattern;
  var dashed = (dashPattern && dashPattern !== figma.mixed && dashPattern.length) ? "dashed" : "solid";
  var sop = s.opacity == null ? 1 : s.opacity;
  var sc = { r: s.color.r, g: s.color.g, b: s.color.b, a: sop };
  var stok = paintToTokenRef(s);
  var color = stok ? "var(" + stok.cssName + ")" : rgbaToCSS(sc);
  // Mixed per-side weights → per-side declarations
  var ind = node.individualStrokeWeights;
  if (ind && ind !== figma.mixed &&
      typeof ind.top === "number" && typeof ind.right === "number" &&
      typeof ind.bottom === "number" && typeof ind.left === "number" &&
      (ind.top !== ind.right || ind.right !== ind.bottom || ind.bottom !== ind.left)) {
    return {
      "border-top":    ind.top    + "px " + dashed + " " + color,
      "border-right":  ind.right  + "px " + dashed + " " + color,
      "border-bottom": ind.bottom + "px " + dashed + " " + color,
      "border-left":   ind.left   + "px " + dashed + " " + color,
    };
  }
  var sw = node.strokeWeight;
  if (sw == null || sw === figma.mixed || typeof sw !== "number") sw = 1;
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
// _varByHex is declared at the top of the file (populated by setVariableMap).
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

// sanitizeSwiftIdent and paintToTokenRef live at the top of the file.
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

// ── Shared prefetch: cache var map (file-wide), parallel-fan out the
// per-tree walks (assets / text styles / main components). Each phase
// is timed so the UI can surface a breakdown when an export feels slow.
var _varMapPromise = null;
function loadVariablesOnce() {
  if (_varMapCache) return Promise.resolve(_varMapCache);
  if (_varMapPromise) return _varMapPromise;
  _varMapPromise = loadVariables().then(function (m) {
    _varMapCache = m || {}; _varMapPromise = null; return _varMapCache;
  }, function (e) { _varMapPromise = null; throw e; });
  return _varMapPromise;
}
// Hook invalidation (loadVariablesOnce shares _varMapCache with the
// earlier cache; documentchange already clears it via invalidateTokenCache).
var _now = (typeof performance !== "undefined" && performance.now)
  ? function () { return performance.now(); } : function () { return Date.now(); };
var _exportTokLive = 0;
async function prefetchForNodes(nodes, mode, timings) {
  resetCSS(mode);
  resetMainCompCache();
  var t0 = _now();
  // All four prefetches are independent reads — fan out in parallel.
  var results = await Promise.all([
    loadVariablesOnce(),
    prefetchAssets(nodes),
    loadTextStyles(nodes),
    prefetchMainComponents(nodes)
  ]);
  timings.prefetch = _now() - t0;
  setVariableMap(results[0]);
  setAssetCache(results[1]);
  setTextStyleMap(results[2]);
}

async function _timedResolve(pageId, nodeIds, timings) {
  var t0 = _now();
  var page = (pageId != null)
    ? figma.root.children.find(function (p) { return p.id === pageId; })
    : figma.currentPage;
  if (page && page.id !== figma.currentPage.id) {
    await figma.setCurrentPageAsync(page);
  }
  timings.page = _now() - t0;
  t0 = _now();
  var resolved = nodeIds && nodeIds.length
    ? await Promise.all(nodeIds.map(function (id) {
        return figma.getNodeByIdAsync(id).catch(function () { return null; });
      }))
    : [];
  timings.resolve = _now() - t0;
  var nodes = [];
  for (var k = 0; k < resolved.length; k++) if (resolved[k]) nodes.push(resolved[k]);
  return nodes;
}

function _postTiming(kind, label, timings) {
  try {
    figma.ui.postMessage({
      type: "timing", kind: kind, label: label,
      page: Math.round(timings.page || 0),
      resolve: Math.round(timings.resolve || 0),
      prefetch: Math.round(timings.prefetch || 0),
      build: Math.round(timings.build || 0),
      total: Math.round(timings.total || 0)
    });
  } catch (e) {}
}

// ── Export selected nodes on current page ─────────────────────
async function exportSelection(mode) {
  var tok = ++_exportTokLive;
  var timings = {}; var tStart = _now();
  var sel = figma.currentPage.selection;
  if (!sel.length) {
    figma.ui.postMessage({ type: "error", message: "No selection. Select at least one frame." });
    return;
  }
  await prefetchForNodes(sel.slice(), mode, timings);
  if (tok !== _exportTokLive) return;
  var tb = _now();
  var result = buildOutput(sel.slice(), figma.currentPage.name);
  timings.build = _now() - tb;
  timings.total = _now() - tStart;
  if (tok !== _exportTokLive) return;
  figma.ui.postMessage(Object.assign({
    type: "result",
    pageName: figma.currentPage.name,
    mode: mode || "css",
    nodeIds: sel.map(function (n) { return n.id; })
  }, result));
  _postTiming("selection", figma.currentPage.name, timings);
}

// ── Export specific node IDs (from picker) ────────────────────
async function exportNodes(pageId, nodeIds, mode) {
  var tok = ++_exportTokLive;
  var timings = {}; var tStart = _now();
  var nodes = await _timedResolve(pageId, nodeIds, timings);
  if (tok !== _exportTokLive) return; // user clicked something newer
  if (!nodes.length) {
    figma.ui.postMessage({ type: "error", message: "No valid frames found on this page." });
    return;
  }
  await prefetchForNodes(nodes, mode, timings);
  if (tok !== _exportTokLive) return;
  var label = nodes.length === 1 ? nodes[0].name : figma.currentPage.name;
  var tb = _now();
  var result = buildOutput(nodes, label);
  timings.build = _now() - tb;
  timings.total = _now() - tStart;
  if (tok !== _exportTokLive) return;
  figma.ui.postMessage(Object.assign({
    type: "result",
    pageName: figma.currentPage.name,
    mode: mode || "css",
    nodeIds: nodes.map(function (n) { return n.id; })
  }, result));
  _postTiming("nodes", label, timings);
}

// ── Export all frames across ALL pages ────────────────────────
async function exportAllPages(mode) {
  var pageResults = [];
  var all = figma.root.children;
  for (var i = 0; i < all.length; i++) {
    var page = all[i];
    if (page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
    var frames = page.children.filter(function (n) { return n.type === "FRAME" || n.type === "COMPONENT" || n.type === "GROUP"; });
    if (!frames.length) continue;
    var timings = {};
    await prefetchForNodes(frames, mode, timings);
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
