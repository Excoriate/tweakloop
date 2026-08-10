import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function prepareFixture(): { fixture: string; sync: string } {
  const fixture = mkdtempSync(join(tmpdir(), "tweakloop-guide-projection-"));
  mkdirSync(join(fixture, ".agents"), { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  cpSync(join(root, ".agents", "AGENTS.md"), join(fixture, ".agents", "AGENTS.md"));
  cpSync(
    join(root, "scripts", "guide-projection.mjs"),
    join(fixture, "scripts", "guide-projection.mjs"),
  );
  const sync = join(fixture, "scripts", "sync-guides.mjs");
  cpSync(join(root, "scripts", "sync-guides.mjs"), sync);
  return { fixture, sync };
}

describe("portable OSS guide projection", () => {
  test("keeps the current repository guide consumers on the canonical bytes", () => {
    const result = JSON.parse(
      execFileSync(process.execPath, [join(root, "scripts", "sync-guides.mjs"), "--check"], {
        cwd: root,
        encoding: "utf8",
      }),
    ) as { ok: boolean; rows: Array<{ status: string }> };
    expect(result.ok).toBe(true);
    expect(result.rows.every((row) => row.status === "PASS")).toBe(true);
    expect(readFileSync(join(root, "Justfile"), "utf8")).toContain(
      "check: build check-guides check-skills check-hooks test lint",
    );
  });

  test("projects in a clean room and refuses a hand-edited root guide", () => {
    const { fixture, sync } = prepareFixture();
    try {
      execFileSync(process.execPath, [sync, fixture]);
      execFileSync(process.execPath, [sync, "--check", fixture]);
      expect(readFileSync(join(fixture, "AGENTS.md"))).toEqual(
        readFileSync(join(fixture, ".agents", "AGENTS.md")),
      );
      expect(readlinkSync(join(fixture, "CLAUDE.md"))).toBe("AGENTS.md");

      writeFileSync(
        join(fixture, ".agents", "AGENTS.md"),
        `${readFileSync(join(fixture, ".agents", "AGENTS.md"), "utf8")}canonical update\n`,
      );
      execFileSync(process.execPath, [sync, fixture]);
      expect(readFileSync(join(fixture, "AGENTS.md"))).toEqual(
        readFileSync(join(fixture, ".agents", "AGENTS.md")),
      );

      writeFileSync(join(fixture, "AGENTS.md"), "hand edit\n");
      writeFileSync(
        join(fixture, ".agents", "AGENTS.md"),
        `${readFileSync(join(fixture, ".agents", "AGENTS.md"), "utf8")}next canonical update\n`,
      );
      expect(() => execFileSync(process.execPath, [sync, fixture], { stdio: "pipe" })).toThrow(
        /hand-edit drift blocks guide projection/,
      );
      expect(readFileSync(join(fixture, "AGENTS.md"), "utf8")).toBe("hand edit\n");
      expect(readlinkSync(join(fixture, "CLAUDE.md"))).toBe("AGENTS.md");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("refuses a non-symlink Claude consumer without touching either guide", () => {
    const { fixture, sync } = prepareFixture();
    try {
      execFileSync(process.execPath, [sync, fixture]);
      const agentsBefore = readFileSync(join(fixture, "AGENTS.md"));
      rmSync(join(fixture, "CLAUDE.md"));
      writeFileSync(join(fixture, "CLAUDE.md"), "independent guide\n");
      expect(() => execFileSync(process.execPath, [sync, fixture], { stdio: "pipe" })).toThrow(
        /CLAUDE\.md must remain a symlink/,
      );
      expect(readFileSync(join(fixture, "AGENTS.md"))).toEqual(agentsBefore);
      expect(readFileSync(join(fixture, "CLAUDE.md"), "utf8")).toBe("independent guide\n");
      expect(existsSync(join(fixture, ".agents", "guide-projection-lock.json"))).toBe(true);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
