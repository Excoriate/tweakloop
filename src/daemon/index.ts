import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMAND_PROTOCOL, PROTOCOL_VERSION } from "../protocol/versions.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { SemanticSceneStore } from "../whiteboard/semantic-store.js";
import type { CompletedWorkspaceRestore } from "../workspace/restore.js";
import { installWorkspaceRestore } from "../workspace/restore.js";
import {
  createWorkspaceForkPlanStore,
  createWorkspaceRestoreJournalStore,
  deriveWorkspaceRestoreOperationId,
  deterministicRestoreId,
  hashWorkspaceRestoreReceipt,
  publishRestoreOwnedDirectory,
  type WorkspaceActivation,
  type WorkspaceRestoreJournal,
  WorkspaceRestoreJournalError,
  type WorkspaceRestoreOperationKind,
  type WorkspaceRestoreStableResult,
  type WorkspaceRuntimeAttempt,
} from "../workspace/restore-journal.js";
import {
  finalizeWorkspaceRestoreGeneration,
  stageWorkspaceRestoreMaterial,
  stageWorkspaceRestoreState,
  validatePublishedWorkspaceRestore,
  validateStagedWorkspaceRestoreBundle,
} from "../workspace/restore-prepare.js";
import {
  createWorkspaceRestoreRetentionService,
  retainWorkspaceRestoreBundle,
} from "../workspace/restore-retention.js";
import {
  resolveWorkspaceActivation,
  runtimeAttemptDecision,
} from "../workspace/restore-runtime.js";
import { createEventHub } from "./event-stream.js";
import { type AuthState, createHttpLayer } from "./http.js";
import {
  discoverHealthyRuntime,
  ensureProjectConfig,
  inspectRuntimeIdentity,
  type RestoreGenerationIdentity,
  type RuntimeDescriptor,
  readRuntime,
  removeRuntime,
  restoredWorkspaceRoot,
  runtimePath,
  stateDirFor,
  tweakloopStateRoot,
  workspaceIdFor,
  writeRuntime,
} from "./runtime.js";
import { createTransactor } from "./transactor.js";

export type DaemonOptions = Readonly<{
  rootPath: string;
  /** Called after a shutdown request has been fully processed. */
  onExit?: () => void;
  log?: (line: string) => void;
  restore?: CompletedWorkspaceRestore;
  preparedRestore?: Readonly<{
    startNonce: string;
    restoreGeneration: RestoreGenerationIdentity;
  }>;
}>;

export type DaemonHandle = Readonly<{
  workspaceId: string;
  projectId: string;
  rootPath: string;
  shellPort: number;
  artifactPort: number;
  cliToken: string;
  startNonce: string;
  restoreGeneration: RestoreGenerationIdentity | null;
  close: () => void;
}>;

