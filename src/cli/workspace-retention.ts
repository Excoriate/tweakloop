import { resolve } from "node:path";
import type { WorkspaceRestoreOperationKind } from "../workspace/restore-journal.js";
import type { WorkspaceRestoreInventory } from "../workspace/restore-retention.js";
import type { DaemonConnection } from "./daemon-client.js";
import { WorkspaceRestoreClientError } from "./workspace-restore.js";

export async function getWorkspaceRestoreInventory(
  connection: DaemonConnection,
): Promise<WorkspaceRestoreInventory> {
  const response = await fetch(
    new URL("/api/v1/workspace-restores/inventory", connection.baseUrl),
    { headers: { authorization: `Bearer ${connection.token}` } },
  );
  if (!response.ok) throw await retentionError(response);
  return (await response.json()) as WorkspaceRestoreInventory;
}

export async function compactWorkspaceRestore(
  connection: DaemonConnection,
  input: Readonly<{
    operationKind: WorkspaceRestoreOperationKind;
    operationId: string;
    bundleRoot?: string;
  }>,
) {
  const response = await fetch(new URL("/api/v1/workspace-restores/compact", connection.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...input,
      ...(input.bundleRoot ? { bundleRoot: resolve(input.bundleRoot) } : {}),
    }),
  });
  if (!response.ok) throw await retentionError(response);
  return (await response.json()) as Readonly<Record<string, unknown>>;
}

async function retentionError(response: Response): Promise<WorkspaceRestoreClientError> {
  const body = (await response.json().catch(() => ({}))) as {
    code?: string;
    message?: string;
    details?: Readonly<Record<string, unknown>>;
  };
  return new WorkspaceRestoreClientError(
    body.code ?? "workspace-restore.retention-failed",
    body.message ?? response.statusText,
    response.status,
    body.details,
  );
}
