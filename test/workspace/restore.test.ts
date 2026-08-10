import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { questionSnapshot, rebuildProjections, snapshot } from "../../src/daemon/projections.js";
import { createTransactor } from "../../src/daemon/transactor.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import { WORKSPACE_EXPORT_PROTOCOL } from "../../src/protocol/versions.js";
import {
  WORKSPACE_EXPORT_MANIFEST_PATH,
  WORKSPACE_EXPORT_OBJECT_PREFIX,
  type WorkspaceExportManifest,
} from "../../src/protocol/workspace-export.js";
import { objectPath as storedObjectPath } from "../../src/storage/object-store/index.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import {
  captureWorkspaceFiles,
  validateWorkspaceBundleEnvelope,
  WORKSPACE_FILES_CONFIG_PROTOCOL,
  writeWorkspaceBundleEnvelope,
} from "../../src/workspace/files.js";
import {
  createWorkspaceRestoreStore,
  validateWorkspaceRestoreManifest,
} from "../../src/workspace/restore.js";
import {
  claimRestoreOwnedDirectory,
  createWorkspaceRestoreJournalStore,
  deriveWorkspaceRestoreOperationId,
  hashWorkspaceOverlay,
  hashWorkspaceRestoreReceipt,
  publishRestoreOwnedDirectory,
  readWorkspaceRestoreCompletionMarker,
  validateWorkspaceRestoreCompletionMarker,
  type WorkspaceRestoreJournal,
  type WorkspaceRestoreStableResult,
  type WorkspaceRuntimeAttempt,
  workspaceRestoreCompletionMarker,
  writeWorkspaceRestoreCompletionMarker,
} from "../../src/workspace/restore-journal.js";
import {
  finalizeWorkspaceRestoreGeneration,
  stageWorkspaceRestoreMaterial,
  stageWorkspaceRestoreState,
  validatePublishedWorkspaceRestore,
} from "../../src/workspace/restore-prepare.js";
import {
  resolveWorkspaceActivation,
  runtimeAttemptDecision,
} from "../../src/workspace/restore-runtime.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tweakloop-restore-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sha(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function event(
  seq: number,
  eventType: string,
  streamType: string,
  streamId: string,
  streamVersion: number,
  payload: Record<string, unknown>,
  actor: Readonly<{ kind: "human" | "agent" | "system"; id: string }> = {
    kind: "system",
    id: "fixture",
  },
): EventEnvelope {
  return {
    seq,
    eventId: `evt_${seq}`,
    workspaceId: "ws_source",
    streamType,
    streamId,
    streamVersion,
    eventType,
    schemaVersion: 1,
    recordedAt: `2026-08-04T00:00:0${seq}.000Z`,
    actor,
    causationId: `cmd_${seq}`,
    correlationId: "corr_restore",
    payload: { type: eventType, ...payload },
  };
}

function fixture(): { manifest: WorkspaceExportManifest; bytes: Buffer; objectPath: string } {
  const bytes = Buffer.from("# Restored\n");
  const hash = sha(bytes);
  const objectPath = `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${hash}`;
  const events = [
    event(1, "workspace.opened", "workspace", "ws_source", 1, {
      workspaceId: "ws_source",
      projectId: "project_source",
      rootPath: "/source",
    }),
    event(2, "artifact.registered", "artifact", "artifact_1", 1, {
      artifactId: "artifact_1",
      name: "design.md",
      format: "markdown",
      sourcePath: "/source/design.md",
    }),
    event(3, "artifact.revision-published", "artifact", "artifact_1", 2, {
      artifactId: "artifact_1",
      revisionId: "revision_1",
      parentId: null,
      seq: 1,
      format: "markdown",
      entryPath: "design.md",
      entryHash: hash,
      files: [{ path: "design.md", hash, mediaType: "text/markdown" }],
      producer: { kind: "agent", id: "fixture" },
      sourcePath: "/source/design.md",
      sessionId: null,
    }),
  ];
  const manifest: WorkspaceExportManifest = {
    protocol: WORKSPACE_EXPORT_PROTOCOL,
    source: { workspaceId: "ws_source", projectId: "project_source", rootPath: "/source" },
    capturedSeq: 3,
    artifacts: [
      {
        artifactId: "artifact_1",
        format: "markdown",
        headRevisionId: "revision_1",
        headSeq: 1,
        entryHash: hash,
        exportedPath: "design.md",
      },
    ],
    revisions: [
      {
        revisionId: "revision_1",
        artifactId: "artifact_1",
        parentId: null,
        seq: 1,
        format: "markdown",
        entryPath: "design.md",
        entryHash: hash,
        objectPath,
        files: [
          {
            path: "design.md",
            hash,
            mediaType: "text/markdown",
            byteLength: bytes.byteLength,
            objectPath,
          },
        ],
      },
    ],
    attachments: [],
    events,
  };
  return { manifest, bytes, objectPath };
}

function deliveryFixture(): { manifest: WorkspaceExportManifest; bytes: Buffer } {
  const base = fixture();
  const deliveryEvents = [
    event(4, "chat.message", "chat", "workspace", 1, {
      messageId: "message_delivery",
      artifactId: null,
      author: "human:alex",
      text: "wake codex",
      context: null,
      mentions: [],
      references: [],
      attachments: [],
      sessionId: null,
      recipientAgentId: "codex",
      threadId: null,
      workId: null,
      intentId: null,
    }),
    event(5, "chat.delivery-offered", "chat-delivery", "message_delivery", 1, {
      messageId: "message_delivery",
      sessionId: "session_delivery",
      agentId: "codex",
      processNonce: "process_delivery",
      attemptId: "attempt_1",
      attemptNumber: 1,
      offeredAt: "2026-08-04T00:00:05.000Z",
    }),
    event(6, "chat.delivery-paused", "chat-delivery", "message_delivery", 2, {
      messageId: "message_delivery",
      attemptId: "attempt_1",
      pausedAt: "2026-08-04T00:00:06.000Z",
      reason: "retry-budget-exhausted",
    }),
    event(7, "chat.delivery-resumed", "chat-delivery", "message_delivery", 3, {
      messageId: "message_delivery",
      resumedAt: "2026-08-04T00:00:07.000Z",
    }),
    event(8, "chat.delivery-offered", "chat-delivery", "message_delivery", 4, {
      messageId: "message_delivery",
      sessionId: "session_delivery",
      agentId: "codex",
      processNonce: "process_delivery",
      attemptId: "attempt_2",
      attemptNumber: 1,
      offeredAt: "2026-08-04T00:00:08.000Z",
    }),
    event(9, "chat.delivery-acknowledged", "chat-delivery", "message_delivery", 5, {
      messageId: "message_delivery",
      sessionId: "session_delivery",
      agentId: "codex",
      processNonce: "process_delivery",
      attemptId: "attempt_2",
      attemptNumber: 1,
      acknowledgedAt: "2026-08-04T00:00:09.000Z",
    }),
  ];
  return {
    manifest: {
      ...base.manifest,
      capturedSeq: 9,
      events: [...base.manifest.events, ...deliveryEvents],
    },
    bytes: base.bytes,
  };
}

function progressFixture(): { manifest: WorkspaceExportManifest; bytes: Buffer } {
  const base = fixture();
  const progressEvents = [
    event(4, "work.created", "work", "work_progress", 1, {
      workId: "work_progress",
      artifactId: "artifact_1",
      baseRevisionId: "revision_1",
      intentIds: [],
      assigneeAgentId: "codex",
      sessionId: null,
    }),
    event(5, "work.claimed", "work", "work_progress", 2, {
      workId: "work_progress",
      claimId: "claim_progress",
      agentId: "codex",
    }),
    event(6, "work.progressed", "work", "work_progress", 3, {
      workId: "work_progress",
      claimId: "claim_progress",
      agentId: "codex",
      summary: "restored durable progress",
      revisionId: null,
      addressedIntentIds: [],
    }),
  ];
  return {
    manifest: {
      ...base.manifest,
      capturedSeq: 6,
      events: [...base.manifest.events, ...progressEvents],
    },
    bytes: base.bytes,
  };
}

const BUNDLE_A = `bundle_${"a".repeat(64)}`;
const BUNDLE_B = `bundle_${"b".repeat(64)}`;
const COLLABORATION_HASH = "c".repeat(64);

