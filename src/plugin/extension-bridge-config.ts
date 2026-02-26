import type { ExtensionBridgeClient } from "./types";

export interface LegacyBridgeSettingsLike {
  extensionBridgeServerEnabled?: boolean;
  extensionBridgeServerPort?: number;
  extensionBridgeServerPath?: string;
  extensionBridgeHeartbeatMs?: number;
  extensionBridgeClients?: unknown;
  extensionBridgeActiveClientId?: unknown;
  extensionBridgeEnabled?: boolean;
  extensionBridgePort?: number;
  extensionBridgeToken?: string;
}

export interface NormalizedBridgeSettings {
  extensionBridgeServerEnabled: boolean;
  extensionBridgeServerPort: number;
  extensionBridgeServerPath: string;
  extensionBridgeHeartbeatMs: number;
  extensionBridgeClients: ExtensionBridgeClient[];
  extensionBridgeActiveClientId: string;
}

export function normalizeBridgePort(value: number): number {
  if (!Number.isFinite(value)) {
    return 27123;
  }
  const n = Math.trunc(value);
  if (n < 1024) {
    return 1024;
  }
  if (n > 65535) {
    return 65535;
  }
  return n;
}

export function normalizeBridgePath(value: unknown): string {
  if (typeof value !== "string") {
    return "/ws";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "/ws";
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function normalizeBridgeHeartbeatMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 30000;
  }
  const n = Math.trunc(value);
  if (n < 1000) {
    return 1000;
  }
  if (n > 120000) {
    return 120000;
  }
  return n;
}

export function normalizeBridgeClients(raw: unknown, legacyToken: string): ExtensionBridgeClient[] {
  if (!Array.isArray(raw)) {
    return [createDefaultClient(legacyToken)];
  }

  const normalized: ExtensionBridgeClient[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const clientId = normalizeClientId(record.clientId);
    const token = normalizeToken(record.token, legacyToken);
    if (!clientId || !token) {
      continue;
    }
    const scopes = normalizeScopes(record.scopes);
    normalized.push({
      clientId,
      token,
      enabled: record.enabled !== false,
      scopes
    });
  }

  return normalized.length > 0 ? dedupeClients(normalized) : [createDefaultClient(legacyToken)];
}

export function resolveActiveClient(clients: ExtensionBridgeClient[], activeClientId: unknown): ExtensionBridgeClient {
  const preferred = typeof activeClientId === "string" ? activeClientId.trim() : "";
  if (preferred) {
    const matched = clients.find((client) => client.clientId === preferred && client.enabled);
    if (matched) {
      return matched;
    }
  }

  const firstEnabled = clients.find((client) => client.enabled);
  if (firstEnabled) {
    return firstEnabled;
  }

  return clients[0] ?? createDefaultClient("project2chrome-local");
}

export function normalizeBridgeSettings(loaded: LegacyBridgeSettingsLike | null | undefined): NormalizedBridgeSettings {
  const legacyToken = normalizeToken(loaded?.extensionBridgeToken, "project2chrome-local");
  const clients = normalizeBridgeClients(loaded?.extensionBridgeClients, legacyToken);
  const activeClient = resolveActiveClient(clients, loaded?.extensionBridgeActiveClientId);

  return {
    extensionBridgeServerEnabled: loaded?.extensionBridgeServerEnabled ?? loaded?.extensionBridgeEnabled ?? true,
    extensionBridgeServerPort: normalizeBridgePort(loaded?.extensionBridgeServerPort ?? loaded?.extensionBridgePort ?? 27123),
    extensionBridgeServerPath: normalizeBridgePath(loaded?.extensionBridgeServerPath),
    extensionBridgeHeartbeatMs: normalizeBridgeHeartbeatMs(loaded?.extensionBridgeHeartbeatMs),
    extensionBridgeClients: clients,
    extensionBridgeActiveClientId: activeClient.clientId
  };
}

function createDefaultClient(legacyToken: string): ExtensionBridgeClient {
  return {
    clientId: "local-event-gateway",
    token: normalizeToken(legacyToken, "project2chrome-local"),
    enabled: true,
    scopes: ["sync:read", "sync:write"]
  };
}

function normalizeClientId(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeToken(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ["sync:read", "sync:write"];
  }
  const scopes: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }
    scopes.push(trimmed);
  }
  return scopes.length > 0 ? [...new Set(scopes)] : ["sync:read", "sync:write"];
}

function dedupeClients(clients: ExtensionBridgeClient[]): ExtensionBridgeClient[] {
  const seen = new Set<string>();
  const out: ExtensionBridgeClient[] = [];
  for (const client of clients) {
    if (seen.has(client.clientId)) {
      continue;
    }
    seen.add(client.clientId);
    out.push(client);
  }
  return out;
}
