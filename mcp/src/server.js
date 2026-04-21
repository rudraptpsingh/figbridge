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

  // ── Catalog tools (app-level views) ───────────────────────
  server.tool(
    "list_screens",
    "List every top-level frame (screen) across pages in the currently open Figma file. Each result has { nodeId, name, pageName, width, height, category, orderHint }. Category is inferred from name: splash | onboarding | auth | home | detail | settings | overlay | editor | search | state | commerce | error | other. Requires the Figbridge plugin to be open with Live bridge on.",
    {
      pageId: z.string().optional().describe("Restrict to a single page id. Omit for all pages.")
    },
    async ({ pageId }) => {
      try {
        const result = await sendCommand("list-screens", { pageId }, 10000);
        return asText({ count: result.count, screens: result.screens });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "list_components",
    "List local components and component sets (with variants) in the currently open Figma file. Returns [{ nodeId, name, kind: 'COMPONENT' | 'COMPONENT_SET', variantCount?, variants? }].",
    {
      includeVariants: z.boolean().optional().describe("If true, include the list of variant components inside each COMPONENT_SET.")
    },
    async ({ includeVariants }) => {
      try {
        const result = await sendCommand("list-components", { includeVariants: !!includeVariants }, 10000);
        return asText({ count: result.count, components: result.components });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "describe_screen",
    "Return a semantic description of a single screen: size, background color, all text content, components used, inferred category, and a one-paragraph natural-language summary. Useful for agents that want to reason about a screen without fetching its full HTML.",
    { nodeId: z.string().describe("Figma node id of the screen/frame.") },
    async ({ nodeId }) => {
      try {
        const result = await sendCommand("describe-screen", { nodeId }, 10000);
        return asText(result);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "export_app_spec",
    "Return a complete JSON catalog of the currently open Figma file: every screen, every component (with variants), design tokens, CSS variables, Tailwind config, screens grouped by category, and a per-page flow ordering. Drop this into an agent's context as the authoritative spec for the app.",
    {},
    async () => {
      try {
        const result = await sendCommand("export-app-spec", {}, 20000);
        return asText(result.spec);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  // ── Write-side tools (agent generates / mutates Figma) ────
  server.tool(
    "clone_screen",
    "Duplicate a frame (screen) inside Figma, optionally renaming it and applying text replacements to every TEXT child. Places the clone to the right of the source. Returns { nodeId, name, textReplacements }.",
    {
      sourceNodeId: z.string().describe("Figma node id of the frame to clone."),
      name: z.string().optional().describe("Name to give the clone."),
      textReplacements: z.record(z.string(), z.string()).optional().describe("Map of find → replace strings applied to every TEXT node in the clone. Requires the fonts used to be available.")
    },
    async ({ sourceNodeId, name, textReplacements }) => {
      try {
        const r = await sendCommand("clone-screen", { sourceNodeId, name, textReplacements }, 15000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "recolor",
    "Swap SOLID fill/stroke colors across a scope. Scope is 'selection' (default), 'page', 'file', or a specific nodeId. Mapping maps old hex → new hex (case-insensitive, 3- or 6-digit hex, with or without #). Returns { changes, nodesVisited }.",
    {
      scope: z.enum(["selection", "page", "file"]).optional(),
      nodeId: z.string().optional().describe("Override scope with a specific node subtree."),
      mapping: z.record(z.string(), z.string()).describe("Old → new hex color map, e.g. { '#ff7a29': '#3ddc97' }.")
    },
    async ({ scope, nodeId, mapping }) => {
      try {
        const r = await sendCommand("recolor", { scope, nodeId, mapping }, 15000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "apply_tokens",
    "Bind loose SOLID color fills to matching local color variables (matched by exact hex). Scope is a nodeId or the current selection. Returns { bound, unboundRemaining, availableColorVariables }.",
    {
      nodeId: z.string().optional().describe("Target node subtree. Omit to use current selection (falls back to current page).")
    },
    async ({ nodeId }) => {
      try {
        const r = await sendCommand("apply-tokens", { nodeId }, 15000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "list_assets",
    "Export bulk assets from the file as base64. kind='icon' scans small vector frames + names like ic-* and exports SVG. kind='image' finds IMAGE-fill nodes and exports PNG@2x. kind='illustration' finds large vectors on 'Illustrations' pages and exports SVG. limit caps the number of assets returned (default 40).",
    {
      kind: z.enum(["icon", "image", "illustration"]).describe("Asset type to export."),
      limit: z.number().optional().describe("Max assets to return. Default 40.")
    },
    async ({ kind, limit }) => {
      try {
        const r = await sendCommand("list-assets", { kind, limit }, 30000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "lint_ds",
    "Lint the file for design-system violations: unbound colors (SOLID fills not using a variable), non-grid spacing (padding/gap not divisible by 4), orphan components (defined but never instanced), and duplicate names. Returns findings grouped by rule.",
    {
      pageId: z.string().optional().describe("Restrict to a single page id.")
    },
    async ({ pageId }) => {
      try {
        const r = await sendCommand("lint-ds", { pageId }, 20000);
        return asText(r);
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
