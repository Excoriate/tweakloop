import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import Database from "better-sqlite3";
import type { WorkspaceFilesOverlayEntry } from "./files.js";

export const WORKSPACE_RESTORE_JOURNAL_PROTOCOL = "tweakloop.workspace-restore-journal/v2";
export const WORKSPACE_RESTORE_OWNER_PROTOCOL = "tweakloop.workspace-restore-owner/v2";
export const WORKSPACE_RESTORE_MARKER_PROTOCOL = "tweakloop.workspace-restore-completion/v2";
export const WORKSPACE_RESTORE_STATE_PROTOCOL = "tweakloop.workspace-restore-state/v2";
export const WORKSPACE_FORK_PLAN_PROTOCOL = "tweakloop.workspace-fork-plan/v2";
export const WORKSPACE_RESTORE_MARKER_PATH = ".tweakloop/restore-complete.json";

const BUNDLE_ID = /^bundle_[a-f0-9]{64}$/;
const RESTORE_ID = /^restore_[a-f0-9]{24}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DEFAULT_COORDINATION_QUOTA = 256 * 1024 * 1024;
const DEFAULT_ACTIVE_LIMIT = 10_000;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const DEFAULT_EFFECT_RESERVATION = MAX_RECORD_BYTES * 2 + 64 * 1024;
const ACCOUNTING_OVERHEAD = 256;
const PROCESS_BOOT_NONCE = randomBytes(16).toString("hex");
const PROCESS_STARTED_AT = new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString();

type WorkspaceRestoreCoordinatorOwner = Readonly<{
  pid: number;
  bootNonce: string;
  processStartedAt: string;
}>;

export type WorkspaceRestoreOperationKind = "restore" | "fork";

export type WorkspaceRestoreTransition =
  | "operation-registered"
  | "destination-claim-intent"
  | "destination-claimed"
  | "destination-conflict"
  | "root-material-intent"
  | "root-material-staged"
  | "state-stage-intent"
  | "state-staged"
  | "root-generation-finalize-intent"
  | "root-generation-finalized"
  | "state-commit-intent"
  | "state-committed"
  | "root-commit-intent"
  | "root-committed"
  | "runtime-attempt-intent"
  | "runtime-attempt-pending"
  | "runtime-attempt-stuck"
  | "runtime-attempt-failed"
  | "runtime-ready"
  | "session-start-intent"
  | "session-ready"
  | "result-commit-intent"
  | "result-committed"
  | "recovery-required";

export type WorkspaceRestoreCleanupEligibility = "private-only" | "disabled";

export type WorkspaceRestoreDestinationIntent = Readonly<{
  protocol: "tweakloop.destination-intent/v1";
  logicalPath: string;
  components: readonly string[];
  normalization: "NFC";
  casePolicy: "sensitive" | "insensitive";
  canonicalizationVersion: 1;
}>;

export type WorkspaceRestoreDestinationResolution = Readonly<{
  protocol: "tweakloop.destination-resolution/v1";
  ancestorPath: string;
  ancestorDev: string;
  ancestorIno: string;
  missingComponents: readonly string[];
  claimGeneration: string;
  canonicalizationVersion: 1;
}>;

export type WorkspaceRestoreOwnedPath = Readonly<{
  path: string;
  parentPath: string;
  parentDev: string;
  parentIno: string;
  dev: string;
  ino: string;
}>;

export type WorkspaceRootMaterialReceipt = Readonly<{
  protocol: "tweakloop.workspace-root-material/v1";
  journalId: string;
  operationId: string;
  bundleId: string;
  rootOwnership: WorkspaceRestoreOwnedPath;
  overlayDigest: string;
  overlayCount: number;
  rootInventoryHash: string;
  objectInventoryHash: string;
}>;

export type WorkspaceStateGenerationReceipt = Readonly<{
  protocol: typeof WORKSPACE_RESTORE_STATE_PROTOCOL;
  journalId: string;
  operationId: string;
  bundleId: string;
  requestFingerprint: string;
  collaborationManifestHash: string;
  workspaceId: string;
  sqliteSchemaVersion: number;
  sqliteMigrationVersion: number;
  sqliteSchemaDigest: string;
  capturedSeq: number;
  eventTipId: string | null;
  eventPrefixDigest: string;
  semanticReceiptCount: number;
  semanticReceiptDigest: string;
  idempotencyReceiptCount: number;
  idempotencyReceiptDigest: string;
  objectInventoryHash: string;
  overlayDigest: string;
  rootMaterialHash: string;
  stateOwnership: WorkspaceRestoreOwnedPath;
}>;

export type WorkspaceRootGenerationReceipt = Readonly<{
  protocol: "tweakloop.workspace-root-generation/v1";
  journalId: string;
  operationId: string;
  bundleId: string;
  destinationClaimKey: string;
  rootMaterialHash: string;
  stateGenerationHash: string;
  rootOwnership: WorkspaceRestoreOwnedPath;
  stateOwnership: WorkspaceRestoreOwnedPath;
}>;

export type WorkspaceRuntimeAttempt = Readonly<{
  attempt: number;
  nonce: string;
  ownerPid: number;
  ownerBootNonce: string;
  ownerProcessStartedAt: string;
  deadline: string;
  descriptorPath: string;
  status: "intent" | "pending" | "stuck" | "failed" | "ready";
}>;

export type WorkspaceActivation =
  | "attach"
  | "restart-runtime-only"
  | "replay-session-command"
  | "session-ended"
  | "handed-off"
  | "successor-active"
  | "recovery";

export type WorkspaceActivationResolution = Readonly<{
  activation: WorkspaceActivation;
  locatorSessionId: string | null;
}>;

export type WorkspaceRestoreStableResult = Readonly<{
  protocol: "tweakloop.workspace-restore-result/v1" | "tweakloop.workspace-fork-result/v1";
  receiptId: string;
  requestFingerprint: string;
  operationKind: WorkspaceRestoreOperationKind;
  operationId: string;
  sourceBundleId: string;
  resultBundleId: string | null;
  workspaceId: string;
  projectId: string;
  rootPath: string;
  sessionId: string;
  overlayDigest: string;
  rootGenerationHash: string;
  stateGenerationHash: string;
  recordedAt: string;
}>;

export type WorkspaceRestoreJournal = Readonly<{
  protocol: typeof WORKSPACE_RESTORE_JOURNAL_PROTOCOL;
  journalId: string;
  revision: number;
  revisionHash: string;
  previousRevisionHash: string | null;
  transition: WorkspaceRestoreTransition;
  operationKind: WorkspaceRestoreOperationKind;
  operationId: string;
  requestFingerprint: string;
  bundleId: string;
  sourceBundleId: string;
  resultBundleId: string | null;
  restoreId: string;
  collaborationManifestHash: string;
  sourceSessionId: string | null;
  agentId: string;
  destinationIntent: WorkspaceRestoreDestinationIntent;
  destinationResolution: WorkspaceRestoreDestinationResolution;
  destinationClaimKey: string;
  destinationRoot: string;
  destinationWorkspaceId: string;
  projectId: string;
  sessionId: string;
  processNonce: string;
  receiptId: string;
  ownershipNonce: string;
  runtimeLineageId: string;
  runtimeAttempt: WorkspaceRuntimeAttempt | null;
  cleanupEligibility: WorkspaceRestoreCleanupEligibility;
  paths: Readonly<{
    stagedRoot: string;
    stagedState: string;
    finalState: string;
  }>;
  ownership: Readonly<{
    root: WorkspaceRestoreOwnedPath | null;
    state: WorkspaceRestoreOwnedPath | null;
  }>;
  overlay: readonly WorkspaceFilesOverlayEntry[];
  rootMaterial: WorkspaceRootMaterialReceipt | null;
  stateGeneration: WorkspaceStateGenerationReceipt | null;
  rootGeneration: WorkspaceRootGenerationReceipt | null;
  stableResult: WorkspaceRestoreStableResult | null;
  activation: WorkspaceActivation | null;
  recovery: Readonly<{ code: string; message: string }> | null;
  createdAt: string;
  updatedAt: string;
}>;

export type WorkspaceRestoreOwnerReceipt = Readonly<{
  protocol: typeof WORKSPACE_RESTORE_OWNER_PROTOCOL;
  journalId: string;
  bundleId: string;
  operationId: string;
  requestFingerprint: string;
  ownershipNonce: string;
  role: "root" | "state";
  finalPath: string;
  destinationClaimKey: string;
}>;

export type WorkspaceRestoreCompletionMarker = Readonly<{
  protocol: typeof WORKSPACE_RESTORE_MARKER_PROTOCOL;
  journalId: string;
  operationId: string;
  requestFingerprint: string;
  sourceBundleId: string;
  restoreId: string;
  destinationRoot: string;
  destinationClaimKey: string;
  workspaceId: string;
  collaborationManifestHash: string;
  rootGenerationHash: string;
  stateGenerationHash: string;
  receiptId: string;
}>;

export type WorkspaceForkPlan = Readonly<{
  protocol: typeof WORKSPACE_FORK_PLAN_PROTOCOL;
  operationId: string;
  sourceBundleId: string;
  resultBundleId: string | null;
  sourceSessionId: string;
  destinationIntent: WorkspaceRestoreDestinationIntent;
  destinationRoot: string;
  destinationWorkspaceId: string;
  destinationSessionId: string;
  processNonce: string;
  forkCommandId: string;
  forkCorrelationId: string;
  recordedAt: string;
}>;

export type WorkspaceRestoreCompactionProof = Readonly<{
  protocol: "tweakloop.workspace-restore-compaction-proof/v1";
  operationKind: WorkspaceRestoreOperationKind;
  operationId: string;
  journalId: string;
  requestFingerprint: string;
  expectedRevision: number;
  expectedRevisionHash: string;
  receiptChainDigest: string;
  destinationObservation: Readonly<{
    status: "absent";
    path: string;
    checkedAt: string;
  }>;
  runtimeObservation: Readonly<{
    status: "absent";
    runtimeLineageId: string;
    lastAttemptNonce: string | null;
    descriptorPath: string | null;
    checkedAt: string;
  }>;
  stateObservation: Readonly<{
    status: "absent" | "validated";
    stateGenerationHash: string;
    objectInventoryHash: string;
    checkedAt: string;
  }>;
  resultDigest: string;
}>;

export type WorkspaceRestoreTombstone = Readonly<{
  protocol: "tweakloop.workspace-restore-tombstone/v1";
  kind: WorkspaceRestoreOperationKind;
  id: string;
  fingerprint: string;
  resultDigest: string;
  protocolVersion: 1;
  canonicalizationVersion: 1;
  fingerprintAlgorithm: "sha256";
  resultDigestAlgorithm: "sha256";
}>;

export type WorkspaceRestoreInventoryEntry = Readonly<{
  operationKind: WorkspaceRestoreOperationKind;
  operationId: string;
  journalId: string;
  status: "active" | "completed" | "recovery" | "conflict" | "compacted";
  transition: WorkspaceRestoreTransition | null;
  bundleId: string | null;
  destinationRoot: string | null;
  accountedBytes: number;
  reservedBytes: number;
  lockEpoch: number | null;
  ownerPid: number | null;
  compactionEligible: boolean;
  updatedAt: string;
}>;

export type WorkspaceRestoreCompactionGuards = Readonly<{
  assertRuntimeAbsent?: (journal: WorkspaceRestoreJournal) => void;
  validateState?: (journal: WorkspaceRestoreJournal) => void;
}>;

export class WorkspaceRestoreJournalError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceRestoreJournalError";
  }
}

