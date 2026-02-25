import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkAmbiguity, validateManagedKey, type ManagedKeySet } from "./reverse-guardrails";
import { applyReverseEvent, type ReverseApplyContext } from "./reverse-apply";
import type { ReverseEvent } from "./reverse-sync-types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeKnownKeys(notePaths: string[], folderPaths: string[] = []): ManagedKeySet {
  return {
    managedNotePaths: new Set(notePaths),
    managedFolderPaths: new Set(folderPaths)
  };
}

function makeEvent(overrides: Partial<ReverseEvent>): ReverseEvent {
  return {
    batchId: overrides.batchId ?? "batch-g1",
    eventId: overrides.eventId ?? "evt-g1",
    type: overrides.type ?? "bookmark_updated",
    bookmarkId: overrides.bookmarkId ?? "bm-g1",
    managedKey: overrides.managedKey ?? "note:1_Projects/Doc.md",
    parentId: overrides.parentId,
    title: overrides.title,
    url: overrides.url,
    occurredAt: overrides.occurredAt ?? "2026-02-25T10:00:00.000Z",
    schemaVersion: overrides.schemaVersion ?? "1"
  };
}

function makeContext(
  initialFiles: Record<string, string>,
  knownKeys?: ManagedKeySet
): {
  ctx: ReverseApplyContext;
  writes: Array<{ path: string; content: string }>;
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const writes: Array<{ path: string; content: string }> = [];
  return {
    writes,
    ctx: {
      vaultBasePath: "/vault",
      linkHeading: "Link",
      readFile: (path) => files.get(path) ?? null,
      writeFile: (path, content) => {
        writes.push({ path, content });
        files.set(path, content);
      },
      knownKeys
    }
  };
}

// ---------------------------------------------------------------------------
// validateManagedKey — unit tests
// ---------------------------------------------------------------------------

describe("validateManagedKey", () => {
  it("note:<path> in managed set → eligible", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Doc.md"]);
    const result = validateManagedKey("note:1_Projects/Doc.md", knownKeys);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, undefined);
  });

  it("note:<path> NOT in managed set → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Other.md"]);
    const result = validateManagedKey("note:1_Projects/Doc.md", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });

  it("folder:<path> in managed set → eligible", () => {
    const knownKeys = makeKnownKeys([], ["1_Projects/MyFolder"]);
    const result = validateManagedKey("folder:1_Projects/MyFolder", knownKeys);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, undefined);
  });

  it("folder:<path> NOT in managed set → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys([], ["1_Projects/OtherFolder"]);
    const result = validateManagedKey("folder:1_Projects/MyFolder", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });

  it("<sourcePath>|<linkIndex> sourcePath in managedNotePaths → eligible", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Doc.md"]);
    const result = validateManagedKey("1_Projects/Doc.md|0", knownKeys);
    assert.equal(result.eligible, true);
    assert.equal(result.reason, undefined);
  });

  it("<sourcePath>|<linkIndex> sourcePath NOT in managedNotePaths → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Other.md"]);
    const result = validateManagedKey("1_Projects/Doc.md|0", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });

  it("unrecognized key format (no prefix, no pipe) → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Doc.md"]);
    const result = validateManagedKey("invalid-key-format", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });

  it("note: with empty path → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Doc.md"]);
    const result = validateManagedKey("note:", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });

  it("folder: with empty path → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys([], ["1_Projects/MyFolder"]);
    const result = validateManagedKey("folder:", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });

  it("link key with non-numeric index → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Doc.md"]);
    const result = validateManagedKey("1_Projects/Doc.md|abc", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });

  it("link key with trailing pipe only → skipped_unmanaged", () => {
    const knownKeys = makeKnownKeys(["1_Projects/Doc.md"]);
    const result = validateManagedKey("1_Projects/Doc.md|", knownKeys);
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_unmanaged");
  });
});

// ---------------------------------------------------------------------------
// checkAmbiguity — unit tests
// ---------------------------------------------------------------------------

const TWO_LINK_CONTENT = [
  "# Doc",
  "### Link",
  "- [One](https://one.test)",
  "- [Two](https://two.test)",
  "### Other"
].join("\n");

const ZERO_LINK_CONTENT = ["# Doc", "### Link", "### Other"].join("\n");

const NO_HEADING_CONTENT = ["# Doc", "- [One](https://one.test)"].join("\n");

