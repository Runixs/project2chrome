import type { AckStatus } from "./reverse-sync-types";

export const WS_ACTION_SCHEMA_VERSION = "1.0";

export const WS_MESSAGE_TYPES = [
  "handshake",
  "handshake_ack",
  "action",
  "ack",
  "error",
  "heartbeat_ping",
  "heartbeat_pong"
] as const;

export type WsMessageType = (typeof WS_MESSAGE_TYPES)[number];

export const WS_ACK_STATUSES = ["received", "applied", "duplicate", "skipped", "rejected"] as const;

export type WsAckStatus = (typeof WS_ACK_STATUSES)[number];

interface WsEnvelopeBase {
  type: WsMessageType;
  eventId: string;
  clientId: string;
  occurredAt: string;
  schemaVersion: string;
  idempotencyKey?: string;
  correlationId?: string;
}

export interface WsHandshakeMessage extends WsEnvelopeBase {
  type: "handshake";
  sessionId: string;
  token: string;
  capabilities?: string[];
}

export interface WsHandshakeAckMessage extends WsEnvelopeBase {
  type: "handshake_ack";
  sessionId: string;
  accepted: boolean;
  heartbeatMs: number;
}

export interface WsActionMessage extends WsEnvelopeBase {
  type: "action";
  op: string;
  target: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}

export interface WsAckMessage extends WsEnvelopeBase {
  type: "ack";
  correlationId: string;
  status: WsAckStatus;
  reason?: string;
  resolvedPath?: string;
  resolvedKey?: string;
  legacyStatus?: AckStatus;
}

export interface WsErrorMessage extends WsEnvelopeBase {
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface WsHeartbeatPingMessage extends WsEnvelopeBase {
  type: "heartbeat_ping";
}

export interface WsHeartbeatPongMessage extends WsEnvelopeBase {
  type: "heartbeat_pong";
  correlationId: string;
}

export type WsEnvelope =
  | WsHandshakeMessage
  | WsHandshakeAckMessage
  | WsActionMessage
  | WsAckMessage
  | WsErrorMessage
  | WsHeartbeatPingMessage
  | WsHeartbeatPongMessage;

export function mapLegacyAckStatus(status: AckStatus): WsAckStatus {
  if (status === "applied") {
    return "applied";
  }
  if (status === "duplicate") {
    return "duplicate";
  }
  if (status === "skipped_ambiguous" || status === "skipped_unmanaged") {
    return "skipped";
  }
  return "rejected";
}

export function parseAndValidateWsEnvelope(body: unknown): WsEnvelope | null {
  if (!isRecord(body)) {
    return null;
  }

  const type = readMessageType(body.type);
  const eventId = readString(body.eventId);
  const clientId = readString(body.clientId);
  const occurredAt = readString(body.occurredAt);
  const schemaVersion = readString(body.schemaVersion);
  const idempotencyKey = readOptionalString(body.idempotencyKey);
  const correlationId = readOptionalString(body.correlationId);

  if (!type || !eventId || !clientId || !occurredAt || !schemaVersion) {
    return null;
  }
  if (idempotencyKey === null || correlationId === null) {
    return null;
  }

  if (type === "handshake") {
    const sessionId = readString(body.sessionId);
    const token = readString(body.token);
    const capabilities = readOptionalStringArray(body.capabilities);
    if (!sessionId || !token || capabilities === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey ?? undefined,
      correlationId: correlationId ?? undefined,
      sessionId,
      token,
      capabilities: capabilities ?? undefined
    };
  }

  if (type === "handshake_ack") {
    const sessionId = readString(body.sessionId);
    const accepted = body.accepted;
    const heartbeatMs = readHeartbeatMs(body.heartbeatMs);
    if (!sessionId || typeof accepted !== "boolean" || heartbeatMs === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey ?? undefined,
      correlationId: correlationId ?? undefined,
      sessionId,
      accepted,
      heartbeatMs
    };
  }

  if (type === "action") {
    const op = readString(body.op);
    const target = readString(body.target);
    const payload = readRecord(body.payload);
    if (!op || !target || !payload || !idempotencyKey) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey,
      correlationId: correlationId ?? undefined,
      op,
      target,
      payload
    };
  }

  if (type === "ack") {
    const status = readWsAckStatus(body.status);
    const reason = readOptionalString(body.reason);
    const resolvedPath = readOptionalString(body.resolvedPath);
    const resolvedKey = readOptionalString(body.resolvedKey);
    const legacyStatus = readOptionalLegacyStatus(body.legacyStatus);
    if (!status || !correlationId || reason === null || resolvedPath === null || resolvedKey === null || legacyStatus === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey ?? undefined,
      correlationId,
      status,
      reason: reason ?? undefined,
      resolvedPath: resolvedPath ?? undefined,
      resolvedKey: resolvedKey ?? undefined,
      legacyStatus: legacyStatus ?? undefined
    };
  }

  if (type === "error") {
    const code = readString(body.code);
    const message = readString(body.message);
    const retryable = body.retryable;
    const details = readOptionalRecord(body.details);
    if (!code || !message || typeof retryable !== "boolean" || details === null) {
      return null;
    }
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey ?? undefined,
      correlationId: correlationId ?? undefined,
      code,
      message,
      retryable,
      details: details ?? undefined
    };
  }

  if (type === "heartbeat_ping") {
    return {
      type,
      eventId,
      clientId,
      occurredAt,
      schemaVersion,
      idempotencyKey: idempotencyKey ?? undefined,
      correlationId: correlationId ?? undefined
    };
  }

  if (!correlationId) {
    return null;
  }

  return {
    type,
    eventId,
    clientId,
    occurredAt,
    schemaVersion,
    idempotencyKey: idempotencyKey ?? undefined,
    correlationId
  };
}

function readMessageType(value: unknown): WsMessageType | null {
  if (typeof value !== "string") {
    return null;
  }
  return WS_MESSAGE_TYPES.includes(value as WsMessageType) ? (value as WsMessageType) : null;
}

function readWsAckStatus(value: unknown): WsAckStatus | null {
  if (typeof value !== "string") {
    return null;
  }
  return WS_ACK_STATUSES.includes(value as WsAckStatus) ? (value as WsAckStatus) : null;
}

function readOptionalLegacyStatus(value: unknown): AckStatus | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return null;
  }
  if (
    value === "applied" ||
    value === "skipped_ambiguous" ||
    value === "skipped_unmanaged" ||
    value === "rejected_invalid" ||
    value === "duplicate"
  ) {
    return value;
  }
  return null;
}

function readHeartbeatMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return null;
  }
  return value >= 1000 && value <= 120000 ? value : null;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readString(value);
}

function readOptionalStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const result: string[] = [];
  for (const item of value) {
    const parsed = readString(item);
    if (!parsed) {
      return null;
    }
    result.push(parsed);
  }
  return result;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }
  return value;
}

function readOptionalRecord(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
