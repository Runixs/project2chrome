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

## [2026-02-25] T4 Markdown Writeback Engine
- Added  pure function in  for create/update/delete scoped to configured Link heading section.
- Heading detection supports markdown headings () and bare  line, with section bounds ending at next markdown heading.
- Preserve non-target content and line-ending style ( vs ), return deterministic error reasons (, ).
- Added  covering create/update/delete, duplicate URL deletion behavior, missing heading/index errors, CRLF preservation, and bare heading handling.
- Implementation files: src/plugin/writeback-engine.ts and src/plugin/writeback-engine.test.ts.


## [2026-02-25] T5 Folder-Rename Writeback
- Added `src/plugin/folder-rename-writeback.ts` with three pure exports: `resolveFolderRenameTarget`, `applyFolderRenameWriteback`, `processFolderRename`.
- Key resolution: `note:<path>` → vault-absolute .md path (appends .md if absent); `folder:<path>` → `<path>/<lastSegment>.md` (matches folder-note convention).
- Frontmatter update: split on `\r?\n`, scan for opening/closing `---`, replace or splice `bookmark_name` line; if no frontmatter, prepend minimal block.
- Pure functions only — no file I/O, no Obsidian API; caller injects `readFile` callback; T8 orchestrator responsible for actual write-back.
- 19 new tests, 55 total pass; typecheck and build clean.
- Avoid `node:path` in plugin source — Obsidian browser context does not guarantee Node.js built-ins; use string operations instead.
## [2026-02-25] T3 Reverse Endpoint Skeleton

### Architecture Decision: Extract bridge-handler.ts
- `main.ts` imports Obsidian types at the top-level, making it untestable with Node.js test runner alone.
- Solution: extract `createBridgeHandler(config)` factory to `src/plugin/bridge-handler.ts` (zero Obsidian imports).
- Tests import `createBridgeHandler` + `skeletonApplyHook` and spin up a real `http.createServer` on port 0 per test suite.
- `main.ts` `startBridgeServer(applyHook = skeletonApplyHook)` accepts an optional hook so T8 can inject the real mutation.

### Idempotency Pattern
- In-memory `processedBatchIds: Set<string>` on plugin class instance — keyed by `batchId`.
- On duplicate: return 200 with `{ status: "duplicate" }` for all events; no apply hook called.
- Limitation: Set resets on plugin reload. T8 may need durable storage for production-grade idempotency.

### Test Pattern for HTTP Handlers
- Use `server.listen(0, "127.0.0.1", resolve)` to grab a random port — avoids port conflicts in CI.
- `server.address() as AddressInfo` gives `{ port }` for TCP servers.
- Use unique `batchId` per test case to avoid Set-based state leakage between tests sharing a server instance.
- TypeScript strict mode requires guarding `array[0]` with `assert.ok(item !== undefined)` before property access.

### CORS Update
- Added `POST` to `Access-Control-Allow-Methods` in bridge-handler (was only `GET, OPTIONS`).
- Old hardcoded CORS in main.ts is now removed (replaced by factory pattern).


## [2026-02-25] T2 Extension State Model — Durable Reverse Queue

### State Shape (current canonical)
- `getState()` now returns migrated shape via `migrateState(raw)` — never returns partial state
- New fields: `reverseQueue: []`, `bookmarkIdToManagedKey: {}`, `suppressionState: { applyEpoch: false, epochStartedAt: null, cooldownUntil: null }`
- `syncFromPayload()` updated to carry `reverseQueue`, `bookmarkIdToManagedKey`, `suppressionState` through full-sync — critical to prevent queue wipe on every Obsidian-side sync

### migrateState(raw) Design
- Handles null/undefined/string/array without throwing (all fallback to safe defaults)
- Treats managedFolderIds/managedBookmarkIds as arrays → falls back to {} (guards `!Array.isArray()`)
- suppressionState sub-object is migrated field-by-field with `?? null` for optional timestamps

### Pure Helper Functions
- `enqueueReverseEvent(state, event)` — pushes `{ event, retryCount: 0, enqueuedAt: ISO }` to queue
- `dequeueAckedEvents(state, ackedEventIds)` — filters via Set for O(n) dequeue; removes ALL matching eventIds including duplicates
- `updateBookmarkKeyMapping(state, bookmarkId, managedKey)` — simple map write, caller persists to storage
- `setApplyEpoch(state, true)` — sets flag + epochStartedAt; `false` → clears both timestamps (crash-safe reset)

