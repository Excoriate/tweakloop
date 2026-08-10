import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { restoredWorkspaceRoot, tweakloopStateRoot } from "../daemon/runtime.js";
import { WORKSPACE_EXPORT_MANIFEST_PATH } from "../protocol/workspace-export.js";
import {
  validateWorkspaceBundleEnvelope,
  type WorkspaceFilesOverlayEntry,
} from "../workspace/files.js";
import { validateWorkspaceRestoreManifest } from "../workspace/restore.js";
import {
  createWorkspaceForkPlanStore,
  deriveWorkspaceRestoreOperationId,
  type WorkspaceActivation,
  type WorkspaceRestoreStableResult,
} from "../workspace/restore-journal.js";
import type { DaemonConnection } from "./daemon-client.js";

export type WorkspaceRestoreResult = Readonly<{
  protocol: "tweakloop.workspace-restore/v1";
  url: string | null;
  workspaceId: string;
  projectId: string;
  rootPath: string;
  sessionId: string | null;
  locator: Readonly<{ url: string; sessionId: string }> | null;
  operationId: string;
  bundleId: string;
  sourceBundleId: string;
  resultBundleId: string | null;
  activation: WorkspaceActivation;
  operationSessionId: string;
  alreadyRestored: boolean;
  overlay: readonly WorkspaceFilesOverlayEntry[];
  receipt: WorkspaceRestoreStableResult;
}>;

export async function restoreWorkspaceExport(
  connection: DaemonConnection,
  directory: string,
  agentId: string,
  options: Readonly<{ destinationRoot?: string; sessionId?: string }> = {},
): Promise<WorkspaceRestoreResult> {
  const root = resolve(directory);
  const validated = validateWorkspaceBundleEnvelope(root);
  const manifestBytes = readFileSync(resolve(root, WORKSPACE_EXPORT_MANIFEST_PATH));
  const plan = validateWorkspaceRestoreManifest(validated.collaborationManifest, {
    bundleId: validated.envelope.bundleId,
    collaborationManifestHash: validated.envelope.collaboration.manifestHash,
  });
  const forkPlan = createWorkspaceForkPlanStore(
    resolve(tweakloopStateRoot(), "fork-plans"),
  ).findByResultBundleId(plan.bundleId);
  const destinationRoot = resolve(
    options.destinationRoot ?? forkPlan?.destinationRoot ?? restoredWorkspaceRoot(plan.bundleId),
  );
  const operationKind = forkPlan ? "fork" : "restore";
  const operationId =
    forkPlan?.operationId ??
    deriveWorkspaceRestoreOperationId({
      operationKind,
      bundleId: plan.bundleId,
      destinationRoot,
    });
  const sessionId = options.sessionId ?? forkPlan?.destinationSessionId;
  const begin = await fetch(new URL("/api/v1/workspace-restores", connection.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.workspace-restore-request/v2",
      bundleId: plan.bundleId,
      collaborationManifestHash: plan.manifestHash,
      collaborationManifestBase64: manifestBytes.toString("base64"),
    }),
  });
  if (!begin.ok) throw await restoreResponseError(begin);
  const staged = (await begin.json()) as {
    bundleId: string;
    restoreId: string;
    manifestHash: string;
    requiredPaths: string[];
  };
  if (
    staged.bundleId !== plan.bundleId ||
    staged.restoreId !== plan.restoreId ||
    staged.manifestHash !== plan.manifestHash
  ) {
    throw new Error("daemon restore identity differs from the locally validated manifest");
  }
  if (JSON.stringify(staged.requiredPaths) !== JSON.stringify(plan.requiredPaths)) {
    throw new Error("daemon requested files outside the locally validated restore inventory");
  }
  for (const portablePath of staged.requiredPaths) {
    const bytes = readFileSync(resolve(root, ...portablePath.split("/")));
    const upload = await fetch(
      new URL(
        `/api/v1/workspace-restores/${encodeURIComponent(staged.bundleId)}/files?path=${encodeURIComponent(portablePath)}`,
        connection.baseUrl,
      ),
      {
        method: "PUT",
        headers: { authorization: `Bearer ${connection.token}` },
        body: bytes,
      },
    );
    if (!upload.ok) throw await restoreResponseError(upload);
  }
  const commit = await fetch(
    new URL(
      `/api/v1/workspace-restores/${encodeURIComponent(staged.bundleId)}/commit`,
      connection.baseUrl,
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        bundleRoot: root,
        destinationRoot,
        ...(sessionId ? { sessionId } : {}),
        operationKind,
        operationId,
      }),
    },
  );
  if (!commit.ok) throw await restoreResponseError(commit);
  const result = (await commit.json()) as WorkspaceRestoreResult;
  if (
    result.bundleId !== plan.bundleId ||
    result.operationId !== operationId ||
    result.receipt?.requestFingerprint === undefined
  ) {
    throw new Error("daemon restore result does not match the bound operation identity");
  }
  return result;
}

export class WorkspaceRestoreClientError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: string,
    message: string,
    status: number,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceRestoreClientError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function restoreResponseError(response: Response): Promise<WorkspaceRestoreClientError> {
  const data = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    details?: Readonly<Record<string, unknown>>;
  };
  return new WorkspaceRestoreClientError(
    data.code ?? "workspace-restore.failed",
    data.message ?? response.statusText,
    response.status,
    data.details,
  );
}
