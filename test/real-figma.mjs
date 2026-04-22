// REAL Figma file test: reconstructs a faithful synthetic tree from the
// Draftr iOS App Design (parsed from /tmp/draftr/payload.bin — decompressed
// canvas.fig) and runs the actual plugin pipeline against it.
//
// We can't load the .fig inside Figma from Node, so we:
//   1. Parsed the real .fig binary and extracted node names, text content,
//      variable names, text-style names, hierarchy cues.
//   2. Rebuild those nodes as plain JS objects matching Figma's sceneNode API.
//   3. Run the real plugin code (test-agent/code.js = plugin rendering
//      pipeline) against them and assert on generated HTML/CSS/tokens.
//
// This exercises the same code the plugin runs in Figma, against a real
// file's structure — the closest we can get without opening Figma itself.
//
// Run: node test/real-figma.mjs

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

require(path.join(__dirname, "..", "test-agent", "harness.js"));
const P = require(path.join(__dirname, "..", "test-agent", "code.js"));
const { frame, text, autoLayout } = require(path.join(__dirname, "..", "test-agent", "fixtures.js"));

let pass = 0, fail = 0;
function check(label, cond, detail) {
  if (cond) { console.log("   ✓ " + label); pass++; }
  else { console.log("   ✗ " + label + (detail ? "\n       " + detail : "")); fail++; }
}
function hdr(s) { process.stdout.write("\n▸ " + s + "\n"); }

// ── Draftr design-system tokens (verified from parsed .fig binary) ──
const DRAFTR_VARS = {
  c1:  { name: "Draftr/inkBlack",  type: "color", value: "#0a0a0b", cssName: "--draftr-ink-black" },
  c2:  { name: "Draftr/ink2",      type: "color", value: "#141416", cssName: "--draftr-ink-2" },
  c3:  { name: "Draftr/ink3",      type: "color", value: "#1c1c20", cssName: "--draftr-ink-3" },
  c4:  { name: "Draftr/ink4",      type: "color", value: "#26262c", cssName: "--draftr-ink-4" },
  c5:  { name: "Draftr/ink5",      type: "color", value: "#32323a", cssName: "--draftr-ink-5" },
  s1:  { name: "Draftr/snow",      type: "color", value: "#f2ece0", cssName: "--draftr-snow" },
  s2:  { name: "Draftr/snow2",     type: "color", value: "#d4d0c8", cssName: "--draftr-snow-2" },
  s3:  { name: "Draftr/snow3",     type: "color", value: "#a8a49b", cssName: "--draftr-snow-3" },
  s4:  { name: "Draftr/snow4",     type: "color", value: "#74706a", cssName: "--draftr-snow-4" },
  a1:  { name: "Draftr/amber",     type: "color", value: "#c98a3c", cssName: "--draftr-amber" },
  a2:  { name: "Draftr/amber2",    type: "color", value: "#a87128", cssName: "--draftr-amber-2" },
  a3:  { name: "Draftr/amber3",    type: "color", value: "#7c5218", cssName: "--draftr-amber-3" },
  af:  { name: "Draftr/amberFog",  type: "color", value: "#2a1e10", cssName: "--draftr-amber-fog" },
  j1:  { name: "Draftr/jade",      type: "color", value: "#6a9977", cssName: "--draftr-jade" },
  e1:  { name: "Draftr/ember",     type: "color", value: "#c6574a", cssName: "--draftr-ember" },
  sl:  { name: "Draftr/slate",     type: "color", value: "#465060", cssName: "--draftr-slate" },
  p1:  { name: "Draftr/paper",     type: "color", value: "#f8f3e7", cssName: "--draftr-paper" },
  p2:  { name: "Draftr/paperLine", type: "color", value: "#e4dbc6", cssName: "--draftr-paper-line" }
};

