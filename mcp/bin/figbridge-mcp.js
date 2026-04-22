#!/usr/bin/env node
const arg = process.argv[2];

if (arg === "init" || arg === "update") {
  // `update` is an alias for re-running init — re-points Claude Desktop at
  // the npx-launched form so future launches always pull the latest version.
  // This is what users run after we ship a new release.
  const { runInit } = await import("../src/init.js");
  const { reapOrphans } = await import("../src/doctor.js");
  // Reap before rewriting config so the next launch lands on a clean :7331.
  // Quiet: init's own section-3 "Bridge health" reports the result; we don't
  // want raw "[figbridge] reaped N/M" lines bleeding above the pretty header.
  await reapOrphans({ quiet: true });
  runInit({ pin: process.argv.includes("--pin") }).catch((e) => {
    process.stderr.write(`[figbridge] ${arg} failed: ${e && e.stack || e}\n`);
    process.exit(1);
  });
} else if (arg === "doctor") {
  const { runDoctor } = await import("../src/doctor.js");
  runDoctor().catch((e) => {
    process.stderr.write(`[figbridge] doctor failed: ${e && e.stack || e}\n`);
    process.exit(1);
  });
} else if (arg === "--version" || arg === "-v" || arg === "version") {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  process.stdout.write(`${pkg.version}\n`);
} else if (arg === "--help" || arg === "-h" || arg === "help") {
  process.stdout.write(`figbridge-mcp — Free, local MCP bridge for Figma

Usage:
  figbridge-mcp                Start the MCP server (used by Claude Desktop).
  figbridge-mcp init           Wire up Claude Desktop — writes an entry that
                               always pulls the latest version on launch.
  figbridge-mcp init --pin     Pin to the currently installed version
                               (absolute path; no auto-updates).
  figbridge-mcp update         Alias for init — re-run after upgrading
                               figbridge-mcp to rewrite a stale config.
  figbridge-mcp doctor         Reap orphan figbridge-mcp processes holding
                               :7331 (the port-conflict "restarted. failed"
                               case). Also reports bridge health.
  figbridge-mcp --version      Print the installed version.
  figbridge-mcp --help         Show this help.

Docs: https://github.com/rudraptpsingh/figbridge
`);
} else {
  const { main } = await import("../src/server.js");
  main().catch((e) => {
    process.stderr.write(`[figbridge] fatal: ${e && e.stack || e}\n`);
    process.exit(1);
  });
}
