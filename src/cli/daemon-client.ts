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
import type { AgentSessionSnapshot } from "../protocol/agent-session.js";
import type { ChatAttachment } from "../protocol/chat.js";
import type { CommandEnvelope, CommandResult, EventEnvelope } from "../protocol/envelopes.js";
import type {
  SessionListResponse,
  SessionRecord,
  SessionStatus,
} from "../protocol/session-lineage.js";
import type { Snapshot, SnapshotChatMessage } from "../protocol/snapshot.js";
import type { SemanticReceiptSnapshot } from "../whiteboard/semantic-store.js";

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
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(new URL(path, connection.baseUrl), {
    method,
    headers: {
      authorization: `Bearer ${connection.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const record = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
    const message =
      typeof record?.code === "string" && record.error !== undefined
        ? `${record.code}: ${String(record.error)}`
        : record?.error !== undefined
          ? String(record.error)
          : typeof record?.code === "string" && typeof record.message === "string"
            ? `${record.code}: ${record.message}`
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
  return postCommandResult(connection, "/api/v1/commands", envelope);
}

async function postCommandResult(
  connection: DaemonConnection,
  path: string,
  body: unknown,
): Promise<CommandResult> {
  const res = await fetch(new URL(path, connection.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as CommandResult | { error: string };
  if ("status" in data) return data;
  throw new Error(data.error ?? `${res.status} ${res.statusText}`);
}

export async function getSnapshot(connection: DaemonConnection): Promise<Snapshot> {
  return request<Snapshot>(connection, "GET", "/api/v1/snapshot");
}

export async function listWhiteboardSemanticReceipts(
  connection: DaemonConnection,
): Promise<SemanticReceiptSnapshot[]> {
  return request<SemanticReceiptSnapshot[]>(
    connection,
    "GET",
    "/api/v1/whiteboard-semantic-receipts",
  );
}

export async function getQuestion(
  connection: DaemonConnection,
  messageId: string,
  signal?: AbortSignal,
): Promise<SnapshotChatMessage> {
  return request<SnapshotChatMessage>(
    connection,
    "GET",
    `/api/v1/question?message=${encodeURIComponent(messageId)}`,
    undefined,
    signal,
  );
}

export async function listEvents(
  connection: DaemonConnection,
  after: number,
): Promise<EventEnvelope[]> {
  return request<EventEnvelope[]>(connection, "GET", `/api/v1/events?after=${after}`);
}

export type PublishResult = Readonly<{
  artifactId: string;
  revisionId: string;
  seq: number;
  unchanged: boolean;
}>;

export async function publishArtifact(
  connection: DaemonConnection,
  path: string,
  actor?: Readonly<{ kind: string; id: string }>,
  sessionId?: string,
  artifactId?: string,
): Promise<PublishResult> {
  return request<PublishResult>(connection, "POST", "/api/v1/publish", {
    path,
    actor,
    sessionId,
    artifactId,
  });
}

export type ExistingSessionOpenResult = Readonly<{
  protocol: "tweakloop.session-open/v1";
  sessionId: string;
  artifactId: string;
  revisionId: string;
  seq: number;
  created: boolean;
  unchanged: boolean;
  alreadyAttached: boolean;
  attachedRevisionId: string;
}>;

export async function openArtifactInSession(
  connection: DaemonConnection,
  input: Readonly<{
    sessionId: string;
    path: string;
    requestId: string;
    expectedContentSha256: string;
    role: "primary" | "opened" | "whiteboard";
    actor: Readonly<{ kind: string; id: string }>;
  }>,
): Promise<ExistingSessionOpenResult> {
  return request(connection, "POST", "/api/v1/sessions/open-artifact", input);
}

export async function attachArtifactToSession(
  connection: DaemonConnection,
  input: Readonly<{
    sessionId: string;
    artifactId: string;
    revisionId: string;
    requestId: string;
    role: "primary" | "opened" | "whiteboard";
    actor: Readonly<{ kind: string; id: string }>;
  }>,
): Promise<CommandResult> {
  return postCommandResult(connection, "/api/v1/sessions/attach-artifact", input);
}

export type SessionUrlMint = Readonly<{
  protocol: "tweakloop.session-url/v1";
  url: string;
  artifactId: string | null;
  agentId: string | null;
  sessionId: string | null;
}>;

export async function mintSessionUrl(
  connection: DaemonConnection,
  input: Readonly<{ sessionId: string; artifactId?: string; agentId?: string }>,
): Promise<SessionUrlMint> {
  return request(connection, "POST", "/api/v1/sessions/url", input);
}

export async function listSessions(
  connection: DaemonConnection,
  filters: Readonly<{ artifactId?: string; agentId?: string; status?: SessionStatus }> = {},
): Promise<SessionListResponse> {
  const params = new URLSearchParams();
  if (filters.artifactId) params.set("artifact", filters.artifactId);
  if (filters.agentId) params.set("agent", filters.agentId);
  if (filters.status) params.set("status", filters.status);
  const query = params.size > 0 ? `?${params}` : "";
  return request(connection, "GET", `/api/v1/sessions${query}`);
}

export async function getSession(
  connection: DaemonConnection,
  sessionId: string,
): Promise<Readonly<{ protocol: string; session: SessionRecord }>> {
  return request(connection, "GET", `/api/v1/sessions/${encodeURIComponent(sessionId)}`);
}

export type BootstrapMint = Readonly<{
  url: string;
  artifactId: string | null;
  agentId: string | null;
  sessionId: string | null;
}>;

export async function mintBootstrap(
  connection: DaemonConnection,
  context: Readonly<{
    artifactId?: string;
    agentId?: string;
    sessionId?: string;
  }> = {},
): Promise<BootstrapMint> {
  return request<BootstrapMint>(connection, "POST", "/api/v1/bootstrap-tokens", context);
}

export async function mintBootstrapUrl(connection: DaemonConnection): Promise<string> {
  return (await mintBootstrap(connection)).url;
}

export async function getAgentSessionSnapshot(
  connection: DaemonConnection,
  input: Readonly<{
    agentId: string;
    processNonce: string;
    sessionId?: string;
    artifactId?: string;
  }>,
): Promise<AgentSessionSnapshot> {
  const params = new URLSearchParams({ agent: input.agentId, process: input.processNonce });
  if (input.sessionId) params.set("session", input.sessionId);
  if (input.artifactId) params.set("artifact", input.artifactId);
  return request<AgentSessionSnapshot>(
    connection,
    "GET",
    `/api/v1/agent-session/snapshot?${params}`,
  );
}

export async function claimWorkWithLease(
  connection: DaemonConnection,
  input: Readonly<{
    agentId: string;
    claimId: string;
    processNonce: string;
    workId?: string;
    ttlMs?: number;
  }>,
): Promise<CommandResult> {
  return request<CommandResult>(connection, "POST", "/api/v1/work/claim", input);
}

export async function heartbeatWorkLease(
  connection: DaemonConnection,
  input: Readonly<{
    workId: string;
    claimId: string;
    agentId: string;
    processNonce: string;
    ttlMs?: number;
  }>,
): Promise<{ ok: true; expiresAt: number }> {
  return request(connection, "POST", "/api/v1/work/heartbeat", input);
}

export async function recoverWorkLease(
  connection: DaemonConnection,
  input: Readonly<{
    workId: string;
    staleClaimId: string;
    claimId: string;
    agentId: string;
    processNonce: string;
    ttlMs?: number;
  }>,
): Promise<CommandResult> {
  return request<CommandResult>(connection, "POST", "/api/v1/work/recover", input);
}

export async function requestShutdown(connection: DaemonConnection): Promise<void> {
  await request(connection, "POST", "/api/v1/shutdown");
}

export type RestoreResult = Readonly<{
  artifactId: string;
  restoredFrom: string;
  revisionId: string;
  seq: number;
  unchanged: boolean;
}>;

export async function restoreRevision(
  connection: DaemonConnection,
  revisionId: string,
  actor?: Readonly<{ kind: string; id: string }>,
): Promise<RestoreResult> {
  return request<RestoreResult>(connection, "POST", "/api/v1/restore", { revisionId, actor });
}

export async function fetchRevisionSource(
  connection: DaemonConnection,
  revisionId: string,
): Promise<Buffer> {
  const res = await fetch(new URL(`/api/v1/revisions/${revisionId}/source`, connection.baseUrl), {
    headers: { authorization: `Bearer ${connection.token}` },
  });
  if (!res.ok) {
    throw new Error(`revision source fetch failed: ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function fetchObject(connection: DaemonConnection, hash: string): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("object hash must be 64 lowercase hex characters");
  }
  const res = await fetch(new URL(`/api/v1/objects/${hash}`, connection.baseUrl), {
    headers: { authorization: `Bearer ${connection.token}` },
  });
  if (!res.ok) throw new Error(`object fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function uploadChatAttachment(
  connection: DaemonConnection,
  input: Readonly<{ bytes: Buffer; fileName: string; mediaType: string }>,
): Promise<ChatAttachment> {
  const res = await fetch(new URL("/api/v1/chat/attachments", connection.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": input.mediaType,
      "x-tweakloop-filename": encodeURIComponent(input.fileName),
    },
    body: input.bytes,
  });
  const data = (await res.json()) as ChatAttachment | { error?: unknown; code?: unknown };
  if (!res.ok) {
    throw new Error(
      "error" in data && data.error !== undefined
        ? `${String(data.code ?? "attachment.error")}: ${String(data.error)}`
        : `chat attachment upload failed: ${res.status}`,
    );
  }
  return data as ChatAttachment;
}

export async function fetchChatAttachment(
  connection: DaemonConnection,
  hash: string,
): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("chat attachment hash must be 64 lowercase hex characters");
  }
  const res = await fetch(
    new URL(`/api/v1/chat/attachments/${encodeURIComponent(hash)}`, connection.baseUrl),
    { headers: { authorization: `Bearer ${connection.token}` } },
  );
  if (!res.ok) throw new Error(`chat attachment fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

export type WhiteboardDraftMetadata = Readonly<{
  protocol: "tweakloop.whiteboard-draft/v1";
  status: "accepted";
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  elementIndexHash: string;
  sceneUrl: string;
  publishedRevisionId: string | null;
}>;

export type WhiteboardDraftConflict = Readonly<{
  protocol: "tweakloop.whiteboard-draft/v1";
  status: "conflict";
  code: "whiteboard.draft-conflict";
  conflictId: string;
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  expectedDraftVersion: number;
  currentDraftVersion: number;
  submittedSceneHash: string;
  currentSceneHash: string;
}>;

export async function getWhiteboardDraft(
  connection: DaemonConnection,
  artifactId: string,
): Promise<WhiteboardDraftMetadata> {
  return request(connection, "GET", `/api/v1/whiteboards/${encodeURIComponent(artifactId)}/draft`);
}

export async function putWhiteboardDraft(
  connection: DaemonConnection,
  input: Readonly<{
    artifactId: string;
    draftId: string;
    baseRevisionId: string;
    expectedDraftVersion: number;
    clientId: string;
    clientSequence: number;
    agentId: string;
    bytes: Buffer;
    conflictId?: string;
  }>,
): Promise<WhiteboardDraftMetadata | WhiteboardDraftConflict> {
  const suffix = input.conflictId
    ? `/conflicts/${encodeURIComponent(input.conflictId)}/resolve`
    : "/draft";
  const res = await fetch(
    new URL(
      `/api/v1/whiteboards/${encodeURIComponent(input.artifactId)}${suffix}`,
      connection.baseUrl,
    ),
    {
      method: input.conflictId ? "POST" : "PUT",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/vnd.excalidraw+json",
        "x-tweakloop-draft-id": input.draftId,
        "x-tweakloop-base-revision": input.baseRevisionId,
        "x-tweakloop-expected-version": String(input.expectedDraftVersion),
        "x-tweakloop-client-id": input.clientId,
        "x-tweakloop-client-sequence": String(input.clientSequence),
        "x-tweakloop-agent-id": input.agentId,
      },
      body: input.bytes,
    },
  );
  const data = (await res.json()) as
    | WhiteboardDraftMetadata
    | WhiteboardDraftConflict
    | { error?: unknown; code?: unknown };
  if (res.ok || (res.status === 409 && "status" in data && data.status === "conflict")) {
    return data as WhiteboardDraftMetadata | WhiteboardDraftConflict;
  }
  throw new Error(
    "error" in data && data.error !== undefined
      ? `${String(data.code ?? "whiteboard.error")}: ${String(data.error)}`
      : `whiteboard draft request failed: ${res.status}`,
  );
}

export async function listWhiteboardConflicts(
  connection: DaemonConnection,
  artifactId: string,
): Promise<Readonly<{ protocol: string; artifactId: string; conflicts: readonly unknown[] }>> {
  return request(
    connection,
    "GET",
    `/api/v1/whiteboards/${encodeURIComponent(artifactId)}/conflicts`,
  );
}

export async function publishWhiteboardDraft(
  connection: DaemonConnection,
  input: Readonly<{
    artifactId: string;
    draftId: string;
    expectedDraftVersion: number;
    expectedHeadRevisionId: string;
    revisionId: string;
    agentId: string;
    commandId: string;
    idempotencyKey: string;
  }>,
): Promise<CommandResult> {
  return postCommand(connection, {
    protocol: "tweakloop.command/v1",
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    workspaceId: connection.descriptor.workspaceId,
    actor: { kind: "agent", id: input.agentId },
    type: "whiteboard.publish-draft",
    payload: {
      artifactId: input.artifactId,
      draftId: input.draftId,
      expectedDraftVersion: input.expectedDraftVersion,
      expectedHeadRevisionId: input.expectedHeadRevisionId,
      revisionId: input.revisionId,
    },
  });
}

export async function fetchWhiteboardObject(
  connection: DaemonConnection,
  hash: string,
): Promise<Buffer> {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("whiteboard object hash must be 64 lowercase hex characters");
  const res = await fetch(
    `http://127.0.0.1:${connection.descriptor.artifactPort}/objects/sha256/${hash}`,
  );
  if (!res.ok) throw new Error(`whiteboard object fetch failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
