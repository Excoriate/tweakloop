import { randomBytes } from "node:crypto";
import type { Transactor } from "../daemon/transactor.js";
import type { ActorRef, CommandAccepted, CommandResult } from "../protocol/envelopes.js";
import { COMMAND_PROTOCOL } from "../protocol/versions.js";
import { putObject } from "../storage/object-store/index.js";
import type { Db } from "../storage/sqlite/db.js";
import {
  RuntimeAuthorityStore,
  WHITEBOARD_AUTOMATION_METHOD,
  WHITEBOARD_AUTOMATION_OPERATION_ID,
  WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
  type WhiteboardAutomationMintInput,
} from "../storage/sqlite/runtime-authority.js";
import { createDraftHub, type DraftHub, type DraftInvalidation } from "./draft-hub.js";
import {
  type DraftWriteResult,
  type StoredConflict,
  validateWhiteboardDraftWriteInput,
  type WhiteboardDraft,
  WhiteboardDraftStore,
} from "./drafts.js";
import { WhiteboardError } from "./errors.js";
import {
  createWhiteboardPublicationPin,
  decidePinnedWhiteboardPublication,
} from "./pinned-publication.js";
import {
  type WhiteboardRetentionDiagnostic,
  WhiteboardRetentionMaintainer,
  type WhiteboardRetentionPolicy,
} from "./retention.js";
import {
  canonicalizeWhiteboardScene,
  stableJsonHash,
  WHITEBOARD_INDEX_MEDIA_TYPE,
  WHITEBOARD_SCENE_MEDIA_TYPE,
} from "./scene.js";
import {
  createRandomSemanticIdentityAllocator,
  decideSemanticSceneReceipt,
  type SemanticSceneRequest,
} from "./semantic-scene.js";
import {
  type SemanticReceiptSnapshot,
  SemanticSceneStore,
  type SemanticSceneStoreResult,
} from "./semantic-store.js";

export type WhiteboardService = Readonly<{
  hub: DraftHub;
  getDraft: (artifactId: string) => WhiteboardDraftView | null;
  listConflicts: (artifactId: string) => StoredConflict[];
  putDraft: (input: PutWhiteboardDraftInput) => DraftWriteResult;
  applySceneCommands: (input: ApplySemanticSceneCommandsInput) => SemanticSceneStoreResult;
  mintSceneCommandToken: (
    input: MintSemanticSceneCommandTokenInput,
  ) => Readonly<{ automationToken: string; expiresAt: number }>;
  listSemanticReceiptSnapshots: () => SemanticReceiptSnapshot[];
  publishDraft: (input: PublishWhiteboardDraftInput) => CommandResult;
}>;

export type WhiteboardDraftView = WhiteboardDraft &
  Readonly<{ retention: WhiteboardRetentionDiagnostic }>;

export type PutWhiteboardDraftInput = Readonly<{
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  expectedDraftVersion: number;
  clientId: string;
  clientSequence: number;
  actor: ActorRef;
  bytes: Buffer;
  resolutionConflictId?: string;
}>;

export type ApplySemanticSceneCommandsInput = Readonly<{
  request: SemanticSceneRequest;
  automationToken: string;
}>;

export type MintSemanticSceneCommandTokenInput = Readonly<{
  sessionId: string;
  runtimeCapability: string;
  artifactId: string;
  method: typeof WHITEBOARD_AUTOMATION_METHOD;
  operationId: typeof WHITEBOARD_AUTOMATION_OPERATION_ID;
  routeSetVersion: typeof WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION;
  request: SemanticSceneRequest;
}>;

export type PublishWhiteboardDraftInput = Readonly<{
  commandId: string;
  idempotencyKey: string;
  artifactId: string;
  draftId: string;
  expectedDraftVersion: number;
  expectedHeadRevisionId: string;
  revisionId: string;
  actor: ActorRef;
}>;

type RevisionRow = {
  revision_id: string;
  artifact_id: string;
  seq: number;
  format: string;
  entry_path: string;
  entry_hash: string;
  source_path: string | null;
};

