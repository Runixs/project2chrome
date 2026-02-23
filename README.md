# project2chrome

Obsidian plugin that mirrors a target vault folder tree into Chrome bookmark bar folders,
and extracts links from `### Link` bullet lists inside markdown files.

## Build

```bash
npm install
npm run build
```

Built plugin output:

- `dist/plugin/main.js`
- `dist/plugin/manifest.json`

## Test

```bash
npm run test
npm run typecheck
```

## Runtime notes

- Plugin is desktop-only.
- OS-specific Chrome Bookmarks paths are configurable in plugin settings.
- Sync target is created under a configurable bookmark bar root folder.
- Close Chrome before heavy sync operations to avoid concurrent write conflicts.

## Design docs location

Process and architecture documents are stored in the Obsidian vault at:

- `1_Projects/project2chrome`
