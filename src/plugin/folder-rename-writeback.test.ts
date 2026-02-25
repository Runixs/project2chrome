import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyFolderRenameWriteback,
  processFolderRename,
  resolveFolderRenameTarget,
} from "./folder-rename-writeback";

// ---------------------------------------------------------------------------
// resolveFolderRenameTarget
// ---------------------------------------------------------------------------

describe("resolveFolderRenameTarget", () => {
  it("note key with .md extension resolves to vault-absolute path", () => {
    const result = resolveFolderRenameTarget({
      managedKey: "note:1_Projects/APS-47235.md",
      newTitle: "New Name",
      vaultBasePath: "/vault",
    });
    assert.deepEqual(result, { targetFilePath: "/vault/1_Projects/APS-47235.md" });
  });

  it("note key WITHOUT .md extension appends .md", () => {
    const result = resolveFolderRenameTarget({
      managedKey: "note:1_Projects/APS-47235",
      newTitle: "New Name",
      vaultBasePath: "/vault",
    });
    assert.deepEqual(result, { targetFilePath: "/vault/1_Projects/APS-47235.md" });
  });

  it("folder key resolves to <folder>/<folderName>.md", () => {
    const result = resolveFolderRenameTarget({
      managedKey: "folder:1_Projects/APS-45429",
      newTitle: "New Name",
      vaultBasePath: "/vault",
    });
    assert.deepEqual(result, {
      targetFilePath: "/vault/1_Projects/APS-45429/APS-45429.md",
    });
  });

  it("folder key with top-level path (no subdirectory)", () => {
    const result = resolveFolderRenameTarget({
      managedKey: "folder:TopFolder",
      newTitle: "New Name",
      vaultBasePath: "/vault",
    });
    assert.deepEqual(result, {
      targetFilePath: "/vault/TopFolder/TopFolder.md",
    });
  });

  it("vaultBasePath trailing slash is handled gracefully", () => {
    const result = resolveFolderRenameTarget({
      managedKey: "note:notes/readme.md",
      newTitle: "New Name",
      vaultBasePath: "/vault/",
    });
    assert.deepEqual(result, { targetFilePath: "/vault/notes/readme.md" });
  });

  it("returns null for unknown key prefix", () => {
    const result = resolveFolderRenameTarget({
      managedKey: "link:some/path",
      newTitle: "New Name",
      vaultBasePath: "/vault",
    });
    assert.equal(result, null);
  });

  it("returns null for empty key", () => {
    const result = resolveFolderRenameTarget({
      managedKey: "",
      newTitle: "New Name",
      vaultBasePath: "/vault",
    });
    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// applyFolderRenameWriteback
// ---------------------------------------------------------------------------

describe("applyFolderRenameWriteback", () => {
  it("replaces existing bookmark_name value", () => {
    const content = [
      "---",
      "bookmark_name: Old Name",
      "owner: APS",
      "---",
      "# Body",
    ].join("\n");
    const result = applyFolderRenameWriteback(content, "[VN] New Title");
    assert.ok(result.includes("bookmark_name: [VN] New Title"));
    assert.ok(!result.includes("bookmark_name: Old Name"));
  });

  it("preserves other frontmatter fields when replacing", () => {
    const content = [
      "---",
      "owner: APS",
      "bookmark_name: Old Name",
      "tags: [foo, bar]",
      "---",
      "body text",
    ].join("\n");
    const result = applyFolderRenameWriteback(content, "New");
    assert.ok(result.includes("owner: APS"));
    assert.ok(result.includes("tags: [foo, bar]"));
    assert.ok(result.includes("body text"));
  });

  it("adds bookmark_name to existing frontmatter that lacks it", () => {
    const content = [
      "---",
      "owner: APS",
      "status: active",
      "---",
      "# Doc",
    ].join("\n");
    const result = applyFolderRenameWriteback(content, "Injected Name");
    assert.ok(result.includes("bookmark_name: Injected Name"));
    assert.ok(result.includes("owner: APS"));
    assert.ok(result.includes("status: active"));
    assert.ok(result.includes("# Doc"));
  });

  it("creates a frontmatter block when none exists", () => {
    const content = "# Title\n\nSome body.";
    const result = applyFolderRenameWriteback(content, "Created Name");
    assert.ok(result.startsWith("---\n"));
    assert.ok(result.includes("bookmark_name: Created Name"));
    assert.ok(result.includes("# Title"));
    assert.ok(result.includes("Some body."));
  });

  it("preserves content after frontmatter unchanged", () => {
    const body = "# Heading\n\nParagraph.\n\n- item";
    const content = ["---", "bookmark_name: Old", "---", body].join("\n");
    const result = applyFolderRenameWriteback(content, "New");
    assert.ok(result.endsWith(body));
  });

  it("handles bookmark_name with special characters in new title", () => {
    const content = ["---", "bookmark_name: Plain", "---"].join("\n");
    const result = applyFolderRenameWriteback(content, "[VN] Host bootloader (v2)");
    assert.ok(result.includes("bookmark_name: [VN] Host bootloader (v2)"));
  });

  it("adds bookmark_name before closing --- (not after body)", () => {
    const content = ["---", "owner: x", "---", "body"].join("\n");
    const result = applyFolderRenameWriteback(content, "Title");
    const lines = result.split("\n");
    const bmIdx = lines.findIndex((l) => l.startsWith("bookmark_name:"));
    const closingIdx = lines.indexOf("---", 1);
    // bookmark_name must appear before the closing ---
    assert.ok(bmIdx < closingIdx, "bookmark_name should be inside frontmatter");
  });
});

// ---------------------------------------------------------------------------
// processFolderRename
// ---------------------------------------------------------------------------

describe("processFolderRename", () => {
  it("returns file_not_found when readFile returns null", () => {
    const result = processFolderRename(
      {
        managedKey: "folder:1_Projects/APS-45429",
        newTitle: "New Title",
        vaultBasePath: "/vault",
      },
      () => null
    );
    assert.deepEqual(result, { success: false, reason: "file_not_found" });
  });

  it("returns unresolvable_key for unknown key format", () => {
    const result = processFolderRename(
      {
        managedKey: "unknown:path/to/thing",
        newTitle: "New Title",
        vaultBasePath: "/vault",
      },
      () => "content"
    );
    assert.deepEqual(result, { success: false, reason: "unresolvable_key" });
  });

  it("returns success with targetPath and newContent for note key", () => {
    const original = ["---", "bookmark_name: Old", "---", "# Doc"].join("\n");
    const result = processFolderRename(
      {
        managedKey: "note:1_Projects/APS-47235.md",
        newTitle: "Updated Name",
        vaultBasePath: "/vault",
      },
      (path) => {
        assert.equal(path, "/vault/1_Projects/APS-47235.md");
        return original;
      }
    );
    assert.equal(result.success, true);
    assert.equal(result.targetPath, "/vault/1_Projects/APS-47235.md");
    assert.ok(result.newContent?.includes("bookmark_name: Updated Name"));
    assert.equal(result.reason, undefined);
  });

  it("returns success with targetPath and newContent for folder key", () => {
    const original = ["---", "bookmark_name: Old Folder", "---", "# Folder"].join("\n");
    const result = processFolderRename(
      {
        managedKey: "folder:1_Projects/APS-45429",
        newTitle: "[VN] Host bootloader",
        vaultBasePath: "/vault",
      },
      (path) => {
        assert.equal(path, "/vault/1_Projects/APS-45429/APS-45429.md");
        return original;
      }
    );
    assert.equal(result.success, true);
    assert.equal(result.targetPath, "/vault/1_Projects/APS-45429/APS-45429.md");
    assert.ok(result.newContent?.includes("bookmark_name: [VN] Host bootloader"));
  });

  it("readFile is called with the resolved absolute path", () => {
    let calledWith: string | undefined;
    processFolderRename(
      {
        managedKey: "note:notes/my-note.md",
        newTitle: "T",
        vaultBasePath: "/base",
      },
      (path) => {
        calledWith = path;
        return null;
      }
    );
    assert.equal(calledWith, "/base/notes/my-note.md");
  });
});