const restoredDaemons = new Map<string, DaemonHandle>();
const restoreOperationTails = new Map<string, Promise<void>>();
const DAEMON_PROCESS_BOOT_NONCE = randomBytes(16).toString("hex");
const DAEMON_PROCESS_STARTED_AT = new Date(
  Date.now() - Math.floor(process.uptime() * 1000),
).toISOString();
const RESTORE_HTTP_TIMEOUT_MS = 5_000;
const RUNTIME_ATTEMPT_TIMEOUT_MS = 30_000;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  if (options.restore && options.preparedRestore) {
    throw new Error("daemon cannot prepare and consume a restored state in the same start");
  }
  const rootPath = resolve(options.rootPath);
  const workspaceId = workspaceIdFor(rootPath);

  const running = await discoverHealthyRuntime(workspaceId);
  if (running) {
    throw new Error(
      `a daemon for this workspace is already running (pid ${running.pid}, shell port ${running.shellPort})`,
    );
  }

  const stateDir = stateDirFor(workspaceId);
  mkdirSync(stateDir, { recursive: true });

  const logPath = join(stateDir, "daemon.log");
  const log =
    options.log ??
    ((line: string) => {
      appendFileSync(logPath, `${line}\n`);
    });

  const project = options.restore
    ? { projectId: options.restore.plan.manifest.source.projectId, schemaVersion: 1 }
    : ensureProjectConfig(rootPath);
  const objectsDir = join(stateDir, "objects");
  mkdirSync(objectsDir, { recursive: true });
  const db = openDatabase(join(stateDir, "events.sqlite"));
  const hub = createEventHub();
  const startNonce = options.preparedRestore?.startNonce ?? randomBytes(16).toString("hex");
  const transactor = createTransactor({
    db,
    workspaceId,
    daemonStartNonce: startNonce,
    newEventId: () => `evt_${randomUUID()}`,
    now: () => new Date().toISOString(),
    onCommitted: (envelopes) => hub.publish(envelopes),
  });

  if (options.restore) {
    const installed = installWorkspaceRestore(options.restore, rootPath, objectsDir, workspaceId);
    const createdAt =
      options.restore.plan.manifest.events[0]?.recordedAt ?? new Date().toISOString();
    transactor.restoreHistory({
      events: installed.events,
      blobs: options.restore.plan.objects.map((object) => ({
        hash: object.hash,
        byteLength: object.byteLength,
        mediaType: object.mediaType,
        createdAt,
      })),
    });
    new SemanticSceneStore(db, { objectsDir, workspaceId }).restoreReceiptSnapshots(
      installed.semanticReceiptSnapshots,
    );
  }

  if (!options.restore && !options.preparedRestore) {
    const opened = transactor.execute({
      protocol: COMMAND_PROTOCOL,
      commandId: randomUUID(),
      idempotencyKey: `workspace.open:${workspaceId}`,
      workspaceId,
      actor: { kind: "system", id: "daemon" },
      type: "workspace.open",
      payload: { projectId: project.projectId, rootPath },
    });
    if (opened.status === "rejected") {
      db.close();
      throw new Error(`workspace.open rejected: ${opened.code} ${opened.message}`);
    }
  }

  const cliToken = randomBytes(32).toString("hex");
  const auth: AuthState = { cliToken, sessions: new Set(), bootstrapTokens: new Set() };
  const restoreRetention = createWorkspaceRestoreRetentionService(
    join(tweakloopStateRoot(), "restore-journals"),
    join(tweakloopStateRoot(), "restore-evidence"),
    { assertRuntimeAbsent: assertNoCachedRestoreRuntime },
  );

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    removeRuntime(workspaceId, startNonce);
    httpLayer.close();
    db.close();
    log(JSON.stringify({ ts: new Date().toISOString(), message: "daemon stopped" }));
  };

  const httpLayer = createHttpLayer({
    db,
    objectsDir,
    workspace: {
      workspaceId,
      projectId: project.projectId,
      rootPath,
      protocolVersion: PROTOCOL_VERSION,
      startNonce,
      restoreGeneration: options.preparedRestore?.restoreGeneration ?? null,
    },
    transactor,
    hub,
    auth,
    onShutdown: () => {
      close();
      options.onExit?.();
    },
    log,
    commitWorkspaceRestore: launchRestoredWorkspace,
    workspaceRestoreInventory: restoreRetention.inventory,
    compactWorkspaceRestore: restoreRetention.compact,
  });

  let ports: { shellPort: number; artifactPort: number };
  try {
    ports = await httpLayer.listen();
    writeRuntime({
      pid: process.pid,
      startNonce,
      shellPort: ports.shellPort,
      artifactPort: ports.artifactPort,
      protocolVersion: PROTOCOL_VERSION,
      workspaceId,
      cliToken,
      restoreGeneration: options.preparedRestore?.restoreGeneration ?? null,
    });
  } catch (error) {
    const descriptor = readRuntime(workspaceId);
    if (descriptor?.startNonce === startNonce) removeRuntime(workspaceId, startNonce);
    httpLayer.close();
    db.close();
    throw error;
  }
  log(
    JSON.stringify({
      ts: new Date().toISOString(),
      message: "daemon started",
      workspaceId,
      ...ports,
    }),
  );

  return {
    workspaceId,
    projectId: project.projectId,
    rootPath,
    shellPort: ports.shellPort,
    artifactPort: ports.artifactPort,
    cliToken,
    startNonce,
    restoreGeneration: options.preparedRestore?.restoreGeneration ?? null,
    close,
  };
}

export type WorkspaceRestoreLaunchOptions = Readonly<{
  destinationRoot?: string;
  sessionId?: string;
  bundleRoot: string;
  operationKind?: WorkspaceRestoreOperationKind;
  operationId?: string;
}>;

export type WorkspaceRestoreLaunchResult = Readonly<{
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
  overlay: WorkspaceRestoreJournal["overlay"];
  receipt: WorkspaceRestoreStableResult;
}>;

