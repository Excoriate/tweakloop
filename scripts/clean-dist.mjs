import { rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDirectory = join(repositoryRoot, "dist");

if (dirname(outputDirectory) !== repositoryRoot || basename(outputDirectory) !== "dist") {
  throw new Error(`refusing to clean unexpected output path: ${outputDirectory}`);
}

rmSync(outputDirectory, { recursive: true, force: true });