export function createWhiteboardService(
  deps: Readonly<{
    db: Db;
    objectsDir: string;
    workspaceId: string;
    transactor: Transactor;
    daemonStartNonce?: string;
    now?: () => string;
    nowMs?: () => number;
    newAutomationToken?: () => string;
    automationTokenTtlMs?: number;
    retentionPolicy?: Partial<WhiteboardRetentionPolicy>;
    publicationRaceInjection?: () => void;
    publicationCommitFailureInjection?: () => void;
  }>,
): WhiteboardService {
  const now = deps.now ?? (() => new Date().toISOString());
  const retention = new WhiteboardRetentionMaintainer(
    deps.db,
    deps.objectsDir,
    deps.retentionPolicy,
  );
  const store = new WhiteboardDraftStore(deps.db, {
    now,
    maxUnresolvedConflicts: retention.policy.maxUnresolvedConflictsPerArtifact,
  });
  const hub = createDraftHub();
  const authorityStore = new RuntimeAuthorityStore(deps.db, {
    workspaceId: deps.workspaceId,
    daemonStartNonce: deps.daemonStartNonce ?? "in-process-daemon",
    now: deps.nowMs ?? (() => Date.now()),
    newAutomationToken: deps.newAutomationToken ?? (() => randomBytes(32).toString("hex")),
    ...(deps.automationTokenTtlMs === undefined
      ? {}
      : { automationTtlMs: deps.automationTokenTtlMs }),
  });
  const semanticStore = new SemanticSceneStore(deps.db, {
    objectsDir: deps.objectsDir,
    workspaceId: deps.workspaceId,
    authorityStore,
    now,
  });
  store.reconcilePublishedDrafts();
  let lastRetention = retention.run();

  function getDraft(artifactId: string): WhiteboardDraftView | null {
    ensureWhiteboardArtifact(deps.db, artifactId);
    const draft = store.get(artifactId);
    if (draft) ensureBaseRevision(deps.db, artifactId, draft.baseRevisionId);
    return draft ? { ...draft, retention: lastRetention } : null;
  }

  function putDraft(input: PutWhiteboardDraftInput): DraftWriteResult {
    validateWhiteboardDraftWriteInput(input);
    ensureWhiteboardArtifact(deps.db, input.artifactId);
    const base = ensureBaseRevision(deps.db, input.artifactId, input.baseRevisionId);
    const canonical = canonicalizeWhiteboardScene(input.bytes);
    const recordedAt = now();
    let result: DraftWriteResult;
    try {
      const sceneHash = putObject(
        deps.objectsDir,
        deps.db,
        canonical.bytes,
        WHITEBOARD_SCENE_MEDIA_TYPE,
        recordedAt,
      );
      const elementIndexHash = putObject(
        deps.objectsDir,
        deps.db,
        canonical.elementIndexBytes,
        WHITEBOARD_INDEX_MEDIA_TYPE,
        recordedAt,
      );
      if (sceneHash !== canonical.hash || elementIndexHash !== canonical.elementIndexHash) {
        throw new Error("whiteboard object-store hash mismatch");
      }
      const current = store.get(input.artifactId);
      const head = currentHead(deps.db, input.artifactId);
      const allowPublishedReset =
        current?.publishedRevisionId !== null &&
        current?.sceneHash === head?.entry_hash &&
        input.expectedDraftVersion === 0 &&
        input.baseRevisionId === head?.revision_id;
      result = store.put({
        artifactId: input.artifactId,
        draftId: input.draftId,
        baseRevisionId: base.revision_id,
        expectedDraftVersion: input.expectedDraftVersion,
        actor: input.actor,
        clientId: input.clientId,
        clientSequence: input.clientSequence,
        sceneHash,
        elementIndexHash,
        requestHash: stableJsonHash({
          artifactId: input.artifactId,
          draftId: input.draftId,
          baseRevisionId: input.baseRevisionId,
          expectedDraftVersion: input.expectedDraftVersion,
          sceneHash,
          elementIndexHash,
          actor: input.actor,
          resolutionConflictId: input.resolutionConflictId ?? null,
        }),
        ...(input.resolutionConflictId ? { resolutionConflictId: input.resolutionConflictId } : {}),
        allowPublishedReset,
      });
    } finally {
      // Rejected CAS attempts can stage bytes; maintenance makes that failure path bounded too.
      lastRetention = retention.run();
    }
    if (result.status === "accepted") hub.publish(toInvalidation(result));
    return result;
  }

  function applySceneCommands(input: ApplySemanticSceneCommandsInput): SemanticSceneStoreResult {
    const result = semanticStore.apply(
      input.request,
      input.automationToken,
      createRandomSemanticIdentityAllocator(),
    );
    lastRetention = retention.run();
    if (result.invalidation) hub.publish(result.invalidation);
    return result;
  }

  function mintSceneCommandToken(
    input: MintSemanticSceneCommandTokenInput,
  ): Readonly<{ automationToken: string; expiresAt: number }> {
    const authorization = decideSemanticSceneReceipt(null, input.request);
    if (authorization.status !== "apply") {
      throw new Error("new semantic request unexpectedly resolved as a replay");
    }
    if (
      input.request.artifactId !== input.artifactId ||
      input.method !== WHITEBOARD_AUTOMATION_METHOD ||
      input.operationId !== WHITEBOARD_AUTOMATION_OPERATION_ID ||
      input.routeSetVersion !== WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION
    ) {
      throw new WhiteboardError(
        "whiteboard.automation-request-invalid",
        "automation token request does not match the canonical scene-command operation",
        400,
      );
    }
    const mintInput: WhiteboardAutomationMintInput = {
      sessionId: input.sessionId,
      runtimeCapability: input.runtimeCapability,
      artifactId: input.artifactId,
      method: input.method,
      operationId: input.operationId,
      routeSetVersion: input.routeSetVersion,
      requestHash: authorization.requestHash,
    };
    const minted = authorityStore.mintWhiteboardAutomationToken(mintInput);
    return { automationToken: minted.token, expiresAt: minted.expiresAt };
  }

  function publishDraft(input: PublishWhiteboardDraftInput): CommandResult {
    ensureWhiteboardArtifact(deps.db, input.artifactId);
    const requestHash = publicationRequestHash(input);
    const replay = deps.db
      .prepare(
        `SELECT r.command_id, r.response_json, h.request_hash
         FROM command_receipts AS r
         LEFT JOIN command_request_hashes AS h
           ON h.workspace_id = r.workspace_id AND h.idempotency_key = r.idempotency_key
         WHERE r.workspace_id = ? AND r.idempotency_key = ?`,
      )
      .get(deps.workspaceId, input.idempotencyKey) as
      | { command_id: string; response_json: string; request_hash: string | null }
      | undefined;
    if (replay) {
      if (replay.command_id !== input.commandId || replay.request_hash !== requestHash) {
        return rejected(
          input,
          "whiteboard.publish-idempotency-conflict",
          "idempotency key belongs to another whiteboard publication request",
        );
      }
      return JSON.parse(replay.response_json) as CommandResult;
    }

    const draft = store.get(input.artifactId);
    if (!draft || draft.draftId !== input.draftId) {
      return rejected(input, "whiteboard.draft-missing", "whiteboard draft does not exist");
    }

    const pin = createWhiteboardPublicationPin({
      artifactId: input.artifactId,
      draftId: input.draftId,
      baseRevisionId: draft.baseRevisionId,
      draftVersion: input.expectedDraftVersion,
      sceneHash: draft.sceneHash,
      elementIndexHash: draft.elementIndexHash,
      expectedHeadRevisionId: input.expectedHeadRevisionId,
    });
    const pinnedHead = currentHead(deps.db, input.artifactId);
    if (!pinnedHead) {
      return rejected(input, "whiteboard.draft-missing", "whiteboard head disappeared");
    }
    deps.publicationRaceInjection?.();
    let transactionDraft: WhiteboardDraft | null = null;
    let completedResult: CommandAccepted | null = null;
    const result = deps.transactor.executeWithTransactionHooks(
      {
        protocol: COMMAND_PROTOCOL,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        workspaceId: deps.workspaceId,
        actor: input.actor,
        type: "artifact.publish",
        payload: {
          artifactId: input.artifactId,
          revisionId: input.revisionId,
          format: "whiteboard",
          entryPath: pinnedHead.entry_path,
          entryHash: pin.sceneHash,
          files: [
            {
              path: pinnedHead.entry_path,
              hash: pin.sceneHash,
              mediaType: WHITEBOARD_SCENE_MEDIA_TYPE,
            },
            {
              path: ".tweakloop/elements.json",
              hash: pin.elementIndexHash,
              mediaType: WHITEBOARD_INDEX_MEDIA_TYPE,
            },
          ],
          producer: input.actor,
          sourcePath: pinnedHead.source_path,
        },
      },
      {
        beforeMutation: () => {
          const currentDraft = store.get(input.artifactId);
          const head = currentHead(deps.db, input.artifactId);
          if (!currentDraft || !head) {
            return rejected(
              input,
              "whiteboard.draft-missing",
              "whiteboard draft or head disappeared",
            );
          }
          const decision = decidePinnedWhiteboardPublication(pin, {
            artifactId: currentDraft.artifactId,
            draftId: currentDraft.draftId,
            baseRevisionId: currentDraft.baseRevisionId,
            draftVersion: currentDraft.draftVersion,
            sceneHash: currentDraft.sceneHash,
            elementIndexHash: currentDraft.elementIndexHash,
            currentHeadRevisionId: head.revision_id,
          });
          if (decision.status === "rejected") {
            return rejected(input, decision.code, decision.message);
          }
          transactionDraft = currentDraft;
          return null;
        },
        afterAccepted: (accepted) => {
          const response = accepted.response as { revisionId?: unknown };
          if (typeof response.revisionId === "string") {
            store.markPublished(input.artifactId, input.draftId, response.revisionId);
          }
          if (transactionDraft === null) {
            throw new Error("whiteboard publication transaction lost its validated draft");
          }
          completedResult = withPublishMetadata(
            accepted,
            input.artifactId,
            transactionDraft,
          ) as CommandAccepted;
          deps.db
            .prepare(
              `UPDATE command_receipts SET response_json = ?
               WHERE workspace_id = ? AND idempotency_key = ?`,
            )
            .run(JSON.stringify(completedResult), deps.workspaceId, input.idempotencyKey);
          deps.db
            .prepare(
              `UPDATE command_request_hashes SET request_hash = ?
               WHERE workspace_id = ? AND idempotency_key = ?`,
            )
            .run(requestHash, deps.workspaceId, input.idempotencyKey);
          deps.publicationCommitFailureInjection?.();
        },
      },
    );
    lastRetention = retention.run();
    return completedResult ?? result;
  }

  return {
    hub,
    getDraft,
    listConflicts: (artifactId) => {
      ensureWhiteboardArtifact(deps.db, artifactId);
      return store.listConflicts(artifactId);
    },
    putDraft,
    applySceneCommands,
    mintSceneCommandToken,
    listSemanticReceiptSnapshots: () => semanticStore.listReceiptSnapshots(),
    publishDraft,
  };
}

