import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyWriteback } from "./writeback-engine";

describe("applyWriteback", () => {
  it("creates by appending to existing Link section", () => {
    const md = ["# Doc", "### Link", "- [One](https://one.test)", "### Other", "- [Keep](https://keep.test)"]
      .join("\n");

    const result = applyWriteback(md, {
      type: "create",
      notePath: "a.md",
      title: "Two",
      url: "https://two.test",
      linkHeading: "Link"
    });

    assert.equal(result.success, true);
    assert.equal(
      result.newContent,
      [
        "# Doc",
        "### Link",
        "- [One](https://one.test)",
        "- [Two](https://two.test)",
        "### Other",
        "- [Keep](https://keep.test)"
      ].join("\n")
    );
  });

  it("creates a Link section when missing", () => {
    const md = ["# Doc", "## Notes", "hello"].join("\n");

    const result = applyWriteback(md, {
      type: "create",
      notePath: "a.md",
      title: "New",
      url: "https://new.test",
      linkHeading: "### Link"
    });

    assert.equal(result.success, true);
    assert.equal(
      result.newContent,
      ["# Doc", "## Notes", "hello", "### Link", "- [New](https://new.test)"].join("\n")
    );
  });

  it("creates at the resolved link index", () => {
    const md = ["### Link", "- [One](https://one.test)", "- [Three](https://three.test)"].join("\n");

    const result = applyWriteback(md, {
      type: "create",
      notePath: "a.md",
      linkIndex: 1,
      title: "Two",
      url: "https://two.test",
      linkHeading: "Link"
    });

    assert.equal(result.success, true);
    assert.equal(
      result.newContent,
      [
        "### Link",
        "- [One](https://one.test)",
        "- [Two](https://two.test)",
        "- [Three](https://three.test)"
      ].join("\n")
    );
  });

  it("updates title only", () => {
    const md = ["### Link", "- [Old](https://one.test)", "- [Keep](https://two.test)"].join("\n");

    const result = applyWriteback(md, {
      type: "update",
      notePath: "a.md",
      linkIndex: 0,
      title: "New",
      linkHeading: "Link"
    });

    assert.equal(result.success, true);
    assert.equal(result.newContent, ["### Link", "- [New](https://one.test)", "- [Keep](https://two.test)"].join("\n"));
  });

  it("updates url only", () => {
    const md = ["### Link", "- [Old](https://one.test)"].join("\n");

    const result = applyWriteback(md, {
      type: "update",
      notePath: "a.md",
      linkIndex: 0,
      url: "https://changed.test",
      linkHeading: "Link"
    });

    assert.equal(result.success, true);
    assert.equal(result.newContent, ["### Link", "- [Old](https://changed.test)"].join("\n"));
  });

  it("updates title and url", () => {
    const md = ["### Link", "- [Old](https://one.test)", "### Other"].join("\n");

    const result = applyWriteback(md, {
      type: "update",
      notePath: "a.md",
      linkIndex: 0,
      title: "Brand New",
      url: "https://brand-new.test",
      linkHeading: "### Link"
    });

    assert.equal(result.success, true);
    assert.equal(result.newContent, ["### Link", "- [Brand New](https://brand-new.test)", "### Other"].join("\n"));
  });

  it("deletes exactly one line at index", () => {
    const md = [
      "### Link",
      "- [One](https://one.test)",
      "- [Two](https://two.test)",
      "- [Three](https://three.test)",
      "### Other"
    ].join("\n");

    const result = applyWriteback(md, {
      type: "delete",
      notePath: "a.md",
      linkIndex: 1,
      linkHeading: "Link"
    });

    assert.equal(result.success, true);
    assert.equal(
      result.newContent,
      ["### Link", "- [One](https://one.test)", "- [Three](https://three.test)", "### Other"].join("\n")
    );
  });

  it("deletes one of duplicate urls without collapsing others", () => {
    const md = [
      "### Link",
      "- [A](https://dup.test)",
      "- [B](https://dup.test)",
      "- [C](https://dup.test)",
      "### Other"
    ].join("\n");

    const result = applyWriteback(md, {
      type: "delete",
      notePath: "a.md",
      linkIndex: 1,
      linkHeading: "Link"
    });

    assert.equal(result.success, true);
    assert.equal(
      result.newContent,
      ["### Link", "- [A](https://dup.test)", "- [C](https://dup.test)", "### Other"].join("\n")
    );
  });

  it("returns heading_not_found when target heading is missing", () => {
    const md = ["# Doc", "### Other", "- [A](https://a.test)"].join("\n");

    const result = applyWriteback(md, {
      type: "update",
      notePath: "a.md",
      linkIndex: 0,
      title: "X",
      linkHeading: "Link"
    });

    assert.deepEqual(result, { success: false, reason: "heading_not_found" });
  });

  it("returns index_out_of_range when index is invalid", () => {
    const md = ["### Link", "- [A](https://a.test)", "### Other"].join("\n");

    const result = applyWriteback(md, {
      type: "delete",
      notePath: "a.md",
      linkIndex: 3,
      linkHeading: "Link"
    });

    assert.deepEqual(result, { success: false, reason: "index_out_of_range" });
  });

  it("preserves content outside target section byte-for-byte and keeps CRLF", () => {
    const eol = "\r\n";
    const md = [
      "---",
      "bookmark_name: Keep This",
      "---",
      "# Title",
      "",
      "### Link",
      "- [Old](https://old.test)",
      "",
      "Paragraph untouched.",
      "### Other",
      "- [Outside](https://outside.test)"
    ].join(eol);

    const result = applyWriteback(md, {
      type: "update",
      notePath: "a.md",
      linkIndex: 0,
      title: "New",
      url: "https://new.test",
      linkHeading: "Link"
    });

    assert.equal(result.success, true);
    assert.equal(
      result.newContent,
      [
        "---",
        "bookmark_name: Keep This",
        "---",
        "# Title",
        "",
        "### Link",
        "- [New](https://new.test)",
        "",
        "Paragraph untouched.",
        "### Other",
        "- [Outside](https://outside.test)"
      ].join(eol)
    );
    assert.equal(result.newContent?.includes("\r\n"), true);
  });

  it("supports bare Link heading line", () => {
    const md = ["# Doc", "Link", "- [A](https://a.test)", "### Other"].join("\n");

    const result = applyWriteback(md, {
      type: "update",
      notePath: "a.md",
      linkIndex: 0,
      title: "B",
      linkHeading: "### Link"
    });

    assert.equal(result.success, true);
    assert.equal(result.newContent, ["# Doc", "Link", "- [B](https://a.test)", "### Other"].join("\n"));
  });
});
