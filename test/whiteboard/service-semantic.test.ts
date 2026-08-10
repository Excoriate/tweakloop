import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createTransactor,
  type Transactor,
  type TransactorTransactionHooks,
} from "../../src/daemon/transactor.js";
import { COMMAND_PROTOCOL } from "../../src/protocol/versions.js";
import { putObject } from "../../src/storage/object-store/index.js";
import type { Db } from "../../src/storage/sqlite/db.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import type { DraftInvalidation } from "../../src/whiteboard/draft-hub.js";
import { WhiteboardDraftStore } from "../../src/whiteboard/drafts.js";
import {
  canonicalizeWhiteboardScene,
  WHITEBOARD_INDEX_MEDIA_TYPE,
  WHITEBOARD_SCENE_MEDIA_TYPE,
} from "../../src/whiteboard/scene.js";
import {
  SEMANTIC_SCENE_REQUEST_PROTOCOL,
  type SemanticSceneRequest,
} from "../../src/whiteboard/semantic-scene.js";
import { createWhiteboardService } from "../../src/whiteboard/service.js";
import { createRuntimeAuthorityFixture, TEST_AUTOMATION_NOW } from "./runtime-authority-fixture.js";

let db: Db;
let objectsDir: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  objectsDir = mkdtempSync(join(tmpdir(), "tweakloop-semantic-service-"));
});

afterEach(() => {
  db.close();
  rmSync(objectsDir, { recursive: true, force: true });
});

function seedArtifact(label: string | null = null) {
  const scene = canonicalizeWhiteboardScene(
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://tweakloop.local",
      elements:
        label === null
          ? []
          : [
              {
                id: `unmanaged-${label}`,
                type: "text",
                x: 20,
                y: 20,
                width: 100,
                height: 30,
                version: 1,
                versionNonce: 1,
                seed: 1,
                text: label,
              },
            ],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  );
  const recordedAt = "2026-08-08T00:00:00.000Z";
  const sceneHash = putObject(objectsDir, db, scene.bytes, WHITEBOARD_SCENE_MEDIA_TYPE, recordedAt);
  const elementIndexHash = putObject(
    objectsDir,
    db,
    scene.elementIndexBytes,
    WHITEBOARD_INDEX_MEDIA_TYPE,
    recordedAt,
  );
  return { sceneHash, elementIndexHash };
}

function seedProjection(base: { sceneHash: string; elementIndexHash: string }): void {
  db.prepare(
    `INSERT INTO p_artifacts (artifact_id, name, format, source_path, registered_seq)
     VALUES ('artifact-board', 'board.excalidraw', 'whiteboard', 'board.excalidraw', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO p_revisions (
       revision_id, artifact_id, parent_id, seq, format, entry_path, entry_hash,
       files_json, producer_json, source_path, created_seq
     ) VALUES ('revision-base', 'artifact-board', NULL, 1, 'whiteboard',
       'board.excalidraw', ?, ?, '{}', 'board.excalidraw', 1)`,
  ).run(
    base.sceneHash,
    JSON.stringify([
      {
        path: "board.excalidraw",
        hash: base.sceneHash,
        mediaType: WHITEBOARD_SCENE_MEDIA_TYPE,
      },
      {
        path: ".tweakloop/elements.json",
        hash: base.elementIndexHash,
        mediaType: WHITEBOARD_INDEX_MEDIA_TYPE,
      },
    ]),
  );
}

function nonExecutingTransactor(onExecute: () => never): Transactor {
  return {
    execute: onExecute,
    executeWithTransactionHooks: (_input: unknown, hooks: TransactorTransactionHooks) =>
      hooks.beforeMutation() ?? onExecute(),
  } as unknown as Transactor;
}

function request(): SemanticSceneRequest {
  return {
    protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
    artifactId: "artifact-board",
    idempotencyKey: "semantic-service-1",
    operations: [{ type: "node.upsert", semanticKey: "api", label: "API" }],
  };
}