export function deriveWorkspaceRestoreOperationId(
  input: Readonly<{
    operationKind: WorkspaceRestoreOperationKind;
    bundleId: string;
    destinationRoot: string;
    sourceSessionId?: string | null;
  }>,
): string {
  requireBundleId(input.bundleId);
  const intent = destinationIntent(input.destinationRoot);
  return `operation_${hashCanonical({
    domain: "tweakloop.workspace-restore/v2/operation",
    operationKind: input.operationKind,
    bundleId: input.bundleId,
    sourceSessionId: input.sourceSessionId ?? null,
    destinationIntent: intent,
  })}`;
}

export function deterministicRestoreId(operationId: string, kind: string): string {
  requireOperationId(operationId);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(kind)) {
    throw journalError("workspace-restore.kind-invalid", "deterministic identity kind is invalid");
  }
  return `${kind}_${digest(`tweakloop.workspace-restore/v2\0identity\0${operationId}\0${kind}`).slice(0, 32)}`;
}

export function createWorkspaceForkPlanStore(
  baseDir: string,
  options: Readonly<{ now?: () => string }> = {},
) {
  const root = resolve(baseDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const now = options.now ?? (() => new Date().toISOString());

  function begin(
    input: Readonly<{
      operationId: string;
      sourceBundleId: string;
      sourceSessionId: string;
      destinationRoot: string;
    }>,
  ): WorkspaceForkPlan {
    requireOperationId(input.operationId);
    requireBundleId(input.sourceBundleId);
    requireText(input.sourceSessionId, "source session id");
    const intent = destinationIntent(input.destinationRoot);
    const path = join(root, `fork_plan_${digest(input.operationId)}.json`);
    recoverInitialValue(path, parseForkPlan);
    if (existsSync(path)) {
      const existing = parseForkPlan(readJson(path));
      if (
        existing.operationId !== input.operationId ||
        existing.sourceBundleId !== input.sourceBundleId ||
        existing.sourceSessionId !== input.sourceSessionId ||
        canonicalJson(existing.destinationIntent) !== canonicalJson(intent)
      ) {
        throw journalError(
          "workspace-fork.operation-conflict",
          "fork operation identity is already bound to another request",
        );
      }
      return existing;
    }
    const plan: WorkspaceForkPlan = {
      protocol: WORKSPACE_FORK_PLAN_PROTOCOL,
      operationId: input.operationId,
      sourceBundleId: input.sourceBundleId,
      resultBundleId: null,
      sourceSessionId: input.sourceSessionId,
      destinationIntent: intent,
      destinationRoot: intent.logicalPath,
      destinationWorkspaceId: deterministicRestoreId(input.operationId, "workspace_fork"),
      destinationSessionId: deterministicRestoreId(input.operationId, "session_fork"),
      processNonce: deterministicRestoreId(input.operationId, "process_fork"),
      forkCommandId: deterministicRestoreId(input.operationId, "command_fork"),
      forkCorrelationId: deterministicRestoreId(input.operationId, "correlation_fork"),
      recordedAt: now(),
    };
    writeInitialValue(path, plan);
    return plan;
  }

  function bindResult(operationId: string, resultBundleId: string): WorkspaceForkPlan {
    requireOperationId(operationId);
    requireBundleId(resultBundleId);
    const path = join(root, `fork_plan_${digest(operationId)}.json`);
    if (!existsSync(path)) {
      throw journalError("workspace-fork.plan-missing", "fork plan does not exist", 404);
    }
    const current = parseForkPlan(readJson(path));
    if (current.resultBundleId !== null && current.resultBundleId !== resultBundleId) {
      throw journalError(
        "workspace-fork.result-conflict",
        "fork operation is already bound to another result bundle",
      );
    }
    if (current.resultBundleId === resultBundleId) return current;
    const next = { ...current, resultBundleId };
    writeReplacementValue(path, next);
    return next;
  }

  function findByResultBundleId(resultBundleId: string): WorkspaceForkPlan | null {
    requireBundleId(resultBundleId);
    const matches = readdirSync(root)
      .filter((name) => /^fork_plan_[a-f0-9]{64}\.json$/.test(name))
      .map((name) => parseForkPlan(readJson(join(root, name))))
      .filter((plan) => plan.resultBundleId === resultBundleId);
    if (matches.length > 1) {
      throw journalError(
        "workspace-fork.result-ambiguous",
        "multiple fork operations claim the same result bundle",
      );
    }
    return matches[0] ?? null;
  }

  return { begin, bindResult, findByResultBundleId } as const;
}

export function createWorkspaceRestoreJournalStore(
  baseDir: string,
  options: Readonly<{
    now?: () => string;
    newNonce?: () => string;
    quotaBytes?: number;
    activeLimit?: number;
    coordinatorOwner?: WorkspaceRestoreCoordinatorOwner;
    isProcessAlive?: (pid: number) => boolean;
  }> = {},
) {
  const root = resolve(baseDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const now = options.now ?? (() => new Date().toISOString());
  const newNonce = options.newNonce ?? (() => randomBytes(24).toString("hex"));
  const quotaBytes = options.quotaBytes ?? DEFAULT_COORDINATION_QUOTA;
  const activeLimit = options.activeLimit ?? DEFAULT_ACTIVE_LIMIT;
  const coordinatorOwner = options.coordinatorOwner ?? {
    pid: process.pid,
    bootNonce: PROCESS_BOOT_NONCE,
    processStartedAt: PROCESS_STARTED_AT,
  };
  const isProcessAlive = options.isProcessAlive ?? pidAlive;
  validateCoordinatorOwner(coordinatorOwner);
  const db = openCoordination(join(root, "restore-coordination.sqlite"), quotaBytes, activeLimit);

  function begin(
    input: Readonly<{
      operationKind: WorkspaceRestoreOperationKind;
      operationId: string;
      bundleId: string;
      sourceBundleId?: string;
      resultBundleId?: string | null;
      restoreId: string;
      collaborationManifestHash: string;
      sourceSessionId?: string | null;
      agentId: string;
      destinationRoot: string;
      destinationWorkspaceId: string;
      projectId: string;
      finalState: string;
      sessionId?: string;
      processNonce?: string;
    }>,
  ): WorkspaceRestoreJournal {
    requireOperationKind(input.operationKind);
    requireOperationId(input.operationId);
    requireBundleId(input.bundleId);
    const sourceBundleId = input.sourceBundleId ?? input.bundleId;
    const resultBundleId = input.resultBundleId ?? null;
    requireBundleId(sourceBundleId);
    if (resultBundleId !== null) requireBundleId(resultBundleId);
    if (
      (input.operationKind === "restore" &&
        (sourceBundleId !== input.bundleId || resultBundleId !== null)) ||
      (input.operationKind === "fork" && resultBundleId !== input.bundleId)
    ) {
      throw journalError(
        "workspace-restore.bundle-role-invalid",
        "source, result, and material bundle roles do not match the operation kind",
      );
    }
    requireRestoreId(input.restoreId);
    requireHash(input.collaborationManifestHash, "collaboration manifest hash");
    requireText(input.agentId, "agent id");
    requireText(input.destinationWorkspaceId, "destination workspace id");
    requireText(input.projectId, "project id");
    const intent = destinationIntent(input.destinationRoot);
    const sourceSessionId = input.sourceSessionId ?? null;
    if (sourceSessionId !== null) requireText(sourceSessionId, "source session id");
    const sessionId =
      input.sessionId ?? deterministicRestoreId(input.operationId, "session_restore");
    const finalState = resolve(input.finalState);
    const requestFingerprint = hashCanonical({
      protocol: "tweakloop.workspace-restore-request-fingerprint/v1",
      operationKind: input.operationKind,
      sourceBundleId,
      resultBundleId,
      materialBundleId: input.bundleId,
      sourceSessionId,
      agentId: input.agentId,
      destinationIntent: intent,
      destinationWorkspaceId: input.destinationWorkspaceId,
      projectId: input.projectId,
      finalState,
      sessionId,
      policyVersion: 1,
    });

    const existing = getOperation(db, input.operationKind, input.operationId);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        throw journalError(
          "workspace-restore.operation-conflict",
          "operation id is already bound to another restore request",
        );
      }
      if (existing.status === "compacted") {
        const tombstone = parseTombstoneJson(existing.tombstone_json);
        throw journalError(
          "workspace-restore.operation-compacted",
          "restore operation was explicitly released and retains only its immutable identity",
          410,
          { tombstone },
        );
      }
      const journal = loadJournal(db, existing.journal_id);
      validateExistingDestination(journal);
      if (journal.transition === "destination-conflict") {
        throw journalError(
          "workspace-restore.destination-claim-conflict",
          "destination is already owned by another operation",
          409,
          { journalId: journal.journalId },
        );
      }
      return journal;
    }

    const resolution = destinationResolution(intent);
    const destinationClaimKey = hashCanonical({
      domain: "tweakloop.destination-claim/v1",
      ancestorDev: resolution.ancestorDev,
      ancestorIno: resolution.ancestorIno,
      missingComponents: resolution.missingComponents,
      canonicalizationVersion: resolution.canonicalizationVersion,
    });
    const journalId = `restore_journal_${digest(
      `tweakloop.workspace-restore-journal/v2\0${input.operationKind}\0${input.operationId}`,
    ).slice(0, 48)}`;
    const ownershipNonce = newNonce();
    if (!/^[a-f0-9]{32,128}$/.test(ownershipNonce)) {
      throw journalError(
        "workspace-restore.ownership-nonce-invalid",
        "restore ownership nonce must be lowercase hexadecimal",
      );
    }
    const createdAt = now();
    const stateAncestor = existingAncestorPath(finalState);
    const journalBase = {
      protocol: WORKSPACE_RESTORE_JOURNAL_PROTOCOL as typeof WORKSPACE_RESTORE_JOURNAL_PROTOCOL,
      journalId,
      revision: 0,
      revisionHash: "",
      previousRevisionHash: null,
      transition: "operation-registered" as const,
      operationKind: input.operationKind,
      operationId: input.operationId,
      requestFingerprint,
      bundleId: input.bundleId,
      sourceBundleId,
      resultBundleId,
      restoreId: input.restoreId,
      collaborationManifestHash: input.collaborationManifestHash,
      sourceSessionId,
      agentId: input.agentId,
      destinationIntent: intent,
      destinationResolution: resolution,
      destinationClaimKey,
      destinationRoot: intent.logicalPath,
      destinationWorkspaceId: input.destinationWorkspaceId,
      projectId: input.projectId,
      sessionId,
      processNonce:
        input.processNonce ?? deterministicRestoreId(input.operationId, "process_restore"),
      receiptId: deterministicRestoreId(input.operationId, "receipt_restore"),
      ownershipNonce,
      runtimeLineageId: deterministicRestoreId(input.operationId, "runtime_lineage"),
      runtimeAttempt: null,
      cleanupEligibility: "private-only" as const,
      paths: {
        stagedRoot: join(
          resolution.ancestorPath,
          `.tweakloop-restore-${journalId}-${ownershipNonce}.root`,
        ),
        stagedState: join(stateAncestor, `.tweakloop-restore-${journalId}-${ownershipNonce}.state`),
        finalState,
      },
      ownership: { root: null, state: null },
      overlay: [] as readonly WorkspaceFilesOverlayEntry[],
      rootMaterial: null,
      stateGeneration: null,
      rootGeneration: null,
      stableResult: null,
      activation: null,
      recovery: null,
      createdAt,
      updatedAt: createdAt,
    };
    const created = createOperation(db, journalBase, resolution.missingComponents.length === 0);
    if (created.transition === "destination-conflict") {
      throw journalError(
        "workspace-restore.destination-claim-conflict",
        "destination already exists or is claimed by another operation",
        409,
        { journalId: created.journalId },
      );
    }
    return created;
  }

  function load(journalId: string): WorkspaceRestoreJournal {
    requireJournalId(journalId);
    return loadJournal(db, journalId);
  }

  function intent(
    current: WorkspaceRestoreJournal,
    transition: WorkspaceRestoreTransition,
    patch: JournalPatch = {},
    reservationBytes = DEFAULT_EFFECT_RESERVATION,
  ): WorkspaceRestoreJournal {
    if (!transition.endsWith("-intent")) {
      throw journalError("workspace-restore.transition-invalid", "intent transition is invalid");
    }
    if (!Number.isSafeInteger(reservationBytes) || reservationBytes <= 0) {
      throw journalError("workspace-restore.reservation-invalid", "reservation must be positive");
    }
    return electAndAppend(
      db,
      current,
      transition,
      patch,
      reservationBytes,
      now(),
      coordinatorOwner,
      isProcessAlive,
    );
  }

  function effect(
    current: WorkspaceRestoreJournal,
    transition: WorkspaceRestoreTransition,
    patch: JournalPatch = {},
  ): WorkspaceRestoreJournal {
    if (transition.endsWith("-intent")) {
      throw journalError("workspace-restore.transition-invalid", "effect transition is invalid");
    }
    return completeAndAppend(db, current, transition, patch, now(), coordinatorOwner);
  }

  function observe(
    current: WorkspaceRestoreJournal,
    transition: WorkspaceRestoreTransition,
    patch: JournalPatch = {},
  ): WorkspaceRestoreJournal {
    return appendObservation(db, current, transition, patch, now());
  }

  function inventory(): Readonly<{
    quotaBytes: number;
    usedBytes: number;
    reservedBytes: number;
    active: number;
    completed: number;
    recovery: number;
    tombstones: number;
  }> {
    return coordinationInventory(db);
  }

  function inventoryEntries(): readonly WorkspaceRestoreInventoryEntry[] {
    return coordinationInventoryEntries(db);
  }

  function find(
    operationKind: WorkspaceRestoreOperationKind,
    operationId: string,
  ): WorkspaceRestoreJournal {
    requireOperationId(operationId);
    const operation = getOperation(db, operationKind, operationId);
    if (!operation) {
      throw journalError(
        "workspace-restore.operation-missing",
        "restore operation is missing",
        404,
      );
    }
    if (operation.status === "compacted") {
      throw journalError(
        "workspace-restore.operation-compacted",
        "restore operation retains only its immutable tombstone",
        410,
        { tombstone: parseTombstoneJson(operation.tombstone_json) },
      );
    }
    return loadJournal(db, operation.journal_id);
  }

  function resume(current: WorkspaceRestoreJournal): WorkspaceRestoreJournal {
    return resumeEffect(db, current, coordinatorOwner, isProcessAlive);
  }

  function createCompactionProof(
    current: WorkspaceRestoreJournal,
    guards: WorkspaceRestoreCompactionGuards = {},
  ): WorkspaceRestoreCompactionProof {
    const persisted = loadJournal(db, current.journalId);
    if (
      persisted.revision !== current.revision ||
      persisted.revisionHash !== current.revisionHash
    ) {
      throw journalError(
        "workspace-restore.journal-stale",
        "restore journal changed before compaction proof",
      );
    }
    if (persisted.transition !== "result-committed" || !persisted.stableResult) {
      throw journalError(
        "workspace-restore.compaction-premature",
        "only a committed stable result can be compacted",
      );
    }
    if (existsSync(persisted.destinationRoot)) {
      throw journalError(
        "workspace-restore.compaction-destination-present",
        "restore destination must be absent before explicit evidence release",
      );
    }
    const descriptorPath = persisted.runtimeAttempt?.descriptorPath ?? null;
    if (descriptorPath !== null && existsSync(descriptorPath)) {
      throw journalError(
        "workspace-restore.compaction-runtime-present",
        "matching runtime descriptor must be absent before explicit evidence release",
      );
    }
    guards.assertRuntimeAbsent?.(persisted);
    const stateGeneration = persisted.stateGeneration;
    if (!stateGeneration) {
      throw journalError(
        "workspace-restore.compaction-proof-invalid",
        "state generation receipt is unavailable",
      );
    }
    const checkedAt = now();
    const statePresent = existsSync(persisted.paths.finalState);
    if (statePresent) {
      guards.validateState?.(persisted);
      const stored = readWorkspaceRestoreStateReceipt(persisted.paths.finalState);
      if (canonicalJson(stored) !== canonicalJson(stateGeneration)) {
        throw journalError(
          "workspace-restore.compaction-state-invalid",
          "remaining state generation receipt does not match the immutable journal",
        );
      }
    }
    return {
      protocol: "tweakloop.workspace-restore-compaction-proof/v1",
      operationKind: persisted.operationKind,
      operationId: persisted.operationId,
      journalId: persisted.journalId,
      requestFingerprint: persisted.requestFingerprint,
      expectedRevision: persisted.revision,
      expectedRevisionHash: persisted.revisionHash,
      receiptChainDigest: receiptChainDigest(db, persisted.journalId),
      destinationObservation: {
        status: "absent",
        path: persisted.destinationRoot,
        checkedAt,
      },
      runtimeObservation: {
        status: "absent",
        runtimeLineageId: persisted.runtimeLineageId,
        lastAttemptNonce: persisted.runtimeAttempt?.nonce ?? null,
        descriptorPath,
        checkedAt,
      },
      stateObservation: {
        status: statePresent ? "validated" : "absent",
        stateGenerationHash: hashCanonical(stateGeneration),
        objectInventoryHash: stateGeneration.objectInventoryHash,
        checkedAt,
      },
      resultDigest: hashCanonical(persisted.stableResult),
    };
  }

  function compact(
    proof: WorkspaceRestoreCompactionProof,
    guards: WorkspaceRestoreCompactionGuards = {},
  ): WorkspaceRestoreTombstone {
    return compactEvidence(db, parseCompactionProof(proof), guards);
  }

  function close(): void {
    db.close();
  }

  return {
    begin,
    load,
    intent,
    effect,
    observe,
    resume,
    find,
    createCompactionProof,
    compact,
    inventory,
    inventoryEntries,
    close,
  } as const;
}

