import { randomUUID } from "node:crypto";
import type { ActorRef } from "../protocol/envelopes.js";
import type { Db } from "../storage/sqlite/db.js";
import { WhiteboardError } from "./errors.js";
import { DEFAULT_WHITEBOARD_RETENTION_POLICY } from "./retention.js";
import { WHITEBOARD_DRAFT_PROTOCOL } from "./scene.js";

export type WhiteboardDraft = Readonly<{
  protocol: typeof WHITEBOARD_DRAFT_PROTOCOL;
  status: "accepted";
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  elementIndexHash: string;
  updatedBy: ActorRef;
  updatedAt: string;
  clientId: string;
  clientSequence: number;
  publishedRevisionId: string | null;
  unchanged?: boolean;
}>;

export type WhiteboardDraftConflict = Readonly<{
  protocol: typeof WHITEBOARD_DRAFT_PROTOCOL;
  status: "conflict";
  code: "whiteboard.draft-conflict";
  conflictId: string;
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  expectedDraftVersion: number;
  currentDraftVersion: number;
  submittedSceneHash: string;
  currentSceneHash: string;
}>;

export type DraftWriteResult = WhiteboardDraft | WhiteboardDraftConflict;

export type StoredConflict = Readonly<{
  conflictId: string;
  artifactId: string;
  draftId: string;
  expectedVersion: number;
  currentVersion: number;
  submittedSceneHash: string;
  currentSceneHash: string;
  submittedBy: ActorRef;
  createdAt: string;
  resolution: Readonly<Record<string, unknown>> | null;
  resolvedAt: string | null;
}>;

type DraftRow = {
  artifact_id: string;
  draft_id: string;
  base_revision_id: string;
  scene_hash: string;
  element_index_hash: string;
  draft_version: number;
  updated_by_json: string;
  updated_at: string;
  client_id: string;
  client_sequence: number;
  published_revision_id: string | null;
};

export class WhiteboardDraftStore {
  readonly db: Db;
  readonly now: () => string;
  readonly newConflictId: () => string;
  readonly maxUnresolvedConflicts: number;

  constructor(
    db: Db,
    options: Readonly<{
      now?: () => string;
      newConflictId?: () => string;
      maxUnresolvedConflicts?: number;
    }> = {},
  ) {
    this.db = db;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newConflictId = options.newConflictId ?? (() => `conflict_${randomUUID()}`);
    this.maxUnresolvedConflicts =
      options.maxUnresolvedConflicts ??
      DEFAULT_WHITEBOARD_RETENTION_POLICY.maxUnresolvedConflictsPerArtifact;
    if (!Number.isSafeInteger(this.maxUnresolvedConflicts) || this.maxUnresolvedConflicts < 1) {
      throw new Error("maxUnresolvedConflicts must be a positive safe integer");
    }
  }

  get(artifactId: string): WhiteboardDraft | null {
    const row = this.db
      .prepare("SELECT * FROM whiteboard_drafts WHERE artifact_id = ?")
      .get(artifactId) as DraftRow | undefined;
    return row ? rowToDraft(row) : null;
  }

  put(
    input: Readonly<{
      artifactId: string;
      draftId: string;
      baseRevisionId: string;
      expectedDraftVersion: number;
      sceneHash: string;
      elementIndexHash: string;
      actor: ActorRef;
      clientId: string;
      clientSequence: number;
      requestHash: string;
      resolutionConflictId?: string;
      allowPublishedReset?: boolean;
    }>,
  ): DraftWriteResult {
    const tx = this.db.transaction(() => this.putInsideTransaction(input));
    return tx.immediate();
  }

