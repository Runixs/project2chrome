import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createReverseLogger, type ReverseLogEntry } from "./reverse-logger";

function collectEntries(): { entries: ReverseLogEntry[]; sink: (entry: ReverseLogEntry) => void } {
  const entries: ReverseLogEntry[] = [];
  return { entries, sink: (entry) => entries.push(entry) };
}

describe("createReverseLogger", () => {
  describe("logAck", () => {
    it("produces correct entry shape for applied status", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logAck("batch-001", "evt-abc", "applied");
      assert.equal(entries.length, 1);
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.event, "ack");
      assert.equal(entry.level, "info");
      assert.equal(entry.batchId, "batch-001");
      assert.equal(entry.eventId, "evt-abc");
      assert.equal(entry.status, "applied");
      assert.ok(typeof entry.timestamp === "string" && entry.timestamp.length > 0);
    });

    it("includes resolvedPath when provided", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logAck("batch-002", "evt-def", "applied", "Notes/link-section");
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.resolvedPath, "Notes/link-section");
      assert.equal(entry.reason, undefined);
    });

    it("includes reason when provided", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logAck("batch-003", "evt-ghi", "skipped_unmanaged", undefined, "unmanaged");
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.status, "skipped_unmanaged");
      assert.equal(entry.reason, "unmanaged");
      assert.equal(entry.resolvedPath, undefined);
    });
  });

  describe("logSkip", () => {
    it("produces correct entry shape for skipped_ambiguous", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logSkip("batch-010", "evt-xyz", "skipped_ambiguous");
      assert.equal(entries.length, 1);
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.event, "skip");
      assert.equal(entry.level, "warn");
      assert.equal(entry.batchId, "batch-010");
      assert.equal(entry.eventId, "evt-xyz");
      assert.equal(entry.reason, "skipped_ambiguous");
      assert.ok(typeof entry.timestamp === "string" && entry.timestamp.length > 0);
    });

    it("produces correct entry for skipped_unmanaged", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logSkip("batch-011", "evt-unm", "skipped_unmanaged");
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.event, "skip");
      assert.equal(entry.reason, "skipped_unmanaged");
    });

    it("produces correct entry for duplicate skip reason", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logSkip("batch-012", "evt-dup", "duplicate");
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.reason, "duplicate");
    });

    it("produces correct entry for invalid skip reason", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logSkip("batch-013", "evt-inv", "invalid");
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.reason, "invalid");
    });
  });

  describe("logError", () => {
    it("produces level error entry", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logError(undefined, undefined, "something went wrong");
      assert.equal(entries.length, 1);
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.event, "error");
      assert.equal(entry.level, "error");
      assert.equal(entry.status, "something went wrong");
      assert.equal(entry.batchId, undefined);
      assert.equal(entry.eventId, undefined);
    });

    it("includes batchId and eventId when provided", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logError("batch-err", "evt-err", "apply_failed");
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.batchId, "batch-err");
      assert.equal(entry.eventId, "evt-err");
      assert.equal(entry.level, "error");
    });
  });

  describe("custom sink", () => {
    it("receives entries instead of writing to console.log", () => {
      const received: ReverseLogEntry[] = [];
      const sink = (entry: ReverseLogEntry): void => {
        received.push(entry);
      };
      const logger = createReverseLogger(sink);
      logger.logEnqueue("batch-s1", "evt-s1", "bookmark_created");
      logger.logFlush("batch-s1", 3);
      assert.equal(received.length, 2);
      const first = received[0];
      const second = received[1];
      assert.ok(first !== undefined);
      assert.ok(second !== undefined);
      assert.equal(first.event, "enqueue");
      assert.equal(second.event, "flush");
    });

    it("sink captures all entry fields without mutation", () => {
      const received: ReverseLogEntry[] = [];
      const logger = createReverseLogger((e) => received.push(e));
      logger.logAck("b1", "e1", "applied", "some/path", "reason-x");
      const entry = received[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.batchId, "b1");
      assert.equal(entry.eventId, "e1");
      assert.equal(entry.status, "applied");
      assert.equal(entry.resolvedPath, "some/path");
      assert.equal(entry.reason, "reason-x");
    });
  });

  describe("logEnqueue", () => {
    it("emits enqueue event with type as status", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logEnqueue("batch-q1", "evt-q1", "bookmark_deleted");
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.event, "enqueue");
      assert.equal(entry.level, "info");
      assert.equal(entry.status, "bookmark_deleted");
    });
  });

  describe("logFlush", () => {
    it("emits flush event with count as status string", () => {
      const { entries, sink } = collectEntries();
      const logger = createReverseLogger(sink);
      logger.logFlush("batch-f1", 5);
      const entry = entries[0];
      assert.ok(entry !== undefined);
      assert.equal(entry.event, "flush");
      assert.equal(entry.level, "info");
      assert.equal(entry.status, "5");
      assert.equal(entry.batchId, "batch-f1");
    });
  });

  describe("redact safety", () => {
    it("no token or secret field appears in any log entry", () => {
      const received: ReverseLogEntry[] = [];
      const logger = createReverseLogger((e) => received.push(e));
      logger.logEnqueue("batch-r1", "evt-r1", "bookmark_created");
      logger.logFlush("batch-r1", 2);
      logger.logAck("batch-r1", "evt-r1", "applied");
      logger.logSkip("batch-r1", "evt-r2", "skipped_unmanaged");
      logger.logError("batch-r1", undefined, "some_error");
      for (const entry of received) {
        const serialized = JSON.stringify(entry);
        assert.ok(!serialized.includes("token"), `Entry should not contain 'token': ${serialized}`);
        assert.ok(!serialized.includes("secret"), `Entry should not contain 'secret': ${serialized}`);
        assert.ok(!serialized.includes("password"), `Entry should not contain 'password': ${serialized}`);
        assert.ok(!serialized.includes("authorization"), `Entry should not contain 'authorization': ${serialized}`);
      }
    });

    it("entry has no extra fields beyond the ReverseLogEntry interface", () => {
      const received: ReverseLogEntry[] = [];
      const logger = createReverseLogger((e) => received.push(e));
      logger.logAck("b", "e", "applied");
      const entry = received[0];
      assert.ok(entry !== undefined);
      const allowedKeys = new Set(["timestamp", "level", "event", "batchId", "eventId", "status", "reason", "resolvedPath"]);
      for (const key of Object.keys(entry)) {
        assert.ok(allowedKeys.has(key), `Unexpected key in log entry: ${key}`);
      }
    });
  });
});
