import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EventEnvelope } from "../protocol/envelopes.js";
import { WORKSPACE_EXPORT_PROTOCOL } from "../protocol/versions.js";
import {
  WORKSPACE_EXPORT_MANIFEST_PATH,
  WORKSPACE_EXPORT_OBJECT_PREFIX,
  type WorkspaceExportManifest,
} from "../protocol/workspace-export.js";
import { objectPath as runtimeObjectPath } from "../storage/object-store/index.js";
import { WHITEBOARD_INDEX_MEDIA_TYPE, WHITEBOARD_SCENE_MEDIA_TYPE } from "../whiteboard/scene.js";
import {
  decodeSemanticSceneReceiptRecord,
  rescopeSemanticSceneReceipt,
  type SemanticSceneReceiptRecord,
  semanticSceneReceiptResponse,
} from "../whiteboard/semantic-scene.js";
import type { SemanticReceiptSnapshot } from "../whiteboard/semantic-store.js";
import {
  validateWorkspaceBundleEnvelope,
  WORKSPACE_BUNDLE_ENVELOPE_PATH,
  WORKSPACE_FILES_MANIFEST_PATH,
} from "./files.js";

const SHA256 = /^[a-f0-9]{64}$/;
const BUNDLE_ID = /^bundle_[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MAX_EVENT_COUNT = 1_000_000;
const MAX_FILE_COUNT = 100_000;
const MAX_OBJECT_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

const SUPPORTED_EVENTS = new Set([
  "workspace.opened",
  "workspace.restored",
  "artifact.registered",
  "artifact.revision-published",
  "review.batch-submitted",
  "intent.created",
  "work.created",
  "work.claimed",
  "work.addressed",
  "work.progressed",
  "work.claim-released",
  "work.abandoned",
  "decision.accepted",
  "decision.reopened",
  "chat.message",
  "chat.delivery-offered",
  "chat.delivery-acknowledged",
  "chat.delivery-paused",
  "chat.delivery-resumed",
  "session.started",
  "session.artifact-attached",
  "session.handoff-offered",
  "session.ended",
]);

export type RestoreObjectDescriptor = Readonly<{
  hash: string;
  mediaType: string;
  byteLength: number;
  objectPath: string;
}>;

export type WorkspaceRestorePlan = Readonly<{
  manifest: WorkspaceExportManifest;
  collaborationManifestBytes: Buffer;
  bundleId: string;
  bundleMode: "bound-envelope" | "collaboration-only";
  manifestHash: string;
  restoreId: string;
  objects: readonly RestoreObjectDescriptor[];
  requiredPaths: readonly string[];
  semanticReceiptSnapshots: readonly SemanticReceiptSnapshot[];
}>;

export type CompletedWorkspaceRestore = Readonly<{
  plan: WorkspaceRestorePlan;
  objectBytes: ReadonlyMap<string, Buffer>;
}>;

export type InstalledWorkspaceRestore = Readonly<{
  rootPath: string;
  objectsDir: string;
  events: readonly EventEnvelope[];
  semanticReceiptSnapshots: readonly SemanticReceiptSnapshot[];
}>;

type WorkspaceRestoreInstallOptions = Readonly<{
  acceptedExistingArtifactHashes?: ReadonlyMap<string, string>;
}>;

export function loadWorkspaceRestoreBundle(bundleRoot: string): CompletedWorkspaceRestore {
  const root = resolve(bundleRoot);
  const validated = validateWorkspaceBundleEnvelope(root);
  const collaborationManifestBytes = readFileSync(
    safeJoin(root, validated.envelope.collaboration.manifestPath),
  );
  const plan = validateWorkspaceRestoreManifest(validated.collaborationManifest, {
    bundleId: validated.envelope.bundleId,
    collaborationManifestHash: validated.envelope.collaboration.manifestHash,
    collaborationManifestBytes,
  });
  const objectBytes = new Map<string, Buffer>();
  for (const descriptor of plan.objects) {
    const bytes = readFileSync(safeJoin(root, descriptor.objectPath));
    if (bytes.byteLength !== descriptor.byteLength || hash(bytes) !== descriptor.hash) {
      throw restoreError(
        "workspace-restore.bundle-object-corrupt",
        `bundle object failed exact validation: ${descriptor.objectPath}`,
        409,
      );
    }
    objectBytes.set(descriptor.hash, bytes);
  }
  return { plan, objectBytes };
}

export class WorkspaceRestoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceRestoreError";
  }
}

export type WorkspaceRestoreAuthority = Readonly<{
  bundleId: string;
  collaborationManifestHash: string;
  collaborationManifestBytes?: Buffer;
}>;

