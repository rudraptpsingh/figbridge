#!/usr/bin/env node
// Static + browser-level validation for the Chrome extension MVP.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { startBridge } from "../mcp/src/bridge.js";

function assert(condition, message, detail) {
  if (!condition) throw new Error(message + (detail ? "\n" + detail : ""));
}

const root = process.cwd();
const extensionDir = path.join(root, "chrome-extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
const popup = fs.readFileSync(path.join(extensionDir, "popup.js"), "utf8");
const content = fs.readFileSync(path.join(extensionDir, "content-capture.js"), "utf8");
const background = fs.readFileSync(path.join(extensionDir, "background.js"), "utf8");

assert(manifest.manifest_version === 3, "extension must use MV3");
assert(manifest.key, "deterministic extension key missing");
assert(manifest.background?.service_worker === "background.js", "background service worker missing");
assert(manifest.permissions.includes("activeTab"), "activeTab permission missing");
assert(manifest.permissions.includes("scripting"), "scripting permission missing");
assert(manifest.host_permissions.includes("http://127.0.0.1:*/*"), "localhost bridge host permission missing");
assert(/captureVisibleTab/.test(popup), "viewport snapshot capture missing");
assert(/import-from-code/.test(popup), "extension should post import-from-code to bridge");
assert(/pageNameForSpec/.test(popup), "per-project Figma page naming helper missing");
assert(/Chrome Capture -/.test(popup), "extension should group captures into site-specific Figma pages");
assert(/capture-full-page/.test(fs.readFileSync(path.join(extensionDir, "popup.html"), "utf8")), "full-page opt-in control missing");
assert(/componentize:\s*false/.test(popup), "extension imports should disable auto-componentization");
assert(/7331/.test(popup) && /7340/.test(popup), "bridge port probing missing");
assert(/FIGBRIDGE_PICK_ELEMENT/.test(content), "selected-element picker missing");
assert(/mode === "viewport"/.test(content), "viewport capture mode missing");
assert(/display === "contents"/.test(content), "display:contents handling missing");
assert(/_bgUrl/.test(content), "asset URL capture missing");

new Function(popup);
new Function(content);
new Function("chrome", background);

function findChrome() {
  const candidates = [
    process.env.FIGBRIDGE_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p));
}

const chromePath = findChrome();
if (!chromePath || process.env.FIGBRIDGE_SKIP_EXTENSION_E2E === "1") {
  console.log("PASS  Chrome extension static validation passed. Browser E2E skipped.");
  process.exit(0);
}

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Figbridge extension fixture</title>
  <style>
    body { margin: 0; font-family: Inter, Arial, sans-serif; background: #101114; color: #fff; }
    main { padding: 32px; }
    .hero { display: flex; gap: 18px; align-items: center; padding: 18px; background: #1e293b; border-radius: 16px; }
    .hero img { width: 64px; height: 64px; object-fit: cover; border-radius: 12px; }
    .contents { display: contents; }
    .card { margin-top: 20px; padding: 16px; background: rgba(255,255,255,.12); border: 1px solid rgba(255,255,255,.2); border-radius: 12px; }
    h1 { margin: 0; font-size: 34px; }
    p { margin: 8px 0 0; font-size: 16px; }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <img alt="mark" src="data:image/svg+xml;base64,${Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='64' height='64' fill='#b8562b'/></svg>").toString("base64")}">
      <div>
        <h1>Authenticated dashboard state</h1>
        <p>Captured from the current Chrome tab.</p>
      </div>
    </section>
    <div class="contents">
      <article id="pick-me" class="card">
        <h2>Selected element target</h2>
        <p>This text should appear only in selected capture.</p>
      </article>
    </div>
  </main>
