import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hashBytes,
  hashPath,
  readDerivationManifest,
  resolveInside,
} from "./agent-harness-manifest.mjs";
import { expectedDerivation, materializeDerivation } from "./agent-harness-render.mjs";
import { validateAgentHarness } from "./validate-agent-harness.mjs";

const LOCK_PROTOCOL = "tweakloop.agent-derivation-lock/v1";

function expectedHash(expected) {
  return expected.kind === "copy" ? hashPath(expected.source) : hashBytes(expected.bytes);
}

function readLock(repositoryRoot) {
  const lockPath = resolveInside(repositoryRoot, ".agents/derivation-lock.json");
  if (!existsSync(lockPath)) return { protocol: LOCK_PROTOCOL, rows: {} };
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (lock.protocol !== LOCK_PROTOCOL || typeof lock.rows !== "object" || lock.rows === null) {
    throw new Error("invalid agent derivation lock");
  }
  return lock;
}

function writeLock(repositoryRoot, phase, rows) {
  const lockPath = resolveInside(repositoryRoot, ".agents/derivation-lock.json");
  const temporary = `${lockPath}.tmp`;
  writeFileSync(
    temporary,
    `${JSON.stringify({ protocol: LOCK_PROTOCOL, phase, rows }, null, 2)}\n`,
  );
  renameSync(temporary, lockPath);
}

function activationReplacementAllowed(row, activate) {
  return activate && new Set(["native-import", "schema-adapter"]).has(row.type);
}

function assertRollbackConsumersMatchLock(repositoryRoot) {
  const manifest = readDerivationManifest(repositoryRoot);
  const lock = readLock(repositoryRoot);
  if (lock.phase !== manifest.phase) {
    throw new Error(
      `rollback refused: derivation lock phase ${lock.phase ?? "<missing>"} does not match ${manifest.phase}`,
    );
  }
  for (const row of manifest.derivations.filter((candidate) => candidate.mode === "generate")) {
    const locked = lock.rows[row.id];
    if (!locked) {
      throw new Error(`rollback refused: derivation lock omits active row ${row.id}`);
    }
    const consumer = resolveInside(repositoryRoot, row.consumer);
    const currentHash = existsSync(consumer) ? hashPath(consumer) : null;
    if (currentHash !== locked.consumerHash) {
      throw new Error(`rollback refused: active consumer drift for ${row.id} (${row.consumer})`);
    }
  }
}

export function syncAgentHarness(repositoryRoot, options = {}) {
  const manifest = readDerivationManifest(repositoryRoot);
  const lock = readLock(repositoryRoot);
  const generated = [];
  const nextRows = {};
  const planned = [];

  for (const row of manifest.derivations.filter((candidate) => candidate.mode === "generate")) {
    const expected = expectedDerivation(row, repositoryRoot, resolveInside);
    const consumer = resolveInside(repositoryRoot, row.consumer);
    const desiredHash = expectedHash(expected);
    const currentHash = existsSync(consumer) ? hashPath(consumer) : null;
    const prior = lock.rows[row.id];
    const consumerMatchesPrior = prior && currentHash === prior.consumerHash;

    if (currentHash !== desiredHash) {
      const safeCanonicalUpdate = consumerMatchesPrior;
      const firstActivation = activationReplacementAllowed(row, options.activate === true);
      const missingConsumer = currentHash === null;
      if (!safeCanonicalUpdate && !firstActivation && !missingConsumer) {
        throw new Error(`hand-edit drift blocks generation: ${row.id} (${row.consumer})`);
      }
      if (
        missingConsumer &&
        new Set(["native-import", "schema-adapter"]).has(row.type) &&
        !firstActivation
      ) {
        throw new Error(`activation flag required to create ${row.id} (${row.consumer})`);
      }
    }

    planned.push({ row, expected, consumer, desiredHash, currentHash });
  }

  for (const item of planned) {
    if (item.currentHash !== item.desiredHash) {
      materializeDerivation(item.expected, item.consumer);
      generated.push({
        id: item.row.id,
        source: item.row.source,
        consumer: item.row.consumer,
      });
    }

    const finalHash = hashPath(item.consumer);
    nextRows[item.row.id] = {
      sourceHash: hashPath(resolveInside(repositoryRoot, item.row.source)),
      expectedHash: item.desiredHash,
      consumerHash: finalHash,
    };
  }

  writeLock(repositoryRoot, manifest.phase, nextRows);
  const validation = validateAgentHarness(repositoryRoot);
  if (!validation.ok) {
    throw new Error(`generated harness failed validation: ${JSON.stringify(validation.rows)}`);
  }
  return { protocol: "tweakloop.agent-harness-sync/v1", phase: manifest.phase, generated };
}

export function rollbackAgentHarness(repositoryRoot) {
  assertRollbackConsumersMatchLock(repositoryRoot);
  const rollbackPath = resolveInside(repositoryRoot, ".agents/rollback/activate-v1.json");
  const rollback = JSON.parse(readFileSync(rollbackPath, "utf8"));
  if (rollback.protocol !== "tweakloop.agent-harness-rollback/v1") {
    throw new Error(`unsupported rollback protocol: ${rollback.protocol}`);
  }
  for (const [repositoryPath, state] of Object.entries(rollback.consumers)) {
    const target = resolveInside(repositoryRoot, repositoryPath);
    rmSync(target, { recursive: true, force: true });
    if (state.kind === "absent") continue;
    mkdirSync(dirname(target), { recursive: true });
    if (state.kind === "symlink") {
      symlinkSync(state.target, target);
    } else if (state.kind === "canonical-guide") {
      writeFileSync(target, readFileSync(resolveInside(repositoryRoot, state.source)));
    } else if (state.kind === "copy") {
      writeFileSync(target, readFileSync(resolveInside(repositoryRoot, state.source)));
    } else {
      throw new Error(`unsupported rollback state for ${repositoryPath}: ${state.kind}`);
    }
  }
  rmSync(resolveInside(repositoryRoot, ".agents/derivation-lock.json"), { force: true });
  const validation = syncAgentHarness(repositoryRoot);
  return {
    protocol: "tweakloop.agent-harness-rollback-result/v1",
    restored: true,
    validation,
  };
}

function parseArguments(argv) {
  const options = { activate: false, rollback: false, repositoryRoot: process.cwd() };
  for (const argument of argv) {
    if (argument === "--activate") options.activate = true;
    else if (argument === "--rollback") options.rollback = true;
    else if (!argument.startsWith("--")) options.repositoryRoot = argument;
    else throw new Error(`unsupported sync option: ${argument}`);
  }
  return options;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const repositoryRoot = resolve(options.repositoryRoot);
    const result = options.rollback
      ? rollbackAgentHarness(repositoryRoot)
      : syncAgentHarness(repositoryRoot, { activate: options.activate });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
