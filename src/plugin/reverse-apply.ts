import type { ApplyHook } from "./bridge-handler";
import { extractBookmarkNameFromFrontmatter } from "./frontmatter";
import { processFolderRename } from "./folder-rename-writeback";
import { parseLinksFromHeading } from "./link-parser";
import type { EventAck, ReverseEvent } from "./reverse-sync-types";
import { applyWriteback, type WritebackOperation } from "./writeback-engine";
import { checkAmbiguity, validateManagedKey, type ManagedKeySet } from "./reverse-guardrails";

export type ReverseApplyContext = {
  vaultBasePath: string;
  linkHeading: string;
  readFile: (path: string) => string | null;
  writeFile: (path: string, content: string) => void;
  knownKeys?: ManagedKeySet;
};

type ManagedKeyResolution =
  | { kind: "rename"; managedKey: string }
  | { kind: "parent"; managedKey: string; parentKind: "note" | "folder"; parentPath: string }
  | { kind: "link"; managedKey: string; sourcePath: string; linkIndex: number };

type ParentCreateTargetResult =
  | { ok: true; sourcePath: string; existingContent: string; linkIndex: number; resolvedKey: string }
  | { ok: false; reason: string };

export function applyReverseEvent(event: ReverseEvent, ctx: ReverseApplyContext): EventAck {
  const managedKey = event.managedKey?.trim();
  if (!managedKey) {
    return { eventId: event.eventId, status: "skipped_unmanaged", reason: "unrecognized_key" };
  }

  if (ctx.knownKeys) {
    const guardrailResult = validateManagedKey(managedKey, ctx.knownKeys);
    if (!guardrailResult.eligible) {
      return {
        eventId: event.eventId,
        status: "skipped_unmanaged",
        reason: guardrailResult.reason ?? "skipped_unmanaged"
      };
    }
  }

  const key = resolveManagedKey(managedKey, event.type);
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

  if (key.kind === "parent") {
    if (event.type !== "bookmark_created") {
      return {
        eventId: event.eventId,
        status: "skipped_ambiguous",
        reason: "parent_key_requires_create"
      };
    }

    const targetResult = resolveParentCreateTarget(key, ctx);
    if (!targetResult.ok) {
      return {
        eventId: event.eventId,
        status: "skipped_ambiguous",
        reason: targetResult.reason
      };
    }

    const writeResult = applyWriteback(targetResult.existingContent, {
      type: "create",
      notePath: targetResult.sourcePath,
      linkIndex: targetResult.linkIndex,
      title: event.title,
      url: event.url,
      linkHeading: ctx.linkHeading
    });

    if (!writeResult.success || writeResult.newContent === undefined) {
      return {
        eventId: event.eventId,
        status: "skipped_ambiguous",
        reason: writeResult.reason ?? "writeback_failed"
      };
    }

    const parentTargetPath = joinVaultPath(ctx.vaultBasePath, targetResult.sourcePath);
    ctx.writeFile(parentTargetPath, writeResult.newContent);
    return {
      eventId: event.eventId,
      status: "applied",
      resolvedPath: parentTargetPath,
      resolvedKey: targetResult.resolvedKey
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

  if (ctx.knownKeys) {
    const ambiguityResult = checkAmbiguity(managedKey, existingContent, ctx.linkHeading);
    if (!ambiguityResult.eligible) {
      return {
        eventId: event.eventId,
        status: "skipped_ambiguous",
        reason: ambiguityResult.reason ?? "skipped_ambiguous"
      };
    }
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

function resolveManagedKey(managedKey: string, eventType: ReverseEvent["type"]): ManagedKeyResolution | null {
  if (managedKey.startsWith("note:")) {
    const parentPath = managedKey.slice("note:".length).trim();
    if (!parentPath) {
      return null;
    }
    if (eventType === "folder_renamed") {
      return { kind: "rename", managedKey };
    }
    return { kind: "parent", managedKey, parentKind: "note", parentPath };
  }

  if (managedKey.startsWith("folder:")) {
    const parentPath = managedKey.slice("folder:".length).trim();
    if (!parentPath) {
      return null;
    }
    if (eventType === "folder_renamed") {
      return { kind: "rename", managedKey };
    }
    return { kind: "parent", managedKey, parentKind: "folder", parentPath };
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

function resolveParentCreateTarget(
  key: Extract<ManagedKeyResolution, { kind: "parent" }>,
  ctx: ReverseApplyContext
): ParentCreateTargetResult {
  if (key.parentKind === "note") {
    return resolveCreateTargetForSourcePath(key.parentPath, ctx);
  }

  const folderPath = trimRelativePath(key.parentPath);
  if (!folderPath) {
    return { ok: false, reason: "folder_parent_missing" };
  }

  const directCandidates = collectFolderDirectCandidates(folderPath);
  const directResolved = resolveSingleExistingNotePath(directCandidates, ctx);
  if (directResolved.length === 1) {
    const onlyDirect = directResolved[0];
    if (onlyDirect) {
      return resolveCreateTargetForSourcePath(onlyDirect, ctx);
    }
  }
  if (directResolved.length > 1) {
    return { ok: false, reason: "folder_parent_ambiguous" };
  }

  const fallbackCandidates = collectBookmarkNameMatches(folderPath, ctx);
  if (fallbackCandidates.length === 1) {
    const onlyFallback = fallbackCandidates[0];
    if (onlyFallback) {
      return resolveCreateTargetForSourcePath(onlyFallback, ctx);
    }
  }
  if (fallbackCandidates.length > 1) {
    return { ok: false, reason: "folder_parent_ambiguous" };
  }

  return { ok: false, reason: "folder_parent_note_not_found" };
}

function resolveCreateTargetForSourcePath(sourcePath: string, ctx: ReverseApplyContext): ParentCreateTargetResult {
  const normalizedSourcePath = trimRelativePath(sourcePath);
  if (!normalizedSourcePath) {
    return { ok: false, reason: "source_path_invalid" };
  }

  const targetPath = joinVaultPath(ctx.vaultBasePath, normalizedSourcePath);
  const existingContent = ctx.readFile(targetPath);
  if (existingContent === null) {
    return { ok: false, reason: "file_not_found" };
  }

  const linkIndex = parseLinksFromHeading(existingContent, ctx.linkHeading, normalizedSourcePath).length;
  return {
    ok: true,
    sourcePath: normalizedSourcePath,
    existingContent,
    linkIndex,
    resolvedKey: `${normalizedSourcePath}|${String(linkIndex)}`
  };
}

function collectFolderDirectCandidates(folderPath: string): string[] {
  const normalizedFolderPath = trimRelativePath(folderPath);
  if (!normalizedFolderPath) {
    return [];
  }

  const folderName = getLastPathSegment(normalizedFolderPath);
  const seen = new Set<string>();
  const out: string[] = [];

  const push = (candidate: string): void => {
    const normalizedCandidate = trimRelativePath(candidate);
    if (!normalizedCandidate || seen.has(normalizedCandidate)) {
      return;
    }
    seen.add(normalizedCandidate);
    out.push(normalizedCandidate);
  };

  push(`${normalizedFolderPath}.md`);
  if (folderName) {
    push(`${normalizedFolderPath}/${folderName}.md`);
  }

  return out;
}

function resolveSingleExistingNotePath(candidates: string[], ctx: ReverseApplyContext): string[] {
  const existing: string[] = [];
  for (const sourcePath of candidates) {
    const absolute = joinVaultPath(ctx.vaultBasePath, sourcePath);
    if (ctx.readFile(absolute) !== null) {
      existing.push(sourcePath);
    }
  }
  return existing;
}

function collectBookmarkNameMatches(folderPath: string, ctx: ReverseApplyContext): string[] {
  if (!ctx.knownKeys) {
    return [];
  }

  const folderName = getLastPathSegment(folderPath).toLowerCase();
  if (!folderName) {
    return [];
  }

  const matches: string[] = [];
  for (const notePath of ctx.knownKeys.managedNotePaths) {
    const normalizedNotePath = trimRelativePath(notePath);
    if (!normalizedNotePath) {
      continue;
    }

    const absolute = joinVaultPath(ctx.vaultBasePath, normalizedNotePath);
    const content = ctx.readFile(absolute);
    if (content === null) {
      continue;
    }

    const bookmarkName = extractBookmarkNameFromFrontmatter(content);
    if (bookmarkName && bookmarkName.trim().toLowerCase() === folderName) {
      matches.push(normalizedNotePath);
    }
  }

  return uniqueStrings(matches);
}

function trimRelativePath(value: string): string {
  return value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

function getLastPathSegment(value: string): string {
  const normalized = trimRelativePath(value);
  if (!normalized) {
    return "";
  }
  const parts = normalized.split("/");
  const segment = parts[parts.length - 1];
  return segment ? segment.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push(value);
  }
  return out;
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
