import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { mkdtempInRepo, TEST_TMP_ROOT } from "./repo-temp-dir.js";

const repoRoot = join(import.meta.dirname, "../..");

describe("in-repo test fixtures", () => {
  it("stays under test/.tmp and never under .ai", () => {
    const dir = mkdtempInRepo("repo-temp-probe-");
    try {
      const rel = relative(repoRoot, dir);
      expect(rel.startsWith(`test${sep}.tmp${sep}`)).toBe(true);
      expect(rel.split(sep)).not.toContain(".ai");
      expect(dir.startsWith(TEST_TMP_ROOT)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets an external-package ESM outfile resolve commander from the repo", () => {
    const dir = mkdtempInRepo("repo-temp-resolve-");
    const probe = join(dir, "probe.mjs");
    writeFileSync(probe, 'import "commander";\n');
    try {
      const result = spawnSync(process.execPath, [probe], { encoding: "utf8" });
      expect(result.status, result.stderr || result.stdout).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
