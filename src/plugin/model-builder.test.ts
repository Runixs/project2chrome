import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TAbstractFile, TFile, TFolder, Vault } from "obsidian";
import { buildDesiredTree } from "./model-builder";

describe("buildDesiredTree", () => {
  it("excludes non-markdown-only folders and includes note nodes only when heading has markdown links", async () => {
    const alphaNote = createFile("1_Projects/Alpha/alpha.md");
    const alphaCanvas = createFile("1_Projects/Alpha/board.canvas");
    const alphaFolder = createFolder("1_Projects/Alpha", "Alpha", [alphaNote, alphaCanvas]);

    const canvasOnly = createFolder("1_Projects/CanvasOnly", "CanvasOnly", [createFile("1_Projects/CanvasOnly/view.canvas")]);

    const rootWithHeading = createFile("1_Projects/with-heading.md");
    const rootWithHeadingNoLinks = createFile("1_Projects/with-heading-no-links.md");
    const rootWithoutHeading = createFile("1_Projects/without-heading.md");
    const target = createFolder("1_Projects", "1_Projects", [
      alphaFolder,
      canvasOnly,
      rootWithHeading,
      rootWithHeadingNoLinks,
      rootWithoutHeading
    ]);

    const vault = createVault(target, {
      "1_Projects/Alpha/alpha.md": "### Link\n- [Alpha](https://alpha.example)",
      "1_Projects/with-heading.md": "### Link\n- [Root](https://root.example)",
      "1_Projects/with-heading-no-links.md": "### Link\n- plain text only",
      "1_Projects/without-heading.md": "# Doc\n- [Ignored](https://ignored.example)"
    });

    const desired = await buildDesiredTree(vault, "1_Projects", "Link", false);

    assert.deepEqual(
      desired.map((node) => node.key),
      ["folder:1_Projects/Alpha", "note:1_Projects/with-heading.md"]
    );
    assert.deepEqual(desired[0]?.children.map((node) => node.key), ["note:1_Projects/Alpha/alpha.md"]);
  });

  it("excludes folder-note-only folders when heading has zero links", async () => {
    const gammaFolderNote = createFile("1_Projects/Gamma/Gamma.md");
    const gammaFolder = createFolder("1_Projects/Gamma", "Gamma", [gammaFolderNote]);

    const betaFolderNote = createFile("1_Projects/Beta/Beta.md");
    const betaCanvas = createFile("1_Projects/Beta/board.canvas");
    const betaFolder = createFolder("1_Projects/Beta", "Beta", [betaFolderNote, betaCanvas]);

    const target = createFolder("1_Projects", "1_Projects", [gammaFolder, betaFolder]);

    const vault = createVault(target, {
      "1_Projects/Gamma/Gamma.md": "---\nbookmark_name: Renamed Gamma\n---\n### Link\n",
      "1_Projects/Beta/Beta.md": "---\nbookmark_name: Renamed Beta\n---\n# Notes"
    });

    const desired = await buildDesiredTree(vault, "1_Projects", "Link", true);

    assert.equal(desired.length, 0);
  });
});

function createVault(target: TFolder, contentByPath: Record<string, string>): Vault {
  const content = new Map<string, string>(Object.entries(contentByPath));
  return {
    getAbstractFileByPath(path: string) {
      return path === target.path ? target : null;
    },
    read(file: TFile) {
      return Promise.resolve(content.get(file.path) ?? "");
    }
  } as Vault;
}

function createFolder(path: string, name: string, children: Array<TFolder | TFile>): TFolder {
  return {
    path,
    name,
    children: children as TAbstractFile[]
  } as unknown as TFolder;
}

function createFile(path: string): TFile {
  const filename = path.split("/").at(-1) ?? "";
  const dot = filename.lastIndexOf(".");
  const basename = dot >= 0 ? filename.slice(0, dot) : filename;
  const extension = dot >= 0 ? filename.slice(dot + 1) : "";

  return {
    path,
    basename,
    extension
  } as unknown as TFile;
}
