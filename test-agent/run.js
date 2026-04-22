// Lightweight test runner. No deps.
require("./harness.js");
const { buildHTML, resetCSS, setVariableMap, setAssetCache, buildOutput, buildTokensJSON, setTextStyleMap, setMinify, buildBundle, buildZip, buildStackblitzHTML, buildTailwindConfig, assignSlugs, slugFor, setSlugLock, getSlugLock, buildAgentBundle, hierarchyMd, componentsJson, designMd, agentsMd, manifestJson, contentHash, buildSnapshot, diffSnapshots, changesMd, auditA11y, issuesMd, contrastRatio, fuzzyMatchComponents, collectFigmaComponentNames, levenshtein, setComponentMap, componentTsx, componentStories, buildComponentFiles, variantCombinations, applyBudget, BUDGETS, flowMermaid, groupResponsiveFrames, responsiveMd, responsiveJson, detectBreakpoint, stripBreakpointSuffix } = require("./code.js");
const { frame, text, autoLayout } = require("./fixtures.js");

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log("  ✓", name); passed++; }
  catch (e) { console.log("  ✗", name, "\n    ", e.message); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function contains(hay, needle) { assert(hay.indexOf(needle) !== -1, `expected to contain: ${needle}\n---\n${hay}\n---`); }
function notContains(hay, needle) { assert(hay.indexOf(needle) === -1, `expected NOT to contain: ${needle}`); }

console.log("\n— baseline —");

t("renders a frame with background", () => {
  resetCSS();
  const out = buildHTML([frame()], "Test");
  contains(out.html, "<div");
  contains(out.css, "background-color");
  contains(out.css, "width: 200px");
});

t("renders text with font styles", () => {
  resetCSS();
  const root = frame({ children: [text()] });
  const out = buildHTML([root], "Test");
  contains(out.html, "<p");
  contains(out.html, "Hello");
  contains(out.css, "font-family");
  contains(out.css, "font-weight: 700");
});

t("auto layout → flex", () => {
  resetCSS();
  const out = buildHTML([autoLayout({ children: [text()] })], "Test");
  contains(out.css, "display: flex");
  contains(out.css, "flex-direction: row");
  contains(out.css, "gap: 8px");
});

console.log("\n— tailwind mode —");

t("emits utility classes, not rules", () => {
  resetCSS("tailwind");
  const out = buildHTML([frame()], "Test");
  contains(out.html, 'class="relative');
  contains(out.html, "w-[200px]");
  contains(out.html, "h-[100px]");
  contains(out.html, "rounded-[8px]");
  contains(out.html, "bg-[#ffffff]");
  notContains(out.css, ".el-1 {");
  contains(out.html, "cdn.tailwindcss.com");
});

t("tailwind auto layout → flex utilities", () => {
  resetCSS("tailwind");
  const out = buildHTML([autoLayout({ children: [text()] })], "Test");
  contains(out.html, "flex");
  contains(out.html, "flex-row");
  contains(out.html, "items-center");
  contains(out.html, "justify-center");
  contains(out.html, "gap-[8px]");
  contains(out.html, "pt-[8px]");
});

t("tailwind text styles", () => {
  resetCSS("tailwind");
  const out = buildHTML([frame({ children: [text()] })], "Test");
  contains(out.html, "text-[16px]");
  contains(out.html, "font-[700]");
  contains(out.html, "text-[#000000]");
  contains(out.html, "text-left");
});

console.log("\n— variables / tokens —");

t("bound fill variable emits var() + :root block", () => {
  resetCSS("css");
  setVariableMap({
    "VAR:1": { cssName: "--color-primary", value: "#7c6cfc" },
    "VAR:2": { cssName: "--radius-md", value: "12px" },
  });
  const node = frame({
    boundVariables: {
      fills: [{ type: "VARIABLE_ALIAS", id: "VAR:1" }],
      cornerRadius: { type: "VARIABLE_ALIAS", id: "VAR:2" },
    },
  });
  const out = buildHTML([node], "Test");
  contains(out.css, "--color-primary: #7c6cfc");
  contains(out.css, "background-color: var(--color-primary)");
  contains(out.css, "border-radius: var(--radius-md)");
  setVariableMap({});
});

t("bound padding variables", () => {
  resetCSS("css");
  setVariableMap({ "VAR:3": { cssName: "--space-md", value: "16px" } });
  const node = autoLayout({
    boundVariables: {
      paddingLeft:  { type: "VARIABLE_ALIAS", id: "VAR:3" },
      paddingRight: { type: "VARIABLE_ALIAS", id: "VAR:3" },
    },
    children: [text()],
  });
  const out = buildHTML([node], "Test");
  contains(out.css, "var(--space-md)");
  setVariableMap({});
});

t("tailwind mode includes :root style block", () => {
  resetCSS("tailwind");
  setVariableMap({ "VAR:1": { cssName: "--c", value: "#fff" } });
  const out = buildHTML([frame({ boundVariables: { fills: [{ id: "VAR:1" }] } })], "Test");
  contains(out.html, "--c: #fff");
  contains(out.html, "bg-[var(--c)]");
  setVariableMap({});
});

t("gradient angle derived from gradientTransform", () => {
  resetCSS("css");
  // identity transform → 90deg (default horizontal left→right)
  const n1 = frame({ id: "g1", name: "Hz", fills: [{ type: "GRADIENT_LINEAR", gradientTransform: [[1,0,0],[0,1,0]], gradientStops: [{color:{r:1,g:0,b:0,a:1},position:0},{color:{r:0,g:0,b:1,a:1},position:1}] }] });
  const out1 = buildHTML([n1], "Test");
  contains(out1.css, "linear-gradient(90deg");
  resetCSS("css");
  // 90° rotation [[0,-1],[1,0]] → top→bottom, CSS angle 180
  const n2 = frame({ id: "g2", name: "Vt", fills: [{ type: "GRADIENT_LINEAR", gradientTransform: [[0,-1,0],[1,0,0]], gradientStops: [{color:{r:1,g:0,b:0,a:1},position:0},{color:{r:0,g:0,b:1,a:1},position:1}] }] });
  const out2 = buildHTML([n2], "Test");
  contains(out2.css, "linear-gradient(180deg");
});

t("multi-mode variables emit dark + data-theme blocks", () => {
  resetCSS("css");
  setVariableMap({
    "VAR:1": {
      cssName: "--bg", value: "#ffffff", name: "bg", type: "color", rawValue: "#ffffff",
      valuesByMode: { "Light": "#ffffff", "Dark": "#111111", "Sepia": "#f4ecd8" },
    },
  });
  const out = buildHTML([frame({ boundVariables: { fills: [{ id: "VAR:1" }] } })], "Test");
  contains(out.css, "--bg: #ffffff");
  contains(out.css, "@media (prefers-color-scheme: dark)");
  contains(out.css, "--bg: #111111");
  contains(out.css, '[data-theme="sepia"]');
  contains(out.css, "--bg: #f4ecd8");
  setVariableMap({});
});

console.log("\n— react/jsx mode —");

t("emits className and component wrapper", () => {
  resetCSS("react");
  const out = buildHTML([frame({ name: "Hero Card", children: [text()] })], "Hero Card");
  contains(out.rawHtml, "className=");
  notContains(out.rawHtml, 'class="');
  assert(out.jsx != null, "jsx should be defined");
  contains(out.jsx, "export default function HeroCard()");
  contains(out.jsx, 'import "./HeroCard.css"');
  contains(out.jsx, "<>");
  contains(out.css, ".hero-card {");
});

t("self-closing <br /> in react text", () => {
  resetCSS("react");
  const out = buildHTML([frame({ children: [text({ characters: "a\nb" })] })], "Test");
  contains(out.rawHtml, "<br />");
  notContains(out.rawHtml, "<br>");
});

console.log("\n— images / svg —");

t("image fill → <img> with data URL", () => {
  resetCSS("css");
  setAssetCache({ "img:1": { kind: "png", data: "data:image/png;base64,AAAA" } });
  const node = frame({ id: "img:1", name: "Photo" });
  const out = buildHTML([node], "Test");
  contains(out.rawHtml, "<img");
  contains(out.rawHtml, 'src="data:image/png;base64,AAAA"');
  contains(out.rawHtml, 'alt="Photo"');
  setAssetCache({});
});

t("vector → inline <svg>", () => {
  resetCSS("css");
  setAssetCache({ "vec:1": { kind: "svg", data: "<svg><circle r='5'/></svg>" } });
  const node = frame({ id: "vec:1", type: "VECTOR", name: "Icon" });
  const out = buildHTML([node], "Test");
  contains(out.rawHtml, "<svg><circle r='5'/></svg>");
  setAssetCache({});
});

t("react mode self-closes <img />", () => {
  resetCSS("react");
  setAssetCache({ "img:2": { kind: "png", data: "data:image/png;base64,BB" } });
  const out = buildHTML([frame({ id: "img:2" })], "Test");
  contains(out.rawHtml, "/>");
  contains(out.rawHtml, "className=");
  setAssetCache({});
});

console.log("\n— semantic tag inference —");

t("button name → <button>", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Primary Button" })], "Test");
  contains(out.rawHtml, "<button ");
});

