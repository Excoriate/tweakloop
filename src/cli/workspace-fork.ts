import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { tweakloopStateRoot } from "../daemon/runtime.js";
import {
  WORKSPACE_EXPORT_MANIFEST_PATH,
  type WorkspaceExportManifest,
  type WorkspaceExportWhiteboardSemanticReceipt,
} from "../protocol/workspace-export.js";
import {
  decodeSemanticSceneReceiptRecord,
  rescopeSemanticSceneReceipt,
} from "../whiteboard/semantic-scene.js";
import {
  validateWorkspaceBundleEnvelope,
  WORKSPACE_FILES_MANIFEST_PATH,
  writeWorkspaceBundleEnvelope,
} from "../workspace/files.js";
import { forkWorkspaceHistory, type WorkspaceForkCheckpoint } from "../workspace/fork.js";
import { validateWorkspaceRestoreManifest } from "../workspace/restore.js";
import {
  createWorkspaceForkPlanStore,
  deriveWorkspaceRestoreOperationId,
  deterministicRestoreId,
} from "../workspace/restore-journal.js";

export type ForkedWorkspaceBundle = Readonly<{
  bundleRoot: string;
  manifest: WorkspaceExportManifest;
  checkpoint: WorkspaceForkCheckpoint;
  processNonce: string;
  operationId: string;
  bundleId: string;
}>;

export function createForkedWorkspaceBundle(
  input: Readonly<{
    sourceBundle: string;
    destinationBundle: string;
    destinationWorkspaceRoot: string;
    sourceSessionId: string;
    destinationAgentId: string;
    operationId?: string;
    planStoreDir?: string;
    now?: () => string;
  }>,
): ForkedWorkspaceBundle {
  const sourceRoot = resolve(input.sourceBundle);
  const destinationRoot = resolve(input.destinationBundle);
  if (existsSync(destinationRoot)) {
    throw new Error(`workspace-fork.destination-exists: ${destinationRoot}`);
  }
  const validated = validateWorkspaceBundleEnvelope(sourceRoot);
  const sourcePlan = validateWorkspaceRestoreManifest(validated.collaborationManifest, {
    bundleId: validated.envelope.bundleId,
    collaborationManifestHash: validated.envelope.collaboration.manifestHash,
  });
  const operationId =
    input.operationId ??
    deriveWorkspaceRestoreOperationId({
      operationKind: "fork",
      bundleId: validated.envelope.bundleId,
      destinationRoot: input.destinationWorkspaceRoot,
      sourceSessionId: input.sourceSessionId,
    });
  const planStore = createWorkspaceForkPlanStore(
    input.planStoreDir ?? resolve(tweakloopStateRoot(), "fork-plans"),
    { ...(input.now ? { now: input.now } : {}) },
  );
  const frozen = planStore.begin({
    operationId,
    sourceBundleId: validated.envelope.bundleId,
    sourceSessionId: input.sourceSessionId,
    destinationRoot: input.destinationWorkspaceRoot,
  });
  let minted = 0;
  const fork = forkWorkspaceHistory({
    events: sourcePlan.manifest.events,
    sourceWorkspaceId: sourcePlan.manifest.source.workspaceId,
    destinationWorkspaceId: frozen.destinationWorkspaceId,
    sourceSessionId: input.sourceSessionId,
    destinationSessionId: frozen.destinationSessionId,
    destinationRootPath: resolve(input.destinationWorkspaceRoot),
    destinationAgentId: input.destinationAgentId,
    destinationProcessNonce: frozen.processNonce,
    recordedAt: frozen.recordedAt,
    forkCommandId: frozen.forkCommandId,
    forkCorrelationId: frozen.forkCorrelationId,
    mint: (kind) => deterministicRestoreId(operationId, `${kind.replaceAll("_", "-")}-${minted++}`),
  });
  const manifest: WorkspaceExportManifest = {
    ...sourcePlan.manifest,
    source: {
      ...sourcePlan.manifest.source,
      workspaceId: frozen.destinationWorkspaceId,
      rootPath: resolve(input.destinationWorkspaceRoot),
    },
    capturedSeq: fork.events.length,
    whiteboardSemanticReceipts: (sourcePlan.manifest.whiteboardSemanticReceipts ?? []).map(
      (entry) => rescopeForkReceipt(entry, frozen.destinationWorkspaceId),
    ),
    events: fork.events,
  };
  validateWorkspaceRestoreManifest(manifest);

  mkdirSync(destinationRoot, { recursive: false, mode: 0o700 });
  const destinationIdentity = directoryIdentity(destinationRoot);
  try {
    for (const path of sourcePlan.requiredPaths) {
      copyVerified(sourceRoot, destinationRoot, path);
    }
    for (const artifact of sourcePlan.manifest.artifacts) {
      const source = resolve(sourceRoot, ...artifact.exportedPath.split("/"));
      if (existsSync(source)) copyVerified(sourceRoot, destinationRoot, artifact.exportedPath);
    }
    if (validated.workspaceFilesManifest) {
      const snapshotSource = resolve(sourceRoot, "workspace-files");
      const snapshotDestination = resolve(destinationRoot, "workspace-files");
      copyVerified(snapshotSource, snapshotDestination, WORKSPACE_FILES_MANIFEST_PATH);
      for (const file of validated.workspaceFilesManifest.files) {
        copyVerified(snapshotSource, snapshotDestination, file.objectPath);
      }
    }
    const manifestPath = resolve(destinationRoot, WORKSPACE_EXPORT_MANIFEST_PATH);
    mkdirSync(dirname(manifestPath), { recursive: true, mode: 0o700 });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    const envelope = writeWorkspaceBundleEnvelope({
      bundleRoot: destinationRoot,
      includeWorkspaceFiles: validated.workspaceFilesManifest !== null,
      observedEndSeq: manifest.capturedSeq,
    });
    const rebound = validateWorkspaceBundleEnvelope(destinationRoot);
    if (rebound.envelope.bundleId !== envelope.bundleId) {
      throw new Error("workspace-fork.bundle-validation-mismatch");
    }
    const bound = planStore.bindResult(operationId, envelope.bundleId);
    if (bound.resultBundleId !== envelope.bundleId) {
      throw new Error("workspace-fork.result-binding-mismatch");
    }
    return {
      bundleRoot: destinationRoot,
      manifest,
      checkpoint: fork.checkpoint,
      processNonce: frozen.processNonce,
      operationId,
      bundleId: envelope.bundleId,
    };
  } catch (error) {
    if (sameDirectoryIdentity(destinationRoot, destinationIdentity)) {
      rmSync(destinationRoot, { recursive: true, force: false });
    }
    throw error;
  }
}

