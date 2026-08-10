import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { putObject, removeObjectFileIfUntracked } from "../../src/storage/object-store/index.js";
import type { Db } from "../../src/storage/sqlite/db.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import { WhiteboardRetentionMaintainer } from "../../src/whiteboard/retention.js";
import {
  canonicalizeWhiteboardScene,
  WHITEBOARD_INDEX_MEDIA_TYPE,
  WHITEBOARD_SCENE_MEDIA_TYPE,
} from "../../src/whiteboard/scene.js";
import {
  SEMANTIC_SCENE_REQUEST_PROTOCOL,
  type SemanticIdentityAllocator,
  type SemanticSceneRequest,
} from "../../src/whiteboard/semantic-scene.js";
import {
  type SemanticReceiptSnapshot,
  SemanticSceneStore,
} from "../../src/whiteboard/semantic-store.js";
import {
  createRuntimeAuthorityFixture,
  type RuntimeAuthorityFixture,
} from "./runtime-authority-fixture.js";

let db: Db;
let objectsDir: string;
let authority: RuntimeAuthorityFixture;

beforeEach(() => {
  db = openDatabase(":memory:");
  objectsDir = mkdtempSync(join(tmpdir(), "tweakloop-semantic-store-"));
  seedWhiteboard(db, objectsDir);
  authority = createRuntimeAuthorityFixture(db, { workspaceId: "workspace-source" });
});

afterEach(() => {
  db.close();
  rmSync(objectsDir, { recursive: true, force: true });
});

function seedWhiteboard(targetDb: Db, targetObjectsDir: string): void {
  const scene = canonicalizeWhiteboardScene(
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://tweakloop.local",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  );
  const sceneHash = putObject(
    targetObjectsDir,
    targetDb,
    scene.bytes,
    WHITEBOARD_SCENE_MEDIA_TYPE,
    "2026-08-08T00:00:00.000Z",
  );
  const elementIndexHash = putObject(
    targetObjectsDir,
    targetDb,
    scene.elementIndexBytes,
    WHITEBOARD_INDEX_MEDIA_TYPE,
    "2026-08-08T00:00:00.000Z",
  );
  targetDb
    .prepare(
      `INSERT INTO p_artifacts (artifact_id, name, format, source_path, registered_seq)
       VALUES ('artifact-board', 'board.excalidraw', 'whiteboard', 'board.excalidraw', 1)`,
    )
    .run();
  targetDb
    .prepare(
      `INSERT INTO p_revisions (
         revision_id, artifact_id, parent_id, seq, format, entry_path, entry_hash,
         files_json, producer_json, source_path, created_seq
       ) VALUES ('revision-base', 'artifact-board', NULL, 1, 'whiteboard',
         'board.excalidraw', ?, ?, '{}', 'board.excalidraw', 1)`,
    )
    .run(
      sceneHash,
      JSON.stringify([
        {
          path: "board.excalidraw",
          hash: sceneHash,
          mediaType: WHITEBOARD_SCENE_MEDIA_TYPE,
        },
        {
          path: ".tweakloop/elements.json",
          hash: elementIndexHash,
          mediaType: WHITEBOARD_INDEX_MEDIA_TYPE,
        },
      ]),
    );
}

function allocator() {
  let serial = 0;
  let calls = 0;
  const next = (prefix: string): string => {
    calls += 1;
    serial += 1;
    return `${prefix}-${serial}`;
  };
  const value: SemanticIdentityAllocator & Readonly<{ calls: () => number }> = {
    newAnchorId: () => next("anchor"),
    newElementId: () => next("element"),
    newGroupId: () => next("group"),
    newSeed: () => {
      calls += 1;
      serial += 1;
      return serial;
    },
    newVersionNonce: () => {
      calls += 1;
      serial += 1;
      return serial;
    },
    calls: () => calls,
  };
  return value;
}

function request(idempotencyKey: string, label = "API"): SemanticSceneRequest {
  return {
    protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
    artifactId: "artifact-board",
    idempotencyKey,
    operations: [{ type: "node.upsert", semanticKey: "api", label }],
  };
}

function store(
  overrides: Partial<ConstructorParameters<typeof SemanticSceneStore>[1]> = {},
): SemanticSceneStore {
  return new SemanticSceneStore(db, {
    objectsDir,
    workspaceId: "workspace-source",
    authorityStore: authority.authorityStore,
    now: () => "2026-08-08T00:00:00.000Z",
    newDraftId: () => "draft-semantic",
    ...overrides,
  });
}

function physicalObjectFileCount(path: string): number {
  let count = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) count += physicalObjectFileCount(child);
    else count += 1;
  }
  return count;
}