t("nav name → <nav>", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Top Nav" })], "Test");
  contains(out.rawHtml, "<nav ");
});

t("heading text → <h1>", () => {
  resetCSS("css");
  const out = buildHTML([frame({ children: [text({ name: "H1 Title", characters: "Hi" })] })], "Test");
  contains(out.rawHtml, "<h1 ");
  contains(out.rawHtml, "Hi");
});

t("search input self-closes and adds placeholder", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Search Input" })], "Test");
  contains(out.rawHtml, "<input ");
  contains(out.rawHtml, 'placeholder="Search Input"');
  notContains(out.rawHtml, "</input>");
});

t("card name → <article>", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Product Card" })], "Test");
  contains(out.rawHtml, "<article ");
});

t("plain frame stays as <div>", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Wrapper" })], "Test");
  contains(out.rawHtml, "<div ");
});

console.log("\n— per-side border/radius —");

t("mixed corner radii → 4-value border-radius", () => {
  resetCSS("css");
  const n = frame({ cornerRadius: undefined, topLeftRadius: 16, topRightRadius: 0, bottomRightRadius: 16, bottomLeftRadius: 0 });
  const out = buildHTML([n], "Test");
  contains(out.css, "border-radius: 16px 0px 16px 0px");
});

t("mixed stroke widths → per-side borders", () => {
  resetCSS("css");
  const n = frame({
    strokes: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    individualStrokeWeights: { top: 0, right: 0, bottom: 2, left: 0 },
  });
  const out = buildHTML([n], "Test");
  contains(out.css, "border-bottom: 2px solid");
  notContains(out.css, "border-top: 2px");
});

console.log("\n— accessibility —");

t("button gets type=button", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Primary Button", children: [text({ characters: "Click" })] })], "Test");
  contains(out.rawHtml, 'type="button"');
});

t("icon-only button gets aria-label", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Close Button" })], "Test");
  contains(out.rawHtml, 'aria-label="Close Button"');
  contains(out.rawHtml, 'type="button"');
});

t("svg gets role=img + aria-label", () => {
  resetCSS("css");
  setAssetCache({ "vec:a": { kind: "svg", data: "<svg/>" } });
  const out = buildHTML([frame({ id: "vec:a", type: "VECTOR", name: "Heart Icon" })], "Test");
  contains(out.rawHtml, 'role="img"');
  contains(out.rawHtml, 'aria-label="Heart Icon"');
  setAssetCache({});
});

t("input gets aria-label + placeholder", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Email Input" })], "Test");
  contains(out.rawHtml, 'aria-label="Email Input"');
  contains(out.rawHtml, 'placeholder="Email Input"');
});

console.log("\n— swiftui emitter —");

t("frame → ZStack with modifiers", () => {
  resetCSS("swiftui");
  const out = buildOutput([frame({ name: "Hero" })], "Hero");
  contains(out.code, "import SwiftUI");
  contains(out.code, "struct Hero: View");
  contains(out.code, "ZStack {");
  contains(out.code, ".frame(width: 200, height: 100)");
  contains(out.code, ".background(Color(red:");
  contains(out.code, ".cornerRadius(8)");
  contains(out.code, "#Preview");
});

t("auto layout → HStack with spacing", () => {
  resetCSS("swiftui");
  const out = buildOutput([autoLayout({ name: "Row", children: [text({ characters: "Hi" })] })], "Row");
  contains(out.code, "HStack(spacing: 8)");
  contains(out.code, "Text(\"Hi\")");
  contains(out.code, ".padding(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))");
});

console.log("\n— jetpack compose emitter —");

t("frame → Box with modifier chain", () => {
  resetCSS("compose");
  const out = buildOutput([frame({ name: "Hero" })], "Hero");
  contains(out.code, "@Composable");
  contains(out.code, "fun Hero()");
  contains(out.code, "Box(modifier = Modifier.size(200.dp, 100.dp)");
  contains(out.code, "RoundedCornerShape(8.dp)");
  assert(out.codeLanguage === "kotlin", "codeLanguage kotlin");
});

t("auto layout → Row with spacedBy", () => {
  resetCSS("compose");
  const out = buildOutput([autoLayout({ name: "Row", children: [text({ characters: "Hi" })] })], "Row");
  contains(out.code, "Row(");
  contains(out.code, "Arrangement.spacedBy(8.dp)");
  contains(out.code, "Text(\"Hi\"");
  contains(out.code, "fontWeight = FontWeight.Bold");
});

console.log("\n— design tokens json —");

t("nests variables by '/' into DTCG format", () => {
  const json = buildTokensJSON({
    "VAR:1": { name: "Colors/Primary", type: "color", rawValue: "#7c6cfc", cssName: "--colors-primary", value: "#7c6cfc" },
    "VAR:2": { name: "Colors/Accent",  type: "color", rawValue: "#e89b3c", cssName: "--colors-accent", value: "#e89b3c" },
    "VAR:3": { name: "Spacing/md",     type: "dimension", rawValue: "16px", cssName: "--spacing-md", value: "16px" },
  });
  const obj = JSON.parse(json);
  assert(obj.colors.primary.$type === "color", "type");
  assert(obj.colors.primary.$value === "#7c6cfc", "value");
  assert(obj.colors.accent.$value === "#e89b3c", "accent");
  assert(obj.spacing.md.$type === "dimension", "dim type");
  assert(obj.spacing.md.$value === "16px", "dim value");
});

t("handles flat names", () => {
  const json = buildTokensJSON({
    "V:1": { name: "primary", type: "color", rawValue: "#fff", cssName: "--primary", value: "#fff" },
  });
  const obj = JSON.parse(json);
  assert(obj.primary.$value === "#fff", "flat");
});

console.log("\n— responsive / constraints —");

t("auto-layout FILL child gets flex:1", () => {
  resetCSS("css");
  const child = frame({ id: "c:1", name: "Fill", width: 100, height: 40, layoutSizingHorizontal: "FILL", layoutSizingVertical: "FIXED" });
  const out = buildHTML([autoLayout({ children: [child] })], "Test");
  contains(out.css, "flex: 1 1 0");
  notContains(out.css, "\n  width: 100px"); // no fixed px width for the FILL child
});

t("auto-layout HUG child omits width", () => {
  resetCSS("css");
  const child = frame({ id: "c:2", name: "Hug", layoutSizingHorizontal: "HUG", layoutSizingVertical: "HUG" });
  const out = buildHTML([autoLayout({ children: [child] })], "Test");
  // the HUG child rule should not set width or height
  const match = /\.hug \{[\s\S]*?\}/.exec(out.css);
  assert(match, "found child rule");
  assert(match[0].indexOf("width:") === -1, "no width on HUG");
  assert(match[0].indexOf("height:") === -1, "no height on HUG");
});

