import { spawn } from "node:child_process";
import { mkdirSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  discoverHealthyRuntime,
  type RuntimeDescriptor,
  stateDirFor,
  workspaceIdFor,
} from "../daemon/runtime.js";
import type { CommandEnvelope, CommandResult, EventEnvelope } from "../protocol/envelopes.js";
import type { Snapshot } from "../protocol/snapshot.js";

export type DaemonConnection = Readonly<{
  baseUrl: string;
  token: string;
  descriptor: RuntimeDescriptor;
}>;

export async function discoverDaemon(rootPath: string): Promise<DaemonConnection | null> {
  const descriptor = await discoverHealthyRuntime(workspaceIdFor(rootPath));
  if (!descriptor) return null;
  return {
    baseUrl: `http://127.0.0.1:${descriptor.shellPort}`,
    token: descriptor.cliToken,
    descriptor,
  };
}

const LOCK_STALE_MS = 30_000;

/**
 * Take the workspace startup lock. A holder that died keeps the lock
 * directory around; past the staleness window it is stolen rather than
 * blocking every future starter.
 */
export function tryAcquireStartupLock(rootPath: string): string | null {
  const stateDir = stateDirFor(workspaceIdFor(rootPath));
  mkdirSync(stateDir, { recursive: true });
  const lockDir = join(stateDir, "startup.lock");
  try {
    mkdirSync(lockDir);
    return lockDir;
  } catch {
    // Held by someone — alive or dead. Decide below.
  }
  const stat = statSync(lockDir, { throwIfNoEntry: false });
  const age = stat ? Date.now() - stat.mtimeMs : Number.POSITIVE_INFINITY;
  if (age <= LOCK_STALE_MS) return null;
  try {
    rmdirSync(lockDir);
    mkdirSync(lockDir);
    return lockDir;
  } catch {
    return null;
  }
}

export function releaseStartupLock(lockDir: string): void {
  try {
    rmdirSync(lockDir);
  } catch {
    // already released
  }
}

export async function ensureDaemon(rootPath: string): Promise<DaemonConnection> {
  const existing = await discoverDaemon(rootPath);
  if (existing) return existing;

  const lock = tryAcquireStartupLock(rootPath);
  try {
    if (lock) {
      const entry = fileURLToPath(new URL("../daemon/main.js", import.meta.url));
      spawn(process.execPath, [entry, rootPath], { detached: true, stdio: "ignore" }).unref();
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(200);
      const connection = await discoverDaemon(rootPath);
      if (connection) return connection;
    }
    const stateDir = stateDirFor(workspaceIdFor(rootPath));
    throw new Error(
      `daemon did not become healthy within 10s — see ${join(stateDir, "daemon.log")}`,
    );
  } finally {
    if (lock) releaseStartupLock(lock);
  }
}

async function request<T>(
  connection: DaemonConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(new URL(path, connection.baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new Error(message);
  }
  return data as T;
}

/**
 * Commands are special: a rejected CommandResult is a protocol value
 * (delivered with a 4xx status), not a transport failure.
 */
export async function postCommand(
  connection: DaemonConnection,
  envelope: CommandEnvelope,
): Promise<CommandResult> {
  const res = await fetch(new URL("/api/v1/commands", connection.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope),
  });
  const data = (await res.json()) as CommandResult | { error: string };
  if ("status" in data) return data;
  throw new Error(data.error ?? `${res.status} ${res.statusText}`);
}

export async function getSnapshot(connection: DaemonConnection): Promise<Snapshot> {
  return request<Snapshot>(connection, "GET", "/api/v1/snapshot");
}

export async function listEvents(
  connection: DaemonConnection,
  after: number,
): Promise<EventEnvelope[]> {
  return request<EventEnvelope[]>(connection, "GET", `/api/v1/events?after=${after}`);
}

export async function mintBootstrapUrl(connection: DaemonConnection): Promise<string> {
  const { url } = await request<{ url: string }>(connection, "POST", "/api/v1/bootstrap-tokens");
  return url;
}

export async function requestShutdown(connection: DaemonConnection): Promise<void> {
  await request(connection, "POST", "/api/v1/shutdown");
}
