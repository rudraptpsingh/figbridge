#!/usr/bin/env node
const arg = process.argv[2];

if (arg === "init") {
  const { runInit } = await import("../src/init.js");
  runInit().catch((e) => {
    process.stderr.write(`[figbridge] init failed: ${e && e.stack || e}\n`);
    process.exit(1);
  });
} else if (arg === "--help" || arg === "-h" || arg === "help") {
  process.stdout.write(`figbridge-mcp — Free, local MCP bridge for Figma

Usage:
  figbridge-mcp            Start the MCP server (used by Claude Desktop).
  figbridge-mcp init       Wire up Claude Desktop + print plugin install steps.
  figbridge-mcp --help     Show this help.

Docs: https://github.com/rudraptpsingh/figbridge
`);
} else {
  const { main } = await import("../src/server.js");
  main().catch((e) => {
    process.stderr.write(`[figbridge] fatal: ${e && e.stack || e}\n`);
    process.exit(1);
  });
}