function ensureWhiteboardArtifact(db: Db, artifactId: string): void {
  const row = db.prepare("SELECT format FROM p_artifacts WHERE artifact_id = ?").get(artifactId) as
    | { format: string }
    | undefined;
  if (!row)
    throw new WhiteboardError("whiteboard.unknown", `unknown whiteboard: ${artifactId}`, 404);
  if (row.format !== "whiteboard") {
    throw new WhiteboardError(
      "whiteboard.format-required",
      `artifact ${artifactId} is not a whiteboard`,
      409,
    );
  }
}

function ensureBaseRevision(db: Db, artifactId: string, revisionId: string): RevisionRow {
  const row = db.prepare("SELECT * FROM p_revisions WHERE revision_id = ?").get(revisionId) as
    | RevisionRow
    | undefined;
  if (!row || row.artifact_id !== artifactId || row.format !== "whiteboard") {
    throw new WhiteboardError(
      "whiteboard.base-revision-unknown",
      `revision ${revisionId} is not a revision of whiteboard ${artifactId}`,
      409,
    );
  }
  return row;
}

function currentHead(db: Db, artifactId: string): RevisionRow | null {
  return (
    (db
      .prepare("SELECT * FROM p_revisions WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1")
      .get(artifactId) as RevisionRow | undefined) ?? null
  );
}

