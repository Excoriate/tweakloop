import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { tweakloopStateRoot } from "../daemon/runtime.js";
import {
  createWorkspaceExportOperationStore,
  deriveWorkspaceExportOperationId,
  WorkspaceExportOperationError,
  type WorkspaceExportStableResult,
} from "../workspace/export-journal.js";
import {
  publishWorkspaceBundle,
  validateWorkspaceBundleEnvelope,
  type WorkspaceBundleCaptureResult,
  type WorkspaceBundlePublishResult,
} from "../workspace/files.js";

export type WorkspaceBundleExportOperationResult = Readonly<{
  published: WorkspaceBundlePublishResult;
  receipt: WorkspaceExportStableResult;
  alreadyExported: boolean;
}>;

export async function exportWorkspaceBundleOperation(
  input: Readonly<{
    destination: string;
    sourceWorkspaceId: string;
    sourceCheckpoint: number;
    filesPolicyHash: string;
    operationId?: string;
    storeDir?: string;
    ownershipNonce?: string;
    capture: (bundleRoot: string) => Promise<WorkspaceBundleCaptureResult>;
  }>,
): Promise<WorkspaceBundleExportOperationResult> {
  const destination = resolve(input.destination);
  const operationId =
    input.operationId ??
    deriveWorkspaceExportOperationId({
      sourceWorkspaceId: input.sourceWorkspaceId,
      destination,
      filesPolicyHash: input.filesPolicyHash,
    });
  const store = createWorkspaceExportOperationStore(
    input.storeDir ?? resolve(tweakloopStateRoot(), "export-operations"),
  );
  try {
    const operation = store.begin({
      operationId,
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceCheckpoint: input.sourceCheckpoint,
      destination,
      filesPolicyHash: input.filesPolicyHash,
    });
    if (operation.status === "completed") {
      const validated = validateWorkspaceBundleEnvelope(destination);
      if (
        validated.envelope.bundleId !== operation.result.bundleId ||
        validated.envelope.collaboration.manifestHash !==
          operation.result.collaborationManifestHash ||
        (validated.envelope.workspaceFiles?.manifestHash ?? null) !==
          operation.result.workspaceFilesManifestHash
      ) {
        throw new WorkspaceExportOperationError(
          "workspace-export.committed-bundle-conflict",
          "committed export destination no longer matches the stable operation result",
        );
      }
      return {
        published: { destination, envelope: validated.envelope },
        receipt: operation.result,
        alreadyExported: true,
      };
    }
    if (existsSync(destination)) {
      throw new WorkspaceExportOperationError(
        "workspace-export.destination-exists-without-stable-result",
        "export destination exists without a stable result for this operation",
      );
    }
    try {
      const published = await publishWorkspaceBundle({
        destination,
        operationId,
        ownershipNonce: input.ownershipNonce ?? randomBytes(24).toString("hex"),
        capture: input.capture,
      });
      const receipt = store.complete(operation.intent, {
        bundleId: published.envelope.bundleId,
        collaborationManifestHash: published.envelope.collaboration.manifestHash,
        workspaceFilesManifestHash: published.envelope.workspaceFiles?.manifestHash ?? null,
      });
      return { published, receipt, alreadyExported: false };
    } catch (error) {
      if (!existsSync(destination)) store.abandon(operation.intent);
      throw error;
    }
  } finally {
    store.close();
  }
}
