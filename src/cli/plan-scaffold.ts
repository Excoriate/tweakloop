import { readFileSync, writeFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGED_PLAN_STARTER = fileURLToPath(
  new URL("../../skills/tweakloop/assets/minimal-plan-starter.html", import.meta.url),
);

export type PlanScaffoldReceipt = Readonly<{
  path: string;
  template: "plan";
  created: true;
  remainingPlaceholderCount: number;
}>;

export class PlanScaffoldError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "PlanScaffoldError";
  }
}

/**
 * Copy the packaged starter exactly once. This function deliberately knows
 * nothing about daemon discovery or workspace identity.
 */
export function createPlanScaffold(
  destination: string,
  starterPath = PACKAGED_PLAN_STARTER,
): PlanScaffoldReceipt {
  const path = resolve(destination);
  if (extname(path).toLowerCase() !== ".html") {
    throw new PlanScaffoldError(
      "scaffold.unsupported-extension",
      "plan scaffolds require an .html destination",
      { path },
    );
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(starterPath);
  } catch (error) {
    throw new PlanScaffoldError(
      "scaffold.template-unavailable",
      "the packaged minimal plan starter is unavailable",
      { starterPath, cause: errorMessage(error) },
    );
  }

  try {
    writeFileSync(path, bytes, { flag: "wx" });
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw new PlanScaffoldError(
        "scaffold.destination-exists",
        `destination already exists: ${path}`,
        { path },
      );
    }
    throw new PlanScaffoldError("scaffold.create-failed", `could not create ${path}`, {
      path,
      cause: errorMessage(error),
    });
  }

  return {
    path,
    template: "plan",
    created: true,
    remainingPlaceholderCount: countPlaceholders(bytes.toString("utf8")),
  };
}

function countPlaceholders(text: string): number {
  return text.match(/\[\[[A-Z0-9_]+\]\]/g)?.length ?? 0;
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
