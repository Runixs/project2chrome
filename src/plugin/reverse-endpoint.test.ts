import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createBridgeHandler, skeletonApplyHook } from "./bridge-handler";

const TEST_TOKEN = "test-token-t3-endpoint";
const FIXED_PAYLOAD = '{"payload":"test-fixture"}\n';

function makeValidBatch(batchId: string, eventId = "evt-001") {
  return {
    batchId,
    sentAt: "2026-02-25T10:00:00.000Z",
    events: [
      {
        batchId,
        eventId,
        type: "bookmark_created",
        bookmarkId: "bm-abc",
        managedKey: "note:Projects/test.md",
        occurredAt: "2026-02-25T10:00:00.000Z",
        schemaVersion: "1"
      }
    ]
  };
}

async function httpGet(port: number, path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token !== undefined) {
    headers["X-Project2Chrome-Token"] = token;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, { method: "GET", headers });
}

async function httpPost(
  port: number,
  path: string,
  body: unknown,
  token?: string,
  rawBody?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) {
    headers["X-Project2Chrome-Token"] = token;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: rawBody !== undefined ? rawBody : JSON.stringify(body)
  });
}

describe("bridge reverse-sync endpoint", () => {
  let server: Server;
  let port: number;
  const processedBatchIds = new Set<string>();

  before(
    () =>
      new Promise<void>((resolve) => {
        const handler = createBridgeHandler({
          expectedToken: TEST_TOKEN,
          getPayload: () => FIXED_PAYLOAD,
          processedBatchIds,
          applyHook: skeletonApplyHook
        });
        server = createServer(handler);
        server.listen(0, "127.0.0.1", () => resolve());
      })
  );

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  );

  function resolvePort(): void {
    const addr = server.address() as AddressInfo;
    port = addr.port;
  }

  // ── Existing endpoints still work ─────────────────────────────────────────

  it("GET /health returns 200 with ok:true", async () => {
    resolvePort();
    const res = await httpGet(port, "/health");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  });

  it("GET /payload with valid token returns 200", async () => {
    resolvePort();
    const res = await httpGet(port, "/payload", TEST_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { payload: string };
    assert.equal(body.payload, "test-fixture");
  });

  it("GET /payload without token returns 401", async () => {
    resolvePort();
    const res = await httpGet(port, "/payload");
    assert.equal(res.status, 401);
  });

  // ── POST /reverse-sync happy path ──────────────────────────────────────────

  it("POST /reverse-sync valid token + valid batch → 200 with per-event ACK applied", async () => {
    resolvePort();
    const batch = makeValidBatch("batch-happy");
    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      batchId: string;
      results: Array<{ eventId: string; status: string }>;
    };
    assert.equal(body.batchId, "batch-happy");
    assert.equal(body.results.length, 1);
    const happyResult = body.results[0];
    assert.ok(happyResult !== undefined, "results[0] should exist");
    assert.equal(happyResult.eventId, "evt-001");
    assert.equal(happyResult.status, "applied");
  });

  // ── Auth failures ──────────────────────────────────────────────────────────

  it("POST /reverse-sync with wrong token returns 401 and does not mutate", async () => {
    resolvePort();
    const before_size = processedBatchIds.size;
    const res = await httpPost(port, "/reverse-sync", makeValidBatch("batch-wrong-tok"), "bad-token");
    assert.equal(res.status, 401);
    // no new batch should have been added
    assert.equal(processedBatchIds.size, before_size);
  });

  it("POST /reverse-sync with missing token returns 401", async () => {
    resolvePort();
    const res = await httpPost(port, "/reverse-sync", makeValidBatch("batch-no-tok"));
    assert.equal(res.status, 401);
  });

  // ── Bad request bodies ─────────────────────────────────────────────────────

  it("POST /reverse-sync with malformed JSON body returns 400", async () => {
    resolvePort();
    const res = await httpPost(port, "/reverse-sync", null, TEST_TOKEN, "{ not valid json [");
    assert.equal(res.status, 400);
  });

  it("POST /reverse-sync with missing required fields (no events) returns 400", async () => {
    resolvePort();
    const res = await httpPost(
      port,
      "/reverse-sync",
      { batchId: "batch-no-events", sentAt: "2026-02-25T10:00:00.000Z" },
      TEST_TOKEN
    );
    assert.equal(res.status, 400);
  });

  it("POST /reverse-sync with event missing required field returns 400", async () => {
    resolvePort();
    const invalidBatch = {
      batchId: "batch-bad-event",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        {
          // missing eventId, bookmarkId, managedKey, occurredAt
          type: "bookmark_created"
        }
      ]
    };
    const res = await httpPost(port, "/reverse-sync", invalidBatch, TEST_TOKEN);
    assert.equal(res.status, 400);
  });

  // ── Idempotency ────────────────────────────────────────────────────────────

  it("POST /reverse-sync same batchId twice → first applied, second all duplicate", async () => {
    resolvePort();
    const batch = makeValidBatch("batch-idem-check", "evt-idem-001");

    const first = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      results: Array<{ eventId: string; status: string }>;
    };
    const firstResult = firstBody.results[0];
    assert.ok(firstResult !== undefined, "firstBody.results[0] should exist");
    assert.equal(firstResult.status, "applied");

    const second = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as {
      batchId: string;
      results: Array<{ eventId: string; status: string }>;
    };
    assert.equal(secondBody.batchId, "batch-idem-check");
    assert.equal(secondBody.results.length, 1);
    const secondResult = secondBody.results[0];
    assert.ok(secondResult !== undefined, "secondBody.results[0] should exist");
    assert.equal(secondResult.eventId, "evt-idem-001");
    assert.equal(secondResult.status, "duplicate");
  });

  // ── Unknown route ──────────────────────────────────────────────────────────

  it("unknown route returns 404", async () => {
    resolvePort();
    const res = await httpGet(port, "/unknown-path");
    assert.equal(res.status, 404);
  });
});
