# figbridge-mcp

Free, open-source, local MCP bridge for Figma. Runs on 127.0.0.1 and gives MCP agents a practical Figma-to-code loop.

Exposes 45 MCP tools — read screens, export tokens, lint the design system, recolor, clone frames, **import a live URL into Figma**, audit the imported design (palette / typography / a11y / whitespace / mobile), and **diff back to source code as a patch** — to any client that speaks MCP: Claude Desktop, Claude Code, Cursor, Cline, etc.

## Install

```
npx figbridge-mcp init
```

This patches your Claude Desktop config and prints the steps for importing the Figma plugin. Then:

1. Quit and reopen Claude Desktop.
2. In Figma: **Plugins → Development → Import plugin from manifest…** and pick `plugin/manifest.json` from the [repo](https://github.com/rudraptpsingh/figbridge).
3. Run the Figbridge plugin, toggle **Live bridge** on.
4. In Claude: *"What tools does figbridge expose?"* — you should see 40+.

## Updating

`init` writes a config of the form `npx -y figbridge-mcp@latest`, so every Claude Desktop launch pulls the current release. Nothing to do after a new version ships.

If you installed ≤ 0.1.1 (which baked an absolute path into your config), run once to self-heal:

```
npx figbridge-mcp@latest update
```

Flags / commands:

- `init --pin` — lock Claude to the currently installed copy (opts out of auto-updates).
- `--version` — print the installed version.
- `doctor` — reap orphan `figbridge-mcp` processes (a failed shutdown can leave :7331 held), and probe 7331..7340 for live bridges. Run if Claude shows "Server disconnected" or the plugin can't connect.

## MCP registry

Also listed on the official [Model Context Protocol registry](https://registry.modelcontextprotocol.io/) as `io.github.rudraptpsingh/figbridge`. Clients that read the registry can discover + install without config edits. Verify: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.rudraptpsingh/figbridge"`.

## Ports

The HTTP+SSE bridge binds `127.0.0.1:7331` by default and auto-falls-back to 7332..7340 if something's already holding it. The Figma plugin probes the same range. Override the preferred starting port with `FIGBRIDGE_PORT=NNNN`.

## Tools

**Read** · `get_current_selection` · `get_last_export` · `list_history` · `get_tokens` · `bridge_status` · `diff_since` · `list_pages` · `list_frames`

**Catalog** · `list_screens` · `list_components` · `describe_screen` · `export_app_spec` · `export_all_pages` · `list_assets` · `select_node` · `export_node`

**Act & Handoff** · `get_agent_bundle` · `clone_screen` · `recolor` · `apply_tokens` · `lint_ds`

**Browser** · `preflight_import` (risk check before import, including font download URLs) · `import_url` (live URL → Figma frame; optional `hybridSnapshot` screenshot reference) · `import_responsive_set` (desktop / tablet / mobile and optional light / dark theme captures) · `import_url_batch` (bulk URL imports) · `screenshot_url` · `probe_url` · `fingerprint_url` · `audit_interactions` (hover / focus discovery) · `verify_text_fidelity` · `measure_fidelity` · `audit_regression` (baseline URL vs candidate URL frontend/UI regression audit)

**Pillar 1 — round-trip editing** · `diff_to_source` (per-text-node field diff between an imported Figma frame and the live source) · `generate_patch` (turn the diff into a minimal HTML/JSX patch against a source dir)

**Pillar 2 — design intelligence audits** · `audit_palette` · `audit_typography` · `audit_a11y` (WCAG 2.x contrast, landmarks, alt text) · `audit_whitespace` (padding/gap rhythm, 4/8-grid conformance) · `audit_mobile` (multi-viewport responsive: horizontal scroll, overflow-x, sub-44px touch targets, sub-12px text)

All audits return deterministic numbers — no LLM rewrites. `audit_regression` is the before/after gate: screenshot pixel diff, disappeared visible text, responsive issue deltas, and CSS-feature drift across desktop/tablet/mobile.

## The agent handoff bundle

`get_agent_bundle` returns a zip an agent can ship from *offline*: `hierarchy.md`, `components.json`, `tokens.json`, `tokens.css`, `AGENTS.md`, `DESIGN.md`, `CHANGES.md`, `ISSUES.md`, `flow.mmd`, `responsive.md`, `manifest.json` (sha-256 + token counts), `screenshots/`.

Three budget tiers (`small` 8k / `medium` 32k / `large` 128k tokens). Deterministic slugs that survive renames, so `CHANGES.md` is a real surgical diff instead of a whole-file retranslation.

## Repo

https://github.com/rudraptpsingh/figbridge (MIT)