export function validateWorkspaceRestoreManifest(
  input: unknown,
  authority?: WorkspaceRestoreAuthority,
): WorkspaceRestorePlan {
  let manifestInput = input;
  if (authority?.collaborationManifestBytes) {
    const actualHash = hash(authority.collaborationManifestBytes);
    if (actualHash !== authority.collaborationManifestHash) {
      throw restoreError(
        "workspace-restore.binding-mismatch",
        "exact collaboration manifest bytes do not match the bound component hash",
        409,
      );
    }
    try {
      manifestInput = JSON.parse(authority.collaborationManifestBytes.toString("utf8"));
    } catch {
      throw restoreError(
        "workspace-restore.manifest-invalid",
        "exact collaboration manifest bytes are not valid JSON",
      );
    }
  }
  const manifest = requireRecord(manifestInput, "manifest") as unknown as WorkspaceExportManifest;
  if (manifest.protocol !== WORKSPACE_EXPORT_PROTOCOL) {
    throw restoreError("workspace-restore.protocol-unsupported", "unsupported export protocol");
  }
  const source = requireRecord(manifest.source, "manifest.source");
  requireId(source.workspaceId, "source workspaceId");
  requireId(source.projectId, "source projectId");
  requireText(source.rootPath, "source rootPath");
  requireSequence(manifest.capturedSeq, "capturedSeq", true);
  if (!Array.isArray(manifest.events) || manifest.events.length !== manifest.capturedSeq) {
    throw restoreError(
      "workspace-restore.events-incomplete",
      `event count must equal capturedSeq ${manifest.capturedSeq}`,
    );
  }
  if (manifest.events.length > MAX_EVENT_COUNT) {
    throw restoreError("workspace-restore.events-too-many", "export contains too many events");
  }
  validateEvents(manifest.events, source.workspaceId as string);
  validateAnswerChains(manifest.events);

  if (!Array.isArray(manifest.artifacts) || !Array.isArray(manifest.revisions)) {
    throw restoreError(
      "workspace-restore.manifest-invalid",
      "artifacts and revisions must be arrays",
    );
  }
  const artifactIds = new Set<string>();
  for (const artifact of manifest.artifacts) {
    requireId(artifact.artifactId, "artifactId");
    if (artifactIds.has(artifact.artifactId)) duplicate("artifact", artifact.artifactId);
    artifactIds.add(artifact.artifactId);
    requireId(artifact.headRevisionId, "headRevisionId");
    requireHash(artifact.entryHash, "artifact entryHash");
    const exportedPath = requirePortablePath(artifact.exportedPath, "artifact exportedPath");
    if (
      (exportedPath === ".tweakloop" || exportedPath.startsWith(".tweakloop/")) &&
      !exportedPath.startsWith(".tweakloop/artifacts/")
    ) {
      throw restoreError(
        "workspace-restore.path-reserved",
        "artifact output cannot overwrite Tweakloop metadata outside the managed artifact namespace",
      );
    }
  }

  const descriptors = new Map<string, RestoreObjectDescriptor>();
  const revisionIds = new Set<string>();
  const revisionById = new Map(
    manifest.revisions.map((revision) => [revision.revisionId, revision]),
  );
  for (const revision of manifest.revisions) {
    requireId(revision.revisionId, "revisionId");
    requireId(revision.artifactId, "revision artifactId");
    if (!artifactIds.has(revision.artifactId)) {
      throw restoreError(
        "workspace-restore.revision-artifact-missing",
        `revision ${revision.revisionId} references an unknown artifact`,
      );
    }
    if (revisionIds.has(revision.revisionId)) duplicate("revision", revision.revisionId);
    revisionIds.add(revision.revisionId);
    if (revision.parentId !== null && !revisionById.has(revision.parentId)) {
      throw restoreError(
        "workspace-restore.revision-parent-missing",
        `revision ${revision.revisionId} references missing parent ${revision.parentId}`,
      );
    }
    requireSequence(revision.seq, "revision seq", false);
    requireHash(revision.entryHash, "revision entryHash");
    requirePortablePath(revision.entryPath, "revision entryPath");
    if (!Array.isArray(revision.files) || revision.files.length === 0) {
      throw restoreError(
        "workspace-restore.revision-files-incomplete",
        `revision ${revision.revisionId} has no complete file inventory`,
      );
    }
    let entryPresent = false;
    const paths = new Set<string>();
    for (const file of revision.files) {
      const path = requirePortablePath(file.path, "revision file path");
      const pathKey = path.normalize("NFC").toLowerCase();
      if (paths.has(pathKey)) duplicate("revision file path", path);
      paths.add(pathKey);
      requireHash(file.hash, "revision file hash");
      const mediaType = requireText(file.mediaType, "revision file mediaType");
      const byteLength = requireByteLength(file.byteLength, "revision file byteLength");
      const objectPath = requireObjectPath(file.objectPath, file.hash);
      addDescriptor(descriptors, { hash: file.hash, mediaType, byteLength, objectPath });
      if (path === revision.entryPath && file.hash === revision.entryHash) entryPresent = true;
    }
    if (!entryPresent) {
      throw restoreError(
        "workspace-restore.revision-entry-mismatch",
        `revision ${revision.revisionId} does not inventory its declared entry`,
      );
    }
  }
  for (const artifact of manifest.artifacts) {
    const head = revisionById.get(artifact.headRevisionId);
    if (!head || head.artifactId !== artifact.artifactId || head.entryHash !== artifact.entryHash) {
      throw restoreError(
        "workspace-restore.artifact-head-mismatch",
        `artifact ${artifact.artifactId} head does not match revision history`,
      );
    }
  }

  if (!Array.isArray(manifest.attachments)) {
    throw restoreError("workspace-restore.manifest-invalid", "attachments must be an array");
  }
  for (const attachment of manifest.attachments) {
    const descriptor = requireRecord(attachment.descriptor, "attachment descriptor");
    const hash = requireHash(descriptor.hash, "attachment hash");
    const mediaType = requireText(descriptor.mediaType, "attachment mediaType");
    const byteLength = requireByteLength(descriptor.byteLength, "attachment byteLength");
    const objectPath = requireObjectPath(attachment.objectPath, hash);
    addDescriptor(descriptors, { hash, mediaType, byteLength, objectPath });
  }
  const semanticReceiptSnapshots = validateSemanticReceiptSnapshots(
    manifest,
    source.workspaceId as string,
    descriptors,
  );
  if (descriptors.size > MAX_FILE_COUNT) {
    throw restoreError("workspace-restore.files-too-many", "export contains too many objects");
  }
  const totalBytes = [...descriptors.values()].reduce((sum, item) => sum + item.byteLength, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
    throw restoreError("workspace-restore.total-too-large", "export exceeds the total size limit");
  }
  const normalizedManifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  const manifestBytes = authority?.collaborationManifestBytes ?? normalizedManifestBytes;
  const normalizedManifestHash = hash(normalizedManifestBytes);
  const manifestHash = authority?.collaborationManifestHash ?? normalizedManifestHash;
  if (!SHA256.test(manifestHash)) {
    throw restoreError(
      "workspace-restore.binding-invalid",
      "bound collaboration manifest hash must be lowercase SHA-256",
    );
  }
  const bundleId =
    authority?.bundleId ??
    `bundle_${hash(
      Buffer.from(`tweakloop.workspace-bundle/v1\0collaboration-only\0${manifestHash}`, "utf8"),
    )}`;
  if (!BUNDLE_ID.test(bundleId)) {
    throw restoreError(
      "workspace-restore.bundle-identity-invalid",
      "workspace bundle identity is invalid",
    );
  }
  return {
    manifest,
    collaborationManifestBytes: manifestBytes,
    bundleId,
    bundleMode: authority ? "bound-envelope" : "collaboration-only",
    manifestHash,
    restoreId: `restore_${manifestHash.slice(0, 24)}`,
    objects: [...descriptors.values()].sort((left, right) =>
      left.objectPath.localeCompare(right.objectPath),
    ),
    semanticReceiptSnapshots,
    requiredPaths: [...descriptors.values()]
      .map((item) => item.objectPath)
      .sort((left, right) => left.localeCompare(right)),
  };
}

