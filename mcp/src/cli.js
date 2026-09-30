// cli.js — call any figbridge MCP tool from a shell, a script or CI, without
// an MCP client session:
//
//   figbridge-mcp call <tool> ['<json-args>' | @args.json | -]
//   figbridge-mcp tools
//
// The server runs in-process and is driven over the SDK's in-memory
// transport, so the tool code path is exactly the one MCP clients hit. The
// bridge attaches to a running figbridge bridge when one owns the port (proxy
// mode), so plugin-backed tools reach the open Figma plugin; otherwise they
// fail fast with "plugin is not connected" and plugin-free tools still work.
//
// Output: the tool's JSON result on stdout. Exit code 1 when the tool reports
// { ok: false } or an MCP error, 2 on usage errors.

import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { startBridge } from "./bridge.js";
import { createServer } from "./server.js";

function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

export async function parseArgs(raw) {
  if (raw == null || raw === "") return {};
  let text = raw;
  if (raw === "-") text = await readStdin();
  else if (raw.startsWith("@")) text = readFileSync(raw.slice(1), "utf8");
  const v = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("tool arguments must be a JSON object");
  return v;
}

async function connect() {
  const quiet = () => {};
  const log = process.env.FIGBRIDGE_DEBUG ? (...a) => process.stderr.write("[figbridge] " + a.join(" ") + "\n") : quiet;
  const { server: bridgeServer, port } = await startBridge(Number(process.env.FIGBRIDGE_PORT || 7331), log);
  const server = createServer(port);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "figbridge-cli", version: "1" });
  await client.connect(clientT);
  const close = async () => {
    try { await client.close(); } catch {}
    if (bridgeServer) {
      try { bridgeServer.closeAllConnections && bridgeServer.closeAllConnections(); } catch {}
      await new Promise((r) => bridgeServer.close(() => r()));
    }
  };
  return { client, close };
}

/** Run `call` / `tools`. Returns the process exit code. */
export async function runCli(argv, out = process.stdout, err = process.stderr) {
  const [cmd, tool, rawArgs] = argv;
  if (cmd === "tools") {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      for (const t of tools) out.write(`${t.name}\t${(t.description || "").split(/(?<=\.)\s/)[0]}\n`);
      return 0;
    } finally { await close(); }
  }
  if (cmd !== "call" || !tool) {
    err.write("usage: figbridge-mcp call <tool> ['<json-args>' | @file.json | -]\n       figbridge-mcp tools\n");
    return 2;
  }
  let args;
  try { args = await parseArgs(rawArgs); }
  catch (e) { err.write(`figbridge-mcp call: bad arguments: ${e.message}\n`); return 2; }
  const { client, close } = await connect();
  try {
    const { tools } = await client.listTools();
    if (!tools.some((t) => t.name === tool)) {
      err.write(`figbridge-mcp call: unknown tool "${tool}". Run \`figbridge-mcp tools\` for the list.\n`);
      return 2;
    }
    const res = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 10 * 60 * 1000 });
    const text = (res.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    out.write((parsed ? JSON.stringify(parsed, null, 2) : text) + "\n");
    if (res.isError) return 1;
    if (parsed && typeof parsed === "object" && parsed.ok === false) return 1;
    return 0;
  } finally { await close(); }
}
