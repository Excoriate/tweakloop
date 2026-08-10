import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { objectPath, putObject, readObject } from "../../src/storage/object-store/index.js";
import type { Db } from "../../src/storage/sqlite/db.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import {
  WhiteboardRetentionMaintainer,
  type WhiteboardRetentionPolicy,
} from "../../src/whiteboard/retention.js";
import {
  WHITEBOARD_INDEX_MEDIA_TYPE,
  WHITEBOARD_SCENE_MEDIA_TYPE,
} from "../../src/whiteboard/scene.js";

let db: Db;
let objectsDir: string;

const policy: WhiteboardRetentionPolicy = {
  maxReceiptsPerArtifact: 2,
  maxResolvedConflictsPerArtifact: 1,
  maxUnresolvedConflictsPerArtifact: 2,
  maxUnreferencedObjects: 1,
};

beforeEach(() => {
  db = openDatabase(":memory:");
  objectsDir = mkdtempSync(join(tmpdir(), "tweakloop-whiteboard-retention-"));
});

afterEach(() => {
  db.close();
  rmSync(objectsDir, { recursive: true, force: true });
});

function object(label: string, mediaType = WHITEBOARD_SCENE_MEDIA_TYPE, sequence = 1): string {
  return putObject(
    objectsDir,
    db,
    Buffer.from(label),
    mediaType,
    `2026-08-04T10:00:${String(sequence).padStart(2, "0")}.000Z`,
  );
}

function insertPublishedEvent(sceneHash: string, indexHash: string): void {
  db.prepare(
    `INSERT INTO events (
       event_id, workspace_id, stream_type, stream_id, stream_version, event_type,
       schema_version, recorded_at, actor_json, payload_json
     ) VALUES (?, 'workspace', 'artifact', 'artifact_board', 1, 'artifact.revision-published',
       1, '2026-08-04T10:00:00.000Z', '{}', ?)`,
  ).run(
    "event_published",
    JSON.stringify({
      revisionId: "revision_immutable",
      entryHash: sceneHash,
      files: [
        { path: "board.excalidraw", hash: sceneHash },
        { path: ".tweakloop/elements.json", hash: indexHash },
      ],
    }),
  );
}

function insertDraft(sceneHash: string, indexHash: string): void {
  db.prepare(
    `INSERT INTO whiteboard_drafts (
       artifact_id, draft_id, base_revision_id, scene_hash, element_index_hash,
       draft_version, updated_by_json, updated_at, client_id, client_sequence
     ) VALUES ('artifact_board', 'draft_current', 'revision_immutable', ?, ?, 5,
       '{}', '2026-08-04T10:00:10.000Z', 'client', 5)`,
  ).run(sceneHash, indexHash);
}