export async function launchRestoredWorkspace(
  completed: CompletedWorkspaceRestore,
  agentId: string,
  options: WorkspaceRestoreLaunchOptions,
): Promise<WorkspaceRestoreLaunchResult> {
  if (completed.plan.bundleMode !== "bound-envelope") {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.bundle-envelope-required",
      "collaboration-only restore staging cannot be committed; re-export with a bound workspace bundle envelope",
      426,
    );
  }
  validateStagedWorkspaceRestoreBundle(options.bundleRoot, completed);
  const forkPlans = createWorkspaceForkPlanStore(join(tweakloopStateRoot(), "fork-plans"));
  const forkPlan = forkPlans.findByResultBundleId(completed.plan.bundleId);
  const operationKind = options.operationKind ?? (forkPlan ? "fork" : "restore");
  if ((operationKind === "fork") !== (forkPlan !== null)) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.operation-kind-conflict",
      "restore operation kind does not match the durable bundle lineage",
    );
  }
  const rootPath = resolve(
    options.destinationRoot ??
      forkPlan?.destinationRoot ??
      restoredWorkspaceRoot(completed.plan.bundleId),
  );
  if (forkPlan && rootPath !== resolve(forkPlan.destinationRoot)) {
    throw new WorkspaceRestoreJournalError(
      "workspace-fork.destination-conflict",
      "fork result bundle is bound to another destination",
    );
  }
  const operationId =
    forkPlan?.operationId ??
    deriveWorkspaceRestoreOperationId({
      operationKind: "restore",
      bundleId: completed.plan.bundleId,
      destinationRoot: rootPath,
    });
  if (options.operationId !== undefined && options.operationId !== operationId) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.operation-conflict",
      "provided operation id does not match the bundle and destination binding",
    );
  }
  const sessionId = forkPlan?.destinationSessionId ?? options.sessionId;
  if (forkPlan && options.sessionId !== undefined && options.sessionId !== sessionId) {
    throw new WorkspaceRestoreJournalError(
      "workspace-fork.session-conflict",
      "fork result bundle is bound to another destination session",
    );
  }
  const workspaceId = workspaceIdFor(rootPath);
  return withRestoreOperationLock(`${operationKind}:${operationId}`, async () => {
    const journalStore = createWorkspaceRestoreJournalStore(
      join(tweakloopStateRoot(), "restore-journals"),
    );
    try {
      let journal = journalStore.begin({
        operationKind,
        operationId,
        bundleId: completed.plan.bundleId,
        sourceBundleId: forkPlan?.sourceBundleId ?? completed.plan.bundleId,
        resultBundleId: forkPlan?.resultBundleId ?? null,
        restoreId: completed.plan.restoreId,
        collaborationManifestHash: completed.plan.manifestHash,
        sourceSessionId: forkPlan?.sourceSessionId ?? null,
        agentId,
        destinationRoot: rootPath,
        destinationWorkspaceId: workspaceId,
        projectId: completed.plan.manifest.source.projectId,
        finalState: stateDirFor(workspaceId),
        ...(sessionId ? { sessionId } : {}),
        ...(forkPlan ? { processNonce: forkPlan.processNonce } : {}),
      });
      const alreadyRestored = journal.transition === "result-committed";
      try {
        retainWorkspaceRestoreBundle(
          join(tweakloopStateRoot(), "restore-evidence"),
          options.bundleRoot,
          journal.bundleId,
        );
      } catch {
        throw new WorkspaceRestoreJournalError(
          "workspace-restore.bundle-binding-mismatch",
          "bundle envelope or an exact bound component changed after staging",
          409,
        );
      }
      journal = driveRestorePublication(journalStore, journal, completed, options.bundleRoot);
      try {
        validatePublishedWorkspaceRestore({ journal, completed });
      } catch (error) {
        recordRestoreRecovery(journalStore, journal, error);
        throw error;
      }
      const runtime = await ensureRestoreRuntime(journalStore, journal);
      journal = runtime.journal;
      const session = await ensureRestoreSession(
        journalStore,
        journal,
        runtime.descriptor,
        completed,
      );
      journal = session.journal;
      if (journal.transition === "session-ready") {
        journal = journalStore.intent(journal, "result-commit-intent");
      } else if (journal.transition === "runtime-ready" && journal.stableResult) {
        journal = journalStore.intent(journal, "result-commit-intent", {
          activation: runtime.restarted ? "restart-runtime-only" : journal.activation,
        });
      }
      if (journal.transition === "result-commit-intent") {
        journalStore.resume(journal);
        const stableResult = journal.stableResult ?? stableRestoreResult(journal);
        journal = journalStore.effect(journal, "result-committed", { stableResult });
      }
      if (journal.transition !== "result-committed" || !journal.stableResult) {
        throw new WorkspaceRestoreJournalError(
          "workspace-restore.result-incomplete",
          `restore reconciliation stopped at ${journal.transition}`,
        );
      }
      validatePublishedWorkspaceRestore({ journal, completed });
      const expected = restoreGenerationIdentity(journal);
      const descriptor = await discoverHealthyRuntime(journal.destinationWorkspaceId, {
        startNonce: journal.runtimeAttempt?.nonce ?? "",
        restoreGeneration: expected,
      });
      if (!descriptor) {
        throw new WorkspaceRestoreJournalError(
          "workspace-restore.runtime-generation-mismatch",
          "restored runtime no longer proves the committed generation",
        );
      }
      const current = await resolveRestoreLocator(descriptor, journal, completed);
      const activation: WorkspaceActivation =
        runtime.restarted && current.activation === "attach"
          ? "restart-runtime-only"
          : current.activation;
      const url =
        current.locatorSessionId === null
          ? null
          : await mintRestoreBootstrap(descriptor, journal.agentId, current.locatorSessionId);
      return {
        url,
        workspaceId: journal.destinationWorkspaceId,
        projectId: journal.projectId,
        rootPath: journal.destinationRoot,
        sessionId: current.locatorSessionId,
        locator:
          current.locatorSessionId === null || url === null
            ? null
            : { url, sessionId: current.locatorSessionId },
        operationId: journal.operationId,
        bundleId: journal.bundleId,
        sourceBundleId: journal.sourceBundleId,
        resultBundleId: journal.resultBundleId,
        activation,
        operationSessionId: journal.sessionId,
        alreadyRestored,
        overlay: journal.overlay,
        receipt: journal.stableResult,
      };
    } finally {
      journalStore.close();
    }
  });
}

