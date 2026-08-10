import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const DERIVATION_TYPES = new Set([
  "identity-copy",
  "native-import",
  "package-projection",
  "schema-adapter",
]);
const DERIVATION_MODES = new Set(["generate", "validate-only", "planned"]);
const TYPE_MODES = new Map([
  ["identity-copy", new Set(["generate", "validate-only"])],
  ["native-import", new Set(["generate", "planned"])],
  ["package-projection", new Set(["generate"])],
  ["schema-adapter", new Set(["generate", "planned"])],
]);
const GENERATED_CONSUMERS = new Set([
  ".claude/settings.json",
  ".claude/skills",
  ".codex/hooks.json",
  ".cursor/hooks.json",
  "AGENTS.md",
  "CLAUDE.md",
  "skills",
]);
const REQUIRED_FIELDS = [
  "id",
  "type",
  "mode",
  "source",
  "consumer",
  "generator",
  "validator",
  "activation",
  "rollback",
  "deletion",
];

export function resolveInside(repositoryRoot, repositoryPath) {
  if (
    typeof repositoryPath !== "string" ||
    repositoryPath.length === 0 ||
    isAbsolute(repositoryPath)
  ) {
    throw new Error(`repository path must be a non-empty relative path: ${repositoryPath}`);
  }
  const resolved = resolve(repositoryRoot, repositoryPath);
  const fromRoot = relative(repositoryRoot, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`repository path escapes the repository root: ${repositoryPath}`);
  }
  return resolved;
}

export function readDerivationManifest(repositoryRoot) {
  const manifestPath = resolveInside(repositoryRoot, ".agents/derivations.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.schemaVersion !== "tweakloop.agent-derivations/v1") {
    throw new Error(`unsupported agent derivation manifest: ${manifest.schemaVersion}`);
  }
  if (!new Set(["shadow", "activate"]).has(manifest.phase)) {
    throw new Error(`unsupported agent derivation phase: ${manifest.phase}`);
  }
  if (manifest.canonicalRoot !== ".agents") {
    throw new Error(`shadow canonical root must be .agents: ${manifest.canonicalRoot}`);
  }
  if (!Array.isArray(manifest.derivations) || manifest.derivations.length === 0) {
    throw new Error("agent derivation manifest has no derivations");
  }

  const ids = new Set();
  for (const row of manifest.derivations) {
    for (const field of REQUIRED_FIELDS) {
      const value = row[field];
      if (
        value === undefined ||
        value === null ||
        (typeof value === "string" && value.trim().length === 0) ||
        (typeof value === "object" && Object.keys(value).length === 0)
      ) {
        throw new Error(`derivation ${row.id ?? "<unknown>"} is missing ${field}`);
      }
    }
    if (!DERIVATION_TYPES.has(row.type)) {
      throw new Error(`derivation ${row.id} has unsupported type ${row.type}`);
    }
    if (!DERIVATION_MODES.has(row.mode)) {
      throw new Error(`derivation ${row.id} has unsupported mode ${row.mode}`);
    }
    if (!TYPE_MODES.get(row.type)?.has(row.mode)) {
      throw new Error(`derivation ${row.id} cannot use ${row.type} in ${row.mode} mode`);
    }
    if (ids.has(row.id)) throw new Error(`duplicate derivation id: ${row.id}`);
    ids.add(row.id);
    const source = resolveInside(repositoryRoot, row.source);
    const consumer = resolveInside(repositoryRoot, row.consumer);
    if (!row.source.startsWith(".agents/")) {
      throw new Error(`derivation ${row.id} source is outside the canonical shadow: ${row.source}`);
    }
    if (!existsSync(source)) {
      throw new Error(`derivation ${row.id} source is missing: ${row.source}`);
    }
    if (
      typeof row.activation.status !== "string" ||
      typeof row.activation.proof !== "string" ||
      row.activation.proof.trim().length === 0
    ) {
      throw new Error(`derivation ${row.id} has an invalid activation contract`);
    }
    if (row.mode === "generate") {
      if (!GENERATED_CONSUMERS.has(row.consumer)) {
        throw new Error(`agent generator refuses undeclared consumer: ${row.consumer}`);
      }
      const consumerFromSource = relative(source, consumer);
      const sourceFromConsumer = relative(consumer, source);
      if (
        consumerFromSource === "" ||
        (!consumerFromSource.startsWith(`..${sep}`) && consumerFromSource !== "..") ||
        (!sourceFromConsumer.startsWith(`..${sep}`) && sourceFromConsumer !== "..")
      ) {
        throw new Error(`derivation ${row.id} source and consumer overlap`);
      }
    }
  }

  return manifest;
}

export function listTreeFiles(rootDirectory, directory = rootDirectory) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error(`derived trees cannot contain symlinks: ${directory}`);
  if (!stat.isDirectory()) return [relative(rootDirectory, directory) || "."];

  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = resolve(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`derived trees cannot contain symlinks: ${fullPath}`);
    return entry.isDirectory()
      ? listTreeFiles(rootDirectory, fullPath)
      : [relative(rootDirectory, fullPath)];
  });
}

export function hashPath(path) {
  const hash = createHash("sha256");

  function update(current, relativePath) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink\0${relativePath}\0${readlinkSync(current)}\0`);
      return;
    }
    if (stat.isFile()) {
      hash.update(`file\0${relativePath}\0`);
      hash.update(readFileSync(current));
      hash.update("\0");
      return;
    }
    if (!stat.isDirectory()) throw new Error(`unsupported derived path type: ${current}`);
    hash.update(`dir\0${relativePath}\0`);
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      update(
        `${current}/${entry.name}`,
        relativePath ? `${relativePath}/${entry.name}` : entry.name,
      );
    }
  }

  update(path, "");
  return hash.digest("hex");
}

export function hashBytes(bytes) {
  return createHash("sha256").update("file\0\0").update(bytes).update("\0").digest("hex");
}

export { DERIVATION_TYPES, GENERATED_CONSUMERS, REQUIRED_FIELDS };
