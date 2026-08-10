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

const LOCK_PROTOCOL = "tweakloop.hook-projection-lock/v1";
const SYNC_PROTOCOL = "tweakloop.hook-projection-sync/v1";
const CHECK_PROTOCOL = "tweakloop.hook-projection-check/v1";
const CANONICAL_PATH = ".agents/hooks/v2";
const CONSUMER_PATH = "hooks/v2";
const LOCK_PATH = ".agents/hook-projection-lock.json";
const BOUNDARY_SCAN_PATHS = [
  CANONICAL_PATH,
  "scripts/hook-projection.mjs",
  "scripts/sync-hooks.mjs",
];
const FORBIDDEN_REVERSE_EDGES = [
  {
    label: "private codebase harness",
    pattern: new RegExp(["codebase", "harness"].join("-"), "u"),
  },
  {
    label: "mixed agent harness script",
    pattern: new RegExp(["scripts", ["agent", "harness-"].join("-")].join("/"), "u"),
  },
  {
    label: "mixed derivation manifest",
    pattern: new RegExp(["\\.agents", "derivations\\.json"].join("/"), "u"),
  },
  {
    label: "mixed derivation lock",
    pattern: new RegExp(["\\.agents", "derivation-lock\\.json"].join("/"), "u"),
  },
  { label: "task-local state", pattern: new RegExp(["\\.ai", ""].join("/"), "u") },
];
const FORBIDDEN_ADAPTER_COMMAND = /["'](?:events|next|presence|progress)["']\s*,/u;

function resolveInside(repositoryRoot, repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    isAbsolute(repositoryPath)
  ) {
    throw new Error(`hook projection path must be relative: ${repositoryPath}`);
  }
  const resolved = resolve(repositoryRoot, repositoryPath);
  const fromRoot = relative(repositoryRoot, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`hook projection path escapes repository root: ${repositoryPath}`);
  }
  return resolved;
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function hashHookTree(rootDirectory) {
  if (!existsSync(rootDirectory)) return null;
  const digest = createHash("sha256");
  let fileCount = 0;

  function update(current, relativePath) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`hook projection trees cannot contain symlinks: ${current}`);
    }
    if (stat.isFile()) {
      fileCount += 1;
      digest.update(`file\0${relativePath}\0`);
      digest.update(readFileSync(current));
      digest.update("\0");
      return;
    }
    if (!stat.isDirectory()) throw new Error(`unsupported hook projection path type: ${current}`);
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

function listFiles(root) {
  const stat = lstatSync(root);
  if (stat.isSymbolicLink()) throw new Error(`hook boundary cannot inspect symlink: ${root}`);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) throw new Error(`unsupported hook boundary path type: ${root}`);
  return readdirSync(root, { withFileTypes: true })
    .sort((left, right) => compareNames(left.name, right.name))
    .flatMap((entry) => listFiles(resolve(root, entry.name)));
}

export function assertPortableHookBoundary(repositoryRoot) {
  for (const repositoryPath of BOUNDARY_SCAN_PATHS) {
    const root = resolveInside(repositoryRoot, repositoryPath);
    if (!existsSync(root)) throw new Error(`hook boundary input is missing: ${repositoryPath}`);
    for (const file of listFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of FORBIDDEN_REVERSE_EDGES) {
        if (forbidden.pattern.test(source)) {
          throw new Error(
            `forbidden hook reverse edge (${forbidden.label}): ${relative(repositoryRoot, file)}`,
          );
        }
      }
      if (file.endsWith(".mjs") && file.includes(`${sep}hooks${sep}v2${sep}`)) {
        if (FORBIDDEN_ADAPTER_COMMAND.test(source)) {
          throw new Error(
            `forbidden mutating or workspace-wide hook command: ${relative(repositoryRoot, file)}`,
          );
        }
      }
    }
  }
  return { protocol: "tweakloop.hook-portability-check/v1", status: "PASS" };
}

function readLock(repositoryRoot) {
  const lockPath = resolveInside(repositoryRoot, LOCK_PATH);
  if (!existsSync(lockPath)) return null;
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (
    lock.protocol !== LOCK_PROTOCOL ||
    typeof lock.canonicalSha256 !== "string" ||
    typeof lock.consumer !== "object" ||
    lock.consumer === null
  ) {
    throw new Error("invalid OSS hook projection lock");
  }
  return lock;
}

