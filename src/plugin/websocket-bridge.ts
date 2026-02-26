import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { EventAck } from "./reverse-sync-types";
import { WS_ACTION_SCHEMA_VERSION, mapLegacyAckStatus, parseAndValidateWsEnvelope, type WsActionMessage, type WsEnvelope } from "./websocket-action-types";
import type { ExtensionBridgeClient } from "./types";

export interface WebSocketBridgeOptions {
  server: Server;
  path: string;
  heartbeatMs: number;
  getClients: () => ExtensionBridgeClient[];
  getSnapshotPayload: (clientId: string) => Record<string, unknown> | null;
  applyAction: (clientId: string, action: WsActionMessage) => EventAck | Promise<EventAck>;
  onLog?: (level: "info" | "warn" | "error", event: string, data?: Record<string, string>) => void;
}

export interface OutboundAction {
  clientId?: string;
  op: string;
  target: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  correlationId?: string;
}

export interface WebSocketBridge {
  close(): Promise<void>;
  broadcastAction(action: OutboundAction): void;
  sendSnapshot(clientId?: string): void;
}

interface SessionState {
  authenticated: boolean;
  clientId: string | null;
  sessionId: string | null;
  lastSeenAt: number;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

const CLOSE_HANDSHAKE_REQUIRED = 4001;
const CLOSE_UNAUTHORIZED = 4003;
const CLOSE_HEARTBEAT_TIMEOUT = 4000;
const CLOSE_INVALID_FRAME = 1008;
const MAX_BUFFERED_BYTES = 1_000_000;
const WS_MAX_PAYLOAD_BYTES = 256 * 1024;

export function createWebSocketBridge(options: WebSocketBridgeOptions): WebSocketBridge {
  const normalizedPath = normalizePath(options.path);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WS_MAX_PAYLOAD_BYTES
  });
  const sessionBySocket = new Map<WebSocket, SessionState>();
  const socketsByClientId = new Map<string, Set<WebSocket>>();

  const onUpgrade = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== normalizedPath) {
      socket.destroy();
      return;
    }

    const origin = request.headers.origin;
    if (!isAllowedUpgradeOrigin(origin)) {
      log(options, "warn", "ws_upgrade_rejected_origin", {
        reason: typeof origin === "string" ? origin : "missing_or_invalid"
      });
      rejectUpgrade(socket, 403, "forbidden_origin");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      wss.emit("connection", ws);
    });
  };

  options.server.on("upgrade", onUpgrade);

  wss.on("connection", (socket) => {
    const session: SessionState = {
      authenticated: false,
      clientId: null,
      sessionId: null,
      lastSeenAt: Date.now(),
      handshakeTimer: null
    };
    sessionBySocket.set(socket, session);

    const handshakeTimeoutMs = Math.max(2000, options.heartbeatMs);
    session.handshakeTimer = setTimeout(() => {
      if (!session.authenticated) {
        socket.close(CLOSE_HANDSHAKE_REQUIRED, "handshake_timeout");
      }
    }, handshakeTimeoutMs);

    socket.on("message", (raw: RawData) => {
      void handleIncomingMessage(socket, session, raw);
    });

    socket.on("close", () => {
      if (session.handshakeTimer) {
        clearTimeout(session.handshakeTimer);
        session.handshakeTimer = null;
      }
      unregisterSocket(socket, session);
      sessionBySocket.delete(socket);
    });

    socket.on("error", () => {
      if (session.handshakeTimer) {
        clearTimeout(session.handshakeTimer);
        session.handshakeTimer = null;
      }
      unregisterSocket(socket, session);
      sessionBySocket.delete(socket);
    });
  });

  const heartbeatIntervalMs = Math.max(500, Math.trunc(options.heartbeatMs / 2));
  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [socket, session] of sessionBySocket.entries()) {
      if (!session.authenticated || !session.clientId) {
        continue;
      }
      if (now - session.lastSeenAt > options.heartbeatMs * 2) {
        log(options, "warn", "ws_heartbeat_timeout", { clientId: session.clientId });
        socket.close(CLOSE_HEARTBEAT_TIMEOUT, "heartbeat_timeout");
        continue;
      }
      sendEnvelope(socket, {
        type: "heartbeat_ping",
        eventId: randomUUID(),
        clientId: session.clientId,
        occurredAt: new Date().toISOString(),
        schemaVersion: WS_ACTION_SCHEMA_VERSION
      });
    }
  }, heartbeatIntervalMs);

  async function handleIncomingMessage(socket: WebSocket, session: SessionState, raw: RawData): Promise<void> {
    session.lastSeenAt = Date.now();

    const envelope = parseIncomingEnvelope(raw);
    if (!envelope) {
      sendError(socket, session.clientId ?? "unknown", "invalid_frame", "Invalid websocket frame", false);
      socket.close(CLOSE_INVALID_FRAME, "invalid_frame");
      return;
    }

    if (!session.authenticated) {
      handleUnauthenticatedMessage(socket, session, envelope);
      return;
    }

    if (!session.clientId || envelope.clientId !== session.clientId) {
      sendError(socket, session.clientId ?? envelope.clientId, "client_mismatch", "clientId mismatch for active session", false, envelope.eventId);
      return;
    }

    if (envelope.type === "heartbeat_ping") {
      sendEnvelope(socket, {
        type: "heartbeat_pong",
        eventId: randomUUID(),
        clientId: session.clientId,
        occurredAt: new Date().toISOString(),
        schemaVersion: WS_ACTION_SCHEMA_VERSION,
        correlationId: envelope.eventId
      });
      return;
    }

    if (envelope.type === "heartbeat_pong") {
      return;
    }

    if (envelope.type !== "action") {
      sendError(socket, session.clientId, "unsupported_type", `Unsupported message type: ${envelope.type}`, false, envelope.eventId);
      return;
    }

    try {
      const ack = await options.applyAction(session.clientId, envelope);
      sendEnvelope(socket, {
        type: "ack",
        eventId: randomUUID(),
        clientId: session.clientId,
        occurredAt: new Date().toISOString(),
        schemaVersion: WS_ACTION_SCHEMA_VERSION,
        correlationId: envelope.eventId,
        idempotencyKey: envelope.idempotencyKey,
        status: mapLegacyAckStatus(ack.status),
        legacyStatus: ack.status,
        reason: ack.reason,
        resolvedPath: ack.resolvedPath,
        resolvedKey: ack.resolvedKey
      });
      log(options, "info", "ws_ack_sent", {
        clientId: session.clientId,
        eventId: envelope.eventId,
        status: ack.status
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(socket, session.clientId, "action_apply_failed", message, true, envelope.eventId);
      log(options, "error", "ws_action_error", {
        clientId: session.clientId,
        eventId: envelope.eventId,
        reason: message
      });
    }
  }

  function handleUnauthenticatedMessage(socket: WebSocket, session: SessionState, envelope: WsEnvelope): void {
    if (envelope.type !== "handshake") {
      sendError(socket, envelope.clientId, "handshake_required", "Handshake required before other message types", false, envelope.eventId);
      socket.close(CLOSE_HANDSHAKE_REQUIRED, "handshake_required");
      return;
    }

    const matchedClient = options
      .getClients()
      .find((client) => client.enabled && client.clientId === envelope.clientId);
    if (!matchedClient || matchedClient.token !== envelope.token) {
      sendError(socket, envelope.clientId, "unauthorized", "Token rejected for client", false, envelope.eventId);
      socket.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return;
    }

    session.authenticated = true;
    session.clientId = envelope.clientId;
    session.sessionId = envelope.sessionId;
    session.lastSeenAt = Date.now();
    if (session.handshakeTimer) {
      clearTimeout(session.handshakeTimer);
      session.handshakeTimer = null;
    }
    registerSocketForClient(socket, envelope.clientId);

    sendEnvelope(socket, {
      type: "handshake_ack",
      eventId: randomUUID(),
      clientId: envelope.clientId,
      occurredAt: new Date().toISOString(),
      schemaVersion: WS_ACTION_SCHEMA_VERSION,
      correlationId: envelope.eventId,
      sessionId: envelope.sessionId,
      accepted: true,
      heartbeatMs: options.heartbeatMs
    });

    sendSnapshotToSocket(socket, envelope.clientId);
    log(options, "info", "ws_connected", { clientId: envelope.clientId });
  }

  function sendSnapshotToSocket(socket: WebSocket, clientId: string): void {
    const payload = options.getSnapshotPayload(clientId);
    if (!payload) {
      log(options, "warn", "ws_snapshot_skipped", {
        clientId,
        reason: "snapshot_not_ready"
      });
      return;
    }
    sendEnvelope(socket, {
      type: "action",
      eventId: randomUUID(),
      clientId,
      occurredAt: new Date().toISOString(),
      schemaVersion: WS_ACTION_SCHEMA_VERSION,
      idempotencyKey: randomUUID(),
      op: "snapshot",
      target: "bookmark_tree",
      payload
    });
  }

  function broadcastAction(action: OutboundAction): void {
    const targetSockets = getTargetSockets(action.clientId);
    for (const socket of targetSockets) {
      const session = sessionBySocket.get(socket);
      if (!session || !session.clientId) {
        continue;
      }
      sendEnvelope(socket, {
        type: "action",
        eventId: randomUUID(),
        clientId: session.clientId,
        occurredAt: new Date().toISOString(),
        schemaVersion: WS_ACTION_SCHEMA_VERSION,
        idempotencyKey: action.idempotencyKey ?? randomUUID(),
        correlationId: action.correlationId,
        op: action.op,
        target: action.target,
        payload: action.payload
      });
    }
  }

  function sendSnapshot(clientId?: string): void {
    const targetSockets = getTargetSockets(clientId);
    for (const socket of targetSockets) {
      const session = sessionBySocket.get(socket);
      if (!session || !session.clientId) {
        continue;
      }
      sendSnapshotToSocket(socket, session.clientId);
    }
  }

  function getTargetSockets(clientId?: string): Set<WebSocket> {
    if (clientId) {
      return new Set(socketsByClientId.get(clientId) ?? []);
    }
    const all = new Set<WebSocket>();
    for (const sockets of socketsByClientId.values()) {
      for (const socket of sockets) {
        all.add(socket);
      }
    }
    return all;
  }

  async function close(): Promise<void> {
    clearInterval(heartbeatTimer);
    options.server.off("upgrade", onUpgrade);
    for (const socket of sessionBySocket.keys()) {
      try {
        socket.close();
      } catch {}
    }
    await new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });
  }

  return {
    close,
    broadcastAction,
    sendSnapshot
  };

  function registerSocketForClient(socket: WebSocket, clientId: string): void {
    let sockets = socketsByClientId.get(clientId);
    if (!sockets) {
      sockets = new Set<WebSocket>();
      socketsByClientId.set(clientId, sockets);
    }
    sockets.add(socket);
  }

  function unregisterSocket(socket: WebSocket, session: SessionState): void {
    if (!session.clientId) {
      return;
    }
    const sockets = socketsByClientId.get(session.clientId);
    if (!sockets) {
      return;
    }
    sockets.delete(socket);
    if (sockets.size === 0) {
      socketsByClientId.delete(session.clientId);
    }
    log(options, "info", "ws_disconnected", { clientId: session.clientId });
  }
}

