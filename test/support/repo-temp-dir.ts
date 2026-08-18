import { mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../..");

/** Gitignored in-repo fixture root. CLI tests bundle with `packages: "external"`;
 * Node ESM resolution walks from the outfile, so `/tmp` cannot see `node_modules`.
 * `.ai/` is a local harness and is never a test fixture root. */
export const TEST_TMP_ROOT = join(repoRoot, "test", ".tmp");

export function mkdtempInRepo(prefix: string): string {
  mkdirSync(TEST_TMP_ROOT, { recursive: true });
  return mkdtempSync(join(TEST_TMP_ROOT, prefix));
}