export function createWorkspaceRestoreStore(baseDir: string) {
  const root = resolve(baseDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const browserFileDescriptors = new Map<
    string,
    ReadonlyMap<string, Readonly<{ hash: string; byteLength: number }>>
  >();

  function begin(input: unknown): WorkspaceRestorePlan {
    const request = parseRestoreBeginRequest(input);
    if ("boundBundle" in request) return beginBoundBundle(request.boundBundle);
    const plan = validateWorkspaceRestoreManifest(request.manifest, request.authority);
    const dir = stageDir(root, plan.bundleId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "plan.json");
    const bytes = restoreStagePlanBytes(plan);
    if (existsSync(path)) {
      const existing = readFileSync(path);
      if (!existing.equals(bytes)) {
        throw restoreError(
          "workspace-restore.idempotency-conflict",
          "restore id already exists with different manifest bytes",
          409,
        );
      }
    } else {
      writeAtomic(path, bytes);
    }
    if (plan.bundleMode === "collaboration-only") {
      const aliasDir = join(root, "aliases");
      mkdirSync(aliasDir, { recursive: true, mode: 0o700 });
      const aliasPath = join(aliasDir, `${plan.restoreId}.json`);
      const aliasBytes = Buffer.from(
        `${JSON.stringify({ restoreId: plan.restoreId, bundleId: plan.bundleId }, null, 2)}\n`,
        "utf8",
      );
      if (existsSync(aliasPath)) {
        if (!readFileSync(aliasPath).equals(aliasBytes)) {
          throw restoreError(
            "workspace-restore.idempotency-conflict",
            "legacy collaboration restore alias conflicts with another bundle",
            409,
          );
        }
      } else {
        writeAtomic(aliasPath, aliasBytes);
      }
    }
    return plan;
  }

  function beginBoundBundle(
    request: Readonly<{
      envelopeBytes: Buffer;
      collaborationManifestBytes: Buffer;
      workspaceFilesManifestBytes: Buffer | null;
    }>,
  ): WorkspaceRestorePlan {
    const temporaryStage = mkdtempSync(join(root, ".bound-restore-"));
    const temporaryBundle = join(temporaryStage, "bundle");
    mkdirSync(temporaryBundle, { mode: 0o700 });
    try {
      writeBundleComponent(temporaryBundle, WORKSPACE_BUNDLE_ENVELOPE_PATH, request.envelopeBytes);
      writeBundleComponent(
        temporaryBundle,
        WORKSPACE_EXPORT_MANIFEST_PATH,
        request.collaborationManifestBytes,
      );
      if (request.workspaceFilesManifestBytes !== null) {
        writeBundleComponent(
          temporaryBundle,
          `workspace-files/${WORKSPACE_FILES_MANIFEST_PATH}`,
          request.workspaceFilesManifestBytes,
        );
      }
      const validated = validateWorkspaceBundleEnvelope(temporaryBundle);
      const plan = validateWorkspaceRestoreManifest(validated.collaborationManifest, {
        bundleId: validated.envelope.bundleId,
        collaborationManifestHash: validated.envelope.collaboration.manifestHash,
        collaborationManifestBytes: request.collaborationManifestBytes,
      });
      writeAtomic(join(temporaryStage, "plan.json"), restoreStagePlanBytes(plan));
      const destination = stageDir(root, plan.bundleId);
      if (existsSync(destination)) {
        const existing = loadPlan(root, plan.bundleId);
        const existingBundle = browserStagedBundleRoot(root, plan.bundleId);
        if (
          existingBundle === null ||
          existing.bundleId !== plan.bundleId ||
          !readFileSync(join(existingBundle, WORKSPACE_BUNDLE_ENVELOPE_PATH)).equals(
            request.envelopeBytes,
          ) ||
          !readFileSync(join(existingBundle, WORKSPACE_EXPORT_MANIFEST_PATH)).equals(
            request.collaborationManifestBytes,
          )
        ) {
          throw restoreError(
            "workspace-restore.idempotency-conflict",
            "bound browser restore identity already exists with different component bytes",
            409,
          );
        }
        return existing;
      }
      renameSync(temporaryStage, destination);
      return plan;
    } finally {
      if (existsSync(temporaryStage)) rmSync(temporaryStage, { recursive: true, force: true });
    }
  }

  function put(bundleId: string, portablePath: string, bytes: Buffer): void {
    const plan = loadPlan(root, bundleId);
    const path = requirePortablePath(portablePath, "restore file path");
    const descriptor = plan.objects.find((item) => item.objectPath === path);
    const bundleRoot = browserStagedBundleRoot(root, plan.bundleId);
    const workspaceDescriptor =
      bundleRoot === null ? null : workspaceFileDescriptor(plan.bundleId, bundleRoot, path);
    const expected = descriptor ?? workspaceDescriptor;
    if (expected === null || expected === undefined) {
      throw restoreError(
        "workspace-restore.file-undeclared",
        `file is not declared by the bound restore bundle: ${path}`,
      );
    }
    if (bytes.byteLength !== expected.byteLength) {
      throw restoreError(
        "workspace-restore.size-mismatch",
        `file size does not match manifest: ${path}`,
      );
    }
    const actual = hash(bytes);
    if (actual !== expected.hash) {
      throw restoreError(
        "workspace-restore.hash-mismatch",
        `file hash does not match manifest: ${path}`,
      );
    }
    const destination = safeJoin(bundleRoot ?? stageDir(root, plan.bundleId), path);
    if (existsSync(destination)) {
      if (!readFileSync(destination).equals(bytes)) {
        throw restoreError(
          "workspace-restore.idempotency-conflict",
          `file was already uploaded with different bytes: ${path}`,
          409,
        );
      }
      return;
    }
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    writeAtomic(destination, bytes);
  }

  function complete(bundleId: string): CompletedWorkspaceRestore {
    const plan = loadPlan(root, bundleId);
    const bundleRoot = browserStagedBundleRoot(root, plan.bundleId);
    const objectBytes = new Map<string, Buffer>();
    for (const descriptor of plan.objects) {
      const path = safeJoin(bundleRoot ?? stageDir(root, plan.bundleId), descriptor.objectPath);
      if (!existsSync(path)) {
        throw restoreError(
          "workspace-restore.incomplete",
          `required file has not been uploaded: ${descriptor.objectPath}`,
          409,
        );
      }
      const bytes = readFileSync(path);
      if (bytes.byteLength !== descriptor.byteLength || hash(bytes) !== descriptor.hash) {
        throw restoreError(
          "workspace-restore.staged-file-corrupt",
          `staged file failed final verification: ${descriptor.objectPath}`,
          409,
        );
      }
      objectBytes.set(descriptor.hash, bytes);
    }
    if (bundleRoot !== null) validateUploadedBrowserBundle(bundleRoot, plan);
    return { plan, objectBytes };
  }

  function requiredPaths(bundleId: string): readonly string[] {
    const plan = loadPlan(root, bundleId);
    const bundleRoot = browserStagedBundleRoot(root, plan.bundleId);
    if (bundleRoot === null) return plan.requiredPaths;
    const validated = validateWorkspaceBundleEnvelope(bundleRoot);
    const workspacePaths =
      validated.workspaceFilesManifest?.files.map((file) => `workspace-files/${file.objectPath}`) ??
      [];
    return [...new Set([...plan.requiredPaths, ...workspacePaths])].sort((left, right) =>
      left.localeCompare(right),
    );
  }

  function boundBundleRoot(bundleId: string): string {
    const plan = loadPlan(root, bundleId);
    const bundleRoot = browserStagedBundleRoot(root, plan.bundleId);
    if (bundleRoot === null) {
      throw restoreError(
        "workspace-restore.bundle-root-required",
        "browser restore has no daemon-owned bound bundle root",
        400,
      );
    }
    validateUploadedBrowserBundle(bundleRoot, plan);
    return bundleRoot;
  }

  function workspaceFileDescriptor(
    bundleId: string,
    bundleRoot: string,
    portablePath: string,
  ): Readonly<{ hash: string; byteLength: number }> | null {
    let descriptors = browserFileDescriptors.get(bundleId);
    if (descriptors === undefined) {
      const validated = validateWorkspaceBundleEnvelope(bundleRoot);
      descriptors = new Map(
        (validated.workspaceFilesManifest?.files ?? []).map((file) => [
          `workspace-files/${file.objectPath}`,
          { hash: file.hash, byteLength: file.byteLength },
        ]),
      );
      browserFileDescriptors.set(bundleId, descriptors);
    }
    return descriptors.get(portablePath) ?? null;
  }

  return { begin, put, complete, requiredPaths, boundBundleRoot } as const;
}

function restoreStagePlanBytes(plan: WorkspaceRestorePlan): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        protocol: "tweakloop.workspace-restore-stage/v2",
        bundleId: plan.bundleId,
        bundleMode: plan.bundleMode,
        collaborationManifestHash: plan.manifestHash,
        collaborationManifestBase64: plan.collaborationManifestBytes.toString("base64"),
        manifest: plan.manifest,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function writeBundleComponent(bundleRoot: string, portablePath: string, bytes: Buffer): void {
  const destination = safeJoin(bundleRoot, portablePath);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeAtomic(destination, bytes);
}

function browserStagedBundleRoot(baseDir: string, bundleId: string): string | null {
  const bundleRoot = join(stageDir(baseDir, bundleId), "bundle");
  return existsSync(join(bundleRoot, WORKSPACE_BUNDLE_ENVELOPE_PATH)) ? bundleRoot : null;
}

function validateUploadedBrowserBundle(bundleRoot: string, plan: WorkspaceRestorePlan): void {
  const validated = validateWorkspaceBundleEnvelope(bundleRoot);
  const manifestBytes = readFileSync(safeJoin(bundleRoot, WORKSPACE_EXPORT_MANIFEST_PATH));
  if (
    validated.envelope.bundleId !== plan.bundleId ||
    validated.envelope.collaboration.manifestHash !== plan.manifestHash ||
    !manifestBytes.equals(plan.collaborationManifestBytes)
  ) {
    throw restoreError(
      "workspace-restore.binding-mismatch",
      "daemon-owned browser bundle differs from the validated restore plan",
      409,
    );
  }
  for (const file of validated.workspaceFilesManifest?.files ?? []) {
    const path = safeJoin(bundleRoot, `workspace-files/${file.objectPath}`);
    if (!existsSync(path)) {
      throw restoreError(
        "workspace-restore.incomplete",
        `required workspace file object has not been uploaded: workspace-files/${file.objectPath}`,
        409,
      );
    }
    const bytes = readFileSync(path);
    if (bytes.byteLength !== file.byteLength || hash(bytes) !== file.hash) {
      throw restoreError(
        "workspace-restore.staged-file-corrupt",
        `staged workspace file object failed final verification: workspace-files/${file.objectPath}`,
        409,
      );
    }
  }
}

export function installWorkspaceRestore(
  completed: CompletedWorkspaceRestore,
  destinationRoot: string,
  destinationObjectsDir: string,
  destinationWorkspaceId: string,
  logicalDestinationRoot: string = destinationRoot,
  options: WorkspaceRestoreInstallOptions = {},
): InstalledWorkspaceRestore {
  const plan = revalidateCompletedPlan(completed);
  const installRootPath = resolve(destinationRoot);
  const rootPath = resolve(logicalDestinationRoot);
  const objectsDir = resolve(destinationObjectsDir);
  mkdirSync(installRootPath, { recursive: true, mode: 0o700 });
  mkdirSync(objectsDir, { recursive: true, mode: 0o700 });

  const projectConfig = Buffer.from(
    `${JSON.stringify(
      {
        $schema: "https://tweakloop.dev/schemas/project/v1.json",
        projectId: plan.manifest.source.projectId,
        schemaVersion: 1,
        restoredFrom: {
          bundleId: plan.bundleId,
          workspaceId: plan.manifest.source.workspaceId,
          projectId: plan.manifest.source.projectId,
          rootPath: plan.manifest.source.rootPath,
          capturedSeq: plan.manifest.capturedSeq,
          manifestHash: plan.manifestHash,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  writeVerified(join(installRootPath, ".tweakloop", "project.json"), projectConfig);

  for (const descriptor of plan.objects) {
    const bytes = completed.objectBytes.get(descriptor.hash);
    if (!bytes) {
      throw restoreError(
        "workspace-restore.object-missing",
        `verified object bytes are unavailable: ${descriptor.hash}`,
      );
    }
    writeVerified(runtimeObjectPath(objectsDir, descriptor.hash), bytes);
  }
  const revisions = new Map(
    plan.manifest.revisions.map((revision) => [revision.revisionId, revision]),
  );
  for (const artifact of plan.manifest.artifacts) {
    const head = revisions.get(artifact.headRevisionId);
    if (!head) throw new Error(`validated head disappeared: ${artifact.headRevisionId}`);
    const bytes = completed.objectBytes.get(head.entryHash);
    if (!bytes) throw new Error(`validated entry object disappeared: ${head.entryHash}`);
    writeVerified(
      safeJoin(installRootPath, artifact.exportedPath),
      bytes,
      options.acceptedExistingArtifactHashes?.get(artifact.exportedPath),
    );
  }

  const projected = projectWorkspaceRestore(completed, rootPath, destinationWorkspaceId);
  return { rootPath, objectsDir, ...projected };
}

export function projectWorkspaceRestore(
  completed: CompletedWorkspaceRestore,
  logicalDestinationRoot: string,
  destinationWorkspaceId: string,
): Pick<InstalledWorkspaceRestore, "events" | "semanticReceiptSnapshots"> {
  const plan = revalidateCompletedPlan(completed);
  const rootPath = resolve(logicalDestinationRoot);
  const source = plan.manifest.source;
  const artifactPaths = new Map(
    plan.manifest.artifacts.map((artifact) => [
      artifact.artifactId,
      safeJoin(rootPath, artifact.exportedPath),
    ]),
  );
  const events = plan.manifest.events.map((event, index) => {
    if (index === 0) {
      return {
        ...event,
        workspaceId: destinationWorkspaceId,
        streamId: destinationWorkspaceId,
        eventType: "workspace.restored",
        payload: {
          type: "workspace.restored",
          workspaceId: destinationWorkspaceId,
          projectId: source.projectId,
          rootPath,
          sourceWorkspaceId: source.workspaceId,
          sourceProjectId: source.projectId,
          sourceRootPath: source.rootPath,
          capturedSeq: completed.plan.manifest.capturedSeq,
          bundleId: plan.bundleId,
        },
      };
    }
    const payload = requireRecord(event.payload, `event ${event.seq} payload`);
    const artifactId = typeof payload.artifactId === "string" ? payload.artifactId : null;
    const rebasedSourcePath =
      payload.sourcePath === null || payload.sourcePath === undefined
        ? payload.sourcePath
        : artifactId
          ? (artifactPaths.get(artifactId) ?? null)
          : null;
    return {
      ...event,
      workspaceId: destinationWorkspaceId,
      streamId: event.streamId === source.workspaceId ? destinationWorkspaceId : event.streamId,
      payload: {
        ...payload,
        ...(payload.workspaceId === source.workspaceId
          ? { workspaceId: destinationWorkspaceId }
          : {}),
        ...(payload.sourcePath !== undefined ? { sourcePath: rebasedSourcePath } : {}),
      },
    };
  });
  const semanticReceiptSnapshots = plan.semanticReceiptSnapshots.map((snapshot) => ({
    receipt: rescopeSemanticSceneReceipt(snapshot.receipt, destinationWorkspaceId),
    draftId:
      snapshot.draftId === null ? null : restoredDraftId(destinationWorkspaceId, snapshot.draftId),
  }));
  return { events, semanticReceiptSnapshots };
}

function revalidateCompletedPlan(completed: CompletedWorkspaceRestore): WorkspaceRestorePlan {
  const plan = validateWorkspaceRestoreManifest(
    completed.plan.manifest,
    completed.plan.bundleMode === "bound-envelope"
      ? {
          bundleId: completed.plan.bundleId,
          collaborationManifestHash: completed.plan.manifestHash,
          collaborationManifestBytes: completed.plan.collaborationManifestBytes,
        }
      : undefined,
  );
  if (
    plan.bundleId !== completed.plan.bundleId ||
    plan.bundleMode !== completed.plan.bundleMode ||
    plan.manifestHash !== completed.plan.manifestHash ||
    plan.restoreId !== completed.plan.restoreId
  ) {
    throw restoreError(
      "workspace-restore.stage-corrupt",
      "completed restore plan identity differs from its validated manifest",
      409,
    );
  }
  return plan;
}

function validateSemanticReceiptSnapshots(
  manifest: WorkspaceExportManifest,
  sourceWorkspaceId: string,
  descriptors: Map<string, RestoreObjectDescriptor>,
): SemanticReceiptSnapshot[] {
  const rawEntries = manifest.whiteboardSemanticReceipts ?? [];
  if (!Array.isArray(rawEntries)) {
    throw restoreError(
      "workspace-restore.semantic-receipts-invalid",
      "whiteboardSemanticReceipts must be an array",
    );
  }
  const artifactFormats = new Map(
    manifest.artifacts.map((artifact) => [artifact.artifactId, artifact.format]),
  );
  const seen = new Set<string>();
  return rawEntries.map((rawEntry, index) => {
    const entry = requireRecord(rawEntry, `whiteboard semantic receipt ${index}`);
    let receipt: SemanticSceneReceiptRecord;
    try {
      receipt = decodeSemanticSceneReceiptRecord(entry.receipt);
    } catch (error) {
      throw restoreError(
        "workspace-restore.semantic-receipt-invalid",
        `whiteboard semantic receipt ${index} is corrupt: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (
      receipt.workspaceId !== sourceWorkspaceId ||
      artifactFormats.get(receipt.artifactId) !== "whiteboard"
    ) {
      throw restoreError(
        "workspace-restore.semantic-receipt-foreign",
        `semantic receipt ${receipt.artifactId}/${receipt.idempotencyKey} does not belong to this source whiteboard workspace`,
      );
    }
    const identity = `${receipt.artifactId}\0${receipt.idempotencyKey}`;
    if (seen.has(identity)) duplicate("whiteboard semantic receipt", identity);
    seen.add(identity);
    const draftId = entry.draftId;
    if (draftId !== null) requireId(draftId, `whiteboard semantic receipt ${index} draftId`);
    if ((receipt.invalidation === null) !== (draftId === null)) {
      throw restoreError(
        "workspace-restore.semantic-receipt-draft-mapping-invalid",
        `semantic receipt ${receipt.artifactId}/${receipt.idempotencyKey} has an invalid draft mapping`,
      );
    }
    const response = semanticSceneReceiptResponse(receipt);
    addSemanticReceiptObject(
      descriptors,
      entry.sceneObject,
      response.sceneHash,
      WHITEBOARD_SCENE_MEDIA_TYPE,
      `whiteboard semantic receipt ${index} sceneObject`,
    );
    addSemanticReceiptObject(
      descriptors,
      entry.elementIndexObject,
      response.elementIndexHash,
      WHITEBOARD_INDEX_MEDIA_TYPE,
      `whiteboard semantic receipt ${index} elementIndexObject`,
    );
    return { receipt, draftId: draftId as string | null };
  });
}

