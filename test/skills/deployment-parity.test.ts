import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const canonicalSkillsRoot = join(root, ".agents", "skills");
const canonicalHooksRoot = join(root, ".agents", "hooks", "v2");
const skillNames = readdirSync(canonicalSkillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

function listRelativeFiles(rootDirectory: string, directory = rootDirectory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    return entry.isDirectory()
      ? listRelativeFiles(rootDirectory, fullPath)
      : [relative(rootDirectory, fullPath)];
  });
}

describe("portable OSS agent skill deployment", () => {
  test("keeps the public test runner on a positive repository-owned root", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const vitestConfig = readFileSync(join(root, "vitest.config.ts"), "utf8");

    expect(packageJson.scripts.test).toBe("vitest run");
    expect(packageJson.scripts["test:watch"]).toBe("vitest");
    expect(vitestConfig).toContain('include: ["test/**/*.test.ts"]');
  });

  test.each(skillNames)("projects canonical %s bytes into both current consumers", (skill) => {
    const canonicalRoot = join(root, ".agents", "skills", skill);
    const canonicalFiles = listRelativeFiles(canonicalRoot).sort();

    for (const consumer of ["skills", join(".claude", "skills")]) {
      const consumerRoot = join(root, consumer, skill);
      expect(listRelativeFiles(consumerRoot).sort()).toEqual(canonicalFiles);
      for (const file of canonicalFiles) {
        expect(readFileSync(join(consumerRoot, file)), `${consumer}/${skill}/${file}`).toEqual(
          readFileSync(join(canonicalRoot, file)),
        );
      }
    }
  });

  test("ships every canonical skill projection in the npm artifact", () => {
    const result = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
        cwd: root,
        encoding: "utf8",
      }),
    ) as Array<{ files: Array<{ path: string }> }>;
    const packedPaths = new Set(result[0]?.files.map((file) => file.path));

    for (const skill of skillNames) {
      for (const file of listRelativeFiles(join(root, ".agents", "skills", skill))) {
        expect(
          packedPaths.has(`skills/${skill}/${file}`),
          `npm package omits ${skill}/${file}`,
        ).toBe(true);
      }
    }

    const publicHookFiles = listRelativeFiles(canonicalHooksRoot);
    expect(publicHookFiles.length).toBeGreaterThan(0);
    for (const file of publicHookFiles) {
      expect(packedPaths.has(`hooks/v2/${file}`), `npm package omits hooks/v2/${file}`).toBe(true);
    }
    for (const path of packedPaths) {
      expect(path).not.toMatch(/^\.agents\//);
      expect(path).not.toMatch(/^\.ai\//);
      expect(path).not.toMatch(/codebase-harness|agent-harness|derivations\.json/u);
    }
  }, 30_000);

  test("synchronizes and checks projections from the portable skill inputs alone", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tweakloop-skill-projection-"));
    const canonicalRoot = join(fixture, ".agents", "skills");
    const canonical = join(canonicalRoot, "tweakloop");
    const fixtureSync = join(fixture, "scripts", "sync-skills.mjs");
    try {
      cpSync(join(root, ".agents", "skills"), canonicalRoot, { recursive: true });
      mkdirSync(join(fixture, "scripts"), { recursive: true });
      cpSync(join(root, "scripts", "sync-skills.mjs"), fixtureSync);
      cpSync(
        join(root, "scripts", "skill-projection.mjs"),
        join(fixture, "scripts", "skill-projection.mjs"),
      );
      execFileSync(process.execPath, [fixtureSync, fixture]);
      execFileSync(process.execPath, [fixtureSync, "--check", fixture]);
      expect(readFileSync(join(fixture, "skills", "tweakloop", "SKILL.md"))).toEqual(
        readFileSync(join(canonical, "SKILL.md")),
      );

      writeFileSync(join(canonical, "SKILL.md"), `${readFileSync(join(canonical, "SKILL.md"))}\n`);
      execFileSync(process.execPath, [fixtureSync, fixture]);
      expect(
        readFileSync(join(fixture, ".claude", "skills", "tweakloop", "SKILL.md"), "utf8"),
      ).toBe(readFileSync(join(canonical, "SKILL.md"), "utf8"));

      writeFileSync(join(fixture, "skills", "tweakloop", "SKILL.md"), "hand edit\n");
      writeFileSync(
        join(canonical, "SKILL.md"),
        `${readFileSync(join(canonical, "SKILL.md"))}v3\n`,
      );
      const untouchedClaude = readFileSync(
        join(fixture, ".claude", "skills", "tweakloop", "SKILL.md"),
      );
      expect(() =>
        execFileSync(process.execPath, [fixtureSync, fixture], { stdio: "pipe" }),
      ).toThrow(/hand-edit drift blocks skill projection/);
      expect(readFileSync(join(fixture, "skills", "tweakloop", "SKILL.md"), "utf8")).toBe(
        "hand edit\n",
      );
      expect(readFileSync(join(fixture, ".claude", "skills", "tweakloop", "SKILL.md"))).toEqual(
        untouchedClaude,
      );
      expect(() =>
        execFileSync(process.execPath, [fixtureSync, "--check", fixture], { stdio: "pipe" }),
      ).toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("projects a newly added canonical skill without a hard-coded inventory", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tweakloop-skill-inventory-"));
    const canonicalRoot = join(fixture, ".agents", "skills");
    const fixtureSync = join(fixture, "scripts", "sync-skills.mjs");
    try {
      cpSync(join(root, ".agents", "skills"), canonicalRoot, { recursive: true });
      cpSync(join(canonicalRoot, "tweakloop"), join(canonicalRoot, "future-skill"), {
        recursive: true,
      });
      mkdirSync(join(fixture, "scripts"), { recursive: true });
      cpSync(join(root, "scripts", "sync-skills.mjs"), fixtureSync);
      cpSync(
        join(root, "scripts", "skill-projection.mjs"),
        join(fixture, "scripts", "skill-projection.mjs"),
      );
      execFileSync(process.execPath, [fixtureSync, fixture]);
      execFileSync(process.execPath, [fixtureSync, "--check", fixture]);

      for (const consumer of ["skills", join(".claude", "skills")]) {
        expect(readFileSync(join(fixture, consumer, "future-skill", "SKILL.md"))).toEqual(
          readFileSync(join(canonicalRoot, "future-skill", "SKILL.md")),
        );
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("rejects a public skill reverse edge into contributor-specific harness state", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tweakloop-skill-private-edge-"));
    const canonicalRoot = join(fixture, ".agents", "skills");
    const fixtureSync = join(fixture, "scripts", "sync-skills.mjs");
    try {
      cpSync(join(root, ".agents", "skills"), canonicalRoot, { recursive: true });
      mkdirSync(join(fixture, "scripts"), { recursive: true });
      cpSync(join(root, "scripts", "sync-skills.mjs"), fixtureSync);
      cpSync(
        join(root, "scripts", "skill-projection.mjs"),
        join(fixture, "scripts", "skill-projection.mjs"),
      );
      writeFileSync(
        join(canonicalRoot, "tweakloop", "private-coupling.md"),
        "Load ../../../../.ai/harness/manifest.json through codebase-harness.\n",
      );

      expect(() =>
        execFileSync(process.execPath, [fixtureSync, fixture], { stdio: "pipe" }),
      ).toThrow(/forbidden skill reverse edge/);
      expect(existsSync(join(fixture, "skills"))).toBe(false);
      expect(existsSync(join(fixture, ".claude", "skills"))).toBe(false);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("permits the exact safe prose boundary without turning it into a private dependency", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tweakloop-skill-safe-boundary-"));
    const canonicalRoot = join(fixture, ".agents", "skills");
    const fixtureSync = join(fixture, "scripts", "sync-skills.mjs");
    const boundary =
      "This public skill does not depend on codebase-harness and never reads `.ai/harness` state.\n";
    try {
      cpSync(join(root, ".agents", "skills"), canonicalRoot, { recursive: true });
      mkdirSync(join(fixture, "scripts"), { recursive: true });
      cpSync(join(root, "scripts", "sync-skills.mjs"), fixtureSync);
      cpSync(
        join(root, "scripts", "skill-projection.mjs"),
        join(fixture, "scripts", "skill-projection.mjs"),
      );
      writeFileSync(join(canonicalRoot, "tweakloop", "boundary.md"), boundary);

      execFileSync(process.execPath, [fixtureSync, fixture]);
      execFileSync(process.execPath, [fixtureSync, "--check", fixture]);
      expect(readFileSync(join(fixture, "skills", "tweakloop", "boundary.md"), "utf8")).toBe(
        boundary,
      );
      expect(
        readFileSync(join(fixture, ".claude", "skills", "tweakloop", "boundary.md"), "utf8"),
      ).toBe(boundary);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
