import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import { createTransactor } from "../daemon/transactor.js";
import { objectPath } from "../storage/object-store/index.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { readEvents } from "../storage/sqlite/event-store.js";
import { type SemanticReceiptSnapshot, SemanticSceneStore } from "../whiteboard/semantic-store.js";
import {
  planWorkspaceFilesOverlay,
  stageWorkspaceFilesOverlay,
  validateWorkspaceBundleEnvelope,
  type WorkspaceBundleValidationResult,
  type WorkspaceFilesOverlayEntry,
} from "./files.js";
import {
  type CompletedWorkspaceRestore,
  type InstalledWorkspaceRestore,
  installWorkspaceRestore,
  projectWorkspaceRestore,
} from "./restore.js";
import {
  claimRestoreOwnedDirectory,
  hashWorkspaceOverlay,
  hashWorkspaceRestoreInventory,
  hashWorkspaceRestoreReceipt,
  publishedRestoreOwnedPath,
  readWorkspaceRestoreCompletionMarker,
  readWorkspaceRestoreStateReceipt,
  validateRestoreOwnedPath,
  validateWorkspaceRestoreCompletionMarker,
  type WorkspaceRestoreJournal,
  WorkspaceRestoreJournalError,
  type WorkspaceRootGenerationReceipt,
  type WorkspaceRootMaterialReceipt,
  type WorkspaceStateGenerationReceipt,
  workspaceRestoreCompletionMarker,
  writeWorkspaceRestoreCompletionMarker,
  writeWorkspaceRestoreStateReceipt,
} from "./restore-journal.js";

export type WorkspaceRestorePreparationFailurePoint =
  | "after-root-install"
  | "after-overlay-stage"
  | "after-history-commit"
  | "after-semantic-receipts"
  | "after-db-checkpoint"
  | "after-state-receipt"
  | "after-root-marker";

export type WorkspaceRestoreMaterialStage = Readonly<{
  validatedBundle: WorkspaceBundleValidationResult;
  rootOwnership: ReturnType<typeof claimRestoreOwnedDirectory>;
  stateOwnership: ReturnType<typeof claimRestoreOwnedDirectory>;
  overlay: readonly WorkspaceFilesOverlayEntry[];
  rootMaterial: WorkspaceRootMaterialReceipt;
}>;

export type WorkspaceRestoreStateStage = Readonly<{
  stateGeneration: WorkspaceStateGenerationReceipt;
}>;

export type WorkspaceRestoreGenerationStage = Readonly<{
  rootGeneration: WorkspaceRootGenerationReceipt;
}>;

export function validateStagedWorkspaceRestoreBundle(
  bundleRoot: string,
  completed: CompletedWorkspaceRestore,
): WorkspaceBundleValidationResult {
  const resolvedBundleRoot = resolve(bundleRoot);
  let validated: WorkspaceBundleValidationResult;
  try {
    validated = validateWorkspaceBundleEnvelope(resolvedBundleRoot);
  } catch {
    generationError(
      "workspace-restore.bundle-binding-mismatch",
      "bundle envelope or an exact bound component changed after staging",
    );
  }
  const boundManifestBytes = readFileSync(
    join(resolvedBundleRoot, validated.envelope.collaboration.manifestPath),
  );
  if (
    validated.envelope.bundleId !== completed.plan.bundleId ||
    validated.envelope.collaboration.manifestHash !== completed.plan.manifestHash ||
    !boundManifestBytes.equals(completed.plan.collaborationManifestBytes)
  ) {
    generationError(
      "workspace-restore.bundle-binding-mismatch",
      "bundle envelope and staged collaboration authority differ",
    );
  }
  return validated;
}