function addSemanticReceiptObject(
  descriptors: Map<string, RestoreObjectDescriptor>,
  raw: unknown,
  expectedHash: string,
  expectedMediaType: string,
  field: string,
): void {
  const value = requireRecord(raw, field);
  const hash = requireHash(value.hash, `${field} hash`);
  const mediaType = requireText(value.mediaType, `${field} mediaType`);
  const byteLength = requireByteLength(value.byteLength, `${field} byteLength`);
  const objectPath = requireObjectPath(value.objectPath, hash);
  if (hash !== expectedHash || mediaType !== expectedMediaType) {
    throw restoreError(
      "workspace-restore.semantic-receipt-object-mismatch",
      `${field} does not match the complete semantic receipt response`,
    );
  }
  addDescriptor(descriptors, { hash, mediaType, byteLength, objectPath });
}

function restoredDraftId(destinationWorkspaceId: string, sourceDraftId: string): string {
  return `draft_restore_${createHash("sha256")
    .update(`${destinationWorkspaceId}\0${sourceDraftId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function parseRestoreBeginRequest(input: unknown):
  | Readonly<{
      manifest: unknown;
      authority?: WorkspaceRestoreAuthority;
    }>
  | Readonly<{
      boundBundle: Readonly<{
        envelopeBytes: Buffer;
        collaborationManifestBytes: Buffer;
        workspaceFilesManifestBytes: Buffer | null;
      }>;
    }> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { manifest: input };
  }
  const record = input as Record<string, unknown>;
  if (record.protocol === "tweakloop.workspace-restore-request/v3") {
    return {
      boundBundle: {
        envelopeBytes: decodeCanonicalBase64(
          record.bundleEnvelopeBase64,
          "restore request bundleEnvelopeBase64",
        ),
        collaborationManifestBytes: decodeCanonicalBase64(
          record.collaborationManifestBase64,
          "restore request collaborationManifestBase64",
        ),
        workspaceFilesManifestBytes:
          record.workspaceFilesManifestBase64 === null
            ? null
            : decodeCanonicalBase64(
                record.workspaceFilesManifestBase64,
                "restore request workspaceFilesManifestBase64",
              ),
      },
    };
  }
  if (record.protocol !== "tweakloop.workspace-restore-request/v2") {
    return { manifest: input };
  }
  const bundleId = requireText(record.bundleId, "restore request bundleId");
  const collaborationManifestHash = requireHash(
    record.collaborationManifestHash,
    "restore request collaborationManifestHash",
  );
  if (!BUNDLE_ID.test(bundleId)) {
    throw restoreError(
      "workspace-restore.bundle-identity-invalid",
      "workspace bundle identity is invalid",
    );
  }
  const collaborationManifestBytes = decodeCanonicalBase64(
    record.collaborationManifestBase64,
    "restore request collaborationManifestBase64",
  );
  return {
    manifest: null,
    authority: { bundleId, collaborationManifestHash, collaborationManifestBytes },
  };
}

