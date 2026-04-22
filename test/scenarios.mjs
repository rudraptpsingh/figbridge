// Real-world agent scenarios — exercise the actual plugin rendering
// pipeline against realistic synthetic Figma trees and validate the output
// is usable by an agent. Runs entirely offline.
//
// Each scenario mirrors a specific prompt a user gives their agent:
//   A. "Implement this login screen" → agent bundle quality
//   B. "Extract design tokens as JSON" → DTCG shape
//   C. "Port to Tailwind" → tailwind HTML quality
//   D. "Merge Mobile/Desktop into responsive CSS" → breakpoint grouping
//   E. "Rebrand — swap orange to green" → recolor MCP surface
//   F. "Bundle the whole file for Claude Code" → large budget
//   G. "Audit a11y" → ISSUES.md in bundle
//   H. "What changed since last export?" → CHANGES.md
//
// Run: node test/scenarios.mjs

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

require(path.join(__dirname, "..", "test-agent", "harness.js"));
const P = require(path.join(__dirname, "..", "test-agent", "code.js"));
const { frame, text, autoLayout } = require(path.join(__dirname, "..", "test-agent", "fixtures.js"));

let passed = 0, failed = 0;
function scenario(title, fn) {
  process.stdout.write("\n▸ " + title + "\n");
  try { fn(); }
  catch (e) { console.error("   ✗ scenario threw:", e.message); failed++; }
}
function check(label, cond, detail) {
  if (cond) { console.log("   ✓ " + label); passed++; }
  else { console.log("   ✗ " + label + (detail ? "\n       " + detail : "")); failed++; }
}

// ── Shared fixture: realistic login screen ───────────────────
function loginScreen() {
  const titleNode = text({ id: "3:6", name: "Title", characters: "Welcome back",
    x: 24, y: 64, width: 300, height: 36, fontSize: 28, fontName: { family: "Inter", style: "Bold" } });
  const emailLabel = text({ id: "3:1", name: "Email", characters: "Email",
    x: 24, y: 120, width: 100, height: 20, fontSize: 14 });
  const emailField = frame({
    id: "3:2", name: "Input/Email", x: 24, y: 144, width: 342, height: 48,
    cornerRadius: 8, fills: [{ type: "SOLID", color: { r: 0.96, g: 0.96, b: 0.96 }, opacity: 1 }],
    children: [text({ id: "3:3", name: "Placeholder", characters: "you@example.com",
      fontSize: 14, x: 16, y: 14, width: 200, height: 20,
      fills: [{ type: "SOLID", color: { r: 0.5, g: 0.5, b: 0.5 }, opacity: 1 }] })]
  });
  const cta = autoLayout({
    id: "3:4", name: "Button/Primary", x: 24, y: 220, width: 342, height: 48,
    cornerRadius: 12, fills: [{ type: "SOLID", color: { r: 1.0, g: 0.478, b: 0.161 }, opacity: 1 }],
    paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, itemSpacing: 8,
    children: [text({ id: "3:5", name: "Label", characters: "Sign in",
      fontSize: 16, fontName: { family: "Inter", style: "Bold" },
      fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }] })]
  });
  return frame({
    id: "2:0", name: "Login", width: 390, height: 844,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
    children: [titleNode, emailLabel, emailField, cta]
  });
}

// ── A. "Implement the login screen" ──────────────────────────
scenario("A. 'Implement this login screen in React' → agent bundle quality", () => {
  const root = loginScreen();
  P.resetCSS("css"); P.setVariableMap({}); P.setAssetCache({});
  const bundle = P.buildAgentBundle([root], "Login", { budget: "medium", screenshots: false });
  const byPath = Object.fromEntries(bundle.map((f) => [f.path, f.data]));

  const paths = bundle.map((f) => f.path);
  ["hierarchy.md","components.json","tokens.json","tokens.css","DESIGN.md","AGENTS.md","manifest.json","ISSUES.md"]
    .forEach((p) => check("bundle includes " + p, paths.includes(p)));

  const hier = byPath["hierarchy.md"] || "";
  check("hierarchy uses the 'login' page slug", /login/i.test(hier));
  check("hierarchy references the button layer", /button/i.test(hier));
  check("hierarchy references the input layer",  /input/i.test(hier));

  const manifest = JSON.parse(byPath["manifest.json"] || "{}");
  check("manifest lists every bundled file",
        Array.isArray(manifest.files) && manifest.files.length >= 8,
        "files: " + (manifest.files || []).length);
  check("every manifest entry has a content hash",
        (manifest.files || []).every((f) => typeof f.hash === "string" && f.hash.length > 0));
  check("every manifest entry has tokens_est",
        (manifest.files || []).every((f) => typeof f.tokens_est === "number"));
  check("manifest has tokens_est_total",
        typeof manifest.tokens_est_total === "number" && manifest.tokens_est_total > 0);

  const agents = byPath["AGENTS.md"] || "";
  check("AGENTS.md mentions slugs or components",
        /slug|component/i.test(agents));
});

