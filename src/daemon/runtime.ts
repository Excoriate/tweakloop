import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/**
 * Identity is not location: the workspace id is derived from the
 * resolved root path only as a stable local handle; durable identity
 * lives in the event store and .tweakloop/project.json.
 */
export function workspaceIdFor(rootPath: string): string {
  const resolved = canonicalWorkspacePath(rootPath);
  return `ws_${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
}

/**
 * Canonicalizes a not-yet-created destination through its deepest real
 * ancestor. The resulting identity is byte-identical after the suffix is
 * published, including when an ancestor is a symlink.
 */
export function canonicalWorkspacePath(rootPath: string): string {
  let cursor = resolve(rootPath);
  const suffix: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error("workspace destination has no real ancestor");
    suffix.unshift(basename(cursor));
    cursor = parent;
  }
  return join(realpathSync(cursor), ...suffix);
}

export function stateDirFor(workspaceId: string): string {
  return join(tweakloopStateRoot(), "workspaces", workspaceId);
}

export function tweakloopStateRoot(): string {
  const base =
    process.env.TWEAKLOOP_STATE_DIR ??
    process.env.XDG_STATE_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : join(homedir(), ".local", "state"));
  return join(base, "tweakloop");
}

export function restoredWorkspaceRoot(bundleId: string): string {
  if (!/^bundle_[a-f0-9]{64}$/.test(bundleId) && !/^restore_[a-f0-9]{24}$/.test(bundleId)) {
    throw new Error("invalid workspace bundle id");
  }
  return join(tweakloopStateRoot(), "restored", bundleId, "workspace");
}

/** Ephemeral runtime descriptor — a locator, never authoritative state. */
export type RestoreGenerationIdentity = Readonly<{
  journalId: string;
  rootGenerationHash: string;
  stateGenerationHash: string;
}>;

export type RuntimeDescriptor = Readonly<{
  pid: number;
  startNonce: string;
  shellPort: number;
  artifactPort: number;
  protocolVersion: number;
  workspaceId: string;
  cliToken: string;
  restoreGeneration?: RestoreGenerationIdentity | null;
}>;

export type RuntimeIdentityObservation =
  | Readonly<{ status: "absent" }>
  | Readonly<{ status: "dead" | "live-no-ready" | "alien"; descriptor: RuntimeDescriptor }>
  | Readonly<{ status: "ready"; descriptor: RuntimeDescriptor }>;

export function runtimePath(workspaceId: string): string {
  return join(stateDirFor(workspaceId), "runtime.json");
}

export function readRuntime(workspaceId: string): RuntimeDescriptor | null {
  try {
    return JSON.parse(readFileSync(runtimePath(workspaceId), "utf8")) as RuntimeDescriptor;
  } catch {
    return null;
  }
}

export function writeRuntime(descriptor: RuntimeDescriptor): void {
  const dir = stateDirFor(descriptor.workspaceId);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `runtime.json.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, runtimePath(descriptor.workspaceId));
  chmodSync(runtimePath(descriptor.workspaceId), 0o600);
}

export function removeRuntime(workspaceId: string, expectedStartNonce: string): boolean {
  const descriptor = readRuntime(workspaceId);
  if (!descriptor || descriptor.startNonce !== expectedStartNonce) return false;
  rmSync(runtimePath(workspaceId), { force: true });
  return true;
}

/** A runtime descriptor is trusted only when the live daemon confirms its nonce. */
export async function discoverHealthyRuntime(
  workspaceId: string,
  expected?: Readonly<{ startNonce: string; restoreGeneration: RestoreGenerationIdentity }>,
): Promise<RuntimeDescriptor | null> {
  const observation = await inspectRuntimeIdentity(workspaceId, expected);
  return observation.status === "ready" ? observation.descriptor : null;
}

export async function inspectRuntimeIdentity(
  workspaceId: string,
  expected?: Readonly<{ startNonce: string; restoreGeneration: RestoreGenerationIdentity }>,
): Promise<RuntimeIdentityObservation> {
  const descriptor = readRuntime(workspaceId);
  if (!descriptor) return { status: "absent" };
  if (
    expected !== undefined &&
    (descriptor.startNonce !== expected.startNonce ||
      canonicalGeneration(descriptor.restoreGeneration ?? null) !==
        canonicalGeneration(expected.restoreGeneration))
  ) {
    return { status: "alien", descriptor };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${descriptor.shellPort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) {
      return processIsAlive(descriptor.pid)
        ? { status: "live-no-ready", descriptor }
        : { status: "dead", descriptor };
    }
    const health = (await res.json()) as {
      startNonce?: string;
      restoreGeneration?: RestoreGenerationIdentity | null;
    };
    if (
      health.startNonce !== descriptor.startNonce ||
      canonicalGeneration(health.restoreGeneration ?? null) !==
        canonicalGeneration(descriptor.restoreGeneration ?? null)
    ) {
      return { status: "alien", descriptor };
    }
    return { status: "ready", descriptor };
  } catch {
    return processIsAlive(descriptor.pid)
      ? { status: "live-no-ready", descriptor }
      : { status: "dead", descriptor };
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function canonicalGeneration(value: RestoreGenerationIdentity | null): string {
  return value === null
    ? "null"
    : JSON.stringify({
        journalId: value.journalId,
        rootGenerationHash: value.rootGenerationHash,
        stateGenerationHash: value.stateGenerationHash,
      });
}

export type ProjectConfig = Readonly<{ projectId: string; schemaVersion: number }>;

/**
 * .tweakloop/project.json carries logical project identity across
 * clones and worktrees; it is safe to commit and holds no secrets.
 */
export function ensureProjectConfig(rootPath: string): ProjectConfig {
  const dir = join(rootPath, ".tweakloop");
  const path = join(dir, "project.json");
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      projectId: string;
      schemaVersion: number;
    };
    return { projectId: parsed.projectId, schemaVersion: parsed.schemaVersion };
  }
  const config = {
    $schema: "https://tweakloop.dev/schemas/project/v1.json",
    projectId: randomUUID(),
    schemaVersion: 1,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return { projectId: config.projectId, schemaVersion: config.schemaVersion };
}