type JournalPatch = Readonly<{
  ownership?: Partial<WorkspaceRestoreJournal["ownership"]>;
  overlay?: readonly WorkspaceFilesOverlayEntry[];
  rootMaterial?: WorkspaceRootMaterialReceipt | null;
  stateGeneration?: WorkspaceStateGenerationReceipt | null;
  rootGeneration?: WorkspaceRootGenerationReceipt | null;
  runtimeAttempt?: WorkspaceRuntimeAttempt | null;
  stableResult?: WorkspaceRestoreStableResult | null;
  activation?: WorkspaceActivation | null;
  recovery?: Readonly<{ code: string; message: string }> | null;
}>;

export function claimRestoreOwnedDirectory(
  journal: WorkspaceRestoreJournal,
  role: "root" | "state",
): WorkspaceRestoreOwnedPath {
  const path = role === "root" ? journal.paths.stagedRoot : journal.paths.stagedState;
  const finalPath = role === "root" ? journal.destinationRoot : journal.paths.finalState;
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: false, mode: 0o700 });
    writeDurableJson(ownerReceiptPath(path, role), ownerReceipt(journal, role, finalPath));
    fsyncDirectory(path);
  }
  return validateRestoreOwnedPath(path, journal, role, finalPath);
}

export function validateRestoreOwnedPath(
  path: string,
  journal: WorkspaceRestoreJournal,
  role: "root" | "state",
  finalPath: string,
  expected?: WorkspaceRestoreOwnedPath | null,
): WorkspaceRestoreOwnedPath {
  const resolvedPath = resolve(path);
  const status = lstatSync(resolvedPath, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw journalError("workspace-restore.ownership-unproved", `${role} is not a real directory`);
  }
  const parentPath = realpathSync(dirname(resolvedPath));
  const parent = lstatSync(parentPath, { bigint: true });
  const receipt = parseOwnerReceipt(readJson(ownerReceiptPath(resolvedPath, role)));
  const required = ownerReceipt(journal, role, finalPath);
  if (canonicalJson(receipt) !== canonicalJson(required)) {
    throw journalError(
      "workspace-restore.ownership-conflict",
      `${role} ownership belongs to another operation`,
    );
  }
  const ownership = {
    path: resolvedPath,
    parentPath,
    parentDev: String(parent.dev),
    parentIno: String(parent.ino),
    dev: String(status.dev),
    ino: String(status.ino),
  };
  if (expected && canonicalJson(expected) !== canonicalJson(ownership)) {
    throw journalError("workspace-restore.ownership-stale", `${role} directory identity changed`);
  }
  return ownership;
}

export function publishRestoreOwnedDirectory(
  journal: WorkspaceRestoreJournal,
  role: "root" | "state",
): Readonly<{ ownership: WorkspaceRestoreOwnedPath; alreadyPublished: boolean }> {
  const stagedPath = role === "root" ? journal.paths.stagedRoot : journal.paths.stagedState;
  const finalPath = role === "root" ? journal.destinationRoot : journal.paths.finalState;
  const expected = role === "root" ? journal.ownership.root : journal.ownership.state;
  if (!expected) {
    throw journalError(
      "workspace-restore.ownership-unrecorded",
      `${role} ownership was not persisted before publication`,
    );
  }
  if (existsSync(finalPath)) {
    const ownership = validateRestoreOwnedPath(
      finalPath,
      journal,
      role,
      finalPath,
      publishedRestoreOwnedPath(expected, finalPath),
    );
    return { ownership, alreadyPublished: true };
  }
  validateRestoreOwnedPath(stagedPath, journal, role, finalPath, expected);
  mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
  if (existsSync(finalPath)) {
    throw journalError(
      role === "root"
        ? "workspace-restore.destination-conflict"
        : "workspace-restore.state-conflict",
      `${role} destination appeared before publication`,
    );
  }
  renameSync(stagedPath, finalPath);
  fsyncDirectory(dirname(finalPath));
  const ownership = validateRestoreOwnedPath(
    finalPath,
    journal,
    role,
    finalPath,
    publishedRestoreOwnedPath(expected, finalPath),
  );
  return { ownership, alreadyPublished: false };
}

/**
 * A rename preserves the owned directory inode while intentionally changing
 * its path and parent inode. This derives the only valid post-publication
 * expectation without weakening the nonce receipt or inode proof.
 */
export function publishedRestoreOwnedPath(
  ownership: WorkspaceRestoreOwnedPath,
  finalPath: string,
): WorkspaceRestoreOwnedPath {
  const path = resolve(finalPath);
  const parentPath = realpathSync(dirname(path));
  const parent = lstatSync(parentPath, { bigint: true });
  return {
    ...ownership,
    path,
    parentPath,
    parentDev: String(parent.dev),
    parentIno: String(parent.ino),
  };
}

export function writeWorkspaceRestoreStateReceipt(
  stateRoot: string,
  receipt: WorkspaceStateGenerationReceipt,
): string {
  const bytes = serializedJson(receipt);
  writeDurableBytes(join(resolve(stateRoot), "restore-state.json"), bytes);
  return digest(bytes);
}

export function readWorkspaceRestoreStateReceipt(
  stateRoot: string,
): WorkspaceStateGenerationReceipt {
  return parseStateReceipt(readJson(join(resolve(stateRoot), "restore-state.json")));
}

export function writeWorkspaceRestoreCompletionMarker(
  rootPath: string,
  marker: WorkspaceRestoreCompletionMarker,
): string {
  const bytes = serializedJson(marker);
  writeDurableBytes(join(resolve(rootPath), ...WORKSPACE_RESTORE_MARKER_PATH.split("/")), bytes);
  return digest(bytes);
}

export function readWorkspaceRestoreCompletionMarker(
  rootPath: string,
): WorkspaceRestoreCompletionMarker {
  return parseCompletionMarker(
    readJson(join(resolve(rootPath), ...WORKSPACE_RESTORE_MARKER_PATH.split("/"))),
  );
}