export function stageWorkspaceRestoreMaterial(
  input: Readonly<{
    journal: WorkspaceRestoreJournal;
    completed: CompletedWorkspaceRestore;
    bundleRoot: string;
    failureInjection?: (point: WorkspaceRestorePreparationFailurePoint) => void;
  }>,
): WorkspaceRestoreMaterialStage {
  const validatedBundle = validateBundleBinding(input.bundleRoot, input.journal, input.completed);
  const rootOwnership = claimRestoreOwnedDirectory(input.journal, "root");
  const stateOwnership = claimRestoreOwnedDirectory(input.journal, "state");
  const overlayPlan = planWorkspaceFilesOverlay(validatedBundle);
  const acceptedExistingArtifactHashes = new Map(
    overlayPlan.entries.flatMap((entry) =>
      entry.baseHash !== null && entry.workingHash !== null
        ? [[entry.path, entry.workingHash] as const]
        : [],
    ),
  );
  const installed = installWorkspaceRestore(
    input.completed,
    input.journal.paths.stagedRoot,
    join(input.journal.paths.stagedState, "objects"),
    input.journal.destinationWorkspaceId,
    input.journal.destinationRoot,
    { acceptedExistingArtifactHashes },
  );
  input.failureInjection?.("after-root-install");
  const overlay = stageWorkspaceFilesOverlay({
    snapshotRoot:
      validatedBundle.workspaceFilesManifest === null
        ? null
        : join(resolve(input.bundleRoot), "workspace-files"),
    stagedRoot: input.journal.paths.stagedRoot,
    plan: overlayPlan,
    operationId: input.journal.operationId,
    ownershipNonce: input.journal.ownershipNonce,
  });
  input.failureInjection?.("after-overlay-stage");
  const objectInventoryHash = verifiedObjectInventory(
    join(input.journal.paths.stagedState, "objects"),
    input.completed,
  );
  const rootMaterial: WorkspaceRootMaterialReceipt = {
    protocol: "tweakloop.workspace-root-material/v1",
    journalId: input.journal.journalId,
    operationId: input.journal.operationId,
    bundleId: input.journal.bundleId,
    rootOwnership,
    overlayDigest: hashWorkspaceOverlay(overlay.entries),
    overlayCount: overlay.entries.length,
    rootInventoryHash: verifiedRootInventory(
      input.journal.paths.stagedRoot,
      input.completed,
      overlay.entries,
    ),
    objectInventoryHash,
  };
  fsyncTree(input.journal.paths.stagedRoot);
  fsyncTree(input.journal.paths.stagedState);
  void installed;
  return {
    validatedBundle,
    rootOwnership,
    stateOwnership,
    overlay: overlay.entries,
    rootMaterial,
  };
}

export function stageWorkspaceRestoreState(
  input: Readonly<{
    journal: WorkspaceRestoreJournal;
    completed: CompletedWorkspaceRestore;
    failureInjection?: (point: WorkspaceRestorePreparationFailurePoint) => void;
  }>,
): WorkspaceRestoreStateStage {
  const rootMaterial = requiredRootMaterial(input.journal);
  const stateOwnership = requiredStateOwnership(input.journal);
  const objectsDir = join(input.journal.paths.stagedState, "objects");
  const installed: InstalledWorkspaceRestore = {
    rootPath: resolve(input.journal.destinationRoot),
    objectsDir: resolve(objectsDir),
    ...projectWorkspaceRestore(
      input.completed,
      input.journal.destinationRoot,
      input.journal.destinationWorkspaceId,
    ),
  };
  const databasePath = join(input.journal.paths.stagedState, "events.sqlite");
  const db = openDatabase(databasePath);
  try {
    db.pragma("synchronous = FULL");
    reconcileHistory(db, installed, input.completed, input.journal);
    input.failureInjection?.("after-history-commit");
    reconcileSemanticReceipts(db, installed, input.journal.destinationWorkspaceId);
    input.failureInjection?.("after-semantic-receipts");
    const stateFacts = stateFactsFor(db, input.journal, input.completed, installed);
    db.pragma("wal_checkpoint(TRUNCATE)");
    input.failureInjection?.("after-db-checkpoint");
    const stateGeneration: WorkspaceStateGenerationReceipt = {
      protocol: "tweakloop.workspace-restore-state/v2",
      journalId: input.journal.journalId,
      operationId: input.journal.operationId,
      bundleId: input.journal.bundleId,
      requestFingerprint: input.journal.requestFingerprint,
      collaborationManifestHash: input.journal.collaborationManifestHash,
      workspaceId: input.journal.destinationWorkspaceId,
      sqliteSchemaVersion: stateFacts.schemaVersion,
      sqliteMigrationVersion: stateFacts.migrationVersion,
      sqliteSchemaDigest: stateFacts.schemaDigest,
      capturedSeq: input.completed.plan.manifest.capturedSeq,
      eventTipId: stateFacts.eventTipId,
      eventPrefixDigest: stateFacts.eventPrefixDigest,
      semanticReceiptCount: stateFacts.semanticReceiptCount,
      semanticReceiptDigest: stateFacts.semanticReceiptDigest,
      idempotencyReceiptCount: stateFacts.idempotencyReceiptCount,
      idempotencyReceiptDigest: stateFacts.idempotencyReceiptDigest,
      objectInventoryHash: verifiedObjectInventory(objectsDir, input.completed),
      overlayDigest: rootMaterial.overlayDigest,
      rootMaterialHash: hashWorkspaceRestoreReceipt(rootMaterial),
      stateOwnership,
    };
    db.close();
    writeWorkspaceRestoreStateReceipt(input.journal.paths.stagedState, stateGeneration);
    fsyncTree(input.journal.paths.stagedState);
    input.failureInjection?.("after-state-receipt");
    return { stateGeneration };
  } catch (error) {
    if (db.open) db.close();
    throw error;
  }
}