function decodeCanonicalBase64(value: unknown, field: string): Buffer {
  const encoded = requireText(value, field);
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== encoded) {
    throw restoreError(
      "workspace-restore.manifest-encoding-invalid",
      `${field} must be canonical base64`,
    );
  }
  return bytes;
}

function loadPlan(baseDir: string, inputId: string): WorkspaceRestorePlan {
  let bundleId: string;
  if (BUNDLE_ID.test(inputId)) {
    bundleId = inputId;
  } else if (/^restore_[a-f0-9]{24}$/.test(inputId)) {
    const aliasPath = join(baseDir, "aliases", `${inputId}.json`);
    if (!existsSync(aliasPath)) {
      throw restoreError("workspace-restore.not-found", "unknown restore id", 404);
    }
    const alias = requireRecord(JSON.parse(readFileSync(aliasPath, "utf8")), "restore alias");
    if (alias.restoreId !== inputId || typeof alias.bundleId !== "string") {
      throw restoreError("workspace-restore.stage-corrupt", "restore alias is invalid", 409);
    }
    bundleId = alias.bundleId;
  } else {
    throw restoreError("workspace-restore.id-invalid", "invalid workspace bundle id", 404);
  }
  if (!BUNDLE_ID.test(bundleId)) {
    throw restoreError(
      "workspace-restore.stage-corrupt",
      "restore bundle identity is invalid",
      409,
    );
  }
  const path = join(stageDir(baseDir, bundleId), "plan.json");
  if (!existsSync(path)) {
    throw restoreError("workspace-restore.not-found", "unknown workspace bundle id", 404);
  }
  const staged = requireRecord(JSON.parse(readFileSync(path, "utf8")), "restore stage");
  if (staged.protocol !== "tweakloop.workspace-restore-stage/v2") {
    throw restoreError("workspace-restore.stage-corrupt", "restore stage protocol is invalid", 409);
  }
  const mode = staged.bundleMode;
  if (mode !== "bound-envelope" && mode !== "collaboration-only") {
    throw restoreError("workspace-restore.stage-corrupt", "restore stage mode is invalid", 409);
  }
  let collaborationManifestBytes: Buffer | undefined;
  if (mode === "bound-envelope") {
    const encoded = requireText(
      staged.collaborationManifestBase64,
      "staged collaborationManifestBase64",
    );
    collaborationManifestBytes = Buffer.from(encoded, "base64");
    if (
      collaborationManifestBytes.length === 0 ||
      collaborationManifestBytes.toString("base64") !== encoded
    ) {
      throw restoreError(
        "workspace-restore.stage-corrupt",
        "staged collaboration manifest encoding is invalid",
        409,
      );
    }
  }
  const plan = validateWorkspaceRestoreManifest(
    staged.manifest,
    mode === "bound-envelope"
      ? {
          bundleId: requireText(staged.bundleId, "staged bundleId"),
          collaborationManifestHash: requireHash(
            staged.collaborationManifestHash,
            "staged collaborationManifestHash",
          ),
          collaborationManifestBytes,
        }
      : undefined,
  );
  if (
    plan.bundleId !== bundleId ||
    plan.bundleMode !== mode ||
    plan.manifestHash !== staged.collaborationManifestHash
  ) {
    throw restoreError("workspace-restore.stage-corrupt", "restore manifest identity changed", 409);
  }
  return plan;
}

