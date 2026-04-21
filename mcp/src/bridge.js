import http from "node:http";
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

export function startBridge(port = 7331, log = () => {}) {
  const server = http.createServer((req, res) => {
    if (req.method === "OPTIONS") { res.writeHead(204, CORS_HEADERS); return res.end(); }

    if (req.method === "GET" && req.url === "/health") {
      return send(res, 200, { ok: true, hasLatest: !!getLatest(), name: "figbridge-bridge" });
    }
    if (req.method === "GET" && req.url === "/latest") {
      return send(res, 200, getLatest() || { empty: true });
    }
    if (req.method === "POST" && req.url === "/push") {
      let chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          setLatest(body);
          log(`push: ${body.pageName || "?"} / ${(body.nodeNames || []).join(", ")}`);
          send(res, 200, { ok: true });
        } catch (e) {
          send(res, 400, { ok: false, error: e.message });
        }
      });
      req.on("error", (e) => send(res, 500, { ok: false, error: e.message }));
      return;
    }
    send(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      log(`bridge listening on http://127.0.0.1:${port}`);
      resolve(server);
    });
  });
}