type WorkspaceRestoreJournalStore = ReturnType<typeof createWorkspaceRestoreJournalStore>;

function driveRestorePublication(
  store: WorkspaceRestoreJournalStore,
  initial: WorkspaceRestoreJournal,
  completed: CompletedWorkspaceRestore,
  bundleRoot: string,
): WorkspaceRestoreJournal {
  let journal = initial;
  for (;;) {
    switch (journal.transition) {
      case "destination-claimed":
        journal = store.intent(journal, "root-material-intent");
        continue;
      case "root-material-intent": {
        store.resume(journal);
        const material = stageWorkspaceRestoreMaterial({ journal, completed, bundleRoot });
        journal = store.effect(journal, "root-material-staged", {
          ownership: { root: material.rootOwnership, state: material.stateOwnership },
          overlay: material.overlay,
          rootMaterial: material.rootMaterial,
        });
        continue;
      }
      case "root-material-staged":
        journal = store.intent(journal, "state-stage-intent");
        continue;
      case "state-stage-intent": {
        store.resume(journal);
        const state = stageWorkspaceRestoreState({ journal, completed });
        journal = store.effect(journal, "state-staged", {
          stateGeneration: state.stateGeneration,
        });
        continue;
      }
      case "state-staged":
        journal = store.intent(journal, "root-generation-finalize-intent");
        continue;
      case "root-generation-finalize-intent": {
        store.resume(journal);
        const generation = finalizeWorkspaceRestoreGeneration({ journal });
        journal = store.effect(journal, "root-generation-finalized", {
          rootGeneration: generation.rootGeneration,
        });
        continue;
      }
      case "root-generation-finalized":
        journal = store.intent(journal, "state-commit-intent");
        continue;
      case "state-commit-intent":
        store.resume(journal);
        publishRestoreOwnedDirectory(journal, "state");
        journal = store.effect(journal, "state-committed");
        continue;
      case "state-committed":
        journal = store.intent(journal, "root-commit-intent");
        continue;
      case "root-commit-intent":
        store.resume(journal);
        publishRestoreOwnedDirectory(journal, "root");
        journal = store.effect(journal, "root-committed");
        continue;
      case "recovery-required":
        throw new WorkspaceRestoreJournalError(
          journal.recovery?.code ?? "workspace-restore.recovery-required",
          journal.recovery?.message ?? "restore requires explicit recovery",
        );
      default:
        return journal;
    }
  }
}

async function ensureRestoreRuntime(
  store: WorkspaceRestoreJournalStore,
  initial: WorkspaceRestoreJournal,
): Promise<
  Readonly<{ journal: WorkspaceRestoreJournal; descriptor: RuntimeDescriptor; restarted: boolean }>
