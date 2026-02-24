import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { normalizeBookmarksPath, syncIntoChromeBookmarks } from "./chrome-bookmarks";
import { DEFAULT_SETTINGS, type Project2ChromeSettings } from "./types";

describe("normalizeBookmarksPath", () => {
  it("expands quoted home-relative Windows style path", () => {
    const input = '"~\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Bookmarks"';
    const normalized = normalizeBookmarksPath(input);
    const expected = path.join(os.homedir(), "AppData", "Local", "Google", "Chrome", "User Data", "Default", "Bookmarks");
    assert.equal(normalized, expected);
  });

  it("expands %VAR% environment placeholders", () => {
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = path.join(os.tmpdir(), "localappdata-sim");
    try {
      const normalized = normalizeBookmarksPath("%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Profile 1\\Bookmarks");
      const expected = path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "User Data", "Profile 1", "Bookmarks");
      assert.equal(normalized, expected);
    } finally {
      if (previous === undefined) {
        delete process.env.LOCALAPPDATA;
      } else {
        process.env.LOCALAPPDATA = previous;
      }
    }
  });
});

describe("syncIntoChromeBookmarks", () => {
  it("creates Chrome-compatible fields for new folder and url nodes", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "project2chrome-"));
    const bookmarksPath = path.join(tempDir, "Bookmarks");

    try {
      const initial = {
        roots: {
          bookmark_bar: {
            id: "1",
            type: "folder",
            name: "Bookmarks bar",
            children: []
          }
        }
      };

      await writeFile(bookmarksPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

      const settings: Project2ChromeSettings = {
        ...DEFAULT_SETTINGS,
        chromeBookmarksFileByOs: {
          macos: bookmarksPath,
          linux: bookmarksPath,
          windows: bookmarksPath
        },
        state: {
          managedFolderIds: {},
          managedBookmarkIds: {}
        }
      };

      await syncIntoChromeBookmarks(
        [
          {
            key: "folder:Projects/APS",
            path: "Projects/APS",
            name: "APS",
            children: [],
            links: [
              {
                key: "Projects/APS.md|https://example.com/",
                title: "Example",
                url: "https://example.com/"
              }
            ]
          }
        ],
        settings,
        { rootFolderName: "Projects", ensureRoot: true }
      );

      const updatedRaw = await readFile(bookmarksPath, "utf8");
      const updated = JSON.parse(updatedRaw) as {
        roots: {
          bookmark_bar: {
            children?: Array<{
              id: string;
              type: string;
              name: string;
              guid?: string;
              date_last_used?: string;
              children?: Array<{
                id: string;
                type: string;
                name: string;
                guid?: string;
                date_last_used?: string;
                meta_info?: Record<string, string>;
                children?: Array<{
                  id: string;
                  type: string;
                  name: string;
                  guid?: string;
                  date_last_used?: string;
                  meta_info?: Record<string, string>;
                  url?: string;
                }>;
              }>;
            }>;
          };
        };
      };

      const root = (updated.roots.bookmark_bar.children ?? []).find((child) => child.name === "Projects");
      assert.ok(root);
      assert.ok(root.guid && root.guid.length > 0);
      assert.equal(root.date_last_used, "0");

      const aps = (root.children ?? []).find((child) => child.name === "APS");
      assert.ok(aps);
      assert.ok(aps.guid && aps.guid.length > 0);
      assert.equal(aps.date_last_used, "0");

      const link = (aps.children ?? []).find((child) => child.type === "url");
      assert.ok(link);
      assert.ok(link.guid && link.guid.length > 0);
      assert.equal(link.date_last_used, "0");
      assert.equal(link.meta_info?.power_bookmark_meta, "");
      assert.equal(link.url, "https://example.com/");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("removes obsolete bookmark even when saved id is stale", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "project2chrome-"));
    const bookmarksPath = path.join(tempDir, "Bookmarks");
    const backupPath = `${bookmarksPath}.bak`;

    try {
      const initial = {
        roots: {
          bookmark_bar: {
            id: "1",
            type: "folder",
            name: "Bookmarks bar",
            children: [
              {
                id: "10",
                type: "folder",
                name: "Projects",
                children: [
                  {
                    id: "20",
                    type: "url",
                    name: "Example",
                    url: "https://example.com/"
                  }
                ]
              }
            ]
          }
        }
      };

      await writeFile(bookmarksPath, `${JSON.stringify(initial, null, 2)}\n`, "utf8");

      const settings: Project2ChromeSettings = {
        ...DEFAULT_SETTINGS,
        chromeBookmarksFileByOs: {
          macos: bookmarksPath,
          linux: bookmarksPath,
          windows: bookmarksPath
        },
        state: {
          managedFolderIds: { __root__: "10" },
          managedBookmarkIds: {
            "notes/a.md|https://example.com/": "999"
          }
        }
      };

      const nextState = await syncIntoChromeBookmarks([], settings, {
        rootFolderName: "Projects",
        ensureRoot: true
      });

      const updatedRaw = await readFile(bookmarksPath, "utf8");
      const backupRaw = await readFile(backupPath, "utf8");
      const updated = JSON.parse(updatedRaw) as {
        roots: {
          bookmark_bar: {
            children?: Array<{ id: string; type: string; name: string; children?: Array<{ type: string; url?: string }> }>;
          };
        };
      };

      const rootFolder = (updated.roots.bookmark_bar.children ?? []).find((child) => child.id === "10");
      assert.ok(rootFolder);
      assert.equal((rootFolder.children ?? []).filter((child) => child.type === "url").length, 0);
      assert.deepEqual(nextState.managedBookmarkIds, {});
      assert.equal(backupRaw, updatedRaw);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
