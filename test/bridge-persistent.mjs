#!/usr/bin/env node
// Regression: bridge-only mode must stay alive after stdin closes.

import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, "..", "mcp", "bin", "figbridge-mcp.js");
const PORT = 7357;

function fail(msg) {
  console.error("FAIL", msg);
  process.exit(1);
}

async function waitForHealth() {
  for (let i = 0; i < 30; i++) {
    await delay(100);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (res.ok) return res.json();
    } catch {}
  }
  return null;
}

const child = spawn("node", [BIN, "bridge"], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, FIGBRIDGE_PORT: String(PORT) }
});

let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

try {
  const initial = await waitForHealth();
  if (!initial?.ok) fail(`bridge did not start\n${stderr}`);

  child.stdin.end();
  await delay(300);

  if (child.exitCode !== null) {
    fail(`bridge-only process exited after stdin close with code ${child.exitCode}\n${stderr}`);
  }

  const afterStdinClose = await waitForHealth();
  if (!afterStdinClose?.ok) fail(`bridge stopped responding after stdin close\n${stderr}`);

  child.kill("SIGTERM");
  console.log("PASS  bridge-only mode persists after stdin close.");
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
}
