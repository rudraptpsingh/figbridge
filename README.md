# Figbridge

**Figma ↔ code, in both directions.** Free, local, no Dev Mode seat, no account.

Figbridge is a Figma plugin + local MCP server. Open the plugin on any file, toggle the **Live bridge**, and any MCP-capable agent (Claude Desktop, Claude Code, Cursor, Continue, Cline…) can read screens, tokens, and components, **import a whole URL into Figma**, **audit the imported design**, **diff it back against the source**, and **emit a patch for the source repo** — over `127.0.0.1`.

```
┌──────────┐   postMessage   ┌──────────┐   HTTP + SSE    ┌───────────────┐     stdio     ┌──────────────┐
│  Figma   │ ──────────────▶ │  Plugin  │ ──────────────▶ │  MCP Server   │ ◀──────────── │  AI agent    │
│  Desktop │                  │   UI     │   :7331/push    │  (localhost)  │   tools/call  │  (Claude …)  │
└──────────┘                  └──────────┘                 └───────────────┘               └──────────────┘
```

## Why

Figma's own [Dev Mode MCP](https://help.figma.com/hc/en-us/articles/32132100833559) requires a **$25/seat Dev subscription**, runs in the cloud, and emits prescriptive React+Tailwind that poisons an agent's context. Third-party plugins like Anima / Codejet / Builder.io require accounts and run in the cloud.

Figbridge:
- **Free.** MIT. Runs entirely on your machine.
- **No account, no token.** Uses your existing Figma desktop session.
- **30+ MCP tools.** Read, catalog, write-back, lint, ship an agent handoff bundle, import a live URL into Figma, audit the imported design across 5 dimensions, and round-trip changes back to a source repo as a patch.
- **Offline agent bundle.** `get_agent_bundle` produces a zip (hierarchy · tokens · components · AGENTS.md · CHANGES.md) an agent can ship from *without* a live MCP connection.
- **Deterministic.** No LLM rewrites. What you select is what you get.
- **Live.** Toggle "Live bridge" and every selection change auto-pushes; agents pull the current selection instantly.

## Install — ~3 minutes

The plugin is **not in Figma Community yet**, so you clone the repo to get it. The MCP server comes from npm.

```bash
# 1. Get the Figma plugin (clone the repo)
git clone https://github.com/rudraptpsingh/figbridge

# 2. Patch Claude Desktop's MCP config
npx figbridge-mcp init
```

Then:

1. **Quit and reopen Claude Desktop** — it only reads MCP config at launch.
2. In Figma: **Plugins → Development → Import plugin from manifest…** → pick the `plugin/manifest.json` from the clone above. (One-time.)
3. Run the Figbridge plugin on any frame, toggle **Live bridge** on. A green dot in the plugin header = connected to the local bridge. The footer shows the port.
4. In Claude: *"What tools does figbridge expose?"* — you should see 30+.

For any other MCP client (Cursor, Cline, VS Code, …), point it at the same binary: `npx figbridge-mcp`.

### Via the MCP registry

