# Figbridge — agent memory

Context for future Claude sessions working in this repo. Keep short and current.

## Repo shape

- `plugin/code.js` — Figma plugin main thread. ES2017-safe (no spread / `??` / `?.`), runs in QuickJS. The user-facing bug source.
- `plugin/ui.html` — iframe UI. Cream/ink/rust theme. Sends `pluginMessage` events; receives `window.onmessage`.
- `mcp/` — npm package `figbridge-mcp`. Stdio MCP server + HTTP+SSE bridge on `:7331`.
- `test/` — integration tests.
- `test-agent/` — unit tests for the render pipeline, with a Figma-sandbox shim.
- `scripts/release.mjs` — one-shot release cutter (below).
- `docs/` — GitHub Pages landing page + Figma Community listing assets.

## Release flow — do not deviate

**Cut a release:**

```bash
node scripts/release.mjs patch          # 0.1.n → 0.1.(n+1)
node scripts/release.mjs minor          # 0.1.n → 0.2.0
node scripts/release.mjs X.Y.Z          # explicit
node scripts/release.mjs patch --dry    # preview, no mutation
```

The script refuses to run on dirty trees / off main / when local is behind origin. It bumps `mcp/package.json`, commits `chore(release): vX.Y.Z`, tags, pushes main + tag. **Don't manually `git tag` unless the script itself is broken.**

On tag push, `.github/workflows/publish.yml` runs:

1. Verify tag matches `mcp/package.json` version.
2. Smoke + full pipeline + tool-surface tests.
3. `npm publish --provenance`.
4. Poll registry.
5. Create GitHub Release — notes grouped by conventional-commit prefix (`feat` / `fix` / `docs` / `ci|chore` / other), appends install + update footer. Idempotent on re-run (`gh release edit`).

Checkout uses `fetch-depth: 0` + `fetch-tags: true` so `git describe --tags "$TAG^"` can resolve the previous tag for the notes range.

## Seamless auto-updates for users

Since **0.1.2**, `init` writes:

```json
{ "command": "npx", "args": ["-y", "figbridge-mcp@latest"] }
```

Claude Desktop respawns npx on every launch → users get new versions for free.

- `init --pin` → absolute-path pinned to current version (opt-out).
- `update` → alias for `init`; used to self-heal ≤ 0.1.1 installs that baked `/_npx/<hash>/` paths.
- `--version` → print installed version.

Existing users on ≤ 0.1.1 should run `npx figbridge-mcp@latest update` once. Call this out in release notes when there's a breaking change.

## Plugin gotchas — don't forget these

- **No IIFE wrappers in `plugin/code.js`.** A `var X = (function(){...})()` at column 0 function-scopes every `function` inside, invisible from the top level. This bit us hard for the entire bottom half of the file. `test/lint-plugin.mjs` catches it — run before pushing.
- **No duplicate top-level function declarations.** Later wins silently in QuickJS, earlier becomes dead code. The lint catches these too.
- **`figma.mixed` is a Symbol**, not `null` / `undefined`. Guard every property that can be mixed:
  - `node.fills`, `node.strokes`, `node.strokeWeight`, `node.dashPattern`, `node.individualStrokeWeights`, `node.cornerRadius`.
  - Missing guard → `TypeError: cannot convert symbol to string` during tree walk.
- **UI dedupe guard needs `nodeIds`.** `ui.html` drops any `result` message whose `msg.nodeIds` doesn't match `state.pending.nodeIds`. `exportNodes` / `exportSelection` must include `nodeIds` explicitly in `postMessage`. Otherwise the loading view stays up forever while `timing` arrives underneath (the tell: footer shows timing, output area stuck on "Exporting…").
- **Port 7331 EADDRINUSE auto-fallback** (since 0.1.6): `startBridge` walks 7331..7340 on EADDRINUSE and returns `{ server, port }`. Plugin UI probes `/health` across the same range before connecting. `FIGBRIDGE_PORT=NNNN` still overrides the preferred starting port.
- **Clean shutdown** (since 0.1.6): `server.js` exits on stdin end/close and SIGTERM/SIGINT/SIGHUP, closing the HTTP server first. Prevents zombie processes piling up when Claude Desktop respawns us.
- **`figbridge-mcp doctor`** (since 0.1.6): reaps orphan figbridge-mcp processes (SIGTERM then SIGKILL) and probes 7331..7340 for live bridges. `init` / `update` run the reaper before rewriting the config so the next Claude launch lands on a clean :7331.

## Commit message conventions

Conventional-commit prefixes so the release-notes bucketing works:

- `feat(scope): …` → 🚀 Features
- `fix(scope): …` → 🐛 Fixes
- `docs: …` → 📝 Docs
- `ci|build|chore(scope): …` → 🔧 Chores & CI (but `chore(release): vX.Y.Z` is filtered out)
- Anything else → Other changes

## Testing

Before any non-trivial push:

```bash
node test/lint-plugin.mjs                # IIFE + dup-decl lint on plugin/code.js
node -e "const fs=require('fs'); new Function('figma','__html__',fs.readFileSync('plugin/code.js','utf8'));"  # parse-only syntax check
node test/smoke.mjs                      # MCP server end-to-end
node test-agent/run.js                   # 130 unit tests on the render pipeline
```

CI (`.github/workflows/ci.yml`) runs smoke + tests on every push.

## Open items / known follow-ups

- Node 20 actions-deprecation warning in CI (Sep 2026 hard cutoff). Bump actions + add `node-version: "20"` → `"24"` when ready.
- Sidebar redesign (original /frontend-design ask) is still deferred — fix-first took priority.
- `SSE is deprecated` notice from Figma console — bridge transport migration eventually.
- Port-conflict auto-fallback on 7331.
