# Project2Chrome

Project2Chrome is an Obsidian desktop plugin that builds and serves a bookmark payload for a separate Chrome extension gateway.

## What It Does

- Mirrors a target vault folder recursively into Chrome bookmark folders.
- Creates a bookmark folder per markdown note, and keeps that note's links inside it.
- Supports Folder Notes mode: links from a folder-note file (same name as folder) are attached directly to the folder node.
- Extracts links from `### Link` sections in markdown files.
- Preserves markdown bullet order exactly and keeps duplicate URLs as separate bookmark entries.
- Syncs on vault changes (create/modify/delete/rename) with debounce.
- Serves bridge payload over localhost for extension-side sync.

## Requirements

- Obsidian desktop (plugin is desktop-only).
- Chrome extension project: [Runixs/local-event-gateway](https://github.com/Runixs/local-event-gateway) (recommended source of truth).
- Node.js 20+ and npm (for local build/test).

## Quick Start (Development)

```bash
npm install
npm run build
```

Build artifacts:

- `dist/plugin/main.js`
- `dist/plugin/manifest.json`

## Install In Obsidian (Manual)

1. Build the plugin.
2. Copy `dist/plugin/main.js` and `dist/plugin/manifest.json` into:
   `.obsidian/plugins/project2chrome/`
3. Reload Obsidian and enable **Project2Chrome** in Community Plugins.

## Plugin Settings

- `Target folder path`: Vault-relative root folder to mirror (example: `Projects`).
- `Link heading`: Heading text used for extraction (supports `Link` or `### Link`, default `Link`).
- `Folder Notes Plugin Use`: when enabled, a folder-note markdown file (same name as its folder) contributes links directly to that folder node instead of creating a duplicated child note folder.
- `Root folder mode`:
  - `Custom`: use `Custom root folder name`
  - `Use target folder name`: use the last segment of target path
- `Auto sync`: enable sync on vault events.
- `Debounce (ms)`: delay before running sync after vault events.
- `Extension bridge enabled`: serve payload to localhost bridge endpoint.
- `Extension bridge port`: localhost port (default `27123`).
- `Extension bridge token`: shared token used by extension request header.

## Extension Setup (Automated Sync)

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Clone/use [Runixs/local-event-gateway](https://github.com/Runixs/local-event-gateway), then click `Load unpacked` and select your local clone path.
4. Open extension popup and set:
   - Bridge URL: `http://127.0.0.1:27123/payload`
   - Bridge token: same value as plugin setting
5. Click `Sync From Obsidian` once, then enable `Auto sync every 1 minute`.

## Link Extraction Format

Inside a markdown note, links are read from bullet items under the configured heading (for example `Link` or `### Link`) only when they use markdown hyperlink format `[name](url)`:

```markdown
### Link
- [Project board](https://example.com/board)
```

Notes:
- Bare URLs (for example `- https://example.com/docs`) are ignored.
- Only `http`/`https` links with a markdown label are added as bookmarks.
- Each markdown note becomes its own bookmark folder; links from that note are stored in that folder.
- If note frontmatter has `bookmark_name`, that value is used as the bookmark folder name for the note.
- Link order follows bullet order in the note.
- Duplicate URLs are allowed and kept as separate entries.

## Folder Notes Mode Example

When `Folder Notes Plugin Use` is enabled and a folder contains a note file with the same name as the folder:

```text
APS-45429/
  APS-45429.md
  APS-47235.md
```

The bookmark structure is generated as:

```text
APS-45429/
  <links from APS-45429.md>
  APS-47235/
    <links from APS-47235.md>
```

If `APS-45429.md` contains frontmatter `bookmark_name: "[VN] Host bootloader"`, the folder node name becomes `[VN] Host bootloader`.

## Commands

- `Refresh payload for Chrome extension`: rebuild payload served by local bridge.

## Test And Typecheck

```bash
npm run test
npm run typecheck
```

## Bridge Endpoint

- Health: `GET http://127.0.0.1:<port>/health`
- Payload: `GET http://127.0.0.1:<port>/payload`
- Required header: `X-Project2Chrome-Token: <token>`
