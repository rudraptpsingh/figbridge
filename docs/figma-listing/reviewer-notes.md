# Notes for the Figma Community reviewer

Thanks for reviewing Figbridge. A few notes to make testing fast.

## What the plugin is

Figbridge is a local bridge plugin. It opens a connection to a small Node program (`figbridge-mcp`) that the user runs **on their own machine** at `http://localhost:7331`. The bridge then exposes MCP tools to AI coding agents (Claude Desktop, Cursor, etc.) so they can read and edit the Figma file the user is in.

**No data leaves the user's machine.** The plugin contacts no external servers. There is no account system, no analytics, no telemetry.

## Why `networkAccess` requests `http://localhost:7331`

Figma requires every network destination to be declared. Since the bridge is a loopback server the user runs themselves, we declare `http://localhost:7331`. That is the only domain in the allowlist. Figma rejects raw IPs (`127.0.0.1`), so `localhost` is the canonical form.

## Testing without installing the bridge

The plugin **works on its own** without the bridge:

1. Open any Figma file.
2. Run the Figbridge plugin.
3. The panel opens showing an **Export** tab. Select a frame and click "Export app spec" — you will get a JSON spec with screens, tokens, and a component inventory. This works fully offline.
4. The **Live bridge** toggle will show "disconnected" (red dot). That is expected if the bridge process is not running. Toggling it with no bridge running is safe — it simply fails to open the SSE connection and shows an error state.

No further setup is needed to review the plugin. Everything past the bridge toggle is optional and requires the user to install the companion Node program separately.

## If you want to test with the bridge end-to-end

1. Install Node 18+.
2. In a terminal: `npx figbridge-mcp` (starts the bridge on port 7331).
3. In the plugin, toggle **Live bridge** on — the dot turns green.
4. In another terminal: `curl http://localhost:7331/health` returns `{ "ok": true, "pluginConnected": true }`.

Source for both plugin and bridge: https://github.com/rudra-rps/figbridge

## Contact

- Author: Rudra Pratap Singh
- Email: rudra.ptp.singh@gmail.com
- Issues: https://github.com/rudra-rps/figbridge/issues
