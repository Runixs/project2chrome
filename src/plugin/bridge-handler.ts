import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseAndValidateReverseBatch,
  type BatchAckResponse,
  type EventAck,
  type ReverseBatch
} from "./reverse-sync-types";
import type { ReverseLogEntry, ReverseLogger } from "./reverse-logger";

export type ApplyHook = (batch: ReverseBatch) => EventAck[] | Promise<EventAck[]>;

export interface BridgeHandlerConfig {
  expectedToken: string;
  getPayload: () => string;
  processedBatchIds: Set<string>;
  applyHook: ApplyHook;
  logger?: ReverseLogger;
  getDebugEntries?: () => ReverseLogEntry[];
  clearDebugEntries?: () => void;
}

/** Skeleton apply hook — returns 'applied' for every event. T8 replaces this with real mutation. */
export function skeletonApplyHook(batch: ReverseBatch): EventAck[] {
  return batch.events.map((e) => ({
      eventId: e.eventId,
      status: "applied" as const
    }));
}

/**
 * Creates the full HTTP request handler for the bridge server.
 * Handles /health, /payload (GET, auth-gated), and /reverse-sync (POST, auth-gated).
 * Extracted as a standalone factory so it can be tested without Obsidian.
 */
export function createBridgeHandler(
  config: BridgeHandlerConfig
): (req: IncomingMessage, res: ServerResponse) => void {
  const {
    expectedToken,
    getPayload,
    processedBatchIds,
    applyHook,
    logger,
    getDebugEntries,
    clearDebugEntries
  } = config;

  return (req, res) => {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const originHeader = req.headers.origin;

    if (originHeader !== undefined && !isAllowedHttpOrigin(originHeader)) {
      logger?.logError(undefined, undefined, "forbidden_origin");
      res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
      res.end('{"error":"forbidden origin"}\n');
      return;
    }

    if (typeof originHeader === "string" && isAllowedHttpOrigin(originHeader)) {
      res.setHeader("Access-Control-Allow-Origin", originHeader);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Project2Chrome-Token");

    if (method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (requestUrl.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end('{"ok":true}\n');
      return;
    }

    if (requestUrl.pathname === "/payload" && method === "GET") {
      const tokenHeader = req.headers["x-project2chrome-token"];
      const tokenValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      if ((tokenValue ?? "") !== expectedToken) {
        logger?.logError(undefined, undefined, "auth_failure");
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"error":"unauthorized"}\n');
        return;
      }

      const payload = getPayload();
      if (!payload) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"error":"payload not ready"}\n');
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(payload);
      return;
    }

    if (requestUrl.pathname === "/reverse-debug" && method === "GET") {
      const tokenHeader = req.headers["x-project2chrome-token"];
      const tokenValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      if ((tokenValue ?? "") !== expectedToken) {
        logger?.logError(undefined, undefined, "auth_failure");
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"error":"unauthorized"}\n');
        return;
      }

      const events = getDebugEntries ? getDebugEntries() : [];
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(`${JSON.stringify({ count: events.length, events })}\n`);
      return;
    }

    if (requestUrl.pathname === "/reverse-debug/clear" && method === "POST") {
      const tokenHeader = req.headers["x-project2chrome-token"];
      const tokenValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      if ((tokenValue ?? "") !== expectedToken) {
        logger?.logError(undefined, undefined, "auth_failure");
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"error":"unauthorized"}\n');
        return;
      }

      clearDebugEntries?.();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end('{"ok":true}\n');
      return;
    }

    if (requestUrl.pathname === "/reverse-sync" && method === "POST") {
      const tokenHeader = req.headers["x-project2chrome-token"];
      const tokenValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      if ((tokenValue ?? "") !== expectedToken) {
        logger?.logError(undefined, undefined, "auth_failure");
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"error":"unauthorized"}\n');
        return;
      }

      logger?.logEnqueue("request", "request", "reverse_sync_received");

      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", async () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          logger?.logError(undefined, undefined, "malformed_json");
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end('{"error":"malformed JSON"}\n');
          return;
        }

        const batch = parseAndValidateReverseBatch(parsed);
        if (!batch) {
          logger?.logError(undefined, undefined, "invalid_batch");
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end('{"error":"invalid batch"}\n');
          return;
        }

        if (processedBatchIds.has(batch.batchId)) {
          logger?.logFlush(batch.batchId, batch.events.length);
          const dupResponse: BatchAckResponse = {
            batchId: batch.batchId,
            results: batch.events.map((e) => ({
              eventId: e.eventId,
              status: "duplicate" as const
            }))
          };
          for (const result of dupResponse.results) {
            logger?.logAck(batch.batchId, result.eventId, result.status);
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(`${JSON.stringify(dupResponse)}\n`);
          return;
        }

        try {
          processedBatchIds.add(batch.batchId);
          logger?.logFlush(batch.batchId, batch.events.length);
          const results = await applyHook(batch);
          const ackResponse: BatchAckResponse = { batchId: batch.batchId, results };
          for (const result of ackResponse.results) {
            logger?.logAck(
              batch.batchId,
              result.eventId,
              result.status,
              result.resolvedPath,
              result.reason
            );
          }
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(`${JSON.stringify(ackResponse)}\n`);
        } catch {
          logger?.logError(batch.batchId, undefined, "reverse_apply_failed");
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end('{"error":"reverse apply failed"}\n');
        }
      });

      req.on("error", () => {
        if (!res.headersSent) {
          logger?.logError(undefined, undefined, "request_read_error");
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end('{"error":"request read error"}\n');
        }
      });

      return;
    }

    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    res.end('{"error":"not found"}\n');
  };
}

function isAllowedHttpOrigin(originHeader: string | string[]): boolean {
  if (Array.isArray(originHeader)) {
    if (originHeader.length !== 1) {
      return false;
    }
    return isAllowedHttpOrigin(originHeader[0] ?? "");
  }

  const origin = originHeader.trim();
  if (!origin) {
    return false;
  }

  return origin.startsWith("chrome-extension://");
}
