/**
 * Structured audit logger for the reverse-sync pipeline.
 * Emits redact-safe JSON entries — never logs tokens, full note content,
 * or raw file paths containing sensitive data.
 */

export type ReverseLogLevel = "info" | "warn" | "error";

export interface ReverseLogEntry {
  timestamp: string;
  level: ReverseLogLevel;
  event: string;
  batchId?: string;
  eventId?: string;
  status?: string;
  reason?: string;
  resolvedPath?: string;
}

export interface ReverseLogger {
  logEnqueue(batchId: string, eventId: string, type: string): void;
  logFlush(batchId: string, eventCount: number): void;
  logAck(
    batchId: string,
    eventId: string,
    status: string,
    resolvedPath?: string,
    reason?: string
  ): void;
  logSkip(batchId: string, eventId: string, reason: string): void;
  logError(batchId: string | undefined, eventId: string | undefined, message: string): void;
}

/**
 * Factory that returns a structured reverse-sync logger.
 * The optional `sink` parameter overrides the default console.log output.
 * Callers that only need to capture entries for testing pass a custom sink.
 */
export function createReverseLogger(
  sink?: (entry: ReverseLogEntry) => void
): ReverseLogger {
  const emit = sink ?? ((entry: ReverseLogEntry) => {
    console.log(JSON.stringify(entry));
  });

  function ts(): string {
    return new Date().toISOString();
  }

  return {
    logEnqueue(batchId: string, eventId: string, type: string): void {
      emit({
        timestamp: ts(),
        level: "info",
        event: "enqueue",
        batchId,
        eventId,
        status: type
      });
    },

    logFlush(batchId: string, eventCount: number): void {
      emit({
        timestamp: ts(),
        level: "info",
        event: "flush",
        batchId,
        status: String(eventCount)
      });
    },

    logAck(
      batchId: string,
      eventId: string,
      status: string,
      resolvedPath?: string,
      reason?: string
    ): void {
      const entry: ReverseLogEntry = {
        timestamp: ts(),
        level: "info",
        event: "ack",
        batchId,
        eventId,
        status
      };
      if (resolvedPath !== undefined) {
        entry.resolvedPath = resolvedPath;
      }
      if (reason !== undefined) {
        entry.reason = reason;
      }
      emit(entry);
    },

    logSkip(batchId: string, eventId: string, reason: string): void {
      emit({
        timestamp: ts(),
        level: "warn",
        event: "skip",
        batchId,
        eventId,
        reason
      });
    },

    logError(
      batchId: string | undefined,
      eventId: string | undefined,
      message: string
    ): void {
      const entry: ReverseLogEntry = {
        timestamp: ts(),
        level: "error",
        event: "error",
        status: message
      };
      if (batchId !== undefined) {
        entry.batchId = batchId;
      }
      if (eventId !== undefined) {
        entry.eventId = eventId;
      }
      emit(entry);
    }
  };
}
