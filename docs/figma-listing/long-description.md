# Figbridge — free, local MCP bridge for Figma

Figbridge gives AI coding agents — Claude Desktop, Claude Code, Cursor, Continue, or any MCP-speaking client — a live connection to the Figma file you have open. No Dev Mode seat. No cloud. Nothing leaves your machine.

## What it does

Install the plugin, run one command (`npx figbridge-mcp init`) on your machine, and your agent gets **seventeen tools** for working with Figma:

**Read**
- list_screens, describe_screen — enumerate top-level frames and their structure
- list_components, get_component — inspect library components and variants
- export_app_spec — one-shot screen + tokens + component inventory, ready to paste into a prompt
- get_current_selection — what the user is looking at right now
- get_image — rendered PNG of any node
- list_assets — every exportable node with suggested filenames
- list_variables — design tokens (color, number, string, boolean)

**Review**
- lint_ds — design-system audit: unbound colors, non-grid spacing, duplicate names, orphan styles, detached instances; grouped by rule with counts

**Write**
- recolor — swap a color across a frame
- apply_tokens — retype a frame to match a token set
- clone_screen — duplicate a screen with edits
- translate_frame — machine-translate text while preserving layout
- set_variable — update a design token

**Bridge**
- bridge_status, list_pages — health and context

## Why people install it

- **Free.** MIT licensed. No subscription, no seat, no account.
- **Local.** The bridge is a Node process on your machine at `http://localhost:7331`. No design data is ever sent to a third party.
- **Works with what you already have.** Any MCP client — Claude Desktop, Claude Code, Cursor, Continue, VS Code via Continue, your own agent — can call it.
- **Read *and* write.** Most Figma integrations stop at read. Figbridge lets agents make real edits you can undo, so an agent can actually fix the design-system issues it finds.
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

Source, docs, slash commands, and an example `/design-review` workflow: https://github.com/rudra-rps/figbridge

## Privacy

Figbridge talks only to `http://localhost:7331` — a server you run on your own machine. It contacts no external services. It has no analytics, no telemetry, no account system. If you close the bridge, the plugin becomes a local-only export tool.

MIT licensed · Plugin & bridge source on GitHub · Issues and PRs welcome.
