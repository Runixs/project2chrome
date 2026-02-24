# Project2Chrome

Project2Chrome is an Obsidian desktop plugin + Chrome extension bridge that mirrors a vault folder tree into Chrome bookmarks.

## What It Does

- Mirrors a target vault folder recursively into Chrome bookmark folders.
- Extracts links from `### Link` sections in markdown files.
- Syncs on vault changes (create/modify/delete/rename) with debounce.
- Maintains managed bookmark/folder state to update existing nodes instead of duplicating.
- Uses Chrome extension API (`chrome.bookmarks`) for cross-platform sync.

## Requirements

- Obsidian desktop (plugin is desktop-only).
- Chrome extension loaded from `dist/extension`.
- Node.js 20+ and npm (for local build/test).

## Quick Start (Development)

```bash
npm install
npm run build
```

Build artifacts:

- `dist/plugin/main.js`
- `dist/plugin/manifest.json`
- `dist/extension/manifest.json`
- `dist/extension/background.js`
- `dist/extension/popup.html`
- `dist/extension/popup.js`

## Install In Obsidian (Manual)

1. Build the plugin.
2. Copy `dist/plugin/main.js` and `dist/plugin/manifest.json` into:
   `.obsidian/plugins/project2chrome/`
3. Reload Obsidian and enable **Project2Chrome** in Community Plugins.

## Plugin Settings

- `Target folder path`: Vault-relative root folder to mirror (example: `Projects`).
- `Link heading`: Heading text used for extraction (default: `Link` for `### Link`).
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
3. Click `Load unpacked` and select `dist/extension`.
4. Open extension popup and set:
   - Bridge URL: `http://127.0.0.1:27123/payload`
   - Bridge token: same value as plugin setting
5. Click `Sync From Obsidian` once, then enable `Auto sync every 1 minute`.

## Link Extraction Format

Inside a markdown note, links are read from bullet items under `### Link`:

```markdown
### Link
- [Project board](https://example.com/board)
- https://example.com/docs
```

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