export function finalizeWorkspaceRestoreGeneration(
  input: Readonly<{
    journal: WorkspaceRestoreJournal;
    failureInjection?: (point: WorkspaceRestorePreparationFailurePoint) => void;
  }>,
): WorkspaceRestoreGenerationStage {
  const rootMaterial = requiredRootMaterial(input.journal);
  const stateGeneration = requiredStateGeneration(input.journal);
  const rootOwnership = requiredRootOwnership(input.journal);
  const stateOwnership = requiredStateOwnership(input.journal);
  const rootGeneration: WorkspaceRootGenerationReceipt = {
    protocol: "tweakloop.workspace-root-generation/v1",
    journalId: input.journal.journalId,
    operationId: input.journal.operationId,
    bundleId: input.journal.bundleId,
    destinationClaimKey: input.journal.destinationClaimKey,
    rootMaterialHash: hashWorkspaceRestoreReceipt(rootMaterial),
    stateGenerationHash: hashWorkspaceRestoreReceipt(stateGeneration),
    rootOwnership,
    stateOwnership,
  };
  const finalized = { ...input.journal, rootGeneration };
  writeWorkspaceRestoreCompletionMarker(
    input.journal.paths.stagedRoot,
    workspaceRestoreCompletionMarker(finalized),
  );
  fsyncTree(input.journal.paths.stagedRoot);
  input.failureInjection?.("after-root-marker");
  return { rootGeneration };
}

export function validatePublishedWorkspaceRestore(
  input: Readonly<{
    journal: WorkspaceRestoreJournal;
    completed: CompletedWorkspaceRestore;
  }>,
): void {
  const rootMaterial = requiredRootMaterial(input.journal);
  requiredRootGeneration(input.journal);
  validateRestoreOwnedPath(
    input.journal.destinationRoot,
    input.journal,
    "root",
    input.journal.destinationRoot,
    publishedRestoreOwnedPath(requiredRootOwnership(input.journal), input.journal.destinationRoot),
  );
  validateWorkspaceRestoreCompletionMarker(
    readWorkspaceRestoreCompletionMarker(input.journal.destinationRoot),
    input.journal,
  );
  const rootInventoryHash = verifiedRootInventory(
    input.journal.destinationRoot,
    input.completed,
    input.journal.overlay,
  );
  if (rootInventoryHash !== rootMaterial.rootInventoryHash) {
    generationError("workspace-restore.root-generation-mismatch", "root bytes or modes changed");
  }
  validatePublishedWorkspaceRestoreState(input);
}