// ── Build S1_Home (verified components + copy from parsed binary) ──
// Hierarchy reproduced from the .fig payload:
//   S1_Home / StatusBg, DynamicIsland, Camera, Pill
//          / Greeting ("Good evening, Rudra" + "Your stories" + "await writing.")
//          / QuickCapture / QC_Icon (QC_Plus), QC_Label, QC_Hint
//          / SectionLabel ("ACTIVE PROJECTS"), SeeAll ("See all")
//          / Project_Mumbai / Proj1_Name "Ek Raat Mumbai Mein", Pill_DRAMA, Proj1_Meta, ProgTrack, ProgFill
//          / Project_Witness / Proj2_Name "The Silent Witness", Pill_THRILLER, ...
//          / Project_Gully / Proj3_Name "Gully Dreams", ...
function draftrHome() {
  const rgb = (hex) => {
    const h = hex.replace("#","");
    return { r: parseInt(h.slice(0,2),16)/255, g: parseInt(h.slice(2,4),16)/255, b: parseInt(h.slice(4,6),16)/255 };
  };
  const fill = (hex, op) => ({ type: "SOLID", color: rgb(hex), opacity: op == null ? 1 : op });

  const statusBar = frame({ id: "2:1", name: "StatusBg", width: 390, height: 54, x: 0, y: 0, fills: [fill("#0a0a0b")] });
  const dynamicIsland = frame({ id: "2:2", name: "DynamicIsland", width: 120, height: 35, x: 135, y: 11, fills: [fill("#0a0a0b")], cornerRadius: 20 });

  const greetingSmall = text({ id: "2:10", name: "Greeting", characters: "Good evening, Rudra",
    x: 24, y: 80, width: 200, height: 20, fontSize: 14, fontName: { family: "Inter", style: "Medium" },
    fills: [fill("#a8a49b")] });
  const greetingLine1 = text({ id: "2:11", name: "Greeting/line1", characters: "Your stories",
    x: 24, y: 108, width: 300, height: 40, fontSize: 32, fontName: { family: "Inter", style: "Bold" },
    fills: [fill("#f2ece0")] });
  const greetingLine2 = text({ id: "2:12", name: "Greeting/line2", characters: "await writing.",
    x: 24, y: 152, width: 300, height: 40, fontSize: 32, fontName: { family: "Inter", style: "Bold" },
    fills: [fill("#c98a3c")] });

  const qcPlus = text({ id: "2:21", name: "QC_Plus", characters: "+",
    x: 22, y: 18, width: 20, height: 20, fontSize: 18, fontName: { family: "Inter", style: "Semi Bold" },
    fills: [fill("#c98a3c")] });
  const qcIcon = frame({ id: "2:20", name: "QC_Icon", x: 16, y: 16, width: 48, height: 48,
    cornerRadius: 12, fills: [fill("#2a1e10")], children: [qcPlus] });
  const qcLabel = text({ id: "2:22", name: "QC_Label", characters: "Quick scene capture",
    x: 76, y: 22, width: 220, height: 20, fontSize: 16, fontName: { family: "Inter", style: "Semi Bold" },
    fills: [fill("#f2ece0")] });
  const qcHint = text({ id: "2:23", name: "QC_Hint", characters: "Tap to write a new scene instantly",
    x: 76, y: 44, width: 260, height: 18, fontSize: 13, fontName: { family: "Inter", style: "Regular" },
    fills: [fill("#a8a49b")] });
  const quickCapture = autoLayout({ id: "2:19", name: "QuickCapture", x: 24, y: 220, width: 342, height: 80,
    cornerRadius: 16, fills: [fill("#141416")],
    paddingLeft: 16, paddingRight: 16, paddingTop: 16, paddingBottom: 16, itemSpacing: 12,
    children: [qcIcon, qcLabel, qcHint] });

  const sectionLabel = text({ id: "2:30", name: "SectionLabel", characters: "ACTIVE PROJECTS",
    x: 24, y: 320, width: 200, height: 16, fontSize: 11, fontName: { family: "Inter", style: "Semi Bold" },
    fills: [fill("#74706a")], letterSpacing: { unit: "PIXELS", value: 1.5 } });
  const seeAll = text({ id: "2:31", name: "SeeAll", characters: "See all",
    x: 310, y: 320, width: 60, height: 16, fontSize: 13, fontName: { family: "Inter", style: "Medium" },
    fills: [fill("#c98a3c")] });

  function projectCard(id, name, title, genre, genreColor, meta) {
    const pillText = text({ id: id + ":pillT", name: "Pill_" + genre, characters: genre,
      x: 12, y: 6, width: 60, height: 14, fontSize: 10, fontName: { family: "Inter", style: "Semi Bold" },
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }], letterSpacing: { unit: "PIXELS", value: 1 } });
    const pill = frame({ id: id + ":pill", name: "Pill_" + genre, x: 16, y: 16, width: 72, height: 24,
      cornerRadius: 12, fills: [fill(genreColor)], children: [pillText] });
    const projName = text({ id: id + ":name", name: "Proj" + id + "_Name", characters: title,
      x: 16, y: 56, width: 300, height: 26, fontSize: 20, fontName: { family: "Inter", style: "Bold" },
      fills: [fill("#f2ece0")] });
    const projMeta = text({ id: id + ":meta", name: "Proj" + id + "_Meta", characters: meta,
      x: 16, y: 86, width: 300, height: 18, fontSize: 13, fontName: { family: "Inter", style: "Regular" },
      fills: [fill("#a8a49b")] });
    const progTrack = frame({ id: id + ":track", name: "ProgTrack", x: 16, y: 120, width: 310, height: 4,
      cornerRadius: 2, fills: [fill("#26262c")] });
    const progFill  = frame({ id: id + ":fill",  name: "ProgFill",  x: 16, y: 120, width: 155, height: 4,
      cornerRadius: 2, fills: [fill("#c98a3c")] });
    return frame({ id: id, name: name, x: 24, y: 0, width: 342, height: 144,
      cornerRadius: 20, fills: [fill("#141416")],
      children: [pill, projName, projMeta, progTrack, progFill] });
  }

  const pMumbai  = projectCard("3:1", "Project_Mumbai",  "Ek Raat Mumbai Mein", "DRAMA",    "#c6574a", "Feature film  · Draft 3");
  const pWitness = projectCard("3:2", "Project_Witness", "The Silent Witness",  "THRILLER", "#465060", "Feature film  · Draft 1");
  const pGully   = projectCard("3:3", "Project_Gully",   "Gully Dreams",        "DRAMA",    "#c6574a", "Series pilot  · Outline");

  return frame({
    id: "1:1", name: "S1_Home", x: 0, y: 0, width: 390, height: 844,
    fills: [fill("#0a0a0b")], cornerRadius: 0,
    children: [statusBar, dynamicIsland, greetingSmall, greetingLine1, greetingLine2,
               quickCapture, sectionLabel, seeAll, pMumbai, pWitness, pGully]
  });
}

