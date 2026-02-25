import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractBookmarkNameFromFrontmatter } from "./frontmatter";

describe("extractBookmarkNameFromFrontmatter", () => {
  it("extracts bookmark_name from simple frontmatter", () => {
    const content = ["---", "bookmark_name: [VN] Host bootloader", "---", "# Doc"].join("\n");
    assert.equal(extractBookmarkNameFromFrontmatter(content), "[VN] Host bootloader");
  });

  it("supports quoted bookmark_name", () => {
    const content = ["---", 'bookmark_name: "[VN] Host bootloader"', "---", "# Doc"].join("\n");
    assert.equal(extractBookmarkNameFromFrontmatter(content), "[VN] Host bootloader");
  });

  it("returns null when bookmark_name is missing", () => {
    const content = ["---", "owner: APS", "---", "# Doc"].join("\n");
    assert.equal(extractBookmarkNameFromFrontmatter(content), null);
  });

  it("returns null when frontmatter is missing", () => {
    const content = ["# Title", "bookmark_name: ignored"].join("\n");
    assert.equal(extractBookmarkNameFromFrontmatter(content), null);
  });

  it("returns null for empty bookmark_name", () => {
    const content = ["---", "bookmark_name:   ", "---", "# Doc"].join("\n");
    assert.equal(extractBookmarkNameFromFrontmatter(content), null);
  });
});