function validateEvents(events: readonly EventEnvelope[], sourceWorkspaceId: string): void {
  const eventIds = new Set<string>();
  const streamVersions = new Map<string, number>();
  for (const [index, event] of events.entries()) {
    const expectedSeq = index + 1;
    if (requireSequence(event.seq, `event ${expectedSeq} seq`, false) !== expectedSeq) {
      throw restoreError(
        "workspace-restore.events-incomplete",
        `event sequence diverges at ${expectedSeq}`,
      );
    }
    requireId(event.eventId, "eventId");
    if (eventIds.has(event.eventId)) duplicate("event", event.eventId);
    eventIds.add(event.eventId);
    if (event.workspaceId !== sourceWorkspaceId) {
      throw restoreError(
        "workspace-restore.event-workspace-mismatch",
        `event ${event.seq} belongs to another workspace`,
      );
    }
    requireId(event.streamType, "streamType");
    requireId(event.streamId, "streamId");
    if (!SUPPORTED_EVENTS.has(event.eventType)) {
      throw restoreError(
        "workspace-restore.event-unsupported",
        `unsupported event type: ${event.eventType}`,
      );
    }
    if (event.schemaVersion !== 1) {
      throw restoreError(
        "workspace-restore.event-schema-unsupported",
        `unsupported schema version for event ${event.seq}`,
      );
    }
    const payload = requireRecord(event.payload, `event ${event.seq} payload`);
    if (payload.type !== event.eventType) {
      throw restoreError(
        "workspace-restore.event-payload-mismatch",
        `event ${event.seq} payload type does not match its envelope`,
      );
    }
    // Stream versions are scoped by workspace + streamId in the event store. A logical
    // aggregate may deliberately change streamType while retaining that identity—for example,
    // artifact revisions followed by chat messages anchored to the same artifact. Restore must
    // validate the exact ordering contract the writer enforces, or valid exported histories fail.
    const streamKey = event.streamId;
    const expectedVersion = (streamVersions.get(streamKey) ?? 0) + 1;
    if (event.streamVersion !== expectedVersion) {
      throw restoreError(
        "workspace-restore.stream-version-invalid",
        `event ${event.seq} stream version must be ${expectedVersion}`,
      );
    }
    streamVersions.set(streamKey, expectedVersion);
    requireText(event.recordedAt, "recordedAt");
    const actor = requireRecord(event.actor, "event actor");
    if (!new Set(["human", "agent", "system"]).has(String(actor.kind))) {
      throw restoreError("workspace-restore.actor-invalid", `event ${event.seq} actor is invalid`);
    }
    requireText(actor.id, "actor id");
    optionalText(event.causationId, "causationId");
    optionalText(event.correlationId, "correlationId");
  }
  const first = events[0];
  if (first && !new Set(["workspace.opened", "workspace.restored"]).has(first.eventType)) {
    throw restoreError(
      "workspace-restore.first-event-invalid",
      "the first event must establish workspace provenance",
    );
  }
}

type ImportedSession = Readonly<{
  agentId: string;
  status: "active" | "handed-off" | "ended";
  handoffToAgentId: string | null;
}>;
type ImportedQuestion = Readonly<{
  messageId: string;
  seq: number;
  sessionId: string;
  optionKeys: ReadonlySet<string>;
}>;
type ImportedAnswer = Readonly<{
  messageId: string;
  questionMessageId: string;
  predecessorMessageId: string | null;
  sessionId: string;
  optionKey: string;
  seq: number;
}>;

