import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildExtensionSyncPayload } from "./extension-payload";
import { DEFAULT_SETTINGS, type DesiredFolder, type Project2ChromeSettings } from "./types";

describe("buildExtensionSyncPayload", () => {
  it("uses custom root folder mode", () => {
    const settings: Project2ChromeSettings = {
      ...DEFAULT_SETTINGS,
      bookmarkBarRootMode: "custom",
      bookmarkBarRootCustomName: "MyRoot"
    };
    const desired: DesiredFolder[] = [];

    const payload = buildExtensionSyncPayload(desired, settings);

    assert.equal(payload.rootFolderName, "MyRoot");
    assert.equal(payload.desired, desired);
    assert.ok(payload.generatedAt.length > 0);
  });

  it("uses target folder name when target mode is selected", () => {
    const settings: Project2ChromeSettings = {
      ...DEFAULT_SETTINGS,
      bookmarkBarRootMode: "target",
      targetFolderPath: "1_Projects/IssueTracker"
    };

    const payload = buildExtensionSyncPayload([], settings);

    assert.equal(payload.rootFolderName, "IssueTracker");
  });
});
