import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeBridgeHeartbeatMs,
  normalizeBridgePath,
  normalizeBridgePort,
  normalizeBridgeClients,
  normalizeBridgeSettings,
  resolveActiveClient
} from "./extension-bridge-config";

describe("normalizeBridgePort", () => {
  it("uses default when not finite", () => {
    assert.equal(normalizeBridgePort(Number.NaN), 27123);
  });

  it("clamps lower bound", () => {
    assert.equal(normalizeBridgePort(12), 1024);
  });

  it("clamps upper bound", () => {
    assert.equal(normalizeBridgePort(70000), 65535);
  });

  it("returns integer port in range", () => {
    assert.equal(normalizeBridgePort(27123.9), 27123);
  });
});

describe("normalizeBridgePath", () => {
  it("uses default when empty", () => {
    assert.equal(normalizeBridgePath(""), "/ws");
  });

  it("adds leading slash when missing", () => {
    assert.equal(normalizeBridgePath("socket"), "/socket");
  });
});

describe("normalizeBridgeHeartbeatMs", () => {
  it("uses default when invalid", () => {
    assert.equal(normalizeBridgeHeartbeatMs(Number.NaN), 30000);
  });

  it("clamps min and max", () => {
    assert.equal(normalizeBridgeHeartbeatMs(100), 1000);
    assert.equal(normalizeBridgeHeartbeatMs(300000), 120000);
  });
});

describe("normalizeBridgeClients", () => {
  it("creates fallback client when array is missing", () => {
    const clients = normalizeBridgeClients(undefined, "legacy-token");
    assert.equal(clients.length, 1);
    assert.equal(clients[0]?.token, "legacy-token");
  });

  it("dedupes client ids and sanitizes scopes", () => {
    const clients = normalizeBridgeClients(
      [
        { clientId: "a", token: "x", enabled: true, scopes: ["sync:read", "sync:read", ""] },
        { clientId: "a", token: "y", enabled: true, scopes: ["sync:write"] }
      ],
      "legacy"
    );
    assert.equal(clients.length, 1);
    assert.deepEqual(clients[0]?.scopes, ["sync:read"]);
    assert.equal(clients[0]?.token, "x");
  });
});

describe("resolveActiveClient", () => {
  it("prefers enabled active client id", () => {
    const selected = resolveActiveClient(
      [
        { clientId: "a", token: "x", enabled: true, scopes: ["sync:read"] },
        { clientId: "b", token: "y", enabled: true, scopes: ["sync:write"] }
      ],
      "b"
    );
    assert.equal(selected.clientId, "b");
  });

  it("falls back to first enabled client", () => {
    const selected = resolveActiveClient(
      [
        { clientId: "a", token: "x", enabled: false, scopes: ["sync:read"] },
        { clientId: "b", token: "y", enabled: true, scopes: ["sync:write"] }
      ],
      "a"
    );
    assert.equal(selected.clientId, "b");
  });
});

describe("normalizeBridgeSettings", () => {
  it("migrates legacy single-client fields", () => {
    const normalized = normalizeBridgeSettings({
      extensionBridgeEnabled: false,
      extensionBridgePort: 29999,
      extensionBridgeToken: "legacy-token"
    });

    assert.equal(normalized.extensionBridgeServerEnabled, false);
    assert.equal(normalized.extensionBridgeServerPort, 29999);
    assert.equal(normalized.extensionBridgeClients.length, 1);
    assert.equal(normalized.extensionBridgeClients[0]?.token, "legacy-token");
    assert.equal(normalized.extensionBridgeActiveClientId, "local-event-gateway");
  });

  it("prefers modern fields when present", () => {
    const normalized = normalizeBridgeSettings({
      extensionBridgeServerEnabled: true,
      extensionBridgeServerPort: 30123,
      extensionBridgeServerPath: "socket",
      extensionBridgeHeartbeatMs: 5000,
      extensionBridgeClients: [{ clientId: "client-a", token: "tok-a", enabled: true, scopes: ["sync:read"] }],
      extensionBridgeActiveClientId: "client-a",
      extensionBridgeToken: "legacy-token"
    });

    assert.equal(normalized.extensionBridgeServerEnabled, true);
    assert.equal(normalized.extensionBridgeServerPort, 30123);
    assert.equal(normalized.extensionBridgeServerPath, "/socket");
    assert.equal(normalized.extensionBridgeHeartbeatMs, 5000);
    assert.equal(normalized.extensionBridgeClients[0]?.token, "tok-a");
    assert.equal(normalized.extensionBridgeActiveClientId, "client-a");
  });
});