function parseIncomingEnvelope(raw: RawData): WsEnvelope | null {
  try {
    let text = "";
    if (typeof raw === "string") {
      text = raw;
    } else if (raw instanceof Buffer) {
      text = raw.toString("utf8");
    } else if (Array.isArray(raw)) {
      const chunks = raw.map((chunk) => (chunk instanceof Buffer ? chunk : Buffer.from(chunk)));
      text = Buffer.concat(chunks).toString("utf8");
    } else {
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw as unknown as ArrayBuffer);
      text = Buffer.from(bytes).toString("utf8");
    }
    const parsed = JSON.parse(text) as unknown;
    return parseAndValidateWsEnvelope(parsed);
  } catch {
    return null;
  }
}

function sendEnvelope(socket: WebSocket, envelope: Record<string, unknown>): void {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    socket.close(1013, "backpressure");
    return;
  }
  socket.send(JSON.stringify(envelope));
}

function sendError(
  socket: WebSocket,
  clientId: string,
  code: string,
  message: string,
  retryable: boolean,
  correlationId?: string
): void {
  sendEnvelope(socket, {
    type: "error",
    eventId: randomUUID(),
    clientId,
    occurredAt: new Date().toISOString(),
    schemaVersion: WS_ACTION_SCHEMA_VERSION,
    correlationId,
    code,
    message,
    retryable
  });
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/ws";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function isAllowedUpgradeOrigin(origin: unknown): boolean {
  if (origin === undefined) {
    return true;
  }
  if (typeof origin !== "string") {
    return false;
  }
  return origin.startsWith("chrome-extension://");
}

function rejectUpgrade(socket: Socket, status: number, body: string): void {
  try {
    socket.write(`HTTP/1.1 ${String(status)} Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${String(body.length)}\r\n\r\n${body}`);
  } finally {
    socket.destroy();
  }
}

function log(
  options: WebSocketBridgeOptions,
  level: "info" | "warn" | "error",
  event: string,
  data?: Record<string, string>
): void {
  options.onLog?.(level, event, data);
}
