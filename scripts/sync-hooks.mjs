import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkHookProjection, syncHookProjection } from "./hook-projection.mjs";

function parseArguments(argv) {
  const options = { check: false, repositoryRoot: process.cwd() };
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (!argument.startsWith("--")) options.repositoryRoot = argument;
    else throw new Error(`unsupported hook sync option: ${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = options.check
      ? checkHookProjection(resolve(options.repositoryRoot))
      : syncHookProjection(resolve(options.repositoryRoot));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if ("ok" in result && !result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
