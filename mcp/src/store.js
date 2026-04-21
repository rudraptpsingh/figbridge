import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

function fingerprint(payload) {
  const h = crypto.createHash("sha1");
  h.update(payload.html || "");
  h.update(payload.css || "");
  h.update(JSON.stringify(payload.tokens || {}));
  return h.digest("hex").slice(0, 12);
}

const STORE_DIR = path.join(os.homedir(), ".figbridge");
const STORE_FILE = path.join(STORE_DIR, "last.json");
const HISTORY_FILE = path.join(STORE_DIR, "history.json");
const MAX_HISTORY = 25;

function ensureDir() {
  try { fs.mkdirSync(STORE_DIR, { recursive: true }); } catch {}
}

let latest = null;
let history = [];

try {
  if (fs.existsSync(STORE_FILE)) latest = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  if (fs.existsSync(HISTORY_FILE)) history = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
} catch {}

export function setLatest(payload) {
  ensureDir();
  latest = payload;
  const fp = fingerprint(payload);
  const entry = {
    pageName: payload.pageName,
    nodeNames: payload.nodeNames,
    nodeIds: payload.nodeIds,
    fileKey: payload.fileKey,
    fileName: payload.fileName,
    capturedAt: payload.capturedAt,
    fingerprint: fp
  };
  payload._fingerprint = fp;
  history.unshift(entry);
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(payload));
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
  } catch (e) {
    process.stderr.write(`[figbridge] persist failed: ${e.message}\n`);
  }
}

export function getLatest() { return latest; }
export function getHistory() { return history; }
export function getHistorySince(sinceMs) {
  const t = Number(sinceMs) || 0;
  return history.filter((e) => (e.capturedAt || 0) > t);
}
export function clear() { latest = null; history = []; try { fs.rmSync(STORE_FILE, { force: true }); fs.rmSync(HISTORY_FILE, { force: true }); } catch {} }
