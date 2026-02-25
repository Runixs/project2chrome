import type { ApplyHook } from "./bridge-handler";
import { processFolderRename } from "./folder-rename-writeback";
import type { EventAck, ReverseEvent } from "./reverse-sync-types";
import { applyWriteback, type WritebackOperation } from "./writeback-engine";

export type ReverseApplyContext = {
  vaultBasePath: string;
  linkHeading: string;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
};

type ManagedKeyResolution =
  | { kind: "rename"; managedKey: string }
  | { kind: "link"; managedKey: string; sourcePath: string; linkIndex: number };

export function applyReverseEvent(event: ReverseEvent, ctx: ReverseApplyContext): EventAck {
  const managedKey = event.managedKey?.trim();
  if (!managedKey) {
    return { eventId: event.eventId, status: "skipped_unmanaged", reason: "unrecognized_key" };
  }

  const key = resolveManagedKey(managedKey);
  if (!key) {
    return { eventId: event.eventId, status: "skipped_unmanaged", reason: "unrecognized_key" };
  }

  if (key.kind === "rename") {
    const rename = processFolderRename(
      {
        managedKey: key.managedKey,
        newTitle: event.title ?? "",
        vaultBasePath: ctx.vaultBasePath
      },
      ctx.readFile
    );

    if (!rename.success || !rename.targetPath || rename.newContent === undefined) {
      return {
        eventId: event.eventId,
        status: "skipped_ambiguous",
        reason: rename.reason ?? "rename_failed"
      };
    }

    ctx.writeFile(rename.targetPath, rename.newContent);
    return {
      eventId: event.eventId,
      status: "applied",
      resolvedPath: rename.targetPath,
      resolvedKey: key.managedKey
    };
  }

  const targetPath = joinVaultPath(ctx.vaultBasePath, key.sourcePath);
  const existingContent = ctx.readFile(targetPath);
  if (existingContent === null) {
    return {
      eventId: event.eventId,
      status: "skipped_ambiguous",
      reason: "file_not_found"
    };
  }

  const writebackOperation = toWritebackOperation(event, key.sourcePath, key.linkIndex, ctx.linkHeading);
  if (!writebackOperation) {
    return {
      eventId: event.eventId,
      status: "skipped_unmanaged",
      reason: "unrecognized_key"
    };
  }

  const result = applyWriteback(existingContent, writebackOperation);
  if (!result.success || result.newContent === undefined) {
    return {
      eventId: event.eventId,
      status: "skipped_ambiguous",
      reason: result.reason ?? "writeback_failed"
    };
  }

  ctx.writeFile(targetPath, result.newContent);
  return {
    eventId: event.eventId,
    status: "applied",
    resolvedPath: targetPath,
    resolvedKey: key.managedKey
  };
}

export function createReverseApplyHook(ctx: ReverseApplyContext): ApplyHook {
  return (batch) => batch.events.map((event) => applyReverseEvent(event, ctx));
}

function resolveManagedKey(managedKey: string): ManagedKeyResolution | null {
  if (managedKey.startsWith("note:") || managedKey.startsWith("folder:")) {
    return { kind: "rename", managedKey };
  }

  const separator = managedKey.lastIndexOf("|");
  if (separator < 1 || separator === managedKey.length - 1) {
    return null;
  }

  const sourcePath = managedKey.slice(0, separator).trim();
  const rawIndex = managedKey.slice(separator + 1).trim();
  if (!sourcePath || !/^\d+$/.test(rawIndex)) {
    return null;
  }

  const linkIndex = Number.parseInt(rawIndex, 10);
  if (!Number.isInteger(linkIndex) || linkIndex < 0) {
    return null;
  }

  return { kind: "link", managedKey, sourcePath, linkIndex };
}

function toWritebackOperation(
  event: ReverseEvent,
  sourcePath: string,
  linkIndex: number,
  linkHeading: string
): WritebackOperation | null {
  if (event.type === "bookmark_created") {
    return {
      type: "create",
      notePath: sourcePath,
      linkIndex,
      title: event.title,
      url: event.url,
      linkHeading
    };
  }

  if (event.type === "bookmark_updated") {
    return {
      type: "update",
      notePath: sourcePath,
      linkIndex,
      title: event.title,
      url: event.url,
      linkHeading
    };
  }

  if (event.type === "bookmark_deleted") {
    return {
      type: "delete",
      notePath: sourcePath,
      linkIndex,
      linkHeading
    };
  }

  return null;
}

function joinVaultPath(vaultBasePath: string, sourcePath: string): string {
  const base = vaultBasePath.endsWith("/") ? vaultBasePath.slice(0, -1) : vaultBasePath;
  const rel = sourcePath.startsWith("/") ? sourcePath.slice(1) : sourcePath;
  return `${base}/${rel}`;
}
