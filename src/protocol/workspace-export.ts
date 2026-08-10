import type { EventEnvelope } from "./envelopes.js";
import type { Snapshot, SnapshotRevision } from "./snapshot.js";
import { WORKSPACE_EXPORT_PROTOCOL } from "./versions.js";

const SHA256 = /^[a-f0-9]{64}$/;
export const WORKSPACE_EXPORT_MANIFEST_PATH = ".tweakloop/export-manifest.json";
export const WORKSPACE_EXPORT_OBJECT_PREFIX = ".tweakloop/objects/sha256";

export type WorkspaceExportSource = Readonly<{
  workspaceId: string;
  projectId: string;
  rootPath: string;
}>;

export type WorkspaceExportArtifact = Readonly<{
  artifactId: string;
  format: string;
  headRevisionId: string;
  headSeq: number;
  entryHash: string;
  exportedPath: string;
}>;

export type WorkspaceExportRevision = Readonly<{
  revisionId: string;
  artifactId: string;
  parentId: string | null;
  seq: number;
  format: string;
  entryPath: string;
  entryHash: string;
  objectPath: string;
  files: readonly WorkspaceExportRevisionFile[];
}>;

export type WorkspaceExportRevisionFile = Readonly<{
  path: string;
  hash: string;
  mediaType: string;
  /** Present on persisted exports; omitted only by the pre-fetch pure inventory plan. */
  byteLength?: number;
  objectPath: string;
}>;

export type WorkspaceExportAttachmentDescriptor = Readonly<{
  hash: string;
  fileName: string;
  mediaType: string;
  byteLength: number;
}>;

export type WorkspaceExportAttachment = Readonly<{
  descriptor: WorkspaceExportAttachmentDescriptor;
  objectPath: string;
}>;

export type WorkspaceExportWhiteboardObject = Readonly<{
  hash: string;
  mediaType: string;
  byteLength: number;
  objectPath: string;
}>;

export type WorkspaceExportWhiteboardSemanticReceipt = Readonly<{
  receipt: unknown;
  draftId: string | null;
  sceneObject: WorkspaceExportWhiteboardObject;
  elementIndexObject: WorkspaceExportWhiteboardObject;
}>;

/**
 * A deterministic, portable capture of one workspace at `capturedSeq`.
 * Paths use forward slashes and are relative to the export directory.
 */
export type WorkspaceExportManifest = Readonly<{
  protocol: typeof WORKSPACE_EXPORT_PROTOCOL;
  source: WorkspaceExportSource;
  capturedSeq: number;
  artifacts: readonly WorkspaceExportArtifact[];
  revisions: readonly WorkspaceExportRevision[];
  attachments: readonly WorkspaceExportAttachment[];
  /** Added compatibly to v1; absent legacy manifests are interpreted as an empty collection. */
  whiteboardSemanticReceipts?: readonly WorkspaceExportWhiteboardSemanticReceipt[];
  events: readonly EventEnvelope[];
}>;

export type WorkspaceExportWrite = Readonly<{ path: string; hash: string }>;

export type WorkspaceExportPlan = Readonly<{
  manifest: WorkspaceExportManifest;
  writes: readonly WorkspaceExportWrite[];
}>;

export class WorkspaceExportPlanError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "WorkspaceExportPlanError";
    this.code = code;
    this.details = details;
  }
}

