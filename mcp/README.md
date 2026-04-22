# figbridge-mcp

Free, local MCP bridge for Figma. Runs on 127.0.0.1. No account, no cloud, no Dev Mode seat.

Exposes 21 MCP tools — read screens, export tokens, lint the design system, recolor, clone frames, build an offline **agent handoff bundle** — to any client that speaks MCP: Claude Desktop, Claude Code, Cursor, Cline, etc.

## Install

```
npx figbridge-mcp init
```

This patches your Claude Desktop config and prints the steps for importing the Figma plugin. Then:

1. Quit and reopen Claude Desktop.
2. In Figma: **Plugins → Development → Import plugin from manifest…** and pick `plugin/manifest.json` from the [repo](https://github.com/rudraptpsingh/figbridge).
3. Run the Figbridge plugin, toggle **Live bridge** on.
4. In Claude: *"What tools does figbridge expose?"* — you should see 21.

## Tools

**Read** · `get_current_selection` · `get_last_export` · `list_history` · `get_tokens` · `bridge_status` · `diff_since` · `list_pages` · `list_frames`

**Catalog** · `list_screens` · `list_components` · `describe_screen` · `export_app_spec` · `export_all_pages` · `list_assets` · `select_node` · `export_node`

**Act & Handoff** · `get_agent_bundle` · `clone_screen` · `recolor` · `apply_tokens` · `lint_ds`

## The agent handoff bundle

`get_agent_bundle` returns a zip an agent can ship from *offline*: `hierarchy.md`, `components.json`, `tokens.json`, `tokens.css`, `AGENTS.md`, `DESIGN.md`, `CHANGES.md`, `ISSUES.md`, `flow.mmd`, `responsive.md`, `manifest.json` (sha-256 + token counts), `screenshots/`.

Three budget tiers (`small` 8k / `medium` 32k / `large` 128k tokens). Deterministic slugs that survive renames, so `CHANGES.md` is a real surgical diff instead of a whole-file retranslation.

## Repo

https://github.com/rudraptpsingh/figbridge (MIT)
