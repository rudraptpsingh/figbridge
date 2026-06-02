#!/usr/bin/env node
// Regression for doctor: do not kill app-owned MCP transports.

import assert from "node:assert/strict";
import { classifyFigbridgeProcesses } from "../mcp/src/doctor.js";

const ps = `
  100     1 /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled
  200   100 npm exec figbridge-mcp@latest
  201   200 node /Users/rp/.npm/_npx/hash/node_modules/.bin/figbridge-mcp
  300     1 node /Users/rp/.npm/_npx/old/node_modules/.bin/figbridge-mcp
  400     1 npm exec figbridge-mcp@latest
  401   400 node /Users/rp/.npm/_npx/orphan/node_modules/.bin/figbridge-mcp
  500   100 node /Users/rp/.npm/_npx/hash/node_modules/.bin/playwright-mcp
`;

const classified = classifyFigbridgeProcesses(ps);

assert.deepEqual(
  classified.active.map(p => p.pid).sort((a, b) => a - b),
  [200, 201],
  "Codex-owned figbridge processes should be left alone"
);

assert.deepEqual(
  classified.reapable.map(p => p.pid).sort((a, b) => a - b),
  [300, 400, 401],
  "Only orphaned figbridge process trees should be reapable"
);

const forced = classifyFigbridgeProcesses(ps, { force: true });
assert.deepEqual(
  forced.reapable.map(p => p.pid).sort((a, b) => a - b),
  [200, 201, 300, 400, 401],
  "Force mode should include every non-self figbridge process"
);

console.log("PASS  doctor leaves active MCP transports alone.");
