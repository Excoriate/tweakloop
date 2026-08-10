import { existsSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { objectPath } from "../storage/object-store/index.js";
import type { Db } from "../storage/sqlite/db.js";
import { WHITEBOARD_INDEX_MEDIA_TYPE, WHITEBOARD_SCENE_MEDIA_TYPE } from "./scene.js";

export const WHITEBOARD_RETENTION_PROTOCOL = "tweakloop.whiteboard-retention/v1" as const;

export type WhiteboardRetentionPolicy = Readonly<{
  maxReceiptsPerArtifact: number;
  maxResolvedConflictsPerArtifact: number;
  maxUnresolvedConflictsPerArtifact: number;
  maxUnreferencedObjects: number;
}>;

export const DEFAULT_WHITEBOARD_RETENTION_POLICY: WhiteboardRetentionPolicy = {
  maxReceiptsPerArtifact: 128,
  maxResolvedConflictsPerArtifact: 32,
  maxUnresolvedConflictsPerArtifact: 64,
  maxUnreferencedObjects: 16,
};

type RetentionCounts = Readonly<{
  objects: number;
  receipts: number;
  resolvedConflicts: number;
  unresolvedConflicts: number;
}>;

export type WhiteboardRetentionDiagnostic = Readonly<{
  protocol: typeof WHITEBOARD_RETENTION_PROTOCOL;
  status: "ok" | "blocked";
  policy: WhiteboardRetentionPolicy;
  before: RetentionCounts;
  after: RetentionCounts;
  reachableObjects: number;
  retainedUnreferencedObjects: number;
  deletedObjects: number;
  prunedReceipts: number;
  prunedResolvedConflicts: number;
  missingReachableObjects: readonly string[];
  failedObjectDeletions: readonly string[];
  blockedReason: string | null;
}>;

type BlobRow = {
  hash: string;
  media_type: string;
  created_at: string;
};

const CONTENT_HASH = /^[a-f0-9]{64}$/;

export class WhiteboardRetentionMaintainer {
  readonly db: Db;
  readonly objectsDir: string;
  readonly policy: WhiteboardRetentionPolicy;

  constructor(db: Db, objectsDir: string, policy: Partial<WhiteboardRetentionPolicy> = {}) {
    this.db = db;
    this.objectsDir = objectsDir;
    this.policy = validatePolicy({ ...DEFAULT_WHITEBOARD_RETENTION_POLICY, ...policy });
  }

  run(): WhiteboardRetentionDiagnostic {
    const before = this.counts();
    try {
      // Validate every existing root document before deleting even ephemeral metadata.
      collectReachableHashes(this.db);
    } catch (error) {
      return this.blocked(before, error instanceof Error ? error.message : String(error));
    }

    const pruned = this.db
      .transaction(() => ({
        receipts: this.db
          .prepare(
            `DELETE FROM whiteboard_draft_receipts
             WHERE rowid IN (
               SELECT rowid FROM (
                 SELECT rowid,
                   ROW_NUMBER() OVER (
                     PARTITION BY artifact_id
                     ORDER BY recorded_at DESC, client_id DESC, client_sequence DESC
                   ) AS retention_rank
                 FROM whiteboard_draft_receipts
               ) WHERE retention_rank > ?
             )`,
          )
          .run(this.policy.maxReceiptsPerArtifact).changes,
        resolvedConflicts: this.db
          .prepare(
            `DELETE FROM whiteboard_draft_conflicts
             WHERE rowid IN (
               SELECT rowid FROM (
                 SELECT rowid,
                   ROW_NUMBER() OVER (
                     PARTITION BY artifact_id
                     ORDER BY resolved_at DESC, created_at DESC, conflict_id DESC
                   ) AS retention_rank
                 FROM whiteboard_draft_conflicts
                 WHERE resolved_at IS NOT NULL
               ) WHERE retention_rank > ?
             )`,
          )
          .run(this.policy.maxResolvedConflictsPerArtifact).changes,
      }))
      .immediate();

    let reachable: Set<string>;
    try {
      reachable = collectReachableHashes(this.db);
    } catch (error) {
      return this.blocked(
        before,
        error instanceof Error ? error.message : String(error),
        pruned.receipts,
        pruned.resolvedConflicts,
      );
    }

    const objects = this.whiteboardObjects();
    const missingReachableObjects = objects
      .filter(
        (row) => reachable.has(row.hash) && !existsSync(objectPath(this.objectsDir, row.hash)),
      )
      .map((row) => row.hash)
      .sort();
    if (missingReachableObjects.length > 0) {
      return this.diagnostic({
        before,
        prunedReceipts: pruned.receipts,
        prunedResolvedConflicts: pruned.resolvedConflicts,
        reachable,
        missingReachableObjects,
        failedObjectDeletions: [],
        deletedObjects: 0,
        blockedReason: "reachable whiteboard object bytes are missing; sweep stopped",
      });
    }

    const unreachable = objects.filter((row) => !reachable.has(row.hash));
    const collectible = unreachable.slice(this.policy.maxUnreferencedObjects);
    const failedObjectDeletions: string[] = [];
    let deletedObjects = 0;
    for (const row of collectible) {
      const path = objectPath(this.objectsDir, row.hash);
      try {
        if (existsSync(path)) unlinkSync(path);
        const deletion = this.db.prepare("DELETE FROM blobs WHERE hash = ?").run(row.hash);
        if (deletion.changes === 1) deletedObjects += 1;
        removeEmptyObjectDirectories(path);
      } catch {
        // Metadata remains the retry marker when filesystem cleanup cannot complete.
        failedObjectDeletions.push(row.hash);
      }
    }

    return this.diagnostic({
      before,
      prunedReceipts: pruned.receipts,
      prunedResolvedConflicts: pruned.resolvedConflicts,
      reachable,
      missingReachableObjects: [],
      failedObjectDeletions,
      deletedObjects,
      blockedReason:
        failedObjectDeletions.length > 0
          ? "one or more unreachable object files could not be removed"
          : null,
    });
  }

  private diagnostic(input: {
    before: RetentionCounts;
    prunedReceipts: number;
    prunedResolvedConflicts: number;
    reachable: ReadonlySet<string>;
    missingReachableObjects: readonly string[];
    failedObjectDeletions: readonly string[];
    deletedObjects: number;
    blockedReason: string | null;
  }): WhiteboardRetentionDiagnostic {
    const after = this.counts();
    const objects = this.whiteboardObjects();
    const reachableObjects = objects.filter((row) => input.reachable.has(row.hash)).length;
    return {
      protocol: WHITEBOARD_RETENTION_PROTOCOL,
      status: input.blockedReason === null ? "ok" : "blocked",
      policy: this.policy,
      before: input.before,
      after,
      reachableObjects,
      retainedUnreferencedObjects: objects.length - reachableObjects,
      deletedObjects: input.deletedObjects,
      prunedReceipts: input.prunedReceipts,
      prunedResolvedConflicts: input.prunedResolvedConflicts,
      missingReachableObjects: input.missingReachableObjects,
      failedObjectDeletions: input.failedObjectDeletions,
      blockedReason: input.blockedReason,
    };
  }

  private blocked(
    before: RetentionCounts,
    reason: string,
    prunedReceipts = 0,
    prunedResolvedConflicts = 0,
  ): WhiteboardRetentionDiagnostic {
    return this.diagnostic({
      before,
      prunedReceipts,
      prunedResolvedConflicts,
      reachable: new Set(),
      missingReachableObjects: [],
      failedObjectDeletions: [],
      deletedObjects: 0,
      blockedReason: `retention root scan failed: ${reason}`,
    });
  }

  private counts(): RetentionCounts {
    const objects = this.whiteboardObjects().length;
    const receipts = count(this.db, "SELECT COUNT(*) AS count FROM whiteboard_draft_receipts");
    const resolvedConflicts = count(
      this.db,
      "SELECT COUNT(*) AS count FROM whiteboard_draft_conflicts WHERE resolved_at IS NOT NULL",
    );
    const unresolvedConflicts = count(
      this.db,
      "SELECT COUNT(*) AS count FROM whiteboard_draft_conflicts WHERE resolved_at IS NULL",
    );
    return { objects, receipts, resolvedConflicts, unresolvedConflicts };
  }

  private whiteboardObjects(): BlobRow[] {
    return this.db
      .prepare(
        `SELECT hash, media_type, created_at FROM blobs
         WHERE media_type IN (?, ?)
         ORDER BY created_at DESC, hash DESC`,
      )
      .all(WHITEBOARD_SCENE_MEDIA_TYPE, WHITEBOARD_INDEX_MEDIA_TYPE) as BlobRow[];
  }
}

function collectReachableHashes(db: Db): Set<string> {
  const reachable = new Set<string>();
  const drafts = db
    .prepare("SELECT scene_hash, element_index_hash FROM whiteboard_drafts")
    .all() as { scene_hash: string; element_index_hash: string }[];
  for (const row of drafts) {
    addHash(reachable, row.scene_hash);
    addHash(reachable, row.element_index_hash);
  }

  const conflicts = db
    .prepare("SELECT submitted_scene_hash, current_scene_hash FROM whiteboard_draft_conflicts")
    .all() as { submitted_scene_hash: string; current_scene_hash: string }[];
  for (const row of conflicts) {
    addHash(reachable, row.submitted_scene_hash);
    addHash(reachable, row.current_scene_hash);
  }

  const revisions = db.prepare("SELECT entry_hash, files_json FROM p_revisions").all() as {
    entry_hash: string;
    files_json: string;
  }[];
  for (const row of revisions) {
    addHash(reachable, row.entry_hash);
    collectJsonHashes(row.files_json, "p_revisions.files_json", reachable);
  }

  const jsonRoots: readonly Readonly<{ sql: string; field: string; label: string }>[] = [
    {
      sql: "SELECT attachments_json AS value FROM p_chat",
      field: "value",
      label: "p_chat.attachments_json",
    },
    {
      sql: "SELECT payload_json AS value FROM events",
      field: "value",
      label: "events.payload_json",
    },
    {
      sql: "SELECT response_json AS value FROM command_receipts",
      field: "value",
      label: "command_receipts.response_json",
    },
    {
      sql: "SELECT response_json AS value FROM whiteboard_draft_receipts",
      field: "value",
      label: "whiteboard_draft_receipts.response_json",
    },
  ];
  for (const root of jsonRoots) {
    const rows = db.prepare(root.sql).all() as Record<string, string>[];
    for (const row of rows) collectJsonHashes(row[root.field] ?? "", root.label, reachable);
  }
  return reachable;
}

function collectJsonHashes(json: string, label: string, target: Set<string>): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${label} contains invalid JSON`);
  }
  const pending: unknown[] = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      addHash(target, value);
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === "object") {
      pending.push(...Object.values(value as Record<string, unknown>));
    }
  }
}

function addHash(target: Set<string>, candidate: string): void {
  if (CONTENT_HASH.test(candidate)) target.add(candidate);
}

function count(db: Db, sql: string): number {
  return (db.prepare(sql).get() as { count: number }).count;
}

function validatePolicy(policy: WhiteboardRetentionPolicy): WhiteboardRetentionPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`whiteboard retention policy ${name} must be a non-negative safe integer`);
    }
  }
  if (policy.maxReceiptsPerArtifact < 1 || policy.maxUnresolvedConflictsPerArtifact < 1) {
    throw new Error(
      "whiteboard retention must preserve at least one receipt and unresolved conflict",
    );
  }
  return Object.freeze({ ...policy });
}

function removeEmptyObjectDirectories(path: string): void {
  for (const directory of [dirname(path), dirname(dirname(path))]) {
    try {
      rmdirSync(directory);
    } catch {
      // A non-empty directory is the normal case; only empty hash buckets are retired.
    }
  }
}