describe("whiteboard semantic service integration", () => {
  it("publishes the stable invalidation after commit and publishes it again on exact replay", () => {
    const base = seedArtifact();
    seedProjection(base);
    const authority = createRuntimeAuthorityFixture(db, {
      workspaceId: "workspace-service",
      daemonStartNonce: "in-process-daemon",
    });
    const service = createWhiteboardService({
      db,
      objectsDir,
      workspaceId: "workspace-service",
      transactor: nonExecutingTransactor(() => {
        throw new Error("semantic drafts must not enter the domain transactor");
      }),
      now: () => "2026-08-08T00:00:00.000Z",
      nowMs: () => TEST_AUTOMATION_NOW,
    });
    const observed: DraftInvalidation[] = [];
    const unsubscribe = service.hub.subscribe("artifact-board", (value) => observed.push(value));
    const semanticRequest = request();
    const first = service.applySceneCommands({
      request: semanticRequest,
      automationToken: authority.tokenFor(semanticRequest),
    });
    const replay = service.applySceneCommands({
      request: semanticRequest,
      automationToken: authority.tokenFor(semanticRequest),
    });
    unsubscribe();

    expect(replay).toMatchObject({ status: "replayed", responseJson: first.responseJson });
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(observed[0]);
    expect(observed[0]).toMatchObject({
      artifactId: "artifact-board",
      draftVersion: 1,
      sceneHash: first.response.sceneHash,
      updatedBy: { kind: "agent", id: "codex" },
    });
    expect(service.getDraft("artifact-board")).toMatchObject({
      draftVersion: 1,
      sceneHash: first.response.sceneHash,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
  });

  it("re-reads the pinned draft inside the publication transaction and creates no revision when stale", () => {
    const base = seedArtifact();
    const draftScene = seedArtifact("draft");
    seedProjection(base);
    const drafts = new WhiteboardDraftStore(db, {
      now: () => "2026-08-08T00:00:00.000Z",
    });
    drafts.put({
      artifactId: "artifact-board",
      draftId: "draft-board",
      baseRevisionId: "revision-base",
      expectedDraftVersion: 0,
      sceneHash: draftScene.sceneHash,
      elementIndexHash: draftScene.elementIndexHash,
      actor: { kind: "agent", id: "codex" },
      clientId: "fixture",
      clientSequence: 1,
      requestHash: "fixture-request",
    });
    let transactorCalls = 0;
    const service = createWhiteboardService({
      db,
      objectsDir,
      workspaceId: "workspace-service",
      transactor: nonExecutingTransactor(() => {
        transactorCalls += 1;
        throw new Error("stale publication must not enter the domain transactor");
      }),
      publicationRaceInjection: () => {
        db.prepare(
          `UPDATE whiteboard_drafts SET draft_version = 2
           WHERE artifact_id = 'artifact-board' AND draft_id = 'draft-board'`,
        ).run();
      },
    });
    const result = service.publishDraft({
      commandId: "command-publish",
      idempotencyKey: "publish-semantic-stale",
      artifactId: "artifact-board",
      draftId: "draft-board",
      expectedDraftVersion: 1,
      expectedHeadRevisionId: "revision-base",
      revisionId: "revision-new",
      actor: { kind: "agent", id: "codex" },
    });
    expect(result).toMatchObject({
      status: "rejected",
      code: "whiteboard.publish-stale-draft",
    });
    expect(transactorCalls).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM p_revisions").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({
      count: 0,
    });
  });

  it("does not publish effects or retain events and receipts when an after-receipt hook aborts", () => {
    const visible: unknown[] = [];
    const transactor = createTransactor({
      db,
      workspaceId: "workspace-service",
      newEventId: () => "event-must-rollback",
      now: () => "2026-08-08T00:00:00.000Z",
      onCommitted: (events) => visible.push(...events),
    });

    expect(() =>
      transactor.executeWithTransactionHooks(
        {
          protocol: COMMAND_PROTOCOL,
          commandId: "command-must-rollback",
          idempotencyKey: "idempotency-must-rollback",
          workspaceId: "workspace-service",
          actor: { kind: "system", id: "daemon" },
          type: "workspace.open",
          payload: { projectId: "project-service", rootPath: "/workspace/service" },
        },
        {
          beforeMutation: () => null,
          afterAccepted: () => {
            expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
            expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({
              count: 1,
            });
            expect(visible).toHaveLength(0);
            throw new Error("injected outer publication abort");
          },
        },
      ),
    ).toThrow(/injected outer publication abort/);
    expect(visible).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({
      count: 0,
    });
  });

  it("rolls back the complete publication and emits nothing when its final hook fails", () => {
    const base = seedArtifact();
    const draftScene = seedArtifact("draft-abort");
    const visible: unknown[] = [];
    let eventSerial = 0;
    const transactor = createTransactor({
      db,
      workspaceId: "workspace-service",
      newEventId: () => `event-publication-${++eventSerial}`,
      now: () => "2026-08-08T00:00:00.000Z",
      onCommitted: (events) => visible.push(...events),
    });
    expect(
      transactor.execute({
        protocol: COMMAND_PROTOCOL,
        commandId: "command-register-board",
        idempotencyKey: "register-board",
        workspaceId: "workspace-service",
        actor: { kind: "agent", id: "codex" },
        type: "artifact.register",
        payload: {
          artifactId: "artifact-board",
          name: "board.excalidraw",
          format: "whiteboard",
          sourcePath: "/workspace/board.excalidraw",
        },
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      transactor.execute({
        protocol: COMMAND_PROTOCOL,
        commandId: "command-publish-base",
        idempotencyKey: "publish-base",
        workspaceId: "workspace-service",
        actor: { kind: "agent", id: "codex" },
        type: "artifact.publish",
        payload: {
          artifactId: "artifact-board",
          revisionId: "revision-base",
          format: "whiteboard",
          entryPath: "board.excalidraw",
          entryHash: base.sceneHash,
          files: [
            {
              path: "board.excalidraw",
              hash: base.sceneHash,
              mediaType: WHITEBOARD_SCENE_MEDIA_TYPE,
            },
            {
              path: ".tweakloop/elements.json",
              hash: base.elementIndexHash,
              mediaType: WHITEBOARD_INDEX_MEDIA_TYPE,
            },
          ],
          producer: { kind: "agent", id: "codex" },
          sourcePath: "/workspace/board.excalidraw",
        },
      }),
    ).toMatchObject({ status: "accepted" });
    new WhiteboardDraftStore(db, {
      now: () => "2026-08-08T00:00:00.000Z",
    }).put({
      artifactId: "artifact-board",
      draftId: "draft-board",
      baseRevisionId: "revision-base",
      expectedDraftVersion: 0,
      sceneHash: draftScene.sceneHash,
      elementIndexHash: draftScene.elementIndexHash,
      actor: { kind: "agent", id: "codex" },
      clientId: "fixture",
      clientSequence: 1,
      requestHash: "fixture-request-abort",
    });
    const visibleBefore = visible.length;
    const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM events").get();
    const receiptsBefore = db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get();
    const service = createWhiteboardService({
      db,
      objectsDir,
      workspaceId: "workspace-service",
      transactor,
      publicationCommitFailureInjection: () => {
        throw new Error("injected final publication failure");
      },
    });

    expect(() =>
      service.publishDraft({
        commandId: "command-publish-abort",
        idempotencyKey: "publish-abort",
        artifactId: "artifact-board",
        draftId: "draft-board",
        expectedDraftVersion: 1,
        expectedHeadRevisionId: "revision-base",
        revisionId: "revision-must-not-exist",
        actor: { kind: "agent", id: "codex" },
      }),
    ).toThrow(/injected final publication failure/);
    expect(visible).toHaveLength(visibleBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(eventsBefore);
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual(
      receiptsBefore,
    );
    expect(db.prepare("SELECT COUNT(*) AS count FROM p_revisions").get()).toEqual({ count: 1 });
    expect(
      db
        .prepare(
          "SELECT published_revision_id FROM whiteboard_drafts WHERE artifact_id = 'artifact-board'",
        )
        .get(),
    ).toEqual({ published_revision_id: null });
  });
});