function toInvalidation(draft: WhiteboardDraft): DraftInvalidation {
  return {
    protocol: "tweakloop.whiteboard-draft/v1",
    kind: "whiteboard-draft",
    artifactId: draft.artifactId,
    draftId: draft.draftId,
    draftVersion: draft.draftVersion,
    baseRevisionId: draft.baseRevisionId,
    sceneHash: draft.sceneHash,
    updatedBy: draft.updatedBy,
  };
}

function rejected(
  input: Pick<PublishWhiteboardDraftInput, "commandId">,
  code: string,
  message: string,
): CommandResult {
  return { status: "rejected", commandId: input.commandId, code, message };
}

function withPublishMetadata(
  result: CommandResult,
  artifactId: string,
  draft: WhiteboardDraft,
): CommandResult {
  if (result.status === "rejected") return result;
  return {
    ...result,
    response: {
      ...(result.response as object),
      protocol: "tweakloop.whiteboard-publish/v1",
      artifactId,
      draftId: draft.draftId,
      draftVersion: draft.draftVersion,
      sceneHash: draft.sceneHash,
      elementIndexHash: draft.elementIndexHash,
    },
  };
}

function publicationRequestHash(input: PublishWhiteboardDraftInput): string {
  return stableJsonHash({
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    artifactId: input.artifactId,
    draftId: input.draftId,
    expectedDraftVersion: input.expectedDraftVersion,
    expectedHeadRevisionId: input.expectedHeadRevisionId,
    revisionId: input.revisionId,
    actor: { kind: input.actor.kind, id: input.actor.id },
  });
}