/** Pure semantic owner for capture validation, portable paths, manifest, and write order. */
export function planWorkspaceExport(
  input: Readonly<{
    expectedWorkspaceId: string;
    workspaceRoot: string;
    snapshot: Snapshot;
    listedEvents: readonly EventEnvelope[];
    whiteboardSemanticReceipts?: readonly WorkspaceExportWhiteboardSemanticReceipt[];
  }>,
): WorkspaceExportPlan {
  const workspaceRoot = normalizeAbsolutePath(input.workspaceRoot, "workspace root");
  const snapshotRoot = normalizeAbsolutePath(input.snapshot.workspace.rootPath, "snapshot root");
  if (input.snapshot.workspace.workspaceId !== input.expectedWorkspaceId) {
    throw planError(
      "workspace-export.workspace-mismatch",
      "daemon and snapshot identify different workspaces",
      {
        expectedWorkspaceId: input.expectedWorkspaceId,
        snapshotWorkspaceId: input.snapshot.workspace.workspaceId,
      },
    );
  }
  if (snapshotRoot !== workspaceRoot) {
    throw planError(
      "workspace-export.root-mismatch",
      "explicit workspace root does not match the daemon snapshot",
      {
        workspaceRoot,
        snapshotRoot,
      },
    );
  }
  const capturedSeq = requireSequence(input.snapshot.lastSeq, "snapshot.lastSeq", true);
  const events = capturedEvents(input.listedEvents, capturedSeq, input.expectedWorkspaceId);
  const revisions = [...input.snapshot.revisions].sort(compareRevisions);
  const manifestRevisions: WorkspaceExportRevision[] = revisions.map((revision) => {
    validateRevision(revision, capturedSeq);
    const files = revisionFiles(events, revision);
    return {
      revisionId: revision.revisionId,
      artifactId: revision.artifactId,
      parentId: revision.parentId,
      seq: revision.seq,
      format: revision.format,
      entryPath: revision.entryPath,
      entryHash: revision.entryHash,
      objectPath: objectPath(revision.entryHash),
      files,
    };
  });
  const byArtifact = groupRevisions(revisions);
  const artifacts: WorkspaceExportArtifact[] = [...input.snapshot.artifacts]
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    .map((artifact) => {
      const history = byArtifact.get(artifact.artifactId);
      const head = history?.[history.length - 1];
      if (!head) {
        throw planError(
          "workspace-export.artifact-head-missing",
          `artifact has no revision at captured seq ${capturedSeq}: ${artifact.artifactId}`,
          { artifactId: artifact.artifactId, capturedSeq },
        );
      }
      if (head.format !== artifact.format) {
        throw planError(
          "workspace-export.artifact-format-mismatch",
          `artifact ${artifact.artifactId} format does not match its head revision`,
          { artifactFormat: artifact.format, headFormat: head.format },
        );
      }
      return {
        artifactId: artifact.artifactId,
        format: head.format,
        headRevisionId: head.revisionId,
        headSeq: head.seq,
        entryHash: head.entryHash,
        exportedPath: exportedArtifactPath(
          workspaceRoot,
          artifact.sourcePath,
          artifact.artifactId,
          artifact.name,
          head,
        ),
      };
    });
  const attachments = collectAttachmentDescriptors(events).map((descriptor) => ({
    descriptor,
    objectPath: objectPath(descriptor.hash),
  }));
  const whiteboardSemanticReceipts = validateWhiteboardSemanticReceipts(
    input.whiteboardSemanticReceipts ?? [],
    input.expectedWorkspaceId,
    new Set(
      artifacts
        .filter((artifact) => artifact.format === "whiteboard")
        .map((artifact) => artifact.artifactId),
    ),
  );
  const manifest: WorkspaceExportManifest = {
    protocol: WORKSPACE_EXPORT_PROTOCOL,
    source: {
      workspaceId: input.snapshot.workspace.workspaceId,
      projectId: input.snapshot.workspace.projectId,
      rootPath: workspaceRoot,
    },
    capturedSeq,
    artifacts,
    revisions: manifestRevisions,
    attachments,
    whiteboardSemanticReceipts,
    events,
  };
  assertUniqueArtifactPaths(artifacts);
  const objectHashes = new Set([
    ...manifestRevisions.flatMap((revision) => revision.files.map((file) => file.hash)),
    ...attachments.map((attachment) => attachment.descriptor.hash),
    ...whiteboardSemanticReceipts.flatMap((entry) => [
      entry.sceneObject.hash,
      entry.elementIndexObject.hash,
    ]),
  ]);
  const writes = [
    ...artifacts.map((artifact) => ({ path: artifact.exportedPath, hash: artifact.entryHash })),
    ...[...objectHashes].map((hash) => ({ path: objectPath(hash), hash })),
  ].sort((left, right) => left.path.localeCompare(right.path));
  return { manifest, writes };
}

