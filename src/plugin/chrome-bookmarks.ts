import { createHash } from "node:crypto";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DesiredFolder, Project2ChromeSettings } from "./types";

type BookmarkNode = {
  id: string;
  name: string;
  type: "url" | "folder";
  url?: string;
  children?: BookmarkNode[];
  date_added?: string;
  date_modified?: string;
};

type BookmarksData = {
  checksum?: string;
  checksum_sha256?: string;
  roots: {
    bookmark_bar: BookmarkNode;
    other?: BookmarkNode;
    synced?: BookmarkNode;
  };
};

const WINDOWS_EPOCH_OFFSET_MICROS = 11644473600000000n;

export async function syncIntoChromeBookmarks(
  folders: DesiredFolder[],
  settings: Project2ChromeSettings,
  options: { rootFolderName: string; ensureRoot: boolean }
): Promise<{ managedFolderIds: Record<string, string>; managedBookmarkIds: Record<string, string> }> {
  const configuredPath = resolveBookmarksPathForCurrentOs(settings);
  const bookmarkPath = normalizeBookmarksPath(configuredPath);
  await assertBookmarksFileAccessible(bookmarkPath, configuredPath);

  const raw = await readFile(bookmarkPath, "utf8");
  const data = parseBookmarksJson(raw, bookmarkPath);

  const bookmarkBar = data.roots.bookmark_bar;
  if (!bookmarkBar.children) {
    bookmarkBar.children = [];
  }

  const nextId = makeIdAllocator(data);
  const desiredFolderKeys = new Set<string>();
  const desiredBookmarkKeys = new Set<string>();
  const desiredBookmarkUrls = new Set<string>();
  const managedFolderIds: Record<string, string> = {};
  const managedBookmarkIds: Record<string, string> = {};

  const rootKey = "__root__";
  const oldRootId = settings.state.managedFolderIds[rootKey];
  const rootFolder = options.ensureRoot
    ? findFolderForKey(bookmarkBar, options.rootFolderName, oldRootId) ?? createFolder(options.rootFolderName, nextId())
    : null;

  if (rootFolder && !bookmarkBar.children.some((child) => child.id === rootFolder.id)) {
    bookmarkBar.children.push(rootFolder);
  }

  if (rootFolder) {
    rootFolder.name = options.rootFolderName;
    rootFolder.date_modified = nowChromeMicros();
    managedFolderIds[rootKey] = rootFolder.id;
    desiredFolderKeys.add(rootKey);
  }

  for (const folder of folders) {
    if (!rootFolder) {
      break;
    }
    applyFolder(
      folder,
      rootFolder,
      settings.state.managedFolderIds,
      settings.state.managedBookmarkIds,
      managedFolderIds,
      managedBookmarkIds,
      desiredFolderKeys,
      desiredBookmarkKeys,
      desiredBookmarkUrls,
      nextId
    );
  }

  const activeManagedBookmarkIds = new Set(Object.values(managedBookmarkIds));
  const activeManagedFolderIds = new Set(Object.values(managedFolderIds));

  pruneObsoleteIds(bookmarkBar, settings.state.managedBookmarkIds, desiredBookmarkKeys, {
    protectedIds: activeManagedBookmarkIds,
    removeByKey: rootFolder
      ? (key) => removeObsoleteBookmarkByKey(rootFolder, key, desiredBookmarkUrls, activeManagedBookmarkIds)
      : undefined
  });
  pruneObsoleteIds(bookmarkBar, settings.state.managedFolderIds, desiredFolderKeys, {
    protectedIds: activeManagedFolderIds
  });

  const now = nowChromeMicros();
  bookmarkBar.date_modified = now;

  data.checksum = computeMd5Checksum(data);
  data.checksum_sha256 = computeSha256Checksum(data);

  const tmpPath = `${bookmarkPath}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(tmpPath, bookmarkPath);
  } catch (error) {
    const details = formatFsError(error);
    if (details.code === "EACCES" || details.code === "EPERM" || details.code === "EBUSY") {
      throw new Error(
        `Cannot write Chrome Bookmarks file at ${bookmarkPath}. Close Chrome and try again. (${details.message})`
      );
    }
    throw new Error(`Failed to write Chrome Bookmarks file at ${bookmarkPath}. (${details.message})`);
  }

  return { managedFolderIds, managedBookmarkIds };
}

function applyFolder(
  desired: DesiredFolder,
  parent: BookmarkNode,
  oldFolderIds: Record<string, string>,
  oldBookmarkIds: Record<string, string>,
  managedFolderIds: Record<string, string>,
  managedBookmarkIds: Record<string, string>,
  desiredFolderKeys: Set<string>,
  desiredBookmarkKeys: Set<string>,
  desiredBookmarkUrls: Set<string>,
  nextId: () => string
): void {
  if (!parent.children) {
    parent.children = [];
  }

  const existing = findFolderForKey(parent, desired.name, oldFolderIds[desired.key]);
  const folderNode = existing ?? createFolder(desired.name, nextId());
  if (!existing) {
    parent.children.push(folderNode);
  }

  folderNode.name = desired.name;
  folderNode.date_modified = nowChromeMicros();
  if (!folderNode.children) {
    folderNode.children = [];
  }

  managedFolderIds[desired.key] = folderNode.id;
  desiredFolderKeys.add(desired.key);

  for (const link of desired.links) {
    const oldId = oldBookmarkIds[link.key];
    const existingLink = findUrlForKey(folderNode, link.url, oldId);
    const urlNode = existingLink ?? createUrl(link.title, link.url, nextId());
    if (!existingLink) {
      folderNode.children.push(urlNode);
    }
    urlNode.name = link.title;
    urlNode.url = link.url;
    managedBookmarkIds[link.key] = urlNode.id;
    desiredBookmarkKeys.add(link.key);
    desiredBookmarkUrls.add(link.url);
  }

  for (const child of desired.children) {
    applyFolder(
      child,
      folderNode,
      oldFolderIds,
      oldBookmarkIds,
      managedFolderIds,
      managedBookmarkIds,
      desiredFolderKeys,
      desiredBookmarkKeys,
      desiredBookmarkUrls,
      nextId
    );
  }
}

function pruneObsoleteIds(
  root: BookmarkNode,
  oldMap: Record<string, string>,
  stillDesired: Set<string>,
  options?: {
    protectedIds?: Set<string>;
    removeByKey?: (key: string) => boolean;
  }
): void {
  for (const [key, id] of Object.entries(oldMap)) {
    if (stillDesired.has(key)) {
      continue;
    }

    if (options?.protectedIds?.has(id)) {
      continue;
    }

    const removedById = removeById(root, id);
    if (!removedById) {
      options?.removeByKey?.(key);
    }
  }
}

function removeById(node: BookmarkNode, id: string): boolean {
  if (!node.children) {
    return false;
  }

  const idx = node.children.findIndex((c) => c.id === id);
  if (idx >= 0) {
    node.children.splice(idx, 1);
    return true;
  }

  return node.children.some((c) => removeById(c, id));
}

function removeObsoleteBookmarkByKey(
  root: BookmarkNode,
  key: string,
  desiredBookmarkUrls: Set<string>,
  protectedIds: Set<string>
): boolean {
  const url = parseBookmarkUrlFromManagedKey(key);
  if (!url || desiredBookmarkUrls.has(url)) {
    return false;
  }
  return removeFirstUrl(root, url, protectedIds);
}

function parseBookmarkUrlFromManagedKey(key: string): string | null {
  const separator = key.indexOf("|");
  if (separator < 0) {
    return null;
  }
  const url = key.slice(separator + 1);
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return null;
  }
  return url;
}

function removeFirstUrl(node: BookmarkNode, url: string, protectedIds: Set<string>): boolean {
  if (!node.children) {
    return false;
  }

  const idx = node.children.findIndex(
    (child) => child.type === "url" && child.url === url && !protectedIds.has(child.id)
  );
  if (idx >= 0) {
    node.children.splice(idx, 1);
    return true;
  }

  return node.children.some((child) => removeFirstUrl(child, url, protectedIds));
}

function findFolderForKey(parent: BookmarkNode, name: string, preferredId?: string): BookmarkNode | undefined {
  const children = parent.children ?? [];
  if (preferredId) {
    const byId = children.find((n) => n.id === preferredId && n.type === "folder");
    if (byId) {
      return byId;
    }
  }
  return children.find((n) => n.type === "folder" && n.name === name);
}

function findUrlForKey(parent: BookmarkNode, url: string, preferredId?: string): BookmarkNode | undefined {
  const children = parent.children ?? [];
  if (preferredId) {
    const byId = children.find((n) => n.id === preferredId && n.type === "url");
    if (byId) {
      return byId;
    }
  }
  return children.find((n) => n.type === "url" && n.url === url);
}

function createFolder(name: string, id: string): BookmarkNode {
  const now = nowChromeMicros();
  return { id, type: "folder", name, children: [], date_added: now, date_modified: now };
}

function createUrl(name: string, url: string, id: string): BookmarkNode {
  return { id, type: "url", name, url, date_added: nowChromeMicros() };
}

function makeIdAllocator(data: BookmarksData): () => string {
  let maxId = 0;

  const visit = (node: BookmarkNode): void => {
    const parsed = Number.parseInt(node.id, 10);
    if (Number.isFinite(parsed) && parsed > maxId) {
      maxId = parsed;
    }
    for (const child of node.children ?? []) {
      visit(child);
    }
  };

  visit(data.roots.bookmark_bar);
  if (data.roots.other) {
    visit(data.roots.other);
  }
  if (data.roots.synced) {
    visit(data.roots.synced);
  }

  return () => String(++maxId);
}

function computeMd5Checksum(data: BookmarksData): string {
  return computeChecksum(data, "md5");
}

function computeSha256Checksum(data: BookmarksData): string {
  return computeChecksum(data, "sha256");
}

function computeChecksum(data: BookmarksData, algo: "md5" | "sha256"): string {
  const hash = createHash(algo);

  const updateString = (value: string): void => {
    hash.update(value, "utf8");
  };

  const updateTitle = (value: string): void => {
    hash.update(Buffer.from(value, "utf16le"));
  };

  const walk = (node: BookmarkNode): void => {
    updateString(node.id);
    updateTitle(node.name);
    updateString(node.type);
    if (node.type === "url" && node.url) {
      updateString(node.url);
      return;
    }
    for (const child of node.children ?? []) {
      walk(child);
    }
  };

  walk(data.roots.bookmark_bar);
  if (data.roots.other) {
    walk(data.roots.other);
  }
  if (data.roots.synced) {
    walk(data.roots.synced);
  }

  return hash.digest("hex");
}

function nowChromeMicros(): string {
  const micros = BigInt(Date.now()) * 1000n + WINDOWS_EPOCH_OFFSET_MICROS;
  return micros.toString();
}

export function normalizeBookmarksPath(input: string): string {
  const trimmed = trimMatchingQuotes(input.trim());
  const expandedEnv = expandPercentEnvVars(trimmed);
  const expandedHome = expandHome(expandedEnv);
  const unifiedSeparators = expandedHome.replace(/[\\/]+/g, path.sep);
  return path.normalize(unifiedSeparators);
}

function trimMatchingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function expandPercentEnvVars(input: string): string {
  return input.replace(/%([^%]+)%/g, (_, name: string) => {
    const key = name.trim();
    return process.env[key] ?? process.env[key.toUpperCase()] ?? process.env[key.toLowerCase()] ?? `%${name}%`;
  });
}

function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (!input.startsWith("~/") && !input.startsWith("~\\")) {
    return input;
  }
  const rest = input.slice(2).replace(/[\\/]+/g, path.sep);
  return path.join(os.homedir(), rest);
}

function assertBookmarksFileAccessible(resolvedPath: string, configuredPath: string): Promise<void> {
  return access(resolvedPath).catch((error: unknown) => {
    const details = formatFsError(error);
    throw new Error(
      `Chrome Bookmarks file is not accessible. configured=${configuredPath}, resolved=${resolvedPath}. (${details.message})`
    );
  });
}

function parseBookmarksJson(raw: string, bookmarkPath: string): BookmarksData {
  try {
    return JSON.parse(raw) as BookmarksData;
  } catch (error) {
    const details = formatFsError(error);
    throw new Error(`Chrome Bookmarks file is not valid JSON at ${bookmarkPath}. (${details.message})`);
  }
}

function formatFsError(error: unknown): { code: string | undefined; message: string } {
  if (error instanceof Error) {
    const withCode = error as NodeJS.ErrnoException;
    return { code: withCode.code, message: error.message };
  }
  return { code: undefined, message: String(error) };
}

function resolveBookmarksPathForCurrentOs(settings: Project2ChromeSettings): string {
  if (process.platform === "darwin") {
    return settings.chromeBookmarksFileByOs.macos;
  }
  if (process.platform === "linux") {
    return settings.chromeBookmarksFileByOs.linux;
  }
  return settings.chromeBookmarksFileByOs.windows;
}
