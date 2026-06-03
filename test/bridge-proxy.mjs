#!/usr/bin/env node
// Regression: a second bridge instance on an already-owned figbridge port must
// ATTACH to it (proxy mode) and forward commands to the shared bridge that owns
// the plugin — not spawn an isolated bridge the plugin can't see. This is the
// permanent fix for the multi-session split-brain.

import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge } from "../mcp/src/bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(__dirname, "..", "mcp", "src", "bridge.js");
const PORT = 7361;

function fail(m) {
  console.error("FAIL", m);
  process.exit(1);
}

// 1. Start the PRIMARY bridge in this process.
const { port, proxy } = await startBridge(PORT, () => {});
if (port !== PORT || proxy) fail(`primary should own ${PORT}, got port=${port} proxy=${proxy}`);

// 2. Attach a fake "plugin": subscribe to /events, auto-reply to any command.
const sse = http.get({ host: "127.0.0.1", port: PORT, path: "/events" }, (res) => {
  let buf = "";
  res.on("data", (c) => {
    buf += c.toString();
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /event: (\w+)/.exec(frame)?.[1];
      const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
      if (ev === "command" && dataLine) {
        const { cmdId, args } = JSON.parse(dataLine.slice(6));
        const body = JSON.stringify({ ok: true, echo: args });
        const rq = http.request(
          { host: "127.0.0.1", port: PORT, path: `/command/${cmdId}/result`, method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } },
          (r) => r.resume(),
        );
        rq.end(body);
      }
    }
  });
});
sse.on("error", () => {});

// Wait for the fake plugin's SSE client to register on the primary.
for (let i = 0; i < 30; i++) {
  await delay(50);
  const h = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()).catch(() => ({}));
  if (h.clients >= 1) break;
}

// 3. CHILD process: import bridge.js, start on the SAME port (→ proxy), then
//    sendCommand. If proxying works it round-trips through the primary to the
//    fake plugin and echoes our args back.
const child = spawn(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import { startBridge, sendCommand, getProxyPort } from ${JSON.stringify(BRIDGE)};
     const r = await startBridge(${PORT}, () => {});
     if (!r.proxy) { console.log(JSON.stringify({ err: "child did not enter proxy mode", r })); process.exit(0); }
     try {
       const res = await sendCommand("ping", { x: 42 }, 4000);
       console.log(JSON.stringify({ proxyPort: getProxyPort(), res }));
     } catch (e) { console.log(JSON.stringify({ err: String(e && e.message || e) })); }
     process.exit(0);`,
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let out = "";
let err = "";
child.stdout.on("data", (c) => (out += c.toString()));
child.stderr.on("data", (c) => (err += c.toString()));
await new Promise((r) => child.on("exit", r));

let parsed;
try {
  parsed = JSON.parse(out.trim().split("\n").pop());
} catch {
  fail(`child produced no parseable output.\nstdout: ${out}\nstderr: ${err}`);
}
if (parsed.err) fail(`child error: ${parsed.err}`);
if (parsed.proxyPort !== PORT) fail(`child proxyPort should be ${PORT}, got ${parsed.proxyPort}`);
if (!parsed.res || parsed.res.ok !== true || parsed.res.echo?.x !== 42) {
  fail(`proxied command did not round-trip through the shared bridge: ${JSON.stringify(parsed.res)}`);
}

console.log("PASS  second instance attaches in proxy mode + command round-trips via the shared bridge.");
sse.destroy();
process.exit(0);
