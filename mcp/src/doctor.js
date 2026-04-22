// Doctor — reap orphan figbridge-mcp processes and report bridge health.
//
// Why this exists: Claude Desktop respawns the MCP server aggressively
// (every time the app starts, sometimes mid-session on config reload).
// If a previous instance didn't exit cleanly — crashed, killed mid-run,
// or stdin-close handler didn't fire — it still holds :7331. The new
// instance then falls back to :7332 (plugin auto-probes), but we've
// leaked a zombie. After a few restarts you've got half a dozen node
// processes sitting around. This command finds them and kills them.

import { execFile as _execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
const execFile = promisify(_execFile);

const SELF_PID = process.pid;

async function listFigbridgeProcesses() {
  // `ps -axo pid=,ppid=,command=` works on macOS + Linux. We pick out
  // the ones running figbridge-mcp (either the bin or bin/figbridge-mcp.js).
  const { stdout } = await execFile("ps", ["-axo", "pid=,ppid=,command="]);
  const procs = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    const [, pidStr, ppidStr, cmd] = m;
    if (!/figbridge-mcp(\.js)?(\s|$)/.test(cmd) && !/bin\/figbridge-mcp/.test(cmd)) continue;
    // Skip doctor itself and grep/ps noise
    if (/\bgrep\b|\bps\b/.test(cmd)) continue;
    const pid = Number(pidStr);
    if (pid === SELF_PID) continue;
    procs.push({ pid, ppid: Number(ppidStr), cmd: cmd.trim() });
  }
  return procs;
}

function probeHealth(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: timeoutMs }, (res) => {
      let buf = "";
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        try { resolve({ port, ok: true, body: JSON.parse(buf) }); }
        catch { resolve({ port, ok: false }); }
      });
    });
    req.on("error", () => resolve({ port, ok: false }));
    req.on("timeout", () => { req.destroy(); resolve({ port, ok: false }); });
  });
}

function kill(pid, signal = "SIGTERM") {
  try { process.kill(pid, signal); return true; } catch { return false; }
}

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function reapOrphans({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => process.stderr.write("[figbridge] " + a.join(" ") + "\n");
  let procs;
  try { procs = await listFigbridgeProcesses(); }
  catch (e) { log("could not list processes:", e.message); return { found: 0, killed: 0 }; }
  if (procs.length === 0) { log("no stale figbridge-mcp processes"); return { found: 0, killed: 0 }; }
  log(`found ${procs.length} figbridge-mcp process${procs.length === 1 ? "" : "es"}:`);
  for (const p of procs) log(`  pid=${p.pid} ppid=${p.ppid}`);
  // SIGTERM first, then SIGKILL for stragglers.
  for (const p of procs) kill(p.pid, "SIGTERM");
  await wait(500);
  let killed = 0;
  for (const p of procs) {
    // Still alive?
    if (kill(p.pid, 0)) {
      if (kill(p.pid, "SIGKILL")) { killed++; log(`  force-killed pid=${p.pid}`); }
    } else {
      killed++;
    }
  }
  log(`reaped ${killed}/${procs.length}`);
  return { found: procs.length, killed };
}

export async function runDoctor() {
  process.stdout.write("figbridge-mcp doctor\n");
  process.stdout.write("────────────────────\n\n");

  // 1. Port scan 7331..7340 for anything claiming to be figbridge.
  const probes = await Promise.all(
    Array.from({ length: 10 }, (_, i) => probeHealth(7331 + i))
  );
  const live = probes.filter((p) => p.ok && p.body && p.body.name === "figbridge-bridge");
  const other = probes.filter((p) => p.ok && (!p.body || p.body.name !== "figbridge-bridge"));

  if (live.length === 0) {
    process.stdout.write("No figbridge bridge responding on 7331–7340.\n");
  } else {
    process.stdout.write(`Live figbridge bridge${live.length > 1 ? "s" : ""}:\n`);
    for (const p of live) {
      const b = p.body;
      process.stdout.write(`  :${p.port}  clients=${b.clients ?? 0}  hasLatest=${b.hasLatest ? "yes" : "no"}\n`);
    }
  }
  for (const p of other) {
    process.stdout.write(`  :${p.port}  responded but not figbridge (port conflict)\n`);
  }
  process.stdout.write("\n");

  // 2. Reap any orphan processes (everything but ourselves).
  const { found, killed } = await reapOrphans({ quiet: true });
  if (found === 0) {
    process.stdout.write("No orphan figbridge-mcp processes.\n");
  } else {
    process.stdout.write(`Reaped ${killed}/${found} orphan figbridge-mcp process${found === 1 ? "" : "es"}.\n`);
  }

  process.stdout.write("\nNext steps:\n");
  if (found > 0) {
    process.stdout.write("  • Restart Claude Desktop so it respawns a fresh figbridge-mcp on :7331.\n");
  } else if (live.length === 0) {
    process.stdout.write("  • Restart Claude Desktop (or run `npx figbridge-mcp init` if never installed).\n");
  } else {
    process.stdout.write("  • All good. Open the Figbridge plugin in Figma and toggle Live bridge on.\n");
  }
}
