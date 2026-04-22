# Publishing Figbridge to the Figma Community

This is the checklist to submit the plugin so users can search and install it like any other Figma plugin. Start to finish: ~30 minutes, most of it waiting for Figma review.

## Prerequisites

- A Figma account (free is fine).
- A Figma organization / team you own (required to publish — personal files cannot publish plugins).
- The `figbridge` source cloned locally.
- Node 18+ (for testing the bridge).

## 1. Final local test

```sh
cd mcp && npm install && npm run build
cd ../plugin && open -a Figma
```

In Figma Desktop: **Plugins → Development → Import plugin from manifest…** → pick `plugin/manifest.json`.

Run the plugin. Make sure:

- The panel opens and shows the **Export** and **Live bridge** tabs.
- With the bridge stopped, the Live bridge tab says "disconnected" and the plugin otherwise works.
- `npx figbridge-mcp init` from a fresh shell writes the MCP entry to Claude Desktop's config.
- After starting the bridge (`npx figbridge-mcp`), toggling Live bridge on turns the dot green and `curl http://localhost:7331/health` returns `{ "pluginConnected": true }`.

## 2. Confirm the listing assets are in place

Everything lives under `docs/figma-listing/`:

- `cover.png` — 1920×960, exported from `cover.html` via headless Chrome.
- `icon.png` — 128×128, exported from `icon.html`.
- `tagline.txt` — ≤ 100 char plugin tagline.
- `short-description.txt` — ≤ 280 char listing summary.
- `long-description.md` — full listing body (paste this into the "Description" field on Figma).
- `tags.txt` — up to 12 tags to paste into the "Tags" field.
- `reviewer-notes.md` — paste into the "Notes for reviewer" field.
- `privacy-policy.md` — host this at `https://rudraptpsingh.github.io/figbridge/privacy` (or equivalent) and paste the URL.

## 3. Host the privacy policy and support page

The privacy policy must be at a public URL. The repo's GitHub Pages site (`docs/`) already serves the landing page; add a `docs/privacy.html` wrapping `figma-listing/privacy-policy.md` and commit.

Support URL for the listing: https://github.com/rudraptpsingh/figbridge/issues

## 4. Record the listing media

Figma expects screenshots in addition to the cover. Record these in order — the first is what shows up in search:

1. **Export tab** with a real frame selected. The JSON spec panel should be mid-scroll so the viewer sees structure.
2. **Live bridge** turned on, green dot, "Connected to figbridge-mcp".
3. **A Claude Code session** with `/design-review` running against the file — show the lint output as rendered markdown.
4. **Cursor calling `export_app_spec`** with the result pasted back into a chat turn.
5. (Optional) A short GIF of `recolor` or `clone_screen` executing — before/after.

Save them as 1920×1200 PNGs (or MP4 for video) under `docs/figma-listing/screenshots/`.

## 5. Publish the plugin

In Figma Desktop, with the plugin loaded via manifest:

1. **Plugins → Development → Figbridge → Publish new release…**
2. Name: `Figbridge`
3. Tagline: paste `tagline.txt`.
4. Description: paste the body of `long-description.md`.
5. Tags: paste `tags.txt` (one per field, up to 12).
6. Cover art: upload `cover.png`.
7. Icon: upload `icon.png`.
8. Screenshots: upload the recordings from step 4 in order.
9. Support contact: `rudra.ptp.singh@gmail.com`.
10. Playground file: (optional) a minimal Figma file with one frame and a component library so reviewers can test without their own content.
11. Notes to reviewers: paste `reviewer-notes.md`.
12. Creator Fund payout: skip for now (free plugin).

Click **Submit for review**.

## 6. While waiting for review

Figma review is usually 5–10 business days. Use the time to:

- Write a launch post with the `/design-review` workflow as the hook.
- Make a 60-second demo video (screen recording of Claude Code calling `export_app_spec → lint_ds → recolor`).
- Submit the bridge to `awesome-mcp-servers` lists and the MCP directory.

## 7. After approval

- Cut a release with `node scripts/release.mjs patch` (or `minor` / `major` / explicit `X.Y.Z`). The script refuses to run on dirty trees, off main, or when local is behind origin, so it's hard to misfire. It bumps `mcp/package.json`, commits `chore(release): vX.Y.Z`, tags, and pushes. The `Publish figbridge-mcp to npm` workflow then runs smoke + full pipeline + tool-surface tests, `npm publish --provenance`s, verifies the registry, and creates a GitHub Release with notes grouped by commit prefix (feat/fix/docs/ci|chore). Add `--dry` to the script to preview without mutating.
- ~~Publish the bridge to npm so `npx figbridge-mcp` works without a git clone: `cd mcp && npm publish --access public`.~~ **Done:** `figbridge-mcp` is live on npm (https://www.npmjs.com/package/figbridge-mcp). `npx figbridge-mcp init` works cold.
- **Users auto-update.** Since 0.1.2, `init` writes `{ command: "npx", args: ["-y", "figbridge-mcp@latest"] }` into Claude Desktop's config, so every Claude launch pulls the current release. No action needed from users after a new npm publish. Earlier installs (≤ 0.1.1) pinned an absolute path and need to run `npx figbridge-mcp@latest update` once to self-heal — call this out in release notes.
- Update the landing page at `docs/index.html` with the Figma Community URL once it is live.

## 8. Rejections — common causes

- **"Network access is too broad."** We declare only `http://localhost:7331`. If asked to justify, point to `reviewer-notes.md`.
- **"What does the plugin do without the bridge?"** The Export tab is fully functional standalone; reviewer-notes explains this.
- **"Tell us what data is sent."** Nothing is sent off the machine. See `privacy-policy.md`.

## 9. After launch

- Watch GitHub issues for install failures — the `init` command is the most likely break point (Claude Desktop config path differs per OS).
- Pin a "Start here" issue with the three install commands and the video link.
- Every update goes through the same publish flow (step 5) — bump `version` in `plugin/manifest.json` first.
