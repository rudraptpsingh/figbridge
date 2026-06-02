const PORTS = [7331, 7332, 7333, 7334, 7335, 7336, 7337, 7338, 7339, 7340];

const statusEl = document.getElementById("bridge-status");
const logEl = document.getElementById("log");
const includeSnapshotEl = document.getElementById("include-snapshot");
const captureFullPageEl = document.getElementById("capture-full-page");
const captureTabEl = document.getElementById("capture-tab");
const pickElementEl = document.getElementById("pick-element");
const captureSelectedEl = document.getElementById("capture-selected");

let bridgeBase = null;

function log(message) {
  logEl.textContent = message;
}

function titleCasePart(part) {
  return String(part || "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

function projectLabelFromUrl(rawUrl) {
  try {
    const url = new URL(rawUrl || "");
    const host = (url.hostname || "current tab").replace(/^www\./, "");
    const bits = host.split(".").filter(Boolean);
    if (bits.length >= 2) return titleCasePart(bits.slice(0, -1).join(" "));
    return titleCasePart(host);
  } catch {
    return "Current Tab";
  }
}

function pageNameForSpec(spec) {
  const capture = spec && spec._capture || {};
  const label = projectLabelFromUrl(capture.url || "");
  return "Chrome Capture - " + label;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab.");
  return tab;
}

async function findBridge() {
  for (const port of PORTS) {
    const base = `http://127.0.0.1:${port}`;
    try {
      const res = await fetch(base + "/health", { cache: "no-store" });
      if (!res.ok) continue;
      const body = await res.json();
      if (body && body.ok) return base;
    } catch {}
  }
  return null;
}

async function ensureContent(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "FIGBRIDGE_PING" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content-capture.js"]
    });
  }
}

async function captureVisibleSnapshot(tab, spec) {
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  const viewport = spec._capture && spec._capture.viewport || { width: spec.width || 1280, height: 800 };
  const scroll = spec._capture && spec._capture.scroll || { x: 0, y: 0 };
  const fullPage = spec._capture && spec._capture.fullPage;
  return {
    type: "rect",
    name: "Chrome viewport snapshot reference",
    x: fullPage ? Math.round(scroll.x || 0) : 0,
    y: fullPage ? Math.round(scroll.y || 0) : 0,
    width: Math.round(viewport.width || spec.width || 1280),
    height: Math.round(viewport.height || 800),
    imageScaleMode: "FILL",
    _imageBytes: dataUrl
  };
}

async function captureSpec(mode) {
  const tab = await activeTab();
  await ensureContent(tab.id);
  const response = await chrome.tabs.sendMessage(tab.id, {
    type: "FIGBRIDGE_CAPTURE",
    mode
  });
  if (!response || !response.ok) throw new Error(response && response.error || "Capture failed.");
  const spec = response.spec;
  if (includeSnapshotEl.checked) {
    const snapshot = await captureVisibleSnapshot(tab, spec);
    spec.layout = "NONE";
    spec.children = [snapshot].concat(spec.children || []);
    spec._hybridSnapshot = {
      enabled: true,
      source: "chrome-extension",
      note: "Visible viewport screenshot inserted behind editable captured layers."
    };
  }
  return spec;
}

async function sendSpec(mode) {
  if (!bridgeBase) throw new Error("Figbridge bridge is not running.");
  const spec = await captureSpec(mode);
  const pageName = pageNameForSpec(spec);
  const res = await fetch(bridgeBase + "/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "import-from-code",
      args: {
        spec,
        name: spec.name || "Chrome capture",
        pageName,
        componentize: false
      },
      timeoutMs: 120000
    })
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) throw new Error(body.error || `Bridge returned HTTP ${res.status}.`);
  return body;
}

async function withBusy(button, fn) {
  const buttons = [captureTabEl, pickElementEl, captureSelectedEl];
  buttons.forEach(b => b.disabled = true);
  const old = button.textContent;
  button.textContent = "Working...";
  try {
    const result = await fn();
    log(result);
  } catch (e) {
    log("Error: " + (e && e.message || e));
  } finally {
    button.textContent = old;
    buttons.forEach(b => b.disabled = false);
  }
}

captureTabEl.addEventListener("click", () => withBusy(captureTabEl, async () => {
  const result = await sendSpec(captureFullPageEl.checked ? "page" : "viewport");
  return `${captureFullPageEl.checked ? "Sent current tab." : "Sent visible viewport."}\n${result.name || ""}\n${result.pageName || ""}\n${result.nodeId || ""}`;
}));

pickElementEl.addEventListener("click", () => withBusy(pickElementEl, async () => {
  const tab = await activeTab();
  await ensureContent(tab.id);
  await chrome.tabs.sendMessage(tab.id, { type: "FIGBRIDGE_PICK_ELEMENT" });
  return "Picker armed. Click an element, then reopen this popup and send selected element.";
}));

captureSelectedEl.addEventListener("click", () => withBusy(captureSelectedEl, async () => {
  const result = await sendSpec("selected");
  return `Sent selected element.\n${result.name || ""}\n${result.pageName || ""}\n${result.nodeId || ""}`;
}));

(async function init() {
  bridgeBase = await findBridge();
  if (bridgeBase) {
    statusEl.textContent = `Connected to ${bridgeBase.replace("http://", "")}`;
    log("Ready.");
  } else {
    statusEl.textContent = "Bridge offline";
    log("Start Figbridge MCP and enable Live bridge in Figma.");
  }
})();
