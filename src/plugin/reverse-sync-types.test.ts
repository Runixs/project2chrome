import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAndValidateReverseBatch } from "./reverse-sync-types";

describe("parseAndValidateReverseBatch", () => {
  it("parses a valid reverse batch", () => {
    const batch = parseAndValidateReverseBatch({
      batchId: "batch-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        {
          batchId: "batch-1",
          eventId: "event-1",
          type: "bookmark_created",
          bookmarkId: "123",
          managedKey: "note:Projects/Alpha.md",
          parentId: "456",
          moveIndex: 0,
          title: "Alpha",
          url: "https://example.com",
          occurredAt: "2026-02-25T09:59:00.000Z",
          schemaVersion: "1"
        }
      ]
    });

    assert.ok(batch);
    assert.equal(batch?.events.length, 1);
    assert.equal(batch?.events[0]?.eventId, "event-1");
    assert.equal(batch?.events[0]?.moveIndex, 0);
  });

  it("rejects when eventId is missing", () => {
    const batch = parseAndValidateReverseBatch({
      batchId: "batch-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        {
          batchId: "batch-1",
          type: "bookmark_created",
          bookmarkId: "123",
          managedKey: "note:Projects/Alpha.md",
          occurredAt: "2026-02-25T09:59:00.000Z",
          schemaVersion: "1"
        }
      ]
    });

    assert.equal(batch, null);
  });

  it("rejects when type is missing", () => {
    const batch = parseAndValidateReverseBatch({
      batchId: "batch-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        {
          batchId: "batch-1",
          eventId: "event-1",
          bookmarkId: "123",
          managedKey: "note:Projects/Alpha.md",
          occurredAt: "2026-02-25T09:59:00.000Z",
          schemaVersion: "1"
        }
      ]
    });

    assert.equal(batch, null);
  });

  it("rejects when type is unknown", () => {
    const batch = parseAndValidateReverseBatch({
      batchId: "batch-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        {
          batchId: "batch-1",
          eventId: "event-1",
          type: "bookmark_moved",
          bookmarkId: "123",
          managedKey: "note:Projects/Alpha.md",
          occurredAt: "2026-02-25T09:59:00.000Z",
          schemaVersion: "1"
        }
      ]
    });

    assert.equal(batch, null);
  });

  it("accepts empty events array", () => {
    const batch = parseAndValidateReverseBatch({
      batchId: "batch-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: []
    });

    assert.deepEqual(batch, {
      batchId: "batch-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: []
    });
  });

  it("uses batchId fallback and default schema version for legacy events", () => {
    const batch = parseAndValidateReverseBatch({
      batchId: "batch-legacy",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        {
          eventId: "event-legacy",
          type: "bookmark_updated",
          bookmarkId: "123",
          managedKey: "note:Projects/Legacy.md",
          occurredAt: "2026-02-25T09:59:00.000Z"
        }
      ]
    });

    assert.ok(batch);
    assert.equal(batch?.events[0]?.batchId, "batch-legacy");
    assert.equal(batch?.events[0]?.schemaVersion, "1");
  });

  it("rejects when moveIndex is not a non-negative integer", () => {
    const batch = parseAndValidateReverseBatch({
      batchId: "batch-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        {
          eventId: "event-1",
          type: "bookmark_updated",
          bookmarkId: "123",
          managedKey: "note:Projects/Legacy.md",
          moveIndex: -1,
          occurredAt: "2026-02-25T09:59:00.000Z"
        }
      ]
    });

    assert.equal(batch, null);
  });
});
