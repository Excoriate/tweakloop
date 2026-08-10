import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from "node:path";
import {
  WORKSPACE_EXPORT_MANIFEST_PATH,
  WORKSPACE_EXPORT_OBJECT_PREFIX,
  type WorkspaceExportManifest,
} from "../protocol/workspace-export.js";

export const WORKSPACE_FILES_CONFIG_PROTOCOL = "tweakloop.workspace-files/v1" as const;
export const WORKSPACE_FILES_SNAPSHOT_PROTOCOL = "tweakloop.workspace-file-snapshot/v2" as const;
export const WORKSPACE_FILES_MANIFEST_PATH = ".tweakloop/workspace-files-manifest.json";
export const WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL = "tweakloop.workspace-bundle/v2" as const;
export const WORKSPACE_BUNDLE_ENVELOPE_PATH = ".tweakloop/workspace-bundle.json";
export const WORKSPACE_FILE_OVERLAY_PRECEDENCE = "workspace-files-over-durable-head" as const;
export const WORKSPACE_FILE_OVERLAY_VERSION = 1 as const;
export const WORKSPACE_FILES_CAPTURE_CONSISTENCY = "quiescent-verified" as const;
export const WORKSPACE_FILES_OBSERVATION = "selected-closed-set/v1" as const;

const BUNDLE_ID = /^bundle_[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const OWNERSHIP_NONCE = /^[a-f0-9]{32,128}$/;
const BUNDLE_ID_DOMAIN = "tweakloop.workspace-bundle/v2\0bundle-id\0";
const WORKSPACE_FILES_FINGERPRINT_DOMAIN =
  "tweakloop.workspace-file-snapshot/v2\0closed-set-fingerprint\0";
const BUNDLE_WORKSPACE_FILES_MANIFEST_PATH = `workspace-files/${WORKSPACE_FILES_MANIFEST_PATH}`;

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_FILE_COUNT = 100_000;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const GLOB_META = /[*?[{]/;
const DEFAULT_EXCLUDES = [".git/**", "node_modules/**", ".tweakloop/**"] as const;
const WORKSPACE_FILES_OBSERVED_FIELDS = [
  "selected-path-membership",
  "exclusions",
  "entry-type",
  "file-identity",
  "bytes",
  "mode",
] as const;

export type WorkspaceFilesConfig = Readonly<{
  protocol: typeof WORKSPACE_FILES_CONFIG_PROTOCOL;
  includes: readonly string[];
  excludes: readonly string[];
  notes?: readonly string[];
}>;

export type WorkspaceFileEntry = Readonly<{
  path: string;
  hash: string;
  byteLength: number;
  mode: number;
  objectPath: string;
}>;

export type WorkspaceFileExclusion = Readonly<{
  path: string;
  reason: "configured" | "managed-state" | "secret-default";
}>;

export type WorkspaceFilesManifest = Readonly<{
  protocol: typeof WORKSPACE_FILES_SNAPSHOT_PROTOCOL;
  config: WorkspaceFilesConfig;
  files: readonly WorkspaceFileEntry[];
  excluded: readonly WorkspaceFileExclusion[];
  totalBytes: number;
  capture: WorkspaceFilesCaptureBoundary;
}>;

export type WorkspaceFilesCaptureBoundary = Readonly<{
  consistency: typeof WORKSPACE_FILES_CAPTURE_CONSISTENCY;
  observation: typeof WORKSPACE_FILES_OBSERVATION;
  fingerprintAlgorithm: "sha256";
  observedFields: typeof WORKSPACE_FILES_OBSERVED_FIELDS;
  startFingerprint: string;
  endFingerprint: string;
}>;

export type WorkspaceFilesCaptureVerification = Readonly<{
  protocol: "tweakloop.workspace-files-capture-verification/v1";
  fingerprint: string;
}>;

export type WorkspaceFilesCaptureResult = Readonly<{
  destination: string;
  manifest: WorkspaceFilesManifest;
  verification: WorkspaceFilesCaptureVerification;
}>;

export type WorkspaceFilesRestoreResult = Readonly<{
  destination: string;
  restored: readonly WorkspaceFileEntry[];
  excluded: readonly WorkspaceFileExclusion[];
}>;

export type WorkspaceFileOverlayState = "clean" | "modified" | "untracked" | "durable-only";

export type WorkspaceFilesOverlayEntry = Readonly<{
  path: string;
  state: WorkspaceFileOverlayState;
  artifactId: string | null;
  revisionId: string | null;
  baseHash: string | null;
  workingHash: string | null;
  byteLength: number;
  mode: number | null;
  objectPath: string | null;
}>;

export type WorkspaceFilesOverlayPlan = Readonly<{
  bundleId: string;
  collaborationManifestHash: string;
  workspaceFilesManifestHash: string | null;
  entries: readonly WorkspaceFilesOverlayEntry[];
  counts: Readonly<Record<WorkspaceFileOverlayState, number>>;
  workingFileBytes: number;
}>;

export type WorkspaceFilesOverlayStageResult = Readonly<{
  bundleId: string;
  operationId: string;
  ownershipNonce: string;
  stagedRoot: string;
  entries: readonly WorkspaceFilesOverlayEntry[];
  installed: number;
  unchanged: number;
  durability: "file-and-directory-fsync";
}>;

export type WorkspaceBundleEnvelope = Readonly<{
  protocol: typeof WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL;
  bundleId: string;
  source: Readonly<{
    workspaceId: string;
    projectId: string;
    capturedSeq: number;
  }>;
  collaboration: Readonly<{
    manifestPath: typeof WORKSPACE_EXPORT_MANIFEST_PATH;
    manifestHash: string;
  }>;
  workspaceFiles: Readonly<{
    manifestPath: typeof BUNDLE_WORKSPACE_FILES_MANIFEST_PATH;
    manifestHash: string;
    precedence: typeof WORKSPACE_FILE_OVERLAY_PRECEDENCE;
    overlayVersion: typeof WORKSPACE_FILE_OVERLAY_VERSION;
  }> | null;
  capture: Readonly<{
    collaboration: Readonly<{
      capturedSeq: number;
      observedEndSeq: number;
      consistency: "event-seq-exact";
    }>;
    workspaceFiles: Readonly<{
      consistency: typeof WORKSPACE_FILES_CAPTURE_CONSISTENCY;
      observation: typeof WORKSPACE_FILES_OBSERVATION;
      fingerprintAlgorithm: "sha256";
      observedFields: typeof WORKSPACE_FILES_OBSERVED_FIELDS;
      startFingerprint: string;
      endFingerprint: string;
      publicationFingerprint: string;
    }> | null;
  }>;
  inventory: Readonly<{
    objectCount: number;
    totalBytes: number;
  }>;
}>;

export type WorkspaceBundleValidationResult = Readonly<{
  envelope: WorkspaceBundleEnvelope;
  collaborationManifest: WorkspaceExportManifest;
  workspaceFilesManifest: WorkspaceFilesManifest | null;
}>;

export type WorkspaceBundlePublishResult = Readonly<{
  destination: string;
  envelope: WorkspaceBundleEnvelope;
}>;

export type WorkspaceBundleCaptureResult =
  | Readonly<{
      includeWorkspaceFiles: false;
      observedEndSeq: number;
      workspaceFilesVerification?: never;
    }>
  | Readonly<{
      includeWorkspaceFiles: true;
      observedEndSeq: number;
      workspaceFilesVerification: WorkspaceFilesCaptureVerification;
    }>;

type WorkspaceFilesCaptureAuthority = Readonly<{
  workspaceRoot: string;
  config: WorkspaceFilesConfig;
  fingerprint: string;
}>;

const workspaceFilesCaptureAuthorities = new WeakMap<
  WorkspaceFilesCaptureVerification,
  WorkspaceFilesCaptureAuthority
>();

export class WorkspaceFilesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceFilesError";
  }
}

export function validateWorkspaceFilesConfig(input: unknown): WorkspaceFilesConfig {
  if (!isRecord(input) || input.protocol !== WORKSPACE_FILES_CONFIG_PROTOCOL) {
    throw filesError("workspace-files.config-protocol", "unsupported workspace files config");
  }
  const includes = validatePatterns(input.includes, "includes", false);
  const excludes = validatePatterns(input.excludes, "excludes", true);
  const notes = input.notes === undefined ? undefined : validateNotes(input.notes);
  return {
    protocol: WORKSPACE_FILES_CONFIG_PROTOCOL,
    includes,
    excludes,
    ...(notes === undefined ? {} : { notes }),
  };
}

/**
 * Capture only explicitly included workspace files. The manifest is published last, after every
 * content-addressed object has been written and verified in a sibling staging directory.
 */
export function captureWorkspaceFiles(
  input: Readonly<{
    workspaceRoot: string;
    destination: string;
    config: unknown;
  }>,
): WorkspaceFilesCaptureResult {
  const root = resolve(input.workspaceRoot);
  requireRealDirectory(root, "workspace-files.root-invalid");
  const destination = resolve(input.destination);
  assertOutsideRoot(destination, root);
  const destinationClaim = claimNewOrEmptyDirectory(destination);
  const config = validateWorkspaceFilesConfig(input.config);
  const parent = dirname(destination);
  requireRealDirectory(parent, "workspace-files.destination-parent-invalid");
  const staging = mkdtempSync(join(parent, ".tweakloop-files-"));

  try {
    const inventory = inventoryWorkspaceFiles(root, config);
    const capturedObjects = new Set<string>();
    for (const file of inventory.files) {
      const source = resolvePortable(root, file.path);
      assertRealPathSegments(root, file.path);
      if (capturedObjects.has(file.hash)) {
        const verified = hashRegularFile(source);
        if (
          verified.hash !== file.hash ||
          verified.byteLength !== file.byteLength ||
          verified.mode !== file.mode
        ) {
          throw filesError(
            "workspace-files.source-changed",
            `workspace file changed during capture: ${file.path}`,
            { path: file.path },
          );
        }
        continue;
      }
      const objectTarget = resolvePortable(staging, file.objectPath);
      ensureRealParentDirectories(staging, file.objectPath);
      streamCopyVerified(source, objectTarget, file, {
        targetMode: 0o600,
        expectedSourceMode: file.mode,
      });
      capturedObjects.add(file.hash);
    }
    const finalObservation = reobserveWorkspaceFiles(
      root,
      config,
      inventory.fingerprint,
      "component-publication",
    );
    const manifest: WorkspaceFilesManifest = {
      protocol: WORKSPACE_FILES_SNAPSHOT_PROTOCOL,
      config,
      files: inventory.files,
      excluded: inventory.excluded,
      totalBytes: inventory.totalBytes,
      capture: workspaceFilesCaptureBoundary(inventory.fingerprint, finalObservation.fingerprint),
    };
    const manifestTarget = resolvePortable(staging, WORKSPACE_FILES_MANIFEST_PATH);
    ensureRealParentDirectories(staging, WORKSPACE_FILES_MANIFEST_PATH);
    writeRegularFileExclusive(
      manifestTarget,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
      0o600,
    );
    publishStagingDirectory(staging, destination, destinationClaim);
    const verification: WorkspaceFilesCaptureVerification = Object.freeze({
      protocol: "tweakloop.workspace-files-capture-verification/v1",
      fingerprint: finalObservation.fingerprint,
    });
    workspaceFilesCaptureAuthorities.set(verification, {
      workspaceRoot: root,
      config,
      fingerprint: finalObservation.fingerprint,
    });
    return { destination, manifest, verification };
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

/** Verify every referenced object before placing any restored file. */
export function restoreWorkspaceFiles(
  input: Readonly<{
    snapshotRoot: string;
    destination: string;
  }>,
): WorkspaceFilesRestoreResult {
  const snapshotRoot = resolve(input.snapshotRoot);
  requireRealDirectory(snapshotRoot, "workspace-files.snapshot-invalid");
  const destination = resolve(input.destination);
  assertOutsideRoot(destination, snapshotRoot);
  const destinationClaim = claimNewOrEmptyDirectory(destination);
  const manifestPath = resolvePortable(snapshotRoot, WORKSPACE_FILES_MANIFEST_PATH);
  const manifest = validateWorkspaceFilesManifest(
    JSON.parse(readRegularFileNoFollow(manifestPath).toString("utf8")),
  );
  for (const file of manifest.files) {
    assertRealPathSegments(snapshotRoot, file.objectPath);
    const verified = hashRegularFile(resolvePortable(snapshotRoot, file.objectPath));
    if (verified.byteLength !== file.byteLength || verified.hash !== file.hash) {
      throw filesError(
        "workspace-files.object-invalid",
        `saved workspace object failed verification: ${file.path}`,
        { path: file.path, expectedHash: file.hash },
      );
    }
  }

  const parent = dirname(destination);
  requireRealDirectory(parent, "workspace-files.destination-parent-invalid");
  const staging = mkdtempSync(join(parent, ".tweakloop-restore-"));
  try {
    for (const file of manifest.files) {
      const target = resolvePortable(staging, file.path);
      ensureRealParentDirectories(staging, file.path);
      streamCopyVerified(resolvePortable(snapshotRoot, file.objectPath), target, file);
    }
    publishStagingDirectory(staging, destination, destinationClaim);
    return {
      destination,
      restored: manifest.files,
      excluded: manifest.excluded,
    };
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

/** Decide every cross-rail owner and collision without touching a filesystem destination. */
export function planWorkspaceFilesOverlay(
  validated: WorkspaceBundleValidationResult,
): WorkspaceFilesOverlayPlan {
  const durable = durableHeadEntries(validated.collaborationManifest);
  const working = validated.workspaceFilesManifest?.files ?? [];
  assertCrossRailPaths(durable, working);
  const durableByPath = new Map(durable.map((entry) => [entry.path, entry]));
  const workingByPath = new Map(working.map((entry) => [entry.path, entry]));
  const entries: WorkspaceFilesOverlayEntry[] = [];
  const paths = [...new Set([...durableByPath.keys(), ...workingByPath.keys()])].sort();
  const counts: Record<WorkspaceFileOverlayState, number> = {
    clean: 0,
    modified: 0,
    untracked: 0,
    "durable-only": 0,
  };

  for (const path of paths) {
    const base = durableByPath.get(path) ?? null;
    const workspaceFile = workingByPath.get(path) ?? null;
    const state: WorkspaceFileOverlayState =
      base && workspaceFile
        ? base.hash === workspaceFile.hash
          ? "clean"
          : "modified"
        : workspaceFile
          ? "untracked"
          : "durable-only";
    counts[state] += 1;
    entries.push({
      path,
      state,
      artifactId: base?.artifactId ?? null,
      revisionId: base?.revisionId ?? null,
      baseHash: base?.hash ?? null,
      workingHash: workspaceFile?.hash ?? null,
      byteLength: workspaceFile?.byteLength ?? base?.byteLength ?? 0,
      mode: workspaceFile?.mode ?? null,
      objectPath: workspaceFile?.objectPath ?? null,
    });
  }
  return {
    bundleId: validated.envelope.bundleId,
    collaborationManifestHash: validated.envelope.collaboration.manifestHash,
    workspaceFilesManifestHash: validated.envelope.workspaceFiles?.manifestHash ?? null,
    entries,
    counts,
    workingFileBytes: working.reduce((total, file) => total + file.byteLength, 0),
  };
}

/**
 * Apply a verified working-file rail only to a caller-owned, non-addressable combined staging root.
 * This function never publishes, removes, or replaces a user destination.
 */
export function stageWorkspaceFilesOverlay(
  input: Readonly<{
    snapshotRoot: string | null;
    stagedRoot: string;
    plan: WorkspaceFilesOverlayPlan;
    operationId: string;
    ownershipNonce: string;
  }>,
): WorkspaceFilesOverlayStageResult {
  requireOperationIdentity(input.operationId, input.ownershipNonce);
  if (!BUNDLE_ID.test(input.plan.bundleId)) {
    throw filesError("workspace-bundle.identity-invalid", "workspace bundle identity is invalid");
  }
  const stagedRoot = resolve(input.stagedRoot);
  requireRealDirectory(stagedRoot, "workspace-files.overlay-stage-invalid");
  const workspaceEntries = input.plan.entries.filter((entry) => entry.workingHash !== null);
  if ((input.snapshotRoot === null) !== (input.plan.workspaceFilesManifestHash === null)) {
    throw filesError(
      "workspace-files.overlay-snapshot-mismatch",
      "workspace overlay plan and snapshot presence differ",
    );
  }
  preflightCombinedStage(stagedRoot, input.plan.entries);
  if (workspaceEntries.length === 0) {
    return {
      bundleId: input.plan.bundleId,
      operationId: input.operationId,
      ownershipNonce: input.ownershipNonce,
      stagedRoot,
      entries: input.plan.entries,
      installed: 0,
      unchanged: 0,
      durability: "file-and-directory-fsync",
    };
  }

  const snapshotRoot = resolve(input.snapshotRoot as string);
  requireRealDirectory(snapshotRoot, "workspace-files.snapshot-invalid");
  assertDisjointRoots(snapshotRoot, stagedRoot);
  const manifestBytes = readBundleFile(
    snapshotRoot,
    WORKSPACE_FILES_MANIFEST_PATH,
    "workspace-files.manifest-missing",
  );
  if (hash(manifestBytes) !== input.plan.workspaceFilesManifestHash) {
    throw filesError(
      "workspace-files.overlay-manifest-mismatch",
      "workspace overlay snapshot manifest differs from the planned manifest",
    );
  }
  const manifest = validateWorkspaceFilesManifest(JSON.parse(manifestBytes.toString("utf8")));
  const manifestByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const plannedWorkspacePaths = new Set(workspaceEntries.map((entry) => entry.path));
  if (
    manifest.files.length !== workspaceEntries.length ||
    manifest.files.some((file) => !plannedWorkspacePaths.has(file.path))
  ) {
    throw filesError(
      "workspace-files.overlay-plan-incomplete",
      "workspace overlay plan does not account for every bound workspace file",
    );
  }
  const sourceStage = resolve(
    dirname(stagedRoot),
    `.tweakloop-workspace-stage-${input.ownershipNonce}`,
  );
  if (existsSync(sourceStage)) {
    throw filesError(
      "workspace-files.overlay-stage-exists",
      `workspace overlay source stage already exists: ${sourceStage}`,
    );
  }
  mkdirSync(sourceStage, { mode: 0o700 });
  let installed = 0;
  let unchanged = 0;
  try {
    for (const entry of workspaceEntries) {
      const descriptor = manifestByPath.get(entry.path);
      if (
        descriptor === undefined ||
        descriptor.hash !== entry.workingHash ||
        descriptor.mode !== entry.mode ||
        descriptor.byteLength !== entry.byteLength ||
        descriptor.objectPath !== entry.objectPath
      ) {
        throw filesError(
          "workspace-files.overlay-plan-mismatch",
          `workspace overlay plan differs from the bound manifest: ${entry.path}`,
        );
      }
      const source = resolvePortable(snapshotRoot, descriptor.objectPath);
      assertRealPathSegments(snapshotRoot, descriptor.objectPath);
      const stagedTarget = resolvePortable(sourceStage, descriptor.path);
      ensureRealParentDirectories(sourceStage, descriptor.path);
      streamCopyVerified(source, stagedTarget, descriptor);
    }

    preflightCombinedStage(stagedRoot, input.plan.entries);
    for (const entry of workspaceEntries) {
      const target = resolvePortable(stagedRoot, entry.path);
      const stagedTarget = resolvePortable(sourceStage, entry.path);
      assertOverlayTargetSafe(stagedRoot, entry.path);
      if (existsSync(target)) {
        const targetVerification = hashRegularFile(target);
        if (
          targetVerification.hash === entry.workingHash &&
          targetVerification.mode === entry.mode
        ) {
          unchanged += 1;
          continue;
        }
      }
      ensureRealParentDirectories(stagedRoot, entry.path);
      renameSync(stagedTarget, target);
      fsyncDirectory(dirname(target));
      const installedVerification = hashRegularFile(target);
      if (
        installedVerification.hash !== entry.workingHash ||
        installedVerification.byteLength !== entry.byteLength ||
        installedVerification.mode !== entry.mode
      ) {
        throw filesError(
          "workspace-files.overlay-verification-failed",
          `installed workspace overlay failed verification: ${entry.path}`,
          { path: entry.path },
        );
      }
      installed += 1;
    }
    return {
      bundleId: input.plan.bundleId,
      operationId: input.operationId,
      ownershipNonce: input.ownershipNonce,
      stagedRoot,
      entries: input.plan.entries,
      installed,
      unchanged,
      durability: "file-and-directory-fsync",
    };
  } finally {
    rmSync(sourceStage, { force: true, recursive: true });
  }
}

/**
 * Capture both bundle rails in one nonce-owned sibling stage and publish exactly once to an absent
 * destination. The callback may write only inside the provided private bundle root.
 */
export async function publishWorkspaceBundle(
  input: Readonly<{
    destination: string;
    operationId: string;
    ownershipNonce: string;
    capture: (bundleRoot: string) => Promise<WorkspaceBundleCaptureResult>;
  }>,
): Promise<WorkspaceBundlePublishResult> {
  requireOperationIdentity(input.operationId, input.ownershipNonce);
  const destination = resolve(input.destination);
  if (existsSync(destination)) {
    throw filesError(
      "workspace-bundle.destination-exists",
      `workspace bundle destination already exists: ${destination}`,
    );
  }
  const parent = dirname(destination);
  requireRealDirectory(parent, "workspace-bundle.destination-parent-invalid");
  const claimRoot = resolve(parent, `.tweakloop-bundle-${input.ownershipNonce}`);
  if (existsSync(claimRoot)) {
    throw filesError(
      "workspace-bundle.stage-exists",
      `workspace bundle staging claim already exists: ${claimRoot}`,
    );
  }
  mkdirSync(claimRoot, { mode: 0o700 });
  const claimStatus = lstatSync(claimRoot);
  const owner = `${JSON.stringify({ operationId: input.operationId, ownershipNonce: input.ownershipNonce })}\n`;
  const ownerPath = join(claimRoot, "owner.json");
  writeRegularFileExclusive(ownerPath, Buffer.from(owner, "utf8"), 0o600);
  const bundleRoot = join(claimRoot, "bundle");
  fsyncDirectory(claimRoot);
  let published = false;
  try {
    const captured = await input.capture(bundleRoot);
    assertBundleStageOwnership(claimRoot, ownerPath, owner, claimStatus.dev, claimStatus.ino);
    fsyncTree(bundleRoot);
    const workspaceFilesPublicationFingerprint = captured.includeWorkspaceFiles
      ? verifyWorkspaceFilesAtBundlePublication(bundleRoot, captured.workspaceFilesVerification)
      : rejectUnexpectedWorkspaceFilesVerification(captured.workspaceFilesVerification);
    const envelope = writeWorkspaceBundleEnvelope({
      bundleRoot,
      includeWorkspaceFiles: captured.includeWorkspaceFiles,
      observedEndSeq: captured.observedEndSeq,
      ...(workspaceFilesPublicationFingerprint === null
        ? {}
        : { workspaceFilesPublicationFingerprint }),
    });
    if (existsSync(destination)) {
      throw filesError(
        "workspace-bundle.destination-appeared",
        `workspace bundle destination appeared during capture: ${destination}`,
      );
    }
    assertBundleStageOwnership(claimRoot, ownerPath, owner, claimStatus.dev, claimStatus.ino);
    fsyncDirectory(bundleRoot);
    renameSync(bundleRoot, destination);
    published = true;
    fsyncDirectory(parent);
    cleanupBundleStageClaim(claimRoot, ownerPath, owner, claimStatus.dev, claimStatus.ino);
    fsyncDirectory(parent);
    return { destination, envelope };
  } catch (error) {
    if (!published) {
      try {
        cleanupBundleStageClaim(claimRoot, ownerPath, owner, claimStatus.dev, claimStatus.ino);
        fsyncDirectory(parent);
      } catch (cleanupError) {
        throw filesError(
          "workspace-bundle.cleanup-ownership-lost",
          "workspace bundle capture failed and staging ownership changed before cleanup",
          {
            captureError: error instanceof Error ? error.message : String(error),
            cleanupError:
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
            claimRoot,
          },
        );
      }
    }
    throw error;
  }
}

/** Write the top-level binding only after both independently verified manifests exist. */
export function writeWorkspaceBundleEnvelope(
  input: Readonly<{
    bundleRoot: string;
    includeWorkspaceFiles: boolean;
    observedEndSeq: number;
    workspaceFilesPublicationFingerprint?: string;
  }>,
): WorkspaceBundleEnvelope {
  const bundleRoot = resolve(input.bundleRoot);
  requireRealDirectory(bundleRoot, "workspace-bundle.root-invalid");
  const collaborationBytes = readBundleFile(
    bundleRoot,
    WORKSPACE_EXPORT_MANIFEST_PATH,
    "workspace-bundle.collaboration-manifest-missing",
  );
  const collaborationManifest = parseBundleJson(
    collaborationBytes,
    "workspace-bundle.collaboration-manifest-invalid",
  ) as WorkspaceExportManifest;
  const source = collaborationSource(collaborationManifest);
  const workspaceComponent = input.includeWorkspaceFiles
    ? readWorkspaceFilesComponent(bundleRoot)
    : { binding: rejectUnboundWorkspaceFiles(bundleRoot), manifest: null };
  if (input.observedEndSeq !== source.capturedSeq) {
    throw filesError(
      "workspace-bundle.capture-advanced",
      "workspace advanced while the bundle was being captured",
      { collaborationCapturedSeq: source.capturedSeq, observedEndSeq: input.observedEndSeq },
    );
  }
  const workspaceFilesCapture = workspaceComponent.manifest?.capture ?? null;
  const publicationFingerprint =
    input.workspaceFilesPublicationFingerprint ?? workspaceFilesCapture?.endFingerprint ?? null;
  if (workspaceFilesCapture === null && publicationFingerprint !== null) {
    throw filesError(
      "workspace-files.capture-changed",
      "workspace file capture changed before bundle envelope publication",
      {
        expectedFingerprint: null,
        publicationFingerprint,
      },
    );
  }
  if (
    workspaceFilesCapture !== null &&
    publicationFingerprint !== workspaceFilesCapture.endFingerprint
  ) {
    throw filesError(
      "workspace-files.capture-changed",
      "workspace file capture changed before bundle envelope publication",
      {
        expectedFingerprint: workspaceFilesCapture.endFingerprint,
        publicationFingerprint,
      },
    );
  }
  const capture: WorkspaceBundleEnvelope["capture"] = {
    collaboration: {
      capturedSeq: source.capturedSeq,
      observedEndSeq: input.observedEndSeq,
      consistency: "event-seq-exact",
    },
    workspaceFiles:
      workspaceFilesCapture === null
        ? null
        : {
            ...workspaceFilesCapture,
            publicationFingerprint: workspaceFilesCapture.endFingerprint,
          },
  };
  const inventory = bundleInventory(collaborationManifest, workspaceComponent.manifest);
  const identity = {
    protocol: WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL,
    source,
    collaboration: {
      manifestPath: WORKSPACE_EXPORT_MANIFEST_PATH,
      manifestHash: hash(collaborationBytes),
    },
    workspaceFiles: workspaceComponent.binding,
    capture,
    inventory,
  } as const;
  const envelope: WorkspaceBundleEnvelope = {
    ...identity,
    bundleId: bundleId(identity),
  };
  const target = resolvePortable(bundleRoot, WORKSPACE_BUNDLE_ENVELOPE_PATH);
  ensureRealParentDirectories(bundleRoot, WORKSPACE_BUNDLE_ENVELOPE_PATH);
  writeRegularFileExclusive(
    target,
    Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`, "utf8"),
    0o600,
  );
  return envelope;
}

/** Fail closed on legacy, omitted, or spliced bundle surfaces before restore/fork mutation. */
export function validateWorkspaceBundleEnvelope(
  bundleRootInput: string,
): WorkspaceBundleValidationResult {
  const bundleRoot = resolve(bundleRootInput);
  requireRealDirectory(bundleRoot, "workspace-bundle.root-invalid");
  const envelopePath = resolvePortable(bundleRoot, WORKSPACE_BUNDLE_ENVELOPE_PATH);
  if (!existsSync(envelopePath)) {
    throw filesError(
      "workspace-bundle.envelope-missing",
      "workspace bundle has no binding envelope; legacy unbound bundles cannot be restored or forked",
    );
  }
  const raw = parseBundleJson(
    readRegularFileNoFollow(envelopePath),
    "workspace-bundle.envelope-invalid",
  );
  if (isRecord(raw) && raw.protocol === "tweakloop.workspace-bundle/v1") {
    throw filesError(
      "workspace-bundle.migration-required",
      "workspace bundle predates the quiescent-verified file capture contract; re-export it",
      { requiredProtocol: WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL },
    );
  }
  if (!isRecord(raw) || raw.protocol !== WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL) {
    throw filesError("workspace-bundle.protocol", "unsupported workspace bundle envelope");
  }
  if (typeof raw.bundleId !== "string" || !BUNDLE_ID.test(raw.bundleId)) {
    throw filesError("workspace-bundle.identity-invalid", "workspace bundle identity is invalid");
  }
  const source = validateBundleSource(raw.source);
  const collaboration = validateCollaborationBinding(raw.collaboration);
  const workspaceFiles = validateWorkspaceFilesBinding(raw.workspaceFiles);
  const capture = validateCaptureBinding(raw.capture, source.capturedSeq, workspaceFiles !== null);
  const inventory = validateInventoryBinding(raw.inventory);
  const identity = {
    protocol: WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL,
    source,
    collaboration,
    workspaceFiles,
    capture,
    inventory,
  } as const;
  if (bundleId(identity) !== raw.bundleId) {
    throw filesError(
      "workspace-bundle.identity-mismatch",
      "workspace bundle identity does not match its binding envelope",
    );
  }

  const collaborationBytes = readBundleFile(
    bundleRoot,
    collaboration.manifestPath,
    "workspace-bundle.collaboration-manifest-missing",
  );
  if (hash(collaborationBytes) !== collaboration.manifestHash) {
    throw filesError(
      "workspace-bundle.collaboration-manifest-mismatch",
      "workspace collaboration manifest does not match the bound hash",
    );
  }
  const collaborationManifest = parseBundleJson(
    collaborationBytes,
    "workspace-bundle.collaboration-manifest-invalid",
  ) as WorkspaceExportManifest;
  const actualSource = collaborationSource(collaborationManifest);
  if (JSON.stringify(actualSource) !== JSON.stringify(source)) {
    throw filesError(
      "workspace-bundle.source-mismatch",
      "workspace bundle source identity does not match the collaboration manifest",
    );
  }

  const snapshotPath = resolvePortable(bundleRoot, BUNDLE_WORKSPACE_FILES_MANIFEST_PATH);
  if (workspaceFiles === null) {
    rejectUnboundWorkspaceFiles(bundleRoot);
    if (
      JSON.stringify(bundleInventory(collaborationManifest, null)) !== JSON.stringify(inventory)
    ) {
      throw filesError(
        "workspace-bundle.inventory-mismatch",
        "workspace bundle inventory differs from its bound components",
      );
    }
    return {
      envelope: { ...identity, bundleId: raw.bundleId },
      collaborationManifest,
      workspaceFilesManifest: null,
    };
  }
  if (!existsSync(snapshotPath)) {
    throw filesError(
      "workspace-bundle.workspace-files-missing",
      "bound workspace file manifest is missing",
    );
  }
  const snapshotBytes = readRegularFileNoFollow(snapshotPath);
  if (hash(snapshotBytes) !== workspaceFiles.manifestHash) {
    throw filesError(
      "workspace-bundle.workspace-files-manifest-mismatch",
      "workspace file manifest does not match the bound hash",
    );
  }
  const workspaceFilesManifest = validateWorkspaceFilesManifest(
    parseBundleJson(snapshotBytes, "workspace-bundle.workspace-files-manifest-invalid"),
  );
  if (
    capture.workspaceFiles === null ||
    JSON.stringify({
      ...workspaceFilesManifest.capture,
      publicationFingerprint: workspaceFilesManifest.capture.endFingerprint,
    }) !== JSON.stringify(capture.workspaceFiles)
  ) {
    throw filesError(
      "workspace-bundle.capture-binding-invalid",
      "workspace file capture boundary does not match the bound component",
    );
  }
  if (
    JSON.stringify(bundleInventory(collaborationManifest, workspaceFilesManifest)) !==
    JSON.stringify(inventory)
  ) {
    throw filesError(
      "workspace-bundle.inventory-mismatch",
      "workspace bundle inventory differs from its bound components",
    );
  }
  return {
    envelope: { ...identity, bundleId: raw.bundleId },
    collaborationManifest,
    workspaceFilesManifest,
  };
}

export function validateWorkspaceFilesManifest(input: unknown): WorkspaceFilesManifest {
  if (isRecord(input) && input.protocol === "tweakloop.workspace-file-snapshot/v1") {
    throw filesError(
      "workspace-files.migration-required",
      "workspace file snapshot predates the quiescent-verified capture contract; re-export it",
      { requiredProtocol: WORKSPACE_FILES_SNAPSHOT_PROTOCOL },
    );
  }
  if (!isRecord(input) || input.protocol !== WORKSPACE_FILES_SNAPSHOT_PROTOCOL) {
    throw filesError("workspace-files.snapshot-protocol", "unsupported workspace file snapshot");
  }
  const config = validateWorkspaceFilesConfig(input.config);
  const capture = validateWorkspaceFilesCaptureBoundary(input.capture);
  if (!Array.isArray(input.files) || input.files.length > MAX_FILE_COUNT) {
    throw filesError("workspace-files.manifest-files", "invalid workspace file inventory");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = input.files.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw filesError("workspace-files.manifest-entry", `invalid file entry at index ${index}`);
    }
    const path = requirePortablePath(candidate.path, `files[${index}].path`);
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) {
      throw filesError("workspace-files.path-collision", `duplicate portable file path: ${path}`);
    }
    seen.add(key);
    const hashValue = requireHash(candidate.hash, `files[${index}].hash`);
    const byteLength = requireByteLength(candidate.byteLength, `files[${index}].byteLength`);
    const mode = requireMode(candidate.mode, `files[${index}].mode`);
    const objectPath = requirePortablePath(candidate.objectPath, `files[${index}].objectPath`);
    if (objectPath !== objectPathFor(hashValue)) {
      throw filesError(
        "workspace-files.object-path",
        `object path does not match hash for ${path}`,
      );
    }
    totalBytes += byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      throw filesError("workspace-files.total-too-large", "workspace file snapshot is too large");
    }
    return { path, hash: hashValue, byteLength, mode, objectPath };
  });
  if (input.totalBytes !== totalBytes) {
    throw filesError(
      "workspace-files.total-mismatch",
      "workspace file total does not match inventory",
    );
  }
  if (!Array.isArray(input.excluded)) {
    throw filesError("workspace-files.exclusions", "invalid workspace file exclusion receipt");
  }
  const excluded: WorkspaceFileExclusion[] = input.excluded.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw filesError("workspace-files.exclusion-entry", `invalid exclusion at index ${index}`);
    }
    const path = requirePortablePath(candidate.path, `excluded[${index}].path`);
    if (
      candidate.reason !== "configured" &&
      candidate.reason !== "managed-state" &&
      candidate.reason !== "secret-default"
    ) {
      throw filesError("workspace-files.exclusion-reason", `invalid exclusion reason for ${path}`);
    }
    return { path, reason: candidate.reason as WorkspaceFileExclusion["reason"] };
  });
  return {
    protocol: WORKSPACE_FILES_SNAPSHOT_PROTOCOL,
    config,
    files,
    excluded,
    totalBytes,
    capture,
  };
}

function workspaceFilesCaptureBoundary(
  startFingerprint: string,
  endFingerprint: string,
): WorkspaceFilesCaptureBoundary {
  return {
    consistency: WORKSPACE_FILES_CAPTURE_CONSISTENCY,
    observation: WORKSPACE_FILES_OBSERVATION,
    fingerprintAlgorithm: "sha256",
    observedFields: WORKSPACE_FILES_OBSERVED_FIELDS,
    startFingerprint,
    endFingerprint,
  };
}

function validateWorkspaceFilesCaptureBoundary(input: unknown): WorkspaceFilesCaptureBoundary {
  if (
    !isRecord(input) ||
    input.consistency !== WORKSPACE_FILES_CAPTURE_CONSISTENCY ||
    input.observation !== WORKSPACE_FILES_OBSERVATION ||
    input.fingerprintAlgorithm !== "sha256" ||
    !Array.isArray(input.observedFields) ||
    JSON.stringify(input.observedFields) !== JSON.stringify(WORKSPACE_FILES_OBSERVED_FIELDS)
  ) {
    throw filesError(
      "workspace-files.capture-binding-invalid",
      "workspace file capture boundary is invalid",
    );
  }
  const startFingerprint = requireHash(input.startFingerprint, "capture.startFingerprint");
  const endFingerprint = requireHash(input.endFingerprint, "capture.endFingerprint");
  if (startFingerprint !== endFingerprint) {
    throw filesError(
      "workspace-files.capture-changed",
      "workspace file closed set changed during capture",
      { startFingerprint, endFingerprint },
    );
  }
  return workspaceFilesCaptureBoundary(startFingerprint, endFingerprint);
}

function reobserveWorkspaceFiles(
  root: string,
  config: WorkspaceFilesConfig,
  expectedFingerprint: string,
  phase: "component-publication" | "bundle-publication",
): Readonly<{ fingerprint: string }> {
  let observed: ReturnType<typeof inventoryWorkspaceFiles>;
  try {
    observed = inventoryWorkspaceFiles(root, config);
  } catch (error) {
    throw filesError(
      "workspace-files.capture-changed",
      `workspace file closed set could not be re-observed before ${phase}`,
      {
        phase,
        expectedFingerprint,
        causeCode: error instanceof WorkspaceFilesError ? error.code : "workspace-files.io-error",
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
  if (observed.fingerprint !== expectedFingerprint) {
    throw filesError(
      "workspace-files.capture-changed",
      `workspace file closed set changed before ${phase}`,
      { phase, expectedFingerprint, observedFingerprint: observed.fingerprint },
    );
  }
  return { fingerprint: observed.fingerprint };
}

function verifyWorkspaceFilesAtBundlePublication(
  bundleRoot: string,
  verification: WorkspaceFilesCaptureVerification | undefined,
): string {
  if (verification === undefined) {
    throw filesError(
      "workspace-files.capture-verification-missing",
      "workspace file capture verification authority is required for bundle publication",
    );
  }
  const authority = workspaceFilesCaptureAuthorities.get(verification);
  if (authority === undefined) {
    throw filesError(
      "workspace-files.capture-verification-invalid",
      "workspace file capture verification authority is invalid or already consumed",
    );
  }
  workspaceFilesCaptureAuthorities.delete(verification);
  const component = readWorkspaceFilesComponent(bundleRoot);
  if (
    verification.protocol !== "tweakloop.workspace-files-capture-verification/v1" ||
    verification.fingerprint !== authority.fingerprint ||
    component.manifest.capture.endFingerprint !== authority.fingerprint
  ) {
    throw filesError(
      "workspace-files.capture-verification-mismatch",
      "workspace file capture verification does not match the staged component",
    );
  }
  return reobserveWorkspaceFiles(
    authority.workspaceRoot,
    authority.config,
    authority.fingerprint,
    "bundle-publication",
  ).fingerprint;
}

function rejectUnexpectedWorkspaceFilesVerification(
  verification: WorkspaceFilesCaptureVerification | undefined,
): null {
  if (verification !== undefined) {
    workspaceFilesCaptureAuthorities.delete(verification);
    throw filesError(
      "workspace-files.capture-verification-unexpected",
      "workspace file capture verification was supplied for a collaboration-only bundle",
    );
  }
  return null;
}

type WorkspaceFileFingerprintEntry = Readonly<{
  path: string;
  type: "file";
  device: string;
  inode: string;
  hash: string;
  byteLength: number;
  mode: number;
}>;

type WorkspaceFileFingerprintExclusion = Readonly<{
  path: string;
  reason: WorkspaceFileExclusion["reason"];
  type: "file" | "directory";
  device: string;
  inode: string;
  mode: number;
}>;

function inventoryWorkspaceFiles(
  root: string,
  config: WorkspaceFilesConfig,
): Readonly<{
  files: readonly WorkspaceFileEntry[];
  excluded: readonly WorkspaceFileExclusion[];
  totalBytes: number;
  fingerprint: string;
}> {
  const files: WorkspaceFileEntry[] = [];
  const excluded: WorkspaceFileExclusion[] = [];
  const selectedObservation: WorkspaceFileFingerprintEntry[] = [];
  const excludedObservation: WorkspaceFileFingerprintExclusion[] = [];
  let totalBytes = 0;

  function visit(directory: string): void {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const portable = portableRelative(root, absolute);
      const entry = lstatSync(absolute, { bigint: true });
      if (entry.isSymbolicLink()) {
        throw filesError(
          "workspace-files.symlink-refused",
          `workspace file capture refuses symlinks: ${portable}`,
          { path: portable },
        );
      }
      if (
        isSecretPath(portable) &&
        config.includes.some((pattern) => !GLOB_META.test(pattern) && pattern === portable)
      ) {
        throw filesError(
          "workspace-files.secret-explicitly-included",
          `workspace file config explicitly includes secret-default path: ${portable}`,
          { path: portable },
        );
      }
      const excludedReason = exclusionReason(portable, config.excludes);
      if (excludedReason !== undefined) {
        if (!entry.isFile() && !entry.isDirectory()) {
          continue;
        }
        const exclusionPath = entry.isDirectory() ? `${portable}/**` : portable;
        excluded.push({
          path: exclusionPath,
          reason: excludedReason,
        });
        excludedObservation.push({
          path: exclusionPath,
          reason: excludedReason,
          type: entry.isDirectory() ? "directory" : "file",
          device: entry.dev.toString(10),
          inode: entry.ino.toString(10),
          mode: Number(entry.mode & 0o777n),
        });
        continue;
      }
      if (entry.isDirectory()) {
        visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!matchesAny(portable, config.includes)) continue;
      if (isSecretPath(portable)) {
        excluded.push({ path: portable, reason: "secret-default" });
        excludedObservation.push({
          path: portable,
          reason: "secret-default",
          type: "file",
          device: entry.dev.toString(10),
          inode: entry.ino.toString(10),
          mode: Number(entry.mode & 0o777n),
        });
        continue;
      }
      const verified = hashRegularFile(absolute);
      const byteLength = verified.byteLength;
      totalBytes += byteLength;
      if (files.length + 1 > MAX_FILE_COUNT || totalBytes > MAX_TOTAL_BYTES) {
        throw filesError(
          "workspace-files.capture-too-large",
          "workspace file capture exceeds limits",
        );
      }
      const fileHash = verified.hash;
      files.push({
        path: portable,
        hash: fileHash,
        byteLength,
        mode: verified.mode,
        objectPath: objectPathFor(fileHash),
      });
      selectedObservation.push({
        path: portable,
        type: "file",
        device: verified.device,
        inode: verified.inode,
        hash: fileHash,
        byteLength,
        mode: verified.mode,
      });
    }
  }

  visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  excluded.sort((left, right) => left.path.localeCompare(right.path));
  selectedObservation.sort((left, right) => left.path.localeCompare(right.path));
  excludedObservation.sort((left, right) => left.path.localeCompare(right.path));
  const fingerprint = hash(
    Buffer.from(
      `${WORKSPACE_FILES_FINGERPRINT_DOMAIN}${JSON.stringify({
        config,
        selected: selectedObservation,
        excluded: excludedObservation,
      })}`,
      "utf8",
    ),
  );
  return { files, excluded, totalBytes, fingerprint };
}

type DurableHeadEntry = Readonly<{
  path: string;
  hash: string;
  byteLength: number;
  artifactId: string;
  revisionId: string;
}>;

function durableHeadEntries(manifest: WorkspaceExportManifest): DurableHeadEntry[] {
  const revisions = new Map(manifest.revisions.map((revision) => [revision.revisionId, revision]));
  return manifest.artifacts.map((artifact) => {
    const revision = revisions.get(artifact.headRevisionId);
    if (!revision || revision.artifactId !== artifact.artifactId) {
      throw filesError(
        "workspace-files.overlay-head-missing",
        `durable head is unavailable for artifact: ${artifact.artifactId}`,
      );
    }
    const entry = revision.files.find(
      (file) => file.path === revision.entryPath && file.hash === revision.entryHash,
    );
    if (entry?.byteLength === undefined) {
      throw filesError(
        "workspace-files.overlay-head-size-missing",
        `durable head size is unavailable for artifact: ${artifact.artifactId}`,
      );
    }
    return {
      path: requirePortablePath(artifact.exportedPath, "artifact exportedPath"),
      hash: requireHash(revision.entryHash, "revision entryHash"),
      byteLength: requireByteLength(entry.byteLength, "revision entry byteLength"),
      artifactId: artifact.artifactId,
      revisionId: revision.revisionId,
    };
  });
}

function assertCrossRailPaths(
  durable: readonly DurableHeadEntry[],
  working: readonly WorkspaceFileEntry[],
): void {
  const paths = [
    ...durable.map((entry) => ({
      path: entry.path,
      rail: "durable" as const,
      artifactId: entry.artifactId,
    })),
    ...working.map((entry) => ({
      path: entry.path,
      rail: "workspace-files" as const,
      artifactId: null,
    })),
  ];
  const normalized = new Map<
    string,
    { path: string; rail: "durable" | "workspace-files"; artifactId: string | null }
  >();
  for (const owner of paths) {
    if (
      (owner.path === ".tweakloop" || owner.path.startsWith(".tweakloop/")) &&
      !isExporterOwnedArtifactFallback(owner)
    ) {
      throw filesError(
        "workspace-files.overlay-reserved-path",
        `workspace overlay collides with reserved metadata: ${owner.path}`,
        owner,
      );
    }
    const key = owner.path.normalize("NFC").toLowerCase();
    const prior = normalized.get(key);
    if (prior && prior.path !== owner.path) {
      throw filesError(
        "workspace-files.overlay-normalized-collision",
        `workspace overlay paths collide after case-fold/NFC normalization: ${prior.path} and ${owner.path}`,
        { prior, owner },
      );
    }
    if (prior && prior.rail === owner.rail) {
      throw filesError(
        "workspace-files.overlay-path-collision",
        `workspace overlay rail repeats a path: ${owner.path}`,
        { prior, owner },
      );
    }
    normalized.set(key, prior ?? owner);
  }
  const ordered = [...normalized.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (let index = 0; index < ordered.length; index += 1) {
    const [candidate, owner] = ordered[index] as [
      string,
      { path: string; rail: string; artifactId: string | null },
    ];
    for (let parentIndex = 1; parentIndex < candidate.split("/").length; parentIndex += 1) {
      const parent = candidate.split("/").slice(0, parentIndex).join("/");
      const parentOwner = normalized.get(parent);
      if (parentOwner) {
        throw filesError(
          "workspace-files.overlay-prefix-collision",
          `workspace overlay file/path prefix collision: ${parentOwner.path} and ${owner.path}`,
          { parent: parentOwner, child: owner },
        );
      }
    }
  }
}

function isExporterOwnedArtifactFallback(
  input: Readonly<{
    path: string;
    rail: "durable" | "workspace-files";
    artifactId: string | null;
  }>,
): boolean {
  if (input.rail !== "durable" || input.artifactId === null) return false;
  const parts = input.path.split("/");
  return (
    parts.length === 4 &&
    parts[0] === ".tweakloop" &&
    parts[1] === "artifacts" &&
    parts[2] === input.artifactId &&
    (parts[3]?.length ?? 0) > 0
  );
}

function preflightCombinedStage(
  stagedRoot: string,
  entries: readonly WorkspaceFilesOverlayEntry[],
): void {
  for (const entry of entries) {
    assertOverlayTargetSafe(stagedRoot, entry.path);
    const target = resolvePortable(stagedRoot, entry.path);
    if (entry.baseHash === null) {
      if (!existsSync(target)) continue;
      const actual = hashRegularFile(target);
      if (actual.hash !== entry.workingHash || actual.mode !== entry.mode) {
        throw filesError(
          "workspace-files.overlay-untracked-conflict",
          `untracked workspace file already exists in the combined stage: ${entry.path}`,
        );
      }
      continue;
    }
    if (!existsSync(target)) {
      throw filesError(
        "workspace-files.overlay-base-missing",
        `durable base is missing from the combined stage: ${entry.path}`,
      );
    }
    const actual = hashRegularFile(target);
    const alreadyOverlaid =
      entry.workingHash !== null && actual.hash === entry.workingHash && actual.mode === entry.mode;
    if (actual.hash !== entry.baseHash && !alreadyOverlaid) {
      throw filesError(
        "workspace-files.overlay-base-mismatch",
        `durable base differs from the planned head: ${entry.path}`,
        { expected: entry.baseHash, actual: actual.hash },
      );
    }
  }
}

function requireOperationIdentity(operationId: string, ownershipNonce: string): void {
  if (!OPERATION_ID.test(operationId)) {
    throw filesError("workspace-files.operation-id-invalid", "workspace operation ID is invalid");
  }
  if (!OWNERSHIP_NONCE.test(ownershipNonce)) {
    throw filesError(
      "workspace-files.ownership-nonce-invalid",
      "workspace ownership nonce is invalid",
    );
  }
}

function assertBundleStageOwnership(
  claimRoot: string,
  ownerPath: string,
  expectedOwner: string,
  expectedDevice: number,
  expectedInode: number,
): void {
  const status = lstatSync(claimRoot);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    status.dev !== expectedDevice ||
    status.ino !== expectedInode ||
    readRegularFileNoFollow(ownerPath).toString("utf8") !== expectedOwner
  ) {
    throw filesError(
      "workspace-bundle.stage-ownership-lost",
      "workspace bundle staging ownership changed",
    );
  }
}

function cleanupBundleStageClaim(
  claimRoot: string,
  ownerPath: string,
  expectedOwner: string,
  expectedDevice: number,
  expectedInode: number,
): void {
  assertBundleStageOwnership(claimRoot, ownerPath, expectedOwner, expectedDevice, expectedInode);
  rmSync(claimRoot, { recursive: true });
}

function assertDisjointRoots(left: string, right: string): void {
  if (left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`)) {
    throw filesError(
      "workspace-files.overlay-roots-overlap",
      "workspace overlay stage and destination must be disjoint",
    );
  }
}

function assertOverlayTargetSafe(root: string, portablePath: string): void {
  const parts = requirePortablePath(portablePath, "overlay path").split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) continue;
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw filesError(
        "workspace-files.overlay-parent-conflict",
        `workspace overlay parent is not a real directory: ${portablePath}`,
        { path: portablePath },
      );
    }
  }
  const target = resolvePortable(root, portablePath);
  if (!existsSync(target)) return;
  const status = lstatSync(target);
  if (status.isSymbolicLink() || !status.isFile()) {
    throw filesError(
      "workspace-files.overlay-target-conflict",
      `workspace overlay target is not a regular file: ${portablePath}`,
      { path: portablePath },
    );
  }
}

function assertRealPathSegments(root: string, portablePath: string): void {
  let current = root;
  for (const part of requirePortablePath(portablePath, "path").split("/")) {
    current = join(current, part);
    if (!existsSync(current)) {
      throw filesError(
        "workspace-files.path-missing",
        `workspace path segment is missing: ${portablePath}`,
      );
    }
    const status = lstatSync(current);
    if (status.isSymbolicLink()) {
      throw filesError(
        "workspace-files.symlink-refused",
        `workspace path contains a symlink: ${portablePath}`,
      );
    }
  }
}

function ensureRealParentDirectories(root: string, portablePath: string): void {
  let current = root;
  for (const part of requirePortablePath(portablePath, "path").split("/").slice(0, -1)) {
    current = join(current, part);
    if (!existsSync(current)) {
      mkdirSync(current, { mode: 0o700 });
    }
    const status = lstatSync(current);
    if (status.isSymbolicLink() || !status.isDirectory()) {
      throw filesError(
        "workspace-files.overlay-parent-conflict",
        `workspace overlay parent is not a real directory: ${portablePath}`,
      );
    }
  }
}

function streamCopyVerified(
  source: string,
  target: string,
  file: WorkspaceFileEntry,
  options: Readonly<{ targetMode?: number; expectedSourceMode?: number }> = {},
): void {
  let sourceDescriptor: number | undefined;
  let targetDescriptor: number | undefined;
  try {
    sourceDescriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const sourceStatus = fstatSync(sourceDescriptor);
    if (
      !sourceStatus.isFile() ||
      sourceStatus.size !== file.byteLength ||
      (options.expectedSourceMode !== undefined &&
        (sourceStatus.mode & 0o777) !== options.expectedSourceMode)
    ) {
      throw filesError(
        "workspace-files.object-invalid",
        `saved workspace object has an invalid type or size: ${file.path}`,
      );
    }
    targetDescriptor = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      options.targetMode ?? file.mode,
    );
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    for (;;) {
      const read = readSync(sourceDescriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      byteLength += read;
      let written = 0;
      while (written < read) {
        const count = writeSync(targetDescriptor, buffer, written, read - written);
        if (count === 0) {
          throw filesError(
            "workspace-files.write-incomplete",
            `workspace file staging made no write progress: ${file.path}`,
          );
        }
        written += count;
      }
    }
    const targetMode = options.targetMode ?? file.mode;
    fchmodSync(targetDescriptor, targetMode);
    fsyncSync(targetDescriptor);
    const targetStatus = fstatSync(targetDescriptor);
    if (
      byteLength !== file.byteLength ||
      digest.digest("hex") !== file.hash ||
      !targetStatus.isFile() ||
      targetStatus.size !== file.byteLength ||
      (targetStatus.mode & 0o777) !== targetMode
    ) {
      throw filesError(
        "workspace-files.object-invalid",
        `saved workspace object failed streamed verification: ${file.path}`,
        { path: file.path, expectedHash: file.hash },
      );
    }
  } catch (error) {
    if (targetDescriptor !== undefined) {
      closeSync(targetDescriptor);
      targetDescriptor = undefined;
    }
    rmSync(target, { force: true });
    if (error instanceof WorkspaceFilesError) throw error;
    throw filesError("workspace-files.copy-refused", `cannot stage workspace file: ${file.path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (targetDescriptor !== undefined) closeSync(targetDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }
  fsyncDirectory(dirname(target));
}

function hashRegularFile(path: string): Readonly<{
  hash: string;
  byteLength: number;
  mode: number;
  device: string;
  inode: string;
}> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor, { bigint: true });
    if (!status.isFile()) {
      throw filesError("workspace-files.not-regular", `not a regular file: ${path}`);
    }
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let byteLength = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.byteLength, null);
      if (read === 0) break;
      digest.update(buffer.subarray(0, read));
      byteLength += read;
    }
    return {
      hash: digest.digest("hex"),
      byteLength,
      mode: Number(status.mode & 0o777n),
      device: status.dev.toString(10),
      inode: status.ino.toString(10),
    };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY);
    fsyncSync(descriptor);
  } catch (error) {
    throw filesError(
      "workspace-files.directory-fsync-unsupported",
      `cannot fsync workspace directory: ${path}`,
      { cause: error instanceof Error ? error.message : String(error) },
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fsyncTree(root: string): void {
  requireRealDirectory(root, "workspace-bundle.stage-invalid");
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const status = lstatSync(path);
    if (status.isSymbolicLink()) {
      throw filesError(
        "workspace-bundle.stage-symlink",
        `workspace bundle staging contains a symlink: ${path}`,
      );
    }
    if (status.isDirectory()) {
      fsyncTree(path);
      continue;
    }
    if (!status.isFile()) {
      throw filesError(
        "workspace-bundle.stage-entry-invalid",
        `workspace bundle staging contains an unsupported entry: ${path}`,
      );
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== status.dev || opened.ino !== status.ino) {
        throw filesError(
          "workspace-bundle.stage-entry-changed",
          `workspace bundle staging entry changed before fsync: ${path}`,
        );
      }
      fsyncSync(descriptor);
    } catch (error) {
      if (error instanceof WorkspaceFilesError) throw error;
      throw filesError(
        "workspace-bundle.stage-fsync-failed",
        `cannot fsync workspace bundle staging entry: ${path}`,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  fsyncDirectory(root);
}

function collaborationSource(input: unknown): WorkspaceBundleEnvelope["source"] {
  if (!isRecord(input) || input.protocol !== "tweakloop.workspace-export/v1") {
    throw filesError(
      "workspace-bundle.collaboration-manifest-invalid",
      "workspace collaboration manifest is invalid",
    );
  }
  if (!Number.isSafeInteger(input.capturedSeq) || (input.capturedSeq as number) < 1) {
    throw filesError(
      "workspace-bundle.captured-seq-invalid",
      "workspace collaboration captured sequence is invalid",
    );
  }
  if (!isRecord(input.source)) {
    throw filesError("workspace-bundle.source-invalid", "workspace bundle source is invalid");
  }
  return validateBundleSource({ ...input.source, capturedSeq: input.capturedSeq });
}

function validateBundleSource(input: unknown): WorkspaceBundleEnvelope["source"] {
  if (!isRecord(input)) {
    throw filesError("workspace-bundle.source-invalid", "workspace bundle source is invalid");
  }
  for (const field of ["workspaceId", "projectId"] as const) {
    if (typeof input[field] !== "string" || input[field].length === 0) {
      throw filesError("workspace-bundle.source-invalid", `workspace bundle ${field} is invalid`);
    }
  }
  if (!Number.isSafeInteger(input.capturedSeq) || (input.capturedSeq as number) < 1) {
    throw filesError(
      "workspace-bundle.captured-seq-invalid",
      "workspace bundle captured sequence is invalid",
    );
  }
  return {
    workspaceId: input.workspaceId as string,
    projectId: input.projectId as string,
    capturedSeq: input.capturedSeq as number,
  };
}

function validateCollaborationBinding(input: unknown): WorkspaceBundleEnvelope["collaboration"] {
  if (!isRecord(input) || input.manifestPath !== WORKSPACE_EXPORT_MANIFEST_PATH) {
    throw filesError(
      "workspace-bundle.collaboration-binding-invalid",
      "workspace collaboration binding is invalid",
    );
  }
  return {
    manifestPath: WORKSPACE_EXPORT_MANIFEST_PATH,
    manifestHash: requireHash(input.manifestHash, "collaboration.manifestHash"),
  };
}

function validateWorkspaceFilesBinding(input: unknown): WorkspaceBundleEnvelope["workspaceFiles"] {
  if (input === null) return null;
  if (
    !isRecord(input) ||
    input.manifestPath !== BUNDLE_WORKSPACE_FILES_MANIFEST_PATH ||
    input.precedence !== WORKSPACE_FILE_OVERLAY_PRECEDENCE ||
    input.overlayVersion !== WORKSPACE_FILE_OVERLAY_VERSION
  ) {
    throw filesError(
      "workspace-bundle.workspace-files-binding-invalid",
      "workspace file binding is invalid",
    );
  }
  return {
    manifestPath: BUNDLE_WORKSPACE_FILES_MANIFEST_PATH,
    manifestHash: requireHash(input.manifestHash, "workspaceFiles.manifestHash"),
    precedence: WORKSPACE_FILE_OVERLAY_PRECEDENCE,
    overlayVersion: WORKSPACE_FILE_OVERLAY_VERSION,
  };
}

function validateCaptureBinding(
  input: unknown,
  capturedSeq: number,
  hasWorkspaceFiles: boolean,
): WorkspaceBundleEnvelope["capture"] {
  if (
    !isRecord(input) ||
    !isRecord(input.collaboration) ||
    input.collaboration.capturedSeq !== capturedSeq ||
    input.collaboration.observedEndSeq !== capturedSeq ||
    input.collaboration.consistency !== "event-seq-exact"
  ) {
    throw filesError(
      "workspace-bundle.capture-binding-invalid",
      "workspace collaboration capture boundary is invalid",
    );
  }
  let workspaceFiles: WorkspaceBundleEnvelope["capture"]["workspaceFiles"] = null;
  if (hasWorkspaceFiles) {
    if (!isRecord(input.workspaceFiles)) {
      throw filesError(
        "workspace-bundle.capture-binding-invalid",
        "workspace file capture boundary is missing",
      );
    }
    const boundary = validateWorkspaceFilesCaptureBoundary(input.workspaceFiles);
    const publicationFingerprint = requireHash(
      input.workspaceFiles.publicationFingerprint,
      "capture.workspaceFiles.publicationFingerprint",
    );
    if (publicationFingerprint !== boundary.endFingerprint) {
      throw filesError(
        "workspace-files.capture-changed",
        "workspace file closed set changed before bundle publication",
        {
          expectedFingerprint: boundary.endFingerprint,
          publicationFingerprint,
        },
      );
    }
    workspaceFiles = { ...boundary, publicationFingerprint };
  } else if (input.workspaceFiles !== null) {
    throw filesError(
      "workspace-bundle.capture-binding-invalid",
      "collaboration-only bundle must bind an explicit null workspace file capture",
    );
  }
  return {
    collaboration: {
      capturedSeq,
      observedEndSeq: capturedSeq,
      consistency: "event-seq-exact",
    },
    workspaceFiles,
  };
}

function validateInventoryBinding(input: unknown): WorkspaceBundleEnvelope["inventory"] {
  if (
    !isRecord(input) ||
    !Number.isSafeInteger(input.objectCount) ||
    (input.objectCount as number) < 0 ||
    (input.objectCount as number) > MAX_FILE_COUNT ||
    !Number.isSafeInteger(input.totalBytes) ||
    (input.totalBytes as number) < 0 ||
    (input.totalBytes as number) > MAX_TOTAL_BYTES
  ) {
    throw filesError("workspace-bundle.inventory-invalid", "workspace bundle inventory is invalid");
  }
  return { objectCount: input.objectCount as number, totalBytes: input.totalBytes as number };
}

function readWorkspaceFilesComponent(bundleRoot: string): Readonly<{
  binding: Exclude<WorkspaceBundleEnvelope["workspaceFiles"], null>;
  manifest: WorkspaceFilesManifest;
}> {
  const bytes = readBundleFile(
    bundleRoot,
    BUNDLE_WORKSPACE_FILES_MANIFEST_PATH,
    "workspace-bundle.workspace-files-missing",
  );
  const manifest = validateWorkspaceFilesManifest(
    parseBundleJson(bytes, "workspace-bundle.workspace-files-manifest-invalid"),
  );
  return {
    binding: {
      manifestPath: BUNDLE_WORKSPACE_FILES_MANIFEST_PATH,
      manifestHash: hash(bytes),
      precedence: WORKSPACE_FILE_OVERLAY_PRECEDENCE,
      overlayVersion: WORKSPACE_FILE_OVERLAY_VERSION,
    },
    manifest,
  };
}

function bundleInventory(
  collaboration: WorkspaceExportManifest,
  workspaceFiles: WorkspaceFilesManifest | null,
): WorkspaceBundleEnvelope["inventory"] {
  const objects = new Map<string, number>();
  const add = (hashValue: unknown, byteLength: unknown, field: string): void => {
    const objectHash = requireHash(hashValue, `${field}.hash`);
    const objectBytes = requireByteLength(byteLength, `${field}.byteLength`);
    const existing = objects.get(objectHash);
    if (existing !== undefined && existing !== objectBytes) {
      throw filesError(
        "workspace-bundle.object-descriptor-conflict",
        `workspace bundle hash has conflicting sizes: ${objectHash}`,
      );
    }
    objects.set(objectHash, objectBytes);
  };
  for (const [revisionIndex, revision] of collaboration.revisions.entries()) {
    for (const [fileIndex, file] of revision.files.entries()) {
      add(file.hash, file.byteLength, `revisions[${revisionIndex}].files[${fileIndex}]`);
    }
  }
  for (const [index, attachment] of collaboration.attachments.entries()) {
    add(attachment.descriptor.hash, attachment.descriptor.byteLength, `attachments[${index}]`);
  }
  for (const [index, receipt] of (collaboration.whiteboardSemanticReceipts ?? []).entries()) {
    add(
      receipt.sceneObject.hash,
      receipt.sceneObject.byteLength,
      `semanticReceipts[${index}].scene`,
    );
    add(
      receipt.elementIndexObject.hash,
      receipt.elementIndexObject.byteLength,
      `semanticReceipts[${index}].index`,
    );
  }
  for (const [index, file] of (workspaceFiles?.files ?? []).entries()) {
    add(file.hash, file.byteLength, `workspaceFiles[${index}]`);
  }
  let totalBytes = 0;
  for (const byteLength of objects.values()) {
    totalBytes += byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_TOTAL_BYTES) {
      throw filesError(
        "workspace-bundle.total-too-large",
        "combined workspace bundle exceeds the total byte limit",
      );
    }
  }
  if (objects.size > MAX_FILE_COUNT) {
    throw filesError(
      "workspace-bundle.object-count-too-large",
      "combined workspace bundle exceeds the object count limit",
    );
  }
  return { objectCount: objects.size, totalBytes };
}

function rejectUnboundWorkspaceFiles(bundleRoot: string): null {
  if (existsSync(resolve(bundleRoot, "workspace-files"))) {
    throw filesError(
      "workspace-bundle.workspace-files-unbound",
      "workspace bundle contains an unbound workspace file snapshot",
    );
  }
  return null;
}

function readBundleFile(bundleRoot: string, path: string, missingCode: string): Buffer {
  const absolute = resolvePortable(bundleRoot, path);
  if (!existsSync(absolute)) {
    throw filesError(missingCode, `workspace bundle file is missing: ${path}`, { path });
  }
  return readRegularFileNoFollow(absolute);
}

function parseBundleJson(bytes: Buffer, code: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw filesError(code, "workspace bundle component is not valid JSON", {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

function bundleId(identity: Omit<WorkspaceBundleEnvelope, "bundleId">): string {
  return `bundle_${hash(Buffer.from(`${BUNDLE_ID_DOMAIN}${JSON.stringify(identity)}`, "utf8"))}`;
}

function validatePatterns(input: unknown, field: string, allowEmpty: boolean): string[] {
  if (!Array.isArray(input) || (!allowEmpty && input.length === 0)) {
    throw filesError(
      "workspace-files.config-patterns",
      `${field} must be ${allowEmpty ? "an" : "a non-empty"} array of relative globs`,
    );
  }
  return input.map((candidate, index) => {
    if (typeof candidate !== "string" || candidate.length === 0) {
      throw filesError("workspace-files.config-pattern", `${field}[${index}] must be a glob`);
    }
    if (candidate.includes("\\") || isAbsolute(candidate) || candidate.startsWith("/")) {
      throw filesError(
        "workspace-files.config-path",
        `${field}[${index}] must be a forward-slash relative glob`,
      );
    }
    const segments = candidate.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw filesError(
        "workspace-files.config-traversal",
        `${field}[${index}] contains an unsafe path segment`,
      );
    }
    return candidate;
  });
}

function validateNotes(input: unknown): string[] {
  if (!Array.isArray(input) || input.some((note) => typeof note !== "string")) {
    throw filesError("workspace-files.config-notes", "notes must be an array of strings");
  }
  return input as string[];
}

function exclusionReason(
  path: string,
  configured: readonly string[],
): WorkspaceFileExclusion["reason"] | undefined {
  if (matchesAny(path, DEFAULT_EXCLUDES)) return "managed-state";
  if (matchesAny(path, configured)) return "configured";
  if (isSecretPath(path)) return "secret-default";
  return undefined;
}

function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern.endsWith("/**")) {
      const base = pattern.slice(0, -3);
      if (path === base || path.startsWith(`${base}/`)) return true;
    }
    return matchesGlob(path, pattern);
  });
}

function isSecretPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) as string;
  if (parts.includes(".ssh")) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (name.endsWith(".pem") || name.endsWith(".key") || name.endsWith(".p12")) return true;
  if (name === "credentials" || name.startsWith("credentials.")) return true;
  if (name === "id_rsa" || name === "id_ed25519") return true;
  return false;
}

function requirePortablePath(input: unknown, field: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.includes("\\") ||
    isAbsolute(input)
  ) {
    throw filesError("workspace-files.path-invalid", `${field} must be a relative portable path`);
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw filesError("workspace-files.path-traversal", `${field} contains an unsafe path segment`);
  }
  return input;
}

function requireHash(input: unknown, field: string): string {
  if (typeof input !== "string" || !SHA256.test(input)) {
    throw filesError("workspace-files.hash-invalid", `${field} must be a sha256 hash`);
  }
  return input;
}

function requireByteLength(input: unknown, field: string): number {
  if (
    !Number.isSafeInteger(input) ||
    (input as number) < 0 ||
    (input as number) > MAX_TOTAL_BYTES
  ) {
    throw filesError("workspace-files.byte-length", `${field} is invalid`);
  }
  return input as number;
}

function requireMode(input: unknown, field: string): number {
  if (!Number.isInteger(input) || (input as number) < 0 || (input as number) > 0o777) {
    throw filesError("workspace-files.mode", `${field} is invalid`);
  }
  return input as number;
}

function objectPathFor(hashValue: string): string {
  return `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${hashValue}`;
}

function portableRelative(root: string, absolute: string): string {
  const value = relative(root, absolute);
  if (value === "" || value === ".." || value.startsWith(`..${sep}`) || isAbsolute(value)) {
    throw filesError("workspace-files.path-escape", "workspace path escapes its root");
  }
  return value.split(sep).join("/");
}

function resolvePortable(root: string, portablePath: string): string {
  const path = requirePortablePath(portablePath, "path");
  const resolved = resolve(root, ...path.split("/"));
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw filesError("workspace-files.path-escape", `path escapes root: ${portablePath}`);
  }
  return resolved;
}

function readRegularFileNoFollow(path: string): Buffer {
  return readRegularFileSnapshot(path).bytes;
}

function readRegularFileSnapshot(path: string): Readonly<{ bytes: Buffer; mode: number }> {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const status = fstatSync(descriptor);
    if (!status.isFile()) {
      throw filesError("workspace-files.not-regular", `not a regular file: ${path}`);
    }
    return { bytes: readFileSync(descriptor), mode: status.mode & 0o777 };
  } catch (error) {
    if (error instanceof WorkspaceFilesError) throw error;
    throw filesError("workspace-files.read-refused", `cannot safely read file: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeRegularFileExclusive(path: string, bytes: Buffer, mode: number): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    writeFileSync(descriptor, bytes);
    fchmodSync(descriptor, mode);
    fsyncSync(descriptor);
    const status = fstatSync(descriptor);
    if (!status.isFile() || (status.mode & 0o777) !== mode) {
      throw filesError(
        "workspace-files.write-verification-failed",
        `workspace file mode failed verification: ${path}`,
      );
    }
  } catch (error) {
    if (error instanceof WorkspaceFilesError) throw error;
    throw filesError("workspace-files.write-refused", `cannot safely write file: ${path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function requireRealDirectory(path: string, code: string): void {
  if (!existsSync(path)) throw filesError(code, `directory does not exist: ${path}`);
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw filesError(code, `path is not a real directory: ${path}`);
  }
}

function assertOutsideRoot(path: string, root: string): void {
  if (path === root || path.startsWith(`${root}${sep}`)) {
    throw filesError(
      "workspace-files.destination-inside-source",
      "workspace file snapshot destination must be outside its source",
    );
  }
}

type DestinationClaim =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "empty-directory"; device: number; inode: number }>;

function claimNewOrEmptyDirectory(path: string): DestinationClaim {
  if (!existsSync(path)) return { kind: "absent" };
  const status = lstatSync(path);
  if (status.isSymbolicLink() || !status.isDirectory() || readdirSync(path).length > 0) {
    throw filesError(
      "workspace-files.destination-not-empty",
      `destination must be new or empty: ${path}`,
    );
  }
  return { kind: "empty-directory", device: status.dev, inode: status.ino };
}

function publishStagingDirectory(
  staging: string,
  destination: string,
  claim: DestinationClaim,
): void {
  if (claim.kind === "absent") {
    if (existsSync(destination)) {
      throw filesError(
        "workspace-files.destination-appeared",
        `destination appeared after validation: ${destination}`,
      );
    }
  } else {
    if (!existsSync(destination)) {
      throw filesError(
        "workspace-files.destination-changed",
        `claimed empty destination disappeared before publication: ${destination}`,
      );
    }
    const current = lstatSync(destination);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== claim.device ||
      current.ino !== claim.inode ||
      readdirSync(destination).length > 0
    ) {
      throw filesError(
        "workspace-files.destination-changed",
        `claimed empty destination changed before publication: ${destination}`,
      );
    }
    rmdirSync(destination);
  }
  fsyncDirectory(staging);
  renameSync(staging, destination);
  fsyncDirectory(dirname(destination));
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function filesError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): WorkspaceFilesError {
  return new WorkspaceFilesError(code, message, details);
}
