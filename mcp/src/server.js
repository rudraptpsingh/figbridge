import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getLatest, getHistory, getHistorySince } from "./store.js";
import { startBridge, sendCommand, clientCount } from "./bridge.js";

const FORMATS = ["html", "css", "tailwind", "tokens", "cssVars", "tailwindConfig", "all"];

function log(...args) { process.stderr.write("[figbridge] " + args.join(" ") + "\n"); }

function formatPayload(payload, format) {
  if (!payload) return { error: "No selection has been pushed yet. Open Figbridge in Figma and enable Live bridge." };
  switch (format) {
    case "html": return { format, content: payload.html || "" };
    case "css": return { format, content: payload.css || "" };
    case "tailwind": return { format, content: payload.tailwindHtml || "" };
    case "tokens": return { format, content: JSON.stringify(payload.tokens || {}, null, 2) };
    case "cssVars": return { format, content: payload.cssVars || "" };
    case "tailwindConfig": return { format, content: payload.tailwindConfig || "" };
    case "all":
    default:
      return {
        format: "all",
        fileKey: payload.fileKey,
        fileName: payload.fileName,
        pageName: payload.pageName,
        nodeNames: payload.nodeNames,
        capturedAt: payload.capturedAt,
        html: payload.html,
        css: payload.css,
        tailwindHtml: payload.tailwindHtml,
        tokens: payload.tokens,
        cssVars: payload.cssVars,
        tailwindConfig: payload.tailwindConfig
      };
  }
}

function asText(obj) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] };
}

export async function main() {
  const port = Number(process.env.FIGBRIDGE_PORT || 7331);
  await startBridge(port, log);

  const server = new McpServer({ name: "figbridge", version: "0.1.0" });

  server.tool(
    "get_current_selection",
    "Get the most recent Figma selection pushed from the Figbridge plugin, in the requested format.",
    {
      format: z.enum(FORMATS).optional().describe("Output format. Default: 'all' (metadata + every format). Use 'html' / 'css' / 'tailwind' / 'tokens' / 'cssVars' / 'tailwindConfig' for a single format.")
    },
    async ({ format }) => asText(formatPayload(getLatest(), format || "all"))
  );

  server.tool(
    "get_last_export",
    "Alias for get_current_selection. Returns the last pushed Figbridge payload.",
    { format: z.enum(FORMATS).optional() },
    async ({ format }) => asText(formatPayload(getLatest(), format || "all"))
  );

  server.tool(
    "list_history",
    "List recent Figma selections that have been pushed (metadata only, newest first).",
    {},
    async () => asText({ history: getHistory() })
  );

  server.tool(
    "get_tokens",
    "Get only the design-token payload (color + number variables, plus CSS variable file and Tailwind config).",
    {},
    async () => {
      const p = getLatest();
      if (!p) return asText({ error: "No selection pushed yet." });
      return asText({ tokens: p.tokens, cssVars: p.cssVars, tailwindConfig: p.tailwindConfig });
    }
  );

  server.tool(
    "bridge_status",
    "Health check for the Figbridge HTTP bridge and the stored payload. Also reports whether a plugin is currently connected (pluginConnected).",
    {},
    async () => {
      const p = getLatest();
      return asText({
        bridge: { port, running: true },
        pluginConnected: clientCount() > 0,
        connectedClients: clientCount(),
        hasLatest: !!p,
        latest: p ? { pageName: p.pageName, nodeNames: p.nodeNames, capturedAt: p.capturedAt, fingerprint: p._fingerprint } : null
      });
    }
  );

  // ── Bidirectional tools (agent → plugin) ──────────────────
  server.tool(
    "select_node",
    "Select a node in Figma and scroll the viewport to it. Provide either a nodeId (e.g. '1:2') or a name substring. Requires the Figbridge plugin to be open with Live bridge enabled.",
    {
      nodeId: z.string().optional().describe("Exact Figma node id, e.g. '49:137'"),
      name: z.string().optional().describe("Case-insensitive substring match on node name (used if nodeId is not provided)")
    },
    async ({ nodeId, name }) => {
      if (!nodeId && !name) return asText({ error: "Provide nodeId or name." });
      try {
        const result = await sendCommand("select", { nodeId, name });
        return asText({ ok: true, selected: result.selected || null });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "export_node",
    "Trigger the plugin to export a specific node (by id) without requiring the user to click. Returns the same payload shape as get_current_selection.",
    {
      nodeId: z.string().describe("Figma node id, e.g. '49:137'"),
      format: z.enum(FORMATS).optional()
    },
    async ({ nodeId, format }) => {
      try {
        await sendCommand("export-node", { nodeId }, 10000);
        // The plugin, after executing, POSTs to /push — which updates store.
        // Give it a moment to land.
        await new Promise((r) => setTimeout(r, 250));
        return asText(formatPayload(getLatest(), format || "all"));
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  // ── Diff ───────────────────────────────────────────────────
  server.tool(
    "diff_since",
    "Return history entries captured after the given timestamp (milliseconds since epoch). Each entry includes a 12-char SHA-1 fingerprint of the payload so you can detect real content changes vs re-selections.",
    { sinceMs: z.number().describe("Return entries with capturedAt > sinceMs. Use 0 for full history.") },
    async ({ sinceMs }) => asText({ since: sinceMs, entries: getHistorySince(sinceMs) })
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`figbridge-mcp ready (stdio + bridge on :${port})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { log("fatal:", e && e.stack || e); process.exit(1); });
}
