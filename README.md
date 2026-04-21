# Figbridge

**Figma → Code, read by any AI agent.** Free, local, no Dev seat, no account.

Figbridge is a Figma plugin + local MCP server. You open the plugin, click a frame, and any MCP-capable AI agent (Claude Desktop, Cursor, Continue, etc.) can instantly read the current selection as deterministic **HTML / CSS / Tailwind / design-tokens** — no Personal Access Token, no Figma Dev Mode subscription, no cloud round-trip.

```
┌──────────┐     postMessage      ┌──────────┐    HTTP POST    ┌───────────────┐     stdio     ┌──────────────┐
│  Figma   │ ───────────────────▶ │  Plugin  │ ──────────────▶ │  MCP Server   │ ◀──────────── │  AI agent    │
│  Desktop │                      │   UI     │   :7331/push    │  (localhost)  │   tools/call  │  (Claude …)  │
└──────────┘                      └──────────┘                 └───────────────┘               └──────────────┘
```

## Why

Figma's own [Dev Mode MCP](https://help.figma.com/hc/en-us/articles/32132100833559) requires a **paid Dev seat ($25/mo)** and only emits **React + Tailwind**. Third-party plugins like Anima / Codejet / Builder.io all require accounts and run in the cloud.

Figbridge:
- **Free.** MIT. Runs entirely on your machine.
- **No account, no token.** Uses your existing Figma desktop session.
- **Multi-format.** HTML/CSS, Tailwind, design tokens (as JSON, CSS vars, Tailwind config) — all from one click.
- **Deterministic.** No LLM rewrites. What you select is what you get.
- **Live.** Toggle "Live bridge" and every selection change auto-pushes; agents pull the current selection instantly.

## Install

### 1. Install the MCP server

```bash
cd mcp && npm install
```

### 2. Wire it into Claude Desktop (or any MCP client)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "figbridge": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/figbridge/mcp/bin/figbridge-mcp.js"]
    }
  }
}
```

Restart Claude Desktop. You should see the `figbridge` server listed with its tools.

### 3. Install the Figma plugin (development mode)

1. Open Figma desktop.
2. Menu → **Plugins → Development → Import plugin from manifest…**
3. Choose `plugin/manifest.json` from this repo.
4. Run the plugin from **Plugins → Development → Figbridge**.

## Use

1. Open any Figma file.
2. Run the Figbridge plugin.
3. Select a frame, click **Export selection** — or toggle **Live bridge** so every selection auto-pushes.
4. In Claude / Cursor / whatever: `"Use figbridge.get_current_selection with format=html"` (or `tailwind`, `css`, `tokens`).

## MCP tools exposed

| Tool | Returns |
|---|---|
| `get_current_selection({ format })` | Latest pushed selection. `format` ∈ `html` \| `css` \| `tailwind` \| `tokens` \| `cssVars` \| `tailwindConfig` \| `all` (default). |
| `get_last_export` | Alias of the above. |
| `list_history` | Metadata for the last 25 selections pushed. |
| `get_tokens` | Just the design-token payload. |
| `bridge_status` | Health + whether a payload is loaded. |

## Output formats

| Format | Shape |
|---|---|
| **HTML + CSS** | Single self-contained `<html>` document, positional absolute layout preserving pixel fidelity. |
| **Tailwind** | Same tree with Tailwind arbitrary-value utilities (`w-[120px]`, `bg-[#ff7a29]`, etc.) + CDN script. No config needed. |
| **Design tokens** | JSON tree of color / number / string / boolean variables, a `:root { --var: value }` CSS file, and a `tailwind.config.js` fragment. Reads Figma Variables + local paint styles. |

## Architecture

- **Plugin main thread** (`plugin/code.js`): reads the node tree, computes HTML/CSS/Tailwind/tokens deterministically. ES2017-safe (no spread / `??` / `?.`) to satisfy the Figma sandbox.
- **Plugin UI** (`plugin/ui.html`): thin shell, tabs for each format, `fetch()` to `http://localhost:7331/push` when live bridge is on.
- **MCP server** (`mcp/src/`): stdio MCP using `@modelcontextprotocol/sdk`, plus a sibling HTTP server on `:7331` that accepts plugin pushes. State is in-memory and persisted to `~/.figbridge/last.json`.

## What Figbridge does *not* do

- It does not reach into Figma without your desktop app + plugin open. No REST API, no PAT.
- It does not rewrite code with AI. It's a deterministic tree walker.
- It does not publish anything to Figma or to the cloud.

## Development

```bash
cd mcp && npm install && npm test   # end-to-end smoke test
node --check plugin/code.js         # plugin syntax check
```

## License

MIT © Rudra Pratap Singh
