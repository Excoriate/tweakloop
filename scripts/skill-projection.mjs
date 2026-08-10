import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const LOCK_PROTOCOL = "tweakloop.skill-projection-lock/v1";
const SYNC_PROTOCOL = "tweakloop.skill-projection-sync/v1";
const CHECK_PROTOCOL = "tweakloop.skill-projection-check/v1";
const CANONICAL_PATH = ".agents/skills";
const CONSUMER_PATHS = ["skills", ".claude/skills"];
const LOCK_PATH = ".agents/skill-projection-lock.json";
const FORBIDDEN_PRIVATE_SKILL_EDGES = [
  ["private codebase harness", /codebase[- ]harness/iu],
  ["private harness state", /\.ai\/harness/iu],
  ["mixed derivation manifest", /\.agents\/(?:rollback\/shadow-)?derivations\.json/iu],
  ["mixed derivation lock", /\.agents\/derivation-lock\.json/iu],
  ["private harness renderer", /agent-harness-render\.mjs/iu],
  ["private consumer probe", /probe-agent-consumers\.mjs/iu],
];
const SAFE_PRIVATE_BOUNDARY_PROSE =
  /^This public skill does not depend on codebase-harness and never reads `\.ai\/harness` state\.\s*$/gmu;

function resolveInside(repositoryRoot, repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    isAbsolute(repositoryPath)
  ) {
    throw new Error(`skill projection path must be relative: ${repositoryPath}`);
  }
  const resolved = resolve(repositoryRoot, repositoryPath);
  const fromRoot = relative(repositoryRoot, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`skill projection path escapes repository root: ${repositoryPath}`);
  }
  return resolved;
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hashSkillTree(rootDirectory) {
  if (!existsSync(rootDirectory)) return null;
  const digest = createHash("sha256");
  let fileCount = 0;

  function update(current, relativePath) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`skill projection trees cannot contain symlinks: ${current}`);
    }
    if (stat.isFile()) {
      fileCount += 1;
      digest.update(`file\0${relativePath}\0`);
      digest.update(readFileSync(current));
      digest.update("\0");
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`unsupported skill projection path type: ${current}`);
    }
    digest.update(`dir\0${relativePath}\0`);
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      compareNames(left.name, right.name),
    )) {
      update(
        resolve(current, entry.name),
        relativePath ? `${relativePath}/${entry.name}` : entry.name,
      );
    }
  }

  update(rootDirectory, "");
  return { sha256: digest.digest("hex"), files: fileCount };
}

export function assertPortableSkillBoundary(repositoryRoot) {
  const canonicalRoot = resolveInside(repositoryRoot, CANONICAL_PATH);

  function inspect(current, relativePath) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`skill projection trees cannot contain symlinks: ${current}`);
    }
    if (stat.isFile()) {
      const source = `${relativePath}\n${readFileSync(current, "utf8").replace(
        SAFE_PRIVATE_BOUNDARY_PROSE,
        "",
      )}`;
      for (const [label, pattern] of FORBIDDEN_PRIVATE_SKILL_EDGES) {
        if (pattern.test(source)) {
          throw new Error(
            `forbidden skill reverse edge (${label}): ${CANONICAL_PATH}/${relativePath}`,
          );
        }
      }
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`unsupported skill projection path type: ${current}`);
    }
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      compareNames(left.name, right.name),
    )) {
      inspect(
        resolve(current, entry.name),
        relativePath ? `${relativePath}/${entry.name}` : entry.name,
      );
    }
  }

  inspect(canonicalRoot, "");
}

function readLock(repositoryRoot) {
  const lockPath = resolveInside(repositoryRoot, LOCK_PATH);
  if (!existsSync(lockPath)) return null;
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (
    lock.protocol !== LOCK_PROTOCOL ||
    typeof lock.canonicalSha256 !== "string" ||
    typeof lock.consumers !== "object" ||
    lock.consumers === null
  ) {
    throw new Error("invalid OSS skill projection lock");
  }
  return lock;
}

