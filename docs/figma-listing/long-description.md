# Figbridge — free, local MCP bridge for Figma

Figbridge gives AI coding agents — Claude Desktop, Claude Code, Cursor, Continue, or any MCP-speaking client — a live connection to the Figma file you have open. It is free, open source, local, and built for community workflows.

## What it does

Install the plugin, run one command (`npx figbridge-mcp init`) on your machine, and your agent gets **twenty-one tools** for working with Figma, plus an offline **agent handoff bundle** that's ready to ship from even without a live connection.

**Read**
- get_current_selection — what the user is looking at right now (HTML / CSS / Tailwind / tokens)
- get_last_export, list_history — recent pushes with SHA fingerprints
- get_tokens — tokens + CSS vars + Tailwind config
- bridge_status — health and plugin-connected state
- diff_since — history after a timestamp
- list_pages, list_frames — page + frame catalog by id

**Catalog**
- list_screens — top-level frames, categorized by name
- list_components — components and component sets with variants
- describe_screen — semantic summary: size, bg, text, components used
- export_app_spec — one-shot JSON spec of the whole file + flows
- export_all_pages — walk every page, merged output
- list_assets — base64 SVG/PNG dump of icons, images, illustrations
- select_node, export_node — focus or export a specific node

**Act & Handoff**
- get_agent_bundle — offline zip: hierarchy.md, components.json, tokens.*, AGENTS.md, CHANGES.md, flow.mmd, responsive.md, ISSUES.md, manifest.json, screenshots
- clone_screen — duplicate a frame, optional text replacements
- recolor — swap hex colors across selection / page / file
- apply_tokens — bind loose fills to matching local color variables
- lint_ds — design-system audit: unbound colors, non-grid spacing, duplicate names, orphan styles

## Why people install it

- **Free.** MIT licensed. No subscription, no seat, no account.
- **Local.** The bridge is a Node process on your machine at `http://localhost:7331`. No design data is ever sent to a third party.
- **Works with what you already have.** Any MCP client — Claude Desktop, Claude Code, Cursor, Continue, your own agent — can call it.
- **Read *and* write.** Most Figma integrations stop at read. Figbridge lets agents make real edits you can undo, so an agent can actually fix the design-system issues it finds.
- **Offline agent handoff.** `get_agent_bundle` produces a zip that agents can ship from without a live MCP connection — hierarchy, tokens, components, a11y issues, and a `CHANGES.md` diff since the last bundle so agents edit surgically.
- **60 seconds to install.** `npx figbridge-mcp init` writes the MCP entry to your Claude config. Open the plugin, toggle the Live bridge on.

## How it works

```
Figma (this plugin)  ⇄  figbridge-mcp (localhost:7331)  ⇄  any MCP client
              POST /push                     stdio MCP
              SSE  /events
```

The plugin opens a Server-Sent Events connection to the local bridge. Agents call MCP tools; the bridge forwards them to the plugin; the plugin reads or mutates the file and returns the result. Everything is on your machine.

## Install

1. Install this plugin from Figma Community.
2. In a terminal: `npx figbridge-mcp init`
3. Restart your MCP client (Claude Desktop, etc.).
4. Open this plugin and toggle **Live bridge** on.

Source, docs, slash commands, and an example `/design-review` workflow: https://github.com/rudraptpsingh/figbridge

## Privacy

Figbridge talks only to `http://localhost:7331` — a server you run on your own machine. It contacts no external services. It has no analytics, no telemetry, no account system. If you close the bridge, the plugin becomes a local-only export tool.

MIT licensed · Plugin & bridge source on GitHub · Issues and PRs welcome.
