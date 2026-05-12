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
    // Lets any local script drive the plugin without going through MCP.
    // Same trust model as the rest of the bridge: 127.0.0.1 only.
    if (req.method === "POST" && req.url === "/command") {
      let chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", async () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          if (!body.action) return send(res, 400, { ok: false, error: "action required" });
          const result = await sendCommand(body.action, body.args || {}, body.timeoutMs || 15000);
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
