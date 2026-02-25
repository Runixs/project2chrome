import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createBridgeHandler } from "./bridge-handler";
import { applyReverseEvent, createReverseApplyHook, type ReverseApplyContext } from "./reverse-apply";
import type { ReverseBatch, ReverseEvent } from "./reverse-sync-types";

const TEST_TOKEN = "test-token-reverse-apply";

function makeEvent(overrides: Partial<ReverseEvent>): ReverseEvent {
  return {
    batchId: overrides.batchId ?? "batch-1",
    eventId: overrides.eventId ?? "evt-1",
    type: overrides.type ?? "bookmark_updated",
    bookmarkId: overrides.bookmarkId ?? "bm-1",
    managedKey: overrides.managedKey ?? "note:1_Projects/Doc.md",
    parentId: overrides.parentId,
    title: overrides.title,
    url: overrides.url,
    occurredAt: overrides.occurredAt ?? "2026-02-25T10:00:00.000Z",
    schemaVersion: overrides.schemaVersion ?? "1"
  };
}

function makeContext(initialFiles: Record<string, string>): {
  ctx: ReverseApplyContext;
  writes: Array<{ path: string; content: string }>;
  files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const writes: Array<{ path: string; content: string }> = [];

  return {
    files,
    writes,
    ctx: {
      vaultBasePath: "/vault",
      linkHeading: "Link",
      readFile: (path) => files.get(path) ?? null,
      writeFile: (path, content) => {
        writes.push({ path, content });
        files.set(path, content);
      }
    }
  };
}

describe("applyReverseEvent", () => {
  it("applies note:<path> folder_renamed by writing bookmark_name frontmatter", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext({
      [targetPath]: ["---", "bookmark_name: Old", "---", "# Body"].join("\n")
    });

    const ack = applyReverseEvent(
      makeEvent({
        type: "folder_renamed",
        managedKey: "note:1_Projects/Doc.md",
        title: "Renamed Doc"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(ack.resolvedPath, targetPath);
    assert.equal(ack.resolvedKey, "note:1_Projects/Doc.md");
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.content.includes("bookmark_name: Renamed Doc"));
  });

  it("applies folder-parent bookmark_created by resolving <folder>.md and appending link", () => {
    const targetPath = "/vault/1_Projects/EASE.md";
    const { ctx, writes } = makeContext({
      [targetPath]: ["# EASE", "### Link", "- [One](https://one.test)"].join("\n")
    });
    ctx.knownKeys = {
      managedFolderPaths: new Set(["1_Projects/EASE"]),
      managedNotePaths: new Set(["1_Projects/EASE.md"])
    };

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_created",
        managedKey: "folder:1_Projects/EASE",
        title: "test",
        url: "chrome://extensions"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(ack.resolvedPath, targetPath);
    assert.equal(ack.resolvedKey, "1_Projects/EASE.md|1");
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.content.includes("- [test](chrome://extensions)"));
  });

  it("applies folder-parent bookmark_created by fallback bookmark_name match", () => {
    const targetPath = "/vault/1_Projects/CustomName.md";
    const { ctx, writes } = makeContext({
      [targetPath]: [
        "---",
        "bookmark_name: EASE",
        "---",
        "# CustomName",
        "### Link"
      ].join("\n")
    });
    ctx.knownKeys = {
      managedFolderPaths: new Set(["1_Projects/EASE"]),
      managedNotePaths: new Set(["1_Projects/CustomName.md"])
    };

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_created",
        managedKey: "folder:1_Projects/EASE",
        title: "test",
        url: "chrome://extensions"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(ack.resolvedPath, targetPath);
    assert.equal(ack.resolvedKey, "1_Projects/CustomName.md|0");
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.content.includes("- [test](chrome://extensions)"));
  });

  it("returns skipped_ambiguous when folder-parent create target cannot be resolved", () => {
    const { ctx, writes } = makeContext({});
    ctx.knownKeys = {
      managedFolderPaths: new Set(["1_Projects/EASE"]),
      managedNotePaths: new Set()
    };

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_created",
        managedKey: "folder:1_Projects/EASE",
        title: "test",
        url: "chrome://extensions"
      }),
      ctx
    );

    assert.deepEqual(ack, {
      eventId: "evt-1",
      status: "skipped_ambiguous",
      reason: "folder_parent_note_not_found"
    });
    assert.equal(writes.length, 0);
  });

  it("returns skipped_ambiguous for parent key updates before resolvedKey remap", () => {
    const { ctx, writes } = makeContext({});
    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_updated",
        managedKey: "folder:1_Projects/EASE",
        title: "changed"
      }),
      ctx
    );

    assert.deepEqual(ack, {
      eventId: "evt-1",
      status: "skipped_ambiguous",
      reason: "parent_key_requires_create"
    });
    assert.equal(writes.length, 0);
  });

  it("applies link-key bookmark_created by appending a link to Link section", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext({
      [targetPath]: ["# Doc", "### Link", "- [One](https://one.test)", "### Other"].join("\n")
    });

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_created",
        managedKey: "1_Projects/Doc.md|1",
        title: "Two",
        url: "https://two.test"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(writes.length, 1);
    assert.equal(
      writes[0]?.content,
      ["# Doc", "### Link", "- [One](https://one.test)", "- [Two](https://two.test)", "### Other"].join("\n")
    );
  });

  it("applies link-key bookmark_deleted by removing the resolved index", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext({
      [targetPath]: ["### Link", "- [One](https://one.test)", "- [Two](https://two.test)", "### Other"].join("\n")
    });

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_deleted",
        managedKey: "1_Projects/Doc.md|1"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.content, ["### Link", "- [One](https://one.test)", "### Other"].join("\n"));
  });

  it("applies folder:<path> folder_renamed by updating bookmark_name", () => {
    const targetPath = "/vault/1_Projects/Folder/Folder.md";
    const { ctx, writes } = makeContext({
      [targetPath]: ["---", "owner: team", "---", "# Folder"].join("\n")
    });

    const ack = applyReverseEvent(
      makeEvent({
        type: "folder_renamed",
        managedKey: "folder:1_Projects/Folder",
        title: "Folder New Name"
      }),
      ctx
    );

    assert.equal(ack.status, "applied");
    assert.equal(ack.resolvedPath, targetPath);
    assert.equal(writes.length, 1);
    assert.ok(writes[0]?.content.includes("bookmark_name: Folder New Name"));
  });

  it("returns skipped_unmanaged when managedKey is missing", () => {
    const { ctx, writes } = makeContext({});
    const ack = applyReverseEvent(makeEvent({ managedKey: "" }), ctx);
    assert.deepEqual(ack, {
      eventId: "evt-1",
      status: "skipped_unmanaged",
      reason: "unrecognized_key"
    });
    assert.equal(writes.length, 0);
  });

  it("returns skipped_unmanaged for unrecognized managedKey format", () => {
    const { ctx, writes } = makeContext({});
    const ack = applyReverseEvent(makeEvent({ managedKey: "invalid-key-format" }), ctx);
    assert.deepEqual(ack, {
      eventId: "evt-1",
      status: "skipped_unmanaged",
      reason: "unrecognized_key"
    });
    assert.equal(writes.length, 0);
  });

  it("returns skipped_ambiguous when writeback fails (heading not found)", () => {
    const targetPath = "/vault/1_Projects/Doc.md";
    const { ctx, writes } = makeContext({
      [targetPath]: ["# Doc", "### Other", "- [One](https://one.test)"].join("\n")
    });

    const ack = applyReverseEvent(
      makeEvent({
        type: "bookmark_updated",
        managedKey: "1_Projects/Doc.md|0",
        title: "Changed"
      }),
      ctx
    );

    assert.deepEqual(ack, {
      eventId: "evt-1",
      status: "skipped_ambiguous",
      reason: "heading_not_found"
    });
    assert.equal(writes.length, 0);
  });
});