function validateAnswerChains(events: readonly EventEnvelope[]): void {
  const sessions = new Map<string, ImportedSession>();
  const chatMessageIds = new Set<string>();
  const questions = new Map<string, ImportedQuestion>();
  const answers = new Map<string, ImportedAnswer>();
  for (const event of events) {
    if (event.eventType === "session.started") {
      const payload = requireRecord(event.payload, `event ${event.seq} payload`);
      const sessionId = requireId(payload.sessionId, `event ${event.seq} sessionId`);
      const agentId = requireSessionEventAuthority(event, payload);
      if (sessions.has(sessionId)) {
        throw restoreError(
          "workspace-restore.session-duplicate",
          `session ${sessionId} is started more than once`,
          400,
          { sessionId, eventSeq: event.seq },
        );
      }
      const predecessorSessionId =
        payload.predecessorSessionId === null
          ? null
          : requireId(payload.predecessorSessionId, `event ${event.seq} predecessorSessionId`);
      if (predecessorSessionId !== null) {
        const predecessor = sessions.get(predecessorSessionId);
        if (predecessor === undefined) {
          throw restoreError(
            "workspace-restore.session-predecessor-unknown",
            `resumed session ${sessionId} references unknown predecessor ${predecessorSessionId}`,
            400,
            { sessionId, predecessorSessionId, eventSeq: event.seq },
          );
        }
        const permitted =
          predecessor.agentId === agentId ||
          (predecessor.status === "handed-off" && predecessor.handoffToAgentId === agentId);
        if (!permitted) {
          throw restoreError(
            "workspace-restore.session-resume-not-authorized",
            `session ${predecessorSessionId} was not handed off to ${agentId}`,
            400,
            { sessionId, predecessorSessionId, agentId, eventSeq: event.seq },
          );
        }
      }
      sessions.set(sessionId, {
        agentId,
        status: "active",
        handoffToAgentId: null,
      });
      continue;
    }
    if (event.eventType === "session.handoff-offered" || event.eventType === "session.ended") {
      const payload = requireRecord(event.payload, `event ${event.seq} payload`);
      const sessionId = requireId(payload.sessionId, `event ${event.seq} sessionId`);
      const agentId = requireSessionEventAuthority(event, payload);
      const session = sessions.get(sessionId);
      if (session === undefined) {
        throw restoreError(
          "workspace-restore.session-transition-unknown",
          `${event.eventType} references unknown session ${sessionId}`,
          400,
          { sessionId, eventSeq: event.seq, eventType: event.eventType },
        );
      }
      if (session.agentId !== agentId) {
        throw restoreError(
          "workspace-restore.session-owner-mismatch",
          `agent ${agentId} does not own session ${sessionId}`,
          400,
          { sessionId, agentId, ownerAgentId: session.agentId, eventSeq: event.seq },
        );
      }
      if (session.status === "ended") {
        throw restoreError(
          "workspace-restore.session-transition-inactive",
          `session ${sessionId} has already ended`,
          400,
          { sessionId, eventSeq: event.seq, eventType: event.eventType },
        );
      }
      sessions.set(sessionId, {
        ...session,
        status: event.eventType === "session.ended" ? "ended" : "handed-off",
        handoffToAgentId:
          event.eventType === "session.handoff-offered"
            ? requireId(payload.toAgentId, `event ${event.seq} toAgentId`)
            : session.handoffToAgentId,
      });
      continue;
    }
    if (event.eventType !== "chat.message") continue;
    const payload = requireRecord(event.payload, `event ${event.seq} payload`);
    const messageId = requireId(payload.messageId, `event ${event.seq} messageId`);
    if (chatMessageIds.has(messageId)) duplicate("chat message", messageId);
    chatMessageIds.add(messageId);
    if (payload.content === undefined) continue;
    const content = requireRecord(payload.content, `event ${event.seq} chat content`);
    if (content.type !== "choice-question" && content.type !== "choice-answer") continue;
    const actor = requireRecord(event.actor, `event ${event.seq} actor`);
    const actorKind = requireText(actor.kind, `event ${event.seq} actor kind`);
    const actorId = requireText(actor.id, `event ${event.seq} actor id`);
    const author = requireText(payload.author, `event ${event.seq} author`);
    if (author !== `${actorKind}:${actorId}`) {
      throw restoreError(
        "workspace-restore.chat-actor-author-mismatch",
        `typed chat message ${messageId} author does not match its event actor`,
        400,
        { messageId, actorKind, actorId, author },
      );
    }
    const sessionId = requireChoiceSession(payload.sessionId, messageId, content.type);
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw restoreError(
        `workspace-restore.${content.type === "choice-question" ? "question" : "answer"}-session-unknown`,
        `${content.type} ${messageId} references unknown session ${sessionId}`,
        400,
        { messageId, sessionId, eventSeq: event.seq },
      );
    }
    if (session.status !== "active") {
      throw restoreError(
        `workspace-restore.${content.type === "choice-question" ? "question" : "answer"}-session-inactive`,
        `${content.type} ${messageId} references inactive session ${sessionId}`,
        400,
        { messageId, sessionId, eventSeq: event.seq, sessionStatus: session.status },
      );
    }
    if (content.type === "choice-question") {
      if (actorKind !== "agent") {
        throw restoreError(
          "workspace-restore.question-agent-required",
          `choice question ${messageId} must be authored by an agent`,
          400,
          { messageId, actorKind, actorId },
        );
      }
      if (session.agentId !== actorId) {
        throw restoreError(
          "workspace-restore.question-session-owner-mismatch",
          `agent ${actorId} does not own question session ${sessionId}`,
          400,
          { messageId, sessionId, actorId, ownerAgentId: session.agentId },
        );
      }
      if (typeof content.prompt !== "string" || content.prompt.trim().length === 0) {
        throw restoreError(
          "workspace-restore.question-prompt-required",
          `choice question ${messageId} requires a prompt`,
          400,
          { messageId },
        );
      }
      const options = validateChoiceOptions(messageId, content.options);
      questions.set(messageId, {
        messageId,
        seq: event.seq,
        sessionId,
        optionKeys: new Set(options.map((option) => option.key)),
      });
      continue;
    }
    if (actorKind !== "human") {
      throw restoreError(
        "workspace-restore.answer-human-required",
        `choice answer ${messageId} must be authored by a human`,
        400,
        { messageId, actorKind, actorId },
      );
    }
    const questionMessageId = requireId(
      content.questionMessageId,
      `answer ${messageId} questionMessageId`,
    );
    const predecessorMessageId =
      content.supersedesAnswerMessageId === null
        ? null
        : requireId(
            content.supersedesAnswerMessageId,
            `answer ${messageId} supersedesAnswerMessageId`,
          );
    const optionKey = requireText(content.optionKey, `answer ${messageId} optionKey`);
    answers.set(messageId, {
      messageId,
      questionMessageId,
      predecessorMessageId,
      sessionId,
      optionKey,
      seq: event.seq,
    });
  }

  const byQuestion = new Map<string, ImportedAnswer[]>();
  for (const answer of answers.values()) {
    const question = questions.get(answer.questionMessageId);
    if (question === undefined) {
      throw restoreError(
        "workspace-restore.answer-question-missing",
        `answer ${answer.messageId} references missing choice question ${answer.questionMessageId}`,
        400,
        { answerMessageId: answer.messageId, questionMessageId: answer.questionMessageId },
      );
    }
    if (question.seq >= answer.seq) {
      throw restoreError(
        "workspace-restore.answer-question-order-invalid",
        `answer ${answer.messageId} precedes its choice question ${answer.questionMessageId}`,
        400,
        { answerMessageId: answer.messageId, questionMessageId: answer.questionMessageId },
      );
    }
    if (answer.sessionId !== question.sessionId) {
      throw restoreError(
        "workspace-restore.answer-session-mismatch",
        `answer ${answer.messageId} belongs to a different session than question ${answer.questionMessageId}`,
        400,
        {
          answerMessageId: answer.messageId,
          answerSessionId: answer.sessionId,
          questionMessageId: answer.questionMessageId,
          questionSessionId: question.sessionId,
        },
      );
    }
    if (!question.optionKeys.has(answer.optionKey)) {
      throw restoreError(
        "workspace-restore.answer-option-unknown",
        `question ${answer.questionMessageId} has no option ${answer.optionKey}`,
        400,
        {
          answerMessageId: answer.messageId,
          questionMessageId: answer.questionMessageId,
          optionKey: answer.optionKey,
        },
      );
    }
    const group = byQuestion.get(answer.questionMessageId) ?? [];
    group.push(answer);
    byQuestion.set(answer.questionMessageId, group);
  }

  for (const [questionMessageId, chain] of byQuestion) {
    const chainById = new Map(chain.map((answer) => [answer.messageId, answer]));
    for (const answer of chain) {
      if (answer.predecessorMessageId === null) continue;
      const predecessor = answers.get(answer.predecessorMessageId);
      if (predecessor === undefined) {
        throw restoreError(
          "workspace-restore.answer-chain-predecessor-missing",
          `answer ${answer.messageId} references missing predecessor ${answer.predecessorMessageId}`,
          400,
          {
            questionMessageId,
            answerMessageId: answer.messageId,
            predecessorMessageId: answer.predecessorMessageId,
          },
        );
      }
      if (predecessor.questionMessageId !== questionMessageId) {
        throw restoreError(
          "workspace-restore.answer-chain-cross-question",
          `answer ${answer.messageId} references a predecessor from another question`,
          400,
          {
            questionMessageId,
            answerMessageId: answer.messageId,
            predecessorMessageId: answer.predecessorMessageId,
            predecessorQuestionMessageId: predecessor.questionMessageId,
          },
        );
      }
    }

    for (const answer of chain) {
      const path = new Set<string>();
      let cursor: ImportedAnswer | undefined = answer;
      while (cursor !== undefined) {
        if (path.has(cursor.messageId)) {
          throw restoreError(
            "workspace-restore.answer-chain-cycle",
            `question ${questionMessageId} answer history contains a supersession cycle`,
            400,
            { questionMessageId, answerMessageIds: [...path, cursor.messageId] },
          );
        }
        path.add(cursor.messageId);
        cursor =
          cursor.predecessorMessageId === null
            ? undefined
            : chainById.get(cursor.predecessorMessageId);
      }
    }

    for (const answer of chain) {
      if (answer.predecessorMessageId === null) continue;
      const predecessor = chainById.get(answer.predecessorMessageId);
      if (predecessor !== undefined && predecessor.seq >= answer.seq) {
        throw restoreError(
          "workspace-restore.answer-chain-order-invalid",
          `answer ${answer.messageId} must follow predecessor ${predecessor.messageId}`,
          400,
          {
            questionMessageId,
            answerMessageId: answer.messageId,
            predecessorMessageId: predecessor.messageId,
          },
        );
      }
    }

    const roots = chain.filter((answer) => answer.predecessorMessageId === null);
    if (roots.length !== 1) {
      throw restoreError(
        roots.length === 0
          ? "workspace-restore.answer-chain-root-missing"
          : "workspace-restore.answer-chain-multiple-roots",
        `question ${questionMessageId} answer history must contain exactly one first answer`,
        400,
        { questionMessageId, rootMessageIds: roots.map((answer) => answer.messageId) },
      );
    }

    const successors = new Map<string, string>();
    for (const answer of chain) {
      if (answer.predecessorMessageId === null) continue;
      const existing = successors.get(answer.predecessorMessageId);
      if (existing !== undefined) {
        throw restoreError(
          "workspace-restore.answer-chain-branch",
          `question ${questionMessageId} answer history branches after ${answer.predecessorMessageId}`,
          400,
          {
            questionMessageId,
            predecessorMessageId: answer.predecessorMessageId,
            successorMessageIds: [existing, answer.messageId],
          },
        );
      }
      successors.set(answer.predecessorMessageId, answer.messageId);
    }
  }
}

