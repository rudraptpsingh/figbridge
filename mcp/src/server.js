import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { getLatest, getHistory, getHistorySince } from "./store.js";
import { startBridge, sendCommand, clientCount } from "./bridge.js";

const FORMATS = ["html", "css", "tailwind", "tokens", "cssVars", "tailwindConfig", "all"];

const PKG_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
).version;

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
  const preferredPort = Number(process.env.FIGBRIDGE_PORT || 7331);
  const { server: bridgeServer, port } = await startBridge(preferredPort, log);

  // ── Clean shutdown ──────────────────────────────────────────
  // Claude Desktop closes our stdin when it wants us to exit. If we
  // don't notice we become a zombie holding :7331 and the next launch
  // lands on the port-fallback path (still works, but we'd leak a
  // process per relaunch). Exit on stdin EOF and on signals.
  let shuttingDown = false;
  function shutdown(reason) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down: ${reason}`);
    try {
      // SSE keepalive sockets hold the server open. close() alone waits
      // for them to drain — which never happens. closeAllConnections()
      // (Node 18.2+) severs idle + active sockets so close() resolves.
      if (typeof bridgeServer.closeAllConnections === "function") {
        bridgeServer.closeAllConnections();
      }
      bridgeServer.close();
    } catch {}
    // Hard-exit fallback in case something still holds the loop open.
    setTimeout(() => process.exit(0), 200).unref();
  }
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("close", () => shutdown("stdin close"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGHUP",  () => shutdown("SIGHUP"));

  const server = new McpServer({ name: "figbridge", version: PKG_VERSION });

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
      includeVariants: z.coerce.boolean().optional().describe("If true, include the list of variant components inside each COMPONENT_SET.")
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
      limit: z.coerce.number().optional().describe("Max assets to return. Default 40.")
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

  // ── Mediator: figbridge orchestrates browser + plugin ─────
  // These tools turn figbridge into the single contact-surface between
  // Claude and Figma. No external chrome-devtools-mcp dance needed; one
  // call goes URL → Figma frame (or back).
  server.tool(
    "import_url",
    "Render a URL in headless Chrome (figbridge-managed), walk the DOM with computed styles, and create the resulting frame tree in Figma. The single highest-fidelity path from web → Figma. Returns { nodeId, name, createdCount, warnings }.",
    {
      url: z.string().describe("Page URL — http(s) or file:// — anything Chrome can load."),
      width: z.coerce.number().optional().describe("Viewport width. Default 1280."),
      name: z.string().optional().describe("Override the Figma frame's name. Defaults to '<title> WIDTHpx'."),
      update: z.coerce.boolean().optional().describe("If true, finds the existing frame by name and replaces its children (no duplicates). Default false."),
      dryRun: z.coerce.boolean().optional().describe("If true, runs the full extraction but skips sending to Figma. Returns spec metadata + telemetry only."),
      colorScheme: z.enum(["light", "dark"]).optional().describe("Force prefers-color-scheme. Sites that auto-switch render in this theme. Leave unset for system default.")
    },
    async ({ url, width, name, update, dryRun, colorScheme }) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/command`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "import-url", args: { url, width: width || 1280, name: name || null, update: !!update, dryRun: !!dryRun, colorScheme: colorScheme || null }, timeoutMs: 300000 })
        });
        return asText(await r.json());
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "import_responsive_set",
    "Import a URL at multiple viewport widths in one call. Creates one Figma frame per viewport, laid out side-by-side. Most efficient way to capture mobile/tablet/desktop in a single iteration. Default widths: 1280, 768, 375. Returns { frames: [{ width, nodeId, name, createdCount }] }.",
    {
      url: z.string(),
      widths: z.array(z.coerce.number()).optional().describe("Viewport widths to capture. Default [1280, 768, 375]."),
      namePrefix: z.string().optional().describe("Frame name prefix. Each frame becomes `<prefix> <width>px`. Default uses the page title.")
    },
    async ({ url, widths, namePrefix }) => {
      const wList = widths && widths.length ? widths : [1280, 768, 375];
      const results = [];
      for (const w of wList) {
        try {
          const { urlToSpec } = await import("./browser.js");
          const spec = await urlToSpec(url, { width: w });
          const name = (namePrefix || spec.name || "Import") + " " + w + "px";
          spec.name = name;
          spec.width = w;
          const r = await sendCommand("import-from-code", { spec, name }, 300000);
          results.push({ width: w, ...r });
        } catch (e) { results.push({ width: w, ok: false, error: e.message }); }
      }
      return asText({ ok: true, frames: results });
    }
  );

  server.tool(
    "verify_text_fidelity",
    "After importing a URL, verify that every visible text string from the live page also exists in the Figma frame. Returns { liveCount, specCount, missing[], matchedPct }. Use as a fast sanity check that the extractor didn't drop content.",
    { url: z.string(), nodeId: z.string(), width: z.coerce.number().optional() },
    async ({ url, nodeId, width }) => {
      try {
        const { urlToSpec, verifyTextFidelity } = await import("./browser.js");
        const spec = await urlToSpec(url, { width: width || 1280 });
        const result = await verifyTextFidelity(url, spec, { width: width || 1280 });
        return asText({ ok: true, nodeId, ...result });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "screenshot_url",
    "Render a URL in headless Chrome and capture a PNG. If `outPath` is given, writes the PNG to disk and returns the path (cheap on agent context). Otherwise returns the base64 bytes. Use for visual diffs against Figma exports.",
    {
      url: z.string().describe("Page URL."),
      width: z.coerce.number().optional().describe("Viewport width. Default 1280."),
      fullPage: z.coerce.boolean().optional().describe("Capture the whole page vs just the viewport. Default true."),
      outPath: z.string().optional().describe("Absolute filesystem path to write the PNG to. When set, response includes { path } and omits base64.")
    },
    async ({ url, width, fullPage, outPath }) => {
      try {
        const { screenshotUrl } = await import("./browser.js");
        const b64 = await screenshotUrl(url, { width: width || 1280, fullPage: fullPage !== false });
        if (outPath) {
          const fs = await import("node:fs/promises"); const path = await import("node:path");
          await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
          await fs.writeFile(outPath, Buffer.from(b64, "base64"));
          return asText({ ok: true, path: outPath, width: width || 1280, bytes: Math.round(b64.length * 0.75) });
        }
        return asText({ ok: true, width: width || 1280, bytes: Math.round(b64.length * 0.75), base64: b64 });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "visual_diff",
    "One-call visual reference: take a live Chrome screenshot of `url` AND export the Figma frame at `nodeId`, write both PNGs to `outDir` (default /tmp), and return their paths. Hand the paths to the Read tool to view side-by-side. Replaces the chrome-devtools-mcp + python-decode + manual-write dance.",
    {
      url: z.string().describe("Live page URL."),
      nodeId: z.string().describe("Figma node id of the imported frame."),
      width: z.coerce.number().optional().describe("Chrome viewport width. Default 1280."),
      scale: z.coerce.number().optional().describe("Figma export scale. Default 0.5."),
      outDir: z.string().optional().describe("Directory to write PNGs into. Default /tmp."),
      prefix: z.string().optional().describe("Filename prefix. Default 'diff'.")
    },
    async ({ url, nodeId, width, scale, outDir, prefix }) => {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/command`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "visual-diff", args: { url, nodeId, width: width || 1280, scale: scale || 0.5, outDir: outDir || "/tmp", prefix: prefix || "diff" }, timeoutMs: 120000 })
        });
        return asText(await r.json());
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "fingerprint_url",
    "Audit a URL's CSS-feature usage in one call — returns counts of flexbox/grid/gradients/shadows/filters/blends/transforms/pseudo-elements/iframes/etc, plus tag mix and color/font palette. Run BEFORE bigger fidelity pushes to know where the actual coverage gaps are. Returns { totalElements, topTags, displays, positions, features, colors[], fonts[] }.",
    {
      url: z.string(),
      width: z.coerce.number().optional()
    },
    async ({ url, width }) => {
      try {
        const { fingerprintUrl } = await import("./browser.js");
        return asText({ ok: true, ...(await fingerprintUrl(url, { width: width || 1280 })) });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "probe_url",
    "Render a URL in headless Chrome and run an arbitrary JS snippet inside the page. Use to inspect the live DOM / computed styles when planning an extraction. Replaces external chrome-devtools-mcp.evaluate_script. Snippet is the async-function body; use `return` for the result. Returns { ok, result }.",
    {
      url: z.string(),
      script: z.string().describe("JS body, runs as async. The `document`/`window`/`getComputedStyle` globals are available. Use `return` for the result."),
      width: z.coerce.number().optional()
    },
    async ({ url, script, width }) => {
      try {
        const { probeUrl } = await import("./browser.js");
        const r = await probeUrl(url, script, { width: width || 1280 });
        return asText({ ok: true, result: r });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "export_frame",
    "Export a Figma frame as PNG. With `outPath`: writes to disk, returns path. Without: returns base64. Use to pull a rendered version of an imported frame back out for visual diff.",
    {
      nodeId: z.string().describe("Figma node id, e.g. '6:1121'."),
      scale: z.coerce.number().optional().describe("Export scale (1 = native). Default 1."),
      outPath: z.string().optional().describe("Absolute path to write PNG. When set, response includes { path } and omits base64.")
    },
    async ({ nodeId, scale, outPath }) => {
      try {
        const r = await sendCommand("export-frame", { nodeId, scale: scale || 1 }, 60000);
        if (!r.ok || !outPath) return asText(r);
        const fs = await import("node:fs/promises"); const path = await import("node:path");
        await fs.mkdir(path.dirname(outPath), { recursive: true }).catch(() => {});
        await fs.writeFile(outPath, Buffer.from(r.base64, "base64"));
        return asText({ ok: true, nodeId: r.nodeId, name: r.name, width: r.width, height: r.height, bytes: r.bytes, path: outPath });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  // ── Code → Figma import ────────────────────────────────────
  server.tool(
    "import_from_code",
    "Create a real Figma frame (auto-layout, text, fills, radii — editable layers, not a flattened image) directly from code. Provide ONE of: `spec` (deterministic JSON tree — preferred), `html` (raw HTML string — best-effort element→frame mapping), or `htmlPath` (read file from disk, then parse as html). Top-level spec shape: { name, width?, height?, fill?, layout: 'VERTICAL'|'HORIZONTAL'|'NONE', padding?, spacing?, children: Node[] } where Node = { type: 'frame'|'text'|'rect', ...style }. The new frame is placed to the right of any existing top-level frame on the current page and selected. Returns { nodeId, name, createdCount, warnings[] }.",
    {
      // `spec` is a nested object. The MCP SDK silently drops fields under
      // `z.any()` so we accept the spec as a JSON STRING and parse it
      // server-side. Object-typed args are still flaky enough across
      // clients that string-in is the safer contract.
      spec: z.string().optional().describe("Deterministic design spec as a JSON string — a tree of { type: 'frame'|'text'|'rect', ... }. Stringify with JSON.stringify(...). Highest fidelity, no parsing guesswork."),
      html: z.string().optional().describe("Raw HTML string. Mapped element-by-element: section/div/header/footer/nav/article → frame; h1-h6/p/span/a/button text → text node; img/hr → rect. Inline `style=\"...\"` attributes are parsed for common properties (background, color, font-size, padding, gap, border-radius, width, height, display:flex with flex-direction)."),
      htmlPath: z.string().optional().describe("Path to an HTML file on disk. Read and treated as `html`. Useful for piping a built page directly into Figma."),
      name: z.string().optional().describe("Override the root frame's name. Defaults to spec.name, '<title>', or 'Imported design'."),
      pageId: z.string().optional().describe("Target page id. Omit to use the current page.")
    },
    async ({ spec, html, htmlPath, name, pageId }) => {
      try {
        let parsedSpec = null;
        if (spec) {
          try { parsedSpec = JSON.parse(spec); }
          catch (e) { return asText({ ok: false, error: "spec is not valid JSON: " + e.message }); }
        }
        let resolvedHtml = html;
        if (!parsedSpec && !html && htmlPath) {
          const { readFile } = await import("node:fs/promises");
          resolvedHtml = await readFile(htmlPath, "utf8");
        }
        if (!parsedSpec && !resolvedHtml) {
          return asText({ ok: false, error: "Provide one of: spec, html, htmlPath." });
        }
        const r = await sendCommand("import-from-code", {
          spec: parsedSpec || null,
          html: resolvedHtml || null,
          name: name || null,
          pageId: pageId || null
        }, 30000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "update_from_code",
    "Update an existing Figma frame in place from a new spec or HTML — finds the frame by `nodeId` or by exact `name`, removes its children, and rebuilds them from `spec` / `html`. The root frame id stays stable so anything that references it survives the update. If no match found, falls back to creating a fresh frame. Returns { nodeId, name, replacedCount, warnings[] }. Use this for iterative re-imports instead of `import_from_code` to avoid duplicate frames.",
    {
      spec: z.string().optional().describe("Deterministic design spec as a JSON string."),
      html: z.string().optional().describe("Raw HTML string."),
      nodeId: z.string().optional().describe("Figma node id of the existing frame to update."),
      name: z.string().optional().describe("Name of the existing top-level frame to update (used when nodeId not provided).")
    },
    async ({ spec, html, nodeId, name }) => {
      try {
        let parsedSpec = null;
        if (spec) { try { parsedSpec = JSON.parse(spec); } catch (e) { return asText({ ok: false, error: "spec not valid JSON: " + e.message }); } }
        if (!parsedSpec && !html) return asText({ ok: false, error: "Provide spec or html." });
        const r = await sendCommand("update-from-code", { spec: parsedSpec || null, html: html || null, nodeId: nodeId || null, name: name || null }, 60000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "run_script",
    "Escape hatch: evaluate an arbitrary JavaScript async-body inside the Figma plugin sandbox. The `figma` plugin API is in scope. Use this when no purpose-built tool exists for what you want — e.g. one-off queries, exotic node manipulations, prototyping a future tool. Body must return a JSON-serializable value (or undefined). Returns { ok, result, error? }. Trust model: bridge binds 127.0.0.1 only, same as recolor/clone_screen.\n\nExample script: `const sel = figma.currentPage.selection[0]; return { id: sel?.id, type: sel?.type, name: sel?.name };`",
    { script: z.string().describe("JavaScript async function body. The `figma` global is available. Use `return` for the result.") },
    async ({ script }) => {
      try {
        const r = await sendCommand("run-script", { script }, 30000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "delete_node",
    "Delete a Figma node by id, a list of ids, or by exact name. Returns { deleted, errors }. Use this to clean up junk frames between imports.",
    {
      nodeId: z.string().optional().describe("Single node id, e.g. '6:2'."),
      nodeIds: z.array(z.string()).optional().describe("Multiple node ids."),
      name: z.union([z.string(), z.array(z.string())]).optional().describe("Exact frame name(s) on the current page.")
    },
    async ({ nodeId, nodeIds, name }) => {
      try {
        const r = await sendCommand("delete-node", { nodeId: nodeId || null, nodeIds: nodeIds || [], name: name || null }, 10000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  // ── Agent bundle ───────────────────────────────────────────
  server.tool(
    "get_agent_bundle",
    "Build an LLM-ready handoff bundle from the currently selected frames (or current page if nothing selected). Returns a list of files: hierarchy.md, components.json, tokens.json, tokens.css, DESIGN.md, AGENTS.md, ISSUES.md, issues.json, snapshot.json, manifest.json, optional CHANGES.md (if prior snapshot exists), optional responsive.md/json, optional flow.mmd, per-variant .tsx + .stories.tsx, optional screenshots (base64 PNG), and tailwind.config.js. Text files are returned verbatim; binary files (screenshots) are base64. Requires the Figbridge plugin open with Live bridge on.",
    {
      nodeId: z.string().optional().describe("Specific frame to bundle. Omit to use current selection or page-level frames."),
      budget: z.enum(["small", "medium", "large"]).optional().describe("Token budget tier. small=hierarchy+tokens only, medium=+components+screenshots, large=everything. Default medium."),
      screenshots: z.coerce.boolean().optional().describe("Include per-root-frame PNG screenshots. Default false."),
      codePaths: z.array(z.string()).optional().describe("Optional list of code file paths (e.g. from `find src/components -name '*.tsx'`) to fuzzy-match against Figma components. Mapping is emitted in components.json + AGENTS.md.")
    },
    async ({ nodeId, budget, screenshots, codePaths }) => {
      try {
        const r = await sendCommand("agent-bundle", { nodeId, budget, screenshots, codePaths }, 60000);
        return asText(r);
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  // ── Structural navigation ──────────────────────────────────
  server.tool(
    "list_pages",
    "List every page in the currently open Figma file: { id, name, frameCount, isCurrent }. Cheap — use this before list_screens / list_frames to orient.",
    {},
    async () => {
      try {
        const r = await sendCommand("list-pages", {}, 5000);
        return asText({ count: r.count, pages: r.pages });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "list_frames",
    "List the top-level layers on a specific page (or the current page). Returns [{ id, name, type, width, height, hasChildren }]. Use this to walk the file without exporting.",
    { pageId: z.string().optional().describe("Page id. Omit to use the current page.") },
    async ({ pageId }) => {
      try {
        const r = await sendCommand("list-frames", { pageId }, 5000);
        return asText({ pageId: r.pageId, pageName: r.pageName, count: r.count, frames: r.frames });
      } catch (e) { return asText({ ok: false, error: e.message }); }
    }
  );

  server.tool(
    "export_all_pages",
    "Export every page's top-level frames in one call. Returns { pageCount, pages: [{ pageId, pageName, frameCount, html, css, tailwindHtml, tokens, cssVars }] }. Use for whole-file handoff; prefer get_agent_bundle for agent-ready output.",
    {},
    async () => {
      try {
        const r = await sendCommand("export-all", {}, 60000);
        return asText({ pageCount: r.pageCount, pages: r.pages });
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