t("non-auto MAX constraint → right offset", () => {
  resetCSS("css");
  const child = frame({ id: "c:3", x: 380, y: 10, width: 100, height: 40, constraints: { horizontal: "MAX", vertical: "MIN" } });
  const parent = frame({ id: "p", width: 500, height: 200, children: [child] });
  const out = buildHTML([parent], "Test");
  contains(out.css, "right: 20px");
});

t("non-auto STRETCH constraint → left + right", () => {
  resetCSS("css");
  const child = frame({ id: "c:4", x: 16, y: 16, width: 468, height: 40, constraints: { horizontal: "STRETCH", vertical: "MIN" } });
  const parent = frame({ id: "p2", width: 500, height: 200, children: [child] });
  const out = buildHTML([parent], "Test");
  contains(out.css, "left: 16px");
  contains(out.css, "right: 16px");
});

console.log("\n— kebab class names —");

t("uses node name as class", () => {
  resetCSS("css");
  const out = buildHTML([frame({ name: "Hero Card" })], "Test");
  contains(out.css, ".hero-card {");
  contains(out.rawHtml, 'class="hero-card"');
});

t("dedupe collisions with suffix", () => {
  resetCSS("css");
  const a = frame({ id: "a", name: "Row" });
  const b = frame({ id: "b", name: "Row" });
  const out = buildHTML([frame({ id: "p", children: [a, b] })], "Test");
  contains(out.css, ".row");
  contains(out.css, ".row-1");
});

console.log("\n— text styles → classes —");

t("shared text style emits single class, reuses it", () => {
  resetCSS("css");
  setTextStyleMap({
    "S:h1": { className: "text-heading", decls: { "font-family": "'Inter',sans-serif", "font-size": "32px", "font-weight": 700 } },
  });
  const a = text({ id: "t1", name: "Alpha", textStyleId: "S:h1", characters: "A" });
  const b = text({ id: "t2", name: "Beta",  textStyleId: "S:h1", characters: "B" });
  const out = buildHTML([frame({ children: [a, b] })], "Test");
  contains(out.css, ".text-heading {");
  contains(out.css, "font-size: 32px");
  contains(out.rawHtml, 'class="alpha text-heading"');
  contains(out.rawHtml, 'class="beta text-heading"');
  // font-size should only appear inside the hoisted .text-heading rule, not under per-node rules
  const textHeadingRule = /\.text-heading \{[\s\S]*?\}/.exec(out.css);
  assert(textHeadingRule && textHeadingRule[0].indexOf("font-size") !== -1, "font-size lives on .text-heading");
  // count font-size occurrences — should be exactly 1 (on text-heading)
  const fontSizeCount = (out.css.match(/font-size:/g) || []).length;
  assert(fontSizeCount === 1, "font-size not duplicated on per-node rules, got " + fontSizeCount);
  setTextStyleMap({});
});

console.log("\n— dedupe identical rulesets —");

t("identical decls merged into grouped selector", () => {
  resetCSS("css");
  const a = frame({ id: "x:1", name: "Alpha" });
  const b = frame({ id: "x:2", name: "Beta" });
  const out = buildHTML([frame({ id: "p", children: [a, b] })], "Test");
  contains(out.css, ".alpha,\n.beta {");
  // alpha and beta share everything → one merged block (parent's block is separate since it has children layout)
  const alphaBetaGroup = /\.alpha,\n\.beta \{[\s\S]*?\}/.exec(out.css);
  assert(alphaBetaGroup, "alpha+beta grouped block exists");
});

console.log("\n— bundle export —");

t("css bundle contains index.html and styles.css", () => {
  resetCSS("css");
  const files = buildBundle([frame()], "Test");
  const paths = files.map(f => f.path);
  assert(paths.indexOf("index.html") !== -1, "index.html present");
  assert(paths.indexOf("styles.css") !== -1, "styles.css present");
});

t("react bundle emits jsx + css + html", () => {
  resetCSS("react");
  const files = buildBundle([frame({ name: "Hero" })], "Hero");
  const paths = files.map(f => f.path);
  assert(paths.indexOf("Hero.jsx") !== -1, "Hero.jsx");
  assert(paths.indexOf("Hero.css") !== -1, "Hero.css");
});

t("swiftui bundle emits .swift", () => {
  resetCSS("swiftui");
  const files = buildBundle([frame({ name: "Hero" })], "Hero");
  assert(files.some(f => f.path === "Hero.swift"), "Hero.swift present");
});

t("buildZip produces valid ZIP signature", () => {
  const zip = buildZip([{ path: "a.txt", data: "hi" }, { path: "b.txt", data: "yo" }]);
  assert(zip instanceof Uint8Array, "Uint8Array");
  assert(zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 0x03 && zip[3] === 0x04, "local file header signature");
  // End-of-central-directory signature at end
  const last4 = String.fromCharCode(zip[zip.length - 22], zip[zip.length - 21], zip[zip.length - 20], zip[zip.length - 19]);
  assert(zip[zip.length - 22] === 0x50 && zip[zip.length - 21] === 0x4b, "EOCD signature near end");
});

console.log("\n— tailwind config —");

t("buildTailwindConfig groups vars by bucket", () => {
  const cfg = buildTailwindConfig({
    "v1": { name: "Colors/Primary", type: "color", cssName: "--colors-primary", value: "#7c6cfc" },
    "v2": { name: "Spacing/md",     type: "dimension", cssName: "--spacing-md", value: "16px" },
    "v3": { name: "Radius/lg",      type: "dimension", cssName: "--radius-lg", value: "12px" },
  });
  contains(cfg, 'colors: {');
  contains(cfg, '"colors-primary": "var(--colors-primary)"');
  contains(cfg, 'spacing: {');
  contains(cfg, '"spacing-md": "var(--spacing-md)"');
  contains(cfg, 'borderRadius: {');
  contains(cfg, '"radius-lg": "var(--radius-lg)"');
  contains(cfg, 'module.exports');
});

t("tailwind bundle includes tailwind.config.js when vars present", () => {
  resetCSS("tailwind");
  setVariableMap({ "v1": { cssName: "--c", value: "#fff", name: "Colors/Primary", type: "color", rawValue: "#fff" } });
  const files = buildBundle([frame()], "Test");
  assert(files.some(f => f.path === "tailwind.config.js"), "tailwind.config.js emitted");
  setVariableMap({});
});

console.log("\n— sandbox URL —");

t("stackblitz form contains file fields and submits", () => {
  const html = buildStackblitzHTML([{ path: "index.html", data: "<h1>hi</h1>" }], "Demo");
  contains(html, 'action="https://stackblitz.com/run"');
  contains(html, 'project[files][index.html]');
  contains(html, '&lt;h1&gt;hi&lt;/h1&gt;');
  contains(html, 'project[title]');
  contains(html, 'Demo');
  contains(html, '.submit()');
});

console.log("\n— minify toggle —");

t("minify strips whitespace and comments", () => {
  resetCSS("css");
  setMinify(true);
  const out = buildHTML([frame({ children: [text()] })], "Test");
  notContains(out.css, "/*");
  notContains(out.css, "\n\n");
  notContains(out.html, "\n  ");
  setMinify(false);
});

console.log("\n— component instances —");

