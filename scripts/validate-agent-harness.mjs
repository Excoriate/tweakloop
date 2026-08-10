import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashBytes,
  hashPath,
  readDerivationManifest,
  resolveInside,
} from "./agent-harness-manifest.mjs";
import { expectedDerivation } from "./agent-harness-render.mjs";

function compareExpected(expected, consumer) {
  if (!existsSync(consumer)) return [`missing consumer: ${consumer}`];
  if (expected.kind === "copy") {
    const sourceStat = lstatSync(expected.source);
    const consumerStat = lstatSync(consumer);
    if (sourceStat.isDirectory() !== consumerStat.isDirectory()) {
      return [`source/consumer kind mismatch: ${expected.source} -> ${consumer}`];
    }
    return hashPath(expected.source) === hashPath(consumer)
      ? []
      : [`byte or file-set drift: ${expected.source} -> ${consumer}`];
  }
  if (!lstatSync(consumer).isFile()) return [`rendered consumer is not a file: ${consumer}`];
  return readFileSync(consumer).equals(expected.bytes)
    ? []
    : [`rendered adapter drift: ${consumer}`];
}

function readLock(repositoryRoot) {
  const path = resolveInside(repositoryRoot, ".agents/derivation-lock.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateAgentHarness(repositoryRoot) {
  const manifest = readDerivationManifest(repositoryRoot);
  const lock = readLock(repositoryRoot);
  const rows = manifest.derivations.map((row) => {
    const failures = [];
    if (row.mode !== "planned") {
      const expected = expectedDerivation(row, repositoryRoot, resolveInside);
      const consumer = resolveInside(repositoryRoot, row.consumer);
      failures.push(...compareExpected(expected, consumer));
      if (row.mode === "generate" && lock) {
        const locked = lock.rows?.[row.id];
        const desiredHash =
          expected.kind === "copy" ? hashPath(expected.source) : hashBytes(expected.bytes);
        if (!locked) failures.push(`derivation lock omits ${row.id}`);
        else {
          if (locked.expectedHash !== desiredHash) failures.push(`expected hash drift: ${row.id}`);
          if (existsSync(consumer) && locked.consumerHash !== hashPath(consumer)) {
            failures.push(`consumer hash drift: ${row.id}`);
          }
        }
      }
    }
    return {
      id: row.id,
      type: row.type,
      mode: row.mode,
      status: failures.length === 0 ? (row.mode === "planned" ? "PLANNED" : "PASS") : "FAIL",
      failures,
      activation: row.activation,
    };
  });
  return {
    protocol: "tweakloop.agent-harness-validation/v1",
    phase: manifest.phase,
    lock: lock ? "PRESENT" : "ABSENT",
    ok: rows.every((row) => row.status !== "FAIL"),
    rows,
  };
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repositoryRoot = resolve(
    process.argv.slice(2).find((arg) => !arg.startsWith("--")) ?? process.cwd(),
  );
  try {
    const result = validateAgentHarness(repositoryRoot);
    process.stdout.write(
      `${JSON.stringify(result, null, process.argv.includes("--json") ? 2 : 0)}\n`,
    );
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