describe("reverse-sync idempotency via bridge handler", () => {
  let server: Server;
  let port = 0;

  before(
    () =>
      new Promise<void>((resolve) => {
        const { ctx } = makeContext({
          "/vault/1_Projects/Doc.md": ["### Link", "- [One](https://one.test)"].join("\n")
        });
        const handler = createBridgeHandler({
          expectedToken: TEST_TOKEN,
          getPayload: () => "{}\n",
          processedBatchIds: new Set<string>(),
          applyHook: createReverseApplyHook(ctx)
        });
        server = createServer(handler);
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as AddressInfo;
          port = addr.port;
          resolve();
        });
      })
  );

  after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      })
  );

  it("replay of same batch/event returns duplicate", async () => {
    const batch: ReverseBatch = {
      batchId: "batch-dup-1",
      sentAt: "2026-02-25T10:00:00.000Z",
      events: [
        makeEvent({
          batchId: "batch-dup-1",
          eventId: "evt-dup-1",
          type: "bookmark_deleted",
          managedKey: "1_Projects/Doc.md|0"
        })
      ]
    };

    const first = await fetch(`http://127.0.0.1:${port}/reverse-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Project2Chrome-Token": TEST_TOKEN
      },
      body: JSON.stringify(batch)
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as { results: Array<{ status: string }> };
    assert.equal(firstBody.results[0]?.status, "applied");

    const second = await fetch(`http://127.0.0.1:${port}/reverse-sync`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Project2Chrome-Token": TEST_TOKEN
      },
      body: JSON.stringify(batch)
    });
    assert.equal(second.status, 200);
    const secondBody = (await second.json()) as { results: Array<{ eventId: string; status: string }> };
    assert.equal(secondBody.results[0]?.eventId, "evt-dup-1");
    assert.equal(secondBody.results[0]?.status, "duplicate");
  });
});