function validateWhiteboardSemanticReceipts(
  entries: readonly WorkspaceExportWhiteboardSemanticReceipt[],
  workspaceId: string,
  whiteboardArtifactIds: ReadonlySet<string>,
): WorkspaceExportWhiteboardSemanticReceipt[] {
  const seen = new Set<string>();
  return [...entries]
    .map((entry, index) => {
      const value = asRecord(entry, `whiteboard semantic receipt ${index}`);
      const receipt = asRecord(value.receipt, `whiteboard semantic receipt ${index}.receipt`);
      const receiptWorkspaceId = requireText(
        receipt.workspaceId,
        `whiteboard semantic receipt ${index}.workspaceId`,
      );
      const artifactId = requireText(
        receipt.artifactId,
        `whiteboard semantic receipt ${index}.artifactId`,
      );
      const idempotencyKey = requireText(
        receipt.idempotencyKey,
        `whiteboard semantic receipt ${index}.idempotencyKey`,
      );
      if (receiptWorkspaceId !== workspaceId || !whiteboardArtifactIds.has(artifactId)) {
        throw planError(
          "workspace-export.semantic-receipt-foreign",
          `semantic receipt ${artifactId}/${idempotencyKey} does not belong to this whiteboard workspace`,
        );
      }
      const identity = `${artifactId}\0${idempotencyKey}`;
      if (seen.has(identity)) {
        throw planError(
          "workspace-export.semantic-receipt-duplicate",
          `duplicate semantic receipt ${artifactId}/${idempotencyKey}`,
        );
      }
      seen.add(identity);
      if (value.draftId !== null) {
        requireText(value.draftId, `whiteboard semantic receipt ${index}.draftId`);
      }
      const responseJson = requireText(
        receipt.responseJson,
        `whiteboard semantic receipt ${index}.responseJson`,
      );
      let response: Record<string, unknown>;
      try {
        response = asRecord(JSON.parse(responseJson), "whiteboard semantic receipt response");
      } catch {
        throw planError(
          "workspace-export.semantic-receipt-invalid",
          `semantic receipt ${artifactId}/${idempotencyKey} has invalid response JSON`,
        );
      }
      const sceneObject = validateWhiteboardObject(
        value.sceneObject,
        `whiteboard semantic receipt ${index}.sceneObject`,
        response.sceneHash,
      );
      const elementIndexObject = validateWhiteboardObject(
        value.elementIndexObject,
        `whiteboard semantic receipt ${index}.elementIndexObject`,
        response.elementIndexHash,
      );
      return {
        receipt: value.receipt,
        draftId: value.draftId as string | null,
        sceneObject,
        elementIndexObject,
      };
    })
    .sort((left, right) => {
      const leftReceipt = left.receipt as { artifactId: string; idempotencyKey: string };
      const rightReceipt = right.receipt as { artifactId: string; idempotencyKey: string };
      return (
        leftReceipt.artifactId.localeCompare(rightReceipt.artifactId) ||
        leftReceipt.idempotencyKey.localeCompare(rightReceipt.idempotencyKey)
      );
    });
}

function validateWhiteboardObject(
  input: unknown,
  field: string,
  expectedHash: unknown,
): WorkspaceExportWhiteboardObject {
  const value = asRecord(input, field);
  const hash = requireHash(requireText(value.hash, `${field}.hash`), `${field}.hash`);
  if (hash !== expectedHash) {
    throw planError(
      "workspace-export.semantic-receipt-object-mismatch",
      `${field} does not match the complete semantic receipt response`,
    );
  }
  const path = requireText(value.objectPath, `${field}.objectPath`);
  if (path !== objectPath(hash)) {
    throw planError(
      "workspace-export.semantic-receipt-object-mismatch",
      `${field}.objectPath does not match its hash`,
    );
  }
  return {
    hash,
    mediaType: requireText(value.mediaType, `${field}.mediaType`),
    byteLength: requireByteLength(value.byteLength),
    objectPath: path,
  };
}

function revisionFiles(
  events: readonly EventEnvelope[],
  revision: SnapshotRevision,
): WorkspaceExportRevisionFile[] {
  const event = events.find(
    (candidate) =>
      candidate.eventType === "artifact.revision-published" &&
      asOptionalRecord(candidate.payload)?.revisionId === revision.revisionId,
  );
  const payload = asOptionalRecord(event?.payload);
  const rawFiles = payload?.files;
  if (rawFiles === undefined) {
    return [
      {
        path: portablePath(revision.entryPath),
        hash: requireHash(revision.entryHash, `revision ${revision.revisionId} entryHash`),
        mediaType: defaultEntryMediaType(revision.format),
        objectPath: objectPath(revision.entryHash),
      },
    ];
  }
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    throw planError(
      "workspace-export.revision-files-invalid",
      `revision ${revision.revisionId} files must be a non-empty array`,
    );
  }
  const paths = new Set<string>();
  const files = rawFiles.map((raw, index) => {
    const value = asRecord(raw, `revision ${revision.revisionId} file ${index}`);
    const path = portablePath(requireText(value.path, "revision file path"));
    const key = path.normalize("NFC").toLowerCase();
    if (paths.has(key)) {
      throw planError(
        "workspace-export.revision-files-invalid",
        `revision ${revision.revisionId} repeats file path ${path}`,
      );
    }
    paths.add(key);
    const hash = requireHash(requireText(value.hash, "revision file hash"), "revision file hash");
    return {
      path,
      hash,
      mediaType: requireText(value.mediaType, "revision file mediaType"),
      objectPath: objectPath(hash),
    };
  });
  const entry = files.find((file) => file.path === portablePath(revision.entryPath));
  if (!entry || entry.hash !== revision.entryHash) {
    throw planError(
      "workspace-export.revision-entry-mismatch",
      `revision ${revision.revisionId} files do not contain its declared entry hash`,
    );
  }
  return files;
}

