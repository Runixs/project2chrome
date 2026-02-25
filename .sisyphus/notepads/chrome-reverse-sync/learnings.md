# Learnings - chrome-reverse-sync

## [2026-02-25] Session Init

### Codebase Conventions
- Plugin repo: `/Users/runixs/working_local/obsidian/project2chrome/`
- Extension repo: `/Users/runixs/working_local/chrome/local-event-gateway/`
- Plugin uses TypeScript + node:test; extension is plain MV3 JS
- Test command: `npm run test && npm run typecheck && npm run build` (plugin)
- Extension check: `node --check background.js && node --check popup.js`
- Existing types in `src/plugin/types.ts`, payload in `src/plugin/extension-payload.ts`
- Bridge server in `src/plugin/main.ts` at port 27123 with `X-Project2Chrome-Token` header auth
- Managed keys: folders = `folder:<path>`, notes = `note:<path>`, links = `<sourcePath>|<linkIndex>`
- `managedFolderIds` and `managedBookmarkIds` stored in `chrome.storage.local`
- `bookmark_name` frontmatter already implemented in `src/plugin/frontmatter.ts`
- Folder-note detection in `model-builder.ts:43`

### MV3 Constraints
- Service workers can terminate at any time → must use `chrome.alarms` + durable queue in `chrome.storage.local/session`
- `chrome.bookmarks.onRemoved` fires ONCE for entire subtree root (not per child)
- `chrome.bookmarks.onChanged` only fires for title/url changes (not structural)
- `chrome.bookmarks.onCreated` must be gated during import window (onImportBegan/onImportEnded)
- ALL bookmark event listeners MUST be registered at top-level synchronously in MV3 service worker

### Loop Prevention Design
- apply-epoch suppression flag + per-node cooldown + crash-safe reset
- NOT just in-memory flags (must survive worker restart)

### V1 Scope Guardrails
- Must NOT delete Obsidian note files/folders from Chrome-side deletes
- Must NOT mutate unmanaged bookmarks or unrelated vault paths
- Must NOT register bookmark listeners lazily/inside async callbacks
- Must NOT rely only on volatile in-memory timers for queue flush
- Must NOT reorder unrelated markdown sections outside target heading/frontmatter fields
- Do NOT change existing GET /payload response format or current extension pull flow

## [2026-02-25] T1 Reverse Contract Freeze
- Added  as canonical reverse-sync contract (events + ACK) with schema version constant and strict parser returning .
- Parser backward compatibility: fills missing per-event  from envelope and defaults missing  to v1; also accepts legacy  field.
- Added parser tests in  for valid path, required-field rejection, unknown type rejection, and empty-events acceptance.
- Documented matching schema in extension  via JSDoc typedefs to keep JS worker aligned without TypeScript build changes.
- Removed unused  function from extension worker to keep changed-file diagnostics clean.

## [2026-02-25] T1 Reverse Contract Freeze
- Added src/plugin/reverse-sync-types.ts as canonical reverse-sync contract (events + ACK) with schema version constant and strict parser returning ReverseBatch | null.
- Parser backward compatibility: fills missing per-event batchId from envelope and defaults missing schemaVersion to v1; also accepts legacy version field.
- Added parser tests in src/plugin/reverse-sync-types.test.ts for valid path, required-field rejection, unknown type rejection, and empty-events acceptance.
- Documented matching schema in extension background.js via JSDoc typedefs to keep JS worker aligned without TypeScript build changes.
- Removed unused prune function from extension worker to keep changed-file diagnostics clean.