### Testing MV3 Extensions with node:test
- Use `node:vm` `runInNewContext(src, ctx)` with a mock chrome global to load background.js
- Function declarations at script top-level become properties of the VM context (sandbox = global)
- CRITICAL: VM cross-realm prototype issue — arrays/objects from VM context have different `Array.prototype`/`Object.prototype` than main world
  - `assert.deepStrictEqual(vmArray, [])` fails even if both are empty — different prototype chains
  - Fix: use scalar checks (`arr.length`, `obj[key]`, `keys(obj).length`) instead of `deepStrictEqual` with empty literals
- Mock chrome needs: `runtime.onInstalled.addListener`, `runtime.onStartup.addListener`, `runtime.onMessage.addListener`, `alarms.onAlarm.addListener`

### Evidence
- 33 tests, 33 pass, 0 fail
- Evidence: `.sisyphus/evidence/task-2-state-happy.txt` and `.sisyphus/evidence/task-2-state-error.txt`
- Commit: `feat(extension): add durable reverse queue state model` (sha: 1f500d2)

## [2026-02-25] T8 Reverse Apply Orchestrator
- Added `src/plugin/reverse-apply.ts` as pure map->mutate->ACK orchestrator with `applyReverseEvent` and `createReverseApplyHook`.
- Managed key routing: `note:`/`folder:` keys use `processFolderRename`; `<sourcePath>|<linkIndex>` keys use `applyWriteback` for create/update/delete.
- Deterministic ACK behavior: unrecognized keys -> `skipped_unmanaged` (`unrecognized_key`), writeback/resolve failures -> `skipped_ambiguous` with propagated reason, success -> `applied` with `resolvedPath` and `resolvedKey`.
- Updated `ApplyHook` contract in `bridge-handler.ts` to return per-event `EventAck[]` (sync or async), with batch envelope assembled at the endpoint.
- Added `src/plugin/reverse-apply.test.ts` coverage for happy path mutations, unmanaged keys, ambiguous writeback failure, and duplicate replay through bridge idempotency.
- Verification passed: `npm run test && npm run typecheck && npm run build`.

## [2026-02-25] T10 Structured Audit Logging

### reverse-logger.ts Architecture
- `createReverseLogger(sink?)` factory pattern — default sink uses `console.log(JSON.stringify(entry))`
- Custom sink injected in tests to capture entries without console noise
- `logEnqueue` stores event type in `status` field (reuse of status for non-ACK events)
- `logFlush` stores count as string in `status` field for uniform interface
- `logError` stores message in `status` field; optional batchId/eventId omitted (no undefined keys in output)

### Redact Safety Pattern
- Logger never receives token, secret, or auth values — callers responsible for not passing those
- Test coverage: scan all serialized entries for `token`, `secret`, `password`, `authorization` strings
- No extra fields beyond `ReverseLogEntry` interface — validated in tests with `Object.keys` allowlist

### bridge-handler.ts Integration
- `logger` is optional in `BridgeHandlerConfig` — all calls use optional chaining (`logger?.logX()`)
- Auth failures log via `logError(undefined, undefined, 'auth_failure')` — no batchId at that point
- Flush logged before apply hook; per-event ACK logged after apply returns (including duplicates)
- `logEnqueue` on POST /reverse-sync arrival uses `('request', 'request', 'reverse_sync_received')` sentinel

### background.js Integration
- `rsLog(event, data)` defined at script top-level: `console.log(JSON.stringify({ ts: Date.now(), event, ...data }))`
- Called in `enqueueReverseEvent` immediately after push
- `flushReverseQueue(state, batchId, bridgeUrl, token)` stub added — T6 implements HTTP send; token never passed to rsLog
- `processReverseAckResponse(state, ackResponse)` stub added — calls `rsLog('ack', ...)` per result, then dequeues

### Evidence
- 89 tests, 89 pass, 0 fail
- Evidence: `.sisyphus/evidence/task-10-logging-happy.log` and `.sisyphus/evidence/task-10-logging-error.log`