function boundRestoreFixture(workingBytes?: Buffer) {
  const source = fixture();
  const bundleRoot = join(root, "bound-bundle");
  mkdirSync(bundleRoot);
  const manifestPath = join(bundleRoot, WORKSPACE_EXPORT_MANIFEST_PATH);
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(source.manifest, null, 2)}\n`);
  const objectPath = join(bundleRoot, ...source.objectPath.split("/"));
  mkdirSync(dirname(objectPath), { recursive: true });
  writeFileSync(objectPath, source.bytes);
  writeFileSync(join(bundleRoot, "design.md"), source.bytes);
  if (workingBytes !== undefined) {
    const workingRoot = join(root, "bound-working-root");
    mkdirSync(workingRoot);
    writeFileSync(join(workingRoot, "design.md"), workingBytes);
    captureWorkspaceFiles({
      workspaceRoot: workingRoot,
      destination: join(bundleRoot, "workspace-files"),
      config: {
        protocol: WORKSPACE_FILES_CONFIG_PROTOCOL,
        includes: ["design.md"],
        excludes: [],
        notes: ["Bound modified-file restore fixture."],
      },
    });
  }
  writeWorkspaceBundleEnvelope({
    bundleRoot,
    includeWorkspaceFiles: workingBytes !== undefined,
    observedEndSeq: source.manifest.capturedSeq,
  });
  const validated = validateWorkspaceBundleEnvelope(bundleRoot);
  const upload = createWorkspaceRestoreStore(join(root, "bound-upload"));
  const plan = upload.begin({
    protocol: "tweakloop.workspace-restore-request/v2",
    bundleId: validated.envelope.bundleId,
    collaborationManifestHash: validated.envelope.collaboration.manifestHash,
    collaborationManifestBase64: readFileSync(manifestPath).toString("base64"),
  });
  upload.put(plan.bundleId, source.objectPath, source.bytes);
  return { bundleRoot, validated, completed: upload.complete(plan.bundleId), bytes: source.bytes };
}

function beginJournal(
  store: ReturnType<typeof createWorkspaceRestoreJournalStore>,
  options: Readonly<{
    bundleId?: string;
    destination?: string;
    operationId?: string;
  }> = {},
): WorkspaceRestoreJournal {
  const bundleId = options.bundleId ?? BUNDLE_A;
  const destination = options.destination ?? join(root, "restored");
  const operationId =
    options.operationId ??
    deriveWorkspaceRestoreOperationId({
      operationKind: "restore",
      bundleId,
      destinationRoot: destination,
    });
  return store.begin({
    operationKind: "restore",
    operationId,
    bundleId,
    restoreId: `restore_${"d".repeat(24)}`,
    collaborationManifestHash: COLLABORATION_HASH,
    agentId: "codex",
    destinationRoot: destination,
    destinationWorkspaceId: `workspace_${sha(Buffer.from(operationId)).slice(0, 24)}`,
    projectId: "project_source",
    finalState: join(root, `state-${sha(Buffer.from(operationId)).slice(0, 12)}`),
  });
}

function advanceToRootGeneration(
  store: ReturnType<typeof createWorkspaceRestoreJournalStore>,
  initial: WorkspaceRestoreJournal,
): WorkspaceRestoreJournal {
  let journal = store.intent(initial, "root-material-intent");
  const rootOwnership = claimRestoreOwnedDirectory(journal, "root");
  const rootMaterial = {
    protocol: "tweakloop.workspace-root-material/v1" as const,
    journalId: journal.journalId,
    operationId: journal.operationId,
    bundleId: journal.bundleId,
    rootOwnership,
    overlayDigest: hashWorkspaceOverlay([]),
    overlayCount: 0,
    rootInventoryHash: "5".repeat(64),
    objectInventoryHash: "4".repeat(64),
  };
  journal = store.effect(journal, "root-material-staged", {
    ownership: { root: rootOwnership },
    overlay: [],
    rootMaterial,
  });
  journal = store.intent(journal, "state-stage-intent");
  const stateOwnership = claimRestoreOwnedDirectory(journal, "state");
  const rootMaterialHash = hashWorkspaceRestoreReceipt(rootMaterial);
  const stateGeneration = {
    protocol: "tweakloop.workspace-restore-state/v2" as const,
    journalId: journal.journalId,
    operationId: journal.operationId,
    bundleId: journal.bundleId,
    requestFingerprint: journal.requestFingerprint,
    collaborationManifestHash: journal.collaborationManifestHash,
    workspaceId: journal.destinationWorkspaceId,
    sqliteSchemaVersion: 1,
    sqliteMigrationVersion: 1,
    sqliteSchemaDigest: "6".repeat(64),
    capturedSeq: 3,
    eventTipId: "evt_3",
    eventPrefixDigest: "1".repeat(64),
    semanticReceiptCount: 0,
    semanticReceiptDigest: "2".repeat(64),
    idempotencyReceiptCount: 0,
    idempotencyReceiptDigest: "3".repeat(64),
    objectInventoryHash: "4".repeat(64),
    overlayDigest: rootMaterial.overlayDigest,
    rootMaterialHash,
    stateOwnership,
  };
  journal = store.effect(journal, "state-staged", {
    ownership: { state: stateOwnership },
    stateGeneration,
  });
  journal = store.intent(journal, "root-generation-finalize-intent");
  const rootGeneration = {
    protocol: "tweakloop.workspace-root-generation/v1" as const,
    journalId: journal.journalId,
    operationId: journal.operationId,
    bundleId: journal.bundleId,
    destinationClaimKey: journal.destinationClaimKey,
    rootMaterialHash,
    stateGenerationHash: hashWorkspaceRestoreReceipt(stateGeneration),
    rootOwnership,
    stateOwnership,
  };
  return store.effect(journal, "root-generation-finalized", { rootGeneration });
}

function advanceToCommittedResult(
  store: ReturnType<typeof createWorkspaceRestoreJournalStore>,
  initial: WorkspaceRestoreJournal,
): WorkspaceRestoreJournal {
  let journal = advanceToRootGeneration(store, initial);
  journal = store.intent(journal, "state-commit-intent");
  journal = store.effect(journal, "state-committed");
  journal = store.intent(journal, "root-commit-intent");
  journal = store.effect(journal, "root-committed");
  const runtimeAttempt: WorkspaceRuntimeAttempt = {
    attempt: 1,
    nonce: "runtime-attempt-1",
    ownerPid: process.pid,
    ownerBootNonce: "boot-1",
    ownerProcessStartedAt: "2026-08-08T09:59:00.000Z",
    deadline: "2026-08-08T10:00:30.000Z",
    descriptorPath: join(root, "absent-runtime.json"),
    status: "intent",
  };
  journal = store.intent(journal, "runtime-attempt-intent", { runtimeAttempt });
  journal = store.effect(journal, "runtime-ready", {
    runtimeAttempt: { ...runtimeAttempt, status: "ready" },
  });
  journal = store.intent(journal, "session-start-intent");
  journal = store.effect(journal, "session-ready", { activation: "attach" });
  journal = store.intent(journal, "result-commit-intent");
  const stableResult: WorkspaceRestoreStableResult = {
    protocol: "tweakloop.workspace-restore-result/v1",
    receiptId: journal.receiptId,
    requestFingerprint: journal.requestFingerprint,
    operationKind: journal.operationKind,
    operationId: journal.operationId,
    sourceBundleId: journal.bundleId,
    resultBundleId: null,
    workspaceId: journal.destinationWorkspaceId,
    projectId: journal.projectId,
    rootPath: journal.destinationRoot,
    sessionId: journal.sessionId,
    overlayDigest: journal.rootMaterial?.overlayDigest ?? "0".repeat(64),
    rootGenerationHash: hashWorkspaceRestoreReceipt(journal.rootGeneration),
    stateGenerationHash: hashWorkspaceRestoreReceipt(journal.stateGeneration),
    recordedAt: "2026-08-08T10:00:00.000Z",
  };
  return store.effect(journal, "result-committed", { stableResult });
}

describe("saved workspace restore staging", () => {
  it("rejects exact collaboration bytes B asserted under bound envelope A before stage creation", () => {
    const source = fixture();
    const bundleRoot = join(root, "binding-a");
    mkdirSync(bundleRoot);
    const manifestPath = join(bundleRoot, WORKSPACE_EXPORT_MANIFEST_PATH);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(source.manifest, null, 2)}\n`);
    const objectPath = join(bundleRoot, ...source.objectPath.split("/"));
    mkdirSync(dirname(objectPath), { recursive: true });
    writeFileSync(objectPath, source.bytes);
    writeFileSync(join(bundleRoot, "design.md"), source.bytes);
    writeWorkspaceBundleEnvelope({
      bundleRoot,
      includeWorkspaceFiles: false,
      observedEndSeq: source.manifest.capturedSeq,
    });
    const validated = validateWorkspaceBundleEnvelope(bundleRoot);
    const manifestB = {
      ...source.manifest,
      events: source.manifest.events.map((event, index) =>
        index === 0
          ? { ...event, payload: { ...event.payload, message: "neighbor history" } }
          : event,
      ),
    };
    const uploadRoot = join(root, "crossed-upload");
    const upload = createWorkspaceRestoreStore(uploadRoot);
    expect(() =>
      upload.begin({
        protocol: "tweakloop.workspace-restore-request/v2",
        bundleId: validated.envelope.bundleId,
        collaborationManifestHash: validated.envelope.collaboration.manifestHash,
        collaborationManifestBase64: Buffer.from(
          `${JSON.stringify(manifestB, null, 2)}\n`,
          "utf8",
        ).toString("base64"),
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-restore.binding-mismatch" }));
    expect(readdirSync(uploadRoot)).toEqual([]);
  });

  it("validates, stages idempotently, survives registry restart, and completes exact bytes", () => {
    const { manifest, bytes, objectPath } = fixture();
    const first = createWorkspaceRestoreStore(root);
    const plan = first.begin(manifest);
    expect(plan.requiredPaths).toEqual([objectPath]);
    first.put(plan.restoreId, objectPath, bytes);
    first.put(plan.restoreId, objectPath, bytes);

    const restarted = createWorkspaceRestoreStore(root);
    const completed = restarted.complete(plan.restoreId);
    expect(completed.objectBytes.get(sha(bytes))).toEqual(bytes);
    expect(restarted.begin(manifest).restoreId).toBe(plan.restoreId);
  });

  it("rejects incomplete, corrupt, undeclared, and traversal-shaped uploads", () => {
    const { manifest, bytes, objectPath } = fixture();
    const store = createWorkspaceRestoreStore(root);
    const plan = store.begin(manifest);
    expect(() => store.complete(plan.restoreId)).toThrow(/has not been uploaded/);
    expect(() => store.put(plan.restoreId, objectPath, Buffer.from("corrupt"))).toThrow(
      /size does not match|hash does not match/,
    );
    expect(() => store.put(plan.restoreId, "undeclared", bytes)).toThrow(/not declared/);
    expect(() => store.put(plan.restoreId, "../escape", bytes)).toThrow(/safe portable path/);
  });

  it("rejects event gaps, unknown events, path escapes, and missing revision objects", () => {
    const { manifest } = fixture();
    expect(() => validateWorkspaceRestoreManifest({ ...manifest, capturedSeq: 4 })).toThrow(
      /event count/,
    );
    expect(() =>
      validateWorkspaceRestoreManifest({
        ...manifest,
        events: manifest.events.map((item, index) =>
          index === 2
            ? { ...item, eventType: "unknown.event", payload: { type: "unknown.event" } }
            : item,
        ),
      }),
    ).toThrow(/unsupported event type/);
    expect(() =>
      validateWorkspaceRestoreManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], exportedPath: "../escape.md" }],
      }),
    ).toThrow(/safe portable path/);
    expect(() =>
      validateWorkspaceRestoreManifest({
        ...manifest,
        revisions: [{ ...manifest.revisions[0], files: [] }],
      }),
    ).toThrow(/complete file inventory/);
  });

  it("accepts and rebuilds every delivery event emitted by the current writer", () => {
    const { manifest } = deliveryFixture();
    const plan = validateWorkspaceRestoreManifest(manifest);
    expect(plan.manifest.capturedSeq).toBe(9);

    const db = openDatabase(":memory:");
    const transactor = createTransactor({
      db,
      workspaceId: "ws_source",
      newEventId: () => "unused",
      now: () => "2026-08-04T00:00:10.000Z",
      onCommitted: () => {},
    });
    transactor.restoreHistory({
      events: manifest.events,
      blobs: manifest.revisions.flatMap((revision) =>
        revision.files.map((file) => ({
          hash: file.hash,
          byteLength: file.byteLength,
          mediaType: file.mediaType,
          createdAt: "2026-08-04T00:00:00.000Z",
        })),
      ),
    });
    const workspace = {
      workspaceId: "ws_source",
      projectId: "project_source",
      rootPath: "/source",
      protocolVersion: 1,
    } as const;
    const before = snapshot(db, workspace, "http://artifact").chat[0]?.delivery;
    expect(before).toMatchObject({
      status: "acknowledged",
      attemptId: "attempt_2",
      attemptNumber: 1,
      agentId: "codex",
    });
    rebuildProjections(db, "ws_source");
    expect(snapshot(db, workspace, "http://artifact").chat[0]?.delivery).toEqual(before);
    db.close();
  });

  it("restores and rebuilds authoritative progress sequence and time from event history", () => {
    const { manifest } = progressFixture();
    const plan = validateWorkspaceRestoreManifest(manifest);
    expect(plan.manifest.capturedSeq).toBe(6);

    const db = openDatabase(":memory:");
    const transactor = createTransactor({
      db,
      workspaceId: "ws_source",
      newEventId: () => "unused",
      now: () => "2026-08-04T00:00:10.000Z",
      onCommitted: () => {},
    });
    transactor.restoreHistory({ events: manifest.events, blobs: [] });
    const workspace = {
      workspaceId: "ws_source",
      projectId: "project_source",
      rootPath: "/source",
      protocolVersion: 1,
    } as const;
    const before = snapshot(db, workspace, "http://artifact").work[0]?.progress;
    expect(before).toEqual([
      {
        summary: "restored durable progress",
        revisionId: null,
        agentId: "codex",
        addressedIntentIds: [],
        seq: 6,
        recordedAt: "2026-08-04T00:00:06.000Z",
      },
    ]);
    rebuildProjections(db, "ws_source");
    expect(snapshot(db, workspace, "http://artifact").work[0]?.progress).toEqual(before);
    db.close();
  });

  it("accepts managed source-less artifact outputs but rejects metadata overwrite", () => {
    const { manifest } = fixture();
    expect(() =>
      validateWorkspaceRestoreManifest({
        ...manifest,
        artifacts: [
          {
            ...manifest.artifacts[0],
            exportedPath: ".tweakloop/artifacts/artifact_1/design.md",
          },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkspaceRestoreManifest({
        ...manifest,
        artifacts: [{ ...manifest.artifacts[0], exportedPath: ".tweakloop/project.json" }],
      }),
    ).toThrow(/managed artifact namespace/);
  });

  it("keeps stream version continuity when one stream id is used by different event types", () => {
    const { manifest } = fixture();
    const crossTypeEvent = event(4, "chat.message", "chat", "artifact_1", 3, {
      messageId: "message_1",
      artifactId: "artifact_1",
      author: "agent:fixture",
      text: "The artifact stream and its chat share one writer identity.",
    });
    const crossTypeManifest = {
      ...manifest,
      capturedSeq: 4,
      events: [...manifest.events, crossTypeEvent],
    };

    expect(() => validateWorkspaceRestoreManifest(crossTypeManifest)).not.toThrow();
    expect(() =>
      validateWorkspaceRestoreManifest({
        ...crossTypeManifest,
        events: [...manifest.events, { ...crossTypeEvent, streamVersion: 1 }],
      }),
    ).toThrow(/event 4 stream version must be 3/);
  });

  it("accepts a distinct resumed session and keeps global and exact snapshots identical after rebuild", () => {
    const manifest = choiceManifest({ resumeSession: true });
    const plan = validateWorkspaceRestoreManifest(manifest);
    expect(
      plan.manifest.events.find(
        (item) => item.eventType === "session.started" && item.payload.sessionId === "session_b",
      )?.payload,
    ).toMatchObject({
      agentId: "other",
      predecessorSessionId: "session_a",
    });
    const db = openDatabase(":memory:");
    const transactor = createTransactor({
      db,
      workspaceId: "ws_source",
      newEventId: () => "unused",
      now: () => "2026-08-04T00:00:10.000Z",
      onCommitted: () => {},
    });
    transactor.restoreHistory({
      events: plan.manifest.events,
      blobs: manifest.revisions.flatMap((revision) =>
        revision.files.map((file) => ({
          hash: file.hash,
          byteLength: file.byteLength,
          mediaType: file.mediaType,
          createdAt: "2026-08-04T00:00:00.000Z",
        })),
      ),
    });
    const workspace = {
      workspaceId: "ws_source",
      projectId: "project_source",
      rootPath: "/source",
      protocolVersion: 1,
    } as const;
    const global = snapshot(db, workspace, "http://artifact").chat.find(
      (message) => message.messageId === "question_restore",
    );
    expect(global).toMatchObject({
      questionState: {
        status: "answered",
        answerMessageId: "answer_restore",
        optionKey: "keep",
      },
    });
    expect(questionSnapshot(db, "question_restore")).toEqual(global);

    rebuildProjections(db, "ws_source");
    const rebuiltGlobal = snapshot(db, workspace, "http://artifact").chat.find(
      (message) => message.messageId === "question_restore",
    );
    expect(rebuiltGlobal).toEqual(global);
    expect(questionSnapshot(db, "question_restore")).toEqual(global);
    db.close();
  });

  it.each([
    {
      defect: "an agent-authored answer",
      code: "workspace-restore.answer-human-required",
      manifest: choiceManifest({ answerActor: { kind: "agent", id: "codex" } }),
    },
    {
      defect: "an answer event actor and payload author mismatch",
      code: "workspace-restore.chat-actor-author-mismatch",
      manifest: choiceManifest({ answerAuthor: "human:other" }),
    },
    {
      defect: "a session start actor/agent mismatch",
      code: "workspace-restore.session-actor-agent-mismatch",
      manifest: choiceManifest({ sessionAActor: { kind: "agent", id: "other" } }),
    },
    {
      defect: "a duplicate active session start that overwrites its owner",
      code: "workspace-restore.session-duplicate",
      manifest: choiceManifest({ duplicateSessionStart: "active" }),
    },
    {
      defect: "a duplicate ended session start that reactivates it under another owner",
      code: "workspace-restore.session-duplicate",
      manifest: choiceManifest({ duplicateSessionStart: "ended" }),
    },
    {
      defect: "a handoff actor/payload agent mismatch before a question",
      code: "workspace-restore.session-actor-agent-mismatch",
      manifest: choiceManifest({
        transitionBefore: "question",
        transitionActor: { kind: "agent", id: "other" },
      }),
    },
    {
      defect: "an end actor/payload agent mismatch before a question",
      code: "workspace-restore.session-actor-agent-mismatch",
      manifest: choiceManifest({
        transitionBefore: "question",
        transitionEventType: "session.ended",
        transitionActor: { kind: "agent", id: "other" },
      }),
    },
    {
      defect: "an end by an agent that does not own the session",
      code: "workspace-restore.session-owner-mismatch",
      manifest: choiceManifest({
        transitionBefore: "question",
        transitionEventType: "session.ended",
        transitionActor: { kind: "agent", id: "other" },
        transitionAgentId: "other",
      }),
    },
    {
      defect: "a handoff by an aligned actor and payload agent that does not own the session",
      code: "workspace-restore.session-owner-mismatch",
      manifest: choiceManifest({
        transitionBefore: "question",
        transitionActor: { kind: "agent", id: "other" },
        transitionAgentId: "other",
      }),
    },
    {
      defect: "a resumed owner without same-owner continuation or handoff authority",
      code: "workspace-restore.session-resume-not-authorized",
      manifest: choiceManifest({ unauthorizedResume: true }),
    },
    {
      defect: "an event actor and payload author mismatch",
      code: "workspace-restore.chat-actor-author-mismatch",
      manifest: choiceManifest({ questionAuthor: "agent:other" }),
    },
    {
      defect: "a human-authored question",
      code: "workspace-restore.question-agent-required",
      manifest: choiceManifest({ questionActor: { kind: "human", id: "alex" } }),
    },
    {
      defect: "a question/session owner mismatch",
      code: "workspace-restore.question-session-owner-mismatch",
      manifest: choiceManifest({ questionActor: { kind: "agent", id: "other" } }),
    },
    {
      defect: "a missing question session as of its event",
      code: "workspace-restore.question-session-unknown",
      manifest: choiceManifest({ questionSessionId: "session_missing" }),
    },
    {
      defect: "an inactive question session as of its event",
      code: "workspace-restore.question-session-inactive",
      manifest: choiceManifest({ transitionBefore: "question" }),
    },
    {
      defect: "an inactive answer session as of its event",
      code: "workspace-restore.answer-session-inactive",
      manifest: choiceManifest({ transitionBefore: "answer" }),
    },
    {
      defect: "a cross-session answer",
      code: "workspace-restore.answer-session-mismatch",
      manifest: choiceManifest({ answerSessionId: "session_b", includeSessionB: true }),
    },
    {
      defect: "an unknown selected option",
      code: "workspace-restore.answer-option-unknown",
      manifest: choiceManifest({ answerOptionKey: "unknown" }),
    },
    {
      defect: "an empty option key",
      code: "workspace-restore.question-option-key-required",
      manifest: choiceManifest({
        options: [
          { key: "", label: "Empty" },
          { key: "change", label: "Change" },
        ],
      }),
    },
    {
      defect: "an empty option label",
      code: "workspace-restore.question-option-label-required",
      manifest: choiceManifest({
        options: [
          { key: "keep", label: "" },
          { key: "change", label: "Change" },
        ],
      }),
    },
    {
      defect: "duplicate option keys",
      code: "workspace-restore.question-option-key-duplicate",
      manifest: choiceManifest({
        options: [
          { key: "same", label: "One" },
          { key: "same", label: "Two" },
        ],
      }),
    },
    {
      defect: "duplicate option labels",
      code: "workspace-restore.question-option-label-duplicate",
      manifest: choiceManifest({
        options: [
          { key: "one", label: "Same" },
          { key: "two", label: "Same" },
        ],
      }),
    },
    {
      defect: "too few options",
      code: "workspace-restore.question-option-count",
      manifest: choiceManifest({ options: [{ key: "only", label: "Only" }] }),
    },
    {
      defect: "too many options",
      code: "workspace-restore.question-option-count",
      manifest: choiceManifest({
        options: Array.from({ length: 9 }, (_, index) => ({
          key: `option-${index + 1}`,
          label: `Option ${index + 1}`,
        })),
      }),
    },
  ])("rejects $defect before staging mutation", ({ code, manifest }) => {
    const store = createWorkspaceRestoreStore(root);
    expect(readdirSync(root)).toEqual([]);
    try {
      store.begin(manifest);
    } catch (error) {
      expect(error).toMatchObject({ code });
      expect(readdirSync(root)).toEqual([]);
      return;
    }
    throw new Error(`expected restore validation to reject with ${code}`);
  });
});

describe("durable workspace restore journal", () => {
  it("binds bundle, operation, and destination independently before creating private paths", () => {
    const store = createWorkspaceRestoreJournalStore(join(root, "coordination"), {
      newNonce: () => "1".repeat(48),
    });
    try {
      const destination = join(root, "same-destination");
      const first = beginJournal(store, { bundleId: BUNDLE_A, destination });
      const firstOperation = first.operationId;

      expect(() =>
        beginJournal(store, {
          bundleId: BUNDLE_B,
          destination,
          operationId: firstOperation,
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace-restore.operation-conflict" }));
      expect(() => beginJournal(store, { bundleId: BUNDLE_B, destination })).toThrowError(
        expect.objectContaining({ code: "workspace-restore.destination-claim-conflict" }),
      );
      expect(first.bundleId).toBe(BUNDLE_A);
      expect(first.collaborationManifestHash).toBe(COLLABORATION_HASH);
      expect(existsSync(first.paths.stagedRoot)).toBe(false);
      expect(existsSync(destination)).toBe(false);
      expect(store.inventory()).toMatchObject({ active: 1, tombstones: 1 });
    } finally {
      store.close();
    }
  });

  it("accepts only operation-owned destination-prefix progress after root publication intent", () => {
    const destination = join(root, "published-parent", "workspace");
    const store = createWorkspaceRestoreJournalStore(join(root, "coordination-prefix-progress"), {
      newNonce: () => "a".repeat(48),
    });
    try {
      let journal = advanceToRootGeneration(store, beginJournal(store, { destination }));
      mkdirSync(dirname(destination), { recursive: true });
      expect(() => beginJournal(store, { destination })).toThrowError(
        expect.objectContaining({ code: "workspace-restore.destination-resolution-changed" }),
      );

      // Recreate the same operation in a fresh coordination store so its journal records
      // publication intent before the exact intermediate parent-create effect occurs.
      const ownedDestination = join(root, "owned-parent", "workspace");
      const owned = createWorkspaceRestoreJournalStore(join(root, "coordination-owned-progress"), {
        newNonce: () => "b".repeat(48),
      });
      try {
        journal = advanceToRootGeneration(
          owned,
          beginJournal(owned, { destination: ownedDestination }),
        );
        journal = owned.intent(journal, "state-commit-intent");
        journal = owned.effect(journal, "state-committed");
        journal = owned.intent(journal, "root-commit-intent");
        mkdirSync(dirname(ownedDestination), { recursive: true });

        const retried = beginJournal(owned, { destination: ownedDestination });
        expect(retried.journalId).toBe(journal.journalId);
        expect(retried.transition).toBe("root-commit-intent");
        expect(existsSync(ownedDestination)).toBe(false);
      } finally {
        owned.close();
      }
    } finally {
      store.close();
    }
  });

  it("rejects recorded-ancestor substitution even when the logical destination is unchanged", () => {
    const ancestor = join(root, "stable-ancestor");
    mkdirSync(ancestor);
    const destination = join(ancestor, "later", "workspace");
    const store = createWorkspaceRestoreJournalStore(join(root, "coordination-ancestor"), {
      newNonce: () => "c".repeat(48),
    });
    try {
      beginJournal(store, { destination });
      renameSync(ancestor, join(root, "former-ancestor"));
      mkdirSync(ancestor);

      expect(() => beginJournal(store, { destination })).toThrowError(
        expect.objectContaining({ code: "workspace-restore.destination-resolution-changed" }),
      );
    } finally {
      store.close();
    }
  });

  it("serializes parent and child destination claims in both acquisition orders", () => {
    const common = join(root, "claim-tree");
    mkdirSync(common);
    const parent = join(common, "team");
    const child = join(parent, "repo");
    const parentFirst = createWorkspaceRestoreJournalStore(join(root, "claims-parent-first"), {
      newNonce: () => "d".repeat(48),
    });
    try {
      const winner = beginJournal(parentFirst, { destination: parent });
      expect(beginJournal(parentFirst, { destination: parent })).toEqual(winner);
      expect(() => beginJournal(parentFirst, { destination: child })).toThrowError(
        expect.objectContaining({ code: "workspace-restore.destination-claim-conflict" }),
      );
    } finally {
      parentFirst.close();
    }

    const childFirst = createWorkspaceRestoreJournalStore(join(root, "claims-child-first"), {
      newNonce: () => "e".repeat(48),
    });
    try {
      beginJournal(childFirst, { destination: child });
      expect(() => beginJournal(childFirst, { destination: parent })).toThrowError(
        expect.objectContaining({ code: "workspace-restore.destination-claim-conflict" }),
      );
    } finally {
      childFirst.close();
    }
  });

  it("returns the same committed receipt after a lost response and rejects a stale successor", () => {
    const store = createWorkspaceRestoreJournalStore(join(root, "coordination"), {
      newNonce: () => "2".repeat(48),
      now: () => "2026-08-08T10:00:00.000Z",
    });
    try {
      const registered = beginJournal(store);
      const rootIntent = store.intent(registered, "root-material-intent");
      const rootOwnership = claimRestoreOwnedDirectory(rootIntent, "root");
      const rootMaterial = {
        protocol: "tweakloop.workspace-root-material/v1" as const,
        journalId: rootIntent.journalId,
        operationId: rootIntent.operationId,
        bundleId: rootIntent.bundleId,
        rootOwnership,
        overlayDigest: hashWorkspaceOverlay([]),
        overlayCount: 0,
        rootInventoryHash: "5".repeat(64),
        objectInventoryHash: "4".repeat(64),
      };
      let journal = store.effect(rootIntent, "root-material-staged", {
        ownership: { root: rootOwnership },
        overlay: [],
        rootMaterial,
      });
      expect(() => store.intent(registered, "root-material-intent")).toThrowError(
        expect.objectContaining({ code: "workspace-restore.journal-stale" }),
      );
      journal = store.intent(journal, "state-stage-intent");
      const stateOwnership = claimRestoreOwnedDirectory(journal, "state");
      const stateGeneration = {
        protocol: "tweakloop.workspace-restore-state/v2" as const,
        journalId: journal.journalId,
        operationId: journal.operationId,
        bundleId: journal.bundleId,
        requestFingerprint: journal.requestFingerprint,
        collaborationManifestHash: journal.collaborationManifestHash,
        workspaceId: journal.destinationWorkspaceId,
        sqliteSchemaVersion: 1,
        sqliteMigrationVersion: 1,
        sqliteSchemaDigest: "6".repeat(64),
        capturedSeq: 3,
        eventTipId: "evt_3",
        eventPrefixDigest: "1".repeat(64),
        semanticReceiptCount: 0,
        semanticReceiptDigest: "2".repeat(64),
        idempotencyReceiptCount: 0,
        idempotencyReceiptDigest: "3".repeat(64),
        objectInventoryHash: "4".repeat(64),
        overlayDigest: rootMaterial.overlayDigest,
        rootMaterialHash: hashWorkspaceRestoreReceipt(rootMaterial),
        stateOwnership,
      };
      journal = store.effect(journal, "state-staged", {
        ownership: { state: stateOwnership },
        stateGeneration,
      });
      journal = store.intent(journal, "root-generation-finalize-intent");
      const rootGeneration = {
        protocol: "tweakloop.workspace-root-generation/v1" as const,
        journalId: journal.journalId,
        operationId: journal.operationId,
        bundleId: journal.bundleId,
        destinationClaimKey: journal.destinationClaimKey,
        rootMaterialHash: stateGeneration.rootMaterialHash,
        stateGenerationHash: hashWorkspaceRestoreReceipt(stateGeneration),
        rootOwnership,
        stateOwnership,
      };
      journal = store.effect(journal, "root-generation-finalized", { rootGeneration });
      journal = store.intent(journal, "state-commit-intent");
      expect(journal.cleanupEligibility).toBe("disabled");
      expect(existsSync(journal.paths.stagedRoot)).toBe(true);
      journal = store.effect(journal, "state-committed");
      journal = store.intent(journal, "root-commit-intent");
      journal = store.effect(journal, "root-committed");
      const runtimeAttempt: WorkspaceRuntimeAttempt = {
        attempt: 1,
        nonce: "runtime-attempt-1",
        ownerPid: process.pid,
        ownerBootNonce: "boot-1",
        ownerProcessStartedAt: "2026-08-08T09:59:00.000Z",
        deadline: "2026-08-08T10:00:30.000Z",
        descriptorPath: join(root, "runtime.json"),
        status: "intent",
      };
      journal = store.intent(journal, "runtime-attempt-intent", { runtimeAttempt });
      journal = store.effect(journal, "runtime-ready", {
        runtimeAttempt: { ...runtimeAttempt, status: "ready" },
      });
      journal = store.intent(journal, "session-start-intent");
      journal = store.effect(journal, "session-ready", { activation: "attach" });
      journal = store.intent(journal, "result-commit-intent");
      const stableResult: WorkspaceRestoreStableResult = {
        protocol: "tweakloop.workspace-restore-result/v1",
        receiptId: journal.receiptId,
        requestFingerprint: journal.requestFingerprint,
        operationKind: journal.operationKind,
        operationId: journal.operationId,
        sourceBundleId: journal.bundleId,
        resultBundleId: null,
        workspaceId: journal.destinationWorkspaceId,
        projectId: journal.projectId,
        rootPath: journal.destinationRoot,
        sessionId: journal.sessionId,
        overlayDigest: rootMaterial.overlayDigest,
        rootGenerationHash: hashWorkspaceRestoreReceipt(rootGeneration),
        stateGenerationHash: hashWorkspaceRestoreReceipt(stateGeneration),
        recordedAt: "2026-08-08T10:00:00.000Z",
      };
      journal = store.effect(journal, "result-committed", { stableResult });

      const retried = beginJournal(store);
      expect(retried.transition).toBe("result-committed");
      expect(retried.stableResult).toEqual(stableResult);
      expect(JSON.stringify(retried.stableResult)).not.toContain("url");
      expect(store.inventory()).toMatchObject({ active: 0, completed: 1, reservedBytes: 0 });
    } finally {
      store.close();
    }
  });

  it("binds parsed markers to both bundle and generation and rejects a forged marker", () => {
    const store = createWorkspaceRestoreJournalStore(join(root, "coordination"), {
      newNonce: (() => {
        let value = 2;
        return () => `${value++}`.repeat(48).slice(0, 48);
      })(),
    });
    try {
      const first = advanceToRootGeneration(
        store,
        beginJournal(store, { bundleId: BUNDLE_A, destination: join(root, "destination-a") }),
      );
      const second = advanceToRootGeneration(
        store,
        beginJournal(store, { bundleId: BUNDLE_B, destination: join(root, "destination-b") }),
      );
      const firstMarker = workspaceRestoreCompletionMarker(first);
      const secondMarker = workspaceRestoreCompletionMarker(second);
      const firstResult = advanceToCommittedResult(
        store,
        beginJournal(store, { bundleId: BUNDLE_A, destination: join(root, "result-a") }),
      );
      const secondResult = advanceToCommittedResult(
        store,
        beginJournal(store, { bundleId: BUNDLE_B, destination: join(root, "result-b") }),
      );
      expect(first.journalId).not.toBe(second.journalId);
      expect(firstMarker.sourceBundleId).not.toBe(secondMarker.sourceBundleId);
      expect(firstMarker.receiptId).not.toBe(secondMarker.receiptId);
      expect(firstMarker.rootGenerationHash).not.toBe(secondMarker.rootGenerationHash);
      expect(firstResult.stableResult?.receiptId).not.toBe(secondResult.stableResult?.receiptId);
      expect(firstResult.stableResult?.sourceBundleId).toBe(BUNDLE_A);
      expect(secondResult.stableResult?.sourceBundleId).toBe(BUNDLE_B);

      writeWorkspaceRestoreCompletionMarker(first.paths.stagedRoot, firstMarker);
      expect(() =>
        validateWorkspaceRestoreCompletionMarker(
          readWorkspaceRestoreCompletionMarker(first.paths.stagedRoot),
          first,
        ),
      ).not.toThrow();
      writeWorkspaceRestoreCompletionMarker(first.paths.stagedRoot, {
        ...firstMarker,
        sourceBundleId: BUNDLE_B,
      });
      expect(() =>
        validateWorkspaceRestoreCompletionMarker(
          readWorkspaceRestoreCompletionMarker(first.paths.stagedRoot),
          first,
        ),
      ).toThrowError(expect.objectContaining({ code: "workspace-restore.marker-conflict" }));
    } finally {
      store.close();
    }
  });

  it("preserves a preexisting destination and rejects illegal phases and over-quota admission", () => {
    const destination = join(root, "preexisting");
    mkdirSync(destination);
    const sentinel = join(destination, "keep.txt");
    writeFileSync(sentinel, "owned by user\n");
    const store = createWorkspaceRestoreJournalStore(join(root, "coordination"), {
      newNonce: () => "6".repeat(48),
    });
    try {
      expect(() => beginJournal(store, { destination })).toThrowError(
        expect.objectContaining({ code: "workspace-restore.destination-claim-conflict" }),
      );
      expect(readFileSync(sentinel, "utf8")).toBe("owned by user\n");
      expect(readdirSync(destination)).toEqual(["keep.txt"]);
    } finally {
      store.close();
    }

    const constrained = createWorkspaceRestoreJournalStore(join(root, "small-coordination"), {
      quotaBytes: 1_024,
      newNonce: () => "7".repeat(48),
    });
    try {
      expect(() =>
        beginJournal(constrained, { destination: join(root, "quota-target") }),
      ).toThrowError(expect.objectContaining({ code: "workspace-restore.capacity-exceeded" }));
      expect(constrained.inventory()).toMatchObject({ usedBytes: 0, reservedBytes: 0, active: 0 });
      expect(existsSync(join(root, "quota-target"))).toBe(false);
    } finally {
      constrained.close();
    }

    const transitions = createWorkspaceRestoreJournalStore(join(root, "transition-coordination"), {
      newNonce: () => "8".repeat(48),
    });
    try {
      const journal = beginJournal(transitions, { destination: join(root, "phase-target") });
      expect(() => transitions.intent(journal, "state-stage-intent")).toThrowError(
        expect.objectContaining({ code: "workspace-restore.transition-invalid" }),
      );
      expect(transitions.load(journal.journalId)).toEqual(journal);
      expect(transitions.inventory().reservedBytes).toBe(0);
    } finally {
      transitions.close();
    }
  });

  it("replays a bound modified-file material stage and preserves durable history", () => {
    const workingBytes = Buffer.from("# Unpublished working file\n");
    const source = boundRestoreFixture(workingBytes);
    const store = createWorkspaceRestoreJournalStore(join(root, "modified-replay-coordination"), {
      newNonce: () => "7".repeat(48),
    });
    try {
      const destinationRoot = join(root, "modified-replay-workspace");
      const operationId = deriveWorkspaceRestoreOperationId({
        operationKind: "restore",
        bundleId: source.validated.envelope.bundleId,
        destinationRoot,
      });
      let journal = store.begin({
        operationKind: "restore",
        operationId,
        bundleId: source.validated.envelope.bundleId,
        restoreId: source.completed.plan.restoreId,
        collaborationManifestHash: source.validated.envelope.collaboration.manifestHash,
        agentId: "codex",
        destinationRoot,
        destinationWorkspaceId: `workspace_${sha(Buffer.from(operationId)).slice(0, 24)}`,
        projectId: source.completed.plan.manifest.source.projectId,
        finalState: join(root, "modified-replay-state"),
      });
      journal = store.intent(journal, "root-material-intent");

      expect(() =>
        stageWorkspaceRestoreMaterial({
          journal,
          completed: source.completed,
          bundleRoot: source.bundleRoot,
          failureInjection: (point) => {
            if (point === "after-overlay-stage") throw new Error("injected:after-overlay-stage");
          },
        }),
      ).toThrow("injected:after-overlay-stage");
      expect(readFileSync(join(journal.paths.stagedRoot, "design.md"))).toEqual(workingBytes);

      store.resume(journal);
      const material = stageWorkspaceRestoreMaterial({
        journal,
        completed: source.completed,
        bundleRoot: source.bundleRoot,
      });
      expect(material.overlay).toEqual([
        expect.objectContaining({
          path: "design.md",
          state: "modified",
          baseHash: sha(source.bytes),
          workingHash: sha(workingBytes),
        }),
      ]);
      expect(readFileSync(join(journal.paths.stagedRoot, "design.md"))).toEqual(workingBytes);
      const exactReplay = stageWorkspaceRestoreMaterial({
        journal,
        completed: source.completed,
        bundleRoot: source.bundleRoot,
      });
      expect(exactReplay.rootMaterial).toEqual(material.rootMaterial);
      expect(exactReplay.overlay).toEqual(material.overlay);

      journal = store.effect(journal, "root-material-staged", {
        ownership: { root: material.rootOwnership, state: material.stateOwnership },
        overlay: material.overlay,
        rootMaterial: material.rootMaterial,
      });
      journal = store.intent(journal, "state-stage-intent");
      const state = stageWorkspaceRestoreState({ journal, completed: source.completed });
      expect(state.stateGeneration.overlayDigest).toBe(material.rootMaterial.overlayDigest);
      expect(readFileSync(join(journal.paths.stagedRoot, "design.md"))).toEqual(workingBytes);
      expect(
        readFileSync(
          storedObjectPath(join(journal.paths.stagedState, "objects"), sha(source.bytes)),
        ),
      ).toEqual(source.bytes);
      const db = new Database(join(journal.paths.stagedState, "events.sqlite"), {
        readonly: true,
      });
      try {
        expect(
          db.prepare("SELECT entry_hash FROM p_revisions WHERE revision_id = ?").get("revision_1"),
        ).toEqual({ entry_hash: sha(source.bytes) });
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  });

  it("rejects a third hash while re-entering a bound modified-file material stage", () => {
    const workingBytes = Buffer.from("# Bound working file\n");
    const source = boundRestoreFixture(workingBytes);
    const store = createWorkspaceRestoreJournalStore(join(root, "modified-third-coordination"), {
      newNonce: () => "8".repeat(48),
    });
    try {
      const destinationRoot = join(root, "modified-third-workspace");
      const operationId = deriveWorkspaceRestoreOperationId({
        operationKind: "restore",
        bundleId: source.validated.envelope.bundleId,
        destinationRoot,
      });
      const journal = store.intent(
        store.begin({
          operationKind: "restore",
          operationId,
          bundleId: source.validated.envelope.bundleId,
          restoreId: source.completed.plan.restoreId,
          collaborationManifestHash: source.validated.envelope.collaboration.manifestHash,
          agentId: "codex",
          destinationRoot,
          destinationWorkspaceId: `workspace_${sha(Buffer.from(operationId)).slice(0, 24)}`,
          projectId: source.completed.plan.manifest.source.projectId,
          finalState: join(root, "modified-third-state"),
        }),
        "root-material-intent",
      );
      stageWorkspaceRestoreMaterial({
        journal,
        completed: source.completed,
        bundleRoot: source.bundleRoot,
      });
      const thirdBytes = Buffer.from("# Neither durable nor bound working\n");
      writeFileSync(join(journal.paths.stagedRoot, "design.md"), thirdBytes);

      expect(() =>
        stageWorkspaceRestoreMaterial({
          journal,
          completed: source.completed,
          bundleRoot: source.bundleRoot,
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace-restore.install-conflict" }));
      expect(readFileSync(join(journal.paths.stagedRoot, "design.md"))).toEqual(thirdBytes);
    } finally {
      store.close();
    }
  });

  it("prepares DB, CAS, semantic receipts, and combined root offline before two publications", () => {
    const source = boundRestoreFixture();
    const store = createWorkspaceRestoreJournalStore(join(root, "prepared-coordination"), {
      newNonce: () => "c".repeat(48),
    });
    try {
      const destinationRoot = join(root, "prepared-workspace");
      const operationId = deriveWorkspaceRestoreOperationId({
        operationKind: "restore",
        bundleId: source.validated.envelope.bundleId,
        destinationRoot,
      });
      let journal = store.begin({
        operationKind: "restore",
        operationId,
        bundleId: source.validated.envelope.bundleId,
        restoreId: source.completed.plan.restoreId,
        collaborationManifestHash: source.validated.envelope.collaboration.manifestHash,
        agentId: "codex",
        destinationRoot,
        destinationWorkspaceId: `workspace_${sha(Buffer.from(operationId)).slice(0, 24)}`,
        projectId: source.completed.plan.manifest.source.projectId,
        finalState: join(root, "prepared-state"),
      });
      const observed: string[] = [];
      journal = store.intent(journal, "root-material-intent");
      const material = stageWorkspaceRestoreMaterial({
        journal,
        completed: source.completed,
        bundleRoot: source.bundleRoot,
        failureInjection: (point) => observed.push(point),
      });
      expect(existsSync(destinationRoot)).toBe(false);
      expect(existsSync(journal.paths.finalState)).toBe(false);
      journal = store.effect(journal, "root-material-staged", {
        ownership: { root: material.rootOwnership, state: material.stateOwnership },
        overlay: material.overlay,
        rootMaterial: material.rootMaterial,
      });
      journal = store.intent(journal, "state-stage-intent");
      const state = stageWorkspaceRestoreState({
        journal,
        completed: source.completed,
        failureInjection: (point) => observed.push(point),
      });
      journal = store.effect(journal, "state-staged", {
        stateGeneration: state.stateGeneration,
      });
      journal = store.intent(journal, "root-generation-finalize-intent");
      const generation = finalizeWorkspaceRestoreGeneration({
        journal,
        failureInjection: (point) => observed.push(point),
      });
      journal = store.effect(journal, "root-generation-finalized", {
        rootGeneration: generation.rootGeneration,
      });
      expect(observed).toEqual([
        "after-root-install",
        "after-overlay-stage",
        "after-history-commit",
        "after-semantic-receipts",
        "after-db-checkpoint",
        "after-state-receipt",
        "after-root-marker",
      ]);
      expect(existsSync(destinationRoot)).toBe(false);
      expect(existsSync(journal.paths.finalState)).toBe(false);

      journal = store.intent(journal, "state-commit-intent");
      publishRestoreOwnedDirectory(journal, "state");
      journal = store.effect(journal, "state-committed");
      expect(existsSync(journal.paths.finalState)).toBe(true);
      expect(existsSync(destinationRoot)).toBe(false);
      journal = store.intent(journal, "root-commit-intent");
      publishRestoreOwnedDirectory(journal, "root");
      journal = store.effect(journal, "root-committed");
      expect(() =>
        validatePublishedWorkspaceRestore({ journal, completed: source.completed }),
      ).not.toThrow();

      writeFileSync(join(destinationRoot, "design.md"), "forged root\n");
      expect(() =>
        validatePublishedWorkspaceRestore({ journal, completed: source.completed }),
      ).toThrowError(
        expect.objectContaining({ code: "workspace-restore.root-generation-mismatch" }),
      );
      writeFileSync(join(destinationRoot, "design.md"), source.bytes);
      const descriptor = source.completed.plan.objects[0];
      if (!descriptor) throw new Error("fixture object is missing");
      const casPath = storedObjectPath(join(journal.paths.finalState, "objects"), descriptor.hash);
      writeFileSync(casPath, "forged cas\n");
      expect(() =>
        validatePublishedWorkspaceRestore({ journal, completed: source.completed }),
      ).toThrowError(
        expect.objectContaining({ code: "workspace-restore.object-generation-mismatch" }),
      );
      writeFileSync(casPath, source.completed.objectBytes.get(descriptor.hash) as Buffer);
      const db = new Database(join(journal.paths.finalState, "events.sqlite"));
      db.prepare("UPDATE events SET payload_json = ? WHERE seq = 2").run('{"type":"forged"}');
      db.close();
      expect(() =>
        validatePublishedWorkspaceRestore({ journal, completed: source.completed }),
      ).toThrowError(
        expect.objectContaining({ code: "workspace-restore.database-prefix-conflict" }),
      );
    } finally {
      store.close();
    }
  });

  it.each([
    "after-root-install",
    "after-overlay-stage",
    "after-history-commit",
    "after-semantic-receipts",
    "after-db-checkpoint",
    "after-state-receipt",
    "after-root-marker",
  ] as const)("resumes the exact private generation after interruption at %s", (failurePoint) => {
    const source = boundRestoreFixture();
    const store = createWorkspaceRestoreJournalStore(join(root, `interrupt-${failurePoint}`), {
      newNonce: () => "d".repeat(48),
    });
    try {
      const destinationRoot = join(root, `interrupted-workspace-${failurePoint}`);
      const operationId = deriveWorkspaceRestoreOperationId({
        operationKind: "restore",
        bundleId: source.validated.envelope.bundleId,
        destinationRoot,
      });
      let journal = store.begin({
        operationKind: "restore",
        operationId,
        bundleId: source.validated.envelope.bundleId,
        restoreId: source.completed.plan.restoreId,
        collaborationManifestHash: source.validated.envelope.collaboration.manifestHash,
        agentId: "codex",
        destinationRoot,
        destinationWorkspaceId: `workspace_${sha(Buffer.from(operationId)).slice(0, 24)}`,
        projectId: source.completed.plan.manifest.source.projectId,
        finalState: join(root, `interrupted-state-${failurePoint}`),
      });
      const inject = (point: string) => {
        if (point === failurePoint) throw new Error(`injected:${point}`);
      };

      journal = store.intent(journal, "root-material-intent");
      if (failurePoint === "after-root-install" || failurePoint === "after-overlay-stage") {
        expect(() =>
          stageWorkspaceRestoreMaterial({
            journal,
            completed: source.completed,
            bundleRoot: source.bundleRoot,
            failureInjection: inject,
          }),
        ).toThrow(`injected:${failurePoint}`);
        store.resume(journal);
      }
      const material = stageWorkspaceRestoreMaterial({
        journal,
        completed: source.completed,
        bundleRoot: source.bundleRoot,
      });
      journal = store.effect(journal, "root-material-staged", {
        ownership: { root: material.rootOwnership, state: material.stateOwnership },
        overlay: material.overlay,
        rootMaterial: material.rootMaterial,
      });

      journal = store.intent(journal, "state-stage-intent");
      if (
        failurePoint === "after-history-commit" ||
        failurePoint === "after-semantic-receipts" ||
        failurePoint === "after-db-checkpoint" ||
        failurePoint === "after-state-receipt"
      ) {
        expect(() =>
          stageWorkspaceRestoreState({
            journal,
            completed: source.completed,
            failureInjection: inject,
          }),
        ).toThrow(`injected:${failurePoint}`);
        store.resume(journal);
      }
      const state = stageWorkspaceRestoreState({ journal, completed: source.completed });
      journal = store.effect(journal, "state-staged", {
        stateGeneration: state.stateGeneration,
      });

      journal = store.intent(journal, "root-generation-finalize-intent");
      if (failurePoint === "after-root-marker") {
        expect(() =>
          finalizeWorkspaceRestoreGeneration({ journal, failureInjection: inject }),
        ).toThrow(`injected:${failurePoint}`);
        store.resume(journal);
      }
      const generation = finalizeWorkspaceRestoreGeneration({ journal });
      journal = store.effect(journal, "root-generation-finalized", {
        rootGeneration: generation.rootGeneration,
      });
      expect(existsSync(destinationRoot)).toBe(false);
      expect(existsSync(journal.paths.finalState)).toBe(false);

      journal = store.intent(journal, "state-commit-intent");
      publishRestoreOwnedDirectory(journal, "state");
      journal = store.effect(journal, "state-committed");
      journal = store.intent(journal, "root-commit-intent");
      publishRestoreOwnedDirectory(journal, "root");
      journal = store.effect(journal, "root-committed");
      expect(() =>
        validatePublishedWorkspaceRestore({ journal, completed: source.completed }),
      ).not.toThrow();
      expect(store.inventory().reservedBytes).toBe(0);
    } finally {
      store.close();
    }
  });

  it("elects one stale-intent adopter by epoch and consumes the recovery reservation", () => {
    const coordination = join(root, "epoch-coordination");
    const first = createWorkspaceRestoreJournalStore(coordination, {
      newNonce: () => "9".repeat(48),
      coordinatorOwner: {
        pid: 101_001,
        bootNonce: "boot-first",
        processStartedAt: "2026-08-08T09:00:00.000Z",
      },
      isProcessAlive: () => false,
    });
    const registered = beginJournal(first, { destination: join(root, "epoch-target") });
    const interrupted = first.intent(registered, "root-material-intent", {}, 32_768);
    const firstLease = first
      .inventoryEntries()
      .find((entry) => entry.operationId === interrupted.operationId);
    expect(firstLease).toMatchObject({ lockEpoch: 1, ownerPid: 101_001 });
    expect(firstLease?.reservedBytes).toBe(32_768);
    expect(first.inventory().reservedBytes).toBe(32_768);
    first.close();

    const winner = createWorkspaceRestoreJournalStore(coordination, {
      coordinatorOwner: {
        pid: 202_002,
        bootNonce: "boot-winner",
        processStartedAt: "2026-08-08T10:00:00.000Z",
      },
      isProcessAlive: () => false,
    });
    const adopted = winner.resume(winner.load(interrupted.journalId));
    expect(
      winner.inventoryEntries().find((entry) => entry.operationId === adopted.operationId),
    ).toMatchObject({
      lockEpoch: 2,
      ownerPid: 202_002,
      reservedBytes: 32_768,
    });

    const loser = createWorkspaceRestoreJournalStore(coordination, {
      coordinatorOwner: {
        pid: 303_003,
        bootNonce: "boot-loser",
        processStartedAt: "2026-08-08T10:00:01.000Z",
      },
      isProcessAlive: (pid) => pid === 202_002,
    });
    expect(() => loser.resume(loser.load(interrupted.journalId))).toThrowError(
      expect.objectContaining({ code: "workspace-restore.operation-in-progress" }),
    );
    const recovered = winner.effect(adopted, "recovery-required", {
      recovery: {
        code: "workspace-restore.injected-boundary",
        message: "test adopts and closes an interrupted effect",
      },
    });
    expect(recovered.transition).toBe("recovery-required");
    expect(
      winner.inventoryEntries().find((entry) => entry.operationId === recovered.operationId),
    ).toMatchObject({ reservedBytes: 0, status: "recovery" });
    expect(winner.inventory().reservedBytes).toBe(0);
    expect(() =>
      loser.effect(adopted, "recovery-required", {
        recovery: { code: "loser", message: "must not create a sibling head" },
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-restore.journal-stale" }));
    loser.close();
    winner.close();
  });

  it("rejects broken material parent links while retaining the admitted effect reservation", () => {
    const store = createWorkspaceRestoreJournalStore(join(root, "material-coordination"), {
      newNonce: () => "a".repeat(48),
    });
    try {
      let journal = beginJournal(store, { destination: join(root, "material-target") });
      journal = store.intent(journal, "root-material-intent", {}, 65_536);
      const rootOwnership = claimRestoreOwnedDirectory(journal, "root");
      const correctRootMaterial = {
        protocol: "tweakloop.workspace-root-material/v1" as const,
        journalId: journal.journalId,
        operationId: journal.operationId,
        bundleId: journal.bundleId,
        rootOwnership,
        overlayDigest: hashWorkspaceOverlay([]),
        overlayCount: 0,
        rootInventoryHash: "5".repeat(64),
        objectInventoryHash: "4".repeat(64),
      };
      expect(() =>
        store.effect(journal, "root-material-staged", {
          ownership: { root: rootOwnership },
          rootMaterial: { ...correctRootMaterial, bundleId: BUNDLE_B },
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace-restore.receipt-chain-invalid" }));
      expect(
        store.inventoryEntries().find((entry) => entry.operationId === journal.operationId),
      ).toMatchObject({ reservedBytes: 65_536 });
      journal = store.effect(journal, "root-material-staged", {
        ownership: { root: rootOwnership },
        rootMaterial: correctRootMaterial,
      });
      journal = store.intent(journal, "state-stage-intent", {}, 65_536);
      const stateOwnership = claimRestoreOwnedDirectory(journal, "state");
      const correctState = {
        protocol: "tweakloop.workspace-restore-state/v2" as const,
        journalId: journal.journalId,
        operationId: journal.operationId,
        bundleId: journal.bundleId,
        requestFingerprint: journal.requestFingerprint,
        collaborationManifestHash: journal.collaborationManifestHash,
        workspaceId: journal.destinationWorkspaceId,
        sqliteSchemaVersion: 1,
        sqliteMigrationVersion: 1,
        sqliteSchemaDigest: "6".repeat(64),
        capturedSeq: 3,
        eventTipId: "evt_3",
        eventPrefixDigest: "1".repeat(64),
        semanticReceiptCount: 0,
        semanticReceiptDigest: "2".repeat(64),
        idempotencyReceiptCount: 0,
        idempotencyReceiptDigest: "3".repeat(64),
        objectInventoryHash: "4".repeat(64),
        overlayDigest: correctRootMaterial.overlayDigest,
        rootMaterialHash: hashWorkspaceRestoreReceipt(correctRootMaterial),
        stateOwnership,
      };
      expect(() =>
        store.effect(journal, "state-staged", {
          ownership: { state: stateOwnership },
          stateGeneration: { ...correctState, rootMaterialHash: "f".repeat(64) },
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace-restore.receipt-chain-invalid" }));
      journal = store.effect(journal, "state-staged", {
        ownership: { state: stateOwnership },
        stateGeneration: correctState,
      });
      journal = store.intent(journal, "root-generation-finalize-intent", {}, 65_536);
      const correctRootGeneration = {
        protocol: "tweakloop.workspace-root-generation/v1" as const,
        journalId: journal.journalId,
        operationId: journal.operationId,
        bundleId: journal.bundleId,
        destinationClaimKey: journal.destinationClaimKey,
        rootMaterialHash: hashWorkspaceRestoreReceipt(correctRootMaterial),
        stateGenerationHash: hashWorkspaceRestoreReceipt(correctState),
        rootOwnership,
        stateOwnership,
      };
      expect(() =>
        store.effect(journal, "root-generation-finalized", {
          rootGeneration: {
            ...correctRootGeneration,
            stateGenerationHash: "e".repeat(64),
          },
        }),
      ).toThrowError(expect.objectContaining({ code: "workspace-restore.receipt-chain-invalid" }));
      journal = store.effect(journal, "root-generation-finalized", {
        rootGeneration: correctRootGeneration,
      });
      expect(journal.rootGeneration).toEqual(correctRootGeneration);
      expect(store.inventory().reservedBytes).toBe(0);
    } finally {
      store.close();
    }
  });

  it("compacts a completed operation after root absence and retains a proof-bound tombstone", () => {
    const store = createWorkspaceRestoreJournalStore(join(root, "compaction-coordination"), {
      newNonce: () => "b".repeat(48),
      now: () => "2026-08-08T11:00:00.000Z",
    });
    try {
      const completed = advanceToCommittedResult(
        store,
        beginJournal(store, { destination: join(root, "released-target") }),
      );
      const before = store.inventory().usedBytes;
      const proof = store.createCompactionProof(completed);
      expect(proof.stateObservation.status).toBe("absent");
      expect(proof.destinationObservation.status).toBe("absent");
      expect(() => store.compact({ ...proof, receiptChainDigest: "0".repeat(64) })).toThrowError(
        expect.objectContaining({ code: "workspace-restore.compaction-proof-stale" }),
      );
      expect(store.load(completed.journalId).stableResult).toEqual(completed.stableResult);

      const tombstone = store.compact(proof);
      expect(tombstone).toMatchObject({
        id: completed.operationId,
        fingerprint: completed.requestFingerprint,
        resultDigest: hashWorkspaceRestoreReceipt(completed.stableResult),
      });
      expect(store.inventory().usedBytes).toBeLessThan(before);
      expect(store.inventory()).toMatchObject({ tombstones: 1, reservedBytes: 0 });
      expect(() => beginJournal(store, { destination: completed.destinationRoot })).toThrowError(
        expect.objectContaining({
          code: "workspace-restore.operation-compacted",
          details: { tombstone },
        }),
      );
    } finally {
      store.close();
    }
  });

  it("fails closed on an unknown coordination protocol version", () => {
    const coordination = join(root, "unknown-version");
    mkdirSync(coordination);
    const databasePath = join(coordination, "restore-coordination.sqlite");
    const database = new Database(databasePath);
    database.exec(`
      CREATE TABLE restore_meta (
        singleton INTEGER PRIMARY KEY,
        protocol_version INTEGER NOT NULL,
        quota_bytes INTEGER NOT NULL,
        active_limit INTEGER NOT NULL,
        used_bytes INTEGER NOT NULL,
        reserved_bytes INTEGER NOT NULL
      ) STRICT;
      INSERT INTO restore_meta VALUES (1, 99, 1000000, 10, 0, 0);
    `);
    database.close();
    expect(() => createWorkspaceRestoreJournalStore(coordination)).toThrowError(
      expect.objectContaining({ code: "workspace-restore.migration-required" }),
    );
  });

  it.each([
    ["ready", "2026-08-08T10:00:00.000Z", "ready"],
    ["alien", "2026-08-08T10:00:00.000Z", "conflict"],
    ["absent", "2026-08-08T10:00:00.000Z", "failed"],
    ["dead", "2026-08-08T10:00:00.000Z", "failed"],
    ["live-no-ready", "2026-08-08T10:00:00.000Z", "pending"],
    ["live-no-ready", "2026-08-08T10:00:30.000Z", "stuck"],
  ] as const)("makes runtime observation %s total", (observed, now, expected) => {
    const attempt: WorkspaceRuntimeAttempt = {
      attempt: 1,
      nonce: "attempt-1",
      ownerPid: 100,
      ownerBootNonce: "boot-1",
      ownerProcessStartedAt: "2026-08-08T09:59:00.000Z",
      deadline: "2026-08-08T10:00:30.000Z",
      descriptorPath: "/runtime.json",
      status: "intent",
    };
    expect(runtimeAttemptDecision({ attempt, observed, now })).toBe(expected);
  });

  it("folds ordered runtime lineage without restarting ended or alien sessions", () => {
    const linked = [
      { seq: 1, eventType: "session.ended", payload: { sessionId: "session-a" } },
      {
        seq: 2,
        eventType: "session.started",
        payload: { sessionId: "session-b", predecessorSessionId: "session-a" },
      },
    ];
    expect(resolveWorkspaceActivation(linked, "session-a")).toEqual({
      activation: "successor-active",
      locatorSessionId: "session-b",
    });
    expect(
      resolveWorkspaceActivation(
        [
          { seq: 1, eventType: "session.handoff-offered", payload: { sessionId: "session-a" } },
          { seq: 2, eventType: "session.handoff-offered", payload: { sessionId: "session-a" } },
          { seq: 3, eventType: "session.ended", payload: { sessionId: "session-a" } },
          {
            seq: 4,
            eventType: "session.started",
            payload: { sessionId: "session-b", predecessorSessionId: "session-a" },
          },
          { seq: 5, eventType: "session.ended", payload: { sessionId: "session-b" } },
          { seq: 6, eventType: "session.ended", payload: { sessionId: "session-b" } },
        ],
        "session-a",
      ),
    ).toEqual({ activation: "session-ended", locatorSessionId: null });
    expect(
      resolveWorkspaceActivation(
        [{ seq: 1, eventType: "session.ended", payload: { sessionId: "session-a" } }],
        "session-a",
      ),
    ).toEqual({ activation: "session-ended", locatorSessionId: null });
    expect(
      resolveWorkspaceActivation(
        [
          {
            seq: 1,
            eventType: "session.started",
            payload: { sessionId: "session-b", predecessorSessionId: "session-a" },
          },
        ],
        "session-a",
      ),
    ).toEqual({ activation: "recovery", locatorSessionId: null });
    expect(
      resolveWorkspaceActivation(
        [
          { seq: 1, eventType: "session.ended", payload: { sessionId: "session-a" } },
          {
            seq: 2,
            eventType: "session.started",
            payload: { sessionId: "session-a", predecessorSessionId: "session-a" },
          },
        ],
        "session-a",
      ),
    ).toEqual({ activation: "recovery", locatorSessionId: null });
  });
});

type ChoiceManifestOptions = Readonly<{
  sessionAActor?: Readonly<{ kind: "human" | "agent" | "system"; id: string }>;
  duplicateSessionStart?: "active" | "ended";
  resumeSession?: boolean;
  unauthorizedResume?: boolean;
  questionActor?: Readonly<{ kind: "human" | "agent"; id: string }>;
  questionAuthor?: string;
  questionSessionId?: string;
  options?: readonly Readonly<{ key: string; label: string }>[];
  answerActor?: Readonly<{ kind: "human" | "agent"; id: string }>;
  answerAuthor?: string;
  answerSessionId?: string;
  answerOptionKey?: string;
  includeSessionB?: boolean;
  transitionBefore?: "question" | "answer";
  transitionEventType?: "session.handoff-offered" | "session.ended";
  transitionActor?: Readonly<{ kind: "human" | "agent" | "system"; id: string }>;
  transitionAgentId?: string;
}>;

function choiceManifest(options: ChoiceManifestOptions = {}): WorkspaceExportManifest {
  const base = fixture().manifest;
  const history = [...base.events];
  const append = (
    eventType: string,
    streamType: string,
    streamId: string,
    payload: Record<string, unknown>,
    actor?: Readonly<{ kind: "human" | "agent" | "system"; id: string }>,
  ): void => {
    history.push(
      event(
        history.length + 1,
        eventType,
        streamType,
        streamId,
        history.filter((item) => item.streamId === streamId).length + 1,
        payload,
        actor,
      ),
    );
  };
  append(
    "session.started",
    "session",
    "session_a",
    {
      sessionId: "session_a",
      artifactId: null,
      originatingAgentId: "codex",
      agentId: "codex",
      processNonce: "process_codex",
      baseRevisionId: null,
      title: "Restore question session",
      goal: "preserve exact typed chat semantics",
      predecessorSessionId: null,
      handoffSummary: null,
    },
    options.sessionAActor ?? { kind: "agent", id: "codex" },
  );
  if (options.duplicateSessionStart === "ended") {
    append(
      "session.ended",
      "session",
      "session_a",
      {
        sessionId: "session_a",
        agentId: "codex",
        summary: "ended before forged reactivation",
      },
      { kind: "agent", id: "codex" },
    );
  }
  if (options.duplicateSessionStart !== undefined) {
    append(
      "session.started",
      "session",
      "session_a",
      {
        sessionId: "session_a",
        artifactId: null,
        originatingAgentId: "other",
        agentId: "other",
        processNonce: "process_other",
        baseRevisionId: null,
        title: "Forged replacement session",
        goal: "overwrite immutable ownership",
        predecessorSessionId: null,
        handoffSummary: null,
      },
      { kind: "agent", id: "other" },
    );
  }
  if (options.resumeSession === true) {
    append(
      "session.handoff-offered",
      "session",
      "session_a",
      {
        sessionId: "session_a",
        agentId: "codex",
        toAgentId: "other",
        summary: "handoff before valid resume",
      },
      { kind: "agent", id: "codex" },
    );
  }
  if (
    options.includeSessionB === true ||
    options.resumeSession === true ||
    options.unauthorizedResume === true
  ) {
    append(
      "session.started",
      "session",
      "session_b",
      {
        sessionId: "session_b",
        artifactId: null,
        originatingAgentId:
          options.resumeSession === true || options.unauthorizedResume === true ? "codex" : "other",
        agentId: "other",
        processNonce: "process_other",
        baseRevisionId: null,
        title: "Other session",
        goal: "stay isolated",
        predecessorSessionId:
          options.resumeSession === true || options.unauthorizedResume === true
            ? "session_a"
            : null,
        handoffSummary: options.resumeSession === true ? "handoff before valid resume" : null,
      },
      { kind: "agent", id: "other" },
    );
  }
  if (options.transitionBefore === "question") {
    append(
      options.transitionEventType ?? "session.handoff-offered",
      "session",
      "session_a",
      {
        sessionId: "session_a",
        agentId: options.transitionAgentId ?? "codex",
        ...(options.transitionEventType === "session.ended"
          ? { summary: "end before question" }
          : { toAgentId: "other", summary: "handoff before question" }),
      },
      options.transitionActor ?? { kind: "agent", id: "codex" },
    );
  }
  const questionSessionId =
    options.questionSessionId ??
    (options.resumeSession === true || options.unauthorizedResume === true
      ? "session_b"
      : "session_a");
  const defaultQuestionAgent =
    options.resumeSession === true ||
    options.unauthorizedResume === true ||
    options.duplicateSessionStart !== undefined
      ? "other"
      : "codex";
  const questionActor = options.questionActor ?? { kind: "agent", id: defaultQuestionAgent };
  append(
    "chat.message",
    "chat",
    "workspace",
    {
      messageId: "question_restore",
      artifactId: null,
      author: options.questionAuthor ?? `${questionActor.kind}:${questionActor.id}`,
      text: "Which route?",
      content: {
        type: "choice-question",
        prompt: "Which route?",
        options: options.options ?? [
          { key: "keep", label: "Keep the current route" },
          { key: "change", label: "Change the route" },
        ],
      },
      context: null,
      mentions: [],
      references: [],
      attachments: [],
      sessionId: questionSessionId,
      recipientAgentId: null,
      threadId: "session_a",
      workId: null,
      intentId: null,
    },
    questionActor,
  );
  if (options.transitionBefore === "answer") {
    append(
      options.transitionEventType ?? "session.handoff-offered",
      "session",
      questionSessionId,
      {
        sessionId: questionSessionId,
        agentId: options.transitionAgentId ?? defaultQuestionAgent,
        ...(options.transitionEventType === "session.ended"
          ? { summary: "end before answer" }
          : { toAgentId: "next", summary: "handoff before answer" }),
      },
      options.transitionActor ?? { kind: "agent", id: defaultQuestionAgent },
    );
  }
  const answerActor = options.answerActor ?? { kind: "human", id: "alex" };
  append(
    "chat.message",
    "chat",
    "workspace",
    {
      messageId: "answer_restore",
      artifactId: null,
      author: options.answerAuthor ?? `${answerActor.kind}:${answerActor.id}`,
      text: "Keep the current route",
      content: {
        type: "choice-answer",
        questionMessageId: "question_restore",
        optionKey: options.answerOptionKey ?? "keep",
        supersedesAnswerMessageId: null,
      },
      context: null,
      mentions: [],
      references: [],
      attachments: [],
      sessionId: options.answerSessionId ?? questionSessionId,
      recipientAgentId: null,
      threadId: "session_a",
      workId: null,
      intentId: null,
    },
    answerActor,
  );
  if (options.transitionBefore === undefined) {
    append(
      "session.handoff-offered",
      "session",
      questionSessionId,
      {
        sessionId: questionSessionId,
        agentId: defaultQuestionAgent,
        toAgentId: "next",
        summary: "handoff after answer",
      },
      { kind: "agent", id: defaultQuestionAgent },
    );
    append(
      "session.ended",
      "session",
      questionSessionId,
      {
        sessionId: questionSessionId,
        agentId: defaultQuestionAgent,
        summary: "ended after accepted typed chat",
      },
      { kind: "agent", id: defaultQuestionAgent },
    );
  }
  return {
    ...base,
    capturedSeq: history.length,
    events: history,
  };
}