Figbridge is also listed on the official [Model Context Protocol registry](https://registry.modelcontextprotocol.io/) as `io.github.rudraptpsingh/figbridge`. Clients that support the registry (Claude Desktop, Cursor, VS Code) can discover and install it without hand-editing config.

### Troubleshooting

If Claude Desktop shows **"Server disconnected"** or port 7331 gets stuck, run:

```bash
npx figbridge-mcp doctor
```

It reaps orphan `figbridge-mcp` processes and reports which ports are alive. The bridge auto-falls-back to 7332..7340 if 7331 is held, and the plugin auto-probes the same range — so "port in use" won't block you. `FIGBRIDGE_PORT=NNNN` overrides the preferred starting port.

### Updating

`init` writes a config that runs `npx -y figbridge-mcp@latest`, so every Claude Desktop launch pulls the current version — **no action needed** after a new release.

If you installed an older version (≤ 0.1.1) that baked an absolute path into your config, run this once to self-heal:

```bash
npx figbridge-mcp@latest update
```

Use `npx figbridge-mcp init --pin` if you'd rather lock to the currently installed copy (no auto-updates). `npx figbridge-mcp --version` prints the installed version.

## MCP tools

**Read (8)** — `get_current_selection` · `get_last_export` · `list_history` · `get_tokens` · `bridge_status` · `diff_since` · `list_pages` · `list_frames`

**Catalog (8)** — `list_screens` · `list_components` · `describe_screen` · `export_app_spec` · `export_all_pages` · `list_assets` · `select_node` · `export_node`

**Act & Handoff (5)** — `get_agent_bundle` · `clone_screen` · `recolor` · `apply_tokens` · `lint_ds`

**Browser (6)** — `import_url` (live URL → Figma frame), `screenshot_url`, `probe_url`, `fingerprint_url`, `verify_text_fidelity`, `measure_fidelity`

**Pillar 1 — Round-trip editing (2)** — `diff_to_source` (per-text-node field diff between imported frame and live source) · `generate_patch` (turn the diff into a minimal HTML/JSX/etc patch against a source dir; style swaps get structured CSS-file hints)

**Pillar 2 — Design intelligence audits (5)** — `audit_palette` · `audit_typography` · `audit_a11y` (WCAG 2.x contrast, landmarks, alt text) · `audit_whitespace` (padding/gap rhythm, 4/8-grid conformance) · `audit_mobile` (multi-viewport responsive: horizontal scroll, overflow-x, sub-44px touch targets, sub-12px text)

All audits are pure deterministic measurement — no LLM. They return numeric scores and structured issue lists ready to feed back into a planning loop.

## The agent handoff bundle

`get_agent_bundle` is the differentiator. One call returns a zip:

```
DESIGN.md          palette · rhythm · do/don't
hierarchy.md       indented tree with deterministic slugs
components.json    variants + props schema
tokens.json        DTCG-shaped
tokens.css         :root + per-mode blocks
flow.mmd           Figma prototype → Mermaid graph
responsive.md      mobile/tablet/desktop merged
ISSUES.md          a11y audit the agent shouldn't repeat
CHANGES.md         surgical diff since last bundle
AGENTS.md          "when you see slug X, import Y"
manifest.json      sha-256 + token counts, stable order for prompt cache
screenshots/       1:1 paired with hierarchy slugs
```

Three budget tiers (`small` 8k / `medium` 32k / `large` 128k tokens). Slugs are deterministic — rename a node, the slug stays — so `CHANGES.md` is a real surgical diff instead of a whole-file retranslation.

## The closed loop: URL → Figma → diff → patch

Figbridge is the first MCP-native tool that closes the loop in both directions.

```
                 import_url                      diff_to_source
   ┌──────────┐  ──────────▶  ┌──────────┐  ──────────▶  ┌──────────┐
   │  Source  │                │  Figma   │                │  changes │
   │  (URL,   │                │  frame   │                │   list   │
   │   repo)  │ ◀──────────    │ (edited) │                └────┬─────┘
   └──────────┘  generate_patch└──────────┘                     │
                                                                ▼
                                                         apply or review
```

1. **`import_url`** pulls a live URL into a Figma page (multi-page aware via `pageName`).
2. **Audit** the result with the five Pillar 2 tools to find palette drift, contrast failures, off-grid spacing, mobile breakage.
3. The designer edits the frame in Figma.
4. **`diff_to_source`** reports exactly which text-node fields diverged from the source URL — characters / fontSize / fontFamily / color / presence.
5. **`generate_patch`** turns the diff into a minimal before/after edit list against a local source directory. Style swaps get structured hints (token vs literal) instead of blind text replacements.

No LLM rewrites in the loop. Every step is deterministic and idempotent.

## Output formats

| Format | Shape |
|---|---|
| **HTML + CSS** | Self-contained document, positional layout preserving pixel fidelity. |
| **Tailwind** | Same tree with Tailwind arbitrary-value utilities (`w-[120px]`, `bg-[#ff7a29]`) + CDN script. |
| **Design tokens** | DTCG JSON tree, `:root { --var: value }` CSS, Tailwind config fragment. Reads Figma Variables + local paint styles. |

## Architecture

- **Plugin main thread** (`plugin/code.js`) — reads the node tree, computes HTML/CSS/Tailwind/tokens deterministically. ES2017-safe (no spread / `??` / `?.`) for the Figma sandbox.
- **Plugin UI** (`plugin/ui.html`) — cream/ink/rust theme, Figma-native layer navigator, inline Commands panel with a Run button per tool.
- **MCP server** (`mcp/src/`) — stdio MCP via `@modelcontextprotocol/sdk`, sibling HTTP + SSE server on `:7331` for plugin pushes and bidirectional commands. State in-memory + persisted to `~/.figbridge/last.json`.

## What Figbridge does *not* do

- No reach into Figma without the desktop app + plugin open. No REST API, no PAT.
- No AI code rewrites. It's a deterministic tree walker.
- No publishing to Figma or to the cloud.

## Development

```bash
cd mcp && npm install && npm test        # integration smoke test
node test-agent/run.js                   # 130 unit tests on the render pipeline
node test/scenarios.mjs                  # 54 real-world scenario checks
node test/real-figma.mjs                 # 43 checks against a parsed real .fig
node test/tools-all.mjs                  # 21-tool MCP surface + e2e
node --check plugin/code.js              # plugin syntax check
```

## Links

- Landing page: https://rudraptpsingh.github.io/figbridge/
- npm: https://www.npmjs.com/package/figbridge-mcp

## License

MIT © Rudra Pratap Singh
