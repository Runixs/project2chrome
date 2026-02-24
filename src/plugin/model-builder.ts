import type { TAbstractFile, Vault } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { parseLinksFromHeading } from "./link-parser";
import type { DesiredFolder, LinkItem } from "./types";

export async function buildDesiredTree(
  vault: Vault,
  targetFolderPath: string,
  heading: string,
  useFolderNotesPlugin: boolean
): Promise<DesiredFolder[]> {
  const target = vault.getAbstractFileByPath(targetFolderPath);
  if (!(target instanceof TFolder)) {
    return [];
  }

  const roots: DesiredFolder[] = [];

  for (const child of target.children) {
    if (child instanceof TFolder) {
      roots.push(await buildFolder(vault, child, heading, useFolderNotesPlugin));
      continue;
    }
    if (isMarkdownFile(child)) {
      roots.push(await buildNoteFolder(vault, child, heading));
    }
  }

  return roots;
}

async function buildFolder(vault: Vault, folder: TFolder, heading: string, useFolderNotesPlugin: boolean): Promise<DesiredFolder> {
  const children: DesiredFolder[] = [];
  let links: LinkItem[] = [];

  for (const child of folder.children) {
    if (child instanceof TFolder) {
      children.push(await buildFolder(vault, child, heading, useFolderNotesPlugin));
      continue;
    }

    if (isMarkdownFile(child)) {
      if (useFolderNotesPlugin && isFolderNoteFile(child, folder)) {
        const content = await vault.read(child);
        links = parseLinksFromHeading(content, heading, child.path);
        continue;
      }
      children.push(await buildNoteFolder(vault, child, heading));
    }
  }

  return {
    key: `folder:${folder.path}`,
    path: folder.path,
    name: folder.name,
    children,
    links
  };
}

async function buildNoteFolder(vault: Vault, noteFile: TFile, heading: string): Promise<DesiredFolder> {
  const content = await vault.read(noteFile);
  const links = parseLinksFromHeading(content, heading, noteFile.path);

  return {
    key: `note:${noteFile.path}`,
    path: noteFile.path,
    name: noteFile.basename,
    children: [],
    links
  };
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "md";
}

function isFolderNoteFile(file: TFile, folder: TFolder): boolean {
  return normalizeName(file.basename) === normalizeName(folder.name);
}

function normalizeName(value: string): string {
  return value.normalize("NFC").trim().toLowerCase();
}
