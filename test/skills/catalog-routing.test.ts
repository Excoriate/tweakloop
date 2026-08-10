import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const maximumDescriptionBytes = 96;

const contracts = [
  {
    name: "tweakloop",
    positive: /Tweakloop review/,
    negative: /NOT for ordinary editing or human acceptance/,
  },
  {
    name: "excalidraw",
    positive: /Tweakloop whiteboards/,
    negative: /NOT for raw Excalidraw JSON or flat images/,
  },
  {
    name: "architecture-diagram",
    positive: /Tweakloop architecture scenes/,
    negative: /NOT for Mermaid, prose, freehand, or raw JSON/,
  },
] as const;

function descriptionOf(skill: string): string {
  const source = readFileSync(join(root, ".agents", "skills", skill, "SKILL.md"), "utf8");
  const match = source.match(/^description:\s*['"]?([^'"\n]+)['"]?$/m);
  if (!match) throw new Error(`missing one-line description for ${skill}`);
  return match[1].trim();
}

function routingFailures(description: string, positive: RegExp, negative: RegExp): string[] {
  const failures: string[] = [];
  if (Buffer.byteLength(description, "utf8") > maximumDescriptionBytes) failures.push("budget");
  if (!positive.test(description)) failures.push("positive-route");
  if (!negative.test(description)) failures.push("negative-route");
  if (!description.slice(0, 64).includes("NOT")) failures.push("early-negative");
  return failures;
}

describe("native skill catalog routing", () => {
  it.each(contracts)("keeps $name decisive inside a conservative native prefix", (contract) => {
    const description = descriptionOf(contract.name);
    expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(maximumDescriptionBytes);
    expect(routingFailures(description, contract.positive, contract.negative)).toEqual([]);
  });

  it("rejects plausible positive-only and tail-loaded catalog descriptions", () => {
    const contract = contracts[0];
    const positiveOnly = "Use for durable Tweakloop review and recovery.";
    const tailLoaded = `${positiveOnly} ${"helpful workflow. ".repeat(6)}NOT for ordinary editing or human acceptance.`;

    expect(routingFailures(positiveOnly, contract.positive, contract.negative)).toContain(
      "negative-route",
    );
    expect(routingFailures(tailLoaded, contract.positive, contract.negative)).toEqual(
      expect.arrayContaining(["budget", "early-negative"]),
    );
  });
});
