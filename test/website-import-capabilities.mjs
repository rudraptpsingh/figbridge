// Capability audit for modern website import workflows.
//
// This is intentionally static: it checks the public MCP/tool surface and
// local implementation hooks so product positioning stays tied to reality.
//
// Run: node test/website-import-capabilities.mjs

import fs from "node:fs";

const server = fs.readFileSync("mcp/src/server.js", "utf8");
const browser = fs.readFileSync("mcp/src/browser.js", "utf8");
const bridge = fs.readFileSync("mcp/src/bridge.js", "utf8");
const extractor = fs.readFileSync("scripts/dom-to-spec.js", "utf8");
const extensionManifest = fs.existsSync("chrome-extension/manifest.json") ? fs.readFileSync("chrome-extension/manifest.json", "utf8") : "";
const extensionPopup = fs.existsSync("chrome-extension/popup.js") ? fs.readFileSync("chrome-extension/popup.js", "utf8") : "";
const extensionContent = fs.existsSync("chrome-extension/content-capture.js") ? fs.readFileSync("chrome-extension/content-capture.js", "utf8") : "";

function hasTool(name) {
  return new RegExp(`server\\.tool\\(\\s*["']${name}["']`).test(server);
}

const capabilities = [
  {
    name: "URL import",
    expect: () => hasTool("import_url") && /urlToSpec/.test(browser) && /import-url/.test(bridge),
  },
  {
    name: "Preflight import risk audit",
    expect: () => hasTool("preflight_import") && /bot-protection/.test(browser) && /low-res-images/.test(browser),
  },
  {
    name: "Section/root selector import",
    expect: () => /rootSelector/.test(server) && /rootSelector/.test(bridge) && /rootSelector/.test(browser),
  },
  {
    name: "HTML/code paste import",
    expect: () => hasTool("import_from_code") && /htmlPath/.test(server),
  },
  {
    name: "Responsive viewport set",
    expect: () => hasTool("import_responsive_set") && /widths/.test(server),
  },
  {
    name: "Light/dark theme capture",
    expect: () => /colorSchemes/.test(server) && /emulateMediaFeatures/.test(browser),
  },
  {
    name: "Bulk URL import",
    expect: () => hasTool("import_url_batch"),
  },
  {
    name: "Re-import/update shortcut",
    expect: () => /update_from_code/.test(server) && /update: z/.test(server),
  },
  {
    name: "Auto-layout heuristics",
    expect: () => /pickLayout/.test(extractor) && /layoutWrap/.test(extractor),
  },
  {
    name: "MCP/AI workflow",
    expect: () => /new McpServer/.test(server) && hasTool("get_agent_bundle"),
  },
  {
    name: "Visual fidelity tooling",
    expect: () => hasTool("visual_diff") && hasTool("measure_fidelity"),
  },
  {
    name: "Frontend/UI regression audit",
    expect: () => hasTool("audit_regression") && /auditRegression/.test(browser) && /missing-text/.test(browser) && /responsive-regression/.test(browser),
  },
  {
    name: "Private/current-tab capture",
    expect: () => /activeTab/.test(extensionManifest) && /captureVisibleTab/.test(extensionPopup) && /import-from-code/.test(extensionPopup) && /FIGBRIDGE_CAPTURE/.test(extensionContent),
  },
  {
    name: "Hover/focus variant capture",
    expect: () => hasTool("audit_interactions") && /:hover/.test(browser) && /:focus/.test(browser),
    partial: true,
  },
  {
    name: "Generated hover/focus Figma variants",
    expect: () => hasTool("import_interaction_variants") || hasTool("capture_interaction_variants"),
    expectedMissing: true,
  },
  {
    name: "Missing-font download",
    expect: () => /font.*download|download.*font/i.test(server + browser + bridge),
    expectedMissing: true,
  },
];

let failed = 0;
for (const cap of capabilities) {
  const ok = !!cap.expect();
  const status = ok ? (cap.partial ? "PART" : "PASS") : (cap.expectedMissing ? "GAP " : "FAIL");
  console.log(`${status}  ${cap.name}`);
  if (!ok && !cap.expectedMissing) failed++;
}

if (failed) {
  console.error(`\n${failed} required capability check(s) failed.`);
  process.exit(1);
}