  listConflicts(artifactId: string): StoredConflict[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM whiteboard_draft_conflicts
         WHERE artifact_id = ? ORDER BY created_at DESC, conflict_id DESC`,
      )
      .all(artifactId) as {
      conflict_id: string;
      artifact_id: string;
      draft_id: string;
      expected_version: number;
      current_version: number;
      submitted_scene_hash: string;
      current_scene_hash: string;
      submitted_by_json: string;
      created_at: string;
      resolution: string | null;
      resolved_at: string | null;
    }[];
    return rows.map((row) => ({
      conflictId: row.conflict_id,
      artifactId: row.artifact_id,
      draftId: row.draft_id,
      expectedVersion: row.expected_version,
      currentVersion: row.current_version,
      submittedSceneHash: row.submitted_scene_hash,
      currentSceneHash: row.current_scene_hash,
      submittedBy: JSON.parse(row.submitted_by_json) as ActorRef,
      createdAt: row.created_at,
      resolution: row.resolution ? JSON.parse(row.resolution) : null,
      resolvedAt: row.resolved_at,
    }));
  }

  markPublished(artifactId: string, draftId: string, revisionId: string): void {
    this.db
      .prepare(
        `UPDATE whiteboard_drafts SET published_revision_id = ?
         WHERE artifact_id = ? AND draft_id = ?`,
      )
      .run(revisionId, artifactId, draftId);
  }

  reconcilePublishedDrafts(): number {
    const result = this.db
      .prepare(
        `UPDATE whiteboard_drafts
         SET published_revision_id = (
           SELECT revision_id FROM p_revisions
           WHERE p_revisions.artifact_id = whiteboard_drafts.artifact_id
             AND p_revisions.entry_hash = whiteboard_drafts.scene_hash
           ORDER BY seq DESC LIMIT 1
         )
         WHERE EXISTS (
           SELECT 1 FROM p_revisions
           WHERE p_revisions.artifact_id = whiteboard_drafts.artifact_id
             AND p_revisions.entry_hash = whiteboard_drafts.scene_hash
             AND p_revisions.seq = (
               SELECT MAX(head.seq) FROM p_revisions AS head
               WHERE head.artifact_id = whiteboard_drafts.artifact_id
             )
         )`,
      )
      .run();
    return result.changes;
  }

  private putInsideTransaction(
    input: Readonly<{
      artifactId: string;
      draftId: string;
      baseRevisionId: string;
      expectedDraftVersion: number;
      sceneHash: string;
      elementIndexHash: string;
      actor: ActorRef;
      clientId: string;
      clientSequence: number;
      requestHash: string;
      resolutionConflictId?: string;
      allowPublishedReset?: boolean;
    }>,
  ): DraftWriteResult {
    validateWhiteboardDraftWriteInput(input);
    const receipt = this.db
      .prepare(
        `SELECT request_hash, response_json FROM whiteboard_draft_receipts
         WHERE artifact_id = ? AND client_id = ? AND client_sequence = ?`,
      )
      .get(input.artifactId, input.clientId, input.clientSequence) as
      | { request_hash: string; response_json: string }
      | undefined;
    if (receipt) {
      if (receipt.request_hash !== input.requestHash) {
        throw new WhiteboardError(
          "whiteboard.draft-idempotency-conflict",
          "client sequence was already used for different whiteboard bytes",
          409,
        );
      }
      return JSON.parse(receipt.response_json) as DraftWriteResult;
    }

    const latestClientSequence = this.db
      .prepare(
        `SELECT MAX(client_sequence) AS client_sequence
         FROM whiteboard_draft_receipts
         WHERE artifact_id = ? AND client_id = ?`,
      )
      .get(input.artifactId, input.clientId) as { client_sequence: number | null };
    if (
      latestClientSequence.client_sequence !== null &&
      input.clientSequence <= latestClientSequence.client_sequence
    ) {
      throw new WhiteboardError(
        "whiteboard.draft-stale-sequence",
        `client sequence ${input.clientSequence} is not newer than retained sequence ${latestClientSequence.client_sequence}`,
        409,
      );
    }

    const currentRow = this.db
      .prepare("SELECT * FROM whiteboard_drafts WHERE artifact_id = ?")
      .get(input.artifactId) as DraftRow | undefined;
    const resetPublished =
      input.allowPublishedReset === true &&
      currentRow?.published_revision_id !== null &&
      input.expectedDraftVersion === 0 &&
      input.draftId !== currentRow?.draft_id;
    const current = resetPublished ? undefined : currentRow;

    let result: DraftWriteResult;
    if (!current) {
      if (input.expectedDraftVersion !== 0) {
        throw new WhiteboardError(
          "whiteboard.draft-missing",
          "no current draft exists for the expected version",
          409,
        );
      }
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO whiteboard_drafts (
             artifact_id, draft_id, base_revision_id, scene_hash, element_index_hash,
             draft_version, updated_by_json, updated_at, client_id, client_sequence,
             published_revision_id
           ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL)
           ON CONFLICT(artifact_id) DO UPDATE SET
             draft_id = excluded.draft_id,
             base_revision_id = excluded.base_revision_id,
             scene_hash = excluded.scene_hash,
             element_index_hash = excluded.element_index_hash,
             draft_version = 1,
             updated_by_json = excluded.updated_by_json,
             updated_at = excluded.updated_at,
             client_id = excluded.client_id,
             client_sequence = excluded.client_sequence,
             published_revision_id = NULL`,
        )
        .run(
          input.artifactId,
          input.draftId,
          input.baseRevisionId,
          input.sceneHash,
          input.elementIndexHash,
          JSON.stringify(input.actor),
          now,
          input.clientId,
          input.clientSequence,
        );
      result = this.getRequired(input.artifactId);
    } else if (
      current.draft_id !== input.draftId ||
      current.base_revision_id !== input.baseRevisionId ||
      current.draft_version !== input.expectedDraftVersion
    ) {
      const unresolvedConflicts = (
        this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM whiteboard_draft_conflicts
             WHERE artifact_id = ? AND resolved_at IS NULL`,
          )
          .get(input.artifactId) as { count: number }
      ).count;
      if (unresolvedConflicts >= this.maxUnresolvedConflicts) {
        throw new WhiteboardError(
          "whiteboard.conflict-limit",
          `whiteboard has ${unresolvedConflicts} unresolved conflicts; resolve one before submitting another stale draft`,
          409,
          { maxUnresolvedConflicts: this.maxUnresolvedConflicts },
        );
      }
      const conflictId = this.newConflictId();
      const createdAt = this.now();
      this.db
        .prepare(
          `INSERT INTO whiteboard_draft_conflicts (
             conflict_id, artifact_id, draft_id, expected_version, current_version,
             submitted_scene_hash, current_scene_hash, submitted_by_json, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conflictId,
          input.artifactId,
          input.draftId,
          input.expectedDraftVersion,
          current.draft_version,
          input.sceneHash,
          current.scene_hash,
          JSON.stringify(input.actor),
          createdAt,
        );
      result = {
        protocol: WHITEBOARD_DRAFT_PROTOCOL,
        status: "conflict",
        code: "whiteboard.draft-conflict",
        conflictId,
        artifactId: input.artifactId,
        draftId: current.draft_id,
        baseRevisionId: current.base_revision_id,
        expectedDraftVersion: input.expectedDraftVersion,
        currentDraftVersion: current.draft_version,
        submittedSceneHash: input.sceneHash,
        currentSceneHash: current.scene_hash,
      };
    } else if (
      current.scene_hash === input.sceneHash &&
      current.element_index_hash === input.elementIndexHash
    ) {
      result = { ...rowToDraft(current), unchanged: true };
      this.resolveConflictIfRequested(input, result);
    } else {
      const now = this.now();
      const update = this.db
        .prepare(
          `UPDATE whiteboard_drafts SET
             scene_hash = ?, element_index_hash = ?, draft_version = draft_version + 1,
             updated_by_json = ?, updated_at = ?, client_id = ?, client_sequence = ?,
             published_revision_id = NULL
           WHERE artifact_id = ? AND draft_id = ? AND base_revision_id = ?
             AND draft_version = ?`,
        )
        .run(
          input.sceneHash,
          input.elementIndexHash,
          JSON.stringify(input.actor),
          now,
          input.clientId,
          input.clientSequence,
          input.artifactId,
          input.draftId,
          input.baseRevisionId,
          input.expectedDraftVersion,
        );
      if (update.changes !== 1) {
        throw new WhiteboardError(
          "whiteboard.draft-conflict",
          "draft changed before the compare-and-swap update",
          409,
        );
      }
      result = this.getRequired(input.artifactId);
      this.resolveConflictIfRequested(input, result);
    }

    this.db
      .prepare(
        `INSERT INTO whiteboard_draft_receipts (
           artifact_id, client_id, client_sequence, request_hash, response_json, recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.artifactId,
        input.clientId,
        input.clientSequence,
        input.requestHash,
        JSON.stringify(result),
        this.now(),
      );
    return result;
  }

  private resolveConflictIfRequested(
    input: Readonly<{ artifactId: string; resolutionConflictId?: string }>,
    result: WhiteboardDraft,
  ): void {
    if (!input.resolutionConflictId) return;
    const resolution = this.db
      .prepare(
        `UPDATE whiteboard_draft_conflicts
         SET resolution = ?, resolved_at = ?
         WHERE conflict_id = ? AND artifact_id = ? AND resolved_at IS NULL`,
      )
      .run(
        JSON.stringify({
          status: "resolved",
          draftVersion: result.draftVersion,
          sceneHash: result.sceneHash,
        }),
        this.now(),
        input.resolutionConflictId,
        input.artifactId,
      );
    if (resolution.changes !== 1) {
      throw new WhiteboardError(
        "whiteboard.conflict-unknown",
        "conflict does not exist, belongs to another artifact, or is already resolved",
        409,
      );
    }
  }

  private getRequired(artifactId: string): WhiteboardDraft {
    const draft = this.get(artifactId);
    if (!draft) throw new Error("whiteboard draft write did not produce a row");
    return draft;
  }
}

export function validateWhiteboardDraftWriteInput(input: {
  expectedDraftVersion: number;
  clientSequence: number;
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  clientId: string;
}): void {
  if (!Number.isSafeInteger(input.expectedDraftVersion) || input.expectedDraftVersion < 0) {
    throw new WhiteboardError(
      "whiteboard.draft-version-invalid",
      "expected draft version must be a non-negative safe integer",
      400,
    );
  }
  if (!Number.isSafeInteger(input.clientSequence) || input.clientSequence < 1) {
    throw new WhiteboardError(
      "whiteboard.client-sequence-invalid",
      "client sequence must be a positive safe integer",
      400,
    );
  }
  for (const [name, value] of [
    ["artifactId", input.artifactId],
    ["draftId", input.draftId],
    ["baseRevisionId", input.baseRevisionId],
    ["clientId", input.clientId],
  ] as const) {
    if (value.length < 1 || value.length > 256 || hasControlCharacter(value)) {
      throw new WhiteboardError(
        "whiteboard.draft-identity-invalid",
        `${name} must be a non-empty printable identifier no longer than 256 characters`,
        400,
      );
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function rowToDraft(row: DraftRow): WhiteboardDraft {
  return {
    protocol: WHITEBOARD_DRAFT_PROTOCOL,
    status: "accepted",
    artifactId: row.artifact_id,
    draftId: row.draft_id,
    baseRevisionId: row.base_revision_id,
    draftVersion: row.draft_version,
    sceneHash: row.scene_hash,
    elementIndexHash: row.element_index_hash,
    updatedBy: JSON.parse(row.updated_by_json) as ActorRef,
    updatedAt: row.updated_at,
    clientId: row.client_id,
    clientSequence: row.client_sequence,
    publishedRevisionId: row.published_revision_id,
  };
}