> {
  let journal = initial;
  const restarted = journal.stableResult !== null && (journal.runtimeAttempt?.attempt ?? 0) > 1;
  const generation = restoreGenerationIdentity(journal);
  if (
    (journal.transition === "result-committed" || journal.transition === "runtime-ready") &&
    journal.runtimeAttempt
  ) {
    const expected = { startNonce: journal.runtimeAttempt.nonce, restoreGeneration: generation };
    const observation = await inspectRuntimeIdentity(journal.destinationWorkspaceId, expected);
    if (observation.status === "ready") {
      return { journal, descriptor: observation.descriptor, restarted };
    }
    if (observation.status === "alien") {
      recordRestoreRecovery(
        store,
        journal,
        new WorkspaceRestoreJournalError(
          "workspace-restore.runtime-generation-conflict",
          "a healthy daemon advertises another restore generation",
        ),
      );
      throw new WorkspaceRestoreJournalError(
        "workspace-restore.runtime-generation-conflict",
        "a healthy daemon advertises another restore generation",
      );
    }
    if (observation.status === "live-no-ready") {
      const deadline = journal.runtimeAttempt.deadline;
      const decision = runtimeAttemptDecision({
        attempt: journal.runtimeAttempt,
        observed: observation.status,
        now: new Date().toISOString(),
      });
      if (decision === "stuck") {
        journal = store.effect(journal, "recovery-required", {
          recovery: {
            code: "workspace-restore.runtime-attempt-stuck",
            message: "restored runtime stayed live without proving readiness through its deadline",
          },
        });
      }
      throw new WorkspaceRestoreJournalError(
        decision === "stuck"
          ? "workspace-restore.runtime-attempt-stuck"
          : "workspace-restore.runtime-attempt-pending",
        decision === "stuck"
          ? "restored runtime exceeded its durable readiness deadline"
          : "restored runtime is live but has not proved readiness",
        decision === "stuck" ? 504 : 503,
        { deadline, receipt: journal.stableResult },
      );
    }
    if (observation.status === "dead") {
      removeRuntime(journal.destinationWorkspaceId, journal.runtimeAttempt.nonce);
    }
    journal = store.intent(journal, "runtime-attempt-intent", {
      runtimeAttempt: nextRuntimeAttempt(journal),
    });
  } else if (
    (journal.transition === "session-start-intent" ||
      journal.transition === "session-ready" ||
      journal.transition === "result-commit-intent") &&
    journal.runtimeAttempt
  ) {
    const expected = { startNonce: journal.runtimeAttempt.nonce, restoreGeneration: generation };
    const observation = await inspectRuntimeIdentity(journal.destinationWorkspaceId, expected);
    if (observation.status === "ready") {
      return { journal, descriptor: observation.descriptor, restarted };
    }
    if (journal.transition.endsWith("-intent")) store.resume(journal);
    recordRestoreRecovery(
      store,
      journal,
      new WorkspaceRestoreJournalError(
        observation.status === "alien"
          ? "workspace-restore.runtime-generation-conflict"
          : "workspace-restore.runtime-lost-before-result",
        `runtime generation became ${observation.status} during session/result reconciliation`,
      ),
    );
    throw new WorkspaceRestoreJournalError(
      observation.status === "alien"
        ? "workspace-restore.runtime-generation-conflict"
        : "workspace-restore.runtime-lost-before-result",
      `runtime generation became ${observation.status} during session/result reconciliation`,
    );
  } else if (
    journal.transition === "root-committed" ||
    journal.transition === "runtime-attempt-failed"
  ) {
    if (journal.transition === "root-committed") {
      const unexpected = await inspectRuntimeIdentity(journal.destinationWorkspaceId);
      if (unexpected.status !== "absent") {
        recordRestoreRecovery(
          store,
          journal,
          new WorkspaceRestoreJournalError(
            "workspace-restore.runtime-unowned",
            "a runtime descriptor exists before the journal has launched a generation",
          ),
        );
        throw new WorkspaceRestoreJournalError(
          "workspace-restore.runtime-unowned",
          "a runtime descriptor exists before the journal has launched a generation",
        );
      }
    }
    journal = store.intent(journal, "runtime-attempt-intent", {
      runtimeAttempt: nextRuntimeAttempt(journal),
    });
  }
  if (journal.transition === "runtime-attempt-stuck") {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.runtime-attempt-stuck",
      "restored runtime exceeded its durable readiness deadline",
      504,
      { deadline: journal.runtimeAttempt?.deadline ?? null, receipt: journal.stableResult },
    );
  }
  if (
    journal.transition === "runtime-attempt-intent" ||
    journal.transition === "runtime-attempt-pending"
  ) {
    if (journal.transition === "runtime-attempt-intent") store.resume(journal);
    const attempt = journal.runtimeAttempt;
    if (!attempt) throw new Error("runtime attempt disappeared after validation");
    const expected = { startNonce: attempt.nonce, restoreGeneration: generation };
    let observation = await inspectRuntimeIdentity(journal.destinationWorkspaceId, expected);
    if (observation.status === "alien") {
      journal = store.effect(journal, "recovery-required", {
        recovery: {
          code: "workspace-restore.runtime-generation-conflict",
          message: "runtime descriptor does not match the journal launch intent",
        },
      });
      throw new WorkspaceRestoreJournalError(
        journal.recovery?.code ?? "workspace-restore.runtime-generation-conflict",
        journal.recovery?.message ?? "runtime descriptor conflicts with restore generation",
      );
    }
    if (observation.status === "live-no-ready") {
      const decision = runtimeAttemptDecision({
        attempt,
        observed: observation.status,
        now: new Date().toISOString(),
      });
      journal = store.effect(
        journal,
        decision === "stuck" ? "runtime-attempt-stuck" : "runtime-attempt-pending",
        { runtimeAttempt: { ...attempt, status: decision === "stuck" ? "stuck" : "pending" } },
      );
      throw new WorkspaceRestoreJournalError(
        decision === "stuck"
          ? "workspace-restore.runtime-attempt-stuck"
          : "workspace-restore.runtime-attempt-pending",
        decision === "stuck"
          ? "restored runtime exceeded its durable readiness deadline"
          : "restored runtime is live but has not proved readiness",
        decision === "stuck" ? 504 : 503,
        { deadline: attempt.deadline },
      );
    }
    if (observation.status === "dead") {
      removeRuntime(journal.destinationWorkspaceId, attempt.nonce);
      observation = { status: "absent" };
    }
    if (observation.status === "absent" && journal.transition === "runtime-attempt-pending") {
      journal = store.effect(journal, "runtime-attempt-failed", {
        runtimeAttempt: { ...attempt, status: "failed" },
      });
      throw new WorkspaceRestoreJournalError(
        "workspace-restore.runtime-attempt-failed",
        "pending restored runtime exited before proving readiness",
        503,
        { deadline: attempt.deadline },
      );
    }
    if (observation.status === "absent") {
      const cacheKey = restoreDaemonCacheKey(journal, attempt);
      try {
        const handle = await startDaemon({
          rootPath: journal.destinationRoot,
          preparedRestore: { startNonce: attempt.nonce, restoreGeneration: generation },
          log: () => {},
          onExit: () => restoredDaemons.delete(cacheKey),
        });
        const proved = await discoverHealthyRuntime(journal.destinationWorkspaceId, expected);
        if (!proved) {
          handle.close();
          throw new WorkspaceRestoreJournalError(
            "workspace-restore.runtime-handshake-failed",
            "started daemon did not publish the intended journal and generation identities",
          );
        }
        restoredDaemons.set(cacheKey, handle);
        observation = { status: "ready", descriptor: proved };
      } catch (error) {
        journal = store.effect(journal, "runtime-attempt-failed", {
          runtimeAttempt: { ...attempt, status: "failed" },
        });
        throw error;
      }
    }
    if (observation.status !== "ready") {
      throw new WorkspaceRestoreJournalError(
        "workspace-restore.runtime-not-ready",
        `runtime reconciliation stopped at ${observation.status}`,
      );
    }
    journal = store.effect(journal, "runtime-ready", {
      runtimeAttempt: { ...attempt, status: "ready" },
    });
    return {
      journal,
      descriptor: observation.descriptor,
      restarted: journal.stableResult !== null,
    };
  }
  throw new WorkspaceRestoreJournalError(
    "workspace-restore.runtime-phase-invalid",
    `cannot reconcile runtime from ${journal.transition}`,
  );
}