describe("whiteboard reachability retention", () => {
  it("bounds ephemeral growth while event-rooted revisions and current draft bytes stay immutable", () => {
    const publishedScene = object("published-scene", WHITEBOARD_SCENE_MEDIA_TYPE, 1);
    const publishedIndex = object("published-index", WHITEBOARD_INDEX_MEDIA_TYPE, 2);
    insertPublishedEvent(publishedScene, publishedIndex);

    const currentScene = object("current-scene", WHITEBOARD_SCENE_MEDIA_TYPE, 3);
    const currentIndex = object("current-index", WHITEBOARD_INDEX_MEDIA_TYPE, 4);
    insertDraft(currentScene, currentIndex);

    const receiptHashes = Array.from({ length: 4 }, (_, index) =>
      object(`receipt-${index}`, WHITEBOARD_SCENE_MEDIA_TYPE, 10 + index),
    );
    for (const [index, hash] of receiptHashes.entries()) {
      db.prepare(
        `INSERT INTO whiteboard_draft_receipts (
           artifact_id, client_id, client_sequence, request_hash, response_json, recorded_at
         ) VALUES ('artifact_board', 'client', ?, ?, ?, ?)`,
      ).run(
        index + 10,
        `${index}`.repeat(64).slice(0, 64),
        JSON.stringify({ status: "accepted", sceneHash: hash }),
        `2026-08-04T10:01:${String(index).padStart(2, "0")}.000Z`,
      );
    }

    const unresolved = object("unresolved-conflict", WHITEBOARD_SCENE_MEDIA_TYPE, 20);
    db.prepare(
      `INSERT INTO whiteboard_draft_conflicts (
         conflict_id, artifact_id, draft_id, expected_version, current_version,
         submitted_scene_hash, current_scene_hash, submitted_by_json, created_at
       ) VALUES ('conflict_open', 'artifact_board', 'draft_current', 4, 5, ?, ?, '{}',
         '2026-08-04T10:02:00.000Z')`,
    ).run(unresolved, currentScene);

    const resolvedHashes = [
      object("resolved-old", WHITEBOARD_SCENE_MEDIA_TYPE, 21),
      object("resolved-new", WHITEBOARD_SCENE_MEDIA_TYPE, 22),
    ];
    for (const [index, hash] of resolvedHashes.entries()) {
      db.prepare(
        `INSERT INTO whiteboard_draft_conflicts (
           conflict_id, artifact_id, draft_id, expected_version, current_version,
           submitted_scene_hash, current_scene_hash, submitted_by_json, created_at,
           resolution, resolved_at
         ) VALUES (?, 'artifact_board', 'draft_current', 4, 5, ?, ?, '{}', ?, '{}', ?)`,
      ).run(
        `conflict_resolved_${index}`,
        hash,
        currentScene,
        `2026-08-04T10:03:0${index}.000Z`,
        `2026-08-04T10:03:0${index}.000Z`,
      );
    }
    const unrelated = [
      object("orphan-a", WHITEBOARD_SCENE_MEDIA_TYPE, 30),
      object("orphan-b", WHITEBOARD_SCENE_MEDIA_TYPE, 31),
    ];

    const maintainer = new WhiteboardRetentionMaintainer(db, objectsDir, policy);
    const result = maintainer.run();

    expect(result).toMatchObject({
      status: "ok",
      policy,
      after: { receipts: 2, resolvedConflicts: 1, unresolvedConflicts: 1 },
      retainedUnreferencedObjects: 1,
      prunedReceipts: 2,
      prunedResolvedConflicts: 1,
    });
    expect(result.deletedObjects).toBeGreaterThanOrEqual(4);
    expect(readObject(objectsDir, publishedScene).toString()).toBe("published-scene");
    expect(readObject(objectsDir, publishedIndex).toString()).toBe("published-index");
    expect(readObject(objectsDir, currentScene).toString()).toBe("current-scene");
    expect(readObject(objectsDir, currentIndex).toString()).toBe("current-index");
    expect(readObject(objectsDir, unresolved).toString()).toBe("unresolved-conflict");
    expect(existsSync(objectPath(objectsDir, receiptHashes[0] as string))).toBe(false);
    expect(existsSync(objectPath(objectsDir, resolvedHashes[0] as string))).toBe(false);
    expect(unrelated.filter((hash) => existsSync(objectPath(objectsDir, hash)))).toHaveLength(1);

    const repeated = maintainer.run();
    expect(repeated).toMatchObject({
      status: "ok",
      deletedObjects: 0,
      prunedReceipts: 0,
      prunedResolvedConflicts: 0,
      after: result.after,
    });
  });

  it("finishes an interrupted unreachable deletion but blocks on missing immutable bytes", () => {
    const interrupted = object("interrupted-orphan", WHITEBOARD_SCENE_MEDIA_TYPE, 1);
    unlinkSync(objectPath(objectsDir, interrupted));

    const recovery = new WhiteboardRetentionMaintainer(db, objectsDir, {
      ...policy,
      maxUnreferencedObjects: 0,
    }).run();
    expect(recovery).toMatchObject({ status: "ok", deletedObjects: 1 });
    expect(db.prepare("SELECT hash FROM blobs WHERE hash = ?").get(interrupted)).toBeUndefined();

    const immutable = object("immutable-but-missing", WHITEBOARD_SCENE_MEDIA_TYPE, 2);
    const orphan = object(
      "must-not-sweep-while-integrity-is-broken",
      WHITEBOARD_SCENE_MEDIA_TYPE,
      3,
    );
    insertPublishedEvent(immutable, object("immutable-index", WHITEBOARD_INDEX_MEDIA_TYPE, 4));
    unlinkSync(objectPath(objectsDir, immutable));

    const blocked = new WhiteboardRetentionMaintainer(db, objectsDir, {
      ...policy,
      maxUnreferencedObjects: 0,
    }).run();
    expect(blocked).toMatchObject({
      status: "blocked",
      deletedObjects: 0,
      missingReachableObjects: [immutable],
    });
    expect(blocked.blockedReason).toContain("reachable whiteboard object bytes are missing");
    expect(existsSync(objectPath(objectsDir, orphan))).toBe(true);
    expect(db.prepare("SELECT hash FROM blobs WHERE hash = ?").get(immutable)).toEqual({
      hash: immutable,
    });
  });
});