describe("checkAmbiguity", () => {
  it("link key with index within bounds → eligible", () => {
    // 2 links, index 1 is valid
    const result = checkAmbiguity("1_Projects/Doc.md|1", TWO_LINK_CONTENT, "Link");
    assert.equal(result.eligible, true);
    assert.equal(result.reason, undefined);
  });

  it("link key with index at boundary (== count, valid append) → eligible", () => {
    // 2 links, index 2 is the append position
    const result = checkAmbiguity("1_Projects/Doc.md|2", TWO_LINK_CONTENT, "Link");
    assert.equal(result.eligible, true);
  });

  it("link key with out-of-bounds index → skipped_ambiguous", () => {
    // 2 links, index 5 is clearly out of range
    const result = checkAmbiguity("1_Projects/Doc.md|5", TWO_LINK_CONTENT, "Link");
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_ambiguous");
  });

  it("link key with index 1 on zero-link section → skipped_ambiguous", () => {
    // 0 links, index 1 is out of range (only index 0 is valid for create)
    const result = checkAmbiguity("1_Projects/Doc.md|1", ZERO_LINK_CONTENT, "Link");
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_ambiguous");
  });

  it("link key with index 0 on zero-link section → eligible (create at start)", () => {
    const result = checkAmbiguity("1_Projects/Doc.md|0", ZERO_LINK_CONTENT, "Link");
    assert.equal(result.eligible, true);
  });

  it("link key with no heading in content and index 0 → eligible (create with missing heading)", () => {
    const result = checkAmbiguity("1_Projects/Doc.md|0", NO_HEADING_CONTENT, "Link");
    assert.equal(result.eligible, true);
  });

  it("link key with no heading in content and index 1 → skipped_ambiguous", () => {
    // Heading not found → 0 links → index 1 > 0 → out of bounds
    const result = checkAmbiguity("1_Projects/Doc.md|1", NO_HEADING_CONTENT, "Link");
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_ambiguous");
  });

  it("note:<path> key → always eligible regardless of content", () => {
    const result = checkAmbiguity("note:1_Projects/Doc.md", TWO_LINK_CONTENT, "Link");
    assert.equal(result.eligible, true);
  });

  it("folder:<path> key → always eligible regardless of content", () => {
    const result = checkAmbiguity("folder:1_Projects/MyFolder", TWO_LINK_CONTENT, "Link");
    assert.equal(result.eligible, true);
  });

  it("bare heading line (non-prefixed) is detected correctly", () => {
    const content = ["# Doc", "Link", "- [One](https://one.test)", "## Other"].join("\n");
    const result = checkAmbiguity("1_Projects/Doc.md|5", content, "Link");
    assert.equal(result.eligible, false);
    assert.equal(result.reason, "skipped_ambiguous");
  });
});

// ---------------------------------------------------------------------------
// Integration: applyReverseEvent with knownKeys guardrails
// ---------------------------------------------------------------------------

describe("applyReverseEvent guardrail integration", () => {
  it("unmanaged note key returns skipped_unmanaged ACK with zero file mutations", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext(
      { [targetPath]: ["---", "bookmark_name: Old", "---", "# Body"].join("\n") },
      makeKnownKeys([]) // empty managed set → Doc.md is not managed
    );

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_updated",
        managedKey: "note:1_Projects/Doc.md",
        title: "Should Not Apply"
      }),
      ctx
    );

    assert.equal(ack.status, "skipped_unmanaged");
    assert.equal(ack.reason, "skipped_unmanaged");
    assert.equal(writes.length, 0);
  });

  it("managed note key proceeds normally to applied for folder_renamed", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext(
      { [targetPath]: ["---", "bookmark_name: Old", "---", "# Body"].join("\n") },
      makeKnownKeys(["1_Projects/Doc.md"])
    );

    const ack = applyReverseEvent(
      makeEvent({
        type: "folder_renamed",
        managedKey: "note:1_Projects/Doc.md",
        title: "New Name"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.content.includes("bookmark_name: New Name"));
  });

  it("unmanaged link key returns skipped_unmanaged ACK with zero file mutations", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext(
      { [targetPath]: ["### Link", "- [One](https://one.test)"].join("\n") },
      makeKnownKeys([]) // empty → Doc.md not managed
    );

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_deleted",
        managedKey: "1_Projects/Doc.md|0"
      }),
      ctx
    );

    assert.equal(ack.status, "skipped_unmanaged");
    assert.equal(ack.reason, "skipped_unmanaged");
    assert.equal(writes.length, 0);
  });

  it("out-of-bounds link index returns skipped_ambiguous ACK with zero file mutations", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext(
      {
        [targetPath]: [
          "### Link",
          "- [One](https://one.test)",
          "- [Two](https://two.test)"
        ].join("\n")
      },
      makeKnownKeys(["1_Projects/Doc.md"])
    );

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_updated",
        managedKey: "1_Projects/Doc.md|99",
        title: "Ghost"
      }),
      ctx
    );

    assert.equal(ack.status, "skipped_ambiguous");
    assert.equal(ack.reason, "skipped_ambiguous");
    assert.equal(writes.length, 0);
  });

  it("no knownKeys provided → guardrail bypassed, existing behavior preserved", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    // No knownKeys in context → guardrail is skipped entirely
    const { ctx, writes } = makeContext(
      { [targetPath]: ["### Link", "- [One](https://one.test)"].join("\n") }
      // knownKeys omitted
    );

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_deleted",
        managedKey: "1_Projects/Doc.md|0"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(writes.length, 1);
  });

  it("unmanaged folder key returns skipped_unmanaged ACK with zero file mutations", () => {
    const targetPath = "/vault/1_Projects/Folder/Folder.md";
    const { ctx, writes } = makeContext(
      { [targetPath]: ["---", "owner: team", "---", "# Folder"].join("\n") },
      makeKnownKeys([], []) // empty folder set
    );

    const ack = applyReverseEvent(
      makeEvent({
        type: "folder_renamed",
        managedKey: "folder:1_Projects/Folder",
        title: "Should Not Apply"
      }),
      ctx
    );

    assert.equal(ack.status, "skipped_unmanaged");
    assert.equal(writes.length, 0);
  });
});