function requireSessionEventAuthority(
  event: EventEnvelope,
  payload: Readonly<Record<string, unknown>>,
): string {
  const actor = requireRecord(event.actor, `event ${event.seq} actor`);
  const agentId = requireId(payload.agentId, `event ${event.seq} agentId`);
  if (actor.kind !== "agent" || actor.id !== agentId) {
    throw restoreError(
      "workspace-restore.session-actor-agent-mismatch",
      `${event.eventType} requires an agent actor matching payload agentId`,
      400,
      {
        eventSeq: event.seq,
        eventType: event.eventType,
        actorKind: actor.kind,
        actorId: actor.id,
        agentId,
      },
    );
  }
  return agentId;
}

function requireChoiceSession(
  value: unknown,
  messageId: string,
  contentType: "choice-question" | "choice-answer",
): string {
  const kind = contentType === "choice-question" ? "question" : "answer";
  if (value === null || value === undefined) {
    throw restoreError(
      `workspace-restore.${kind}-session-required`,
      `${contentType} ${messageId} requires an exact session`,
      400,
      { messageId },
    );
  }
  return requireId(value, `${contentType} ${messageId} sessionId`);
}

function validateChoiceOptions(
  messageId: string,
  value: unknown,
): readonly Readonly<{ key: string; label: string }>[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    throw restoreError(
      "workspace-restore.question-option-count",
      `choice question ${messageId} requires between 2 and 8 options`,
      400,
      { messageId, optionCount: Array.isArray(value) ? value.length : null },
    );
  }
  const options = value.map((item, index) => {
    const option = requireRecord(item, `question ${messageId} option ${index + 1}`);
    if (typeof option.key !== "string" || option.key.trim().length === 0) {
      throw restoreError(
        "workspace-restore.question-option-key-required",
        `choice question ${messageId} option ${index + 1} requires a key`,
        400,
        { messageId, optionIndex: index },
      );
    }
    if (typeof option.label !== "string" || option.label.trim().length === 0) {
      throw restoreError(
        "workspace-restore.question-option-label-required",
        `choice question ${messageId} option ${index + 1} requires a label`,
        400,
        { messageId, optionIndex: index },
      );
    }
    return { key: option.key, label: option.label };
  });
  if (new Set(options.map((option) => option.key)).size !== options.length) {
    throw restoreError(
      "workspace-restore.question-option-key-duplicate",
      `choice question ${messageId} option keys must be unique`,
      400,
      { messageId },
    );
  }
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw restoreError(
      "workspace-restore.question-option-label-duplicate",
      `choice question ${messageId} option labels must be unique`,
      400,
      { messageId },
    );
  }
  return options;
}

function addDescriptor(
  descriptors: Map<string, RestoreObjectDescriptor>,
  descriptor: RestoreObjectDescriptor,
): void {
  if (descriptor.byteLength > MAX_OBJECT_BYTES) {
    throw restoreError(
      "workspace-restore.file-too-large",
      `object exceeds the per-file size limit: ${descriptor.objectPath}`,
    );
  }
  const existing = descriptors.get(descriptor.hash);
  if (
    existing &&
    (existing.mediaType !== descriptor.mediaType ||
      existing.byteLength !== descriptor.byteLength ||
      existing.objectPath !== descriptor.objectPath)
  ) {
    throw restoreError(
      "workspace-restore.object-descriptor-conflict",
      `object hash has conflicting descriptors: ${descriptor.hash}`,
    );
  }
  descriptors.set(descriptor.hash, descriptor);
}

function requireObjectPath(value: unknown, expectedHash: string): string {
  const path = requirePortablePath(value, "objectPath");
  const expected = `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${expectedHash}`;
  if (path !== expected) {
    throw restoreError("workspace-restore.object-path-invalid", `object path must be ${expected}`);
  }
  return path;
}

function requirePortablePath(value: unknown, field: string): string {
  const text = requireText(value, field).replaceAll("\\", "/");
  if (
    text === WORKSPACE_EXPORT_MANIFEST_PATH ||
    text.startsWith("/") ||
    /^[A-Za-z]:\//.test(text) ||
    text.split("/").some((part) => part === "" || part === "." || part === "..") ||
    text.includes("\0")
  ) {
    throw restoreError("workspace-restore.path-escape", `${field} is not a safe portable path`);
  }
  return text;
}

function safeJoin(root: string, portablePath: string): string {
  const destination = resolve(root, ...portablePath.split("/"));
  const rel = relative(root, destination);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw restoreError("workspace-restore.path-escape", "restore path escapes staging root");
  }
  return destination;
}

function stageDir(root: string, restoreId: string): string {
  return safeJoin(root, restoreId);
}

function writeAtomic(path: string, bytes: Buffer): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
  renameSync(temp, path);
}

function writeVerified(path: string, bytes: Buffer, acceptedExistingHash?: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    const existing = readFileSync(path);
    if (!existing.equals(bytes) && hash(existing) !== acceptedExistingHash) {
      throw restoreError(
        "workspace-restore.install-conflict",
        `restore destination already contains different bytes: ${path}`,
        409,
      );
    }
    return;
  }
  writeAtomic(path, bytes);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw restoreError("workspace-restore.manifest-invalid", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw restoreError("workspace-restore.manifest-invalid", `${field} must be non-empty text`);
  }
  return value;
}

function optionalText(value: unknown, field: string): void {
  if (value !== null && (typeof value !== "string" || value.includes("\0"))) {
    throw restoreError("workspace-restore.manifest-invalid", `${field} must be text or null`);
  }
}

function requireId(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!ID.test(text)) {
    throw restoreError("workspace-restore.id-invalid", `${field} is invalid`);
  }
  return text;
}

function requireHash(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!SHA256.test(text)) {
    throw restoreError("workspace-restore.hash-invalid", `${field} must be lowercase SHA-256`);
  }
  return text;
}

function requireByteLength(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw restoreError("workspace-restore.size-invalid", `${field} must be non-negative`);
  }
  return Number(value);
}

function requireSequence(value: unknown, field: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || Number(value) < (allowZero ? 0 : 1)) {
    throw restoreError("workspace-restore.sequence-invalid", `${field} is invalid`);
  }
  return Number(value);
}

function duplicate(kind: string, identity: string): never {
  throw restoreError(
    "workspace-restore.duplicate-identity",
    `duplicate ${kind} identity: ${identity}`,
  );
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function restoreError(
  code: string,
  message: string,
  status = 400,
  details: Readonly<Record<string, unknown>> = {},
): WorkspaceRestoreError {
  return new WorkspaceRestoreError(code, message, status, details);
}
