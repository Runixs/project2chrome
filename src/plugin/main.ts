import { createServer, type Server } from "node:http";
import type { App, TAbstractFile } from "obsidian";
import { Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { normalizeBridgePort } from "./extension-bridge-config";
import { buildExtensionSyncPayload } from "./extension-payload";
import { buildDesiredTree } from "./model-builder";
import { DEFAULT_SETTINGS, type Project2ChromeSettings } from "./types";
import { createBridgeHandler, skeletonApplyHook, type ApplyHook } from "./bridge-handler";

export default class Project2ChromePlugin extends Plugin {
  settings: Project2ChromeSettings = DEFAULT_SETTINGS;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;
  private syncQueued = false;
  private bridgeServer: Server | null = null;
  private latestPayloadJson = "";
  private processedBatchIds: Set<string> = new Set();

  async onload(): Promise<void> {
    await this.loadSettings();
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
    if (this.bridgeServer) {
      this.bridgeServer.close();
      this.bridgeServer = null;
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<Project2ChromeSettings> | null;

    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      useFolderNotesPlugin: loaded?.useFolderNotesPlugin ?? DEFAULT_SETTINGS.useFolderNotesPlugin,
      bookmarkBarRootMode: loaded?.bookmarkBarRootMode === "target" ? "target" : (loaded?.bookmarkBarRootMode ?? DEFAULT_SETTINGS.bookmarkBarRootMode),
      bookmarkBarRootCustomName: loaded?.bookmarkBarRootCustomName ?? DEFAULT_SETTINGS.bookmarkBarRootCustomName,
      extensionBridgeEnabled: loaded?.extensionBridgeEnabled ?? DEFAULT_SETTINGS.extensionBridgeEnabled,
      extensionBridgePort: normalizeBridgePort(loaded?.extensionBridgePort ?? DEFAULT_SETTINGS.extensionBridgePort),
      extensionBridgeToken: (loaded?.extensionBridgeToken ?? DEFAULT_SETTINGS.extensionBridgeToken).trim() || DEFAULT_SETTINGS.extensionBridgeToken
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
    if (this.bridgeServer) {
      this.bridgeServer.close();
      this.bridgeServer = null;
    }
    if (!this.settings.extensionBridgeEnabled) {
      return;
    }

    const handler = createBridgeHandler({
      expectedToken: this.settings.extensionBridgeToken,
      getPayload: () => this.latestPayloadJson,
      processedBatchIds: this.processedBatchIds,
      applyHook
    });

    this.bridgeServer = createServer(handler);

    await new Promise<void>((resolve, reject) => {
      this.bridgeServer?.once("error", reject);
      this.bridgeServer?.listen(this.settings.extensionBridgePort, "127.0.0.1", () => resolve());
    });
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
        toggle.setValue(this.plugin.settings.extensionBridgeEnabled).onChange(async (value) => {
          this.plugin.settings.extensionBridgeEnabled = value;
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
          .setValue(String(this.plugin.settings.extensionBridgePort))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            this.plugin.settings.extensionBridgePort = normalizeBridgePort(parsed);
            await this.plugin.saveSettings();
            await this.plugin.startBridgeServer();
          });
      });

    new Setting(containerEl)
      .setName("Extension bridge token")
      .setDesc("Shared token required by extension request header")
      .addText((text) => {
        text
          .setPlaceholder("project2chrome-local")
          .setValue(this.plugin.settings.extensionBridgeToken)
          .onChange(async (value) => {
            this.plugin.settings.extensionBridgeToken = value.trim() || DEFAULT_SETTINGS.extensionBridgeToken;
            await this.plugin.saveSettings();
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
