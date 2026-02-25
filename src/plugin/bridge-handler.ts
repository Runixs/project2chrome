import type { IncomingMessage, ServerResponse } from "node:http";
import {
  parseAndValidateReverseBatch,
  type BatchAckResponse,
  type ReverseBatch
} from "./reverse-sync-types";

export type ApplyHook = (batch: ReverseBatch) => BatchAckResponse;

export interface BridgeHandlerConfig {
  expectedToken: string;
  getPayload: () => string;
  processedBatchIds: Set<string>;
  applyHook: ApplyHook;
}

/** Skeleton apply hook — returns 'applied' for every event. T8 replaces this with real mutation. */
export function skeletonApplyHook(batch: ReverseBatch): BatchAckResponse {
  return {
    batchId: batch.batchId,
    results: batch.events.map((e) => ({
      eventId: e.eventId,
      status: "applied" as const
    }))
  };
}

/**
 * Creates the full HTTP request handler for the bridge server.
 * Handles /health, /payload (GET, auth-gated), and /reverse-sync (POST, auth-gated).
 * Extracted as a standalone factory so it can be tested without Obsidian.
 */
export function createBridgeHandler(
  config: BridgeHandlerConfig
): (req: IncomingMessage, res: ServerResponse) => void {
  const { expectedToken, getPayload, processedBatchIds, applyHook } = config;

  return (req, res) => {
    const method = req.method ?? "GET";
    const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");

    res.setHeader("Access-Control-Allow-Origin", "*");
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

    if (requestUrl.pathname === "/reverse-sync" && method === "POST") {
      const tokenHeader = req.headers["x-project2chrome-token"];
      const tokenValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
      if ((tokenValue ?? "") !== expectedToken) {
        res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
        res.end('{"error":"unauthorized"}\n');
        return;
      }

      const chunks: Buffer[] = [];

      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });

      req.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end('{"error":"malformed JSON"}\n');
          return;
        }

        const batch = parseAndValidateReverseBatch(parsed);
        if (!batch) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end('{"error":"invalid batch"}\n');
          return;
        }

        if (processedBatchIds.has(batch.batchId)) {
          const dupResponse: BatchAckResponse = {
            batchId: batch.batchId,
            results: batch.events.map((e) => ({
              eventId: e.eventId,
              status: "duplicate" as const
            }))
          };
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(`${JSON.stringify(dupResponse)}\n`);
          return;
        }

        processedBatchIds.add(batch.batchId);
        const ackResponse = applyHook(batch);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(`${JSON.stringify(ackResponse)}\n`);
      });

      req.on("error", () => {
        if (!res.headersSent) {
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
