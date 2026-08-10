import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { EventEnvelope } from "../protocol/envelopes.js";
import type { Snapshot } from "../protocol/snapshot.js";
import {
  planWorkspaceExport,
  WORKSPACE_EXPORT_MANIFEST_PATH,
  WORKSPACE_EXPORT_OBJECT_PREFIX,
  type WorkspaceExportManifest,
  WorkspaceExportPlanError,
  type WorkspaceExportWhiteboardSemanticReceipt,
} from "../protocol/workspace-export.js";
import { WHITEBOARD_INDEX_MEDIA_TYPE, WHITEBOARD_SCENE_MEDIA_TYPE } from "../whiteboard/scene.js";
import {
  decodeSemanticSceneReceiptRecord,
  semanticSceneReceiptResponse,
} from "../whiteboard/semantic-scene.js";
import type { SemanticReceiptSnapshot } from "../whiteboard/semantic-store.js";
import {
  type DaemonConnection,
  fetchChatAttachment,
  fetchObject,
  fetchRevisionSource,
  getSnapshot,
  listEvents,
  listWhiteboardSemanticReceipts,
} from "./daemon-client.js";

const SHA256 = /^[a-f0-9]{64}$/;

export type WorkspaceExportClient = Readonly<{
  getSnapshot: (connection: DaemonConnection) => Promise<Snapshot>;
  listEvents: (connection: DaemonConnection, after: number) => Promise<EventEnvelope[]>;
  fetchRevisionSource: (connection: DaemonConnection, revisionId: string) => Promise<Buffer>;
  fetchObject?: (connection: DaemonConnection, hash: string) => Promise<Buffer>;
  fetchChatAttachment?: (connection: DaemonConnection, hash: string) => Promise<Buffer>;
  listWhiteboardSemanticReceipts: (
    connection: DaemonConnection,
  ) => Promise<SemanticReceiptSnapshot[]>;
}>;

const DEFAULT_CLIENT: WorkspaceExportClient = {
  getSnapshot,
  listEvents,
  fetchRevisionSource,
  fetchObject,
  fetchChatAttachment,
  listWhiteboardSemanticReceipts,
};

export class WorkspaceExportError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "WorkspaceExportError";
    this.code = code;
    this.details = details;
  }
}

/**
 * Fetch and verify immutable bytes, then execute the protocol-owned pure plan.
 * The destination is created only after every required byte is verified, and
 * its manifest remains the final exclusive write.
 */
export async function exportWorkspace(
  connection: DaemonConnection,
  workspaceRoot: string,
  destination: string,
  client: WorkspaceExportClient = DEFAULT_CLIENT,
): Promise<WorkspaceExportManifest> {
  const destinationRoot = resolve(destination);
  if (pathExists(destinationRoot)) {
    throw new WorkspaceExportError(
      "workspace-export.destination-exists",
      `export destination already exists: ${destinationRoot}`,
      { destination: destinationRoot },
    );
  }

  const explicitRoot = resolve(workspaceRoot);
  const snapshot = await client.getSnapshot(connection);
  const listedEvents = await client.listEvents(connection, 0);
  const verifiedObjects = new Map<string, Buffer>();
  const whiteboardSemanticReceipts = await prepareWhiteboardSemanticReceipts(
    connection,
    await client.listWhiteboardSemanticReceipts(connection),
    client,
    verifiedObjects,
  );
  const plan = safelyPlan({
    expectedWorkspaceId: connection.descriptor.workspaceId,
    workspaceRoot: explicitRoot,
    snapshot,
    listedEvents,
    whiteboardSemanticReceipts,
  });

  for (const revision of plan.manifest.revisions) {
    for (const file of revision.files) {
      if (verifiedObjects.has(file.hash)) continue;
      const bytes = client.fetchObject
        ? await client.fetchObject(connection, file.hash)
        : file.hash === revision.entryHash
          ? await client.fetchRevisionSource(connection, revision.revisionId)
          : null;
      if (!bytes) {
        throw new WorkspaceExportError(
          "workspace-export.revision-object-fetch-unavailable",
          `revision ${revision.revisionId} contains a non-entry object that cannot be fetched`,
          { revisionId: revision.revisionId, path: file.path, hash: file.hash },
        );
      }
      verifyHash(bytes, file.hash, "revision object", `${revision.revisionId}:${file.path}`);
      verifiedObjects.set(file.hash, bytes);
    }
  }

  if (plan.manifest.attachments.length > 0 && !client.fetchChatAttachment) {
    throw new WorkspaceExportError(
      "workspace-export.attachment-fetch-unavailable",
      "captured chat attachments cannot be exported without fetchChatAttachment",
      { attachmentCount: plan.manifest.attachments.length },
    );
  }
  for (const attachment of plan.manifest.attachments) {
    const descriptor = attachment.descriptor;
    const bytes = await client.fetchChatAttachment?.(connection, descriptor.hash);
    if (!bytes) {
      throw new WorkspaceExportError(
        "workspace-export.attachment-fetch-unavailable",
        `chat attachment fetch returned no bytes: ${descriptor.hash}`,
      );
    }
    verifyHash(bytes, descriptor.hash, "attachment", descriptor.fileName);
    if (bytes.byteLength !== descriptor.byteLength) {
      throw new WorkspaceExportError(
        "workspace-export.attachment-size-mismatch",
        `chat attachment size does not match its descriptor: ${descriptor.fileName}`,
        { expected: descriptor.byteLength, actual: bytes.byteLength, hash: descriptor.hash },
      );
    }
    verifiedObjects.set(descriptor.hash, bytes);
  }

  const manifest: WorkspaceExportManifest = {
    ...plan.manifest,
    revisions: plan.manifest.revisions.map((revision) => ({
      ...revision,
      files: revision.files.map((file) => ({
        ...file,
        byteLength: verifiedObjects.get(file.hash)?.byteLength ?? file.byteLength ?? 0,
      })),
    })),
  };

  for (const write of plan.writes) {
    if (!verifiedObjects.has(write.hash)) {
      throw new WorkspaceExportError(
        "workspace-export.revision-object-missing",
        `verified object is unavailable for planned path: ${write.path}`,
        { path: write.path, hash: write.hash },
      );
    }
  }

  createDestination(destinationRoot);
  for (const write of plan.writes) {
    const bytes = verifiedObjects.get(write.hash);
    if (!bytes) throw new Error(`planner invariant failed for ${write.hash}`);
    writeExclusive(destinationRoot, write.path, bytes);
  }
  writeExclusive(
    destinationRoot,
    WORKSPACE_EXPORT_MANIFEST_PATH,
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
  );
  return manifest;
}

