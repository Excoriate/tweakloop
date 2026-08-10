import { randomUUID } from "node:crypto";
import type { ActorRef } from "../protocol/envelopes.js";
import {
  putObjectTracked,
  readObject,
  removeObjectFileIfUntracked,
} from "../storage/object-store/index.js";
import type { Db } from "../storage/sqlite/db.js";
import {
  type RuntimeAuthorityStore,
  WHITEBOARD_AUTOMATION_METHOD,
  WHITEBOARD_AUTOMATION_OPERATION_ID,
  WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
} from "../storage/sqlite/runtime-authority.js";
import type { DraftInvalidation } from "./draft-hub.js";
import { WhiteboardError } from "./errors.js";
import {
  canonicalizeWhiteboardScene,
  WHITEBOARD_INDEX_MEDIA_TYPE,
  WHITEBOARD_SCENE_MEDIA_TYPE,
} from "./scene.js";
import {
  applySemanticSceneRequest,
  decideSemanticSceneReceipt,
  materializeSemanticDraftInvalidation,
  rescopeSemanticSceneReceipt,
  type SemanticIdentityAllocator,
  type SemanticSceneReceiptRecord,
  type SemanticSceneRequest,
  type SemanticSceneResponse,
} from "./semantic-scene.js";

export type SemanticSceneStoreResult = Readonly<{
  status: "applied" | "replayed";
  response: SemanticSceneResponse;
  responseJson: string;
  receipt: SemanticSceneReceiptRecord;
  invalidation: DraftInvalidation | null;
}>;

export type SemanticReceiptSnapshot = Readonly<{
  receipt: SemanticSceneReceiptRecord;
  draftId: string | null;
}>;

type SemanticReceiptRow = Readonly<{
  receipt_json: string;
  draft_id: string | null;
}>;

type DraftRow = Readonly<{
  artifact_id: string;
  draft_id: string;
  base_revision_id: string;
  scene_hash: string;
  element_index_hash: string;
  draft_version: number;
  published_revision_id: string | null;
}>;

type RevisionRow = Readonly<{
  revision_id: string;
  artifact_id: string;
  format: string;
  entry_hash: string;
  files_json: string;
}>;

type DraftSource = Readonly<{
  mode: "create" | "active" | "reset-published";
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  expectedHeadRevisionId: string;
  sceneHash: string;
  elementIndexHash: string;
  current: DraftRow | null;
}>;

export class SemanticSceneStore {
  readonly db: Db;
  readonly objectsDir: string;
  readonly workspaceId: string;
  readonly now: () => string;
  readonly newDraftId: () => string;
  readonly failureInjection?: (point: "after-pointer-before-receipt") => void;
  readonly removeUntrackedObjectFile: (hash: string) => boolean;
  readonly authorityStore: RuntimeAuthorityStore | null;

  constructor(
    db: Db,
    options: Readonly<{
      objectsDir: string;
      workspaceId: string;
      authorityStore?: RuntimeAuthorityStore;
      now?: () => string;
      newDraftId?: () => string;
      failureInjection?: (point: "after-pointer-before-receipt") => void;
      removeUntrackedObjectFile?: (hash: string) => boolean;
    }>,
  ) {
    this.db = db;
    this.objectsDir = options.objectsDir;
    this.workspaceId = options.workspaceId;
    this.authorityStore = options.authorityStore ?? null;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newDraftId = options.newDraftId ?? (() => `draft_${randomUUID()}`);
    this.failureInjection = options.failureInjection;
    this.removeUntrackedObjectFile =
      options.removeUntrackedObjectFile ??
      ((hash) => removeObjectFileIfUntracked(this.objectsDir, this.db, hash));
  }