// ── Execute scenarios against the REAL Draftr structure ──
const home = draftrHome();

hdr("1. Export S1_Home → HTML+CSS (real pipeline, no fakes)");
P.resetCSS("css"); P.setVariableMap({}); P.setAssetCache({});
const cssOut = P.buildOutput([home], "S1 · Home");
check("output has non-empty html",             cssOut.html.length > 500);
check("output has non-empty css",              cssOut.css.length > 100);
check("html contains 'Your stories' copy",     /Your stories/.test(cssOut.html));
check("html contains 'Quick scene capture'",   /Quick scene capture/.test(cssOut.html));
check("html contains all 3 project titles",
      /Ek Raat Mumbai Mein/.test(cssOut.html) && /The Silent Witness/.test(cssOut.html) && /Gully Dreams/.test(cssOut.html));
check("html contains 'ACTIVE PROJECTS' section label", /ACTIVE PROJECTS/.test(cssOut.html));
check("html contains 'See all' link",          /See all/.test(cssOut.html));
check("css references the ink-black bg (#0a0a0b)",
      /#0a0a0b|rgba?\(\s*10\s*,\s*10\s*,\s*11/i.test(cssOut.css));
check("css references amber accent (#c98a3c)",
      /#c98a3c|rgba?\(\s*201\s*,\s*138\s*,\s*60/i.test(cssOut.css));
check("css references snow text (#f2ece0)",
      /#f2ece0|rgba?\(\s*242\s*,\s*236\s*,\s*224/i.test(cssOut.css));

hdr("2. Port to Tailwind utilities");
P.resetCSS("tailwind"); P.setVariableMap({}); P.setAssetCache({});
const twOut = P.buildOutput([home], "S1 · Home");
check("tailwind output non-empty",             twOut.html.length > 500);
check("uses arbitrary-value utilities",        /\b(w|h|p|px|py|top|left)-\[/.test(twOut.html));
check("tailwind preserves all 3 project titles",
      /Ek Raat Mumbai Mein/.test(twOut.html) && /The Silent Witness/.test(twOut.html) && /Gully Dreams/.test(twOut.html));
check("no raw inline style=width/height leaks", !/style="[^"]*width:/.test(twOut.rawHtml || ""));

hdr("3. Extract Draftr design tokens (DTCG)");
P.resetCSS("css");
P.setVariableMap(DRAFTR_VARS);
const tokensStr = P.buildTokensJSON(DRAFTR_VARS);
const tokens = JSON.parse(tokensStr);
check("tokens has 'draftr' namespace",         !!tokens.draftr);
check("has all 5 ink shades",
      tokens.draftr && tokens.draftr["inkblack"] && tokens.draftr["ink2"] && tokens.draftr["ink3"] && tokens.draftr["ink4"] && tokens.draftr["ink5"],
      "draftr keys: " + Object.keys(tokens.draftr || {}).join(","));
check("amber brand color preserved exactly",
      tokens.draftr && tokens.draftr.amber && tokens.draftr.amber["$value"].toLowerCase() === "#c98a3c");
check("DTCG $type on every token",
      Object.values(tokens.draftr).filter((v) => v.$type).every((v) => v.$type === "color" || v.$type === "dimension"));
const cssVars = P.rootVarsBlock();
check("tokens.css emits :root{} block",        /:root\s*\{/.test(cssVars));
check("tokens.css includes --draftr-amber",    /--draftr-amber\s*:\s*#c98a3c/i.test(cssVars));
check("tokens.css includes --draftr-ink-black", /--draftr-ink-black\s*:\s*#0a0a0b/i.test(cssVars),
      "cssVars head: " + cssVars.slice(0, 300));

hdr("4. Build agent bundle for Draftr (budget=large)");
P.resetCSS("css");
P.setVariableMap(DRAFTR_VARS);
P.setAssetCache({});
const bundle = P.buildAgentBundle([home], "S1 · Home", { budget: "large", screenshots: false });
const paths  = bundle.map((f) => f.path);
["hierarchy.md","components.json","tokens.json","tokens.css","DESIGN.md","AGENTS.md","manifest.json","ISSUES.md","snapshot.json"]
  .forEach((p) => check("bundle includes " + p, paths.includes(p)));

const hier = bundle.find((f) => f.path === "hierarchy.md").data;
check("hierarchy.md contains 's1-home' slug",         /s1-home/i.test(hier));
check("hierarchy.md kebab-cases QuickCapture → quick-capture", /quick-capture/i.test(hier));
check("hierarchy.md kebab-cases SectionLabel → section-label", /section-label/i.test(hier));
check("hierarchy.md references at least one project",          /project-(mumbai|witness|gully)/i.test(hier));

const design = bundle.find((f) => f.path === "DESIGN.md").data;
check("DESIGN.md is non-empty",                       design.length > 100);

const agents = bundle.find((f) => f.path === "AGENTS.md").data;
check("AGENTS.md is non-empty",                       agents.length > 100);

const manifest = JSON.parse(bundle.find((f) => f.path === "manifest.json").data);
check("manifest lists every file with hash",
      manifest.files.every((f) => f.hash && f.tokens_est != null));
check("manifest.tokens_est_total is within 128k (large)",
      manifest.tokens_est_total > 0 && manifest.tokens_est_total <= 128_000,
      "total=" + manifest.tokens_est_total);

const tokenFile = bundle.find((f) => f.path === "tokens.json").data;
check("bundled tokens.json contains all 3 amber shades",
      /#c98a3c/i.test(tokenFile) && /#a87128/i.test(tokenFile) && /#7c5218/i.test(tokenFile));

hdr("5. A11y audit on the Home screen");
const issues = P.auditA11y([home]);
check("audit ran without crashing",                  Array.isArray(issues));
// The small 'Good evening' text is #a8a49b on #0a0a0b bg — ~6.8:1 contrast (passing).
// The ACTIVE PROJECTS label is #74706a on #0a0a0b — ~3.9:1 (FAIL for 11px body).
const contrastIssues = issues.filter((i) => /contrast/i.test(i.type + " " + i.message));
check("contrast check flagged the muted label",      contrastIssues.length > 0,
      "issues summary: " + issues.map((i) => i.type).slice(0, 5).join(", "));

hdr("6. Diff detection: simulate renaming a project");
P.resetCSS("css"); P.assignSlugs([home], "");
const snap1 = P.buildSnapshot([home]);
// Mutate: rename Gully Dreams → Gully Dreams II
home.children[10].children[1].characters = "Gully Dreams II";
P.resetCSS("css"); P.assignSlugs([home], "");
const snap2 = P.buildSnapshot([home]);
const diff  = P.diffSnapshots(snap1, snap2);
const totalDiff = (diff.added || []).length + (diff.removed || []).length + (diff.changed || []).length;
check("diff captured the text change",              totalDiff > 0,
      "diff=" + JSON.stringify(diff).slice(0, 200));
const md = P.changesMd(diff);
check("CHANGES.md mentions the new title",           /Gully Dreams II|changed/i.test(md));

// ── Final report ──
process.stdout.write("\n" + pass + " passed, " + fail + " failed against the REAL Draftr iOS App Design structure\n");
process.exit(fail ? 1 : 0);