export function validateWorkspaceRestoreCompletionMarker(
  marker: WorkspaceRestoreCompletionMarker,
  journal: WorkspaceRestoreJournal,
): void {
  const expected = workspaceRestoreCompletionMarker(journal);
  if (canonicalJson(marker) !== canonicalJson(expected)) {
    throw journalError(
      "workspace-restore.marker-conflict",
      "completion marker does not match the requested operation generation",
    );
  }
}

export function workspaceRestoreCompletionMarker(
  journal: WorkspaceRestoreJournal,
): WorkspaceRestoreCompletionMarker {
  if (!journal.rootGeneration || !journal.stateGeneration) {
    throw journalError(
      "workspace-restore.marker-premature",
      "completion marker requires both material generations",
    );
  }
  return {
    protocol: WORKSPACE_RESTORE_MARKER_PROTOCOL,
    journalId: journal.journalId,
    operationId: journal.operationId,
    requestFingerprint: journal.requestFingerprint,
    sourceBundleId: journal.resultBundleId ?? journal.bundleId,
    restoreId: journal.restoreId,
    destinationRoot: journal.destinationRoot,
    destinationClaimKey: journal.destinationClaimKey,
    workspaceId: journal.destinationWorkspaceId,
    collaborationManifestHash: journal.collaborationManifestHash,
    rootGenerationHash: hashCanonical(journal.rootGeneration),
    stateGenerationHash: hashCanonical(journal.stateGeneration),
    receiptId: journal.receiptId,
  };
}

export function hashWorkspaceRestoreReceipt(value: unknown): string {
  return hashCanonical(value);
}

export function hashWorkspaceRestoreInventory(
  entries: readonly Readonly<{ hash: string; byteLength: number; objectPath: string }>[],
): string {
  return hashCanonical(
    [...entries]
      .map((entry) => ({
        hash: entry.hash,
        byteLength: entry.byteLength,
        objectPath: entry.objectPath,
      }))
      .sort((left, right) => left.objectPath.localeCompare(right.objectPath)),
  );
}

export function hashWorkspaceOverlay(entries: readonly WorkspaceFilesOverlayEntry[]): string {
  return hashCanonical([...entries].sort((left, right) => left.path.localeCompare(right.path)));
}

