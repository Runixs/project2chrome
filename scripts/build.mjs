import { build } from "esbuild";
import { mkdir, cp } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outdir = path.join(root, "dist", "plugin");
const extensionOutdir = path.join(root, "dist", "extension");

await mkdir(outdir, { recursive: true });
await mkdir(extensionOutdir, { recursive: true });

await build({
  entryPoints: [path.join(root, "src", "plugin", "main.ts")],
  outfile: path.join(outdir, "main.js"),
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcemap: false,
  target: "node20",
  external: ["obsidian"]
});

await cp(path.join(root, "src", "plugin", "manifest.json"), path.join(outdir, "manifest.json"));
await cp(path.join(root, "src", "extension", "manifest.json"), path.join(extensionOutdir, "manifest.json"));
await cp(path.join(root, "src", "extension", "background.js"), path.join(extensionOutdir, "background.js"));
await cp(path.join(root, "src", "extension", "popup.html"), path.join(extensionOutdir, "popup.html"));
await cp(path.join(root, "src", "extension", "popup.js"), path.join(extensionOutdir, "popup.js"));