// ── B. "Extract design tokens" ───────────────────────────────
scenario("B. 'Extract the design tokens as JSON' → DTCG shape", () => {
  P.resetCSS("css");
  // Shape matches what loadVariables() produces: id → { name, type, value, cssName, modes? }
  const varMap = {
    v1: { name: "brand/primary", type: "color",     value: "#ff7a29", cssName: "--brand-primary" },
    v2: { name: "spacing/md",    type: "dimension", value: "16px",    cssName: "--spacing-md" }
  };
  P.setVariableMap(varMap);
  const tokensStr = P.buildTokensJSON(varMap);
  const tokens    = JSON.parse(tokensStr);
  check("tokens.json has a 'brand' namespace",
        !!tokens.brand,
        "top-level keys: " + Object.keys(tokens).join(","));
  check("brand.primary is DTCG-shaped",
        tokens.brand && tokens.brand.primary &&
        tokens.brand.primary["$value"] === "#ff7a29" &&
        tokens.brand.primary["$type"] === "color");
  check("spacing.md carries a dimension value",
        tokens.spacing && tokens.spacing.md && /16/.test(String(tokens.spacing.md["$value"])));
});

// ── C. "Port to Tailwind" ────────────────────────────────────
scenario("C. 'Give me Tailwind utilities instead of CSS'", () => {
  const root = loginScreen();
  P.resetCSS("tailwind"); P.setVariableMap({}); P.setAssetCache({});
  const out = P.buildOutput([root], "Login");
  check("tailwind output is non-empty",                 out.html && out.html.length > 100);
  check("uses Tailwind arbitrary-value utilities",      /\b(w|h|p|px|py|top|left)-\[/.test(out.html),
        "sample: " + (out.rawHtml || out.html).slice(0, 200));
  check("no raw inline style= attributes on layers",    !/ style="(width|height|padding)/.test(out.rawHtml || ""));
  check("includes the 'Sign in' CTA text",              /Sign in/.test(out.html));
  check("body uses class= (not className=) in preview", /class=/.test(out.html));
});

// ── D. "Responsive breakpoints" ──────────────────────────────
scenario("D. 'Merge Mobile/Desktop variants into one responsive component'", () => {
  const mobile  = frame({ id: "m:1", name: "Home / Mobile",  width: 390,  height: 844 });
  const desktop = frame({ id: "d:1", name: "Home / Desktop", width: 1440, height: 900 });
  const groups  = P.groupResponsiveFrames([mobile, desktop]);
  check("groups matched pair by base name",
        Array.isArray(groups) && groups.length === 1,
        "groups=" + JSON.stringify(groups).slice(0, 200));
  check("group has both breakpoints",
        groups[0] && groups[0].variants && groups[0].variants.length === 2);
  const md = P.responsiveMd(groups);
  check("responsive.md is non-empty",                    md && md.length > 0);
  check("responsive.md mentions 'Home' group",           /Home/.test(md));
  check("responsive.md lists mobile breakpoint",         /mobile/i.test(md));
  check("responsive.md lists desktop breakpoint",        /desktop/i.test(md));
});

// ── E. "Rebrand swap orange → green" ─────────────────────────
scenario("E. 'Recolor brand from orange to green' → MCP surface exists", () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, "..", "mcp", "src", "server.js"), "utf8");
  const pluginSrc = fs.readFileSync(path.join(__dirname, "..", "plugin", "code.js"), "utf8");
  check("MCP registers recolor tool",                  /server\.tool\(\s*"recolor"/.test(serverSrc));
  check("MCP schema accepts mapping: hex→hex",         /mapping.*hex/i.test(serverSrc));
  check("plugin implements recolor action",            /action === "recolor"/.test(pluginSrc));
  check("plugin recolor walks SOLID fills",            /function recolor/.test(pluginSrc) && /SOLID/.test(pluginSrc));
});

