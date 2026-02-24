import type { App, TAbstractFile } from "obsidian";
import { Notice, Plugin, PluginSettingTab, Setting, TFolder } from "obsidian";
import { syncIntoChromeBookmarks } from "./chrome-bookmarks";
import { buildExtensionSyncPayload } from "./extension-payload";
import { buildDesiredTree } from "./model-builder";
import { DEFAULT_SETTINGS, type Project2ChromeSettings } from "./types";

export default class Project2ChromePlugin extends Plugin {
  settings: Project2ChromeSettings = DEFAULT_SETTINGS;
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private isSyncing = false;
  private syncQueued = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new Project2ChromeSettingTab(this.app, this));

    this.registerEvent(this.app.vault.on("create", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.onVaultChange(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.onVaultRename(file, oldPath)));

    this.addCommand({
      id: "project2chrome-sync-now",
      name: "Sync to Chrome bookmarks now",
      callback: async () => {
        await this.syncNow();
      }
    });

    this.addCommand({
      id: "project2chrome-export-extension-payload",
      name: "Export payload for Chrome extension",
      callback: async () => {
        await this.exportPayloadForExtension();
      }
    });

    if (this.settings.autoSync) {
      this.scheduleSync();
    }
  }

  onunload(): void {
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<Project2ChromeSettings> | null;
    const legacyPath = (loaded as { chromeBookmarksFile?: string } | null)?.chromeBookmarksFile;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loaded,
      chromeBookmarksFileByOs: {
        ...DEFAULT_SETTINGS.chromeBookmarksFileByOs,
        ...(loaded?.chromeBookmarksFileByOs ?? {})
      },
      bookmarkBarRootMode: loaded?.bookmarkBarRootMode === "target" ? "target" : (loaded?.bookmarkBarRootMode ?? DEFAULT_SETTINGS.bookmarkBarRootMode),
      bookmarkBarRootCustomName: loaded?.bookmarkBarRootCustomName ?? DEFAULT_SETTINGS.bookmarkBarRootCustomName,
      state: {
        ...DEFAULT_SETTINGS.state,
        ...(loaded?.state ?? {})
      }
    };

    if (legacyPath && !loaded?.chromeBookmarksFileByOs) {
      this.settings.chromeBookmarksFileByOs = {
        macos: legacyPath,
        linux: legacyPath,
        windows: legacyPath
      };
    }
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

  private async exportPayloadForExtension(): Promise<void> {
    try {
      const target = this.app.vault.getAbstractFileByPath(this.settings.targetFolderPath);
      if (!(target instanceof TFolder)) {
        new Notice(`Project2Chrome export failed: target folder missing: ${this.settings.targetFolderPath}`);
        return;
      }

      const desired = await buildDesiredTree(this.app.vault, this.settings.targetFolderPath, this.settings.linkHeading);
      const payload = buildExtensionSyncPayload(desired, this.settings);
      const outPath = "project2chrome-extension-payload.json";
      await this.app.vault.adapter.write(outPath, `${JSON.stringify(payload, null, 2)}\n`);
      new Notice(`Project2Chrome: exported extension payload -> ${outPath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Project2Chrome export failed: ${message}`);
    }
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
        ? await buildDesiredTree(this.app.vault, this.settings.targetFolderPath, this.settings.linkHeading)
        : [];
      const nextState = await syncIntoChromeBookmarks(desired, this.settings, {
        rootFolderName: resolveRootFolderName(this.settings),
        ensureRoot: targetExists
      });
      this.settings.state = nextState;
      await this.saveSettings();
      if (!targetExists) {
        new Notice(`Project2Chrome: target folder missing, managed bookmarks removed: ${this.settings.targetFolderPath}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Project2Chrome sync failed: ${message}`);
    } finally {
      this.isSyncing = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        this.scheduleSync();
      }
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
      .setDesc("Heading name used to extract links, e.g. Link for ### Link")
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
      .setName("Chrome Bookmarks file (macOS)")
      .setDesc("Path used when running Obsidian on macOS")
      .addText((text) => {
        text
          .setPlaceholder("~/Library/Application Support/Google/Chrome/Default/Bookmarks")
          .setValue(this.plugin.settings.chromeBookmarksFileByOs.macos)
          .onChange(async (value) => {
            this.plugin.settings.chromeBookmarksFileByOs.macos = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Chrome Bookmarks file (Linux)")
      .setDesc("Path used when running Obsidian on Linux")
      .addText((text) => {
        text
          .setPlaceholder("~/.config/google-chrome/Default/Bookmarks")
          .setValue(this.plugin.settings.chromeBookmarksFileByOs.linux)
          .onChange(async (value) => {
            this.plugin.settings.chromeBookmarksFileByOs.linux = value.trim();
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Chrome Bookmarks file (Windows)")
      .setDesc("Path used when running Obsidian on Windows")
      .addText((text) => {
        text
          .setPlaceholder("~/AppData/Local/Google/Chrome/User Data/Default/Bookmarks")
          .setValue(this.plugin.settings.chromeBookmarksFileByOs.windows)
          .onChange(async (value) => {
            this.plugin.settings.chromeBookmarksFileByOs.windows = value.trim();
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
      .setName("Sync now")
      .setDesc("Run a full sync immediately")
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

function resolveRootFolderName(settings: Project2ChromeSettings): string {
  if (settings.bookmarkBarRootMode === "target") {
    const trimmed = settings.targetFolderPath.trim().replace(/\/+$/, "");
    const parts = trimmed.split("/").filter((part) => part.length > 0);
    const last = parts[parts.length - 1] ?? "Projects";
    return last;
  }
  return settings.bookmarkBarRootCustomName.trim() || "Projects";
}
