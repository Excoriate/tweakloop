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
import { join } from "node:path";

/**
 * Identity is not location: the workspace id is derived from the
 * resolved root path only as a stable local handle; durable identity
 * lives in the event store and .tweakloop/project.json.
 */
export function workspaceIdFor(rootPath: string): string {
  const resolved = realpathSync(rootPath);
  return `ws_${createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
}

export function stateDirFor(workspaceId: string): string {
  const base =
    process.env.TWEAKLOOP_STATE_DIR ??
    process.env.XDG_STATE_HOME ??
    (process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : join(homedir(), ".local", "state"));
  return join(base, "tweakloop", "workspaces", workspaceId);
}

/** Ephemeral runtime descriptor — a locator, never authoritative state. */
export type RuntimeDescriptor = Readonly<{
  pid: number;
  startNonce: string;
  shellPort: number;
  artifactPort: number;
  protocolVersion: number;
  workspaceId: string;
  cliToken: string;
}>;

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

export function removeRuntime(workspaceId: string): void {
  rmSync(runtimePath(workspaceId), { force: true });
}

/** A runtime descriptor is trusted only when the live daemon confirms its nonce. */
export async function discoverHealthyRuntime(
  workspaceId: string,
): Promise<RuntimeDescriptor | null> {
  const descriptor = readRuntime(workspaceId);
  if (!descriptor) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${descriptor.shellPort}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return null;
    const health = (await res.json()) as { startNonce?: string };
    return health.startNonce === descriptor.startNonce ? descriptor : null;
  } catch {
    return null;
  }
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
