import { build } from "esbuild";
import { mkdir, cp } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const outdir = path.join(root, "dist", "plugin");

await mkdir(outdir, { recursive: true });

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
