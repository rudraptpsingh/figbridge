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
const PARENT_PID = process.ppid;

function isFigbridgeCommand(cmd) {
  return /figbridge-mcp(?:\.js)?(?:@[\w.-]+)?(?:\s|$)/.test(cmd) || /bin\/figbridge-mcp/.test(cmd);
}

function parseProcessTable(stdout) {
  const rows = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!m) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3].trim() });
  }
  return rows;
}

function parentChain(pid, byPid) {
  const chain = [];
  const seen = new Set();
  let cur = byPid.get(pid);
  while (cur && cur.ppid && !seen.has(cur.ppid)) {
    seen.add(cur.ppid);
    const parent = byPid.get(cur.ppid);
    if (!parent) break;
    chain.push(parent);
    cur = parent;
  }
  return chain;
}

function isOwnLauncher(pid, byPid) {
  if (pid === SELF_PID || pid === PARENT_PID) return true;
  return parentChain(SELF_PID, byPid).some(p => p.pid === pid);
}

function isReapableOrphan(proc, byPid) {
  // Conservative by default: only reap processes whose parent is launchd/init
  // or whose whole parent chain is figbridge/npm/npx glue. If Codex/Claude
  // still owns the process, killing it closes the MCP stdio transport and the
  // next tool call reports "Transport closed".
  if (proc.ppid === 1 || proc.ppid === 0) return true;
  const parent = byPid.get(proc.ppid);
  if (!parent) return true;
  const chain = parentChain(proc.pid, byPid);
  if (!chain.length) return true;
  return chain.every(p =>
    isFigbridgeCommand(p.cmd) ||
    /\bnpm\s+exec\b.*figbridge-mcp/.test(p.cmd) ||
    /\bnpx\b.*figbridge-mcp/.test(p.cmd)
  );
}

export function classifyFigbridgeProcesses(stdout, { force = false } = {}) {
  // `ps -axo pid=,ppid=,command=` works on macOS + Linux. We pick out
  // the ones running figbridge-mcp (either the bin or bin/figbridge-mcp.js).
  const rows = parseProcessTable(stdout);
  const byPid = new Map(rows.map(p => [p.pid, p]));
  const reapable = [];
  const active = [];
  for (const row of rows) {
    const { pid, cmd } = row;
    if (!isFigbridgeCommand(cmd)) continue;
    // Skip doctor itself and grep/ps noise
    if (/\bgrep\b|\bps\b/.test(cmd)) continue;
    if (isOwnLauncher(pid, byPid)) continue;
    if (force || isReapableOrphan(row, byPid)) reapable.push(row);
    else active.push(row);
  }
  return { reapable, active };
}

async function listFigbridgeProcesses(options = {}) {
  const { stdout } = await execFile("ps", ["-axo", "pid=,ppid=,command="]);
  return classifyFigbridgeProcesses(stdout, options);
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
  let classified;
  try { classified = await listFigbridgeProcesses({ force: process.env.FIGBRIDGE_DOCTOR_FORCE === "1" }); }
  catch (e) { log("could not list processes:", e.message); return { found: 0, killed: 0 }; }
  const procs = classified.reapable;
  if (classified.active.length) {
    log(`leaving ${classified.active.length} active figbridge-mcp process${classified.active.length === 1 ? "" : "es"} alone`);
  }
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