t("two INSTANCE nodes sharing mainComponent collapse to one class", () => {
  resetCSS("css");
  const main = { name: "Chip" };
  const a = frame({ id: "i:1", name: "Chip A", type: "INSTANCE", mainComponent: main });
  const b = frame({ id: "i:2", name: "Chip B", type: "INSTANCE", mainComponent: main });
  const out = buildHTML([frame({ id: "p", children: [a, b] })], "Test");
  const matches = out.css.match(/\.i-chip \{/g) || [];
  assert(matches.length === 1, "exactly one .i-chip rule, got " + matches.length);
  contains(out.rawHtml, 'class="i-chip"');
  contains(out.rawHtml, 'data-component="Chip"');
});

console.log("\n— deterministic slugs —");

t("slug follows ancestor path", () => {
  resetCSS("css");
  const child = frame({ id: "c:1", name: "Title" });
  const hero = frame({ id: "h:1", name: "Hero", children: [child] });
  const page = frame({ id: "p:1", name: "Home", children: [hero] });
  assignSlugs([page], "");
  assert(slugFor(page) === "home", "page slug=home, got " + slugFor(page));
  assert(slugFor(hero) === "home/hero", "hero slug, got " + slugFor(hero));
  assert(slugFor(child) === "home/hero/title", "child slug, got " + slugFor(child));
});

t("duplicate sibling names get suffix", () => {
  resetCSS("css");
  const a = frame({ id: "a", name: "Row" });
  const b = frame({ id: "b", name: "Row" });
  const page = frame({ id: "p", name: "Home", children: [a, b] });
  assignSlugs([page], "");
  assert(slugFor(a) === "home/row", "first row, got " + slugFor(a));
  assert(slugFor(b) === "home/row-1", "second row suffix, got " + slugFor(b));
});

t("slug appears in emitted HTML as data-figma-slug", () => {
  resetCSS("css");
  const out = buildHTML([frame({ id: "p:x", name: "Home", children: [frame({ id: "h:x", name: "Hero" })] })], "Home");
  contains(out.rawHtml, 'data-figma-slug="home"');
  contains(out.rawHtml, 'data-figma-slug="home/hero"');
});

t("slug lock survives renames", () => {
  resetCSS("css");
  setSlugLock({ "n:1": "home/hero/original-slug" });
  const node = frame({ id: "n:1", name: "Renamed Title" });
  const page = frame({ id: "p", name: "Home", children: [node] });
  assignSlugs([page], "");
  assert(slugFor(node) === "home/hero/original-slug", "locked slug preserved, got " + slugFor(node));
  setSlugLock({});
});

t("getSlugLock exports current mapping", () => {
  resetCSS("css");
  const page = frame({ id: "p:y", name: "Home", children: [frame({ id: "h:y", name: "Hero" })] });
  assignSlugs([page], "");
  const lock = getSlugLock();
  assert(lock["p:y"] === "home", "p:y locked");
  assert(lock["h:y"] === "home/hero", "h:y locked");
});

t("slug is deterministic across runs", () => {
  resetCSS("css");
  const tree = () => frame({ id: "p:z", name: "Home", children: [frame({ id: "c1", name: "A" }), frame({ id: "c2", name: "B" })] });
  assignSlugs([tree()], "");
  const first = getSlugLock();
  resetCSS("css");
  assignSlugs([tree()], "");
  const second = getSlugLock();
  assert(JSON.stringify(first) === JSON.stringify(second), "deterministic across runs");
});

t("slug survives in img and svg emission", () => {
  resetCSS("css");
  setAssetCache({
    "img:a": { kind: "png", data: "data:image/png;base64,AA" },
    "vec:a": { kind: "svg", data: "<svg/>" },
  });
  const out = buildHTML([frame({ id: "p", name: "Home", children: [
    frame({ id: "img:a", name: "Photo" }),
    frame({ id: "vec:a", type: "VECTOR", name: "Icon" }),
  ] })], "Home");
  contains(out.rawHtml, 'data-figma-slug="home/photo"');
  contains(out.rawHtml, 'data-figma-slug="home/icon"');
  setAssetCache({});
});

t("slug on void tags (input)", () => {
  resetCSS("css");
  const out = buildHTML([frame({ id: "p", name: "Home", children: [frame({ id: "i:1", name: "Search Input" })] })], "Home");
  contains(out.rawHtml, '<input ');
  contains(out.rawHtml, 'data-figma-slug="home/search-input"');
});

console.log("\n— agent handoff bundle —");

t("hierarchyMd renders indented slug tree", () => {
  resetCSS("css");
  const tree = [frame({ id: "p", name: "Home", children: [
    frame({ id: "h", name: "Hero", children: [text({ id: "t", name: "Title", characters: "Welcome back" })] })
  ] })];
  assignSlugs(tree, "");
  const md = hierarchyMd(tree);
  contains(md, "# Hierarchy");
  contains(md, "- `home` [div]");
  contains(md, "  - `home/hero` [div]");
  contains(md, "    - `home/hero/title`");
  contains(md, 'text="Welcome back"');
});

t("componentsJson catalogs COMPONENT_SETs and counts instance usage", () => {
  resetCSS("css");
  const btn = { id: "comp:btn", name: "Button", type: "COMPONENT_SET",
    componentPropertyDefinitions: { variant: { type: "VARIANT", variantOptions: ["primary", "secondary"] } },
    children: [
      { id: "v:p", type: "COMPONENT", name: "variant=primary", variantProperties: { variant: "primary" } },
      { id: "v:s", type: "COMPONENT", name: "variant=secondary", variantProperties: { variant: "secondary" } },
    ],
  };
  const page = frame({ id: "p", name: "Home", children: [
    btn,
    frame({ id: "i1", name: "Save", type: "INSTANCE", mainComponent: { name: "Button" } }),
    frame({ id: "i2", name: "Cancel", type: "INSTANCE", mainComponent: { name: "Button" } }),
  ] });
  assignSlugs([page], "");
  const cj = JSON.parse(componentsJson([page]));
  assert(cj.components.Button, "Button catalogued");
  assert(cj.components.Button.type === "COMPONENT_SET", "type");
  assert(cj.components.Button.usage === 2, "usage count = 2, got " + cj.components.Button.usage);
  assert(cj.components.Button.variants.length === 2, "two variants");
  assert(cj.components.Button.propertyDefinitions, "prop defs present");
});

t("designMd summarizes palette, type scale, spacing", () => {
  resetCSS("css");
  const tree = [autoLayout({ id: "p", name: "Home", itemSpacing: 16, children: [
    text({ id: "t1", name: "Title", fontSize: 32, characters: "Hi" }),
    text({ id: "t2", name: "Copy",  fontSize: 16, characters: "Body" }),
  ] })];
  assignSlugs(tree, "");
  const md = designMd(tree, "Home");
  contains(md, "# Home");
  contains(md, "## Inventory");
  contains(md, "## Palette");
  contains(md, "## Type scale");
  contains(md, "`32px`");
  contains(md, "`16px`");
  contains(md, "## Spacing scale");
});

t("agentsMd embeds mapping hints when provided", () => {
  const md = agentsMd("Home", { mappings: { Button: "@/components/Button" } });
  contains(md, "# Agent instructions for Home");
  contains(md, "Prefer tokens");
  contains(md, "When you see component `Button`, use `@/components/Button`");
});

t("agentsMd has neutral fallback when no mappings", () => {
  const md = agentsMd("Home", {});
  contains(md, "no code mappings");
});

t("manifestJson hashes every file + sums token estimates", () => {
  const files = [
    { path: "a.md", data: "hello world" },
    { path: "b.json", data: JSON.stringify({ x: 1 }) },
  ];
  const m = JSON.parse(manifestJson(files));
  assert(m.version === 1, "version");
  assert(m.files.length === 2, "two files");
  assert(m.files[0].hash && m.files[0].hash.length === 16, "16-hex hash");
  assert(m.files[0].bytes === 11, "bytes of 'hello world'");
  assert(m.tokens_est_total > 0, "total tokens");
});

t("contentHash is deterministic and differs for different inputs", () => {
  assert(contentHash("abc") === contentHash("abc"), "deterministic");
  assert(contentHash("abc") !== contentHash("abd"), "differs");
  assert(contentHash("").length === 16, "empty-string length");
});

t("buildAgentBundle emits stable-first file order", () => {
  resetCSS("css");
  const tree = [frame({ id: "p", name: "Home", children: [text({ id: "t", name: "Title", characters: "Hi" })] })];
  const files = buildAgentBundle(tree, "Home");
  const paths = files.map(f => f.path);
  // Stable (tokens, components) before volatile (hierarchy, DESIGN)
  const iTokensJson = paths.indexOf("tokens.json");
  const iComponents = paths.indexOf("components.json");
  const iHierarchy  = paths.indexOf("hierarchy.md");
  const iDesign     = paths.indexOf("DESIGN.md");
  const iManifest   = paths.indexOf("manifest.json");
  assert(iTokensJson >= 0 && iTokensJson < iHierarchy, "tokens.json before hierarchy.md");
  assert(iComponents < iHierarchy, "components.json before hierarchy.md");
  assert(iHierarchy < iDesign, "hierarchy.md before DESIGN.md");
  assert(iManifest === paths.length - 1, "manifest.json is last (so it covers all other files)");
});

t("buildAgentBundle includes screenshots when supplied", () => {
  resetCSS("css");
  const tree = [frame({ id: "p:ss", name: "Home" })];
  const files = buildAgentBundle(tree, "Home", { screenshots: { "p:ss": new Uint8Array([137, 80, 78, 71]) } });
  const paths = files.map(f => f.path);
  assert(paths.indexOf("screenshots/home.png") !== -1, "slug-named screenshot present");
});

t("buildAgentBundle manifest lists all files including itself", () => {
  resetCSS("css");
  const tree = [frame({ id: "p", name: "Home" })];
  const files = buildAgentBundle(tree, "Home");
  const manifest = JSON.parse(files.find(f => f.path === "manifest.json").data);
  const manifestPaths = manifest.files.map(e => e.path);
  assert(manifestPaths.indexOf("tokens.json") !== -1, "tokens.json in manifest");
  assert(manifestPaths.indexOf("hierarchy.md") !== -1, "hierarchy.md in manifest");
  assert(manifestPaths.indexOf("AGENTS.md") !== -1, "AGENTS.md in manifest");
});

t("buildAgentBundle is deterministic (same input → same hashes)", () => {
  resetCSS("css");
  const make = () => [frame({ id: "p", name: "Home", children: [frame({ id: "c", name: "Hero" })] })];
  const f1 = buildAgentBundle(make(), "Home");
  const f2 = buildAgentBundle(make(), "Home");
  const m1 = JSON.parse(f1.find(f => f.path === "manifest.json").data);
  const m2 = JSON.parse(f2.find(f => f.path === "manifest.json").data);
  // Compare file hashes (excluding manifest itself)
  const hashes1 = m1.files.filter(e => e.path !== "manifest.json").map(e => e.path + ":" + e.hash).sort().join("|");
  const hashes2 = m2.files.filter(e => e.path !== "manifest.json").map(e => e.path + ":" + e.hash).sort().join("|");
  assert(hashes1 === hashes2, "deterministic hashes");
});

t("buildAgentBundle zips cleanly", () => {
  resetCSS("css");
  const tree = [frame({ id: "p", name: "Home", children: [text({ id: "t", name: "Title", characters: "Hi" })] })];
  const files = buildAgentBundle(tree, "Home");
  const zip = buildZip(files);
  assert(zip instanceof Uint8Array, "Uint8Array");
  assert(zip[0] === 0x50 && zip[1] === 0x4b, "ZIP signature");
});

console.log("\n— diff-mode CHANGES.md —");

t("buildSnapshot captures slug fingerprint per node", () => {
  resetCSS("css");
  const tree = [frame({ id: "p", name: "Home", children: [
    text({ id: "t", name: "Title", characters: "Welcome", fontSize: 32 }),
  ] })];
  assignSlugs(tree, "");
  const snap = buildSnapshot(tree);
  assert(snap["home"], "home snap");
  assert(snap["home/title"], "home/title snap");
  assert(snap["home/title"].text === "Welcome", "text captured");
  assert(snap["home/title"].fontSize === 32, "fontSize captured");
});

t("diffSnapshots detects add, remove, change", () => {
  const prev = {
    "home/title": { type: "TEXT", text: "Welcome", size: null, padding: null, gap: null, radius: null, fontSize: 32, fontWeight: "Bold", instance: null },
    "home/legacy":{ type: "FRAME", text: null, size: "100x100", padding: null, gap: null, radius: 8, fontSize: null, fontWeight: null, instance: null },
  };
  const cur = {
    "home/title":   { type: "TEXT", text: "Welcome back", size: null, padding: null, gap: null, radius: null, fontSize: 32, fontWeight: "Bold", instance: null },
    "home/subtitle":{ type: "TEXT", text: "Howdy", size: null, padding: null, gap: null, radius: null, fontSize: 14, fontWeight: "Regular", instance: null },
  };
  const d = diffSnapshots(prev, cur);
  assert(d.added.length === 1 && d.added[0].slug === "home/subtitle", "subtitle added");
  assert(d.removed.length === 1 && d.removed[0].slug === "home/legacy", "legacy removed");
  const titleText = d.changed.find(c => c.slug === "home/title" && c.field === "text");
  assert(titleText && titleText.from === "Welcome" && titleText.to === "Welcome back", "title text change");
});

t("changesMd renders human-readable markdown", () => {
  const diff = {
    added: [{ slug: "home/subtitle", fp: { type: "TEXT", text: "Hi", size: "200x20" } }],
    removed: [{ slug: "home/legacy", fp: { type: "FRAME" } }],
    changed: [{ slug: "home/title", field: "text", from: "Welcome", to: "Welcome back" }],
  };
  const md = changesMd(diff);
  contains(md, "# Changes");
  contains(md, "## Added");
  contains(md, "- `home/subtitle`");
  contains(md, "## Removed");
  contains(md, "- `home/legacy`");
  contains(md, "## Changed");
  contains(md, "### `home/title`");
  contains(md, "`Welcome` → `Welcome back`");
});

t("changesMd empty diff prints no changes message", () => {
  const md = changesMd({ added: [], removed: [], changed: [] });
  contains(md, "_No changes detected._");
});

t("buildAgentBundle includes CHANGES.md when priorSnapshot is supplied", () => {
  resetCSS("css");
  const v1 = [frame({ id: "p", name: "Home", children: [text({ id: "t", name: "Title", characters: "Welcome" })] })];
  assignSlugs(v1, "");
  const priorSnapshot = buildSnapshot(v1);

  resetCSS("css");
  const v2 = [frame({ id: "p", name: "Home", children: [
    text({ id: "t", name: "Title", characters: "Welcome back" }),
    text({ id: "s", name: "Subtitle", characters: "Howdy" }),
  ] })];
  const files = buildAgentBundle(v2, "Home", { priorSnapshot });
  const changes = files.find(f => f.path === "CHANGES.md");
  assert(changes, "CHANGES.md present");
  contains(changes.data, "home/subtitle");
  contains(changes.data, "Welcome back");
  const changesJson = files.find(f => f.path === "changes.json");
  assert(changesJson, "changes.json present");
  const parsed = JSON.parse(changesJson.data);
  assert(parsed.added.some(a => a.slug === "home/subtitle"), "subtitle added in json");
});

t("buildAgentBundle always emits snapshot.json for next-run persistence", () => {
  resetCSS("css");
  const tree = [frame({ id: "p", name: "Home" })];
  const files = buildAgentBundle(tree, "Home");
  assert(files.some(f => f.path === "snapshot.json"), "snapshot.json present");
});

t("buildAgentBundle with no prior omits CHANGES.md entirely", () => {
  resetCSS("css");
  const tree = [frame({ id: "p", name: "Home" })];
  const files = buildAgentBundle(tree, "Home");
  assert(!files.some(f => f.path === "CHANGES.md"), "no CHANGES.md without prior");
});

console.log("\n— a11y audit —");

t("contrastRatio: black on white is 21:1", () => {
  const r = contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, { r: 1, g: 1, b: 1, a: 1 });
  assert(Math.abs(r - 21) < 0.1, "got " + r);
});

