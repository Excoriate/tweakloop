import { describe, expect, it } from "vitest";
import type { WhiteboardError } from "../../src/whiteboard/errors.js";
import { canonicalizeWhiteboardScene } from "../../src/whiteboard/scene.js";
import {
  readSemanticSceneMap,
  SEMANTIC_SCENE_MAP_APP_STATE_KEY,
} from "../../src/whiteboard/semantic-representation.js";
import {
  applySemanticSceneRequest,
  decideSemanticSceneReceipt,
  materializeSemanticDraftInvalidation,
  rescopeSemanticSceneReceipt,
  SEMANTIC_SCENE_REQUEST_PROTOCOL,
  type SemanticDraftTuple,
  type SemanticIdentityAllocator,
  type SemanticSceneCommitCandidate,
  type SemanticSceneReceiptRecord,
  type SemanticSceneRequest,
} from "../../src/whiteboard/semantic-scene.js";

const EMPTY_SCENE = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://tweakloop.local",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

type CountingAllocator = SemanticIdentityAllocator & Readonly<{ calls: () => number }>;

function allocator(): CountingAllocator {
  let sequence = 0;
  const next = (): number => {
    sequence += 1;
    return sequence;
  };
  return {
    newAnchorId: () => `anchor-${next()}`,
    newElementId: () => `element-${next()}`,
    newGroupId: () => `group-${next()}`,
    newSeed: () => next(),
    newVersionNonce: () => next(),
    calls: () => sequence,
  };
}

function request(
  idempotencyKey: string,
  operations: SemanticSceneRequest["operations"],
): SemanticSceneRequest {
  return {
    protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
    artifactId: "artifact-board",
    idempotencyKey,
    operations,
  };
}

function draft(draftVersion = 0): SemanticDraftTuple {
  return {
    artifactId: "artifact-board",
    draftId: "draft-board",
    baseRevisionId: "revision-base",
    draftVersion,
    expectedHeadRevisionId: "revision-base",
  };
}

function apply(
  scene: Buffer | string,
  currentDraft: SemanticDraftTuple,
  semanticRequest: SemanticSceneRequest,
  ids: SemanticIdentityAllocator,
  workspaceId = "workspace-source",
  layoutFrame?: Readonly<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    nodeWidth: number;
    nodeHeight: number;
    gap: number;
  }>,
): SemanticSceneCommitCandidate {
  const authorization = decideSemanticSceneReceipt(null, semanticRequest);
  expect(authorization.status).toBe("apply");
  if (authorization.status !== "apply") throw new Error("expected apply authorization");
  return applySemanticSceneRequest({
    workspaceId,
    currentScene: scene,
    currentDraft,
    actor: { kind: "agent", id: "codex", runId: "local-process-run" },
    authorization,
    allocator: ids,
    ...(layoutFrame ? { layoutFrame } : {}),
  });
}

function mapOf(result: SemanticSceneCommitCandidate) {
  const map = readSemanticSceneMap(result.canonicalScene.scene);
  expect(map).not.toBeNull();
  if (!map) throw new Error("expected semantic map");
  return map;
}

