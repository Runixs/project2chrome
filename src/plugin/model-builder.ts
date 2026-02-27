import type { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { extractBookmarkNameFromFrontmatter } from "./frontmatter";
import { hasHeadingSource, parseLinksFromHeading } from "./link-parser";
import type { DesiredFolder, LinkItem } from "./types";

export async function buildDesiredTree(
  vault: Vault,
  targetFolderPath: string,
  heading: string,
  useFolderNotesPlugin: boolean
): Promise<DesiredFolder[]> {
  const target = vault.getAbstractFileByPath(targetFolderPath);
  if (!isVaultFolder(target)) {
    return [];
  }

  const roots: DesiredFolder[] = [];

  for (const child of target.children) {
    if (isVaultFolder(child)) {
      const folderNode = await buildFolder(vault, child, heading, useFolderNotesPlugin);
      if (folderNode) {
        roots.push(folderNode);
      }
      continue;
    }
    if (isMarkdownFile(child)) {
      const noteNode = await buildNoteFolder(vault, child, heading);
      if (noteNode) {
        roots.push(noteNode);
      }
    }
  }

  return roots;
}

async function buildFolder(vault: Vault, folder: TFolder, heading: string, useFolderNotesPlugin: boolean): Promise<DesiredFolder | null> {
  const children: DesiredFolder[] = [];
  let links: LinkItem[] = [];
  let folderName = folder.name;
  let hasFolderNoteSource = false;

  for (const child of folder.children) {
    if (isVaultFolder(child)) {
      const childFolder = await buildFolder(vault, child, heading, useFolderNotesPlugin);
      if (childFolder) {
        children.push(childFolder);
      }
      continue;
    }

    if (isMarkdownFile(child)) {
      if (useFolderNotesPlugin && isFolderNoteFile(child, folder)) {
        const content = await vault.read(child);
        if (hasHeadingSource(content, heading)) {
          links = parseLinksFromHeading(content, heading, child.path);
          folderName = extractBookmarkNameFromFrontmatter(content) ?? folder.name;
          hasFolderNoteSource = true;
        }
        continue;
      }
      const noteNode = await buildNoteFolder(vault, child, heading);
      if (noteNode) {
        children.push(noteNode);
      }
    }
  }

  if (children.length === 0 && links.length === 0 && !hasFolderNoteSource) {
    return null;
  }

  return {
    key: `folder:${folder.path}`,
    path: folder.path,
    name: folderName,
    children,
    links
  };
}

async function buildNoteFolder(vault: Vault, noteFile: TFile, heading: string): Promise<DesiredFolder | null> {
  const content = await vault.read(noteFile);
  if (!hasHeadingSource(content, heading)) {
    return null;
  }
  const links = parseLinksFromHeading(content, heading, noteFile.path);
  const bookmarkName = extractBookmarkNameFromFrontmatter(content);

  return {
    key: `note:${noteFile.path}`,
    path: noteFile.path,
    name: bookmarkName ?? noteFile.basename,
    children: [],
    links
  };
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
  return isVaultFile(file) && file.extension.toLowerCase() === "md";
}

function isVaultFolder(file: TAbstractFile | null | undefined): file is TFolder {
  if (!file || typeof file !== "object") {
    return false;
  }

  const candidate = file as { children?: unknown };
  return Array.isArray(candidate.children);
}

function isVaultFile(file: TAbstractFile | null | undefined): file is TFile {
  if (!file || typeof file !== "object") {
    return false;
  }

  const candidate = file as { extension?: unknown };
  return typeof candidate.extension === "string";
}

function isFolderNoteFile(file: TFile, folder: TFolder): boolean {
  return normalizeName(file.basename) === normalizeName(folder.name);
}

function normalizeName(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}
