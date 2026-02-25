export const REVERSE_SYNC_SCHEMA_VERSION = "1";

export const REVERSE_EVENT_TYPES = [
  "bookmark_created",
  "bookmark_updated",
  "bookmark_deleted",
  "folder_renamed"
] as const;

export type ReverseEventType = (typeof REVERSE_EVENT_TYPES)[number];

export interface ReverseEvent {
  batchId: string;
  eventId: string;
  type: ReverseEventType;
  bookmarkId: string;
  managedKey: string;
  parentId?: string;
  title?: string;
  url?: string;
  occurredAt: string;
  schemaVersion: string;
}

export interface ReverseBatch {
  batchId: string;
  events: ReverseEvent[];
  sentAt: string;
}

export type AckStatus = "applied" | "skipped_ambiguous" | "skipped_unmanaged" | "rejected_invalid" | "duplicate";

export interface EventAck {
  eventId: string;
  status: AckStatus;
  resolvedPath?: string;
  resolvedKey?: string;
  reason?: string;
}

export interface BatchAckResponse {
  batchId: string;
  results: EventAck[];
}

export function parseAndValidateReverseBatch(body: unknown): ReverseBatch | null {
  if (!isRecord(body)) {
    return null;
  }

  const batchId = readString(body.batchId);
  const sentAt = readString(body.sentAt);
  const events = body.events;

  if (!batchId || !sentAt || !Array.isArray(events)) {
    return null;
  }

  const parsedEvents: ReverseEvent[] = [];
  for (const rawEvent of events) {
    const parsedEvent = parseEvent(rawEvent, batchId);
    if (!parsedEvent) {
      return null;
    }
    parsedEvents.push(parsedEvent);
  }

  return {
    batchId,
    sentAt,
    events: parsedEvents
  };
}

function parseEvent(rawEvent: unknown, fallbackBatchId: string): ReverseEvent | null {
  if (!isRecord(rawEvent)) {
    return null;
  }

  const batchId = readString(rawEvent.batchId) ?? fallbackBatchId;
  const eventId = readString(rawEvent.eventId);
  const type = readEventType(rawEvent.type);
  const bookmarkId = readString(rawEvent.bookmarkId);
  const managedKey = readString(rawEvent.managedKey);
  const occurredAt = readString(rawEvent.occurredAt);
  const schemaVersion = readSchemaVersion(rawEvent);

  if (!batchId || !eventId || !type || !bookmarkId || !managedKey || !occurredAt || !schemaVersion) {
    return null;
  }

  const parentId = readOptionalString(rawEvent.parentId);
  const title = readOptionalString(rawEvent.title);
  const url = readOptionalString(rawEvent.url);

  if (parentId === null || title === null || url === null) {
    return null;
  }

  return {
    batchId,
    eventId,
    type,
    bookmarkId,
    managedKey,
    parentId: parentId ?? undefined,
    title: title ?? undefined,
    url: url ?? undefined,
    occurredAt,
    schemaVersion
  };
}

function readSchemaVersion(eventRecord: Record<string, unknown>): string | null {
  const schemaVersion = readString(eventRecord.schemaVersion);
  if (schemaVersion) {
    return schemaVersion;
  }

  const legacyVersion = readString(eventRecord.version);
  if (legacyVersion) {
    return legacyVersion;
  }

  return REVERSE_SYNC_SCHEMA_VERSION;
}

function readEventType(value: unknown): ReverseEventType | null {
  if (typeof value !== "string") {
    return null;
  }
  return REVERSE_EVENT_TYPES.includes(value as ReverseEventType) ? (value as ReverseEventType) : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
