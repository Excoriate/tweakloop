import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createPlanScaffold, type PlanScaffoldError } from "../../src/cli/plan-scaffold.js";

const starterPath = fileURLToPath(
  new URL("../../skills/tweakloop/assets/minimal-plan-starter.html", import.meta.url),
);
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
});

describe("new plan scaffold", () => {
  it("copies the packaged starter byte-for-byte from outside the repository cwd", () => {
    const directory = mkdtempSync(join(tmpdir(), "tweakloop-plan-"));
    const destination = join(directory, "proposal.html");
    process.chdir(directory);

    const receipt = createPlanScaffold(destination);

    expect(readFileSync(destination)).toEqual(readFileSync(starterPath));
    expect(receipt).toEqual({
      path: destination,
      template: "plan",
      created: true,
      remainingPlaceholderCount: 30,
    });
    expect(() => readFileSync(join(directory, ".tweakloop/project.json"))).toThrow();
  });

  it("fails before write and preserves every existing destination byte", () => {
    const directory = mkdtempSync(join(tmpdir(), "tweakloop-plan-existing-"));
    const destination = join(directory, "proposal.html");
    const sentinel = Buffer.from("existing user bytes\n");
    writeFileSync(destination, sentinel);

    expect(() => createPlanScaffold(destination)).toThrowError(
      expect.objectContaining<Partial<PlanScaffoldError>>({
        code: "scaffold.destination-exists",
      }),
    );
    expect(readFileSync(destination)).toEqual(sentinel);
  });

  it("rejects a non-HTML destination without creating it", () => {
    const directory = mkdtempSync(join(tmpdir(), "tweakloop-plan-extension-"));
    const destination = join(directory, "proposal.md");

    expect(() => createPlanScaffold(destination)).toThrowError(
      expect.objectContaining<Partial<PlanScaffoldError>>({
        code: "scaffold.unsupported-extension",
      }),
    );
    expect(() => readFileSync(destination)).toThrow();
  });
});