function rescopeForkReceipt(
  entry: WorkspaceExportWhiteboardSemanticReceipt,
  destinationWorkspaceId: string,
): WorkspaceExportWhiteboardSemanticReceipt {
  const receipt = decodeSemanticSceneReceiptRecord(entry.receipt);
  return {
    ...entry,
    receipt: rescopeSemanticSceneReceipt(receipt, destinationWorkspaceId),
    draftId:
      entry.draftId === null
        ? null
        : `draft_fork_${createHash("sha256")
            .update(`${destinationWorkspaceId}\0${entry.draftId}`)
            .digest("hex")
            .slice(0, 32)}`,
  };
}

function copyVerified(sourceRoot: string, destinationRoot: string, portablePath: string): void {
  const source = resolveInside(sourceRoot, portablePath);
  const destination = resolveInside(destinationRoot, portablePath);
  const bytes = readFileSync(source);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, bytes, { flag: "wx", mode: 0o600 });
  if (!readFileSync(destination).equals(bytes)) {
    throw new Error(`workspace-fork.copy-verification-failed: ${portablePath}`);
  }
}

function resolveInside(root: string, portablePath: string): string {
  const resolvedRoot = resolve(root);
  const destination = resolve(resolvedRoot, ...portablePath.split("/"));
  if (!destination.startsWith(`${resolvedRoot}${sep}`)) {
    throw new Error(`workspace-fork.path-escape: ${portablePath}`);
  }
  return destination;
}

function directoryIdentity(path: string): Readonly<{ dev: bigint; ino: bigint }> {
  const status = lstatSync(path, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`workspace-fork.destination-invalid: ${path}`);
  }
  return { dev: status.dev, ino: status.ino };
}

function sameDirectoryIdentity(
  path: string,
  expected: Readonly<{ dev: bigint; ino: bigint }>,
): boolean {
  if (!existsSync(path)) return false;
  const actual = directoryIdentity(path);
  return actual.dev === expected.dev && actual.ino === expected.ino;
}