function openCoordination(
  path: string,
  quotaBytes: number,
  activeLimit: number,
): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS restore_meta (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      protocol_version INTEGER NOT NULL,
      quota_bytes INTEGER NOT NULL,
      active_limit INTEGER NOT NULL,
      used_bytes INTEGER NOT NULL,
      reserved_bytes INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS restore_operations (
      operation_kind TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      journal_id TEXT NOT NULL UNIQUE,
      destination_claim_key TEXT NOT NULL,
      status TEXT NOT NULL,
      stable_result_json TEXT,
      tombstone_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (operation_kind, operation_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS restore_destination_claims (
      claim_key TEXT PRIMARY KEY,
      operation_kind TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      claim_json TEXT NOT NULL,
      claim_generation TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS restore_journal_heads (
      journal_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      revision_hash TEXT NOT NULL,
      lock_epoch INTEGER NOT NULL,
      owner_pid INTEGER,
      owner_boot_nonce TEXT,
      owner_process_started_at TEXT,
      reserved_bytes INTEGER NOT NULL,
      state_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS restore_journal_revisions (
      journal_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      previous_revision_hash TEXT,
      revision_hash TEXT NOT NULL,
      transition TEXT NOT NULL,
      state_json TEXT NOT NULL,
      accounted_bytes INTEGER NOT NULL,
      PRIMARY KEY (journal_id, revision)
    ) STRICT;
  `);
  const meta = db.prepare("SELECT protocol_version FROM restore_meta WHERE singleton = 1").get() as
    | { protocol_version: number }
    | undefined;
  if (!meta) {
    db.prepare("INSERT INTO restore_meta VALUES (1, 2, ?, ?, 0, 0)").run(quotaBytes, activeLimit);
  } else if (meta.protocol_version !== 2) {
    db.close();
    throw journalError(
      "workspace-restore.migration-required",
      "restore coordination database requires migration",
    );
  }
  return db;
}

type OperationRow = Readonly<{
  request_fingerprint: string;
  journal_id: string;
  status: string;
  tombstone_json: string | null;
}>;

function getOperation(
  db: Database.Database,
  kind: WorkspaceRestoreOperationKind,
  operationId: string,
): OperationRow | undefined {
  return db
    .prepare(
      "SELECT request_fingerprint, journal_id, status, tombstone_json FROM restore_operations WHERE operation_kind = ? AND operation_id = ?",
    )
    .get(kind, operationId) as OperationRow | undefined;
}

function createOperation(
  db: Database.Database,
  base: Omit<WorkspaceRestoreJournal, "revisionHash"> & Readonly<{ revisionHash: string }>,
  targetAlreadyExists: boolean,
): WorkspaceRestoreJournal {
  const transaction = db.transaction(() => {
    const meta = coordinationMeta(db);
    const active = db
      .prepare("SELECT COUNT(*) AS count FROM restore_operations WHERE status = 'active'")
      .get() as { count: number };
    if (active.count >= meta.active_limit) capacityError();
    const claimRows = db
      .prepare("SELECT operation_kind, operation_id, claim_json FROM restore_destination_claims")
      .all() as Array<{ operation_kind: string; operation_id: string; claim_json: string }>;
    const conflictClaim = claimRows.find((claim) => {
      if (claim.operation_kind === base.operationKind && claim.operation_id === base.operationId) {
        return false;
      }
      const persisted = requireRecord(JSON.parse(claim.claim_json), "destination claim");
      return destinationIntentsOverlap(
        parseDestinationIntent(persisted.intent),
        base.destinationIntent,
      );
    });
    const conflict =
      targetAlreadyExists ||
      (conflictClaim !== undefined &&
        (conflictClaim.operation_kind !== base.operationKind ||
          conflictClaim.operation_id !== base.operationId));
    let current = createRevision(base, "operation-registered", null, 1);
    const registrationBytes = accountedBytes(current);
    const permanentReserve = registrationBytes + 4096;
    assertCapacity(meta, permanentReserve);
    db.prepare(
      `INSERT INTO restore_operations
       (operation_kind, operation_id, request_fingerprint, journal_id, destination_claim_key, status, stable_result_json, tombstone_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      current.operationKind,
      current.operationId,
      current.requestFingerprint,
      current.journalId,
      current.destinationClaimKey,
      conflict ? "conflict" : "active",
      current.createdAt,
      current.updatedAt,
    );
    insertHeadAndRevision(db, current, registrationBytes);
    current = appendRevisionInTransaction(
      db,
      current,
      "destination-claim-intent",
      {},
      current.updatedAt,
    );
    if (conflict) {
      current = appendRevisionInTransaction(
        db,
        current,
        "destination-conflict",
        {
          recovery: {
            code: "workspace-restore.destination-claim-conflict",
            message: "destination already exists or belongs to another operation",
          },
        },
        current.updatedAt,
      );
      db.prepare(
        "UPDATE restore_operations SET tombstone_json = ?, updated_at = ? WHERE operation_kind = ? AND operation_id = ?",
      ).run(
        canonicalJson({
          protocol: "tweakloop.workspace-restore-tombstone/v1",
          operationKind: current.operationKind,
          operationId: current.operationId,
          fingerprint: current.requestFingerprint,
          resultDigest: null,
        }),
        current.updatedAt,
        current.operationKind,
        current.operationId,
      );
    } else {
      db.prepare(
        `INSERT INTO restore_destination_claims
         (claim_key, operation_kind, operation_id, claim_json, claim_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        current.destinationClaimKey,
        current.operationKind,
        current.operationId,
        canonicalJson({
          intent: current.destinationIntent,
          resolution: current.destinationResolution,
          requestFingerprint: current.requestFingerprint,
        }),
        current.destinationResolution.claimGeneration,
        current.createdAt,
      );
      current = appendRevisionInTransaction(
        db,
        current,
        "destination-claimed",
        {},
        current.updatedAt,
      );
    }
    return current;
  });
  return transaction.immediate();
}

function electAndAppend(
  db: Database.Database,
  expected: WorkspaceRestoreJournal,
  transition: WorkspaceRestoreTransition,
  patch: JournalPatch,
  reservationBytes: number,
  updatedAt: string,
  owner: WorkspaceRestoreCoordinatorOwner,
  isProcessAlive: (pid: number) => boolean,
): WorkspaceRestoreJournal {
  const transaction = db.transaction(() => {
    const head = headRow(db, expected.journalId);
    assertHead(head, expected);
    if (head.owner_pid !== null && !sameOwner(head, owner)) {
      if (head.owner_pid !== owner.pid && isProcessAlive(head.owner_pid)) {
        throw journalError(
          "workspace-restore.operation-in-progress",
          "another live process owns this restore transition",
        );
      }
    }
    const meta = coordinationMeta(db);
    assertCapacity(meta, reservationBytes);
    db.prepare(
      `UPDATE restore_journal_heads
       SET lock_epoch = lock_epoch + 1, owner_pid = ?, owner_boot_nonce = ?, owner_process_started_at = ?, reserved_bytes = ?
       WHERE journal_id = ? AND revision = ? AND revision_hash = ?`,
    ).run(
      owner.pid,
      owner.bootNonce,
      owner.processStartedAt,
      reservationBytes,
      expected.journalId,
      expected.revision,
      expected.revisionHash,
    );
    db.prepare(
      "UPDATE restore_meta SET reserved_bytes = reserved_bytes + ? WHERE singleton = 1",
    ).run(reservationBytes);
    return appendRevisionInTransaction(db, expected, transition, patch, updatedAt);
  });
  return transaction.immediate();
}

function completeAndAppend(
  db: Database.Database,
  expected: WorkspaceRestoreJournal,
  transition: WorkspaceRestoreTransition,
  patch: JournalPatch,
  updatedAt: string,
  owner: WorkspaceRestoreCoordinatorOwner,
): WorkspaceRestoreJournal {
  const transaction = db.transaction(() => {
    const head = headRow(db, expected.journalId);
    assertHead(head, expected);
    if (!sameOwner(head, owner)) {
      throw journalError(
        "workspace-restore.transition-owner-conflict",
        "restore transition completion is not owned by this process",
      );
    }
    const completed = appendRevisionInTransaction(db, expected, transition, patch, updatedAt);
    db.prepare(
      `UPDATE restore_journal_heads
       SET owner_pid = NULL, owner_boot_nonce = NULL, owner_process_started_at = NULL, reserved_bytes = 0
       WHERE journal_id = ?`,
    ).run(expected.journalId);
    db.prepare(
      "UPDATE restore_meta SET reserved_bytes = MAX(0, reserved_bytes - ?) WHERE singleton = 1",
    ).run(head.reserved_bytes);
    if (transition === "result-committed" && completed.stableResult) {
      db.prepare(
        `UPDATE restore_operations SET status = 'completed', stable_result_json = ?, updated_at = ?
         WHERE operation_kind = ? AND operation_id = ?`,
      ).run(
        canonicalJson(completed.stableResult),
        updatedAt,
        completed.operationKind,
        completed.operationId,
      );
    }
    return completed;
  });
  return transaction.immediate();
}

function appendObservation(
  db: Database.Database,
  expected: WorkspaceRestoreJournal,
  transition: WorkspaceRestoreTransition,
  patch: JournalPatch,
  updatedAt: string,
): WorkspaceRestoreJournal {
  const transaction = db.transaction(() => {
    const head = headRow(db, expected.journalId);
    assertHead(head, expected);
    return appendRevisionInTransaction(db, expected, transition, patch, updatedAt);
  });
  return transaction.immediate();
}

type HeadRow = Readonly<{
  revision: number;
  revision_hash: string;
  lock_epoch: number;
  owner_pid: number | null;
  owner_boot_nonce: string | null;
  owner_process_started_at: string | null;
  reserved_bytes: number;
  state_json: string;
}>;

function headRow(db: Database.Database, journalId: string): HeadRow {
  const row = db
    .prepare("SELECT * FROM restore_journal_heads WHERE journal_id = ?")
    .get(journalId) as HeadRow | undefined;
  if (!row) throw journalError("workspace-restore.journal-missing", "restore journal is missing");
  return row;
}

function assertHead(head: HeadRow, expected: WorkspaceRestoreJournal): void {
  if (head.revision !== expected.revision || head.revision_hash !== expected.revisionHash) {
    throw journalError(
      "workspace-restore.journal-stale",
      "restore journal head changed; concurrent successor won",
      409,
      { expectedRevision: expected.revision, actualRevision: head.revision },
    );
  }
}

function sameOwner(head: HeadRow, owner: WorkspaceRestoreCoordinatorOwner): boolean {
  return (
    head.owner_pid === owner.pid &&
    head.owner_boot_nonce === owner.bootNonce &&
    head.owner_process_started_at === owner.processStartedAt
  );
}

function resumeEffect(
  db: Database.Database,
  expected: WorkspaceRestoreJournal,
  owner: WorkspaceRestoreCoordinatorOwner,
  isProcessAlive: (pid: number) => boolean,
): WorkspaceRestoreJournal {
  const transaction = db.transaction(() => {
    const head = headRow(db, expected.journalId);
    assertHead(head, expected);
    if (
      !expected.transition.endsWith("-intent") &&
      expected.transition !== "runtime-attempt-pending"
    ) {
      throw journalError(
        "workspace-restore.resume-invalid",
        "only an interrupted effect intent can be adopted",
      );
    }
    if (head.reserved_bytes <= 0) {
      throw journalError(
        "workspace-restore.lock-recovery-required",
        "interrupted effect has no durable evidence reservation",
      );
    }
    if (
      head.owner_pid !== null &&
      !sameOwner(head, owner) &&
      head.owner_pid !== owner.pid &&
      isProcessAlive(head.owner_pid)
    ) {
      throw journalError(
        "workspace-restore.operation-in-progress",
        "another live process owns this restore transition",
      );
    }
    const changed = db
      .prepare(
        `UPDATE restore_journal_heads
         SET lock_epoch = lock_epoch + 1, owner_pid = ?, owner_boot_nonce = ?, owner_process_started_at = ?
         WHERE journal_id = ? AND revision = ? AND revision_hash = ? AND lock_epoch = ?`,
      )
      .run(
        owner.pid,
        owner.bootNonce,
        owner.processStartedAt,
        expected.journalId,
        expected.revision,
        expected.revisionHash,
        head.lock_epoch,
      );
    if (changed.changes !== 1) {
      throw journalError(
        "workspace-restore.journal-forked",
        "restore intent was adopted by another successor",
      );
    }
    return expected;
  });
  return transaction.immediate();
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code !== "ESRCH";
  }
}

function validateCoordinatorOwner(owner: WorkspaceRestoreCoordinatorOwner): void {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw journalError("workspace-restore.owner-invalid", "coordinator PID is invalid");
  }
  requireText(owner.bootNonce, "coordinator boot nonce");
  requireText(owner.processStartedAt, "coordinator process start");
}

function appendRevisionInTransaction(
  db: Database.Database,
  current: WorkspaceRestoreJournal,
  transition: WorkspaceRestoreTransition,
  patch: JournalPatch,
  updatedAt: string,
): WorkspaceRestoreJournal {
  assertTransition(current.transition, transition);
  const nextState = applyPatch(current, transition, patch, updatedAt);
  assertTransitionPayload(current, nextState);
  const next = createRevision(nextState, transition, current.revisionHash, current.revision + 1);
  const bytes = accountedBytes(next);
  if (bytes > MAX_RECORD_BYTES) {
    throw journalError(
      "workspace-restore.record-too-large",
      "restore journal record exceeds the canonical size limit",
      413,
    );
  }
  const meta = coordinationMeta(db);
  const head = headRow(db, current.journalId);
  if (head.reserved_bytes > 0 && bytes > head.reserved_bytes) {
    throw journalError(
      "workspace-restore.reservation-exhausted",
      "restore journal effect exceeds its reserved capacity",
    );
  }
  if (head.reserved_bytes > 0) {
    assertCapacityAfterConsuming(meta, head.reserved_bytes, bytes);
  } else {
    assertCapacity(meta, bytes);
  }
  db.prepare(
    `INSERT INTO restore_journal_revisions
     (journal_id, revision, previous_revision_hash, revision_hash, transition, state_json, accounted_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    next.journalId,
    next.revision,
    next.previousRevisionHash,
    next.revisionHash,
    next.transition,
    canonicalJson(next),
    bytes,
  );
  const changed = db
    .prepare(
      `UPDATE restore_journal_heads SET revision = ?, revision_hash = ?, state_json = ?
     WHERE journal_id = ? AND revision = ? AND revision_hash = ?`,
    )
    .run(
      next.revision,
      next.revisionHash,
      canonicalJson(next),
      next.journalId,
      current.revision,
      current.revisionHash,
    );
  if (changed.changes !== 1) {
    throw journalError(
      "workspace-restore.journal-forked",
      "restore journal predecessor already has another successor",
    );
  }
  if (transition === "recovery-required") {
    db.prepare(
      `UPDATE restore_operations SET status = 'recovery', updated_at = ?
       WHERE operation_kind = ? AND operation_id = ?`,
    ).run(updatedAt, next.operationKind, next.operationId);
  }
  db.prepare("UPDATE restore_meta SET used_bytes = used_bytes + ? WHERE singleton = 1").run(bytes);
  return next;
}

function insertHeadAndRevision(
  db: Database.Database,
  journal: WorkspaceRestoreJournal,
  bytes: number,
): void {
  db.prepare(
    `INSERT INTO restore_journal_heads
     (journal_id, revision, revision_hash, lock_epoch, owner_pid, owner_boot_nonce, owner_process_started_at, reserved_bytes, state_json)
     VALUES (?, ?, ?, 0, NULL, NULL, NULL, 0, ?)`,
  ).run(journal.journalId, journal.revision, journal.revisionHash, canonicalJson(journal));
  db.prepare(
    `INSERT INTO restore_journal_revisions
     (journal_id, revision, previous_revision_hash, revision_hash, transition, state_json, accounted_bytes)
     VALUES (?, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    journal.journalId,
    journal.revision,
    journal.revisionHash,
    journal.transition,
    canonicalJson(journal),
    bytes,
  );
  db.prepare("UPDATE restore_meta SET used_bytes = used_bytes + ? WHERE singleton = 1").run(bytes);
}

function createRevision(
  state: Omit<WorkspaceRestoreJournal, "revisionHash"> & Readonly<{ revisionHash: string }>,
  transition: WorkspaceRestoreTransition,
  previousRevisionHash: string | null,
  revision: number,
): WorkspaceRestoreJournal {
  const unhashed = {
    ...state,
    transition,
    previousRevisionHash,
    revision,
    revisionHash: "",
  };
  const revisionHash = hashCanonical({
    domain: "tweakloop.workspace-restore-journal/v2/revision",
    state: unhashed,
  });
  return { ...unhashed, revisionHash };
}

function applyPatch(
  current: WorkspaceRestoreJournal,
  transition: WorkspaceRestoreTransition,
  patch: JournalPatch,
  updatedAt: string,
): WorkspaceRestoreJournal {
  return {
    ...current,
    transition,
    cleanupEligibility:
      current.cleanupEligibility === "disabled" ||
      transition === "state-commit-intent" ||
      transition === "state-committed" ||
      transition === "root-commit-intent" ||
      transition === "root-committed"
        ? "disabled"
        : "private-only",
    ownership: {
      root: patch.ownership?.root ?? current.ownership.root,
      state: patch.ownership?.state ?? current.ownership.state,
    },
    overlay: patch.overlay ?? current.overlay,
    rootMaterial: patch.rootMaterial === undefined ? current.rootMaterial : patch.rootMaterial,
    stateGeneration:
      patch.stateGeneration === undefined ? current.stateGeneration : patch.stateGeneration,
    rootGeneration:
      patch.rootGeneration === undefined ? current.rootGeneration : patch.rootGeneration,
    runtimeAttempt:
      patch.runtimeAttempt === undefined ? current.runtimeAttempt : patch.runtimeAttempt,
    stableResult: patch.stableResult === undefined ? current.stableResult : patch.stableResult,
    activation: patch.activation === undefined ? current.activation : patch.activation,
    recovery: patch.recovery === undefined ? current.recovery : patch.recovery,
    updatedAt,
  };
}

function loadJournal(db: Database.Database, journalId: string): WorkspaceRestoreJournal {
  const head = headRow(db, journalId);
  const journal = parseJournal(JSON.parse(head.state_json));
  if (journal.revision !== head.revision || journal.revisionHash !== head.revision_hash) {
    throw journalError(
      "workspace-restore.journal-corrupt",
      "restore journal head and state disagree",
    );
  }
  const revisions = db
    .prepare(
      "SELECT revision, previous_revision_hash, revision_hash, state_json FROM restore_journal_revisions WHERE journal_id = ? ORDER BY revision",
    )
    .all(journalId) as Array<{
    revision: number;
    previous_revision_hash: string | null;
    revision_hash: string;
    state_json: string;
  }>;
  let previous: string | null = null;
  for (const row of revisions) {
    const state = parseJournal(JSON.parse(row.state_json));
    if (
      state.revision !== row.revision ||
      state.previousRevisionHash !== previous ||
      state.revisionHash !== row.revision_hash ||
      createRevision({ ...state, revisionHash: "" }, state.transition, previous, row.revision)
        .revisionHash !== row.revision_hash
    ) {
      throw journalError(
        "workspace-restore.journal-corrupt",
        "restore journal revision chain is invalid",
      );
    }
    previous = row.revision_hash;
  }
  return journal;
}

function validateExistingDestination(journal: WorkspaceRestoreJournal): void {
  if (!existsSync(journal.destinationRoot)) {
    const ancestorPath = journal.destinationResolution.ancestorPath;
    if (!existsSync(ancestorPath)) {
      throw journalError(
        "workspace-restore.destination-resolution-changed",
        "recorded destination ancestor disappeared",
      );
    }
    const ancestor = lstatSync(ancestorPath, { bigint: true });
    if (
      !ancestor.isDirectory() ||
      ancestor.isSymbolicLink() ||
      String(ancestor.dev) !== journal.destinationResolution.ancestorDev ||
      String(ancestor.ino) !== journal.destinationResolution.ancestorIno
    ) {
      throw journalError(
        "workspace-restore.destination-resolution-changed",
        "recorded destination ancestor identity changed",
      );
    }
    let cursor = ancestorPath;
    let progressed = false;
    for (const component of journal.destinationResolution.missingComponents) {
      cursor = join(cursor, component);
      if (!existsSync(cursor)) break;
      const status = lstatSync(cursor);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw journalError(
          "workspace-restore.destination-resolution-changed",
          "stored destination suffix contains a substituted non-directory",
        );
      }
      progressed = true;
    }
    if (progressed && !operationMayOwnDestinationSuffix(journal.transition)) {
      throw journalError(
        "workspace-restore.destination-resolution-changed",
        "destination suffix advanced before the operation recorded root publication intent",
      );
    }
    return;
  }
  if (journal.transition === "destination-conflict") return;
  const marker = readWorkspaceRestoreCompletionMarker(journal.destinationRoot);
  if (
    marker.journalId !== journal.journalId ||
    marker.destinationClaimKey !== journal.destinationClaimKey ||
    marker.requestFingerprint !== journal.requestFingerprint
  ) {
    throw journalError(
      "workspace-restore.destination-claim-conflict",
      "existing destination belongs to another restore operation",
    );
  }
}

function operationMayOwnDestinationSuffix(transition: WorkspaceRestoreTransition): boolean {
  return new Set<WorkspaceRestoreTransition>([
    "root-commit-intent",
    "root-committed",
    "runtime-attempt-intent",
    "runtime-attempt-pending",
    "runtime-attempt-stuck",
    "runtime-attempt-failed",
    "runtime-ready",
    "session-start-intent",
    "session-ready",
    "result-commit-intent",
    "result-committed",
    "recovery-required",
  ]).has(transition);
}

type CoordinationMeta = Readonly<{
  quota_bytes: number;
  active_limit: number;
  used_bytes: number;
  reserved_bytes: number;
}>;

function coordinationMeta(db: Database.Database): CoordinationMeta {
  return db.prepare("SELECT * FROM restore_meta WHERE singleton = 1").get() as CoordinationMeta;
}

function assertCapacity(meta: CoordinationMeta, additionalBytes: number): void {
  if (meta.used_bytes + meta.reserved_bytes + additionalBytes > meta.quota_bytes) capacityError();
}

function assertCapacityAfterConsuming(
  meta: CoordinationMeta,
  consumedReservation: number,
  additionalBytes: number,
): void {
  if (
    meta.used_bytes + Math.max(0, meta.reserved_bytes - consumedReservation) + additionalBytes >
    meta.quota_bytes
  ) {
    capacityError();
  }
}

const ALLOWED_TRANSITIONS: Readonly<
  Partial<Record<WorkspaceRestoreTransition, readonly WorkspaceRestoreTransition[]>>
> = {
  "operation-registered": ["destination-claim-intent"],
  "destination-claim-intent": ["destination-claimed", "destination-conflict"],
  "destination-claimed": ["root-material-intent", "recovery-required"],
  "root-material-intent": ["root-material-staged", "recovery-required"],
  "root-material-staged": ["state-stage-intent", "recovery-required"],
  "state-stage-intent": ["state-staged", "recovery-required"],
  "state-staged": ["root-generation-finalize-intent", "recovery-required"],
  "root-generation-finalize-intent": ["root-generation-finalized", "recovery-required"],
  "root-generation-finalized": ["state-commit-intent", "recovery-required"],
  "state-commit-intent": ["state-committed", "recovery-required"],
  "state-committed": ["root-commit-intent", "recovery-required"],
  "root-commit-intent": ["root-committed", "recovery-required"],
  "root-committed": ["runtime-attempt-intent", "recovery-required"],
  "runtime-attempt-intent": [
    "runtime-attempt-pending",
    "runtime-attempt-stuck",
    "runtime-attempt-failed",
    "runtime-ready",
    "recovery-required",
  ],
  "runtime-attempt-pending": [
    "runtime-attempt-pending",
    "runtime-attempt-stuck",
    "runtime-attempt-failed",
    "runtime-ready",
    "recovery-required",
  ],
  "runtime-attempt-stuck": ["recovery-required"],
  "runtime-attempt-failed": ["runtime-attempt-intent", "recovery-required"],
  "runtime-ready": [
    "runtime-attempt-intent",
    "session-start-intent",
    "result-commit-intent",
    "recovery-required",
  ],
  "session-start-intent": ["session-ready", "recovery-required"],
  "session-ready": ["result-commit-intent", "recovery-required"],
  "result-commit-intent": ["result-committed", "recovery-required"],
  "result-committed": ["runtime-attempt-intent", "recovery-required"],
};

function assertTransition(
  current: WorkspaceRestoreTransition,
  next: WorkspaceRestoreTransition,
): void {
  if (!ALLOWED_TRANSITIONS[current]?.includes(next)) {
    throw journalError(
      "workspace-restore.transition-invalid",
      `restore transition ${current} -> ${next} is invalid`,
    );
  }
}

function assertTransitionPayload(
  previous: WorkspaceRestoreJournal,
  current: WorkspaceRestoreJournal,
): void {
  const fail = (message: string): never => {
    throw journalError("workspace-restore.receipt-chain-invalid", message);
  };
  if (current.transition === "root-material-staged") {
    const receipt = current.rootMaterial ?? fail("root material receipt is missing");
    const rootOwnership = current.ownership.root ?? fail("root material ownership is missing");
    if (
      receipt.journalId !== current.journalId ||
      receipt.operationId !== current.operationId ||
      receipt.bundleId !== current.bundleId ||
      canonicalJson(receipt.rootOwnership) !== canonicalJson(rootOwnership) ||
      receipt.overlayDigest !== hashWorkspaceOverlay(current.overlay) ||
      receipt.overlayCount !== current.overlay.length ||
      !SHA256.test(receipt.rootInventoryHash) ||
      !SHA256.test(receipt.objectInventoryHash)
    ) {
      fail("root material receipt does not bind the staged overlay and ownership");
    }
  }
  if (current.transition === "state-staged") {
    const receipt = current.stateGeneration ?? fail("state generation receipt is missing");
    const stateOwnership = current.ownership.state ?? fail("state generation ownership is missing");
    const rootMaterial =
      current.rootMaterial ?? fail("state generation parent material is missing");
    if (
      receipt.journalId !== current.journalId ||
      receipt.operationId !== current.operationId ||
      receipt.bundleId !== current.bundleId ||
      receipt.requestFingerprint !== current.requestFingerprint ||
      receipt.collaborationManifestHash !== current.collaborationManifestHash ||
      receipt.workspaceId !== current.destinationWorkspaceId ||
      receipt.rootMaterialHash !== hashCanonical(rootMaterial) ||
      receipt.overlayDigest !== rootMaterial.overlayDigest ||
      receipt.objectInventoryHash !== rootMaterial.objectInventoryHash ||
      canonicalJson(receipt.stateOwnership) !== canonicalJson(stateOwnership)
    ) {
      fail("state generation receipt does not bind its request, parent, or ownership");
    }
  }
  if (current.transition === "root-generation-finalized") {
    const receipt = current.rootGeneration ?? fail("root generation receipt is missing");
    const rootMaterial = current.rootMaterial ?? fail("root generation parent material is missing");
    const stateGeneration =
      current.stateGeneration ?? fail("root generation state parent is missing");
    const rootOwnership =
      current.ownership.root ?? fail("root generation root ownership is missing");
    const stateOwnership =
      current.ownership.state ?? fail("root generation state ownership is missing");
    if (
      receipt.journalId !== current.journalId ||
      receipt.operationId !== current.operationId ||
      receipt.bundleId !== current.bundleId ||
      receipt.destinationClaimKey !== current.destinationClaimKey ||
      receipt.rootMaterialHash !== hashCanonical(rootMaterial) ||
      receipt.stateGenerationHash !== hashCanonical(stateGeneration) ||
      canonicalJson(receipt.rootOwnership) !== canonicalJson(rootOwnership) ||
      canonicalJson(receipt.stateOwnership) !== canonicalJson(stateOwnership)
    ) {
      fail("root generation receipt does not bind both immutable parent generations");
    }
  }
  if (
    (current.transition === "state-commit-intent" ||
      current.transition === "state-committed" ||
      current.transition === "root-commit-intent" ||
      current.transition === "root-committed") &&
    !current.rootGeneration
  ) {
    fail("publication requires a finalized root generation");
  }
  if (
    current.transition === "runtime-attempt-intent" ||
    current.transition === "runtime-attempt-pending" ||
    current.transition === "runtime-attempt-stuck" ||
    current.transition === "runtime-attempt-failed" ||
    current.transition === "runtime-ready"
  ) {
    const attempt = current.runtimeAttempt ?? fail("runtime attempt receipt is missing");
    const expectedStatus = current.transition.replace("runtime-attempt-", "");
    const requiredStatus = current.transition === "runtime-ready" ? "ready" : expectedStatus;
    if (attempt.status !== requiredStatus) fail("runtime attempt status does not match its phase");
    if (
      attempt.attempt < 1 ||
      (previous.runtimeAttempt !== null &&
        current.transition === "runtime-attempt-intent" &&
        (attempt.attempt !== previous.runtimeAttempt.attempt + 1 ||
          attempt.nonce === previous.runtimeAttempt.nonce))
    ) {
      fail("runtime attempt number or nonce is not a fresh lineage successor");
    }
  }
  if (current.transition === "session-ready" && current.activation === null) {
    fail("session readiness requires a suffix compatibility outcome");
  }
  if (current.transition === "result-committed") {
    const result = current.stableResult ?? fail("stable result is missing");
    const rootGeneration =
      current.rootGeneration ?? fail("stable result root generation is missing");
    const stateGeneration =
      current.stateGeneration ?? fail("stable result state generation is missing");
    if (
      result.receiptId !== current.receiptId ||
      result.requestFingerprint !== current.requestFingerprint ||
      result.operationKind !== current.operationKind ||
      result.operationId !== current.operationId ||
      result.sourceBundleId !== current.sourceBundleId ||
      result.resultBundleId !== current.resultBundleId ||
      result.workspaceId !== current.destinationWorkspaceId ||
      result.projectId !== current.projectId ||
      result.rootPath !== current.destinationRoot ||
      result.sessionId !== current.sessionId ||
      result.rootGenerationHash !== hashCanonical(rootGeneration) ||
      result.stateGenerationHash !== hashCanonical(stateGeneration)
    ) {
      fail("stable result does not bind the operation and committed generations");
    }
  }
  if (current.transition === "recovery-required" && current.recovery === null) {
    fail("recovery transition requires a typed recovery observation");
  }
}

function capacityError(): never {
  throw journalError(
    "workspace-restore.capacity-exceeded",
    "restore coordination evidence quota is exhausted",
    507,
  );
}

function coordinationInventory(db: Database.Database) {
  const meta = coordinationMeta(db);
  const counts = db
    .prepare(
      `SELECT
       SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN status = 'recovery' THEN 1 ELSE 0 END) AS recovery,
       SUM(CASE WHEN tombstone_json IS NOT NULL THEN 1 ELSE 0 END) AS tombstones
       FROM restore_operations`,
    )
    .get() as {
    active: number | null;
    completed: number | null;
    recovery: number | null;
    tombstones: number | null;
  };
  return {
    quotaBytes: meta.quota_bytes,
    usedBytes: meta.used_bytes,
    reservedBytes: meta.reserved_bytes,
    active: counts.active ?? 0,
    completed: counts.completed ?? 0,
    recovery: counts.recovery ?? 0,
    tombstones: counts.tombstones ?? 0,
  };
}

function coordinationInventoryEntries(
  db: Database.Database,
): readonly WorkspaceRestoreInventoryEntry[] {
  const rows = db
    .prepare(
      `SELECT o.operation_kind, o.operation_id, o.journal_id, o.status, o.updated_at,
              h.state_json, h.lock_epoch, h.owner_pid,
              COALESCE(h.reserved_bytes, 0) AS reserved_bytes,
              COALESCE(SUM(r.accounted_bytes), 0) AS accounted_bytes
       FROM restore_operations AS o
       LEFT JOIN restore_journal_heads AS h ON h.journal_id = o.journal_id
       LEFT JOIN restore_journal_revisions AS r ON r.journal_id = o.journal_id
       GROUP BY o.operation_kind, o.operation_id, o.journal_id, o.status, o.updated_at,
                h.state_json, h.lock_epoch, h.owner_pid, h.reserved_bytes
       ORDER BY o.updated_at, o.operation_kind, o.operation_id`,
    )
    .all() as Array<{
    operation_kind: WorkspaceRestoreOperationKind;
    operation_id: string;
    journal_id: string;
    status: WorkspaceRestoreInventoryEntry["status"];
    updated_at: string;
    state_json: string | null;
    lock_epoch: number | null;
    owner_pid: number | null;
    reserved_bytes: number;
    accounted_bytes: number;
  }>;
  return rows.map((row) => {
    const journal = row.state_json === null ? null : parseJournal(JSON.parse(row.state_json));
    return {
      operationKind: row.operation_kind,
      operationId: row.operation_id,
      journalId: row.journal_id,
      status: row.status,
      transition: journal?.transition ?? null,
      bundleId: journal?.bundleId ?? null,
      destinationRoot: journal?.destinationRoot ?? null,
      accountedBytes: row.accounted_bytes,
      reservedBytes: row.reserved_bytes,
      lockEpoch: row.lock_epoch,
      ownerPid: row.owner_pid,
      compactionEligible:
        row.status === "completed" && row.reserved_bytes === 0 && journal?.stableResult !== null,
      updatedAt: row.updated_at,
    };
  });
}

function receiptChainDigest(db: Database.Database, journalId: string): string {
  const rows = db
    .prepare(
      `SELECT revision, previous_revision_hash, revision_hash, transition
       FROM restore_journal_revisions WHERE journal_id = ? ORDER BY revision`,
    )
    .all(journalId) as Array<{
    revision: number;
    previous_revision_hash: string | null;
    revision_hash: string;
    transition: string;
  }>;
  if (rows.length === 0) {
    throw journalError(
      "workspace-restore.compaction-proof-invalid",
      "restore receipt chain is empty",
    );
  }
  return hashCanonical(rows);
}

function compactEvidence(
  db: Database.Database,
  proof: WorkspaceRestoreCompactionProof,
  guards: WorkspaceRestoreCompactionGuards,
): WorkspaceRestoreTombstone {
  const transaction = db.transaction(() => {
    const operation = getOperation(db, proof.operationKind, proof.operationId);
    if (operation?.status !== "completed" || operation.journal_id !== proof.journalId) {
      throw journalError(
        "workspace-restore.compaction-proof-stale",
        "restore operation is not the completed proof subject",
      );
    }
    const journal = loadJournal(db, proof.journalId);
    if (
      journal.revision !== proof.expectedRevision ||
      journal.revisionHash !== proof.expectedRevisionHash ||
      journal.requestFingerprint !== proof.requestFingerprint ||
      receiptChainDigest(db, journal.journalId) !== proof.receiptChainDigest ||
      !journal.stableResult ||
      hashCanonical(journal.stableResult) !== proof.resultDigest
    ) {
      throw journalError(
        "workspace-restore.compaction-proof-stale",
        "restore proof no longer matches the immutable evidence snapshot",
      );
    }
    if (
      proof.destinationObservation.path !== journal.destinationRoot ||
      existsSync(journal.destinationRoot)
    ) {
      throw journalError(
        "workspace-restore.compaction-destination-present",
        "restore destination presence changed after proof",
      );
    }
    const descriptorPath = journal.runtimeAttempt?.descriptorPath ?? null;
    if (
      proof.runtimeObservation.runtimeLineageId !== journal.runtimeLineageId ||
      proof.runtimeObservation.lastAttemptNonce !== (journal.runtimeAttempt?.nonce ?? null) ||
      proof.runtimeObservation.descriptorPath !== descriptorPath ||
      (descriptorPath !== null && existsSync(descriptorPath))
    ) {
      throw journalError(
        "workspace-restore.compaction-runtime-present",
        "matching runtime identity changed after proof",
      );
    }
    guards.assertRuntimeAbsent?.(journal);
    const stateGeneration = journal.stateGeneration;
    if (
      !stateGeneration ||
      proof.stateObservation.stateGenerationHash !== hashCanonical(stateGeneration) ||
      proof.stateObservation.objectInventoryHash !== stateGeneration.objectInventoryHash
    ) {
      throw journalError(
        "workspace-restore.compaction-state-invalid",
        "state observation does not bind the immutable generation",
      );
    }
    const statePresent = existsSync(journal.paths.finalState);
    if (proof.stateObservation.status !== (statePresent ? "validated" : "absent")) {
      throw journalError(
        "workspace-restore.compaction-state-invalid",
        "remaining state presence changed after proof",
      );
    }
    if (statePresent) {
      guards.validateState?.(journal);
      const stored = readWorkspaceRestoreStateReceipt(journal.paths.finalState);
      if (canonicalJson(stored) !== canonicalJson(stateGeneration)) {
        throw journalError(
          "workspace-restore.compaction-state-invalid",
          "remaining state receipt changed after proof",
        );
      }
    }
    const head = headRow(db, journal.journalId);
    if (head.reserved_bytes !== 0 || head.owner_pid !== null) {
      throw journalError(
        "workspace-restore.compaction-in-progress",
        "restore evidence has an active effect owner or reservation",
      );
    }
    const tombstone: WorkspaceRestoreTombstone = {
      protocol: "tweakloop.workspace-restore-tombstone/v1",
      kind: journal.operationKind,
      id: journal.operationId,
      fingerprint: journal.requestFingerprint,
      resultDigest: proof.resultDigest,
      protocolVersion: 1,
      canonicalizationVersion: 1,
      fingerprintAlgorithm: "sha256",
      resultDigestAlgorithm: "sha256",
    };
    const evidence = db
      .prepare(
        "SELECT COALESCE(SUM(accounted_bytes), 0) AS bytes FROM restore_journal_revisions WHERE journal_id = ?",
      )
      .get(journal.journalId) as { bytes: number };
    const tombstoneBytes = accountedBytes(tombstone);
    const swapOverhead = ACCOUNTING_OVERHEAD;
    const meta = coordinationMeta(db);
    const additionalPeak = Math.max(0, tombstoneBytes + swapOverhead - evidence.bytes);
    assertCapacity(meta, additionalPeak);
    db.prepare("DELETE FROM restore_journal_revisions WHERE journal_id = ?").run(journal.journalId);
    db.prepare("DELETE FROM restore_journal_heads WHERE journal_id = ?").run(journal.journalId);
    db.prepare(
      "DELETE FROM restore_destination_claims WHERE claim_key = ? AND operation_kind = ? AND operation_id = ?",
    ).run(journal.destinationClaimKey, journal.operationKind, journal.operationId);
    db.prepare(
      `UPDATE restore_operations
       SET status = 'compacted', stable_result_json = NULL, tombstone_json = ?, updated_at = ?
       WHERE operation_kind = ? AND operation_id = ?`,
    ).run(
      canonicalJson(tombstone),
      proof.destinationObservation.checkedAt,
      journal.operationKind,
      journal.operationId,
    );
    db.prepare(
      "UPDATE restore_meta SET used_bytes = MAX(0, used_bytes - ? + ?) WHERE singleton = 1",
    ).run(evidence.bytes, tombstoneBytes);
    return tombstone;
  });
  return transaction.immediate();
}

function destinationIntent(input: string): WorkspaceRestoreDestinationIntent {
  const logicalPath = resolve(input).normalize("NFC");
  const root = parse(logicalPath).root;
  const rawComponents = logicalPath.slice(root.length).split(sep).filter(Boolean);
  const casePolicy =
    process.platform === "darwin" || process.platform === "win32" ? "insensitive" : "sensitive";
  const components = rawComponents.map((part) => {
    const normalized = part.normalize("NFC");
    return casePolicy === "insensitive" ? normalized.toLowerCase() : normalized;
  });
  return {
    protocol: "tweakloop.destination-intent/v1",
    logicalPath,
    components,
    normalization: "NFC",
    casePolicy,
    canonicalizationVersion: 1,
  };
}

function parseDestinationIntent(value: unknown): WorkspaceRestoreDestinationIntent {
  const record = requireRecord(value, "destination intent");
  if (record.protocol !== "tweakloop.destination-intent/v1") invalidReceipt("destination intent");
  requireText(record.logicalPath, "destination logical path");
  if (
    !Array.isArray(record.components) ||
    !record.components.every((entry) => typeof entry === "string")
  ) {
    invalidReceipt("destination components");
  }
  if (record.normalization !== "NFC") invalidReceipt("destination normalization");
  if (record.casePolicy !== "sensitive" && record.casePolicy !== "insensitive") {
    invalidReceipt("destination case policy");
  }
  if (record.canonicalizationVersion !== 1) migrationRequired("destination intent");
  return record as unknown as WorkspaceRestoreDestinationIntent;
}

function destinationIntentsOverlap(
  left: WorkspaceRestoreDestinationIntent,
  right: WorkspaceRestoreDestinationIntent,
): boolean {
  const leftRoot = parse(left.logicalPath).root.normalize("NFC");
  const rightRoot = parse(right.logicalPath).root.normalize("NFC");
  const normalizeRoot = (value: string) =>
    left.casePolicy === "insensitive" || right.casePolicy === "insensitive"
      ? value.toLowerCase()
      : value;
  if (normalizeRoot(leftRoot) !== normalizeRoot(rightRoot)) return false;
  const shared = Math.min(left.components.length, right.components.length);
  for (let index = 0; index < shared; index += 1) {
    if (left.components[index] !== right.components[index]) return false;
  }
  return true;
}

function destinationResolution(
  intent: WorkspaceRestoreDestinationIntent,
): WorkspaceRestoreDestinationResolution {
  let cursor = intent.logicalPath;
  const missing: string[] = [];
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw journalError(
        "workspace-restore.destination-parent-missing",
        "restore destination has no existing ancestor",
      );
    }
    missing.unshift(basename(cursor).normalize("NFC"));
    cursor = parent;
  }
  const ancestorPath = realpathSync(cursor);
  const ancestor = lstatSync(ancestorPath, { bigint: true });
  if (!ancestor.isDirectory() || ancestor.isSymbolicLink()) {
    throw journalError(
      "workspace-restore.destination-ancestor-invalid",
      "restore destination ancestor must be a real directory",
    );
  }
  const normalizedMissing = missing.map((part) =>
    intent.casePolicy === "insensitive" ? part.toLowerCase() : part,
  );
  return {
    protocol: "tweakloop.destination-resolution/v1",
    ancestorPath,
    ancestorDev: String(ancestor.dev),
    ancestorIno: String(ancestor.ino),
    missingComponents: normalizedMissing,
    claimGeneration: hashCanonical({
      ancestorPath,
      ancestorDev: String(ancestor.dev),
      ancestorIno: String(ancestor.ino),
      missingComponents: normalizedMissing,
    }),
    canonicalizationVersion: 1,
  };
}

function existingAncestorPath(input: string): string {
  let cursor = resolve(input);
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw journalError(
        "workspace-restore.destination-parent-missing",
        "restore path has no existing ancestor",
      );
    }
    cursor = parent;
  }
  return realpathSync(cursor);
}

function ownerReceipt(
  journal: WorkspaceRestoreJournal,
  role: "root" | "state",
  finalPath: string,
): WorkspaceRestoreOwnerReceipt {
  return {
    protocol: WORKSPACE_RESTORE_OWNER_PROTOCOL,
    journalId: journal.journalId,
    bundleId: journal.bundleId,
    operationId: journal.operationId,
    requestFingerprint: journal.requestFingerprint,
    ownershipNonce: journal.ownershipNonce,
    role,
    finalPath: resolve(finalPath),
    destinationClaimKey: journal.destinationClaimKey,
  };
}

function ownerReceiptPath(path: string, role: "root" | "state"): string {
  return role === "root"
    ? join(resolve(path), ".tweakloop", "restore-owner.json")
    : join(resolve(path), "restore-owner.json");
}

function parseJournal(value: unknown): WorkspaceRestoreJournal {
  const record = requireRecord(value, "restore journal");
  if (record.protocol !== WORKSPACE_RESTORE_JOURNAL_PROTOCOL) invalidReceipt("journal protocol");
  requireJournalId(record.journalId);
  requireOperationKind(record.operationKind);
  requireOperationId(record.operationId);
  requireHash(record.requestFingerprint, "request fingerprint");
  requireBundleId(record.bundleId);
  requireBundleId(record.sourceBundleId);
  if (record.resultBundleId !== null) requireBundleId(record.resultBundleId);
  requireRestoreId(record.restoreId);
  requireHash(record.collaborationManifestHash, "collaboration manifest hash");
  requireText(record.agentId, "agent id");
  requireInteger(record.revision, "revision");
  requireHash(record.revisionHash, "revision hash");
  if (record.previousRevisionHash !== null)
    requireHash(record.previousRevisionHash, "previous hash");
  requireText(record.transition, "transition");
  requireText(record.destinationRoot, "destination root");
  requireText(record.destinationClaimKey, "destination claim key");
  requireText(record.destinationWorkspaceId, "workspace id");
  requireText(record.projectId, "project id");
  requireText(record.sessionId, "session id");
  requireText(record.processNonce, "process nonce");
  requireText(record.receiptId, "receipt id");
  requireText(record.ownershipNonce, "ownership nonce");
  requireText(record.runtimeLineageId, "runtime lineage id");
  requireRecord(record.destinationIntent, "destination intent");
  requireRecord(record.destinationResolution, "destination resolution");
  requireRecord(record.paths, "paths");
  requireRecord(record.ownership, "ownership");
  if (!Array.isArray(record.overlay)) invalidReceipt("overlay");
  return record as unknown as WorkspaceRestoreJournal;
}

function parseOwnerReceipt(value: unknown): WorkspaceRestoreOwnerReceipt {
  const record = requireRecord(value, "owner receipt");
  if (record.protocol !== WORKSPACE_RESTORE_OWNER_PROTOCOL) invalidReceipt("owner protocol");
  requireJournalId(record.journalId);
  requireBundleId(record.bundleId);
  requireOperationId(record.operationId);
  requireHash(record.requestFingerprint, "request fingerprint");
  requireText(record.ownershipNonce, "ownership nonce");
  if (record.role !== "root" && record.role !== "state") invalidReceipt("owner role");
  requireText(record.finalPath, "final path");
  requireHash(record.destinationClaimKey, "destination claim key");
  return record as unknown as WorkspaceRestoreOwnerReceipt;
}

function parseStateReceipt(value: unknown): WorkspaceStateGenerationReceipt {
  const record = requireRecord(value, "state receipt");
  if (record.protocol !== WORKSPACE_RESTORE_STATE_PROTOCOL) invalidReceipt("state protocol");
  requireJournalId(record.journalId);
  requireOperationId(record.operationId);
  requireBundleId(record.bundleId);
  requireHash(record.requestFingerprint, "request fingerprint");
  requireHash(record.collaborationManifestHash, "collaboration manifest hash");
  requireText(record.workspaceId, "workspace id");
  requireInteger(record.sqliteSchemaVersion, "sqlite schema version");
  requireInteger(record.sqliteMigrationVersion, "sqlite migration version");
  requireHash(record.sqliteSchemaDigest, "sqlite schema digest");
  requireInteger(record.capturedSeq, "captured seq");
  if (record.eventTipId !== null) requireText(record.eventTipId, "event tip id");
  requireHash(record.eventPrefixDigest, "event prefix digest");
  requireInteger(record.semanticReceiptCount, "semantic receipt count");
  requireHash(record.semanticReceiptDigest, "semantic receipt digest");
  requireInteger(record.idempotencyReceiptCount, "idempotency receipt count");
  requireHash(record.idempotencyReceiptDigest, "idempotency receipt digest");
  requireHash(record.objectInventoryHash, "object inventory hash");
  requireHash(record.overlayDigest, "overlay digest");
  requireHash(record.rootMaterialHash, "root material hash");
  requireRecord(record.stateOwnership, "state ownership");
  return record as unknown as WorkspaceStateGenerationReceipt;
}

function parseCompletionMarker(value: unknown): WorkspaceRestoreCompletionMarker {
  const record = requireRecord(value, "completion marker");
  if (record.protocol !== WORKSPACE_RESTORE_MARKER_PROTOCOL) invalidReceipt("marker protocol");
  requireJournalId(record.journalId);
  requireOperationId(record.operationId);
  requireHash(record.requestFingerprint, "request fingerprint");
  requireBundleId(record.sourceBundleId);
  requireRestoreId(record.restoreId);
  requireText(record.destinationRoot, "destination root");
  requireHash(record.destinationClaimKey, "destination claim key");
  requireText(record.workspaceId, "workspace id");
  requireHash(record.collaborationManifestHash, "collaboration manifest hash");
  requireHash(record.rootGenerationHash, "root generation hash");
  requireHash(record.stateGenerationHash, "state generation hash");
  requireText(record.receiptId, "receipt id");
  return record as unknown as WorkspaceRestoreCompletionMarker;
}

function parseForkPlan(value: unknown): WorkspaceForkPlan {
  const record = requireRecord(value, "fork plan");
  if (record.protocol !== WORKSPACE_FORK_PLAN_PROTOCOL) invalidReceipt("fork plan protocol");
  requireOperationId(record.operationId);
  requireBundleId(record.sourceBundleId);
  if (record.resultBundleId !== null) requireBundleId(record.resultBundleId);
  requireText(record.sourceSessionId, "source session id");
  requireRecord(record.destinationIntent, "destination intent");
  requireText(record.destinationRoot, "destination root");
  requireText(record.destinationWorkspaceId, "destination workspace id");
  requireText(record.destinationSessionId, "destination session id");
  requireText(record.processNonce, "process nonce");
  requireText(record.forkCommandId, "fork command id");
  requireText(record.forkCorrelationId, "fork correlation id");
  requireText(record.recordedAt, "recordedAt");
  return record as unknown as WorkspaceForkPlan;
}

function parseCompactionProof(value: unknown): WorkspaceRestoreCompactionProof {
  const record = requireRecord(value, "compaction proof");
  if (record.protocol !== "tweakloop.workspace-restore-compaction-proof/v1") {
    migrationRequired("compaction proof protocol");
  }
  requireOperationKind(record.operationKind);
  requireOperationId(record.operationId);
  requireJournalId(record.journalId);
  requireHash(record.requestFingerprint, "request fingerprint");
  requireInteger(record.expectedRevision, "expected revision");
  requireHash(record.expectedRevisionHash, "expected revision hash");
  requireHash(record.receiptChainDigest, "receipt chain digest");
  requireHash(record.resultDigest, "result digest");
  const destination = requireRecord(record.destinationObservation, "destination observation");
  if (destination.status !== "absent") invalidReceipt("destination observation status");
  requireText(destination.path, "destination observation path");
  requireText(destination.checkedAt, "destination observation time");
  const runtime = requireRecord(record.runtimeObservation, "runtime observation");
  if (runtime.status !== "absent") invalidReceipt("runtime observation status");
  requireText(runtime.runtimeLineageId, "runtime lineage id");
  if (runtime.lastAttemptNonce !== null) {
    requireText(runtime.lastAttemptNonce, "runtime attempt nonce");
  }
  if (runtime.descriptorPath !== null) requireText(runtime.descriptorPath, "descriptor path");
  requireText(runtime.checkedAt, "runtime observation time");
  const state = requireRecord(record.stateObservation, "state observation");
  if (state.status !== "absent" && state.status !== "validated") {
    invalidReceipt("state observation status");
  }
  requireHash(state.stateGenerationHash, "state generation hash");
  requireHash(state.objectInventoryHash, "object inventory hash");
  requireText(state.checkedAt, "state observation time");
  return record as unknown as WorkspaceRestoreCompactionProof;
}

function parseTombstoneJson(value: string | null): WorkspaceRestoreTombstone {
  if (value === null) {
    throw journalError(
      "workspace-restore.tombstone-invalid",
      "compacted operation has no immutable tombstone",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw journalError(
      "workspace-restore.tombstone-invalid",
      "restore tombstone is unreadable",
      409,
      { cause: errorMessage(error) },
    );
  }
  const record = requireRecord(parsed, "restore tombstone");
  if (record.protocol !== "tweakloop.workspace-restore-tombstone/v1") {
    migrationRequired("restore tombstone protocol");
  }
  requireOperationKind(record.kind);
  requireOperationId(record.id);
  requireHash(record.fingerprint, "tombstone fingerprint");
  requireHash(record.resultDigest, "tombstone result digest");
  if (record.protocolVersion !== 1 || record.canonicalizationVersion !== 1) {
    migrationRequired("restore tombstone version");
  }
  if (record.fingerprintAlgorithm !== "sha256" || record.resultDigestAlgorithm !== "sha256") {
    migrationRequired("restore tombstone hash algorithm");
  }
  return record as unknown as WorkspaceRestoreTombstone;
}

function writeInitialValue(path: string, value: unknown): void {
  const temp = `${path}.initial`;
  writeDurableBytes(temp, serializedJson(value), true);
  if (existsSync(path)) {
    removeRegularFile(temp);
    throw journalError(
      "workspace-restore.journal-conflict",
      "durable plan was concurrently created",
    );
  }
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

function writeReplacementValue(path: string, value: unknown): void {
  const temp = `${path}.next`;
  if (existsSync(temp)) removeRegularFile(temp);
  writeDurableBytes(temp, serializedJson(value), true);
  renameSync(temp, path);
  fsyncDirectory(dirname(path));
}

function recoverInitialValue<T>(path: string, parser: (value: unknown) => T): void {
  const temp = `${path}.initial`;
  if (!existsSync(temp)) return;
  if (!existsSync(path)) {
    parser(readJson(temp));
    renameSync(temp, path);
    fsyncDirectory(dirname(path));
    return;
  }
  removeRegularFile(temp);
}

function writeDurableJson(path: string, value: unknown): void {
  writeDurableBytes(path, serializedJson(value), true);
}

function writeDurableBytes(path: string, bytes: Buffer, exclusive = false): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fd = openSync(path, exclusive ? "wx" : "w", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } catch (error) {
    if (!unsupportedDirectoryFsync(error)) throw error;
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

function removeRegularFile(path: string): void {
  const status = lstatSync(path);
  if (!status.isFile() || status.isSymbolicLink()) {
    throw journalError(
      "workspace-restore.journal-temp-invalid",
      "restore temporary path is not a regular file",
    );
  }
  rmSync(path, { force: false });
  fsyncDirectory(dirname(path));
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw journalError(
      "workspace-restore.receipt-invalid",
      `restore receipt is missing or invalid: ${path}`,
      409,
      { cause: errorMessage(error) },
    );
  }
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

function hashCanonical(value: unknown): string {
  return digest(canonicalJson(value));
}

function serializedJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function accountedBytes(value: unknown): number {
  return Buffer.byteLength(canonicalJson(value), "utf8") + ACCOUNTING_OVERHEAD;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw journalError("workspace-restore.receipt-invalid", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOperationKind(value: unknown): asserts value is WorkspaceRestoreOperationKind {
  if (value !== "restore" && value !== "fork") invalidReceipt("operation kind");
}

function requireOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) invalidReceipt("operation id");
}

function requireBundleId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !BUNDLE_ID.test(value)) invalidReceipt("bundle id");
}

function requireRestoreId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !RESTORE_ID.test(value)) invalidReceipt("restore id");
}

function requireJournalId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^restore_journal_[a-f0-9]{48}$/.test(value)) {
    invalidReceipt("journal id");
  }
}

function requireHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) invalidReceipt(field);
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0"))
    invalidReceipt(field);
}

function requireInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalidReceipt(field);
}

function invalidReceipt(field: string): never {
  throw journalError(
    "workspace-restore.receipt-invalid",
    `restore receipt field is invalid: ${field}`,
  );
}

function migrationRequired(field: string): never {
  throw journalError(
    "workspace-restore.migration-required",
    `restore evidence version is unsupported: ${field}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function journalError(
  code: string,
  message: string,
  status = 409,
  details: Readonly<Record<string, unknown>> = {},
): WorkspaceRestoreJournalError {
  return new WorkspaceRestoreJournalError(code, message, status, details);
}
