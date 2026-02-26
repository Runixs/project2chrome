import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapLegacyAckStatus, parseAndValidateWsEnvelope } from "./websocket-action-types";

describe("mapLegacyAckStatus", () => {
  it("maps legacy statuses to websocket ack statuses", () => {
    assert.equal(mapLegacyAckStatus("applied"), "applied");
    assert.equal(mapLegacyAckStatus("duplicate"), "duplicate");
    assert.equal(mapLegacyAckStatus("skipped_ambiguous"), "skipped");
    assert.equal(mapLegacyAckStatus("skipped_unmanaged"), "skipped");
    assert.equal(mapLegacyAckStatus("rejected_invalid"), "rejected");
  });
});

describe("parseAndValidateWsEnvelope", () => {
  it("parses valid handshake message", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "handshake",
      eventId: "evt-1",
      clientId: "project2chrome",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      sessionId: "ses-1",
      token: "abc123",
      capabilities: ["action", "ack"]
    });

    assert.ok(parsed);
    assert.equal(parsed?.type, "handshake");
  });

  it("parses valid action message with idempotency key", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "action",
      eventId: "evt-2",
      clientId: "project2chrome",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      idempotencyKey: "idem-1",
      op: "bookmark_updated",
      target: "bookmark:123",
      payload: {
        title: "A",
        url: "chrome://extensions"
      }
    });

    assert.ok(parsed);
    assert.equal(parsed?.type, "action");
  });

  it("parses valid ack message with legacy status", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "ack",
      eventId: "evt-3",
      clientId: "gateway",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      correlationId: "evt-2",
      status: "skipped",
      legacyStatus: "skipped_ambiguous",
      reason: "multiple_matches"
    });

    assert.ok(parsed);
    assert.equal(parsed?.type, "ack");
    if (parsed?.type === "ack") {
      assert.equal(parsed.legacyStatus, "skipped_ambiguous");
    }
  });

  it("rejects action message missing idempotency key", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "action",
      eventId: "evt-4",
      clientId: "project2chrome",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      op: "bookmark_updated",
      target: "bookmark:123",
      payload: {}
    });

    assert.equal(parsed, null);
  });

  it("rejects heartbeat_pong when correlationId is missing", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "heartbeat_pong",
      eventId: "evt-5",
      clientId: "gateway",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0"
    });

    assert.equal(parsed, null);
  });

  it("rejects ack with unknown legacy status", () => {
    const parsed = parseAndValidateWsEnvelope({
      type: "ack",
      eventId: "evt-6",
      clientId: "gateway",
      occurredAt: "2026-02-25T10:00:00.000Z",
      schemaVersion: "1.0",
      correlationId: "evt-1",
      status: "rejected",
      legacyStatus: "future_status"
    });

    assert.equal(parsed, null);
  });
});
