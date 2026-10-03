# figbridge-mcp

Free, open-source, local MCP bridge for Figma. Runs on 127.0.0.1 and gives MCP agents a practical Figma-to-code loop.

Exposes 54 MCP tools — read screens, export tokens, lint the design system, recolor, clone frames, **import a live URL into Figma**, audit the imported design (palette / typography / a11y / whitespace / mobile), **diff back to source code as a patch**, **map Figma components to code like Code Connect (no Dev seat needed)**, and **match a running app to its mockup** with a codebase-aware visual-diff loop — to any client that speaks MCP: Claude Desktop, Claude Code, Cursor, Cline, etc.

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
- `call <tool> [json | @file | -]` — call one tool without an MCP client and print its JSON; exits 1 on `ok: false`. `tools` lists them. E.g. `npx figbridge-mcp call lint_connect '{}'` in CI.
- `diff_specs` accepts a URL or captured spec JSON path for each side (`mockupUrl`/`mockupSpecPath`, `appUrl`/`appSpecPath`). This lets a Playwright Electron capture use the exact same structured diff and source mapping as browser URLs; capture with the bundled `src/dom-to-spec.js` after the UI state settles. When Figma and DOM nesting differ, pass explicit `anchors` (`mockupId`/`mockupName` ↔ `appTestid`) and optional per-anchor `fields`. Without `fields`, an anchor checks every captured field on either side; missing values appear in `coverage.unmeasured` and prevent PASS. An explicit `fields` list limits the comparison to those values. The returned `coverage` includes each unpaired node's path and Figma ID or app test ID, so reviewers can expand the mapping without guessing which screen areas were omitted. It also exposes missing or ambiguous pairs, captured node counts, and `wholeScreenCertified: false`. A comparison can certify only its captured state and selected anchors, so enumerate all important screen regions before treating a screen as matched.
- `bridge` — start only the local HTTP+SSE bridge and keep it alive after stdin closes. Use for persistent local agent sessions and direct `POST /command` calls.
- `doctor` — reap orphan `figbridge-mcp` processes (a failed shutdown can leave :7331 held), and probe 7331..7340 for live bridges. Run if Claude shows "Server disconnected" or the plugin can't connect.

## MCP registry

Also listed on the official [Model Context Protocol registry](https://registry.modelcontextprotocol.io/) as `io.github.rudraptpsingh/figbridge`. Clients that read the registry can discover + install without config edits. Verify: `curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.rudraptpsingh/figbridge"`.

## Ports

The HTTP+SSE bridge binds `127.0.0.1:7331` by default and auto-falls-back to 7332..7340 if something's already holding it. The Figma plugin probes the same range. Override the preferred starting port with `FIGBRIDGE_PORT=NNNN`.

For direct local workflows that should survive short-lived terminal sessions, run:

```
npx figbridge-mcp bridge
```

Normal MCP mode exits when stdin closes so MCP clients can clean up correctly. Bridge-only mode is intentionally persistent and exits only on process signals.

## Tools

**Read** · `get_current_selection` · `get_last_export` · `list_history` · `get_tokens` · `bridge_status` · `diff_since` · `list_pages` · `list_frames`

**Catalog** · `list_screens` · `list_components` · `describe_screen` · `export_app_spec` · `export_all_pages` · `list_assets` · `select_node` · `export_node`

**Act & Handoff** · `get_agent_bundle` · `clone_screen` · `recolor` · `apply_tokens` · `lint_ds`

**Browser** · `preflight_import` (risk check before import, including font download URLs) · `import_url` (live URL → Figma frame; optional `hybridSnapshot` screenshot reference) · `import_responsive_set` (desktop / tablet / mobile and optional light / dark theme captures) · `import_url_batch` (bulk URL imports) · `screenshot_url` · `probe_url` · `fingerprint_url` · `audit_interactions` (hover / focus discovery) · `verify_text_fidelity` · `measure_fidelity` · `audit_regression` (baseline URL vs candidate URL frontend/UI regression audit)

**Pillar 1 — round-trip editing** · `diff_to_source` (per-text-node field diff between an imported Figma frame and the live source) · `generate_patch` (turn the diff into a minimal HTML/JSX patch against a source dir)

**Pillar 2 — design intelligence audits** · `audit_palette` · `audit_typography` · `audit_a11y` (WCAG 2.x contrast, landmarks, alt text) · `audit_whitespace` (padding/gap rhythm, 4/8-grid conformance) · `audit_mobile` (multi-viewport responsive: horizontal scroll, overflow-x, sub-44px touch targets, sub-12px text)

All audits return deterministic numbers — no model rewrites. `audit_regression` is the before/after gate: screenshot pixel diff, disappeared visible text, responsive issue deltas, and CSS-feature drift across desktop/tablet/mobile.

**Code Connect** · `connect_components` (seed / edit a `figbridge.connect.json` in your repo: Figma component → code component, props map, example) · `get_code_connect` (the mapped component, props and a ready-to-paste JSX snippet for an instance — also shown in the plugin's Code tab) · `lint_connect` (fails when a file, export, prop, literal value or Figma property in the map no longer exists). Details: [Code Connect without a Dev seat](https://github.com/rudraptpsingh/figbridge#code-connect-without-a-dev-seat).

**Pillar 3 — match the mockup** · `match_mockup` (matched-state pixel and structured comparison, including viewport position and size) · `diff_specs` (fast structured comparison; pass `sourceDir` to see mapped TSX class rules and exact dimension edits when a unique literal exists) · `map_components` (data-testid and `figbridge.connect.json` source mapping, plus Figma-exported versus generated dimension-token drift). Dynamic dimensions stay unresolved until inspected.

For an actionable design review, compare the same viewport, content and UI state. `match_mockup` compares two rendered URLs; it does not inspect a native Electron window or reconstruct Figma layer values from a screenshot. Export the Figma state as an inspectable reference and capture the app's matching state. The report now pairs uniquely named siblings before positional fallback, reports explicit `data-state` mismatches, and includes `summary.omittedIssues` when a delta cap hides findings. Comparable values are exact by default, including one-pixel geometry and subtle authored colours; pass `tolerant: true` for the previous perceptual/numeric thresholds. A failed or truncated structured comparison cannot return `pass: true`. Repeated generic nodes, image content and dynamic layout still require inspection; treat an unmatched state as review evidence, not a certified whole-screen match.

Base style kits ship under `kits/` (tokens + primitives per design language; cinematic-dark first) so design and code production start from a known-good, tokens-driven foundation.

## The agent handoff bundle

`get_agent_bundle` returns a zip an agent can ship from *offline*: `hierarchy.md`, `components.json`, `tokens.json`, `tokens.css`, `AGENTS.md`, `DESIGN.md`, `CHANGES.md`, `ISSUES.md`, `flow.mmd`, `responsive.md`, `manifest.json` (sha-256 + token counts), `screenshots/`.

Three budget tiers (`small` 8k / `medium` 32k / `large` 128k tokens). Deterministic slugs that survive renames, so `CHANGES.md` is a real surgical diff instead of a whole-file retranslation.

## Repo

https://github.com/rudraptpsingh/figbridge (MIT)
