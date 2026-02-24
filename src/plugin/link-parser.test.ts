import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLinksFromHeading } from "./link-parser";

describe("parseLinksFromHeading", () => {
  it("extracts markdown links and raw urls under target heading", () => {
    const md = [
      "# Doc",
      "### Link",
      "- [Google](https://google.com)",
      "- https://example.com/path",
      "### Other",
      "- [Ignored](https://ignored.com)"
    ].join("\n");

    const parsed = parseLinksFromHeading(md, "Link", "a/b.md");
    assert.equal(parsed.length, 2);
    assert.deepEqual(
      parsed.map((item) => ({ title: item.title, url: item.url })),
      [
        { title: "Google", url: "https://google.com/" },
        { title: "https://example.com/path", url: "https://example.com/path" }
      ]
    );
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
