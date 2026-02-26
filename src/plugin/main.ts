import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { App, TAbstractFile } from "obsidian";
import { FileSystemAdapter, Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import {
  normalizeBridgeSettings,
  normalizeBridgeHeartbeatMs,
  normalizeBridgePath,
  normalizeBridgePort,
  resolveActiveClient
} from "./extension-bridge-config";
import { buildExtensionSyncPayload } from "./extension-payload";
import { buildDesiredTree } from "./model-builder";
import { DEFAULT_SETTINGS, type DesiredFolder, type Project2ChromeSettings } from "./types";
import { createBridgeHandler, skeletonApplyHook, type ApplyHook } from "./bridge-handler";
import { createReverseApplyHook } from "./reverse-apply";
import { createReverseLogger, type ReverseLogEntry } from "./reverse-logger";
import { REVERSE_EVENT_TYPES, REVERSE_SYNC_SCHEMA_VERSION, type EventAck, type ReverseBatch, type ReverseEvent, type ReverseEventType } from "./reverse-sync-types";
import type { ManagedKeySet } from "./reverse-guardrails";
import type { WsActionMessage } from "./websocket-action-types";
import { createWebSocketBridge, type WebSocketBridge } from "./websocket-bridge";

export default class Project2ChromePlugin extends Plugin {
  settings: Project2ChromeSettings = DEFAULT_SETTINGS;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;
  private syncQueued = false;
  private bridgeServer: Server | null = null;
  private websocketBridge: WebSocketBridge | null = null;
  private latestPayloadJson = "";
  private processedBatchIds: Set<string> = new Set();
  private reverseDebugEntries: ReverseLogEntry[] = [];
  private readonly reverseDebugMaxEntries = 250;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureBridgeTokenHardening();
    this.addSettingTab(new Project2ChromeSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));

    this.addCommand({
      id: "project2chrome-refresh-bridge-payload",
      name: "Refresh payload for Chrome extension",
      callback: async () => {
        await this.syncNow();
      }
    });

    this.addCommand({
      id: "project2chrome-show-reverse-debug-snapshot",
      name: "Show reverse sync debug snapshot",
      callback: () => {
        this.showReverseDebugSnapshot();
      }
    });

    this.addCommand({
      id: "project2chrome-clear-reverse-debug-log",
      name: "Clear reverse sync debug log",
      callback: () => {
        this.clearReverseDebugEntries();
        new Notice("Project2Chrome reverse debug log cleared");
      }
    });

    if (this.settings.autoSync) {
      await this.syncNow();
    }

    await this.startBridgeServer();

    if (this.settings.autoSync) {
      this.scheduleSync();
    }
  }

  onunload(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    if (this.websocketBridge) {
      void this.websocketBridge.close();
      this.websocketBridge = null;
    }
    if (this.bridgeServer) {
      this.bridgeServer.close();
      this.bridgeServer = null;
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<Project2ChromeSettings> | null;
    const bridge = normalizeBridgeSettings(loaded as unknown as {
      extensionBridgeServerEnabled?: boolean;
      extensionBridgeServerPort?: number;
      extensionBridgeServerPath?: string;
      extensionBridgeHeartbeatMs?: number;
      extensionBridgeClients?: unknown;
      extensionBridgeActiveClientId?: unknown;
      extensionBridgeEnabled?: boolean;
      extensionBridgePort?: number;
      extensionBridgeToken?: string;
    } | null);

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      useFolderNotesPlugin: loaded?.useFolderNotesPlugin ?? DEFAULT_SETTINGS.useFolderNotesPlugin,
      bookmarkBarRootMode: loaded?.bookmarkBarRootMode === "target" ? "target" : (loaded?.bookmarkBarRootMode ?? DEFAULT_SETTINGS.bookmarkBarRootMode),
      bookmarkBarRootCustomName: loaded?.bookmarkBarRootCustomName ?? DEFAULT_SETTINGS.bookmarkBarRootCustomName,
      extensionBridgeServerEnabled: bridge.extensionBridgeServerEnabled,
      extensionBridgeServerPort: bridge.extensionBridgeServerPort,
      extensionBridgeServerPath: bridge.extensionBridgeServerPath,
      extensionBridgeHeartbeatMs: bridge.extensionBridgeHeartbeatMs,
      extensionBridgeClients: bridge.extensionBridgeClients,
      extensionBridgeActiveClientId: bridge.extensionBridgeActiveClientId,
      reverseDebugEnabled: loaded?.reverseDebugEnabled ?? DEFAULT_SETTINGS.reverseDebugEnabled,
      reverseDebugNoticeOnError: loaded?.reverseDebugNoticeOnError ?? DEFAULT_SETTINGS.reverseDebugNoticeOnError
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private onVaultChange(file: TAbstractFile): void {
    if (!this.settings.autoSync) {
      return;
    }
    if (!isInsideTarget(file.path, this.settings.targetFolderPath)) {
      return;
    }
    this.scheduleSync();
  }

  private onVaultRename(file: TAbstractFile, oldPath: string): void {
    if (!this.settings.autoSync) {
      return;
    }
    if (!isInsideTarget(file.path, this.settings.targetFolderPath) && !isInsideTarget(oldPath, this.settings.targetFolderPath)) {
      return;
    }
    this.scheduleSync();
  }

  private scheduleSync(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
    }

    this.syncTimer = setTimeout(() => {
      void this.runSync();
    }, Math.max(100, this.settings.debounceMs));
  }

  async syncNow(): Promise<void> {
    await this.runSync();
  }

  private async runSync(): Promise<void> {
    if (this.isSyncing) {
      this.syncQueued = true;
      return;
    }

    const target = this.app.vault.getAbstractFileByPath(this.settings.targetFolderPath);
    const targetExists = target instanceof TFolder;

    this.isSyncing = true;
    try {
      const desired = targetExists
        ? await buildDesiredTree(
            this.app.vault,
            this.settings.targetFolderPath,
            this.settings.linkHeading,
            this.settings.useFolderNotesPlugin
          )
        : [];
      const payload = buildExtensionSyncPayload(desired, this.settings);
      this.latestPayloadJson = `${JSON.stringify(payload, null, 2)}\n`;
      await this.saveSettings();
      this.websocketBridge?.sendSnapshot();
      if (!targetExists) {
        new Notice(`Project2Chrome: target folder missing, serving empty payload: ${this.settings.targetFolderPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Project2Chrome payload refresh failed: ${message}`);
    } finally {
      this.isSyncing = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        this.scheduleSync();
      }
    }
  }

  async startBridgeServer(applyHook: ApplyHook = skeletonApplyHook): Promise<void> {
    if (this.websocketBridge) {
      await this.websocketBridge.close();
      this.websocketBridge = null;
    }
    await this.closeBridgeServer();
    if (!this.settings.extensionBridgeServerEnabled) {
      return;
    }

    const activeClient = resolveActiveClient(this.settings.extensionBridgeClients, this.settings.extensionBridgeActiveClientId);
    this.settings.extensionBridgeActiveClientId = activeClient.clientId;

    const effectiveApplyHook = applyHook === skeletonApplyHook
      ? this.createLiveApplyHook()
      : applyHook;

    const reverseLogger = createReverseLogger((entry) => {
      this.handleReverseDebugEntry(entry);
    });

    const handler = createBridgeHandler({
      expectedToken: activeClient.token,
      getPayload: () => this.latestPayloadJson,
      processedBatchIds: this.processedBatchIds,
      applyHook: effectiveApplyHook,
      logger: reverseLogger,
      getDebugEntries: () => this.getReverseDebugEntries(),
      clearDebugEntries: () => this.clearReverseDebugEntries()
    });

    this.bridgeServer = createServer(handler);

    this.websocketBridge = createWebSocketBridge({
      server: this.bridgeServer,
      path: this.settings.extensionBridgeServerPath,
      heartbeatMs: this.settings.extensionBridgeHeartbeatMs,
      getClients: () => this.settings.extensionBridgeClients,
      getSnapshotPayload: () => this.parseLatestPayloadSnapshot(),
      applyAction: (_clientId, action) => this.applyWebSocketAction(action, effectiveApplyHook),
      onLog: (level, event, data) => this.handleWebSocketBridgeLog(level, event, data)
    });

    await new Promise<void>((resolve, reject) => {
      this.bridgeServer?.once("error", reject);
      this.bridgeServer?.listen(this.settings.extensionBridgeServerPort, "127.0.0.1", () => resolve());
    });
  }

  private async applyWebSocketAction(action: WsActionMessage, applyHook: ApplyHook): Promise<EventAck> {
    if (!action.idempotencyKey) {
      return {
        eventId: action.eventId,
        status: "rejected_invalid",
        reason: "missing_idempotency_key"
      };
    }

    if (this.processedBatchIds.has(action.idempotencyKey)) {
      return {
        eventId: action.eventId,
        status: "duplicate"
      };
    }

    const eventType = toReverseEventType(action.op);
    if (!eventType) {
      return {
        eventId: action.eventId,
        status: "rejected_invalid",
        reason: "unsupported_op"
      };
    }

    const bookmarkId = readActionPayloadString(action.payload, "bookmarkId") ?? action.target;
    const managedKey = readActionPayloadString(action.payload, "managedKey") ?? action.target;
    if (!bookmarkId || !managedKey) {
      return {
        eventId: action.eventId,
        status: "rejected_invalid",
        reason: "missing_target_fields"
      };
    }

    const event: ReverseEvent = {
      batchId: action.idempotencyKey,
      eventId: action.eventId,
      type: eventType,
      bookmarkId,
      managedKey,
      parentId: readActionPayloadString(action.payload, "parentId"),
      title: readActionPayloadContentString(action.payload, "title"),
      url: readActionPayloadContentString(action.payload, "url"),
      occurredAt: action.occurredAt,
      schemaVersion: REVERSE_SYNC_SCHEMA_VERSION
    };

    const batch: ReverseBatch = {
      batchId: action.idempotencyKey,
      events: [event],
      sentAt: new Date().toISOString()
    };

    const results = await applyHook(batch);
    const result = results[0] ?? {
      eventId: action.eventId,
      status: "rejected_invalid",
      reason: "apply_hook_empty_result"
    };
    this.processedBatchIds.add(action.idempotencyKey);
    return result;
  }

  private parseLatestPayloadSnapshot(): Record<string, unknown> | null {
    if (!this.latestPayloadJson) {
      return null;
    }

    try {
      const parsed = JSON.parse(this.latestPayloadJson) as unknown;
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async ensureBridgeTokenHardening(): Promise<void> {
    const active = resolveActiveClient(this.settings.extensionBridgeClients, this.settings.extensionBridgeActiveClientId);
    if (active.token !== "project2chrome-local") {
      return;
    }

    const hardenedToken = `p2c-${randomUUID()}`;
    this.settings.extensionBridgeClients = this.settings.extensionBridgeClients.map((client) => {
      if (client.clientId !== active.clientId) {
        return client;
      }
      return {
        ...client,
        token: hardenedToken
      };
    });
    await this.saveSettings();
  }

  private async closeBridgeServer(): Promise<void> {
    const server = this.bridgeServer;
    if (!server) {
      return;
    }
    this.bridgeServer = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private handleWebSocketBridgeLog(
    level: "info" | "warn" | "error",
    event: string,
    data?: Record<string, string>
  ): void {
    this.handleReverseDebugEntry({
      timestamp: new Date().toISOString(),
      level,
      event,
      eventId: data?.eventId,
      status: data?.status,
      reason: formatWebSocketLogReason(data)
    });
  }

  private createLiveApplyHook(): ApplyHook {
    return (batch) => {
      const vaultBasePath = this.getVaultBasePath();
      if (!vaultBasePath) {
        return batch.events.map((event) => ({
          eventId: event.eventId,
          status: "skipped_ambiguous",
          reason: "vault_path_unavailable"
        }));
      }

      const reverseApplyHook = createReverseApplyHook({
        vaultBasePath,
        linkHeading: this.settings.linkHeading,
        knownKeys: this.buildManagedKeySetFromLatestPayload(),
        readFile: (absolutePath) => this.readVaultFileSync(vaultBasePath, absolutePath),
        writeFile: (absolutePath, content) => this.writeVaultFileSync(vaultBasePath, absolutePath, content)
      });

      return reverseApplyHook(batch);
    };
  }

  private handleReverseDebugEntry(entry: ReverseLogEntry): void {
    if (entry.level === "error" && this.settings.reverseDebugNoticeOnError) {
      const detail = entry.status ?? entry.reason ?? entry.event;
      new Notice(`Project2Chrome reverse sync error: ${detail}`);
    }

    if (!this.settings.reverseDebugEnabled) {
      return;
    }

    this.reverseDebugEntries.push(entry);
    if (this.reverseDebugEntries.length > this.reverseDebugMaxEntries) {
      this.reverseDebugEntries.splice(0, this.reverseDebugEntries.length - this.reverseDebugMaxEntries);
    }

    console.log(`[Project2Chrome:reverse] ${JSON.stringify(entry)}`);
  }

  getReverseDebugEntries(): ReverseLogEntry[] {
    return [...this.reverseDebugEntries];
  }

  clearReverseDebugEntries(): void {
    this.reverseDebugEntries = [];
  }

  showReverseDebugSnapshot(): void {
    if (this.reverseDebugEntries.length === 0) {
      new Notice("Project2Chrome reverse debug log is empty");
      return;
    }

    const latest = this.reverseDebugEntries.slice(-5);
    const lines = latest.map((entry) => this.formatReverseDebugEntry(entry)).join("\n");
    new Notice(`Project2Chrome reverse debug (${this.reverseDebugEntries.length})\n${lines}`);
  }

  private formatReverseDebugEntry(entry: ReverseLogEntry): string {
    const status = entry.status ? ` status=${entry.status}` : "";
    const reason = entry.reason ? ` reason=${entry.reason}` : "";
    const eventId = entry.eventId ? ` eventId=${entry.eventId}` : "";
    const batchId = entry.batchId ? ` batchId=${entry.batchId}` : "";
    return `[${entry.level}] ${entry.event}${status}${reason}${eventId}${batchId}`;
  }

  private getVaultBasePath(): string | null {
    if (this.app.vault.adapter instanceof FileSystemAdapter) {
      return this.app.vault.adapter.getBasePath();
    }
    return null;
  }

  private readVaultFileSync(vaultBasePath: string, absolutePath: string): string | null {
    if (!isPathInsideVault(vaultBasePath, absolutePath)) {
      return null;
    }

    try {
      return readFileSync(absolutePath, "utf-8");
    } catch {
      return null;
    }
  }

  private writeVaultFileSync(vaultBasePath: string, absolutePath: string, content: string): void {
    if (!isPathInsideVault(vaultBasePath, absolutePath)) {
      throw new Error("reverse_write_outside_vault");
    }

    writeFileSync(absolutePath, content, "utf-8");
  }

  private buildManagedKeySetFromLatestPayload(): ManagedKeySet | undefined {
    if (!this.latestPayloadJson) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(this.latestPayloadJson) as { desired?: unknown };
      const desired = Array.isArray(parsed.desired) ? (parsed.desired as DesiredFolder[]) : [];
      return buildManagedKeySet(desired);
    } catch {
      return undefined;
    }
  }
}

class Project2ChromeSettingTab extends PluginSettingTab {
  private readonly plugin: Project2ChromePlugin;

  constructor(app: App, plugin: Project2ChromePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Target folder path")
      .setDesc("Vault-relative root folder to mirror into Chrome bookmark bar")
      .addText((text) => {
        text
          .setPlaceholder("1_Projects")
          .setValue(this.plugin.settings.targetFolderPath)
          .onChange(async (value) => {
            this.plugin.settings.targetFolderPath = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Link heading")
      .setDesc("Heading used to extract links, e.g. Link or ### Link")
      .addText((text) => {
        text
          .setPlaceholder("Link")
          .setValue(this.plugin.settings.linkHeading)
          .onChange(async (value) => {
            this.plugin.settings.linkHeading = value.trim() || "Link";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Folder Notes Plugin Use")
      .setDesc("When enabled, folder-note file links (same name as folder) are placed directly under that folder")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.useFolderNotesPlugin).onChange(async (value) => {
          this.plugin.settings.useFolderNotesPlugin = value;
          await this.plugin.saveSettings();
          await this.plugin.syncNow();
        });
      });

    new Setting(containerEl)
      .setName("Root folder mode")
      .setDesc("Bookmark bar root folder name source")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("custom", "Custom")
          .addOption("target", "Use target folder name")
          .setValue(this.plugin.settings.bookmarkBarRootMode)
          .onChange(async (value) => {
            this.plugin.settings.bookmarkBarRootMode = value === "target" ? "target" : "custom";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Custom root folder name")
      .setDesc("Used only when Root folder mode is Custom")
      .addText((text) => {
        text
          .setPlaceholder("Projects")
          .setValue(this.plugin.settings.bookmarkBarRootCustomName)
          .onChange(async (value) => {
            this.plugin.settings.bookmarkBarRootCustomName = value.trim() || "Projects";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Extension bridge enabled")
      .setDesc("Serve payload to Chrome extension over localhost")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.extensionBridgeServerEnabled).onChange(async (value) => {
          this.plugin.settings.extensionBridgeServerEnabled = value;
          await this.plugin.saveSettings();
          await this.plugin.startBridgeServer();
        });
      });

    new Setting(containerEl)
      .setName("Extension bridge port")
      .setDesc("Localhost port for extension payload endpoint")
      .addText((text) => {
        text
          .setPlaceholder("27123")
          .setValue(String(this.plugin.settings.extensionBridgeServerPort))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.extensionBridgeServerPort = normalizeBridgePort(parsed);
            await this.plugin.saveSettings();
            await this.plugin.startBridgeServer();
          });
      });

    new Setting(containerEl)
      .setName("Extension bridge path")
      .setDesc("WebSocket server path (reserved for transport migration)")
      .addText((text) => {
        text
          .setPlaceholder("/ws")
          .setValue(this.plugin.settings.extensionBridgeServerPath)
          .onChange(async (value) => {
            this.plugin.settings.extensionBridgeServerPath = normalizeBridgePath(value);
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Extension bridge heartbeat (ms)")
      .setDesc("WebSocket heartbeat interval for bridge sessions")
      .addText((text) => {
        text
          .setPlaceholder("30000")
          .setValue(String(this.plugin.settings.extensionBridgeHeartbeatMs))
          .onChange(async (value) => {
            this.plugin.settings.extensionBridgeHeartbeatMs = normalizeBridgeHeartbeatMs(Number.parseInt(value, 10));
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Active bridge client ID")
      .setDesc("Client profile used for current bridge auth")
      .addText((text) => {
        const activeClient = resolveActiveClient(this.plugin.settings.extensionBridgeClients, this.plugin.settings.extensionBridgeActiveClientId);
        text
          .setPlaceholder("local-event-gateway")
          .setValue(activeClient.clientId)
          .onChange(async (value) => {
            const nextId = value.trim();
            if (!nextId) {
              return;
            }
            const existing = this.plugin.settings.extensionBridgeClients.find((client) => client.clientId === nextId);
            if (!existing) {
              const fallbackToken = activeClient.token || DEFAULT_SETTINGS.extensionBridgeClients[0]?.token || "project2chrome-local";
              this.plugin.settings.extensionBridgeClients = [
                ...this.plugin.settings.extensionBridgeClients,
                {
                  clientId: nextId,
                  token: fallbackToken,
                  enabled: true,
                  scopes: ["sync:read", "sync:write"]
                }
              ];
            }
            this.plugin.settings.extensionBridgeActiveClientId = nextId;
            await this.plugin.saveSettings();
            await this.plugin.startBridgeServer();
          });
      });

    new Setting(containerEl)
      .setName("Active bridge client token")
      .setDesc("Shared token for active client profile")
      .addText((text) => {
        const activeClient = resolveActiveClient(this.plugin.settings.extensionBridgeClients, this.plugin.settings.extensionBridgeActiveClientId);
        text
          .setPlaceholder("project2chrome-local")
          .setValue(activeClient.token)
          .onChange(async (value) => {
            const nextToken = value.trim() || DEFAULT_SETTINGS.extensionBridgeClients[0]?.token || "project2chrome-local";
            this.plugin.settings.extensionBridgeClients = this.plugin.settings.extensionBridgeClients.map((client) => {
              if (client.clientId !== this.plugin.settings.extensionBridgeActiveClientId) {
                return client;
              }
              return {
                ...client,
                token: nextToken
              };
            });
            await this.plugin.saveSettings();
            await this.plugin.startBridgeServer();
          });
      });

    new Setting(containerEl)
      .setName("Reverse debug enabled")
      .setDesc("Capture reverse-sync events in memory and expose via /reverse-debug")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.reverseDebugEnabled).onChange(async (value) => {
          this.plugin.settings.reverseDebugEnabled = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Reverse debug error notices")
      .setDesc("Show Obsidian notice when reverse-sync errors occur")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.reverseDebugNoticeOnError).onChange(async (value) => {
          this.plugin.settings.reverseDebugNoticeOnError = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Reverse debug log")
      .setDesc("View latest reverse-sync debug snapshot or clear in-memory log")
      .addButton((button) => {
        button.setButtonText("Show").onClick(() => {
          this.plugin.showReverseDebugSnapshot();
        });
      })
      .addButton((button) => {
        button.setButtonText("Clear").onClick(() => {
          this.plugin.clearReverseDebugEntries();
          new Notice("Project2Chrome reverse debug log cleared");
        });
      });

    new Setting(containerEl)
      .setName("Auto sync")
      .setDesc("Sync on file/folder create, modify, delete, rename")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoSync).onChange(async (value) => {
          this.plugin.settings.autoSync = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Debounce (ms)")
      .setDesc("Delay before running sync after vault change events")
      .addText((text) => {
        text
          .setPlaceholder("700")
          .setValue(String(this.plugin.settings.debounceMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.debounceMs = Number.isFinite(parsed) ? Math.max(100, parsed) : 700;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Refresh payload now")
      .setDesc("Rebuild payload served to extension immediately")
      .addButton((button) => {
        button.setButtonText("Run").onClick(async () => {
          await this.plugin.syncNow();
        });
      });
  }
}

function isInsideTarget(filePath: string, target: string): boolean {
  if (!target) {
    return false;
  }
  return filePath === target || filePath.startsWith(`${target}/`);
}

function isPathInsideVault(vaultBasePath: string, targetPath: string): boolean {
  const vaultResolved = resolve(vaultBasePath);
  const targetResolved = resolve(targetPath);
  return targetResolved === vaultResolved || targetResolved.startsWith(`${vaultResolved}${sep}`);
}

function buildManagedKeySet(desired: DesiredFolder[]): ManagedKeySet {
  const managedNotePaths = new Set<string>();
  const managedFolderPaths = new Set<string>();

  const visit = (folder: DesiredFolder): void => {
    if (folder.key.startsWith("note:")) {
      managedNotePaths.add(folder.path);
    }

    if (folder.key.startsWith("folder:")) {
      managedFolderPaths.add(folder.path);
    }

    for (const link of folder.links) {
      const separator = link.key.lastIndexOf("|");
      if (separator > 0) {
        managedNotePaths.add(link.key.slice(0, separator));
      }
    }

    for (const child of folder.children) {
      visit(child);
    }
  };

  for (const folder of desired) {
    visit(folder);
  }

  return {
    managedNotePaths,
    managedFolderPaths
  };
}

function toReverseEventType(op: string): ReverseEventType | null {
  return REVERSE_EVENT_TYPES.includes(op as ReverseEventType) ? (op as ReverseEventType) : null;
}

function readActionPayloadString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readActionPayloadContentString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatWebSocketLogReason(data?: Record<string, string>): string | undefined {
  if (!data) {
    return undefined;
  }
  const parts: string[] = [];
  if (data.clientId) {
    parts.push(`clientId=${data.clientId}`);
  }
  if (data.reason) {
    parts.push(`reason=${data.reason}`);
  }
  if (data.status) {
    parts.push(`status=${data.status}`);
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}
