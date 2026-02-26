import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import WebSocket, { type RawData } from "ws";
import { createWebSocketBridge, type WebSocketBridge } from "./websocket-bridge";
import type { EventAck } from "./reverse-sync-types";

interface Harness {
  port: number;
  bridge: WebSocketBridge;
  close: () => Promise<void>;
  actions: string[];
}

const activeHarnesses: Harness[] = [];

afterEach(async () => {
  while (activeHarnesses.length > 0) {
    const harness = activeHarnesses.pop();
    if (harness) {
      await harness.close();
    }
  }
});

describe("createWebSocketBridge", () => {
  it("accepts valid handshake and sends handshake_ack + snapshot", async () => {
    const harness = await createHarness();
    const ws = await openClient(harness.port);

    ws.send(
      JSON.stringify({
        type: "handshake",
        eventId: "evt-h-1",
        clientId: "client-a",
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        sessionId: "session-a",
        token: "token-a"
      })
    );

    const initial = await collectJsonMessages(ws, 2, 1500);
    const a = initial[0];
    const b = initial[1];
    assert.ok(a);
    assert.ok(b);
    const receivedTypes = new Set([String(a.type), String(b.type)]);

    assert.equal(receivedTypes.has("handshake_ack"), true);
    assert.equal(receivedTypes.has("action"), true);
    const snapshot = String(a.type) === "action" ? a : b;
    assert.ok(snapshot);
    assert.equal(snapshot.op, "snapshot");
    assert.equal(snapshot.target, "bookmark_tree");

    ws.close();
  });

  it("rejects handshake when token is wrong", async () => {
    const harness = await createHarness();
    const ws = await openClient(harness.port);

    const closePromise = waitForClose(ws, 1500);
    ws.send(
      JSON.stringify({
        type: "handshake",
        eventId: "evt-h-2",
        clientId: "client-a",
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        sessionId: "session-a",
        token: "bad-token"
      })
    );

    const closed = await closePromise;
    assert.equal(closed.code, 4003);
  });

  it("acks inbound action frames via applyAction callback", async () => {
    const harness = await createHarness({
      applyAction: () => ({
        eventId: "evt-action-1",
        status: "applied",
        resolvedKey: "note:Projects/Alpha.md|0"
      })
    });
    const ws = await openClient(harness.port);

    ws.send(
      JSON.stringify({
        type: "handshake",
        eventId: "evt-h-3",
        clientId: "client-a",
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        sessionId: "session-a",
        token: "token-a"
      })
    );

    await collectJsonMessages(ws, 2, 1500);

    ws.send(
      JSON.stringify({
        type: "action",
        eventId: "evt-action-1",
        clientId: "client-a",
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        idempotencyKey: "idem-1",
        op: "bookmark_updated",
        target: "note:Projects/Alpha.md|0",
        payload: {
          bookmarkId: "bk-1",
          managedKey: "note:Projects/Alpha.md|0",
          title: "changed"
        }
      })
    );

    const ack = await waitForJsonMessage(ws);
    assert.equal(ack.type, "ack");
    assert.equal(ack.correlationId, "evt-action-1");
    assert.equal(ack.status, "applied");
    assert.equal(ack.legacyStatus, "applied");
    assert.equal(harness.actions.length, 1);

    ws.close();
  });

  it("routes broadcastAction to selected clientId", async () => {
    const harness = await createHarness();
    const wsA = await openClient(harness.port);
    const wsB = await openClient(harness.port);

    wsA.send(
      JSON.stringify({
        type: "handshake",
        eventId: "evt-h-a",
        clientId: "client-a",
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        sessionId: "session-a",
        token: "token-a"
      })
    );
    wsB.send(
      JSON.stringify({
        type: "handshake",
        eventId: "evt-h-b",
        clientId: "client-b",
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        sessionId: "session-b",
        token: "token-b"
      })
    );

    await Promise.all([
      collectJsonMessages(wsA, 2, 1500),
      collectJsonMessages(wsB, 2, 1500)
    ]);

    harness.bridge.broadcastAction({
      clientId: "client-a",
      op: "bookmark_updated",
      target: "note:Projects/Alpha.md|0",
      payload: { title: "A" }
    });

    const routed = await waitForJsonMessage(wsA);
    assert.equal(routed.type, "action");
    assert.equal(routed.op, "bookmark_updated");
    assert.equal(routed.clientId, "client-a");

    await assertNoMessage(wsB, 250);

    wsA.close();
    wsB.close();
  });

  it("closes idle connections on heartbeat timeout", async () => {
    const harness = await createHarness({ heartbeatMs: 150 });
    const ws = await openClient(harness.port);

    ws.send(
      JSON.stringify({
        type: "handshake",
        eventId: "evt-h-5",
        clientId: "client-a",
        occurredAt: new Date().toISOString(),
        schemaVersion: "1.0",
        sessionId: "session-a",
        token: "token-a"
      })
    );

    await collectJsonMessages(ws, 2, 1500);

    const closed = await waitForClose(ws, 2000);
    assert.equal(closed.code, 4000);
  });
});

