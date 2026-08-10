import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../src/storage/sqlite/db.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import { WhiteboardDraftStore } from "../../src/whiteboard/drafts.js";
import type { WhiteboardError } from "../../src/whiteboard/errors.js";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

afterEach(() => db.close());

function write(
  store: WhiteboardDraftStore,
  overrides: Partial<Parameters<WhiteboardDraftStore["put"]>[0]> = {},
) {
  return store.put({
    artifactId: "artifact_board",
    draftId: "draft_1",
    baseRevisionId: "rev_1",
    expectedDraftVersion: 0,
    sceneHash: "a".repeat(64),
    elementIndexHash: "1".repeat(64),
    actor: { kind: "agent", id: "agent-a" },
    clientId: "client-a",
    clientSequence: 1,
    requestHash: "request-1",
    ...overrides,
  });
}

describe("whiteboard draft CAS storage", () => {
  it("returns one lost-response receipt and rejects sequence reuse with different bytes", () => {
    const store = new WhiteboardDraftStore(db, {
      now: () => "2026-08-04T10:00:00.000Z",
      newConflictId: () => "conflict_1",
    });
    const first = write(store);
    const replay = write(store);
    expect(first).toEqual(replay);
    expect(first).toMatchObject({ status: "accepted", draftVersion: 1 });
    expect(() =>
      write(store, { sceneHash: "b".repeat(64), requestHash: "different" }),
    ).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({
        code: "whiteboard.draft-idempotency-conflict",
      }),
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_draft_receipts").get()).toEqual({
      count: 1,
    });
  });

  it("makes one writer win, retains both scene hashes, and resolves by a new CAS", () => {
    let conflictNumber = 0;
    const store = new WhiteboardDraftStore(db, {
      now: () => "2026-08-04T10:00:00.000Z",
      newConflictId: () => `conflict_${++conflictNumber}`,
    });
    write(store);
    const winner = write(store, {
      expectedDraftVersion: 1,
      sceneHash: "b".repeat(64),
      elementIndexHash: "2".repeat(64),
      actor: { kind: "human", id: "browser" },
      clientId: "browser",
      clientSequence: 1,
      requestHash: "browser-v2",
    });
    expect(winner).toMatchObject({ status: "accepted", draftVersion: 2 });

    const loser = write(store, {
      expectedDraftVersion: 1,
      sceneHash: "c".repeat(64),
      elementIndexHash: "3".repeat(64),
      clientId: "agent-b",
      clientSequence: 1,
      requestHash: "agent-stale",
    });
    expect(loser).toEqual({
      protocol: "tweakloop.whiteboard-draft/v1",
      status: "conflict",
      code: "whiteboard.draft-conflict",
      conflictId: "conflict_1",
      artifactId: "artifact_board",
      draftId: "draft_1",
      baseRevisionId: "rev_1",
      expectedDraftVersion: 1,
      currentDraftVersion: 2,
      submittedSceneHash: "c".repeat(64),
      currentSceneHash: "b".repeat(64),
    });
    expect(store.listConflicts("artifact_board")[0]).toMatchObject({
      conflictId: "conflict_1",
      submittedSceneHash: "c".repeat(64),
      currentSceneHash: "b".repeat(64),
      resolution: null,
    });

    const resolved = write(store, {
      expectedDraftVersion: 2,
      sceneHash: "d".repeat(64),
      elementIndexHash: "4".repeat(64),
      clientId: "agent-b",
      clientSequence: 2,
      requestHash: "merged-v3",
      resolutionConflictId: "conflict_1",
    });
    expect(resolved).toMatchObject({ status: "accepted", draftVersion: 3 });
    expect(store.listConflicts("artifact_board")[0]).toMatchObject({
      resolution: { status: "resolved", draftVersion: 3, sceneHash: "d".repeat(64) },
      resolvedAt: "2026-08-04T10:00:00.000Z",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("reconciles a committed head after a crash before the draft cleanup marker", () => {
    const store = new WhiteboardDraftStore(db, {
      now: () => "2026-08-04T10:00:00.000Z",
    });
    const draft = write(store);
    expect(draft).toMatchObject({ publishedRevisionId: null });
    db.prepare(
      `INSERT INTO p_revisions (
         revision_id, artifact_id, parent_id, seq, format, entry_path, entry_hash,
         files_json, producer_json, source_path, created_seq
       ) VALUES (?, ?, NULL, 1, 'whiteboard', 'board.excalidraw', ?, '[]', '{}', NULL, 1)`,
    ).run("rev_published", "artifact_board", "a".repeat(64));

    expect(store.reconcilePublishedDrafts()).toBe(1);
    expect(store.get("artifact_board")).toMatchObject({
      sceneHash: "a".repeat(64),
      publishedRevisionId: "rev_published",
    });
  });

  it("rejects a pruned stale client sequence instead of reporting an unchanged success", () => {
    const store = new WhiteboardDraftStore(db);
    write(store);
    write(store, {
      expectedDraftVersion: 1,
      sceneHash: "b".repeat(64),
      elementIndexHash: "2".repeat(64),
      clientSequence: 2,
      requestHash: "request-2",
    });
    db.prepare(
      `DELETE FROM whiteboard_draft_receipts
       WHERE artifact_id = 'artifact_board' AND client_id = 'client-a' AND client_sequence = 1`,
    ).run();

    expect(() =>
      write(store, {
        expectedDraftVersion: 2,
        sceneHash: "b".repeat(64),
        elementIndexHash: "2".repeat(64),
        clientSequence: 1,
        requestHash: "request-1",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({
        code: "whiteboard.draft-stale-sequence",
      }),
    );
    expect(store.get("artifact_board")).toMatchObject({ draftVersion: 2 });
  });

  it("caps unresolved stale-write conflicts instead of retaining attacker-shaped growth", () => {
    let conflictNumber = 0;
    const store = new WhiteboardDraftStore(db, {
      maxUnresolvedConflicts: 1,
      newConflictId: () => `conflict_${++conflictNumber}`,
    });
    write(store);
    write(store, {
      expectedDraftVersion: 1,
      sceneHash: "b".repeat(64),
      elementIndexHash: "2".repeat(64),
      clientId: "winner",
      requestHash: "winner",
    });
    expect(
      write(store, {
        expectedDraftVersion: 1,
        sceneHash: "c".repeat(64),
        elementIndexHash: "3".repeat(64),
        clientId: "loser-1",
        requestHash: "loser-1",
      }),
    ).toMatchObject({ status: "conflict" });

    expect(() =>
      write(store, {
        expectedDraftVersion: 1,
        sceneHash: "d".repeat(64),
        elementIndexHash: "4".repeat(64),
        clientId: "loser-2",
        requestHash: "loser-2",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({ code: "whiteboard.conflict-limit" }),
    );
    expect(store.listConflicts("artifact_board")).toHaveLength(1);
  });
});