function defaultEntryMediaType(format: string): string {
  if (format === "markdown") return "text/markdown";
  if (format === "whiteboard") return "application/vnd.excalidraw+json";
  return "text/html";
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function capturedEvents(
  listed: readonly EventEnvelope[],
  capturedSeq: number,
  workspaceId: string,
): EventEnvelope[] {
  const captured = [...listed]
    .filter((event) => event.seq <= capturedSeq)
    .sort((left, right) => left.seq - right.seq);
  for (let index = 0; index < captured.length; index += 1) {
    const event = captured[index];
    const expected = index + 1;
    if (!event || requireSequence(event.seq, `events[${index}].seq`, false) !== expected) {
      throw planError(
        "workspace-export.events-incomplete",
        `captured event log diverges at seq ${expected}`,
      );
    }
    if (event.workspaceId !== workspaceId) {
      throw planError(
        "workspace-export.event-workspace-mismatch",
        `event ${event.seq} belongs to another workspace`,
      );
    }
  }
  if (captured.length !== capturedSeq) {
    throw planError(
      "workspace-export.events-incomplete",
      `captured event log ends at ${captured.length}, expected ${capturedSeq}`,
    );
  }
  return captured;
}

function validateRevision(revision: SnapshotRevision, capturedSeq: number): void {
  const seq = requireSequence(revision.seq, `revision ${revision.revisionId} seq`, false);
  if (seq > capturedSeq) {
    throw planError(
      "workspace-export.revision-after-snapshot",
      `revision ${revision.revisionId} is newer than captured seq ${capturedSeq}`,
    );
  }
  requireHash(revision.entryHash, `revision ${revision.revisionId} entryHash`);
}

function groupRevisions(revisions: readonly SnapshotRevision[]): Map<string, SnapshotRevision[]> {
  const result = new Map<string, SnapshotRevision[]>();
  for (const revision of revisions) {
    const values = result.get(revision.artifactId) ?? [];
    values.push(revision);
    result.set(revision.artifactId, values);
  }
  return result;
}

function exportedArtifactPath(
  workspaceRoot: string,
  sourcePath: string | null,
  artifactId: string,
  artifactName: string,
  head: SnapshotRevision,
): string {
  const fallbackName = safeSegment(
    lastSegment(head.entryPath),
    `${safeSegment(artifactName, "artifact")}.${head.format}`,
  );
  if (sourcePath === null) {
    return `.tweakloop/artifacts/${safeSegment(artifactId, "artifact")}/${fallbackName}`;
  }
  const source = normalizeAbsolutePath(sourcePath, "artifact source path");
  if (source.startsWith(`${workspaceRoot}/`)) {
    return portablePath(source.slice(workspaceRoot.length + 1));
  }
  return `external/${safeSegment(artifactId, "artifact")}/${safeSegment(lastSegment(source), fallbackName)}`;
}

function collectAttachmentDescriptors(
  events: readonly EventEnvelope[],
): WorkspaceExportAttachmentDescriptor[] {
  const byHash = new Map<string, WorkspaceExportAttachmentDescriptor>();
  for (const event of events) {
    if (event.eventType !== "chat.message") continue;
    const payload = asRecord(event.payload, `chat.message event ${event.seq} payload`);
    if (payload.attachments === undefined) continue;
    if (!Array.isArray(payload.attachments)) {
      throw planError(
        "workspace-export.attachment-descriptor-invalid",
        `chat.message event ${event.seq} attachments must be an array`,
      );
    }
    for (const [index, raw] of payload.attachments.entries()) {
      const value = asRecord(raw, `chat.message event ${event.seq} attachment ${index}`);
      const descriptor = {
        hash: requireText(value.hash, "attachment hash"),
        fileName: requireText(value.fileName, "attachment fileName"),
        mediaType: requireText(value.mediaType, "attachment mediaType"),
        byteLength: requireByteLength(value.byteLength),
      };
      requireHash(descriptor.hash, "attachment hash");
      const existing = byHash.get(descriptor.hash);
      if (existing && !sameDescriptor(existing, descriptor)) {
        throw planError(
          "workspace-export.attachment-descriptor-conflict",
          `attachment hash has conflicting descriptors: ${descriptor.hash}`,
        );
      }
      byHash.set(descriptor.hash, descriptor);
    }
  }
  return [...byHash.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

function assertUniqueArtifactPaths(artifacts: readonly WorkspaceExportArtifact[]): void {
  const owners = new Map<string, string>();
  for (const artifact of artifacts) {
    const path = artifact.exportedPath;
    if (
      path === WORKSPACE_EXPORT_MANIFEST_PATH ||
      path.startsWith(`${WORKSPACE_EXPORT_OBJECT_PREFIX}/`)
    ) {
      throw planError(
        "workspace-export.path-collision",
        `artifact output collides with reserved export data: ${path}`,
      );
    }
    const key = path.normalize("NFC").toLowerCase();
    const prior = owners.get(key);
    if (prior)
      throw planError(
        "workspace-export.path-collision",
        `portable output paths collide: ${prior} and ${path}`,
      );
    owners.set(key, path);
  }
}

function normalizeAbsolutePath(value: string, field: string): string {
  const normalized = value.replaceAll("\\", "/");
  const drive = normalized.match(/^([A-Za-z]:)\//)?.[1];
  if (!normalized.startsWith("/") && drive === undefined) {
    throw planError("workspace-export.source-path-invalid", `${field} must be absolute: ${value}`);
  }
  const prefix = drive ? `${drive.toUpperCase()}/` : "/";
  const body = drive ? normalized.slice(3) : normalized.slice(1);
  const segments: string[] = [];
  for (const segment of body.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0)
        throw planError("workspace-export.path-escape", `${field} escapes its root`);
      segments.pop();
    } else if (segment.includes("\0")) {
      throw planError("workspace-export.path-escape", `${field} contains NUL bytes`);
    } else {
      segments.push(segment);
    }
  }
  return `${prefix}${segments.join("/")}`.replace(/\/$/, "") || prefix;
}

function portablePath(value: string): string {
  const segments = value.replaceAll("\\", "/").split("/").filter(Boolean);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === "." || segment === ".." || segment.includes("\0"))
  ) {
    throw planError("workspace-export.path-escape", `unsafe portable export path: ${value}`);
  }
  return segments.join("/");
}

