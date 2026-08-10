import { randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { validateWorkspaceBundleEnvelope } from "./files.js";
import { loadWorkspaceRestoreBundle } from "./restore.js";
import {
  createWorkspaceRestoreJournalStore,
  type WorkspaceRestoreInventoryEntry,
  type WorkspaceRestoreJournal,
  WorkspaceRestoreJournalError,
  type WorkspaceRestoreOperationKind,
} from "./restore-journal.js";
import { validatePublishedWorkspaceRestoreState } from "./restore-prepare.js";

export type WorkspaceRestoreInventory = Readonly<{
  protocol: "tweakloop.workspace-restore-inventory/v1";
  capacity: Readonly<{
    quotaBytes: number;
    usedBytes: number;
    reservedBytes: number;
    active: number;
    completed: number;
    recovery: number;
    tombstones: number;
    retainedBundleBytes: number;
  }>;
  operations: readonly WorkspaceRestoreInventoryEntry[];
}>;

export function createWorkspaceRestoreRetentionService(
  coordinationRoot: string,
  evidenceRoot: string,
  options: Readonly<{
    assertRuntimeAbsent?: (journal: WorkspaceRestoreJournal) => void;
  }> = {},
) {
  const root = resolve(coordinationRoot);
  const evidence = resolve(evidenceRoot);

  function inventory(): WorkspaceRestoreInventory {
    const store = createWorkspaceRestoreJournalStore(root);
    try {
      return {
        protocol: "tweakloop.workspace-restore-inventory/v1",
        capacity: { ...store.inventory(), retainedBundleBytes: directoryBytes(evidence) },
        operations: store.inventoryEntries(),
      };
    } finally {
      store.close();
    }
  }

  function compact(
    input: Readonly<{
      operationKind: WorkspaceRestoreOperationKind;
      operationId: string;
      bundleRoot?: string;
    }>,
  ) {
    const store = createWorkspaceRestoreJournalStore(root);
    try {
      const journal = store.find(input.operationKind, input.operationId);
      const retainedBundle = workspaceRestoreEvidenceBundlePath(evidence, journal.bundleId);
      const bundleRoot = input.bundleRoot ? resolve(input.bundleRoot) : retainedBundle;
      const completed = loadWorkspaceRestoreBundle(bundleRoot);
      if (completed.plan.bundleId !== journal.bundleId) {
        throw new WorkspaceRestoreJournalError(
          "workspace-restore.compaction-bundle-conflict",
          "compaction bundle does not match the immutable operation",
          409,
          { expectedBundleId: journal.bundleId, actualBundleId: completed.plan.bundleId },
        );
      }
      const guards = {
        ...(options.assertRuntimeAbsent
          ? { assertRuntimeAbsent: options.assertRuntimeAbsent }
          : {}),
        validateState: (persisted: typeof journal) => {
          if (!existsSync(persisted.paths.finalState)) return;
          validatePublishedWorkspaceRestoreState({ journal: persisted, completed });
        },
      };
      const proof = store.createCompactionProof(journal, guards);
      const tombstone = store.compact(proof, guards);
      const bundleStillReferenced = store
        .inventoryEntries()
        .some((entry) => entry.status !== "compacted" && entry.bundleId === journal.bundleId);
      if (!bundleStillReferenced && existsSync(retainedBundle)) {
        rmSync(retainedBundle, { recursive: true });
      }
      return {
        protocol: "tweakloop.workspace-restore-compaction/v1" as const,
        operationKind: input.operationKind,
        operationId: input.operationId,
        proof,
        tombstone,
        capacity: { ...store.inventory(), retainedBundleBytes: directoryBytes(evidence) },
      };
    } finally {
      store.close();
    }
  }

  return { inventory, compact } as const;
}

export function retainWorkspaceRestoreBundle(
  evidenceRoot: string,
  sourceBundleRoot: string,
  bundleId: string,
): string {
  const validated = validateWorkspaceBundleEnvelope(sourceBundleRoot);
  if (validated.envelope.bundleId !== bundleId) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.evidence-bundle-conflict",
      "retained restore evidence does not match the journal bundle",
    );
  }
  const destination = workspaceRestoreEvidenceBundlePath(evidenceRoot, bundleId);
  if (existsSync(destination)) {
    const retained = validateWorkspaceBundleEnvelope(destination);
    if (retained.envelope.bundleId !== bundleId) {
      throw new WorkspaceRestoreJournalError(
        "workspace-restore.evidence-bundle-corrupt",
        "retained restore evidence has another bundle identity",
      );
    }
    return destination;
  }
  mkdirSync(dirname(destination), { recursive: true });
  const stage = join(
    dirname(destination),
    `.${basename(destination)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`,
  );
  try {
    copyRegularTree(resolve(sourceBundleRoot), stage);
    const copied = validateWorkspaceBundleEnvelope(stage);
    if (copied.envelope.bundleId !== bundleId) {
      throw new WorkspaceRestoreJournalError(
        "workspace-restore.evidence-bundle-conflict",
        "copied restore evidence changed bundle identity",
      );
    }
    fsyncRegularTree(stage);
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (!existsSync(destination)) throw error;
      const winner = validateWorkspaceBundleEnvelope(destination);
      if (winner.envelope.bundleId !== bundleId) throw error;
      rmSync(stage, { recursive: true });
    }
    fsyncDirectory(dirname(destination));
    return destination;
  } catch (error) {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
    throw error;
  }
}

function workspaceRestoreEvidenceBundlePath(evidenceRoot: string, bundleId: string): string {
  if (!/^bundle_[a-f0-9]{64}$/.test(bundleId)) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.bundle-id-invalid",
      "restore evidence bundle id is invalid",
    );
  }
  return join(resolve(evidenceRoot), "bundles", bundleId);
}

function copyRegularTree(source: string, destination: string): void {
  const status = lstatSync(source);
  if (status.isSymbolicLink()) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.evidence-symlink-rejected",
      "restore evidence cannot retain symbolic links",
    );
  }
  if (status.isDirectory()) {
    mkdirSync(destination, { mode: status.mode & 0o777 });
    for (const name of readdirSync(source).sort()) {
      copyRegularTree(join(source, name), join(destination, name));
    }
    return;
  }
  if (!status.isFile()) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.evidence-file-type-rejected",
      "restore evidence contains a non-regular file",
    );
  }
  copyFileSync(source, destination);
}

function fsyncRegularTree(path: string): void {
  const status = lstatSync(path);
  if (status.isDirectory()) {
    for (const name of readdirSync(path).sort()) fsyncRegularTree(join(path, name));
    fsyncDirectory(path);
    return;
  }
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function directoryBytes(path: string): number {
  if (!existsSync(path)) return 0;
  const status = statSync(path);
  if (!status.isDirectory()) return status.size;
  return readdirSync(path).reduce((sum, name) => sum + directoryBytes(join(path, name)), 0);
}
