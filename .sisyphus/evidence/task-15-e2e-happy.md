# T15 — E2E Reverse Sync Validation: Happy Path Evidence

**Date:** 2026-02-25  
**Task:** T15 — Execute End-to-End Reverse Sync Validation Matrix  
**Test file:** `src/plugin/e2e-reverse-sync.test.ts`  
**Command:** `npm run test && npm run typecheck && npm run build`

---

## Summary

| Metric | Value |
|---|---|
| Total tests (all suites) | 128 |
| Pass | 128 |
| Fail | 0 |
| New E2E tests added | 9 |
| Prior tests (T1-T14) | 119 |
| Typecheck | ✅ clean |
| Build | ✅ clean |

---

## Scenario Results

| # | Scenario | Event Type | Managed Key | Expected Status | Actual Status | Vault Mutated |
|---|---|---|---|---|---|---|
| S1 | bookmark_created | `bookmark_created` | `Notes/create-target.md\|1` | `applied` | ✅ `applied` | Yes — link appended |
| S2 | bookmark_updated | `bookmark_updated` | `Notes/update-target.md\|0` | `applied` | ✅ `applied` | Yes — link replaced |
| S3 | bookmark_deleted | `bookmark_deleted` | `Notes/delete-target.md\|1` | `applied` | ✅ `applied` | Yes — link removed |
| S4 | folder_renamed | `folder_renamed` | `folder:Notes/Alpha` | `applied` | ✅ `applied` | Yes — `bookmark_name` written |
| S8 (first) | Duplicate (1st send) | `bookmark_updated` | `Notes/ambig-target.md\|0` | not `duplicate` | ✅ `applied` | Yes |
| S9 | Loop suppression check | `bookmark_updated` | `Notes/ambig-target.md\|0` | `applied` | ✅ `applied` | Yes — plugin applies normally |

---

## Scenario Detail

### S1 — bookmark_created appends link to note

**Input note (`/vault/Notes/create-target.md`):**
```markdown
### Link
- [One](https://one.test)
```

**POST payload:**
```json
{
  "batchId": "batch-s1",
  "managedKey": "Notes/create-target.md|1",
  "type": "bookmark_created",
  "title": "Two",
  "url": "https://two.test"
}
```

**ACK response:** `{ "status": "applied" }`

**Updated note:**
```markdown
### Link
- [One](https://one.test)
- [Two](https://two.test)
```

---

### S2 — bookmark_updated replaces link title and url

**Input note (`/vault/Notes/update-target.md`):**
```markdown
### Link
- [Old Title](https://old.test)
```

**POST payload:** `managedKey: "Notes/update-target.md|0"`, title: "New Title", url: "https://new.test"

**ACK response:** `{ "status": "applied" }`

**Updated note:**
```markdown
### Link
- [New Title](https://new.test)
```

---

### S3 — bookmark_deleted removes link at index

**Input note (`/vault/Notes/delete-target.md`):**
```markdown
### Link
- [One](https://one.test)
- [Two](https://two.test)
```

**POST payload:** `managedKey: "Notes/delete-target.md|1"`, `type: "bookmark_deleted"`

**ACK response:** `{ "status": "applied" }`

**Updated note:**
```markdown
### Link
- [One](https://one.test)
```

---

### S4 — folder_renamed updates bookmark_name in folder-note

**Input note (`/vault/Notes/Alpha/Alpha.md`):**
```markdown
# Alpha
Some folder content.
```

**POST payload:** `managedKey: "folder:Notes/Alpha"`, title: "Alpha Renamed"

**Key resolution:** `folder:Notes/Alpha` → `/vault/Notes/Alpha/Alpha.md` (folder-note convention)

**ACK response:** `{ "status": "applied" }`

**Updated note:**
```markdown
---
bookmark_name: Alpha Renamed
---
# Alpha
Some folder content.
```

---

### S8 — duplicate batchId: second request returns `duplicate`

**First POST:** `batchId: "batch-s8"` → `{ "status": "applied" }` (vault mutated)  
**Second POST:** same `batchId: "batch-s8"` → `{ "status": "duplicate" }` (vault NOT re-mutated)

---

### S9 — Loop suppression: plugin applies normally

Loop suppression (`applyEpoch` + cooldown) is implemented extension-side in the Chrome service worker.  
The plugin bridge has no suppression mechanism — it always processes valid incoming events.

**Verification:** Sent a valid `bookmark_updated` batch; received `{ "status": "applied" }`.  
**Suppression coverage reference:** `extension/suppression.test.js` — 4 tests covering:
- `applyEpoch = true` suppresses enqueue
- Cooldown active suppresses enqueue
- Cooldown expired allows enqueue
- `setApplyEpoch(false)` clears timestamps

---

## Pipeline Wiring Verified

```
createReverseApplyHook(ctx)          ← reverse-apply.ts
    ↓
createBridgeHandler({ applyHook })   ← bridge-handler.ts
    ↓
http.createServer(handler)           ← real HTTP server on port 0
    ↓
In-memory vault (Map<string, string>) ← no real filesystem I/O
```

All guardrail layers active (`knownKeys` injected into context):
- `validateManagedKey` — filters unmanaged paths
- `checkAmbiguity` — rejects out-of-bounds link indices