async function createHarness(input?: {
  heartbeatMs?: number;
  applyAction?: () => EventAck;
}): Promise<Harness> {
  const server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  const actions: string[] = [];

  const bridge = createWebSocketBridge({
    server,
    path: "/ws",
    heartbeatMs: input?.heartbeatMs ?? 1000,
    getClients: () => [
      {
        clientId: "client-a",
        token: "token-a",
        enabled: true,
        scopes: ["sync:read", "sync:write"]
      },
      {
        clientId: "client-b",
        token: "token-b",
        enabled: true,
        scopes: ["sync:read"]
      }
    ],
    getSnapshotPayload: () => ({ desired: [] }),
    applyAction: (_clientId, action) => {
      actions.push(action.eventId);
      return input?.applyAction?.() ?? {
        eventId: action.eventId,
        status: "applied"
      };
    }
  });

  const harness: Harness = {
    port: address.port,
    bridge,
    actions,
    close: async () => {
      await bridge.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
  activeHarnesses.push(harness);
  return harness;
}

async function openClient(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

async function waitForJsonMessage(ws: WebSocket, timeoutMs = 1500): Promise<Record<string, unknown>> {
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timeout waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (raw: RawData): void => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      try {
        const text = rawToText(raw);
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
          return;
        }
        reject(new Error("message is not an object"));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    ws.on("message", onMessage);
  });
}

async function collectJsonMessages(
  ws: WebSocket,
  count: number,
  timeoutMs: number
): Promise<Record<string, unknown>[]> {
  return await new Promise<Record<string, unknown>[]>((resolve, reject) => {
    const messages: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("timeout waiting for websocket message"));
    }, timeoutMs);

    const onMessage = (raw: RawData): void => {
      try {
        const parsed = JSON.parse(rawToText(raw)) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("message is not an object");
        }
        messages.push(parsed as Record<string, unknown>);
        if (messages.length >= count) {
          clearTimeout(timeout);
          ws.off("message", onMessage);
          resolve(messages);
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.off("message", onMessage);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    ws.on("message", onMessage);
  });
}

async function assertNoMessage(ws: WebSocket, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("message", onMessage);
      resolve();
    }, timeoutMs);

    const onMessage = (): void => {
      clearTimeout(timeout);
      ws.off("message", onMessage);
      reject(new Error("unexpected websocket message"));
    };

    ws.on("message", onMessage);
  });
}

async function waitForClose(ws: WebSocket, timeoutMs: number): Promise<{ code: number; reason: string }> {
  return await new Promise<{ code: number; reason: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.off("close", onClose);
      reject(new Error("timeout waiting for websocket close"));
    }, timeoutMs);

    const onClose = (code: number, reason: Buffer): void => {
      clearTimeout(timeout);
      ws.off("close", onClose);
      resolve({
        code,
        reason: reason.toString("utf8")
      });
    };

    ws.on("close", onClose);
  });
}

function rawToText(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Buffer) {
    return raw.toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks = raw.map((chunk) => (chunk instanceof Buffer ? chunk : Buffer.from(chunk)));
    return Buffer.concat(chunks).toString("utf8");
  }
  return Buffer.from(raw as ArrayBuffer).toString("utf8");
}