async function ensureRestoreSession(
  store: WorkspaceRestoreJournalStore,
  initial: WorkspaceRestoreJournal,
  descriptor: RuntimeDescriptor,
  completed: CompletedWorkspaceRestore,
): Promise<Readonly<{ journal: WorkspaceRestoreJournal }>> {
  let journal = initial;
  if (journal.transition === "result-committed") return { journal };
  if (journal.transition === "runtime-ready" && journal.stableResult) return { journal };
  if (journal.transition === "runtime-ready") {
    journal = store.intent(journal, "session-start-intent");
  }
  if (journal.transition !== "session-start-intent") {
    if (journal.transition === "session-ready" || journal.transition === "result-commit-intent") {
      return { journal };
    }
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.session-phase-invalid",
      `cannot reconcile session from ${journal.transition}`,
    );
  }
  store.resume(journal);
  const expected = {
    startNonce: journal.runtimeAttempt?.nonce ?? "",
    restoreGeneration: restoreGenerationIdentity(journal),
  };
  if (!(await discoverHealthyRuntime(journal.destinationWorkspaceId, expected))) {
    journal = store.effect(journal, "recovery-required", {
      recovery: {
        code: "workspace-restore.runtime-lost-before-session",
        message: "runtime generation disappeared before session reconciliation",
      },
    });
    throw new WorkspaceRestoreJournalError(
      journal.recovery?.code ?? "workspace-restore.runtime-lost-before-session",
      journal.recovery?.message ?? "runtime disappeared before session reconciliation",
    );
  }
  const prefixHasSession = completed.plan.manifest.events.some(
    (event) =>
      event.eventType === "session.started" &&
      isRecord(event.payload) &&
      event.payload.sessionId === journal.sessionId,
  );
  if (prefixHasSession) {
    const suffix = await readRestoreSuffix(descriptor, completed.plan.manifest.capturedSeq);
    const resolution = resolveWorkspaceActivation(suffix, journal.sessionId);
    const activation = resolution.activation;
    if (
      resolution.locatorSessionId === null ||
      (activation !== "attach" && activation !== "successor-active")
    ) {
      journal = store.effect(journal, "recovery-required", {
        activation,
        recovery: {
          code: `workspace-restore.session-${activation}`,
          message: `restored session activation resolved to ${activation}`,
        },
      });
      throw new WorkspaceRestoreJournalError(
        journal.recovery?.code ?? "workspace-restore.session-recovery",
        journal.recovery?.message ?? "restored session cannot be attached",
      );
    }
    journal = store.effect(journal, "session-ready", { activation });
    return { journal };
  }
  const response = await fetch(`http://127.0.0.1:${descriptor.shellPort}/api/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.cliToken}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(RESTORE_HTTP_TIMEOUT_MS),
    body: JSON.stringify({
      protocol: COMMAND_PROTOCOL,
      commandId: deterministicRestoreId(journal.operationId, "command_restore"),
      idempotencyKey: `session.start:${journal.sessionId}`,
      workspaceId: journal.destinationWorkspaceId,
      actor: { kind: "agent", id: journal.agentId },
      type: "session.start",
      payload: {
        sessionId: journal.sessionId,
        artifactId: null,
        agentId: journal.agentId,
        processNonce: journal.processNonce,
        baseRevisionId: null,
        title: journal.operationKind === "fork" ? "Forked workspace" : "Restored workspace",
        goal:
          journal.operationKind === "fork"
            ? "Continue work in an independent workspace fork"
            : "Continue work from the saved workspace history",
      },
    }),
  });
  const result = (await response.json().catch(() => null)) as Readonly<{
    status?: string;
    code?: string;
    message?: string;
  }> | null;
  if (!response.ok || result?.status === "rejected") {
    throw new WorkspaceRestoreJournalError(
      result?.code ?? "workspace-restore.session-start-failed",
      result?.message ?? `restored session start failed with HTTP ${response.status}`,
    );
  }
  journal = store.effect(journal, "session-ready", { activation: "replay-session-command" });
  return { journal };
}

async function resolveRestoreLocator(
  descriptor: RuntimeDescriptor,
  journal: WorkspaceRestoreJournal,
  completed: CompletedWorkspaceRestore,
) {
  const suffix = await readRestoreSuffix(descriptor, completed.plan.manifest.capturedSeq);
  return resolveWorkspaceActivation(suffix, journal.sessionId);
}

function nextRuntimeAttempt(journal: WorkspaceRestoreJournal): WorkspaceRuntimeAttempt {
  const now = Date.now();
  return {
    attempt: (journal.runtimeAttempt?.attempt ?? 0) + 1,
    nonce: randomBytes(24).toString("hex"),
    ownerPid: process.pid,
    ownerBootNonce: DAEMON_PROCESS_BOOT_NONCE,
    ownerProcessStartedAt: DAEMON_PROCESS_STARTED_AT,
    deadline: new Date(now + RUNTIME_ATTEMPT_TIMEOUT_MS).toISOString(),
    descriptorPath: runtimePath(journal.destinationWorkspaceId),
    status: "intent",
  };
}

function restoreGenerationIdentity(journal: WorkspaceRestoreJournal): RestoreGenerationIdentity {
  if (!journal.rootGeneration || !journal.stateGeneration) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.generation-incomplete",
      "runtime launch requires both immutable restore generations",
    );
  }
  return {
    journalId: journal.journalId,
    rootGenerationHash: hashWorkspaceRestoreReceipt(journal.rootGeneration),
    stateGenerationHash: hashWorkspaceRestoreReceipt(journal.stateGeneration),
  };
}

function assertNoCachedRestoreRuntime(journal: WorkspaceRestoreJournal): void {
  const attempt = journal.runtimeAttempt;
  if (!attempt) return;
  const generation = restoreGenerationIdentity(journal);
  const liveHandle = [...restoredDaemons.values()].find(
    (handle) =>
      handle.workspaceId === journal.destinationWorkspaceId &&
      handle.startNonce === attempt.nonce &&
      handle.restoreGeneration?.journalId === generation.journalId &&
      handle.restoreGeneration.rootGenerationHash === generation.rootGenerationHash &&
      handle.restoreGeneration.stateGenerationHash === generation.stateGenerationHash,
  );
  if (liveHandle) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.compaction-runtime-present",
      "matching restored runtime is still live after its descriptor disappeared",
    );
  }
}

function stableRestoreResult(journal: WorkspaceRestoreJournal): WorkspaceRestoreStableResult {
  const generation = restoreGenerationIdentity(journal);
  return {
    protocol:
      journal.operationKind === "fork"
        ? "tweakloop.workspace-fork-result/v1"
        : "tweakloop.workspace-restore-result/v1",
    receiptId: journal.receiptId,
    requestFingerprint: journal.requestFingerprint,
    operationKind: journal.operationKind,
    operationId: journal.operationId,
    sourceBundleId: journal.sourceBundleId,
    resultBundleId: journal.resultBundleId,
    workspaceId: journal.destinationWorkspaceId,
    projectId: journal.projectId,
    rootPath: journal.destinationRoot,
    sessionId: journal.sessionId,
    overlayDigest: hashWorkspaceRestoreReceipt(
      [...journal.overlay].sort((left, right) => left.path.localeCompare(right.path)),
    ),
    rootGenerationHash: generation.rootGenerationHash,
    stateGenerationHash: generation.stateGenerationHash,
    recordedAt: journal.createdAt,
  };
}

async function readRestoreSuffix(
  descriptor: RuntimeDescriptor,
  capturedSeq: number,
): Promise<
  readonly Readonly<{ seq: number; eventType: string; payload: Record<string, unknown> }>[]
> {
  const response = await fetch(
    `http://127.0.0.1:${descriptor.shellPort}/api/v1/events?after=${capturedSeq}`,
    {
      headers: { authorization: `Bearer ${descriptor.cliToken}` },
      signal: AbortSignal.timeout(RESTORE_HTTP_TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.session-suffix-unavailable",
      `session suffix query failed with HTTP ${response.status}`,
    );
  }
  const value = (await response.json()) as unknown;
  if (!Array.isArray(value)) {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.session-suffix-invalid",
      "session suffix response is not an event array",
    );
  }
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.seq) ||
      typeof entry.eventType !== "string"
    ) {
      throw new WorkspaceRestoreJournalError(
        "workspace-restore.session-suffix-invalid",
        "session suffix contains an invalid event envelope",
      );
    }
    return {
      seq: entry.seq as number,
      eventType: entry.eventType,
      payload: isRecord(entry.payload) ? entry.payload : {},
    };
  });
}

