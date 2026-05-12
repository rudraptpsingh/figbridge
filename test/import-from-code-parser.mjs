// Unit test for the HTML → spec parser inside plugin/code.js.
// The parser helpers (_ifcHtmlToSpec, _ifcParseStyle, _ifcColor, _ifcPx,
// _ifcAttr, _ifcDecode) are pure functions. We load them into a vm
// sandbox alongside the existing hex helpers they don't actually depend
// on, and assert the mapping.
//
// Run: node test/import-from-code-parser.mjs

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import vm from "node:vm";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(__dirname, "..", "plugin", "code.js"), "utf8");

function ok(m) { process.stdout.write("  ✓ " + m + "\n"); }
function fail(m) { console.error("✗", m); process.exit(1); }

function extract(name) {
  // Match `function NAME(...) { ... }` with a brace-balanced body.
  const i = SRC.indexOf("function " + name + "(");
  if (i < 0) throw new Error("not found: " + name);
  let depth = 0, start = SRC.indexOf("{", i), j = start;
  if (start < 0) throw new Error("no body: " + name);
  for (; j < SRC.length; j++) {
    const c = SRC[j];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) { j++; break; } }
  }
  return SRC.slice(i, j);
}

const fnNames = [
  "_ifcHtmlToSpec",
  "_ifcAttr",
  "_ifcDecode",
  "_ifcParseStyle",
  "_ifcColor",
  "_ifcPx",
];

const code = fnNames.map(extract).join("\n\n");
const sandbox = { module: {}, console };
vm.createContext(sandbox);
vm.runInContext(code + "\nmodule.exports = { _ifcHtmlToSpec, _ifcParseStyle, _ifcColor, _ifcPx };", sandbox);
const { _ifcHtmlToSpec, _ifcParseStyle, _ifcColor, _ifcPx } = sandbox.module.exports;

// ── px / color helpers ───────────────────────────────────────
if (_ifcPx("24px") !== 24) fail("_ifcPx 24px");
if (_ifcPx("1.5rem") !== 1.5) fail("_ifcPx rem fallback");
if (_ifcPx("auto") !== null) fail("_ifcPx auto");
ok("_ifcPx handles px/rem/auto");

if (_ifcColor("#abc") !== "#abc") fail("_ifcColor hex shorthand");
if (_ifcColor("rgb(255, 122, 41)") !== "#ff7a29") fail("_ifcColor rgb()");
if (_ifcColor("rgba(0, 0, 0, 0.5)") !== "#000000") fail("_ifcColor rgba()");
ok("_ifcColor parses hex/rgb/rgba");

// ── style parser ─────────────────────────────────────────────
const s = _ifcParseStyle("background: #ff7a29; padding: 24px; gap: 12px; display: flex; flex-direction: row; border-radius: 8px; color: rgb(255,255,255); font-size: 18px; font-weight: 700");
if (s.background !== "#ff7a29") fail("style background");
if (s.padding !== 24) fail("style padding");
if (s.gap !== 12) fail("style gap");
if (s.display !== "flex") fail("style display");
if (s.flexDirection !== "row") fail("style flex-direction");
if (s.borderRadius !== 8) fail("style border-radius");
if (s.color !== "#ffffff") fail("style color");
if (s.fontSize !== 18) fail("style font-size");
if (s.fontWeight !== "700") fail("style font-weight");
ok("_ifcParseStyle covers common props");

// ── html → spec: basic ───────────────────────────────────────
const warnings = [];
const spec = _ifcHtmlToSpec(`<html>
  <head><title>Landing</title></head>
  <body>
    <header style="background:#0f172a; padding:24px; display:flex; flex-direction:row; gap:16px">
      <h1 style="color:#ffffff; font-size:32px">Hi</h1>
      <button style="background:#22c55e; color:#ffffff; padding:12px; border-radius:8px">Get started</button>
    </header>
    <section><p>Body copy</p></section>
  </body>
</html>`, warnings);

if (spec.type !== "frame") fail("root not frame");
if (spec.name !== "Landing") fail("title not picked up: " + spec.name);
if (!Array.isArray(spec.children) || spec.children.length < 2) fail("missing top-level kids");

const header = spec.children.find(c => c.name === "header");
if (!header) fail("no <header> child");
if (header.layout !== "HORIZONTAL") fail("header layout: " + header.layout);
if (header.padding !== 24) fail("header padding: " + header.padding);
if (header.spacing !== 16) fail("header gap: " + header.spacing);
if (header.fill !== "#0f172a") fail("header bg: " + header.fill);

const h1 = header.children.find(c => c.name === "h1");
if (!h1) fail("no h1");
if (h1.type !== "text") fail("h1 not text");
if (h1.characters !== "Hi") fail("h1 chars: " + h1.characters);
if (h1.fontSize !== 32) fail("h1 fontSize: " + h1.fontSize);

const btn = header.children.find(c => c.name === "button");
if (!btn || btn.type !== "text" || btn.characters !== "Get started") fail("button text");

ok("HTML → spec maps semantic tags, inline styles, and titles");

// ── html → spec: text decoding + nesting ─────────────────────
const spec2 = _ifcHtmlToSpec(`<body><div><span>A &amp; B</span></div></body>`, warnings);
const div = spec2.children[0];
if (!div || div.type !== "frame") fail("no top div");
const span = div.children[0];
if (!span || span.type !== "text" || span.characters !== "A & B") fail("entity decode: " + (span && span.characters));
ok("entities decoded, nested div → frame, span → text");

process.stdout.write("• HTML → spec parser unit tests passed\n");