async function prepareWhiteboardSemanticReceipts(
  connection: DaemonConnection,
  snapshots: readonly SemanticReceiptSnapshot[],
  client: WorkspaceExportClient,
  verifiedObjects: Map<string, Buffer>,
): Promise<WorkspaceExportWhiteboardSemanticReceipt[]> {
  if (snapshots.length > 0 && !client.fetchObject) {
    throw new WorkspaceExportError(
      "workspace-export.semantic-receipt-object-fetch-unavailable",
      "semantic whiteboard receipts cannot be exported without object fetch support",
    );
  }
  const entries: WorkspaceExportWhiteboardSemanticReceipt[] = [];
  for (const snapshot of snapshots) {
    const receipt = decodeSemanticSceneReceiptRecord(snapshot.receipt);
    const response = semanticSceneReceiptResponse(receipt);
    const sceneBytes = await fetchVerifiedSemanticObject(
      connection,
      response.sceneHash,
      client,
      verifiedObjects,
    );
    const indexBytes = await fetchVerifiedSemanticObject(
      connection,
      response.elementIndexHash,
      client,
      verifiedObjects,
    );
    entries.push({
      receipt,
      draftId: snapshot.draftId,
      sceneObject: {
        hash: response.sceneHash,
        mediaType: WHITEBOARD_SCENE_MEDIA_TYPE,
        byteLength: sceneBytes.byteLength,
        objectPath: `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${response.sceneHash}`,
      },
      elementIndexObject: {
        hash: response.elementIndexHash,
        mediaType: WHITEBOARD_INDEX_MEDIA_TYPE,
        byteLength: indexBytes.byteLength,
        objectPath: `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${response.elementIndexHash}`,
      },
    });
  }
  return entries;
}

async function fetchVerifiedSemanticObject(
  connection: DaemonConnection,
  hash: string,
  client: WorkspaceExportClient,
  verifiedObjects: Map<string, Buffer>,
): Promise<Buffer> {
  const existing = verifiedObjects.get(hash);
  if (existing) return existing;
  const bytes = await client.fetchObject?.(connection, hash);
  if (!bytes) {
    throw new WorkspaceExportError(
      "workspace-export.semantic-receipt-object-fetch-unavailable",
      `semantic whiteboard receipt object cannot be fetched: ${hash}`,
    );
  }
  verifyHash(bytes, hash, "semantic whiteboard receipt object", hash);
  verifiedObjects.set(hash, bytes);
  return bytes;
}

function safelyPlan(input: Parameters<typeof planWorkspaceExport>[0]) {
  try {
    return planWorkspaceExport(input);
  } catch (error) {
    if (!(error instanceof WorkspaceExportPlanError)) throw error;
    throw new WorkspaceExportError(error.code, error.message, error.details);
  }
}

function createDestination(destinationRoot: string): void {
  try {
    mkdirSync(destinationRoot, { mode: 0o700 });
  } catch (error) {
    if (hasCode(error, "EEXIST")) {
      throw new WorkspaceExportError(
        "workspace-export.destination-exists",
        `export destination already exists: ${destinationRoot}`,
        { destination: destinationRoot },
      );
    }
    throw error;
  }
}

function writeExclusive(destinationRoot: string, portable: string, bytes: Buffer): void {
  const outputPath = resolve(destinationRoot, ...portable.split("/"));
  const outputRelative = relative(destinationRoot, outputPath);
  if (
    outputRelative === "" ||
    outputRelative === ".." ||
    outputRelative.startsWith(`..${sep}`) ||
    isAbsolute(outputRelative)
  ) {
    throw new WorkspaceExportError(
      "workspace-export.path-escape",
      `export path escapes destination: ${portable}`,
      { destinationRoot, portable },
    );
  }
  mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(outputPath, bytes, { flag: "wx", mode: 0o600 });
}

function verifyHash(bytes: Buffer, expected: string, kind: string, identity: string): void {
  if (!SHA256.test(expected)) {
    throw new WorkspaceExportError(
      "workspace-export.hash-invalid",
      `${kind} hash must be a lowercase SHA-256 hash`,
      { expected },
    );
  }
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    throw new WorkspaceExportError(
      "workspace-export.hash-mismatch",
      `${kind} bytes failed SHA-256 verification: ${identity}`,
      { kind, identity, expected, actual },
    );
  }
}

function pathExists(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