t("auditA11y flags low-contrast body text", () => {
  resetCSS("css");
  // Light gray text (#BBB) on white — ratio ~1.9, fails AA 4.5.
  const badText = text({
    id: "tx", name: "Copy",
    fills: [{ type: "SOLID", color: { r: 0.73, g: 0.73, b: 0.73 }, opacity: 1 }],
    fontSize: 14,
  });
  const root = frame({ id: "f", name: "Card", children: [badText] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  const hit = issues.find(i => i.type === "contrast");
  assert(hit, "expected a contrast issue");
  assert(hit.level === "error", "contrast issue is an error");
  contains(hit.message, "WCAG AA");
});

t("auditA11y allows sufficient contrast", () => {
  resetCSS("css");
  const goodText = text({
    id: "tx", name: "Copy",
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    fontSize: 14,
  });
  const root = frame({ id: "f", name: "Card", children: [goodText] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  assert(!issues.some(i => i.type === "contrast"), "black on white should pass");
});

t("auditA11y uses relaxed 3:1 for large text", () => {
  resetCSS("css");
  // Medium gray text big enough for "large" (>= 24px).
  const big = text({
    id: "tx", name: "Heading",
    fills: [{ type: "SOLID", color: { r: 0.55, g: 0.55, b: 0.55 }, opacity: 1 }],
    fontSize: 32,
  });
  const root = frame({ id: "f", name: "Card", children: [big] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  const contrastIssue = issues.find(i => i.type === "contrast");
  // ratio ~3.9 — passes 3:1 large, fails 4.5:1 normal; this proves relaxed threshold applies.
  assert(!contrastIssue, "large text should pass 3:1 even at ratio 3.9");
});

t("auditA11y detects heading-order skip", () => {
  resetCSS("css");
  const h1 = text({ id: "h1", name: "h1 title", characters: "Big" });
  const h3 = text({ id: "h3", name: "h3 section", characters: "Oops" });
  const root = frame({ id: "f", name: "Home", children: [h1, h3] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  const hit = issues.find(i => i.type === "heading-order");
  assert(hit, "expected heading-order issue");
  contains(hit.message, "h1");
  contains(hit.message, "h3");
});

t("auditA11y flags unlabeled images", () => {
  resetCSS("css");
  const img = frame({
    id: "img1", name: "Rectangle",
    fills: [{ type: "IMAGE", imageHash: "abc", scaleMode: "FILL" }],
  });
  const root = frame({ id: "f", name: "Card", children: [img] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  assert(issues.some(i => i.type === "missing-label"), "expected missing-label");
});

t("auditA11y flags interactive-without-text", () => {
  resetCSS("css");
  // Button frame with no text children.
  const btn = autoLayout({ id: "b1", name: "Button", children: [] });
  const root = frame({ id: "f", name: "Card", children: [btn] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  const hit = issues.find(i => i.type === "interactive-no-text");
  assert(hit, "expected interactive-no-text");
  assert(hit.level === "error", "should be error level");
});

t("auditA11y passes interactive with text child", () => {
  resetCSS("css");
  const btn = autoLayout({
    id: "b1", name: "Button",
    children: [text({ id: "t1", name: "Label", characters: "Go" })],
  });
  const root = frame({ id: "f", name: "Card", children: [btn] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  assert(!issues.some(i => i.type === "interactive-no-text"), "button with text should pass");
});

t("auditA11y flags touch targets smaller than 44px", () => {
  resetCSS("css");
  const btn = autoLayout({
    id: "b1", name: "Button", width: 30, height: 20,
    children: [text({ id: "t1", name: "Label", characters: "x" })],
  });
  const root = frame({ id: "f", name: "Card", children: [btn] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  const hit = issues.find(i => i.type === "touch-target");
  assert(hit, "expected touch-target issue");
  contains(hit.message, "30×20");
});

t("auditA11y walks into nested backgrounds for contrast", () => {
  resetCSS("css");
  // Dark parent → white text should pass even though grandparent is white.
  const child = text({
    id: "tx", name: "Copy", fontSize: 14,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
  });
  const darkCard = frame({
    id: "dc", name: "Card",
    fills: [{ type: "SOLID", color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    children: [child],
  });
  const root = frame({ id: "root", name: "Page", children: [darkCard] });
  assignSlugs([root], "");
  const issues = auditA11y([root]);
  assert(!issues.some(i => i.type === "contrast"), "white on black should pass");
});

t("issuesMd renders no-issues state", () => {
  const md = issuesMd([]);
  contains(md, "No issues detected");
});

t("issuesMd groups by type", () => {
  const md = issuesMd([
    { level: "error", type: "contrast", slug: "a", nodeId: "1", message: "m1" },
    { level: "warn", type: "contrast", slug: "b", nodeId: "2", message: "m2" },
    { level: "error", type: "interactive-no-text", slug: "c", nodeId: "3", message: "m3" },
  ]);
  contains(md, "## contrast (2)");
  contains(md, "## interactive-no-text (1)");
  contains(md, "`a`");
});

t("buildAgentBundle includes ISSUES.md + issues.json + AGENTS.md summary", () => {
  resetCSS("css");
  const badText = text({
    id: "tx", name: "Copy",
    fills: [{ type: "SOLID", color: { r: 0.73, g: 0.73, b: 0.73 }, opacity: 1 }],
    fontSize: 14,
  });
  const root = frame({ id: "f", name: "Card", children: [badText] });
  const files = buildAgentBundle([root], "Home");
  assert(files.some(f => f.path === "ISSUES.md"), "ISSUES.md present");
  const jsonFile = files.find(f => f.path === "issues.json");
  assert(jsonFile, "issues.json present");
  const parsed = JSON.parse(jsonFile.data);
  assert(parsed.some(i => i.type === "contrast"), "contrast issue surfaced in json");
  const agents = files.find(f => f.path === "AGENTS.md");
  contains(agents.data, "Known accessibility issues");
  contains(agents.data, "contrast");
  // manifest should include the new files.
  const manifest = JSON.parse(files.find(f => f.path === "manifest.json").data);
  assert(manifest.files.some(f => f.path === "ISSUES.md"), "manifest lists ISSUES.md");
});

console.log("\n— component mapping —");

t("levenshtein basic distances", () => {
  assert(levenshtein("abc", "abc") === 0);
  assert(levenshtein("kitten", "sitting") === 3);
  assert(levenshtein("", "abc") === 3);
});

t("collectFigmaComponentNames gathers COMPONENT, COMPONENT_SET, INSTANCE mains", () => {
  const tree = [frame({ id: "r", name: "Root", children: [
    { id: "c1", name: "Button", type: "COMPONENT", children: [] },
    { id: "c2", name: "Card", type: "COMPONENT_SET", children: [] },
    { id: "i1", name: "inst", type: "INSTANCE", mainComponent: { name: "Icon" }, children: [] },
  ] })];
  const names = collectFigmaComponentNames(tree);
  assert(names.indexOf("Button") !== -1, "Button present");
  assert(names.indexOf("Card") !== -1, "Card present");
  assert(names.indexOf("Icon") !== -1, "Icon present");
});

t("fuzzyMatchComponents exact basename match wins", () => {
  const m = fuzzyMatchComponents(["Button"], ["src/components/Button.tsx", "src/components/Buttonish.tsx"]);
  assert(m["Button"] === "src/components/Button.tsx", "got " + m["Button"]);
});

t("fuzzyMatchComponents tolerates minor typos and case", () => {
  const m = fuzzyMatchComponents(["Primary Button"], ["src/components/PrimaryButton.tsx"]);
  assert(m["Primary Button"] === "src/components/PrimaryButton.tsx", "normalized match");
});

t("fuzzyMatchComponents respects threshold", () => {
  // "Button" vs "Dropdown" — distance too far under threshold 0.2.
  const m = fuzzyMatchComponents(["Button"], ["src/Dropdown.tsx"], { threshold: 0.2 });
  assert(!m["Button"], "should not match dissimilar names");
});

t("fuzzyMatchComponents picks best among candidates", () => {
  const m = fuzzyMatchComponents(["Card"], ["src/Carousel.tsx", "src/Card.tsx", "src/Carding.tsx"]);
  assert(m["Card"] === "src/Card.tsx", "best match is exact Card.tsx");
});

t("componentsJson includes mapping + codePath per component", () => {
  resetCSS("css");
  const cset = { id: "c1", name: "Button", type: "COMPONENT_SET", children: [] };
  const root = frame({ id: "r", name: "Home", children: [cset] });
  assignSlugs([root], "");
  const json = JSON.parse(componentsJson([root], { Button: "src/Button.tsx" }));
  assert(json.mapping.Button === "src/Button.tsx", "mapping block echoed");
  assert(json.components.Button.codePath === "src/Button.tsx", "codePath attached");
});

t("setComponentMap persists default mapping when no override", () => {
  resetCSS("css");
  setComponentMap({ Button: "pkg/ui/Button" });
  const cset = { id: "c1", name: "Button", type: "COMPONENT_SET", children: [] };
  const root = frame({ id: "r", name: "Home", children: [cset] });
  assignSlugs([root], "");
  const json = JSON.parse(componentsJson([root]));
  assert(json.components.Button.codePath === "pkg/ui/Button", "persisted mapping used");
  setComponentMap({}); // reset for subsequent tests
});

t("buildAgentBundle fuzzy-matches codePaths into mapping", () => {
  resetCSS("css");
  const cset = { id: "c1", name: "PrimaryButton", type: "COMPONENT_SET", children: [] };
  const root = frame({ id: "r", name: "Home", children: [cset] });
  const files = buildAgentBundle([root], "Home", { codePaths: ["src/components/PrimaryButton.tsx", "src/components/Card.tsx"] });
  const comps = JSON.parse(files.find(f => f.path === "components.json").data);
  assert(comps.mapping.PrimaryButton === "src/components/PrimaryButton.tsx", "fuzzy matched");
  const agents = files.find(f => f.path === "AGENTS.md").data;
  contains(agents, "PrimaryButton");
  contains(agents, "src/components/PrimaryButton.tsx");
});

t("buildAgentBundle explicit mappings override fuzzy matching", () => {
  resetCSS("css");
  const cset = { id: "c1", name: "Button", type: "COMPONENT_SET", children: [] };
  const root = frame({ id: "r", name: "Home", children: [cset] });
  const files = buildAgentBundle([root], "Home", {
    mappings: { Button: "@/ui/Button" },
    codePaths: ["src/wrong/Button.tsx"], // should be ignored
  });
  const comps = JSON.parse(files.find(f => f.path === "components.json").data);
  assert(comps.mapping.Button === "@/ui/Button", "explicit wins");
});

console.log("\n— variants → typed props + Storybook —");

const buttonDefs = {
  variant: { type: "VARIANT", defaultValue: "primary", variantOptions: ["primary", "secondary", "ghost"] },
  disabled: { type: "BOOLEAN", defaultValue: false },
  label: { type: "TEXT", defaultValue: "Click me" },
};

t("componentTsx emits typed union for VARIANT props", () => {
  const tsx = componentTsx("Button", buttonDefs);
  contains(tsx, 'export interface ButtonProps');
  contains(tsx, 'variant?: "primary" | "secondary" | "ghost"');
  contains(tsx, "disabled?: boolean");
  contains(tsx, "label?: string");
});

t("componentTsx wires defaults from defaultValue", () => {
  const tsx = componentTsx("Button", buttonDefs);
  contains(tsx, 'variant = "primary"');
  contains(tsx, "disabled = false");
  contains(tsx, 'label = "Click me"');
});

t("componentTsx uses children when no text prop", () => {
  const tsx = componentTsx("Card", {
    elevated: { type: "BOOLEAN", defaultValue: false },
  });
  contains(tsx, "children?: React.ReactNode");
  contains(tsx, "{children}");
});

t("variantCombinations enumerates full cartesian product", () => {
  const combos = variantCombinations(buttonDefs);
  // 3 variants × 2 booleans = 6 combinations. `label` is TEXT, not expanded.
  assert(combos.length === 6, "got " + combos.length);
  assert(combos.some(c => c.variant === "primary" && c.disabled === true), "primary+disabled combo");
  assert(combos.some(c => c.variant === "ghost" && c.disabled === false), "ghost+enabled combo");
});

t("variantCombinations returns single empty combo when no variants", () => {
  const combos = variantCombinations({ label: { type: "TEXT", defaultValue: "Hi" } });
  assert(combos.length === 1, "one combo");
  assert(Object.keys(combos[0]).length === 0, "empty args");
});

t("componentStories emits per-variant story args", () => {
  const stories = componentStories("Button", buttonDefs);
  contains(stories, 'import { Button } from "./Button"');
  contains(stories, "export const");
  contains(stories, 'variant: "primary"');
  contains(stories, "disabled: true");
});

t("buildComponentFiles emits .tsx + .stories.tsx per COMPONENT_SET", () => {
  const cset = {
    id: "cs1", name: "Button", type: "COMPONENT_SET",
    componentPropertyDefinitions: buttonDefs,
    children: [],
  };
  const root = frame({ id: "r", name: "Home", children: [cset] });
  const files = buildComponentFiles([root]);
  assert(files.some(f => f.path === "components/Button.tsx"), "tsx present");
  assert(files.some(f => f.path === "components/Button.stories.tsx"), "stories present");
});

t("buildComponentFiles skips components without propertyDefinitions", () => {
  const c = { id: "c1", name: "Plain", type: "COMPONENT", children: [] };
  const files = buildComponentFiles([frame({ id: "r", name: "R", children: [c] })]);
  assert(files.length === 0, "no files emitted without defs");
});

t("buildAgentBundle includes generated component files", () => {
  resetCSS("css");
  const cset = {
    id: "cs1", name: "Button", type: "COMPONENT_SET",
    componentPropertyDefinitions: buttonDefs,
    children: [],
  };
  const root = frame({ id: "r", name: "Home", children: [cset] });
  const files = buildAgentBundle([root], "Home");
  assert(files.some(f => f.path === "components/Button.tsx"), "tsx in bundle");
  assert(files.some(f => f.path === "components/Button.stories.tsx"), "stories in bundle");
  const manifest = JSON.parse(files.find(f => f.path === "manifest.json").data);
  assert(manifest.files.some(f => f.path === "components/Button.tsx"), "manifest lists tsx");
});

console.log("\n— budget tiers —");

t("BUDGETS exposes 8k/32k/128k tiers", () => {
  assert(BUDGETS.small === 8000 && BUDGETS.medium === 32000 && BUDGETS.large === 128000);
});

t("applyBudget keeps essential tokens files first", () => {
  const files = [
    { path: "tokens.json", data: "x".repeat(100) },
    { path: "tokens.css", data: "y".repeat(100) },
    { path: "DESIGN.md", data: "d".repeat(100000) },
    { path: "screenshots/a.png", data: new Uint8Array(100000) },
  ];
  const kept = applyBudget(files, "small");
  assert(kept.some(f => f.path === "tokens.json"), "tokens.json kept");
  assert(kept.some(f => f.path === "tokens.css"), "tokens.css kept");
});

t("applyBudget drops low-priority files when over cap", () => {
  const big = "a".repeat(50000); // ~12.5k tokens
  const files = [
    { path: "tokens.json", data: "x" },
    { path: "tokens.css", data: "y" },
    { path: "hierarchy.md", data: "z" },
    { path: "AGENTS.md", data: big },
    { path: "components.json", data: big },
    { path: "screenshots/a.png", data: new Uint8Array(200000) },
    { path: "components/Button.tsx", data: big },
  ];
  const kept = applyBudget(files, "small");
  assert(!kept.some(f => f.path === "screenshots/a.png"), "screenshots dropped");
  assert(!kept.some(f => /^components\//.test(f.path)), "generated component files dropped");
});

t("applyBudget large tier keeps everything", () => {
  const files = [
    { path: "tokens.json", data: "x" },
    { path: "DESIGN.md", data: "d" },
    { path: "screenshots/a.png", data: new Uint8Array(100) },
  ];
  const kept = applyBudget(files, "large");
  assert(kept.length === files.length, "all kept");
});

t("buildAgentBundle small tier produces a narrow file set", () => {
  resetCSS("css");
  const bigTree = [frame({ id: "p", name: "Home", children: Array.from({length: 200}, (_, i) => text({ id: "t" + i, name: "n" + i, characters: "long text here " + "x".repeat(500) })) })];
  const files = buildAgentBundle(bigTree, "Home", { budget: "small" });
  assert(files.some(f => f.path === "tokens.json"), "tokens.json present");
  assert(files.some(f => f.path === "manifest.json"), "manifest present");
  assert(!files.some(f => /^screenshots\//.test(f.path)), "no screenshots in small");
});

t("applyBudget preserves stable-first ordering after drops", () => {
  const files = [
    { path: "tokens.json", data: "x" },
    { path: "tokens.css", data: "y" },
    { path: "hierarchy.md", data: "z" },
    { path: "DESIGN.md", data: "a".repeat(50000) },
    { path: "components.json", data: "c" },
  ];
  const kept = applyBudget(files, "small");
  // Check order of kept files matches original order.
  const paths = kept.map(f => f.path);
  const origOrder = files.map(f => f.path).filter(p => paths.indexOf(p) !== -1);
  assert(JSON.stringify(paths) === JSON.stringify(origOrder), "order preserved: " + paths.join(","));
});

console.log("\n— flow Mermaid —");

t("flowMermaid returns placeholder when no reactions", () => {
  resetCSS("css");
  const root = frame({ id: "r", name: "Home" });
  assignSlugs([root], "");
  const mmd = flowMermaid([root]);
  contains(mmd, "graph LR");
  contains(mmd, "No NAVIGATE reactions");
});

t("flowMermaid emits edges for ON_CLICK NAVIGATE reactions", () => {
  resetCSS("css");
  const btn = autoLayout({
    id: "btn", name: "Login Button",
    reactions: [{
      trigger: { type: "ON_CLICK" },
      action: { type: "NODE", navigation: "NAVIGATE", destinationId: "home" },
    }],
  });
  const login = frame({ id: "login", name: "Login", children: [btn] });
  const home = frame({ id: "home", name: "Home" });
  assignSlugs([login, home], "");
  const mmd = flowMermaid([login, home]);
  contains(mmd, "graph LR");
  contains(mmd, "-->");
  contains(mmd, "Login Button");
  contains(mmd, "Home");
});

t("flowMermaid labels edges with source name", () => {
  resetCSS("css");
  const btn = autoLayout({
    id: "btn", name: "Sign Up",
    reactions: [{ trigger: { type: "ON_CLICK" }, action: { type: "NODE", navigation: "NAVIGATE", destinationId: "dash" } }],
  });
  const login = frame({ id: "login", name: "Login", children: [btn] });
  const dash = frame({ id: "dash", name: "Dashboard" });
  assignSlugs([login, dash], "");
  const mmd = flowMermaid([login, dash]);
  contains(mmd, "|Sign Up|");
});

t("flowMermaid sanitizes pipes and quotes in labels", () => {
  resetCSS("css");
  const btn = autoLayout({
    id: "btn", name: 'Weird "Name" | X',
    reactions: [{ trigger: { type: "ON_CLICK" }, action: { type: "NODE", navigation: "NAVIGATE", destinationId: "dash" } }],
  });
  const login = frame({ id: "login", name: "Login", children: [btn] });
  const dash = frame({ id: "dash", name: "Dash" });
  assignSlugs([login, dash], "");
  const mmd = flowMermaid([login, dash]);
  notContains(mmd, '|Weird "Name" | X|'); // raw pipe absent
  contains(mmd, "Weird 'Name' / X"); // sanitized label
});

t("flowMermaid skips reactions without NAVIGATE", () => {
  resetCSS("css");
  const btn = autoLayout({
    id: "btn", name: "Hover",
    reactions: [{ trigger: { type: "ON_HOVER" }, action: { type: "URL", url: "https://x" } }],
  });
  const root = frame({ id: "r", name: "Root", children: [btn] });
  assignSlugs([root], "");
  const mmd = flowMermaid([root]);
  assert(mmd.indexOf("-->") === -1, "no edges emitted: " + mmd);
});

t("buildAgentBundle emits flow.mmd only when reactions exist", () => {
  resetCSS("css");
  const btn = autoLayout({
    id: "btn", name: "Go",
    reactions: [{ trigger: { type: "ON_CLICK" }, action: { type: "NODE", navigation: "NAVIGATE", destinationId: "home" } }],
  });
  const login = frame({ id: "login", name: "Login", children: [btn] });
  const home = frame({ id: "home", name: "Home" });
  const files = buildAgentBundle([login, home], "App");
  assert(files.some(f => f.path === "flow.mmd"), "flow.mmd present");

  resetCSS("css");
  const plain = buildAgentBundle([frame({ id: "p", name: "Page" })], "App");
  assert(!plain.some(f => f.path === "flow.mmd"), "no flow.mmd without reactions");
});

console.log("\n— responsive frameset merger —");

t("stripBreakpointSuffix removes breakpoint tokens", () => {
  assert(stripBreakpointSuffix("Home / Mobile") === "Home");
  assert(stripBreakpointSuffix("Home - Desktop") === "Home");
  assert(stripBreakpointSuffix("Settings (Tablet)") === "Settings");
  assert(stripBreakpointSuffix("Page") === "Page");
});

t("detectBreakpoint recognizes keywords in name", () => {
  assert(detectBreakpoint("Home / Mobile", 375).bp === "mobile");
  assert(detectBreakpoint("Home / Tablet", 768).bp === "tablet");
  assert(detectBreakpoint("Home / Desktop", 1280).bp === "desktop");
});

t("detectBreakpoint falls back to width", () => {
  assert(detectBreakpoint("Home", 320).bp === "mobile");
  assert(detectBreakpoint("Home", 800).bp === "tablet");
  assert(detectBreakpoint("Home", 1440).bp === "desktop");
});

t("groupResponsiveFrames groups by base name", () => {
  resetCSS("css");
  const mob = frame({ id: "m", name: "Home / Mobile", width: 375 });
  const tab = frame({ id: "t", name: "Home / Tablet", width: 768 });
  const dsk = frame({ id: "d", name: "Home / Desktop", width: 1440 });
  const other = frame({ id: "o", name: "Settings / Mobile", width: 375 });
  const groups = groupResponsiveFrames([mob, tab, dsk, other]);
  assert(groups.length === 1, "only Home group (Settings has only one variant)");
  assert(groups[0].baseName === "Home");
  assert(groups[0].variants.length === 3);
  assert(groups[0].variants[0].breakpoint === "mobile", "mobile first");
  assert(groups[0].variants[2].breakpoint === "desktop", "desktop last");
});

t("groupResponsiveFrames ignores singletons", () => {
  const only = frame({ id: "m", name: "Home / Mobile", width: 375 });
  const groups = groupResponsiveFrames([only]);
  assert(groups.length === 0, "single variant is not a group");
});

t("responsiveMd renders media-query guidance", () => {
  resetCSS("css");
  const mob = frame({ id: "m", name: "Home / Mobile", width: 375 });
  const dsk = frame({ id: "d", name: "Home / Desktop", width: 1440 });
  assignSlugs([mob, dsk], "");
  const groups = groupResponsiveFrames([mob, dsk]);
  const md = responsiveMd(groups);
  contains(md, "## Home");
  contains(md, "mobile-first");
  contains(md, "@media (min-width: 1024px)");
});

t("responsiveJson captures structured groups", () => {
  resetCSS("css");
  const mob = frame({ id: "m", name: "Home / Mobile", width: 375 });
  const dsk = frame({ id: "d", name: "Home / Desktop", width: 1440 });
  assignSlugs([mob, dsk], "");
  const groups = groupResponsiveFrames([mob, dsk]);
  const j = JSON.parse(responsiveJson(groups));
  assert(j.groups.length === 1);
  assert(j.groups[0].variants.length === 2);
  assert(j.groups[0].variants[1].minWidth === 1024);
});

t("buildAgentBundle emits responsive.md + responsive.json when groups exist", () => {
  resetCSS("css");
  const mob = frame({ id: "m", name: "Home / Mobile", width: 375 });
  const dsk = frame({ id: "d", name: "Home / Desktop", width: 1440 });
  const files = buildAgentBundle([mob, dsk], "App");
  assert(files.some(f => f.path === "responsive.md"), "responsive.md present");
  assert(files.some(f => f.path === "responsive.json"), "responsive.json present");

  resetCSS("css");
  const single = buildAgentBundle([frame({ id: "x", name: "Home / Mobile", width: 375 })], "App");
  assert(!single.some(f => f.path === "responsive.md"), "no responsive.md without grouping");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
