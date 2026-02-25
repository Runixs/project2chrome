/**
 * E2E Reverse Sync Scenario Matrix
 *
 * Wires the full plugin pipeline end-to-end at the HTTP API level:
 *   createReverseApplyHook(ctx) → createBridgeHandler({ applyHook }) → real HTTP server
 *
 * In-memory vault (Map<string, string>) replaces real filesystem I/O.
 * No Obsidian instance or Chrome browser required.
 *
 * Scenarios:
 *   S1  (happy)       bookmark_created   → link appended
 *   S2  (happy)       bookmark_updated   → link title/url replaced
 *   S3  (happy)       bookmark_deleted   → link removed
 *   S4  (happy)       folder_renamed     → bookmark_name updated in folder-note
 *   S5  (auth fail)   wrong token        → 401, no mutation
 *   S6  (ambiguous)   index out of bound → skipped_ambiguous
 *   S7  (unmanaged)   unrecognized key   → skipped_unmanaged
 *   S8  (duplicate)   same batchId ×2    → second all duplicate
 *   S9  (suppression) plugin applies normally (suppression is extension-side;
 *                     see extension/suppression.test.js for full coverage)
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { createBridgeHandler } from "./bridge-handler";
import { createReverseApplyHook, type ReverseApplyContext } from "./reverse-apply";
import type { ManagedKeySet } from "./reverse-guardrails";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_TOKEN = "test-token-e2e-reverse-sync";
const VAULT_BASE = "/vault";
const LINK_HEADING = "Link";

// ---------------------------------------------------------------------------
// Vault fixture — initial file contents
// ---------------------------------------------------------------------------

const INITIAL_FILES: Record<string, string> = {
  // S1: bookmark_created — will have link appended at index 1
  "/vault/Notes/create-target.md": ["### Link", "- [One](https://one.test)"].join("\n"),

  // S2: bookmark_updated — index 0 will be replaced
  "/vault/Notes/update-target.md": ["### Link", "- [Old Title](https://old.test)"].join("\n"),

  // S3: bookmark_deleted — index 1 will be removed
  "/vault/Notes/delete-target.md": [
    "### Link",
    "- [One](https://one.test)",
    "- [Two](https://two.test)"
  ].join("\n"),

  // S4: folder_renamed — folder-note; bookmark_name will be set
  "/vault/Notes/Alpha/Alpha.md": ["# Alpha", "Some folder content."].join("\n"),

  // S6: ambiguous — only 1 link; index 5 is OOB
  // S9: loop-suppression check — index 0 update (should succeed)
  "/vault/Notes/ambig-target.md": ["### Link", "- [One](https://one.test)"].join("\n")
};

// Managed key registry for guardrail validation
const KNOWN_KEYS: ManagedKeySet = {
  managedNotePaths: new Set([
    "Notes/create-target.md",
    "Notes/update-target.md",
    "Notes/delete-target.md",
    "Notes/ambig-target.md"
  ]),
  managedFolderPaths: new Set(["Notes/Alpha"])
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface VaultHarness {
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
  ctx: ReverseApplyContext;
}

function makeVault(initialFiles: Record<string, string>): VaultHarness {
  const files = new Map<string, string>(Object.entries(initialFiles));
  const writes: Array<{ path: string; content: string }> = [];

  const ctx: ReverseApplyContext = {
    vaultBasePath: VAULT_BASE,
    linkHeading: LINK_HEADING,
    readFile: (path) => files.get(path) ?? null,
    writeFile: (path, content) => {
      writes.push({ path, content });
      files.set(path, content);
    },
    knownKeys: KNOWN_KEYS
  };

  return { files, writes, ctx };
}

async function httpPost(
  port: number,
  path: string,
  body: unknown,
  token?: string
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token !== undefined) {
    headers["X-Project2Chrome-Token"] = token;
  }
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });
}

function makeBatch(batchId: string, events: object[]) {
  return { batchId, sentAt: "2026-02-25T10:00:00.000Z", events };
}

function makeEvent(fields: {
  batchId: string;
  eventId: string;
  type: string;
  bookmarkId?: string;
  managedKey: string;
  title?: string;
  url?: string;
}) {
  return {
    batchId: fields.batchId,
    eventId: fields.eventId,
    type: fields.type,
    bookmarkId: fields.bookmarkId ?? "bm-e2e",
    managedKey: fields.managedKey,
    occurredAt: "2026-02-25T10:00:00.000Z",
    schemaVersion: "1",
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.url !== undefined ? { url: fields.url } : {})
  };
}

// ---------------------------------------------------------------------------
// E2E Scenario Matrix
// ---------------------------------------------------------------------------

describe("e2e reverse-sync scenario matrix", () => {
  let server: Server;
  let port: number;
  let vault: VaultHarness;
  const processedBatchIds = new Set<string>();

  before(
    () =>
      new Promise<void>((resolve) => {
        vault = makeVault({ ...INITIAL_FILES });
        const applyHook = createReverseApplyHook(vault.ctx);
        const handler = createBridgeHandler({
          expectedToken: TEST_TOKEN,
          getPayload: () => "{}",
          processedBatchIds,
          applyHook
        });
        server = createServer(handler);
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as AddressInfo).port;
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

  // ── S1: bookmark_created → link appended ──────────────────────────────────

  it("S1 (happy): bookmark_created appends link to note Link section", async () => {
    const batch = makeBatch("batch-s1", [
      makeEvent({
        batchId: "batch-s1",
        eventId: "evt-s1",
        type: "bookmark_created",
        managedKey: "Notes/create-target.md|1",
        title: "Two",
        url: "https://two.test"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);

    const body = (await res.json()) as {
      batchId: string;
      results: Array<{ eventId: string; status: string; resolvedPath?: string }>;
    };
    assert.equal(body.batchId, "batch-s1");
    assert.equal(body.results.length, 1);

    const result = body.results[0];
    assert.ok(result !== undefined, "results[0] should exist");
    assert.equal(result.eventId, "evt-s1");
    assert.equal(result.status, "applied");

    // Verify vault mutation
    const content = vault.files.get("/vault/Notes/create-target.md") ?? "";
    assert.ok(content.includes("- [One](https://one.test)"), "original link preserved");
    assert.ok(content.includes("- [Two](https://two.test)"), "new link appended");
  });

  // ── S2: bookmark_updated → link title/url replaced ────────────────────────

  it("S2 (happy): bookmark_updated replaces link title and url", async () => {
    const batch = makeBatch("batch-s2", [
      makeEvent({
        batchId: "batch-s2",
        eventId: "evt-s2",
        type: "bookmark_updated",
        managedKey: "Notes/update-target.md|0",
        title: "New Title",
        url: "https://new.test"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { results: Array<{ eventId: string; status: string }> };
    const result = body.results[0];
    assert.ok(result !== undefined, "results[0] should exist");
    assert.equal(result.eventId, "evt-s2");
    assert.equal(result.status, "applied");

    const content = vault.files.get("/vault/Notes/update-target.md") ?? "";
    assert.ok(content.includes("- [New Title](https://new.test)"), "link updated");
    assert.ok(!content.includes("Old Title"), "old title replaced");
  });

  // ── S3: bookmark_deleted → link removed ───────────────────────────────────

  it("S3 (happy): bookmark_deleted removes link at specified index", async () => {
    const batch = makeBatch("batch-s3", [
      makeEvent({
        batchId: "batch-s3",
        eventId: "evt-s3",
        type: "bookmark_deleted",
        managedKey: "Notes/delete-target.md|1"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { results: Array<{ eventId: string; status: string }> };
    const result = body.results[0];
    assert.ok(result !== undefined, "results[0] should exist");
    assert.equal(result.eventId, "evt-s3");
    assert.equal(result.status, "applied");

    const content = vault.files.get("/vault/Notes/delete-target.md") ?? "";
    assert.ok(content.includes("- [One](https://one.test)"), "first link preserved");
    assert.ok(!content.includes("- [Two](https://two.test)"), "deleted link removed");
  });

  // ── S4: folder_renamed → bookmark_name updated in folder-note ─────────────

  it("S4 (happy): folder_renamed updates bookmark_name in folder-note frontmatter", async () => {
    const batch = makeBatch("batch-s4", [
      makeEvent({
        batchId: "batch-s4",
        eventId: "evt-s4",
        type: "folder_renamed",
        managedKey: "folder:Notes/Alpha",
        title: "Alpha Renamed"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { results: Array<{ eventId: string; status: string }> };
    const result = body.results[0];
    assert.ok(result !== undefined, "results[0] should exist");
    assert.equal(result.eventId, "evt-s4");
    assert.equal(result.status, "applied");

    // folder:Notes/Alpha → /vault/Notes/Alpha/Alpha.md
    const content = vault.files.get("/vault/Notes/Alpha/Alpha.md") ?? "";
    assert.ok(content.includes("bookmark_name: Alpha Renamed"), "bookmark_name written");
  });

  // ── S5: auth failure → 401, no mutation ───────────────────────────────────

  it("S5 (auth failure): wrong token returns 401 and does not mutate vault", async () => {
    const writesBefore = vault.writes.length;

    const batch = makeBatch("batch-s5", [
      makeEvent({
        batchId: "batch-s5",
        eventId: "evt-s5",
        type: "bookmark_updated",
        managedKey: "Notes/update-target.md|0",
        title: "Malicious Write",
        url: "https://evil.test"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, "wrong-token");
    assert.equal(res.status, 401);

    // No writes should have occurred
    assert.equal(vault.writes.length, writesBefore, "vault must not be mutated on auth failure");

    // batchId must NOT be recorded in processedBatchIds
    assert.equal(processedBatchIds.has("batch-s5"), false, "failed auth must not record batchId");
  });

  // ── S6: ambiguous — index out of bounds → skipped_ambiguous ───────────────

  it("S6 (ambiguous): link index beyond section bounds returns skipped_ambiguous", async () => {
    // ambig-target.md has 1 link; index 5 is strictly > 1 → ambiguous
    const batch = makeBatch("batch-s6", [
      makeEvent({
        batchId: "batch-s6",
        eventId: "evt-s6",
        type: "bookmark_updated",
        managedKey: "Notes/ambig-target.md|5",
        title: "Phantom",
        url: "https://phantom.test"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { results: Array<{ eventId: string; status: string }> };
    const result = body.results[0];
    assert.ok(result !== undefined, "results[0] should exist");
    assert.equal(result.eventId, "evt-s6");
    assert.equal(result.status, "skipped_ambiguous");

    // File must not be mutated
    const content = vault.files.get("/vault/Notes/ambig-target.md") ?? "";
    assert.ok(!content.includes("Phantom"), "ambiguous write must not occur");
  });

  // ── S7: unmanaged — unrecognized key format → skipped_unmanaged ───────────

  it("S7 (unmanaged): unrecognized key format returns skipped_unmanaged", async () => {
    const batch = makeBatch("batch-s7", [
      makeEvent({
        batchId: "batch-s7",
        eventId: "evt-s7",
        type: "bookmark_updated",
        managedKey: "invalid-key-format-no-pipe-or-prefix",
        title: "Ghost",
        url: "https://ghost.test"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { results: Array<{ eventId: string; status: string }> };
    const result = body.results[0];
    assert.ok(result !== undefined, "results[0] should exist");
    assert.equal(result.eventId, "evt-s7");
    assert.equal(result.status, "skipped_unmanaged");
  });

  // ── S8: duplicate batchId → second POST returns all duplicate ─────────────

  it("S8 (duplicate): same batchId sent twice — second returns duplicate for all events", async () => {
    const batch = makeBatch("batch-s8", [
      makeEvent({
        batchId: "batch-s8",
        eventId: "evt-s8",
        type: "bookmark_updated",
        managedKey: "Notes/ambig-target.md|0",
        title: "Dup Check",
        url: "https://dup.test"
      })
    ]);

    const first = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(first.status, 200);

    const firstBody = (await first.json()) as {
      batchId: string;
      results: Array<{ eventId: string; status: string }>;
    };
    const firstResult = firstBody.results[0];
    assert.ok(firstResult !== undefined, "firstBody.results[0] should exist");
    // First request is either applied or a skip, but never duplicate
    assert.notEqual(firstResult.status, "duplicate", "first POST must not return duplicate");

    const second = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(second.status, 200);

    const secondBody = (await second.json()) as {
      batchId: string;
      results: Array<{ eventId: string; status: string }>;
    };
    assert.equal(secondBody.batchId, "batch-s8");
    assert.equal(secondBody.results.length, 1);

    const secondResult = secondBody.results[0];
    assert.ok(secondResult !== undefined, "secondBody.results[0] should exist");
    assert.equal(secondResult.eventId, "evt-s8");
    assert.equal(secondResult.status, "duplicate");
  });

  // ── S9: loop suppression — plugin applies normally; suppression is extension-side

  it("S9 (loop suppression): plugin bridge applies events without plugin-level suppression", async () => {
    // Loop suppression (applyEpoch + cooldown) lives in the Chrome extension side.
    // The plugin bridge NEVER suppresses incoming events — it always processes valid requests.
    // Full suppression coverage: extension/suppression.test.js
    //
    // This test verifies the plugin applies a valid event after S8 mutations,
    // confirming no suppression mechanism exists on the plugin side.
    const batch = makeBatch("batch-s9", [
      makeEvent({
        batchId: "batch-s9",
        eventId: "evt-s9",
        type: "bookmark_updated",
        // S8 updated index 0 to "Dup Check"; now we update it again with a new batch
        managedKey: "Notes/ambig-target.md|0",
        title: "Suppression Verify",
        url: "https://suppression.test"
      })
    ]);

    const res = await httpPost(port, "/reverse-sync", batch, TEST_TOKEN);
    assert.equal(res.status, 200);

    const body = (await res.json()) as { results: Array<{ eventId: string; status: string }> };
    const result = body.results[0];
    assert.ok(result !== undefined, "results[0] should exist");
    assert.equal(result.eventId, "evt-s9");
    // Plugin applies the event normally — no suppression on the plugin side
    assert.equal(result.status, "applied");

    const content = vault.files.get("/vault/Notes/ambig-target.md") ?? "";
    assert.ok(
      content.includes("- [Suppression Verify](https://suppression.test)"),
      "plugin applied event without suppression"
    );
  });
});
