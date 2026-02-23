# Project2Chrome

Project2Chrome is an Obsidian desktop plugin that mirrors a vault folder tree into Chrome's bookmark bar and imports links from markdown sections.

## What It Does

- Mirrors a target vault folder recursively into Chrome bookmark folders.
- Extracts links from `### Link` sections in markdown files.
- Syncs on vault changes (create/modify/delete/rename) with debounce.
- Maintains managed bookmark/folder state to update existing nodes instead of duplicating.
- Supports macOS, Linux, and Windows bookmark file paths.

## Requirements

- Obsidian desktop (plugin is desktop-only).
- Chrome profile with a writable `Bookmarks` JSON file.
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
- `Link heading`: Heading text used for extraction (default: `Link` for `### Link`).
- `Root folder mode`:
  - `Custom`: use `Custom root folder name`
  - `Use target folder name`: use the last segment of target path
- `Chrome Bookmarks file (macOS/Linux/Windows)`: OS-specific bookmarks JSON path.
- `Auto sync`: enable sync on vault events.
- `Debounce (ms)`: delay before running sync after vault events.

Default bookmark file paths:

- macOS: `~/Library/Application Support/Google/Chrome/Default/Bookmarks`
- Linux: `~/.config/google-chrome/Default/Bookmarks`
- Windows: `~/AppData/Local/Google/Chrome/User Data/Default/Bookmarks`

## Link Extraction Format

Inside a markdown note, links are read from bullet items under `### Link`:

```markdown
### Link
- [Project board](https://example.com/board)
- https://example.com/docs
```

## Commands

- `Sync to Chrome bookmarks now`: trigger full sync immediately.

## Test And Typecheck

```bash
npm run test
npm run typecheck
```

## Safety Notes

- Close Chrome before heavy sync operations to reduce write conflicts.
- This plugin edits Chrome's `Bookmarks` JSON file directly.
- Keep a backup copy of your `Bookmarks` file before first use.