export function validatePublishedWorkspaceRestoreState(
  input: Readonly<{
    journal: WorkspaceRestoreJournal;
    completed: CompletedWorkspaceRestore;
  }>,
): void {
  const stateGeneration = requiredStateGeneration(input.journal);
  validateRestoreOwnedPath(
    input.journal.paths.finalState,
    input.journal,
    "state",
    input.journal.paths.finalState,
    publishedRestoreOwnedPath(
      requiredStateOwnership(input.journal),
      input.journal.paths.finalState,
    ),
  );
  const storedState = readWorkspaceRestoreStateReceipt(input.journal.paths.finalState);
  if (canonicalJson(storedState) !== canonicalJson(stateGeneration)) {
    generationError("workspace-restore.state-generation-mismatch", "state receipt changed");
  }
  const objectsDir = join(input.journal.paths.finalState, "objects");
  if (
    verifiedObjectInventory(objectsDir, input.completed) !== stateGeneration.objectInventoryHash
  ) {
    generationError("workspace-restore.object-generation-mismatch", "CAS bytes changed");
  }
  const databasePath = join(input.journal.paths.finalState, "events.sqlite");
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const installed = expectedInstalledState(input.completed, input.journal);
    const facts = stateFactsFor(db, input.journal, input.completed, installed);
    if (
      facts.schemaVersion !== stateGeneration.sqliteSchemaVersion ||
      facts.migrationVersion !== stateGeneration.sqliteMigrationVersion ||
      facts.schemaDigest !== stateGeneration.sqliteSchemaDigest ||
      facts.eventPrefixDigest !== stateGeneration.eventPrefixDigest ||
      facts.eventTipId !== stateGeneration.eventTipId ||
      facts.semanticReceiptCount !== stateGeneration.semanticReceiptCount ||
      facts.semanticReceiptDigest !== stateGeneration.semanticReceiptDigest ||
      facts.idempotencyReceiptCount !== stateGeneration.idempotencyReceiptCount ||
      facts.idempotencyReceiptDigest !== stateGeneration.idempotencyReceiptDigest
    ) {
      generationError(
        "workspace-restore.database-generation-mismatch",
        "SQLite prefix, schema, or durable receipt facts changed",
      );
    }
  } finally {
    db.close();
  }
}

function validateBundleBinding(
  bundleRoot: string,
  journal: WorkspaceRestoreJournal,
  completed: CompletedWorkspaceRestore,
): WorkspaceBundleValidationResult {
  const resolvedBundleRoot = resolve(bundleRoot);
  const validated = validateStagedWorkspaceRestoreBundle(resolvedBundleRoot, completed);
  if (
    validated.envelope.bundleId !== journal.bundleId ||
    validated.envelope.collaboration.manifestHash !== journal.collaborationManifestHash ||
    validated.envelope.bundleId !== completed.plan.bundleId
  ) {
    generationError(
      "workspace-restore.bundle-binding-mismatch",
      "bundle envelope, staged collaboration, and journal authority differ",
    );
  }
  return validated;
}

function reconcileHistory(
  db: Database.Database,
  installed: InstalledWorkspaceRestore,
  completed: CompletedWorkspaceRestore,
  journal: WorkspaceRestoreJournal,
): void {
  const count = db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number };
  if (count.count === 0) {
    const createdAt = completed.plan.manifest.events[0]?.recordedAt ?? "1970-01-01T00:00:00.000Z";
    createTransactor({
      db,
      workspaceId: journal.destinationWorkspaceId,
      daemonStartNonce: journal.processNonce,
      newEventId: () => "restore-preparation-does-not-mint-events",
      now: () => createdAt,
      onCommitted: () => {},
    }).restoreHistory({
      events: installed.events,
      blobs: completed.plan.objects.map((object) => ({
        hash: object.hash,
        byteLength: object.byteLength,
        mediaType: object.mediaType,
        createdAt,
      })),
    });
    return;
  }
  if (count.count !== installed.events.length) {
    generationError(
      "workspace-restore.database-partial",
      "restored event store contains a partial or foreign event prefix",
    );
  }
  const actual = readEvents(db, journal.destinationWorkspaceId, 0, installed.events.length + 1);
  if (hashWorkspaceRestoreReceipt(actual) !== hashWorkspaceRestoreReceipt(installed.events)) {
    generationError(
      "workspace-restore.database-prefix-conflict",
      "restored event store does not match the rebound source history",
    );
  }
}

function reconcileSemanticReceipts(
  db: Database.Database,
  installed: InstalledWorkspaceRestore,
  workspaceId: string,
): void {
  const store = new SemanticSceneStore(db, { objectsDir: "", workspaceId });
  const current = store.listReceiptSnapshots();
  if (current.length === 0 && installed.semanticReceiptSnapshots.length > 0) {
    store.restoreReceiptSnapshots(installed.semanticReceiptSnapshots);
    return;
  }
  if (
    hashWorkspaceRestoreReceipt(sortedSemanticReceipts(current)) !==
    hashWorkspaceRestoreReceipt(sortedSemanticReceipts(installed.semanticReceiptSnapshots))
  ) {
    generationError(
      "workspace-restore.semantic-receipt-conflict",
      "semantic receipt store contains partial or foreign state",
    );
  }
}

