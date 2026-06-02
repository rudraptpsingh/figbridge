# Figbridge Capture Chrome Extension

Companion extension for authenticated/current-tab capture.

## Install locally

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this `chrome-extension/` folder.
5. Start Figbridge MCP and open the Figbridge Figma plugin with **Live bridge** enabled.

## What it does

- Sends the visible viewport to Figbridge over `http://127.0.0.1:7331..7340`.
- Can opt into slower full-page DOM capture for long pages.
- Lets you pick one element on the page, reopen the popup, and send only that element.
- Can include a visible-viewport screenshot reference beneath editable layers.
- Groups captures into separate Figma pages per website or project when the plugin supports `pageName`.
- Does not use cloud services or external APIs.

The extension posts `import-from-code` commands to the same local bridge used by the MCP server.
