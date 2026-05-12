import http from "node:http";
import crypto from "node:crypto";
import { setLatest, getLatest } from "./store.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, ...CORS_HEADERS });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

// ── SSE registry ─────────────────────────────────────────────
const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch {}
  }
}

// ── Command queue (agent → plugin round-trip) ────────────────
const pending = new Map(); // cmdId → { resolve, reject, timer }

export function sendCommand(action, args, timeoutMs = 5000) {
  if (clients.size === 0) {
    return Promise.reject(new Error("Figbridge plugin is not connected. Open the plugin in Figma and toggle Live bridge on."));
  }
  const cmdId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(cmdId);
      reject(new Error(`Command "${action}" timed out after ${timeoutMs}ms. Is the plugin still open?`));
    }, timeoutMs);
    pending.set(cmdId, { resolve, reject, timer });
    broadcast("command", { cmdId, action, args });
  });
}

export function clientCount() { return clients.size; }

// ── HTTP server ──────────────────────────────────────────────
// Try the requested port first; on EADDRINUSE walk up to `portRange`
// additional ports. Claude Desktop can respawn this process while an
// older instance is still holding 7331, so a hard fatal there means
// the user sees "Server disconnected" with no useful recovery. With
// fallback, the new instance just picks 7332 and the plugin (which
// probes the range) finds it. Resolves to `{ server, port }`.
export function startBridge(preferredPort = 7331, log = () => {}, portRange = 9) {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); return res.end(); }

    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, {
        ok: true, name: "figbridge-bridge",
        hasLatest: !!getLatest(), clients: clients.size
      });
    }

    if (req.method === "GET" && req.url === "/latest") {
      return send(res, 200, getLatest() || { empty: true });
    }

    // SSE — plugin subscribes here
    if (req.method === "GET" && req.url === "/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...CORS_HEADERS
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, serverTime: Date.now() })}\n\n`);
      clients.add(res);
      log(`client connected (total=${clients.size})`);
      const keepalive = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
      req.on("close", () => {
        clients.delete(res);
        clearInterval(keepalive);
        log(`client disconnected (total=${clients.size})`);
      });
      return;
    }

    // Plugin push a new selection payload
    if (req.method === "POST" && req.url === "/push") {
      let chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          setLatest(body);
          log(`push: ${body.pageName || "?"} / ${(body.nodeNames || []).join(", ")}`);
          broadcast("selection", {
            pageName: body.pageName, nodeNames: body.nodeNames,
            nodeIds: body.nodeIds, capturedAt: body.capturedAt
          });
          send(res, 200, { ok: true });
        } catch (e) { send(res, 400, { ok: false, error: e.message }); }
      });
      req.on("error", (e) => send(res, 500, { ok: false, error: e.message }));
      return;
    }

    // External command injection — POST /command { action, args, timeoutMs? }
    // Lets any local script drive figbridge without going through MCP.
    // Same trust model as the rest of the bridge: 127.0.0.1 only.
    //
    // Two kinds of actions:
    //   - PLUGIN actions (default) — broadcast to plugin over SSE, await reply
    //   - SERVER actions (browser orchestrator) — handled in the MCP server
    //     process directly so they don't need the Figma plugin to be open.
    if (req.method === "POST" && req.url === "/command") {
      let chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          if (!body.action) return send(res, 400, { ok: false, error: "action required" });
          const args = body.args || {};
          // Server-side actions handled here, not over SSE.
          if (body.action === "import-url" || body.action === "screenshot-url" || body.action === "probe-url" || body.action === "visual-diff" || body.action === "fingerprint-url") {
            const { urlToSpec, screenshotUrl, probeUrl, fingerprintUrl } = await import("./browser.js");
            if (body.action === "fingerprint-url") {
              const r = await fingerprintUrl(args.url, { width: args.width || 1280 });
              return send(res, 200, { ok: true, ...r });
            }
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const writeMaybe = async (b64, outPath) => {
              if (!outPath) return null;
              const dir = path.dirname(outPath);
              try { await fs.mkdir(dir, { recursive: true }); } catch {}
              await fs.writeFile(outPath, Buffer.from(b64, "base64"));
              return outPath;
            };
            if (body.action === "import-url") {
              const spec = await urlToSpec(args.url, { width: args.width || 1280, name: args.name || null, colorScheme: args.colorScheme || null, sourceDir: args.sourceDir || null });
              if (args.name) spec.name = args.name;
              // Telemetry: count nodes + features so the response gives
              // visibility into what was captured.
              const telemetry = { nodes: 0, gradients: 0, perSidePadding: 0, xy: 0, shadows: 0, borders: 0, svgs: 0, images: 0, ranges: 0, transforms: 0, blends: 0 };
              (function tally(n) {
                if (!n) return;
                telemetry.nodes++;
                if (typeof n.fill === 'string' && n.fill.startsWith('linear-gradient')) telemetry.gradients++;
                if (Array.isArray(n.fill)) for (const l of n.fill) if (l.kind === 'linear-gradient') telemetry.gradients++;
                if (n.padding && typeof n.padding === 'object') telemetry.perSidePadding++;
                if (typeof n.x === 'number') telemetry.xy++;
                if (n.shadow) telemetry.shadows++;
                if (n.stroke) telemetry.borders++;
                if (n.type === 'svg') telemetry.svgs++;
                if (n._imageBytes) telemetry.images++;
                if (Array.isArray(n.ranges) && n.ranges.length) telemetry.ranges++;
                if (n.transform) telemetry.transforms++;
                if (n.blendMode) telemetry.blends++;
                if (n.children) for (const c of n.children) tally(c);
              })(spec);
              // Dry-run: return the telemetry without sending to plugin.
              if (args.dryRun) return send(res, 200, { ok: true, dryRun: true, spec: { name: spec.name, width: spec.width, height: spec.height }, telemetry });
              const action = args.update ? "update-from-code" : "import-from-code";
              const r = await sendCommand(action, { spec, name: spec.name || args.name || null }, args.timeoutMs || 300000);
              return send(res, 200, { ...r, telemetry });
            }
            if (body.action === "screenshot-url") {
              const b64 = await screenshotUrl(args.url, { width: args.width || 1280, fullPage: args.fullPage !== false });
              const written = await writeMaybe(b64, args.outPath);
              const out = { ok: true, width: args.width || 1280, bytes: Math.round(b64.length * 0.75) };
              if (written) out.path = written; else out.base64 = b64;
              return send(res, 200, out);
            }
            if (body.action === "probe-url") {
              const r = await probeUrl(args.url, args.script, { width: args.width || 1280 });
              return send(res, 200, { ok: true, result: r });
            }
            if (body.action === "visual-diff") {
              // One call: chrome screenshot + figma frame export, both to disk.
              // Returns paths the agent can hand to Read for inline viewing.
              const b64chrome = await screenshotUrl(args.url, { width: args.width || 1280, fullPage: true });
              const figR = await sendCommand("export-frame", { nodeId: args.nodeId, scale: args.scale || 0.5 }, 60000);
              if (!figR || !figR.ok) return send(res, 200, { ok: false, error: "figma export failed", figmaError: figR && figR.error });
              const outDir = args.outDir || "/tmp";
              const chromePath = path.join(outDir, (args.prefix || "diff") + "-chrome.png");
              const figmaPath  = path.join(outDir, (args.prefix || "diff") + "-figma.png");
              await writeMaybe(b64chrome, chromePath);
              await writeMaybe(figR.base64, figmaPath);
              return send(res, 200, {
                ok: true,
                chrome: { path: chromePath, width: args.width || 1280, bytes: Math.round(b64chrome.length * 0.75) },
                figma:  { path: figmaPath, width: figR.width, height: figR.height, bytes: figR.bytes }
              });
            }
          }
          const result = await sendCommand(body.action, args, body.timeoutMs || 15000);
          send(res, 200, result);
        } catch (e) { send(res, 502, { ok: false, error: e.message }); }
      });
      req.on("error", (e) => send(res, 500, { ok: false, error: e.message }));
      return;
    }

    // Plugin reports a command result
    const m = req.url && req.url.match(/^\/command\/([^/]+)\/result$/);
    if (req.method === "POST" && m) {
      const cmdId = m[1];
      let chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          const p = pending.get(cmdId);
          if (!p) return send(res, 404, { ok: false, error: "unknown cmdId" });
          clearTimeout(p.timer);
          pending.delete(cmdId);
          if (body.ok === false) p.reject(new Error(body.error || "command failed"));
          else p.resolve(body);
          send(res, 200, { ok: true });
        } catch (e) { send(res, 400, { ok: false, error: e.message }); }
      });
      return;
    }

    send(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    let attempt = 0;
    let settled = false;
    const onError = (e) => {
      if (settled) return;
      if (e && e.code === "EADDRINUSE" && attempt < portRange) {
        const stale = preferredPort + attempt;
        attempt++;
        const next = preferredPort + attempt;
        log(`port ${stale} in use, trying ${next}`);
        // server is still usable; re-listen on the next port
        setImmediate(() => { if (!settled) server.listen(next, "127.0.0.1"); });
        return;
      }
      settled = true;
      server.removeListener("error", onError);
      reject(e);
    };
    server.on("error", onError);
    server.once("listening", () => {
      settled = true;
      server.removeListener("error", onError);
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : preferredPort + attempt;
      log(`bridge listening on http://127.0.0.1:${port}`);
      resolve({ server, port });
    });
    server.listen(preferredPort, "127.0.0.1");
  });
}