function expectedInstalledState(
  completed: CompletedWorkspaceRestore,
  journal: WorkspaceRestoreJournal,
): InstalledWorkspaceRestore {
  const projected = projectWorkspaceRestore(
    completed,
    journal.destinationRoot,
    journal.destinationWorkspaceId,
  );
  return {
    rootPath: journal.destinationRoot,
    objectsDir: join(journal.paths.finalState, "objects"),
    ...projected,
  };
}

function stateFactsFor(
  db: Database.Database,
  journal: WorkspaceRestoreJournal,
  completed: CompletedWorkspaceRestore,
  installed: InstalledWorkspaceRestore,
) {
  const schemaVersion = db.pragma("user_version", { simple: true }) as number;
  const migrationVersion = schemaVersion;
  const schema = db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_master
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    )
    .all();
  const events = readEvents(
    db,
    journal.destinationWorkspaceId,
    0,
    completed.plan.manifest.capturedSeq + 1,
  ).filter((event) => event.seq <= completed.plan.manifest.capturedSeq);
  if (events.length !== completed.plan.manifest.capturedSeq) {
    generationError(
      "workspace-restore.database-prefix-incomplete",
      "database no longer contains the complete captured event prefix",
    );
  }
  if (hashWorkspaceRestoreReceipt(events) !== hashWorkspaceRestoreReceipt(installed.events)) {
    generationError(
      "workspace-restore.database-prefix-conflict",
      "database captured prefix differs from the restored event history",
    );
  }
  const semantic = expectedSemanticRows(db, installed.semanticReceiptSnapshots);
  const idempotency = db
    .prepare(
      `SELECT r.workspace_id, r.idempotency_key, r.command_id, r.first_event_seq,
              r.last_event_seq, r.response_json, r.recorded_at, h.request_hash
       FROM command_receipts AS r
       LEFT JOIN command_request_hashes AS h
         ON h.workspace_id = r.workspace_id AND h.idempotency_key = r.idempotency_key
       WHERE r.workspace_id = ? AND r.last_event_seq IS NOT NULL AND r.last_event_seq <= ?
       ORDER BY r.idempotency_key`,
    )
    .all(journal.destinationWorkspaceId, completed.plan.manifest.capturedSeq);
  return {
    schemaVersion,
    migrationVersion,
    schemaDigest: hashWorkspaceRestoreReceipt(schema),
    eventTipId: events.at(-1)?.eventId ?? null,
    eventPrefixDigest: hashWorkspaceRestoreReceipt(events),
    semanticReceiptCount: semantic.length,
    semanticReceiptDigest: hashWorkspaceRestoreReceipt(semantic),
    idempotencyReceiptCount: idempotency.length,
    idempotencyReceiptDigest: hashWorkspaceRestoreReceipt(idempotency),
  } as const;
}

function expectedSemanticRows(
  db: Database.Database,
  expected: readonly SemanticReceiptSnapshot[],
): unknown[] {
  const rows: unknown[] = [];
  for (const snapshot of sortedSemanticReceipts(expected)) {
    const receipt = snapshot.receipt;
    const row = db
      .prepare(
        `SELECT workspace_id, artifact_id, idempotency_key, request_hash,
                normalization_version, receipt_json, draft_id, recorded_at
         FROM whiteboard_semantic_receipts
         WHERE workspace_id = ? AND artifact_id = ? AND idempotency_key = ?`,
      )
      .get(receipt.workspaceId, receipt.artifactId, receipt.idempotencyKey);
    if (!row) {
      generationError(
        "workspace-restore.semantic-receipt-missing",
        `semantic receipt disappeared: ${receipt.artifactId}/${receipt.idempotencyKey}`,
      );
    }
    rows.push(row);
  }
  return rows;
}

function sortedSemanticReceipts(entries: readonly SemanticReceiptSnapshot[]) {
  return [...entries].sort((left, right) => {
    const leftKey = `${left.receipt.artifactId}\0${left.receipt.idempotencyKey}`;
    const rightKey = `${right.receipt.artifactId}\0${right.receipt.idempotencyKey}`;
    return leftKey.localeCompare(rightKey);
  });
}

