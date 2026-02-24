import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLinksFromHeading } from "./link-parser";

describe("parseLinksFromHeading", () => {
  it("extracts markdown links under target heading", () => {
    const md = [
      "# Doc",
      "### Link",
      "- [Google](https://google.com)",
      "- [Example](https://example.com/path)",
      "### Other",
      "- [Ignored](https://ignored.com)"
    ].join("\n");

    const parsed = parseLinksFromHeading(md, "Link", "a/b.md");
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map((item) => ({ title: item.title, url: item.url })),
      [
        { title: "Google", url: "https://google.com/" },
        { title: "Example", url: "https://example.com/path" }
      ]
    );
  });

  it("ignores bare urls even when listed as bullets", () => {
    const md = ["### Link", "- https://example.com/path", "- [Keep](https://keep.me)"].join("\n");

    const parsed = parseLinksFromHeading(md, "Link", "x.md");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.title, "Keep");
    assert.equal(parsed[0]?.url, "https://keep.me/");
  });

  it("extracts multiple markdown bullets in the same section", () => {
    const md = [
      "### Link",
      "- [One](https://one.test)",
      "- [Two](https://two.test)",
      "- [Three](https://three.test)"
    ].join("\n");

    const parsed = parseLinksFromHeading(md, "Link", "multi.md");
    assert.equal(parsed.length, 3);
    assert.deepEqual(parsed.map((item) => item.title), ["One", "Two", "Three"]);
  });

  it("accepts configured heading with markdown hashes", () => {
    const md = ["### Link", "- [Issue](https://example.com/issue)", "### Other", "- [Skip](https://skip.me)"].join("\n");

    const parsed = parseLinksFromHeading(md, "### Link", "h.md");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.title, "Issue");
    assert.equal(parsed[0]?.url, "https://example.com/issue");
  });

  it("returns empty when heading does not exist", () => {
    const md = "# A\n- https://x.com";
    const parsed = parseLinksFromHeading(md, "Link", "x.md");
    assert.equal(parsed.length, 0);
  });

  it("parses markdown link titles containing inner brackets", () => {
    const md = [
      "### Link",
      "- [[VN] Host Bootloader Solution](https://confluence.samsungds.net/spaces/APS/pages/3300017080/40.+VN+Host+Bootloader+Solution)"
    ].join("\n");

    const parsed = parseLinksFromHeading(md, "Link", "vn.md");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]?.title, "[VN] Host Bootloader Solution");
    assert.equal(
      parsed[0]?.url,
      "https://confluence.samsungds.net/spaces/APS/pages/3300017080/40.+VN+Host+Bootloader+Solution"
    );
  });
});
