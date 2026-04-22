#!/usr/bin/env node
// One-shot release cutter for figbridge-mcp.
//
// Usage:
//   node scripts/release.mjs patch          # 0.1.2 → 0.1.3
//   node scripts/release.mjs minor          # 0.1.2 → 0.2.0
//   node scripts/release.mjs major          # 0.1.2 → 1.0.0
//   node scripts/release.mjs 0.3.1          # explicit
//   node scripts/release.mjs patch --dry    # show the plan, don't mutate
//
// What it does, in order:
//   1. Sanity-checks the working tree is clean and on main and in sync.
//   2. Reads mcp/package.json and computes the target version.
//   3. Prints the commits since the last tag so you can sanity-check the bump.
//   4. Writes the new version to mcp/package.json.
//   5. Commits as `chore(release): vX.Y.Z`.
//   6. Tags `vX.Y.Z`.
//   7. Pushes main and the tag.
//   8. GitHub Actions does the rest (npm publish + GitHub Release + notes).
//
// Guard rails: if anything fails partway through, we abort with a message
// and leave the working tree in a recoverable state (no partial push).

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PKG = path.join(ROOT, "mcp", "package.json");
const SRV = path.join(ROOT, "server.json");

const DRY = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const bumpArg = process.argv.slice(2).find(a => !a.startsWith("--"));

if (!bumpArg) {
  console.error("usage: node scripts/release.mjs <patch|minor|major|X.Y.Z> [--dry]");
  process.exit(2);
}

const sh = (cmd, opts = {}) => execSync(cmd, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }).trim();
const run = (cmd) => {
  console.log(`$ ${cmd}`);
  if (DRY) return "";
  const r = spawnSync("sh", ["-c", cmd], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) { console.error(`! command failed (exit ${r.status})`); process.exit(r.status || 1); }
};

function bumpSemver(cur, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(cur);
  if (!m) throw new Error(`can't parse current version: ${cur}`);
  let [_, x, y, z] = m.map(Number);
  if (kind === "patch") z++;
  else if (kind === "minor") { y++; z = 0; }
  else if (kind === "major") { x++; y = 0; z = 0; }
  else throw new Error(`unknown bump kind: ${kind}`);
  return `${x}.${y}.${z}`;
}

// ── 1. Preflight ──────────────────────────────────────────────────
const branch = sh("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  console.error(`! must be on main to release (on ${branch}).`);
  process.exit(1);
}
const dirty = sh("git status --porcelain");
if (dirty) {
  console.error("! working tree is dirty. commit or stash first:\n" + dirty);
  process.exit(1);
}
try { sh("git fetch --tags origin main"); } catch (e) {
  console.error("! git fetch failed: " + e.message); process.exit(1);
}
const ahead = sh("git rev-list --count origin/main..HEAD");
const behind = sh("git rev-list --count HEAD..origin/main");
if (behind !== "0") {
  console.error(`! local main is ${behind} commit(s) behind origin. pull first.`);
  process.exit(1);
}

// ── 2. Compute next version ───────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
const curVer = pkg.version;
const nextVer = bumpSemver(curVer, bumpArg);
const tag = `v${nextVer}`;

if (sh(`git tag -l ${tag}`)) {
  console.error(`! tag ${tag} already exists.`);
  process.exit(1);
}

// ── 3. Show the diff since last tag ───────────────────────────────
const lastTag = (() => {
  try { return sh("git describe --tags --abbrev=0"); } catch { return ""; }
})();
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const log = sh(`git log ${range} --pretty=format:"  %h %s" --no-merges`);

console.log(`\nfigbridge-mcp release plan`);
console.log(`─────────────────────────────────────────────`);
console.log(`  current version   ${curVer}`);
console.log(`  next version      ${nextVer}      (bump: ${bumpArg})`);
console.log(`  tag               ${tag}`);
console.log(`  branch            ${branch} (in sync with origin, ${ahead} ahead — ${ahead === "0" ? "nothing new since origin!" : "those commits will ship"})`);
console.log(`  commits since ${lastTag || "repo start"}:`);
console.log(log ? log : "    (none)");
console.log(`─────────────────────────────────────────────`);
if (ahead === "0" && bumpArg !== "patch") {
  console.error("! no new commits since origin/main — nothing to release.");
  process.exit(1);
}
if (DRY) { console.log("(dry run — nothing was changed)"); process.exit(0); }

// ── 4. Mutate: bump + commit + tag + push ─────────────────────────
pkg.version = nextVer;
fs.writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
// Keep server.json (MCP registry manifest) in lockstep with mcp/package.json.
// The registry schema requires packages[0].version to match the published npm
// version — drift here would make `mcp-publisher publish` fail in CI.
let srvAdd = "";
if (fs.existsSync(SRV)) {
  const srv = JSON.parse(fs.readFileSync(SRV, "utf8"));
  srv.version = nextVer;
  for (const p of srv.packages || []) p.version = nextVer;
  fs.writeFileSync(SRV, JSON.stringify(srv, null, 2) + "\n");
  srvAdd = ` ${path.relative(ROOT, SRV)}`;
}
run(`git add ${path.relative(ROOT, PKG)}${srvAdd}`);
run(`git commit -m "chore(release): ${tag}"`);
run(`git tag ${tag}`);
run(`git push origin main`);
run(`git push origin ${tag}`);

console.log(`\n✓ pushed ${tag}. Publish workflow is now running.`);
console.log(`  watch: gh run watch --exit-status`);
console.log(`  npm:   https://www.npmjs.com/package/figbridge-mcp/v/${nextVer}`);