function verifiedObjectInventory(objectsDir: string, completed: CompletedWorkspaceRestore): string {
  const entries = completed.plan.objects.map((descriptor) => {
    const path = objectPath(objectsDir, descriptor.hash);
    const bytes = readRegularFile(path);
    const actualHash = sha256(bytes);
    if (actualHash !== descriptor.hash || bytes.byteLength !== descriptor.byteLength) {
      generationError(
        "workspace-restore.object-generation-mismatch",
        `CAS object differs from the bound inventory: ${descriptor.hash}`,
      );
    }
    return {
      hash: actualHash,
      byteLength: bytes.byteLength,
      objectPath: descriptor.objectPath,
    };
  });
  return hashWorkspaceRestoreInventory(entries);
}

function verifiedRootInventory(
  rootPath: string,
  completed: CompletedWorkspaceRestore,
  overlay: readonly WorkspaceFilesOverlayEntry[],
): string {
  const paths = new Set<string>([
    ".tweakloop/project.json",
    ...completed.plan.manifest.artifacts.map((artifact) => artifact.exportedPath),
    ...overlay.map((entry) => entry.path),
  ]);
  const entries = [...paths].sort().map((portablePath) => {
    const path = resolvePortable(rootPath, portablePath);
    const bytes = readRegularFile(path);
    const status = lstatSync(path);
    return {
      path: portablePath,
      hash: sha256(bytes),
      byteLength: bytes.byteLength,
      mode: status.mode & 0o777,
    };
  });
  return hashWorkspaceRestoreReceipt(entries);
}

function requiredRootMaterial(journal: WorkspaceRestoreJournal): WorkspaceRootMaterialReceipt {
  if (!journal.rootMaterial)
    generationError("workspace-restore.root-material-missing", "root material is missing");
  return journal.rootMaterial;
}

function requiredStateGeneration(
  journal: WorkspaceRestoreJournal,
): WorkspaceStateGenerationReceipt {
  if (!journal.stateGeneration)
    generationError("workspace-restore.state-generation-missing", "state generation is missing");
  return journal.stateGeneration;
}

function requiredRootGeneration(journal: WorkspaceRestoreJournal): WorkspaceRootGenerationReceipt {
  if (!journal.rootGeneration)
    generationError("workspace-restore.root-generation-missing", "root generation is missing");
  return journal.rootGeneration;
}

function requiredRootOwnership(journal: WorkspaceRestoreJournal) {
  if (!journal.ownership.root)
    generationError("workspace-restore.root-ownership-missing", "root ownership is missing");
  return journal.ownership.root;
}

function requiredStateOwnership(journal: WorkspaceRestoreJournal) {
  if (!journal.ownership.state)
    generationError("workspace-restore.state-ownership-missing", "state ownership is missing");
  return journal.ownership.state;
}

function resolvePortable(rootPath: string, portablePath: string): string {
  const root = resolve(rootPath);
  const path = resolve(root, ...portablePath.split("/"));
  if (!path.startsWith(`${root}${sep}`)) {
    generationError("workspace-restore.path-escape", `path escapes restore root: ${portablePath}`);
  }
  return path;
}

function readRegularFile(path: string): Buffer {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    generationError(
      "workspace-restore.file-invalid",
      `restore material is not a regular file: ${path}`,
    );
  }
  return readFileSync(path);
}

function fsyncTree(rootPath: string): void {
  const status = lstatSync(rootPath);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    generationError(
      "workspace-restore.stage-invalid",
      `restore stage is not a real directory: ${rootPath}`,
    );
  }
  for (const name of readdirSync(rootPath).sort()) {
    const path = join(rootPath, name);
    const child = lstatSync(path);
    if (child.isSymbolicLink()) {
      generationError(
        "workspace-restore.stage-symlink",
        `restore stage contains a symlink: ${path}`,
      );
    }
    if (child.isDirectory()) fsyncTree(path);
    else if (child.isFile()) fsyncPath(path);
    else
      generationError(
        "workspace-restore.stage-entry-invalid",
        `restore stage contains a special file: ${path}`,
      );
  }
  fsyncPath(rootPath, true);
}

function fsyncPath(path: string, directory = false): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!directory || !unsupportedDirectoryFsync(error)) throw error;
  } finally {
    closeSync(fd);
  }
}

function unsupportedDirectoryFsync(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EINVAL" || error.code === "ENOTSUP" || error.code === "EBADF")
  );
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function generationError(code: string, message: string): never {
  throw new WorkspaceRestoreJournalError(code, message, 409);
}