// ── F. "Full-file handoff at large budget" ───────────────────
scenario("F. 'Bundle the whole file for Claude Code' → budget=large", () => {
  const root = loginScreen();
  P.resetCSS("css"); P.setVariableMap({
    v1: { name: "brand/primary", type: "color", value: "#ff7a29", cssName: "--brand-primary" }
  });
  P.setAssetCache({});
  const bundle = P.buildAgentBundle([root], "Login", { budget: "large", screenshots: false });
  const paths  = bundle.map((f) => f.path);
  ["hierarchy.md","components.json","tokens.json","tokens.css","DESIGN.md","AGENTS.md",
   "manifest.json","ISSUES.md","issues.json","snapshot.json"]
    .forEach((p) => check("large bundle includes " + p, paths.includes(p)));

  const manifest = JSON.parse(bundle.find((f) => f.path === "manifest.json").data);
  check("manifest reports nonzero total tokens",        manifest.tokens_est_total > 0,
        "total=" + manifest.tokens_est_total);
  check("large bundle total within 128k tokens",        manifest.tokens_est_total <= 128_000);

  // Sanity: tokens.json actually references the brand color
  const toks = bundle.find((f) => f.path === "tokens.json").data;
  check("tokens.json includes #ff7a29", /ff7a29/i.test(toks));
});

// ── G. "A11y audit" ──────────────────────────────────────────
scenario("G. 'Audit this for a11y issues' → auditA11y + ISSUES.md", () => {
  const badText = text({ id: "t:1", name: "Hint", characters: "Small print",
    fontSize: 10,
    fills: [{ type: "SOLID", color: { r: 0.85, g: 0.85, b: 0.85 }, opacity: 1 }] });
  const bg = frame({ id: "f:1", name: "Screen", width: 390, height: 200,
    fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
    children: [badText] });
  P.resetCSS("css"); P.assignSlugs([bg], "");
  const issues = P.auditA11y([bg]);
  check("auditA11y returns an array",                  Array.isArray(issues));
  check("finds the low-contrast issue",
        issues.some((i) => /contrast/i.test(i.type + " " + i.message)),
        "issues: " + JSON.stringify(issues).slice(0, 200));

  const md = P.issuesMd(issues);
  check("ISSUES.md is non-empty when issues exist",    md && md.length > 0);
  check("ISSUES.md mentions 'contrast'",               /contrast/i.test(md));
});

// ── H. "Diff since last export" ──────────────────────────────
scenario("H. 'What changed since last export?' → snapshot diff", () => {
  P.resetCSS("css");
  const a = frame({ id: "x:1", name: "Home", width: 390, height: 844,
    children: [text({ id: "x:2", name: "Title", characters: "Welcome" })] });
  P.assignSlugs([a], ""); const snap1 = P.buildSnapshot([a]);

  P.resetCSS("css");
  const b = frame({ id: "x:1", name: "Home", width: 390, height: 844,
    children: [text({ id: "x:2", name: "Title", characters: "Welcome back" })] });
  P.assignSlugs([b], ""); const snap2 = P.buildSnapshot([b]);

  const diff = P.diffSnapshots(snap1, snap2);
  check("diff reports at least one changed entry",
        (diff.added && diff.added.length) + (diff.removed && diff.removed.length) + (diff.changed && diff.changed.length) > 0,
        "diff=" + JSON.stringify(diff).slice(0, 200));

  const md = P.changesMd(diff);
  check("CHANGES.md is non-empty",                     md && md.length > 0);
  check("CHANGES.md references the new text",
        /Welcome back|Title|changed|text/i.test(md),
        "snippet: " + md.slice(0, 200));
});

// ── Report ───────────────────────────────────────────────────
process.stdout.write("\n" + passed + " passed, " + failed + " failed across 8 real-world scenarios\n");
process.exit(failed ? 1 : 0);