function writeLock(repositoryRoot, canonical, consumers) {
  const lockPath = resolveInside(repositoryRoot, LOCK_PATH);
  const temporary = `${lockPath}.tmp-${randomUUID()}`;
  writeFileSync(
    temporary,
    `${JSON.stringify(
      {
        protocol: LOCK_PROTOCOL,
        canonical: CANONICAL_PATH,
        canonicalSha256: canonical.sha256,
        canonicalFiles: canonical.files,
        consumers: Object.fromEntries(
          consumers.map((row) => [row.path, { sha256: row.hash.sha256, files: row.hash.files }]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  renameSync(temporary, lockPath);
}

function currentProjection(repositoryRoot) {
  const canonicalRoot = resolveInside(repositoryRoot, CANONICAL_PATH);
  assertPortableSkillBoundary(repositoryRoot);
  const canonical = hashSkillTree(canonicalRoot);
  if (!canonical) throw new Error(`canonical skill tree is missing: ${CANONICAL_PATH}`);
  return {
    canonicalRoot,
    canonical,
    consumers: CONSUMER_PATHS.map((path) => {
      const root = resolveInside(repositoryRoot, path);
      return { path, root, hash: hashSkillTree(root) };
    }),
  };
}

export function checkSkillProjections(repositoryRoot) {
  const projection = currentProjection(repositoryRoot);
  const lock = readLock(repositoryRoot);
  const rows = projection.consumers.map((consumer) => {
    const failures = [];
    if (!consumer.hash) failures.push("missing consumer");
    else if (consumer.hash.sha256 !== projection.canonical.sha256) {
      failures.push("consumer bytes or file set differ from canonical");
    }
    const locked = lock?.consumers?.[consumer.path];
    if (!locked) failures.push("projection lock omits consumer");
    else if (consumer.hash && locked.sha256 !== consumer.hash.sha256) {
      failures.push("consumer differs from projection lock");
    }
    return { path: consumer.path, status: failures.length === 0 ? "PASS" : "FAIL", failures };
  });
  if (!lock || lock.canonicalSha256 !== projection.canonical.sha256) {
    rows.push({
      path: LOCK_PATH,
      status: "FAIL",
      failures: [!lock ? "projection lock is missing" : "canonical differs from projection lock"],
    });
  }
  return {
    protocol: CHECK_PROTOCOL,
    canonical: { path: CANONICAL_PATH, ...projection.canonical },
    rows,
    ok: rows.every((row) => row.status === "PASS"),
  };
}

export function syncSkillProjections(repositoryRoot) {
  const projection = currentProjection(repositoryRoot);
  const lock = readLock(repositoryRoot);
  const priorIsCoherent =
    lock !== null &&
    Object.values(lock.consumers).every((row) => row.sha256 === lock.canonicalSha256);
  const planned = [];

  for (const consumer of projection.consumers) {
    if (consumer.hash?.sha256 === projection.canonical.sha256) continue;
    const prior = lock?.consumers?.[consumer.path];
    const missing = consumer.hash === null;
    const matchesPrior =
      priorIsCoherent && prior && consumer.hash && prior.sha256 === consumer.hash.sha256;
    if (!missing && !matchesPrior) {
      throw new Error(`hand-edit drift blocks skill projection: ${consumer.path}`);
    }
    planned.push(consumer);
  }

  const transactionId = randomUUID();
  const staged = [];
  const published = [];
  let committed = false;
  try {
    for (const consumer of planned) {
      mkdirSync(dirname(consumer.root), { recursive: true });
      const stage = resolve(dirname(consumer.root), `.skills-stage-${transactionId}`);
      cpSync(projection.canonicalRoot, stage, { recursive: true, errorOnExist: true });
      const stageHash = hashSkillTree(stage);
      if (stageHash?.sha256 !== projection.canonical.sha256) {
        throw new Error(`staged skill projection failed verification: ${consumer.path}`);
      }
      staged.push({ ...consumer, stage });
    }

    for (const consumer of staged) {
      const backup = resolve(dirname(consumer.root), `.skills-backup-${transactionId}`);
      if (existsSync(consumer.root)) renameSync(consumer.root, backup);
      const publication = {
        ...consumer,
        backup: existsSync(backup) ? backup : null,
        installed: false,
      };
      published.push(publication);
      renameSync(consumer.stage, consumer.root);
      publication.installed = true;
    }

    const finalConsumers = CONSUMER_PATHS.map((path) => {
      const hash = hashSkillTree(resolveInside(repositoryRoot, path));
      if (!hash || hash.sha256 !== projection.canonical.sha256) {
        throw new Error(`published skill projection failed verification: ${path}`);
      }
      return { path, hash };
    });
    writeLock(repositoryRoot, projection.canonical, finalConsumers);
    committed = true;
    const result = {
      protocol: SYNC_PROTOCOL,
      canonical: { path: CANONICAL_PATH, ...projection.canonical },
      generated: planned.map((row) => row.path),
      consumers: finalConsumers,
    };
    for (const consumer of published) {
      if (consumer.backup) rmSync(consumer.backup, { recursive: true, force: true });
    }
    return result;
  } catch (error) {
    if (committed) throw error;
    for (const consumer of published.reverse()) {
      if (consumer.installed) rmSync(consumer.root, { recursive: true, force: true });
      if (consumer.backup) renameSync(consumer.backup, consumer.root);
    }
    for (const consumer of staged) {
      if (existsSync(consumer.stage)) rmSync(consumer.stage, { recursive: true, force: true });
    }
    throw error;
  }
}

export { CANONICAL_PATH, CHECK_PROTOCOL, CONSUMER_PATHS, LOCK_PATH, LOCK_PROTOCOL, SYNC_PROTOCOL };
