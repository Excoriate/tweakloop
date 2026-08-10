import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const LOCK_PROTOCOL = "tweakloop.guide-projection-lock/v1";
const SYNC_PROTOCOL = "tweakloop.guide-projection-sync/v1";
const CHECK_PROTOCOL = "tweakloop.guide-projection-check/v1";
const CANONICAL_PATH = ".agents/AGENTS.md";
const AGENTS_CONSUMER_PATH = "AGENTS.md";
const CLAUDE_CONSUMER_PATH = "CLAUDE.md";
const CLAUDE_TARGET = "AGENTS.md";
const LOCK_PATH = ".agents/guide-projection-lock.json";

function resolveInside(repositoryRoot, repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    isAbsolute(repositoryPath)
  ) {
    throw new Error(`guide projection path must be relative: ${repositoryPath}`);
  }
  const resolved = resolve(repositoryRoot, repositoryPath);
  const fromRoot = relative(repositoryRoot, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`guide projection path escapes repository root: ${repositoryPath}`);
  }
  return resolved;
}

function hashRegularFile(file, label) {
  if (!existsSync(file)) return null;
  const stat = lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readLock(repositoryRoot) {
  const file = resolveInside(repositoryRoot, LOCK_PATH);
  if (!existsSync(file)) return null;
  const lock = JSON.parse(readFileSync(file, "utf8"));
  if (
    lock.protocol !== LOCK_PROTOCOL ||
    lock.canonical !== CANONICAL_PATH ||
    typeof lock.canonicalSha256 !== "string" ||
    lock.agentsConsumer !== AGENTS_CONSUMER_PATH ||
    lock.claudeConsumer !== CLAUDE_CONSUMER_PATH ||
    lock.claudeTarget !== CLAUDE_TARGET
  ) {
    throw new Error("invalid OSS guide projection lock");
  }
  return lock;
}

function currentProjection(repositoryRoot) {
  const canonicalFile = resolveInside(repositoryRoot, CANONICAL_PATH);
  const agentsFile = resolveInside(repositoryRoot, AGENTS_CONSUMER_PATH);
  const claudeFile = resolveInside(repositoryRoot, CLAUDE_CONSUMER_PATH);
  const canonicalSha256 = hashRegularFile(canonicalFile, "canonical guide");
  if (!canonicalSha256) throw new Error(`canonical guide is missing: ${CANONICAL_PATH}`);

  let claudeTarget = null;
  if (existsSync(claudeFile)) {
    const stat = lstatSync(claudeFile);
    if (stat.isSymbolicLink()) claudeTarget = readlinkSync(claudeFile);
    else claudeTarget = "<not-a-symlink>";
  }

  return {
    canonicalFile,
    canonicalSha256,
    agentsFile,
    agentsSha256: hashRegularFile(agentsFile, "root AGENTS.md consumer"),
    claudeFile,
    claudeTarget,
  };
}

export function checkGuideProjection(repositoryRoot) {
  const projection = currentProjection(repositoryRoot);
  const lock = readLock(repositoryRoot);
  const agentsFailures = [];
  const claudeFailures = [];
  const lockFailures = [];

  if (!projection.agentsSha256) agentsFailures.push("missing root AGENTS.md consumer");
  else if (projection.agentsSha256 !== projection.canonicalSha256) {
    agentsFailures.push("root AGENTS.md bytes differ from canonical guide");
  }

  if (projection.claudeTarget === null) claudeFailures.push("missing CLAUDE.md consumer");
  else if (projection.claudeTarget !== CLAUDE_TARGET) {
    claudeFailures.push("CLAUDE.md must be a symlink to AGENTS.md");
  } else if (
    createHash("sha256").update(readFileSync(projection.claudeFile)).digest("hex") !==
    projection.canonicalSha256
  ) {
    claudeFailures.push("CLAUDE.md resolves to bytes that differ from canonical guide");
  }

  if (!lock) lockFailures.push("guide projection lock is missing");
  else if (lock.canonicalSha256 !== projection.canonicalSha256) {
    lockFailures.push("canonical guide differs from projection lock");
  }

  const rows = [
    { path: AGENTS_CONSUMER_PATH, failures: agentsFailures },
    { path: CLAUDE_CONSUMER_PATH, failures: claudeFailures },
    { path: LOCK_PATH, failures: lockFailures },
  ].map((row) => ({
    ...row,
    status: row.failures.length === 0 ? "PASS" : "FAIL",
  }));

  return {
    protocol: CHECK_PROTOCOL,
    canonical: { path: CANONICAL_PATH, sha256: projection.canonicalSha256 },
    rows,
    ok: rows.every((row) => row.status === "PASS"),
  };
}

function writeLock(repositoryRoot, canonicalSha256) {
  const lockFile = resolveInside(repositoryRoot, LOCK_PATH);
  const temporary = `${lockFile}.tmp-${randomUUID()}`;
  writeFileSync(
    temporary,
    `${JSON.stringify(
      {
        protocol: LOCK_PROTOCOL,
        canonical: CANONICAL_PATH,
        canonicalSha256,
        agentsConsumer: AGENTS_CONSUMER_PATH,
        claudeConsumer: CLAUDE_CONSUMER_PATH,
        claudeTarget: CLAUDE_TARGET,
      },
      null,
      2,
    )}\n`,
  );
  renameSync(temporary, lockFile);
}

export function syncGuideProjection(repositoryRoot) {
  const projection = currentProjection(repositoryRoot);
  const lock = readLock(repositoryRoot);

  if (
    projection.agentsSha256 &&
    projection.agentsSha256 !== projection.canonicalSha256 &&
    (!lock || projection.agentsSha256 !== lock.canonicalSha256)
  ) {
    throw new Error("hand-edit drift blocks guide projection: AGENTS.md");
  }
  if (projection.claudeTarget !== null && projection.claudeTarget !== CLAUDE_TARGET) {
    throw new Error("CLAUDE.md must remain a symlink to AGENTS.md");
  }

  const transactionId = randomUUID();
  const stage = `${projection.agentsFile}.stage-${transactionId}`;
  const backup = `${projection.agentsFile}.backup-${transactionId}`;
  const updateAgents = projection.agentsSha256 !== projection.canonicalSha256;
  let backedUp = false;
  let installed = false;
  let createdClaude = false;

  try {
    if (updateAgents) {
      writeFileSync(stage, readFileSync(projection.canonicalFile), { mode: 0o644 });
      if (existsSync(projection.agentsFile)) {
        renameSync(projection.agentsFile, backup);
        backedUp = true;
      }
      renameSync(stage, projection.agentsFile);
      installed = true;
    }
    if (projection.claudeTarget === null) {
      symlinkSync(CLAUDE_TARGET, projection.claudeFile);
      createdClaude = true;
    }

    writeLock(repositoryRoot, projection.canonicalSha256);
    const check = checkGuideProjection(repositoryRoot);
    if (!check.ok) throw new Error("published guide projection failed verification");
    if (backedUp) rmSync(backup, { force: true });
    return { ...check, protocol: SYNC_PROTOCOL, changed: updateAgents || createdClaude };
  } catch (error) {
    if (createdClaude && existsSync(projection.claudeFile)) rmSync(projection.claudeFile);
    if (installed && existsSync(projection.agentsFile)) rmSync(projection.agentsFile);
    if (backedUp && existsSync(backup)) renameSync(backup, projection.agentsFile);
    if (existsSync(stage)) rmSync(stage);
    throw error;
  }
}