function writeLock(repositoryRoot, canonical, consumer) {
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
        consumer: {
          path: CONSUMER_PATH,
          sha256: consumer.sha256,
          files: consumer.files,
        },
      },
      null,
      2,
    )}\n`,
  );
  renameSync(temporary, lockPath);
}

function currentProjection(repositoryRoot) {
  const canonicalRoot = resolveInside(repositoryRoot, CANONICAL_PATH);
  const canonical = hashHookTree(canonicalRoot);
  if (!canonical) throw new Error(`canonical hook tree is missing: ${CANONICAL_PATH}`);
  const consumerRoot = resolveInside(repositoryRoot, CONSUMER_PATH);
  return { canonicalRoot, canonical, consumerRoot, consumer: hashHookTree(consumerRoot) };
}

export function checkHookProjection(repositoryRoot) {
  assertPortableHookBoundary(repositoryRoot);
  const projection = currentProjection(repositoryRoot);
  const lock = readLock(repositoryRoot);
  const failures = [];
  if (!projection.consumer) failures.push("missing consumer");
  else if (projection.consumer.sha256 !== projection.canonical.sha256) {
    failures.push("consumer bytes or file set differ from canonical");
  }
  if (!lock) failures.push("projection lock is missing");
  else {
    if (lock.canonicalSha256 !== projection.canonical.sha256) {
      failures.push("canonical differs from projection lock");
    }
    if (
      lock.consumer.path !== CONSUMER_PATH ||
      (projection.consumer && lock.consumer.sha256 !== projection.consumer.sha256)
    ) {
      failures.push("consumer differs from projection lock");
    }
  }
  return {
    protocol: CHECK_PROTOCOL,
    canonical: { path: CANONICAL_PATH, ...projection.canonical },
    consumer: {
      path: CONSUMER_PATH,
      ...(projection.consumer ?? {}),
      status: failures.length === 0 ? "PASS" : "FAIL",
      failures,
    },
    ok: failures.length === 0,
  };
}

export function syncHookProjection(repositoryRoot) {
  assertPortableHookBoundary(repositoryRoot);
  const projection = currentProjection(repositoryRoot);
  const lock = readLock(repositoryRoot);
  if (projection.consumer?.sha256 === projection.canonical.sha256) {
    writeLock(repositoryRoot, projection.canonical, projection.consumer);
    return {
      protocol: SYNC_PROTOCOL,
      canonical: { path: CANONICAL_PATH, ...projection.canonical },
      generated: [],
      consumer: { path: CONSUMER_PATH, ...projection.consumer },
    };
  }

  const consumerMatchesPrior =
    projection.consumer !== null &&
    lock?.consumer?.path === CONSUMER_PATH &&
    lock.consumer.sha256 === projection.consumer.sha256 &&
    lock.canonicalSha256 === lock.consumer.sha256;
  if (projection.consumer !== null && !consumerMatchesPrior) {
    throw new Error(`hand-edit drift blocks hook projection: ${CONSUMER_PATH}`);
  }

  mkdirSync(dirname(projection.consumerRoot), { recursive: true });
  const transactionId = randomUUID();
  const stage = resolve(dirname(projection.consumerRoot), `.hooks-stage-${transactionId}`);
  const backup = resolve(dirname(projection.consumerRoot), `.hooks-backup-${transactionId}`);
  let installed = false;
  let backedUp = false;
  let committed = false;
  try {
    cpSync(projection.canonicalRoot, stage, { recursive: true, errorOnExist: true });
    const stageHash = hashHookTree(stage);
    if (stageHash?.sha256 !== projection.canonical.sha256) {
      throw new Error(`staged hook projection failed verification: ${CONSUMER_PATH}`);
    }
    if (existsSync(projection.consumerRoot)) {
      renameSync(projection.consumerRoot, backup);
      backedUp = true;
    }
    renameSync(stage, projection.consumerRoot);
    installed = true;
    const consumer = hashHookTree(projection.consumerRoot);
    if (!consumer || consumer.sha256 !== projection.canonical.sha256) {
      throw new Error(`published hook projection failed verification: ${CONSUMER_PATH}`);
    }
    writeLock(repositoryRoot, projection.canonical, consumer);
    committed = true;
    if (backedUp) rmSync(backup, { recursive: true, force: true });
    return {
      protocol: SYNC_PROTOCOL,
      canonical: { path: CANONICAL_PATH, ...projection.canonical },
      generated: [CONSUMER_PATH],
      consumer: { path: CONSUMER_PATH, ...consumer },
    };
  } catch (error) {
    if (committed) throw error;
    if (installed) rmSync(projection.consumerRoot, { recursive: true, force: true });
    if (backedUp) renameSync(backup, projection.consumerRoot);
    if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

export { CANONICAL_PATH, CHECK_PROTOCOL, CONSUMER_PATH, LOCK_PATH, LOCK_PROTOCOL, SYNC_PROTOCOL };
