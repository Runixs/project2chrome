import type { TAbstractFile, Vault } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { parseLinksFromHeading } from "./link-parser";
import type { DesiredFolder } from "./types";

export async function buildDesiredTree(vault: Vault, targetFolderPath: string, heading: string): Promise<DesiredFolder[]> {
  const target = vault.getAbstractFileByPath(targetFolderPath);
  if (!(target instanceof TFolder)) {
    return [];
  }

  const roots: DesiredFolder[] = [];

  for (const child of target.children) {
    if (child instanceof TFolder) {
      roots.push(await buildFolder(vault, child, heading));
    }
  }

  return roots;
}

async function buildFolder(vault: Vault, folder: TFolder, heading: string): Promise<DesiredFolder> {
  const children: DesiredFolder[] = [];
  const linksByUrl = new Map<string, { title: string; key: string; url: string }>();

  for (const child of folder.children) {
    if (child instanceof TFolder) {
      children.push(await buildFolder(vault, child, heading));
      continue;
    }

    if (isMarkdownFile(child)) {
      const content = await vault.read(child);
      const links = parseLinksFromHeading(content, heading, child.path);
      for (const link of links) {
        if (!linksByUrl.has(link.url)) {
          linksByUrl.set(link.url, link);
        }
      }
    }
  }

  return {
    key: `folder:${folder.path}`,
    path: folder.path,
    name: folder.name,
    children,
    links: [...linksByUrl.values()].map((l) => ({ title: l.title, url: l.url, key: l.key }))
  };
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "md";
}
