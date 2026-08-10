import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { assertPortableHookBoundary, hashHookTree } from "../../scripts/hook-projection.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function createCleanRoom() {
  const fixture = mkdtempSync(join(tmpdir(), "tweakloop-hook-projection-"));
  mkdirSync(join(fixture, ".agents", "hooks"), { recursive: true });
  mkdirSync(join(fixture, "scripts"), { recursive: true });
  cpSync(join(root, ".agents", "hooks", "v2"), join(fixture, ".agents", "hooks", "v2"), {
    recursive: true,
  });
  cpSync(
    join(root, "scripts", "hook-projection.mjs"),
    join(fixture, "scripts", "hook-projection.mjs"),
  );
  cpSync(join(root, "scripts", "sync-hooks.mjs"), join(fixture, "scripts", "sync-hooks.mjs"));
  return fixture;
}

function sync(fixture: string, ...args: string[]) {
  return execFileSync(
    process.execPath,
    [join(fixture, "scripts", "sync-hooks.mjs"), ...args, fixture],
    {
      encoding: "utf8",
    },
  );
}

describe("standalone OSS hook projection", () => {
  test("keeps the checked-in public projection byte-identical and portable", () => {
    sync(root, "--check");
    expect(hashHookTree(join(root, "hooks", "v2"))).toEqual(
      hashHookTree(join(root, ".agents", "hooks", "v2")),
    );
    expect(() => assertPortableHookBoundary(root)).not.toThrow();
  });

  test("projects and checks byte-identical hooks with every private harness input absent", () => {
    const fixture = createCleanRoom();
    try {
      sync(fixture);
      sync(fixture, "--check");
      expect(hashHookTree(join(fixture, "hooks", "v2"))).toEqual(
        hashHookTree(join(fixture, ".agents", "hooks", "v2")),
      );
      expect(() => assertPortableHookBoundary(fixture)).not.toThrow();
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("updates an unedited projection and blocks hand-edit drift atomically", () => {
    const fixture = createCleanRoom();
    try {
      sync(fixture);
      const canonicalReadme = join(fixture, ".agents", "hooks", "v2", "README.md");
      const consumerReadme = join(fixture, "hooks", "v2", "README.md");
      writeFileSync(canonicalReadme, `${readFileSync(canonicalReadme, "utf8")}\nprojection-v2\n`);
      sync(fixture);
      expect(readFileSync(consumerReadme)).toEqual(readFileSync(canonicalReadme));

      writeFileSync(consumerReadme, "hand edit\n");
      writeFileSync(canonicalReadme, `${readFileSync(canonicalReadme, "utf8")}canonical-v3\n`);
      expect(() => sync(fixture)).toThrow(/hand-edit drift blocks hook projection/);
      expect(readFileSync(consumerReadme, "utf8")).toBe("hand edit\n");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test("rejects a reverse edge to personal harness tooling", () => {
    const fixture = createCleanRoom();
    try {
      const adapter = join(fixture, ".agents", "hooks", "v2", "continue-on-inbound.mjs");
      writeFileSync(
        adapter,
        `${readFileSync(adapter, "utf8")}\nimport "../../../scripts/agent-harness-render.mjs";\n`,
      );
      expect(() => sync(fixture)).toThrow(/forbidden hook reverse edge/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  test.each([
    ["workspace-wide events", '"events",\n    "list"'],
    ["mutating next", '"next",\n    "--session"'],
  ])("rejects a plausibly wrong %s adapter", (_label, replacement) => {
    const fixture = createCleanRoom();
    try {
      const adapter = join(fixture, ".agents", "hooks", "v2", "continue-on-inbound.mjs");
      const source = readFileSync(adapter, "utf8");
      expect(source).toContain('"native-hook",\n    "observe"');
      writeFileSync(adapter, source.replace('"native-hook",\n    "observe"', replacement));
      expect(() => sync(fixture)).toThrow(/forbidden mutating or workspace-wide hook command/);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