</body>
</html>`;

const pageServer = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});

await new Promise(resolve => pageServer.listen(0, "127.0.0.1", resolve));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

let bridgeServer = null;
let browser = null;
let reader = null;
const received = [];

try {
  const bridge = await startBridge(7331, () => {}, 9);
  bridgeServer = bridge.server;

  const sseResp = await fetch(`http://127.0.0.1:${bridge.port}/events`);
  reader = sseResp.body.getReader();
  const decoder = new TextDecoder();
  let sseBuf = "";
  (async function readLoop() {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
          const frame = sseBuf.slice(0, idx);
          sseBuf = sseBuf.slice(idx + 2);
          if (frame.startsWith(":")) continue;
          const lines = frame.split("\n");
          let event = "message", data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            if (line.startsWith("data: ")) data += line.slice(6);
          }
          if (event !== "command" || !data) continue;
          const cmd = JSON.parse(data);
          received.push(cmd);
          const spec = cmd.args?.spec || {};
          await fetch(`http://127.0.0.1:${bridge.port}/command/${cmd.cmdId}/result`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ok: true,
              nodeId: "chrome:test",
              name: cmd.args?.name || spec.name || "Chrome capture",
              pageName: cmd.args?.pageName || null,
              createdCount: countSpec(spec),
              warnings: []
            })
          });
        }
      }
    } catch {}
  })();

  const require = createRequire(import.meta.url);
  const puppeteerPath = require.resolve("puppeteer-core", { paths: [path.join(root, "mcp")] });
  const puppeteer = (await import(puppeteerPath)).default;
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "figbridge-extension-"));
  browser = await puppeteer.launch({
    headless: false,
    executablePath: chromePath,
    ignoreDefaultArgs: true,
    userDataDir,
    args: [
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-popup-blocking",
    ],
    defaultViewport: { width: 1100, height: 800 },
  });

  const page = await browser.newPage();
  await page.goto(pageUrl, { waitUntil: "domcontentloaded" });
  await delay(500);

  let extensionPage = null;
  let directHarness = false;
  try {
    const extensionDiscovery = await discoverExtensionPopup(browser);
    extensionPage = extensionDiscovery.page;
  } catch (e) {
    directHarness = true;
    await installContentHarness(page);
  }

  const captureFromPage = async (mode) => {
    if (directHarness) return await sendHarnessMessage(page, { type: "FIGBRIDGE_CAPTURE", mode });
    return await extensionPage.evaluate(async ({ url, mode }) => {
      const tabs = await chrome.tabs.query({ url });
      if (!tabs[0]) throw new Error("fixture tab not found");
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: "FIGBRIDGE_PING" });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ["content-capture.js"] });
      }
      return await chrome.tabs.sendMessage(tabs[0].id, { type: "FIGBRIDGE_CAPTURE", mode });
    }, { url: pageUrl, mode });
  };

  const pickElement = async () => {
    if (directHarness) {
      await sendHarnessMessage(page, { type: "FIGBRIDGE_PICK_ELEMENT" });
      return;
    }
    await extensionPage.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      try {
        await chrome.tabs.sendMessage(tabs[0].id, { type: "FIGBRIDGE_PING" });
      } catch {
        await chrome.scripting.executeScript({ target: { tabId: tabs[0].id }, files: ["content-capture.js"] });
      }
      await chrome.tabs.sendMessage(tabs[0].id, { type: "FIGBRIDGE_PICK_ELEMENT" });
    }, pageUrl);
  };

  const capturePage = await captureFromPage("page");
  assert(capturePage.ok, "page capture message failed", JSON.stringify(capturePage));
  assert(capturePage.spec.name.includes("Chrome current tab"), "page capture name wrong");
  assert(capturePage.spec._capture.fullPage === true, "page capture should be marked full-page");
  assert(JSON.stringify(capturePage.spec).includes("Authenticated dashboard state"), "page capture missed hero text");
  assert(JSON.stringify(capturePage.spec).includes(":contents"), "page capture did not preserve display:contents branch");

  const viewportPage = await captureFromPage("viewport");
  assert(viewportPage.ok, "viewport capture message failed", JSON.stringify(viewportPage));
  assert(viewportPage.spec.name.includes("Chrome viewport"), "viewport capture name wrong");
  assert(viewportPage.spec._capture.fullPage === false, "viewport capture should not be marked full-page");

  await pickElement();
  await page.click("#pick-me");
  await delay(250);
  const selected = await captureFromPage("selected");
  assert(selected.ok, "selected capture message failed", JSON.stringify(selected));
  assert(JSON.stringify(selected.spec).includes("Selected element target"), "selected capture missed selected heading");
  assert(!JSON.stringify(selected.spec).includes("Authenticated dashboard state"), "selected capture included unrelated page hero");

  const bridgeCapture = await captureFromPage("page");
  const bridgeResult = directHarness
    ? await postBridgeCommand(bridge.port, bridgeCapture.spec)
    : await extensionPage.evaluate(async ({ port, spec }) => {
        const res = await fetch(`http://127.0.0.1:${port}/command`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "import-from-code",
            args: { spec, name: spec.name, pageName: "Chrome Capture - 127 0 0 1", componentize: false },
            timeoutMs: 30000
          })
        });
        return await res.json();
      }, { port: bridge.port, spec: bridgeCapture.spec });
  assert(bridgeResult.ok, "extension context did not reach bridge", JSON.stringify(bridgeResult));
  assert(received.some(cmd => cmd.action === "import-from-code"), "fake plugin did not receive import-from-code");
  assert(received.some(cmd => /^Chrome Capture - /.test(cmd.args?.pageName || "")), "bridge command did not include site-specific pageName", JSON.stringify(received));
  assert(received.some(cmd => cmd.args?.componentize === false), "bridge command did not disable auto-componentization", JSON.stringify(received));

  console.log(directHarness
    ? "PASS  Chrome extension MVP static + content-script/bridge browser E2E passed. Popup load was unavailable in automated Chrome."
    : "PASS  Chrome extension MVP static + full popup browser E2E passed.");
} finally {
  try { if (reader) await reader.cancel(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  if (bridgeServer) {
    try {
      if (typeof bridgeServer.closeAllConnections === "function") bridgeServer.closeAllConnections();
      await new Promise(resolve => bridgeServer.close(resolve));
    } catch {}
  }
  await new Promise(resolve => pageServer.close(resolve));
}

function countSpec(node) {
  if (!node) return 0;
  let count = 1;
  for (const child of node.children || []) count += countSpec(child);
  return count;
}

async function installContentHarness(page) {
  await page.evaluate(() => {
    window.__figbridgeHarnessListener = null;
    window.chrome = {
      runtime: {
        onMessage: {
          addListener(fn) {
            window.__figbridgeHarnessListener = fn;
          }
        }
      }
    };
  });
  await page.addScriptTag({ path: path.join(extensionDir, "content-capture.js") });
  await page.waitForFunction(() => typeof window.__figbridgeHarnessListener === "function");
}

async function sendHarnessMessage(page, msg) {
  return await page.evaluate((payload) => new Promise(resolve => {
    window.__figbridgeHarnessListener(payload, {}, resolve);
  }), msg);
}

async function postBridgeCommand(port, spec) {
  const res = await fetch(`http://127.0.0.1:${port}/command`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "import-from-code",
      args: { spec, name: spec.name, pageName: "Chrome Capture - 127 0 0 1", componentize: false },
      timeoutMs: 30000
    })
  });
  return await res.json();
}

async function discoverExtensionPopup(browser) {
  await delay(1000);
  const candidates = [];
  for (const target of browser.targets()) {
    const url = target.url();
    if (!url.startsWith("chrome-extension://")) continue;
    const id = new URL(url).host;
    if (id && candidates.indexOf(id) < 0) candidates.push(id);
  }

  for (const id of candidates) {
    const page = await browser.newPage();
    try {
      await page.goto(`chrome-extension://${id}/popup.html`, {
        waitUntil: "domcontentloaded",
        timeout: 3000,
      });
      const text = await page.evaluate(() => document.title + "\n" + document.body.innerText);
      if (/Figbridge Capture/.test(text)) return { id, page };
    } catch {
      await page.close().catch(() => {});
      continue;
    }
    await page.close().catch(() => {});
  }

  throw new Error(
    "Figbridge extension target not found.\n" +
    JSON.stringify(browser.targets().map(t => ({ type: t.type(), url: t.url() })), null, 2)
  );
}
