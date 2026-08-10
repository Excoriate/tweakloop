import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const artifactRoot = join(repositoryRoot, "web", "artifact");
const sourceRoot = join(artifactRoot, "src");
const assetsRoot = join(artifactRoot, "assets");
const packageAssets = join(
  repositoryRoot,
  "node_modules",
  "@excalidraw",
  "excalidraw",
  "dist",
  "prod",
);

if (!assetsRoot.startsWith(`${artifactRoot}/`)) {
  throw new Error(`Refusing to clean unexpected whiteboard output path: ${assetsRoot}`);
}

await rm(assetsRoot, { recursive: true, force: true });
await mkdir(assetsRoot, { recursive: true });

await build({
  entryPoints: [join(sourceRoot, "whiteboard-loader.js")],
  outfile: join(artifactRoot, "whiteboard.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  target: ["chrome120", "safari17", "firefox120"],
  conditions: ["production"],
  minify: true,
  legalComments: "none",
});

await build({
  entryPoints: { runtime: join(sourceRoot, "whiteboard-runtime.jsx") },
  outdir: assetsRoot,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  target: ["chrome120", "safari17", "firefox120"],
  conditions: ["production"],
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  assetNames: "generated/[name]-[hash]",
  loader: { ".woff2": "file" },
  minify: true,
  legalComments: "none",
});

await cp(join(packageAssets, "fonts"), join(assetsRoot, "fonts"), { recursive: true });
await cp(join(packageAssets, "locales"), join(assetsRoot, "locales"), { recursive: true });

async function sizeTree(root) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = await sizeTree(entryPath);
      bytes += nested.bytes;
      files += nested.files;
    } else {
      bytes += (await stat(entryPath)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

const loaderBytes = (await stat(join(artifactRoot, "whiteboard.js"))).size;
const runtimeBytes = (await stat(join(assetsRoot, "runtime.js"))).size;
const cssBytes = (await stat(join(assetsRoot, "runtime.css"))).size;
const distribution = await sizeTree(assetsRoot);
process.stdout.write(
  `${JSON.stringify({ loaderBytes, runtimeBytes, cssBytes, distributionBytes: distribution.bytes, distributionFiles: distribution.files })}\n`,
);
