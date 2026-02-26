# Project2Chrome

Project2Chrome is an Obsidian desktop plugin that synchronizes bookmark intent with `local-event-gateway` using a WebSocket action protocol.

## What It Does

- Builds desired bookmark tree from a target vault folder.
- Emits startup snapshot and edit-driven action updates.
- Applies inbound bookmark actions back into notes/folder-note metadata.
- Supports multi-client bridge auth profiles.
- Preserves loop safety via dedupe/suppression behavior.

## Requirements

- Obsidian desktop.
- Chrome extension: `local-event-gateway`.
- Node.js 20+ and npm for local development.

## Development

```bash
npm install
npm run test
npm run typecheck
npm run build
```

## Plugin Settings

- Target/content settings:
  - `Target folder path`
  - `Link heading`
  - `Folder Notes Plugin Use`
  - `Root folder mode`
  - `Custom root folder name`
- Bridge settings:
  - `Extension bridge enabled`
  - `Extension bridge port`
  - `Extension bridge path`
  - `Extension bridge heartbeat (ms)`
  - `Active bridge client ID`
  - `Active bridge client token`
- Runtime settings:
  - `Auto sync`
  - `Debounce (ms)`

## Transport

- Plugin hosts local WebSocket bridge on configured localhost port/path.
- Bridge authenticates clients using per-client token handshake.
- Action envelopes are validated and ACKed with deterministic statuses.

## Reverse Apply Semantics

- Supported ops: `bookmark_created`, `bookmark_updated`, `bookmark_deleted`, `folder_renamed`, `bookmark_moved`.
- Unknown/unresolvable targets return explicit skip/reject statuses.
- Managed-key guardrails are derived from latest payload snapshot and enforced during live apply.
- Title/URL payload values are accepted as strings without content-level scheme gating.

## Commands

- `Refresh payload for Chrome extension`
- `Show reverse sync debug snapshot`
- `Clear reverse sync debug log`

## Notes on Link Parsing

- Markdown links are parsed under the configured heading.
- Empty/custom URL strings are supported at sync-layer string level.
- Type/shape validation remains enforced by protocol validators.