async function mintRestoreBootstrap(
  descriptor: RuntimeDescriptor,
  agentId: string,
  sessionId: string,
): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${descriptor.shellPort}/api/v1/bootstrap-tokens`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${descriptor.cliToken}`,
      "content-type": "application/json",
    },
    signal: AbortSignal.timeout(RESTORE_HTTP_TIMEOUT_MS),
    body: JSON.stringify({ agentId, sessionId }),
  });
  const body = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!response.ok || typeof body?.url !== "string") {
    throw new WorkspaceRestoreJournalError(
      "workspace-restore.bootstrap-failed",
      `restored bootstrap failed with HTTP ${response.status}`,
    );
  }
  return body.url;
}

function recordRestoreRecovery(
  store: WorkspaceRestoreJournalStore,
  journal: WorkspaceRestoreJournal,
  error: unknown,
): WorkspaceRestoreJournal {
  const recovery = {
    code:
      error instanceof WorkspaceRestoreJournalError
        ? error.code
        : "workspace-restore.generation-validation-failed",
    message: error instanceof Error ? error.message : "restore generation validation failed",
  };
  return journal.transition.endsWith("-intent")
    ? store.effect(journal, "recovery-required", { recovery })
    : store.observe(journal, "recovery-required", { recovery });
}

function restoreDaemonCacheKey(
  journal: WorkspaceRestoreJournal,
  attempt: WorkspaceRuntimeAttempt,
): string {
  const generation = restoreGenerationIdentity(journal);
  return [
    journal.bundleId,
    journal.journalId,
    attempt.nonce,
    generation.rootGenerationHash,
    generation.stateGenerationHash,
  ].join(":");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function withRestoreOperationLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = restoreOperationTails.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = previous.then(() => gate);
  restoreOperationTails.set(key, tail);
  await previous;
  try {
    return await task();
  } finally {
    release();
    if (restoreOperationTails.get(key) === tail) restoreOperationTails.delete(key);
  }
}