function safeSegment(value: unknown, fallback: string): string {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/[\\/:*?"<>|]/g, "-")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/^\.+$/, "")
    .trim();
  return normalized || fallback;
}

function lastSegment(value: string): string {
  return value.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) ?? "artifact";
}

function objectPath(hash: string): string {
  requireHash(hash, "object hash");
  return `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${hash}`;
}

function requireHash(value: string, field: string): string {
  if (!SHA256.test(value))
    throw planError("workspace-export.hash-invalid", `${field} must be a lowercase SHA-256 hash`);
  return value;
}

function requireSequence(value: number, field: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw planError(
      "workspace-export.sequence-invalid",
      `${field} must be a ${allowZero ? "non-negative" : "positive"} safe integer`,
    );
  }
  return value;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw planError(
      "workspace-export.attachment-descriptor-invalid",
      `${field} must be a non-empty string without NUL bytes`,
    );
  }
  return value;
}

function requireByteLength(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw planError(
      "workspace-export.attachment-descriptor-invalid",
      "attachment byteLength must be a non-negative safe integer",
    );
  }
  return Number(value);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw planError("workspace-export.attachment-descriptor-invalid", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function sameDescriptor(
  left: WorkspaceExportAttachmentDescriptor,
  right: WorkspaceExportAttachmentDescriptor,
): boolean {
  return (
    left.hash === right.hash &&
    left.fileName === right.fileName &&
    left.mediaType === right.mediaType &&
    left.byteLength === right.byteLength
  );
}

function compareRevisions(left: SnapshotRevision, right: SnapshotRevision): number {
  return left.seq - right.seq || left.revisionId.localeCompare(right.revisionId);
}

function planError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): WorkspaceExportPlanError {
  return new WorkspaceExportPlanError(code, message, details);
}
