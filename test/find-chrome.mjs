#!/usr/bin/env node
// Browser discovery per platform. Windows used to throw "No Chrome/Chromium
// found" even with Edge installed, because only macOS/Linux paths were listed.

import assert from "node:assert/strict";
import { chromeCandidates, findChrome } from "../mcp/src/browser.js";

const winEnv = {
  PROGRAMFILES: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
};

const win = chromeCandidates("win32", winEnv);
assert.ok(win.includes("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
assert.ok(win.includes("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe"), "per-user Chrome install");
assert.ok(win.includes("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), "Edge, present on every Windows 10/11");
assert.ok(win.indexOf("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe") < win.indexOf("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), "Chrome preferred over Edge");
assert.equal(new Set(win).size, win.length, "no duplicates");

const edgeOnly = (p) => p === "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
assert.equal(findChrome("win32", winEnv, edgeOnly), "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
assert.equal(findChrome("win32", { ...winEnv, FIGBRIDGE_CHROME: "D:\\chrome.exe" }, () => false), "D:\\chrome.exe", "override wins");
assert.throws(() => findChrome("win32", winEnv, () => false), /FIGBRIDGE_CHROME/);

const mac = chromeCandidates("darwin", {});
assert.equal(mac[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
assert.ok(chromeCandidates("linux", {}).includes("/usr/bin/chromium"));

console.log("PASS  browser discovery (Windows Chrome/Edge, macOS, Linux, override).");