  apply(
    request: SemanticSceneRequest,
    automationToken: string,
    allocator: SemanticIdentityAllocator,
  ): SemanticSceneStoreResult {
    const semanticAuthorization = decideSemanticSceneReceipt(null, request);
    if (semanticAuthorization.status !== "apply") {
      throw new Error("new semantic request unexpectedly resolved as a replay");
    }
    const createdObjectHashes = new Set<string>();
    const tx = this.db.transaction(() =>
      this.applyInsideTransaction(
        request,
        automationToken,
        semanticAuthorization,
        allocator,
        createdObjectHashes,
      ),
    );
    try {
      return tx.immediate();
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      for (const hash of createdObjectHashes) {
        try {
          this.removeUntrackedObjectFile(hash);
        } catch {
          try {
            this.removeUntrackedObjectFile(hash);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "semantic whiteboard transaction failed and object cleanup remained incomplete",
        );
      }
      throw error;
    }
  }

  getReceiptForKey(artifactId: string, idempotencyKey: string): SemanticReceiptSnapshot | null {
    const row = this.getReceiptRow(artifactId, idempotencyKey);
    return row ? { receipt: parseReceipt(row.receipt_json), draftId: row.draft_id } : null;
  }

  listReceiptSnapshots(): SemanticReceiptSnapshot[] {
    const rows = this.db
      .prepare(
        `SELECT receipt_json, draft_id FROM whiteboard_semantic_receipts
         WHERE workspace_id = ? ORDER BY artifact_id, idempotency_key`,
      )
      .all(this.workspaceId) as SemanticReceiptRow[];
    return rows.map((row) => ({ receipt: parseReceipt(row.receipt_json), draftId: row.draft_id }));
  }

  restoreReceiptSnapshots(
    snapshots: readonly SemanticReceiptSnapshot[],
    mapDraftId: (sourceDraftId: string) => string = (sourceDraftId) => sourceDraftId,
  ): void {
    const tx = this.db.transaction(() => {
      for (const snapshot of snapshots) {
        const receipt = rescopeSemanticSceneReceipt(snapshot.receipt, this.workspaceId);
        const draftId = snapshot.draftId === null ? null : mapDraftId(snapshot.draftId);
        this.insertReceipt(receipt, draftId);
      }
    });
    tx.immediate();
  }

  private applyInsideTransaction(
    request: SemanticSceneRequest,
    automationToken: string,
    semanticAuthorization: Extract<
      ReturnType<typeof decideSemanticSceneReceipt>,
      { status: "apply" }
    >,
    allocator: SemanticIdentityAllocator,
    createdObjectHashes: Set<string>,
  ): SemanticSceneStoreResult {
    const principal = this.requiredAuthorityStore().authorizeAndConsumeWhiteboardToken({
      token: automationToken,
      artifactId: request.artifactId,
      method: WHITEBOARD_AUTOMATION_METHOD,
      operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
      routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
      requestHash: semanticAuthorization.requestHash,
    });
    const actor: ActorRef = { kind: "agent", id: principal.declaredAgentId };
    const existing = this.getReceiptRow(request.artifactId, request.idempotencyKey);
    if (existing) return this.replayRow(existing, request);

    const source = this.currentDraftSource(request.artifactId);
    const currentScene = readObject(this.objectsDir, source.sceneHash);
    const canonicalCurrent = canonicalizeWhiteboardScene(currentScene);
    if (
      canonicalCurrent.hash !== source.sceneHash ||
      canonicalCurrent.elementIndexHash !== source.elementIndexHash
    ) {
      throw new WhiteboardError(
        "whiteboard.semantic-projection-mismatch",
        "stored whiteboard scene and element index do not describe the same semantic projection",
        409,
      );
    }
    const candidate = applySemanticSceneRequest({
      workspaceId: this.workspaceId,
      currentScene,
      currentDraft: {
        artifactId: request.artifactId,
        draftId: source.draftId,
        baseRevisionId: source.baseRevisionId,
        draftVersion: source.draftVersion,
        expectedHeadRevisionId: source.expectedHeadRevisionId,
      },
      actor,
      authorization: semanticAuthorization,
      allocator,
    });

    if (!candidate.response.unchanged) {
      const recordedAt = this.now();
      const storedScene = putObjectTracked(
        this.objectsDir,
        this.db,
        candidate.canonicalScene.bytes,
        WHITEBOARD_SCENE_MEDIA_TYPE,
        recordedAt,
      );
      if (storedScene.createdFile) createdObjectHashes.add(storedScene.hash);
      const storedIndex = putObjectTracked(
        this.objectsDir,
        this.db,
        candidate.canonicalScene.elementIndexBytes,
        WHITEBOARD_INDEX_MEDIA_TYPE,
        recordedAt,
      );
      if (storedIndex.createdFile) createdObjectHashes.add(storedIndex.hash);
      const sceneHash = storedScene.hash;
      const elementIndexHash = storedIndex.hash;
      if (
        sceneHash !== candidate.response.sceneHash ||
        elementIndexHash !== candidate.response.elementIndexHash
      ) {
        throw new Error("semantic whiteboard object-store hash mismatch");
      }
      this.compareAndSwapDraft(source, candidate.response, actor, recordedAt);
    }
    this.failureInjection?.("after-pointer-before-receipt");
    this.insertReceipt(
      candidate.receiptInsert,
      candidate.invalidation === null ? null : source.draftId,
    );
    return {
      status: "applied",
      response: candidate.response,
      responseJson: candidate.responseJson,
      receipt: candidate.receiptInsert,
      invalidation: candidate.invalidation,
    };
  }

  private replayRow(
    row: SemanticReceiptRow,
    request: SemanticSceneRequest,
  ): SemanticSceneStoreResult {
    const receipt = parseReceipt(row.receipt_json);
    const decision = decideSemanticSceneReceipt(receipt, request);
    if (decision.status !== "replay") {
      throw new Error("stored semantic receipt unexpectedly authorized mutation");
    }
    if (decision.invalidation !== null && row.draft_id === null) {
      throw new WhiteboardError(
        "whiteboard.semantic-receipt-corrupt",
        "semantic receipt invalidation is missing its destination-local draft identity",
        409,
      );
    }
    return {
      status: "replayed",
      response: decision.response,
      responseJson: decision.responseJson,
      receipt,
      invalidation:
        decision.invalidation && row.draft_id
          ? materializeSemanticDraftInvalidation(decision.invalidation, row.draft_id)
          : null,
    };
  }

  private getReceiptRow(artifactId: string, idempotencyKey: string): SemanticReceiptRow | null {
    return (
      (this.db
        .prepare(
          `SELECT receipt_json, draft_id FROM whiteboard_semantic_receipts
           WHERE workspace_id = ? AND artifact_id = ? AND idempotency_key = ?`,
        )
        .get(this.workspaceId, artifactId, idempotencyKey) as SemanticReceiptRow | undefined) ??
      null
    );
  }

  private requiredAuthorityStore(): RuntimeAuthorityStore {
    if (this.authorityStore === null) {
      throw new Error("semantic whiteboard mutation requires a runtime authority store");
    }
    return this.authorityStore;
  }

  private currentDraftSource(artifactId: string): DraftSource {
    const head = this.db
      .prepare(
        `SELECT revision_id, artifact_id, format, entry_hash, files_json FROM p_revisions
         WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1`,
      )
      .get(artifactId) as RevisionRow | undefined;
    if (head?.format !== "whiteboard") {
      throw new WhiteboardError(
        "whiteboard.unknown",
        `unknown whiteboard or missing head: ${artifactId}`,
        404,
      );
    }
    const current = this.db
      .prepare("SELECT * FROM whiteboard_drafts WHERE artifact_id = ?")
      .get(artifactId) as DraftRow | undefined;
    if (current && current.published_revision_id === null) {
      return {
        mode: "active",
        draftId: current.draft_id,
        baseRevisionId: current.base_revision_id,
        draftVersion: current.draft_version,
        expectedHeadRevisionId: current.base_revision_id,
        sceneHash: current.scene_hash,
        elementIndexHash: current.element_index_hash,
        current,
      };
    }
    const headElementIndexHash = revisionElementIndexHash(head);
    return {
      mode: current ? "reset-published" : "create",
      draftId: this.checkedDraftId(this.newDraftId()),
      baseRevisionId: head.revision_id,
      draftVersion: 0,
      expectedHeadRevisionId: head.revision_id,
      sceneHash: head.entry_hash,
      elementIndexHash: headElementIndexHash,
      current: current ?? null,
    };
  }

  private compareAndSwapDraft(
    source: DraftSource,
    response: SemanticSceneResponse,
    actor: ActorRef,
    recordedAt: string,
  ): void {
    const actorJson = JSON.stringify(actor);
    const clientId = `semantic:${actor.kind}:${actor.id}`;
    if (source.mode === "create") {
      this.db
        .prepare(
          `INSERT INTO whiteboard_drafts (
             artifact_id, draft_id, base_revision_id, scene_hash, element_index_hash,
             draft_version, updated_by_json, updated_at, client_id, client_sequence,
             published_revision_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          response.artifactId,
          source.draftId,
          response.baseRevisionId,
          response.sceneHash,
          response.elementIndexHash,
          response.draftVersion,
          actorJson,
          recordedAt,
          clientId,
          response.draftVersion,
        );
      return;
    }

    const current = source.current;
    if (!current) throw new Error("semantic whiteboard CAS source is missing");
    const update = this.db
      .prepare(
        `UPDATE whiteboard_drafts SET
           draft_id = ?, base_revision_id = ?, scene_hash = ?, element_index_hash = ?,
           draft_version = ?, updated_by_json = ?, updated_at = ?, client_id = ?,
           client_sequence = ?, published_revision_id = NULL
         WHERE artifact_id = ? AND draft_id = ? AND base_revision_id = ?
           AND scene_hash = ? AND element_index_hash = ? AND draft_version = ?
           AND published_revision_id IS ?`,
      )
      .run(
        source.draftId,
        response.baseRevisionId,
        response.sceneHash,
        response.elementIndexHash,
        response.draftVersion,
        actorJson,
        recordedAt,
        clientId,
        response.draftVersion,
        response.artifactId,
        current.draft_id,
        current.base_revision_id,
        current.scene_hash,
        current.element_index_hash,
        current.draft_version,
        current.published_revision_id,
      );
    if (update.changes !== 1) {
      throw new WhiteboardError(
        "whiteboard.draft-conflict",
        "semantic whiteboard draft changed before the receipt/pointer compare-and-swap",
        409,
      );
    }
  }

  private insertReceipt(receipt: SemanticSceneReceiptRecord, draftId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO whiteboard_semantic_receipts (
           workspace_id, artifact_id, idempotency_key, request_hash,
           normalization_version, receipt_json, draft_id, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.workspaceId,
        receipt.artifactId,
        receipt.idempotencyKey,
        receipt.requestHash,
        receipt.normalizationVersion,
        JSON.stringify(receipt),
        draftId,
        this.now(),
      );
  }

  private checkedDraftId(value: string): string {
    if (value.length < 1 || value.length > 256 || hasControlCharacter(value)) {
      throw new WhiteboardError(
        "whiteboard.draft-identity-invalid",
        "server draft identity allocator returned an invalid identifier",
        500,
      );
    }
    return value;
  }
}

function revisionElementIndexHash(revision: RevisionRow): string {
  let files: unknown;
  try {
    files = JSON.parse(revision.files_json);
  } catch {
    throw new WhiteboardError(
      "whiteboard.semantic-projection-mismatch",
      "published whiteboard revision has invalid file metadata",
      409,
    );
  }
  const index = Array.isArray(files)
    ? files.find(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          (value as { path?: unknown }).path === ".tweakloop/elements.json",
      )
    : undefined;
  const hash = (index as { hash?: unknown } | undefined)?.hash;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new WhiteboardError(
      "whiteboard.semantic-projection-mismatch",
      "published whiteboard revision is missing its valid semantic element index",
      409,
    );
  }
  return hash;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function parseReceipt(value: string): SemanticSceneReceiptRecord {
  try {
    return JSON.parse(value) as SemanticSceneReceiptRecord;
  } catch {
    throw new WhiteboardError(
      "whiteboard.semantic-receipt-corrupt",
      "stored semantic receipt is not valid JSON",
      409,
    );
  }
}
