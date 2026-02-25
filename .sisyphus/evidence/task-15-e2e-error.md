# T15 — E2E Reverse Sync Validation: Error / Edge Case Evidence

**Date:** 2026-02-25  
**Task:** T15 — Execute End-to-End Reverse Sync Validation Matrix  
**Test file:** `src/plugin/e2e-reverse-sync.test.ts`

---

## Error / Guard Scenarios

| # | Scenario | Input | Expected | Actual | Vault Mutated |
|---|---|---|---|---|---|
| S5 | Auth failure | Wrong token | `401` | ✅ `401` | No |
| S6 | Ambiguous key | Link index out of bounds (5 > 1) | `200 skipped_ambiguous` | ✅ `200 skipped_ambiguous` | No |
| S7 | Unmanaged key | Unrecognized key format (no pipe, no prefix) | `200 skipped_unmanaged` | ✅ `200 skipped_unmanaged` | No |
| S8 (2nd) | Duplicate batchId | Same batchId resent | `200 duplicate` | ✅ `200 duplicate` | No |

---

## S5 — Auth Failure: Wrong Token

**Request:**
```
POST /reverse-sync
X-Project2Chrome-Token: wrong-token
```

**Response:** `401 Unauthorized { "error": "unauthorized" }`

**Guards verified:**
- `processedBatchIds.size` unchanged (batchId not recorded)
- `vault.writes.length` unchanged (no file mutations)

---

## S6 — Ambiguous: Link Index Out of Bounds

**Note (`/vault/Notes/ambig-target.md`):** Contains exactly 1 link (index 0)

**POST payload:**
```json
{
  "managedKey": "Notes/ambig-target.md|5",
  "type": "bookmark_updated",
  "title": "Phantom"
}
```

**Guard chain:**
1. `validateManagedKey("Notes/ambig-target.md|5", knownKeys)` → eligible (sourcePath in managedNotePaths)
2. `checkAmbiguity("Notes/ambig-target.md|5", content, "Link")` → `linkIndex(5) > linkCount(1)` → `{ eligible: false, reason: "skipped_ambiguous" }`

**ACK response:** `{ "status": "skipped_ambiguous" }`  
**Vault:** Not mutated (no "Phantom" written)

---

## S7 — Unmanaged: Unrecognized Key Format

**POST payload:**
```json
{
  "managedKey": "invalid-key-format-no-pipe-or-prefix",
  "type": "bookmark_updated"
}
```

**Guard chain:**
- `validateManagedKey("invalid-key-format-no-pipe-or-prefix", knownKeys)`:
  - Not `note:` prefix
  - Not `folder:` prefix
  - No `|` separator → `{ eligible: false, reason: "skipped_unmanaged" }`

**ACK response:** `{ "status": "skipped_unmanaged" }`

---

## S8 — Duplicate: Second POST with Same batchId

**First POST:** `batchId: "batch-s8"` → processed, `{ "status": "applied" }`, batchId added to `processedBatchIds`

**Second POST:** same `batchId: "batch-s8"` → detected in `processedBatchIds`

**Response (second):**
```json
{
  "batchId": "batch-s8",
  "results": [{ "eventId": "evt-s8", "status": "duplicate" }]
}
```

**Note:** `applyHook` is NOT called on duplicate — idempotency enforced at handler level before hook invocation.

---

## Loop Suppression Reference (S9)

Loop suppression is **extension-side only**. Full coverage in:

**File:** `extension/suppression.test.js`  
**Tests:**

| Test | Description |
|---|---|
| `applyEpoch = true suppresses enqueue` | `handleBookmarkCreated` drops event when applyEpoch is active |
| `cooldown active suppresses enqueue` | Events dropped during 3000ms cooldown window |
| `cooldown expired allows enqueue` | `cooldownUntil` in the past → enqueue proceeds |
| `setApplyEpoch(false) clears timestamps` | `epochStartedAt` and `cooldownUntil` reset to null |

The plugin bridge does not implement suppression — it always processes valid incoming events from the extension, which is correct behavior. The extension's suppression layer prevents forwarding events during payload-apply windows.

---

## Full Test Run Output (summary)

```
# tests 128
# suites 24
# pass 128
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 325.692792
```

**Typecheck:** `tsc --noEmit` → no errors  
**Build:** `node scripts/build.mjs` → clean