describe("durable semantic whiteboard receipt store", () => {
  it("commits pointer and one lifetime receipt atomically, then replays after restart and 128 later operations", () => {
    const ids = allocator();
    const firstStore = store();
    const originalRequest = request("semantic-first");
    const original = firstStore.apply(originalRequest, authority.tokenFor(originalRequest), ids);
    expect(original).toMatchObject({
      status: "applied",
      response: { draftVersion: 1, unchanged: false },
      invalidation: { draftId: "draft-semantic", draftVersion: 1 },
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });

    for (let index = 0; index < 129; index += 1) {
      const laterRequest = request(`semantic-later-${index}`, `API ${index}`);
      firstStore.apply(laterRequest, authority.tokenFor(laterRequest), ids);
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_semantic_receipts").get()).toEqual({
      count: 130,
    });
    new WhiteboardRetentionMaintainer(db, objectsDir).run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_semantic_receipts").get()).toEqual({
      count: 130,
    });

    const callsBeforeReplay = ids.calls();
    const restarted = store();
    const replay = restarted.apply(originalRequest, authority.tokenFor(originalRequest), ids);
    expect(replay).toMatchObject({
      status: "replayed",
      responseJson: original.responseJson,
      invalidation: {
        draftId: "draft-semantic",
        draftVersion: 1,
        deduplicationKey: `artifact-board:1:${original.response.sceneHash}`,
      },
    });
    expect(ids.calls()).toBe(callsBeforeReplay);
    const conflictingRequest = request("semantic-first", "different payload");
    expect(() =>
      restarted.apply(conflictingRequest, authority.tokenFor(conflictingRequest), ids),
    ).toThrow(/idempotency key was already used/);
  });

  it("rolls back the draft pointer when receipt insertion cannot complete", () => {
    const filesBefore = physicalObjectFileCount(objectsDir);
    let cleanupCalls = 0;
    const failing = store({
      failureInjection: () => {
        throw new Error("injected receipt failure");
      },
      removeUntrackedObjectFile: (hash) => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) throw new Error("transient first cleanup failure");
        return removeObjectFileIfUntracked(objectsDir, db, hash);
      },
    });
    const failingRequest = request("semantic-fail");
    const failingToken = authority.tokenFor(failingRequest);
    expect(() => failing.apply(failingRequest, failingToken, allocator())).toThrow(
      /injected receipt failure/,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_drafts").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_semantic_receipts").get()).toEqual({
      count: 0,
    });
    expect(physicalObjectFileCount(objectsDir)).toBe(filesBefore);
    expect(cleanupCalls).toBe(3);
    expect(
      db
        .prepare(
          `SELECT used_at FROM runtime_whiteboard_automation_tokens
           WHERE token_hash = ?`,
        )
        .get(createHash("sha256").update(failingToken).digest("hex")),
    ).toEqual({ used_at: null });
  });

  it("fails closed when the stored draft index no longer matches its scene", () => {
    const semanticStore = store();
    const sourceRequest = request("semantic-index-source");
    semanticStore.apply(sourceRequest, authority.tokenFor(sourceRequest), allocator());
    const before = db
      .prepare(
        "SELECT draft_version, scene_hash, element_index_hash FROM whiteboard_drafts WHERE artifact_id = ?",
      )
      .get("artifact-board");
    db.prepare("UPDATE whiteboard_drafts SET element_index_hash = ? WHERE artifact_id = ?").run(
      "f".repeat(64),
      "artifact-board",
    );

    const noAllocation = allocator();
    const filesBefore = physicalObjectFileCount(objectsDir);
    const corruptRequest = request("semantic-index-must-not-repair", "must not land");
    expect(() =>
      semanticStore.apply(corruptRequest, authority.tokenFor(corruptRequest), noAllocation),
    ).toThrow(/scene and element index do not describe the same semantic projection/);
    expect(noAllocation.calls()).toBe(0);
    expect(physicalObjectFileCount(objectsDir)).toBe(filesBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_semantic_receipts").get()).toEqual({
      count: 1,
    });
    expect(
      db
        .prepare("SELECT draft_version, scene_hash FROM whiteboard_drafts WHERE artifact_id = ?")
        .get("artifact-board"),
    ).toEqual({
      draft_version: (before as { draft_version: number }).draft_version,
      scene_hash: (before as { scene_hash: string }).scene_hash,
    });
  });

  it("fails before allocation when a published revision points at the wrong element index", () => {
    const revision = db
      .prepare("SELECT files_json FROM p_revisions WHERE revision_id = ?")
      .get("revision-base") as { files_json: string };
    const files = JSON.parse(revision.files_json) as { path: string; hash: string }[];
    const corrupt = files.map((file) =>
      file.path === ".tweakloop/elements.json" ? { ...file, hash: "f".repeat(64) } : file,
    );
    db.prepare("UPDATE p_revisions SET files_json = ? WHERE revision_id = ?").run(
      JSON.stringify(corrupt),
      "revision-base",
    );
    const noAllocation = allocator();
    const filesBefore = physicalObjectFileCount(objectsDir);
    const corruptRequest = request("semantic-published-index-must-not-repair");

    expect(() =>
      store().apply(corruptRequest, authority.tokenFor(corruptRequest), noAllocation),
    ).toThrow(/scene and element index do not describe the same semantic projection/);
    expect(noAllocation.calls()).toBe(0);
    expect(physicalObjectFileCount(objectsDir)).toBe(filesBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_drafts").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM whiteboard_semantic_receipts").get()).toEqual({
      count: 0,
    });
  });

  it("exports by table traversal and restores destination-rescoped exact response bytes", () => {
    const sourceStore = store();
    const portableRequest = request("semantic-portable");
    const original = sourceStore.apply(
      portableRequest,
      authority.tokenFor(portableRequest),
      allocator(),
    );
    const snapshots = JSON.parse(
      JSON.stringify(sourceStore.listReceiptSnapshots()),
    ) as SemanticReceiptSnapshot[];

    const destinationDb = openDatabase(":memory:");
    const destinationObjects = mkdtempSync(join(tmpdir(), "tweakloop-semantic-destination-"));
    try {
      const destinationAuthority = createRuntimeAuthorityFixture(destinationDb, {
        workspaceId: "workspace-destination",
      });
      const destination = new SemanticSceneStore(destinationDb, {
        objectsDir: destinationObjects,
        workspaceId: "workspace-destination",
        authorityStore: destinationAuthority.authorityStore,
      });
      destination.restoreReceiptSnapshots(snapshots, () => "draft-destination");
      const restored = destination.getReceiptForKey("artifact-board", "semantic-portable");
      expect(restored).toMatchObject({
        draftId: "draft-destination",
        receipt: {
          workspaceId: "workspace-destination",
          responseJson: original.responseJson,
          sourceProvenance: { workspaceId: "workspace-source" },
        },
      });
      const noAllocation = allocator();
      const replay = destination.apply(
        portableRequest,
        destinationAuthority.tokenFor(portableRequest),
        noAllocation,
      );
      expect(replay).toMatchObject({
        status: "replayed",
        responseJson: original.responseJson,
        invalidation: { draftId: "draft-destination" },
      });
      expect(noAllocation.calls()).toBe(0);
    } finally {
      destinationDb.close();
      rmSync(destinationObjects, { recursive: true, force: true });
    }
  });
});

import { createHash } from "node:crypto";