describe("server-owned semantic whiteboard scene", () => {
  it("constructs node, bound edge, group, layout, and collaboration anchors without caller renderer fields", () => {
    const ids = allocator();
    const result = apply(
      EMPTY_SCENE,
      draft(),
      request("scene-create-1", [
        { type: "node.upsert", semanticKey: "api", shape: "rectangle", label: "API" },
        { type: "node.upsert", semanticKey: "db", shape: "ellipse", label: "Database" },
        { type: "edge.upsert", semanticKey: "api-db", from: "api", to: "db", label: "SQL" },
        { type: "group.set", semanticKey: "backend", members: ["api", "db"] },
        { type: "layout.apply", direction: "lr", gap: 96, scope: ["api", "db"] },
      ]),
      ids,
    );

    expect(result.response).toMatchObject({
      status: "accepted",
      idempotencyKey: "scene-create-1",
      draftVersion: 1,
      unchanged: false,
    });
    expect(result.response.changedTargets.map((target) => target.semanticKey)).toEqual([
      "api",
      "api-db",
      "db",
    ]);
    expect(result.response.changedBounds).toEqual({ x: 120, y: 120, width: 576, height: 120 });
    expect(result.invalidation).toMatchObject({
      kind: "whiteboard-draft",
      draftVersion: 1,
      sceneHash: result.response.sceneHash,
    });
    expect("events" in result).toBe(false);

    const map = mapOf(result);
    expect(map.groups.backend).toMatchObject({ members: ["api", "db"] });
    expect(map.entities.api).toMatchObject({
      semanticKey: "api",
      kind: "node",
      anchorId: expect.stringMatching(/^anchor-/),
      elementId: expect.stringMatching(/^element-/),
      deleted: false,
    });
    expect(map.entities["api-db"]).toMatchObject({ from: "api", to: "db", kind: "edge" });

    const scene = result.canonicalScene.scene as {
      elements: Array<Record<string, unknown>>;
    };
    const api = scene.elements.find((element) => element.id === map.entities.api?.elementId);
    const edge = scene.elements.find((element) => element.id === map.entities["api-db"]?.elementId);
    expect(api).toMatchObject({
      type: "rectangle",
      groupIds: [map.groups.backend?.groupId],
      customData: {
        tweakloop: {
          semanticManaged: true,
          semanticKey: "api",
          anchorId: map.entities.api?.anchorId,
          role: "primary",
        },
      },
    });
    expect(edge).toMatchObject({
      type: "arrow",
      startBinding: { elementId: map.entities.api?.elementId },
      endBinding: { elementId: map.entities.db?.elementId },
    });
    expect(
      result.canonicalScene.elementIndex.elements.find(
        (entry) => entry.elementId === map.entities.api?.elementId,
      ),
    ).toMatchObject({
      semanticKey: "api",
      anchorId: map.entities.api?.anchorId,
      semanticRole: "primary",
      semanticRetired: false,
    });
    expect(
      result.canonicalScene.elementIndex.elements.find(
        (entry) => entry.elementId === map.entities.api?.labelElementId,
      ),
    ).toMatchObject({
      semanticKey: "api",
      semanticRole: "label",
      semanticRetired: false,
    });
    expect(
      result.canonicalScene.elementIndex.elements.find(
        (entry) => entry.elementId === map.entities.api?.labelElementId,
      ),
    ).not.toHaveProperty("anchorId");
  });

  it("renders one authoritative locked enclosure, advances it with layout, and replays without allocation", () => {
    const ids = allocator();
    const createRequest = request("group-boundary-create", [
      { type: "node.upsert", semanticKey: "api", placement: { x: 200, y: 200 } },
      { type: "node.upsert", semanticKey: "worker", placement: { x: 600, y: 360 } },
      { type: "group.set", semanticKey: "runtime-zone", members: ["api", "worker"] },
    ]);
    const created = apply(EMPTY_SCENE, draft(), createRequest, ids);
    const createdMap = mapOf(created);
    const createdBoundary = createdMap.groups["runtime-zone"]?.boundary;
    expect(createdBoundary).toMatchObject({
      version: 1,
      bounds: { x: 168, y: 168, width: 704, height: 344 },
    });
    const createdElements = (created.canonicalScene.scene.elements ?? []) as Array<
      Record<string, unknown>
    >;
    const boundaries = createdElements.filter(
      (element) =>
        (element.customData as { tweakloop?: { role?: string } } | undefined)?.tweakloop?.role ===
        "group-boundary",
    );
    expect(boundaries).toHaveLength(1);
    expect(boundaries[0]).toMatchObject({
      id: createdBoundary?.elementId,
      type: "rectangle",
      x: 168,
      y: 168,
      width: 704,
      height: 344,
      groupIds: [],
      locked: true,
      strokeStyle: "dashed",
      customData: {
        tweakloop: {
          semanticKey: "runtime-zone",
          anchorId: createdMap.groups["runtime-zone"]?.groupId,
          role: "group-boundary",
        },
      },
    });
    expect(createdElements.indexOf(boundaries[0] as Record<string, unknown>)).toBeLessThan(
      createdElements.findIndex((element) => element.id === createdMap.entities.api?.elementId),
    );
    expect(
      created.canonicalScene.elementIndex.elements.find(
        (entry) => entry.elementId === createdBoundary?.elementId,
      ),
    ).not.toHaveProperty("semanticKey");

    const callsBeforeReplay = ids.calls();
    expect(decideSemanticSceneReceipt(created.receiptInsert, createRequest)).toMatchObject({
      status: "replay",
      responseJson: created.responseJson,
    });
    expect(ids.calls()).toBe(callsBeforeReplay);

    const laidOut = apply(
      created.canonicalScene.bytes,
      draft(created.response.draftVersion),
      request("group-boundary-layout", [
        { type: "layout.apply", direction: "lr", gap: 120, scope: ["api", "worker"] },
      ]),
      ids,
    );
    const laidOutBoundary = mapOf(laidOut).groups["runtime-zone"]?.boundary;
    expect(laidOutBoundary).toMatchObject({
      elementId: createdBoundary?.elementId,
      seed: createdBoundary?.seed,
      version: 2,
      bounds: { x: 88, y: 88, width: 664, height: 184 },
    });
    expect(laidOutBoundary?.versionNonce).not.toBe(createdBoundary?.versionNonce);
  });

  it("keeps default-layout group members contiguous so an ungrouped node is not visibly enclosed", () => {
    const ids = allocator();
    const created = apply(
      EMPTY_SCENE,
      draft(),
      request("group-boundary-nonmember-create", [
        { type: "node.upsert", semanticKey: "api", label: "API" },
        { type: "node.upsert", semanticKey: "browser", label: "Browser" },
        { type: "node.upsert", semanticKey: "database", label: "Database" },
        {
          type: "group.set",
          semanticKey: "service-runtime",
          members: ["api", "database"],
        },
      ]),
      ids,
    );

    const laidOut = apply(
      created.canonicalScene.bytes,
      draft(created.response.draftVersion),
      request("group-boundary-nonmember-layout", [
        { type: "layout.apply", direction: "lr", gap: 96 },
      ]),
      ids,
    );
    const map = mapOf(laidOut);
    const boundary = map.groups["service-runtime"]?.boundary?.bounds;
    const browser = map.entities.browser?.bounds;
    const api = map.entities.api?.bounds;
    const database = map.entities.database?.bounds;
    if (!boundary || !browser || !api || !database) {
      throw new Error("missing group-layout fixture bounds");
    }

    const isContained = (candidate: typeof browser) =>
      candidate.x >= boundary.x &&
      candidate.y >= boundary.y &&
      candidate.x + candidate.width <= boundary.x + boundary.width &&
      candidate.y + candidate.height <= boundary.y + boundary.height;

    expect(isContained(api)).toBe(true);
    expect(isContained(database)).toBe(true);
    expect(isContained(browser)).toBe(false);
  });

  it("advances the enclosure when membership or enclosed geometry changes without changing its bounds", () => {
    const ids = allocator();
    const created = apply(
      EMPTY_SCENE,
      draft(),
      request("group-boundary-dirty-create", [
        { type: "node.upsert", semanticKey: "left", placement: { x: 200, y: 200 } },
        { type: "node.upsert", semanticKey: "middle", placement: { x: 420, y: 200 } },
        { type: "node.upsert", semanticKey: "replacement", placement: { x: 420, y: 200 } },
        { type: "node.upsert", semanticKey: "right", placement: { x: 700, y: 200 } },
        {
          type: "group.set",
          semanticKey: "dirty-zone",
          members: ["left", "middle", "right"],
        },
      ]),
      ids,
    );
    const createdBoundary = mapOf(created).groups["dirty-zone"]?.boundary;
    if (!createdBoundary) throw new Error("missing dirty boundary fixture");

    const geometryChanged = apply(
      created.canonicalScene.bytes,
      draft(created.response.draftVersion),
      request("group-boundary-inner-geometry", [
        { type: "node.upsert", semanticKey: "middle", placement: { x: 460, y: 200 } },
      ]),
      ids,
    );
    const geometryBoundary = mapOf(geometryChanged).groups["dirty-zone"]?.boundary;
    expect(geometryBoundary).toMatchObject({
      elementId: createdBoundary.elementId,
      seed: createdBoundary.seed,
      version: 2,
      bounds: createdBoundary.bounds,
    });

    const membershipChanged = apply(
      geometryChanged.canonicalScene.bytes,
      draft(geometryChanged.response.draftVersion),
      request("group-boundary-membership", [
        {
          type: "group.set",
          semanticKey: "dirty-zone",
          members: ["left", "replacement", "right"],
        },
      ]),
      ids,
    );
    expect(mapOf(membershipChanged).groups["dirty-zone"]?.boundary).toMatchObject({
      elementId: createdBoundary.elementId,
      seed: createdBoundary.seed,
      version: 3,
      bounds: createdBoundary.bounds,
    });
  });

  it("fails closed when authoritative group boundary bytes are missing, duplicated, or corrupt", () => {
    const ids = allocator();
    const created = apply(
      EMPTY_SCENE,
      draft(),
      request("group-boundary-corruption", [
        { type: "node.upsert", semanticKey: "api" },
        { type: "group.set", semanticKey: "service-zone", members: ["api"] },
      ]),
      ids,
    );
    const boundaryId = mapOf(created).groups["service-zone"]?.boundary?.elementId;
    if (!boundaryId) throw new Error("missing group boundary fixture");

    const missing = JSON.parse(created.canonicalScene.bytes.toString()) as {
      elements: Array<{ id: string }>;
    };
    missing.elements = missing.elements.filter((element) => element.id !== boundaryId);
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(missing))).toThrow(
      /references managed element .* that is missing from the scene/,
    );

    const duplicated = JSON.parse(created.canonicalScene.bytes.toString()) as {
      elements: Array<Record<string, unknown>>;
    };
    const boundaryElement = duplicated.elements.find((element) => element.id === boundaryId);
    if (!boundaryElement) throw new Error("missing group boundary element fixture");
    duplicated.elements.push({ ...boundaryElement, id: `${boundaryId}-duplicate` });
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(duplicated))).toThrow(
      /duplicate live semantic role service-zone\/group-boundary/,
    );

    const corruptBytes = JSON.parse(created.canonicalScene.bytes.toString()) as {
      elements: Array<Record<string, unknown>>;
    };
    const corruptBoundary = corruptBytes.elements.find((element) => element.id === boundaryId);
    if (!corruptBoundary) throw new Error("missing corruptible group boundary fixture");
    corruptBoundary.locked = false;
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(corruptBytes))).toThrow(
      /renderer bytes disagree with the authoritative projection/,
    );

    const corruptState = JSON.parse(created.canonicalScene.bytes.toString()) as {
      appState: Record<string, unknown>;
    };
    const semanticMap = corruptState.appState[SEMANTIC_SCENE_MAP_APP_STATE_KEY] as {
      groups: Record<string, { boundary: { bounds: { x: number } } }>;
    };
    semanticMap.groups["service-zone"].boundary.bounds.x += 1;
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(corruptState))).toThrow(
      /boundary bounds disagree with its active members/,
    );
  });

  it("accepts a legacy group without boundary, upgrades it on mutation, and removes an empty enclosure", () => {
    const ids = allocator();
    const created = apply(
      EMPTY_SCENE,
      draft(),
      request("legacy-group-create", [
        { type: "node.upsert", semanticKey: "api" },
        { type: "group.set", semanticKey: "legacy-zone", members: ["api"] },
      ]),
      ids,
    );
    const createdBoundaryId = mapOf(created).groups["legacy-zone"]?.boundary?.elementId;
    if (!createdBoundaryId) throw new Error("missing legacy boundary fixture");
    const legacy = JSON.parse(created.canonicalScene.bytes.toString()) as {
      elements: Array<{ id: string }>;
      appState: Record<string, unknown>;
    };
    legacy.elements = legacy.elements.filter((element) => element.id !== createdBoundaryId);
    const legacyMap = legacy.appState[SEMANTIC_SCENE_MAP_APP_STATE_KEY] as {
      groups: Record<string, { boundary?: unknown }>;
    };
    delete legacyMap.groups["legacy-zone"].boundary;
    const acceptedLegacy = canonicalizeWhiteboardScene(JSON.stringify(legacy));

    const callsBeforeUpgrade = ids.calls();
    const upgraded = apply(
      acceptedLegacy.bytes,
      draft(created.response.draftVersion),
      request("legacy-group-upgrade", [{ type: "node.upsert", semanticKey: "api" }]),
      ids,
    );
    const upgradedBoundary = mapOf(upgraded).groups["legacy-zone"]?.boundary;
    expect(upgraded.response.unchanged).toBe(false);
    expect(upgradedBoundary).toMatchObject({ version: 1 });
    expect(ids.calls()).toBe(callsBeforeUpgrade + 3);
    expect(
      (upgraded.canonicalScene.scene.elements as Array<Record<string, unknown>>).filter(
        (element) =>
          (element.customData as { tweakloop?: { role?: string } } | undefined)?.tweakloop?.role ===
          "group-boundary",
      ),
    ).toHaveLength(1);

    const emptied = apply(
      upgraded.canonicalScene.bytes,
      draft(upgraded.response.draftVersion),
      request("legacy-group-empty", [{ type: "entity.delete", semanticKey: "api" }]),
      ids,
    );
    expect(mapOf(emptied).groups["legacy-zone"]).toMatchObject({ members: [], boundary: null });
    expect(
      (emptied.canonicalScene.scene.elements as Array<Record<string, unknown>>).filter(
        (element) =>
          (element.customData as { tweakloop?: { role?: string } } | undefined)?.tweakloop?.role ===
          "group-boundary",
      ),
    ).toHaveLength(0);
  });

  it("rejects a semantic group as a label target with the exact supported target classes", () => {
    const ids = allocator();
    const grouped = apply(
      EMPTY_SCENE,
      draft(),
      request("group-label-base", [
        { type: "node.upsert", semanticKey: "api", label: "API" },
        { type: "group.set", semanticKey: "payments-zone-7", members: ["api"] },
      ]),
      ids,
    );

    expect(() =>
      apply(
        grouped.canonicalScene.bytes,
        draft(grouped.response.draftVersion),
        request("group-label-attempt", [
          { type: "label.set", target: "payments-zone-7", text: "Payments zone" },
        ]),
        ids,
      ),
    ).toThrow(
      "semantic group payments-zone-7 does not support labels; set-label targets nodes and edges only",
    );
    expect(() =>
      apply(
        grouped.canonicalScene.bytes,
        draft(grouped.response.draftVersion),
        request("near-group-label-attempt", [
          { type: "label.set", target: "payments-zone", text: "Payments zone" },
        ]),
        ids,
      ),
    ).toThrow("semantic entity payments-zone does not exist or is deleted");
  });

  it("keeps the four identities separate through update, repair, delete, and revive while rejecting rename", () => {
    const ids = allocator();
    let result = apply(
      EMPTY_SCENE,
      draft(),
      request("lifecycle-create", [
        { type: "node.upsert", semanticKey: "api", label: "API" },
        { type: "node.upsert", semanticKey: "db", label: "DB" },
        { type: "edge.upsert", semanticKey: "api-db", from: "api", to: "db" },
      ]),
      ids,
    );
    const created = mapOf(result);
    const createdApi = created.entities.api;
    const createdEdge = created.entities["api-db"];
    expect(createdApi).toBeDefined();
    expect(createdEdge).toBeDefined();

    result = apply(
      result.canonicalScene.bytes,
      draft(result.response.draftVersion),
      request("lifecycle-update", [
        { type: "node.upsert", semanticKey: "api", shape: "diamond", label: "Public API" },
      ]),
      ids,
    );
    const updated = mapOf(result);
    expect(updated.entities.api).toMatchObject({
      anchorId: createdApi?.anchorId,
      elementId: createdApi?.elementId,
      shape: "diamond",
      label: "Public API",
    });
    expect(updated.entities.api?.elementVersion).toBeGreaterThan(
      createdApi?.elementVersion ?? Number.MAX_SAFE_INTEGER,
    );

    const beforeMove = updated.entities.api;
    const edgeBeforeMove = updated.entities["api-db"];
    result = apply(
      result.canonicalScene.bytes,
      draft(result.response.draftVersion),
      request("lifecycle-move", [
        { type: "node.upsert", semanticKey: "api", placement: { x: 240, y: 360 } },
      ]),
      ids,
    );
    const moved = mapOf(result);
    expect(moved.entities.api).toMatchObject({
      anchorId: beforeMove?.anchorId,
      elementId: beforeMove?.elementId,
      shape: "diamond",
      label: "Public API",
      bounds: { x: 240, y: 360 },
    });
    expect(moved.entities["api-db"]).toMatchObject({
      elementId: edgeBeforeMove?.elementId,
    });
    expect(moved.entities["api-db"]?.elementVersion).toBeGreaterThan(
      edgeBeforeMove?.elementVersion ?? Number.MAX_SAFE_INTEGER,
    );

    result = apply(
      result.canonicalScene.bytes,
      draft(result.response.draftVersion),
      request("lifecycle-repair", [{ type: "element.repair", semanticKey: "api" }]),
      ids,
    );
    const repaired = mapOf(result);
    expect(repaired.entities.api?.anchorId).toBe(createdApi?.anchorId);
    expect(repaired.entities.api?.elementId).not.toBe(createdApi?.elementId);
    expect(repaired.entities.api?.retiredElements.map((entry) => entry.elementId)).toContain(
      createdApi?.elementId,
    );
    expect(repaired.entities["api-db"]?.elementId).toBe(createdEdge?.elementId);
    expect(repaired.entities["api-db"]?.elementVersion).toBeGreaterThan(
      createdEdge?.elementVersion ?? Number.MAX_SAFE_INTEGER,
    );

    expect(() =>
      apply(
        result.canonicalScene.bytes,
        draft(result.response.draftVersion),
        request("lifecycle-rename", [
          { type: "semantic.rename", semanticKey: "api", newSemanticKey: "gateway" },
        ]),
        ids,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({
        code: "whiteboard.semantic-rename-unsupported",
      }),
    );

    result = apply(
      result.canonicalScene.bytes,
      draft(result.response.draftVersion),
      request("lifecycle-delete", [
        { type: "entity.delete", semanticKey: "api-db" },
        { type: "entity.delete", semanticKey: "api" },
      ]),
      ids,
    );
    const deleted = mapOf(result);
    expect(deleted.entities.api).toMatchObject({
      semanticKey: "api",
      anchorId: createdApi?.anchorId,
      elementId: null,
      deleted: true,
    });

    result = apply(
      result.canonicalScene.bytes,
      draft(result.response.draftVersion),
      request("lifecycle-revive", [
        { type: "node.upsert", semanticKey: "api", label: "API revived" },
      ]),
      ids,
    );
    const revived = mapOf(result);
    expect(revived.entities.api).toMatchObject({
      semanticKey: "api",
      anchorId: createdApi?.anchorId,
      deleted: false,
    });
    expect(revived.entities.api?.elementId).not.toBe(createdApi?.elementId);
    expect(result.response.changedTargets[0]).toMatchObject({
      semanticKey: "api",
      anchorId: createdApi?.anchorId,
      elementId: revived.entities.api?.elementId,
    });
  });

  it("fails closed on caller renderer fields, duplicate operation keys, and map/customData disagreement", () => {
    const ids = allocator();
    const rawRendererRequest = {
      ...request("raw-renderer", [
        {
          type: "node.upsert",
          semanticKey: "api",
          label: "API",
          versionNonce: 42,
        } as never,
      ]),
    };
    expect(() => decideSemanticSceneReceipt(null, rawRendererRequest)).toThrow(/versionNonce/);
    expect(ids.calls()).toBe(0);

    expect(() =>
      decideSemanticSceneReceipt(
        null,
        request("raw-group-boundary", [
          {
            type: "group.set",
            semanticKey: "service-zone",
            members: ["api"],
            boundary: { elementId: "caller-owned" },
          } as never,
        ]),
      ),
    ).toThrow(/boundary/);

    expect(() =>
      decideSemanticSceneReceipt(
        null,
        request("duplicate-key", [
          { type: "node.upsert", semanticKey: "api" },
          { type: "label.set", target: "api", text: "second mutation" },
        ]),
      ),
    ).toThrow(/duplicate semantic operation key api/);

    const result = apply(
      EMPTY_SCENE,
      draft(),
      request("representation", [
        { type: "node.upsert", semanticKey: "api" },
        { type: "node.upsert", semanticKey: "db" },
      ]),
      ids,
    );
    const corrupted = JSON.parse(result.canonicalScene.bytes.toString()) as {
      elements: Array<{ customData?: { tweakloop?: Record<string, unknown> } }>;
    };
    const db = corrupted.elements.find(
      (element) => element.customData?.tweakloop?.semanticKey === "db",
    );
    if (!db?.customData?.tweakloop) throw new Error("missing managed db fixture");
    db.customData.tweakloop.anchorId = "wrong-anchor";
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(corrupted))).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({
        code: "whiteboard.semantic-representation-invalid",
      }),
    );

    const corruptedGeometry = JSON.parse(result.canonicalScene.bytes.toString()) as {
      elements: Array<{
        x?: number;
        customData?: { tweakloop?: Record<string, unknown> };
      }>;
    };
    const api = corruptedGeometry.elements.find(
      (element) => element.customData?.tweakloop?.semanticKey === "api",
    );
    if (!api || typeof api.x !== "number") throw new Error("missing managed api fixture");
    api.x += 1;
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(corruptedGeometry))).toThrow(
      /x disagrees with the authoritative SemanticSceneMap/,
    );

    const missingMap = JSON.parse(result.canonicalScene.bytes.toString()) as {
      appState: Record<string, unknown>;
    };
    delete missingMap.appState[SEMANTIC_SCENE_MAP_APP_STATE_KEY];
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(missingMap))).toThrow(
      /without tweakloopSemanticScene/,
    );
  });

  it("uses a server logical LayoutFrame and rejects off-frame or viewer-shaped geometry before mutation", () => {
    const ids = allocator();
    expect(() =>
      apply(
        EMPTY_SCENE,
        draft(),
        request("outside-frame", [
          { type: "node.upsert", semanticKey: "api", placement: { x: 0, y: 0 } },
        ]),
        ids,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({
        code: "whiteboard.semantic-geometry-out-of-frame",
      }),
    );
    expect(ids.calls()).toBe(0);

    expect(() =>
      decideSemanticSceneReceipt(null, {
        ...request("viewer-data", [{ type: "node.upsert", semanticKey: "api" }]),
        viewport: { width: 800 },
      } as SemanticSceneRequest),
    ).toThrow(/viewport/);

    const created = apply(
      EMPTY_SCENE,
      draft(),
      request("geometry-create", [
        { type: "node.upsert", semanticKey: "a" },
        { type: "node.upsert", semanticKey: "b" },
      ]),
      ids,
    );
    expect(() =>
      apply(
        created.canonicalScene.bytes,
        draft(created.response.draftVersion),
        request("geometry-layout", [
          { type: "layout.apply", direction: "lr", gap: 80, scope: ["a", "b"] },
        ]),
        ids,
        "workspace-source",
        {
          minX: 120,
          minY: 120,
          maxX: 500,
          maxY: 500,
          nodeWidth: 240,
          nodeHeight: 120,
          gap: 80,
        },
      ),
    ).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({
        code: "whiteboard.semantic-geometry-out-of-frame",
      }),
    );
  });

  it("replays the exact lifetime receipt after 128 later operations and destination restore without reallocation", () => {
    const ids = allocator();
    const originalRequest = request("first-operation", [
      { type: "node.upsert", semanticKey: "api", label: "API" },
    ]);
    let current = apply(EMPTY_SCENE, draft(), originalRequest, ids);
    const firstReceipt = current.receiptInsert;
    const firstResponseJson = current.responseJson;
    expect(firstReceipt.invalidation?.updatedBy).toEqual({ kind: "agent", id: "codex" });

    for (let index = 0; index < 129; index += 1) {
      current = apply(
        current.canonicalScene.bytes,
        draft(current.response.draftVersion),
        request(`later-${index}`, [{ type: "label.set", target: "api", text: `API ${index}` }]),
        ids,
      );
    }

    const callsBeforeReplay = ids.calls();
    const replay = decideSemanticSceneReceipt(firstReceipt, originalRequest);
    expect(replay).toMatchObject({ status: "replay", responseJson: firstResponseJson });
    expect(ids.calls()).toBe(callsBeforeReplay);
    if (replay.status !== "replay" || !replay.invalidation) {
      throw new Error("expected replayable invalidation fixture");
    }
    expect(
      materializeSemanticDraftInvalidation(replay.invalidation, "draft-restored"),
    ).toMatchObject({
      draftId: "draft-restored",
      draftVersion: 1,
      sceneHash: replay.response.sceneHash,
      deduplicationKey: `artifact-board:1:${replay.response.sceneHash}`,
    });

    const serialized = JSON.stringify(firstReceipt);
    const restored = rescopeSemanticSceneReceipt(
      JSON.parse(serialized) as SemanticSceneReceiptRecord,
      "workspace-destination",
    );
    expect(restored).toMatchObject({
      workspaceId: "workspace-destination",
      artifactId: "artifact-board",
      idempotencyKey: "first-operation",
      responseJson: firstResponseJson,
      sourceProvenance: { workspaceId: "workspace-source" },
    });
    expect(restored.requestHash).toBe(firstReceipt.requestHash);
    expect(decideSemanticSceneReceipt(restored, originalRequest)).toMatchObject({
      status: "replay",
      responseJson: firstResponseJson,
    });
    expect(firstResponseJson).not.toMatch(/workspace|draftId|session|process|path|url/i);

    expect(() =>
      decideSemanticSceneReceipt(
        restored,
        request("first-operation", [
          { type: "node.upsert", semanticKey: "different", label: "Different" },
        ]),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({ code: "scene.idempotency-conflict" }),
    );
  });
});
