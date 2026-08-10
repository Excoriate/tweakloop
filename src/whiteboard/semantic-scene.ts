import { createHash, randomInt, randomUUID } from "node:crypto";
import type { ActorRef } from "../protocol/envelopes.js";
import type { DraftChangedTarget, DraftInvalidation } from "./draft-hub.js";
import { WhiteboardError } from "./errors.js";
import {
  type CanonicalWhiteboardScene,
  canonicalizeWhiteboardScene,
  stableJsonHash,
} from "./scene.js";
import {
  emptySemanticSceneMap,
  managedElementMetadata,
  type RetiredRendererElement,
  readSemanticSceneMap,
  SEMANTIC_SCENE_MAP_APP_STATE_KEY,
  type SemanticBounds,
  type SemanticSceneEntity,
  type SemanticSceneGroup,
  type SemanticSceneGroupBoundary,
  type SemanticSceneMap,
  semanticGroupBoundaryBounds,
} from "./semantic-representation.js";

export const SEMANTIC_SCENE_REQUEST_PROTOCOL = "tweakloop.whiteboard-scene-command/v1" as const;
export const SEMANTIC_SCENE_RESPONSE_PROTOCOL = "tweakloop.whiteboard-scene-response/v1" as const;
export const SEMANTIC_SCENE_RECEIPT_PROTOCOL = "tweakloop.whiteboard-scene-receipt/v1" as const;
export const SEMANTIC_SCENE_NORMALIZATION_VERSION = 1 as const;

export const DEFAULT_SEMANTIC_LAYOUT_FRAME = Object.freeze({
  minX: 120,
  minY: 120,
  maxX: 4_120,
  maxY: 3_120,
  nodeWidth: 240,
  nodeHeight: 120,
  gap: 80,
}) satisfies SemanticLayoutFrame;

export type SemanticLayoutFrame = Readonly<{
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  nodeWidth: number;
  nodeHeight: number;
  gap: number;
}>;

export type SemanticSceneOperation =
  | Readonly<{
      type: "node.upsert";
      semanticKey: string;
      shape?: "rectangle" | "ellipse" | "diamond";
      label?: string | null;
      placement?: Readonly<{ x: number; y: number }>;
    }>
  | Readonly<{
      type: "edge.upsert";
      semanticKey: string;
      from: string;
      to: string;
      label?: string | null;
    }>
  | Readonly<{ type: "label.set"; target: string; text: string | null }>
  | Readonly<{ type: "group.set"; semanticKey: string; members: readonly string[] }>
  | Readonly<{
      type: "layout.apply";
      direction?: "lr" | "tb";
      gap?: number;
      scope?: readonly string[];
    }>
  | Readonly<{ type: "entity.delete"; semanticKey: string }>
  | Readonly<{ type: "element.repair"; semanticKey: string }>
  | Readonly<{ type: "semantic.rename"; semanticKey: string; newSemanticKey: string }>;

export type SemanticSceneRequest = Readonly<{
  protocol: typeof SEMANTIC_SCENE_REQUEST_PROTOCOL;
  artifactId: string;
  idempotencyKey: string;
  operations: readonly SemanticSceneOperation[];
}>;

export type NormalizedSemanticSceneRequest = Readonly<{
  protocol: typeof SEMANTIC_SCENE_REQUEST_PROTOCOL;
  artifactId: string;
  idempotencyKey: string;
  operations: readonly NormalizedSemanticSceneOperation[];
}>;

type NormalizedSemanticSceneOperation =
  | Readonly<{
      type: "node.upsert";
      semanticKey: string;
      shape: "rectangle" | "ellipse" | "diamond" | null;
      label: NormalizedOptionalLabel;
      placement: Readonly<{ x: number; y: number }> | null;
    }>
  | Readonly<{
      type: "edge.upsert";
      semanticKey: string;
      from: string;
      to: string;
      label: NormalizedOptionalLabel;
    }>
  | Readonly<{ type: "label.set"; target: string; text: string | null }>
  | Readonly<{ type: "group.set"; semanticKey: string; members: readonly string[] }>
  | Readonly<{
      type: "layout.apply";
      direction: "lr" | "tb";
      gap: number;
      scope: readonly string[] | null;
    }>
  | Readonly<{ type: "entity.delete"; semanticKey: string }>
  | Readonly<{ type: "element.repair"; semanticKey: string }>
  | Readonly<{ type: "semantic.rename"; semanticKey: string; newSemanticKey: string }>;

type NormalizedOptionalLabel =
  | Readonly<{ mode: "preserve" }>
  | Readonly<{ mode: "set"; value: string | null }>;

export type SemanticIdentityAllocator = Readonly<{
  newAnchorId: () => string;
  newElementId: () => string;
  newGroupId: () => string;
  newSeed: () => number;
  newVersionNonce: () => number;
}>;

export type SemanticDraftTuple = Readonly<{
  artifactId: string;
  draftId: string;
  baseRevisionId: string;
  draftVersion: number;
  expectedHeadRevisionId: string;
}>;

export type SemanticSceneResponse = Readonly<{
  protocol: typeof SEMANTIC_SCENE_RESPONSE_PROTOCOL;
  status: "accepted";
  artifactId: string;
  idempotencyKey: string;
  normalizationVersion: typeof SEMANTIC_SCENE_NORMALIZATION_VERSION;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  elementIndexHash: string;
  expectedHeadRevisionId: string;
  unchanged: boolean;
  changedTargets: readonly DraftChangedTarget[];
  changedBounds: SemanticBounds | null;
}>;

export type SemanticDraftInvalidationDescriptor = Readonly<{
  artifactId: string;
  baseRevisionId: string;
  draftVersion: number;
  sceneHash: string;
  updatedBy: ActorRef;
  deduplicationKey: string;
  changedTargets: readonly DraftChangedTarget[];
  changedBounds: SemanticBounds | null;
}>;

export type SemanticSceneReceiptRecord = Readonly<{
  protocol: typeof SEMANTIC_SCENE_RECEIPT_PROTOCOL;
  workspaceId: string;
  artifactId: string;
  idempotencyKey: string;
  normalizationVersion: typeof SEMANTIC_SCENE_NORMALIZATION_VERSION;
  normalizedRequestJson: string;
  requestHash: string;
  responseJson: string;
  invalidation: SemanticDraftInvalidationDescriptor | null;
  sourceProvenance: Readonly<{
    workspaceId: string;
    receiptHash: string;
  }> | null;
}>;

export type SemanticReceiptApplyAuthorization = Readonly<{
  status: "apply";
  normalizedRequest: NormalizedSemanticSceneRequest;
  normalizedRequestJson: string;
  requestHash: string;
}>;

export type SemanticReceiptDecision =
  | SemanticReceiptApplyAuthorization
  | Readonly<{
      status: "replay";
      response: SemanticSceneResponse;
      responseJson: string;
      invalidation: SemanticDraftInvalidationDescriptor | null;
    }>;

export type SemanticSceneCommitCandidate = Readonly<{
  canonicalScene: CanonicalWhiteboardScene;
  response: SemanticSceneResponse;
  responseJson: string;
  receiptInsert: SemanticSceneReceiptRecord;
  invalidation: DraftInvalidation | null;
}>;

type JsonObject = Record<string, unknown>;

export function createRandomSemanticIdentityAllocator(): SemanticIdentityAllocator {
  return {
    newAnchorId: () => `anchor_${randomUUID()}`,
    newElementId: () => `element_${randomUUID()}`,
    newGroupId: () => `group_${randomUUID()}`,
    newSeed: () => randomInt(1, 2_147_483_647),
    newVersionNonce: () => randomInt(0, 2_147_483_647),
  };
}

export function decideSemanticSceneReceipt(
  existingReceiptForKey: SemanticSceneReceiptRecord | null,
  request: SemanticSceneRequest,
): SemanticReceiptDecision {
  const normalizedRequest = normalizeSemanticSceneRequest(request);
  const normalizedRequestJson = JSON.stringify(normalizedRequest);
  const requestHash = stableJsonHash({
    normalizationVersion: SEMANTIC_SCENE_NORMALIZATION_VERSION,
    request: normalizedRequest,
  });
  if (!existingReceiptForKey) {
    return { status: "apply", normalizedRequest, normalizedRequestJson, requestHash };
  }
  validateReceiptRecord(existingReceiptForKey);
  if (
    existingReceiptForKey.artifactId !== normalizedRequest.artifactId ||
    existingReceiptForKey.idempotencyKey !== normalizedRequest.idempotencyKey
  ) {
    throw receiptCorrupt("looked-up semantic receipt does not match its requested key");
  }
  if (
    existingReceiptForKey.requestHash !== requestHash ||
    existingReceiptForKey.normalizedRequestJson !== normalizedRequestJson
  ) {
    throw new WhiteboardError(
      "scene.idempotency-conflict",
      "idempotency key was already used for a different semantic scene request",
      409,
    );
  }
  const response = parseReceiptResponse(existingReceiptForKey.responseJson);
  validateReceiptInvalidation(existingReceiptForKey.invalidation, response);
  return {
    status: "replay",
    response,
    responseJson: existingReceiptForKey.responseJson,
    invalidation: existingReceiptForKey.invalidation,
  };
}

export function applySemanticSceneRequest(
  input: Readonly<{
    workspaceId: string;
    currentScene: Buffer | string;
    currentDraft: SemanticDraftTuple;
    actor: ActorRef;
    authorization: SemanticReceiptApplyAuthorization;
    allocator: SemanticIdentityAllocator;
    layoutFrame?: SemanticLayoutFrame;
  }>,
): SemanticSceneCommitCandidate {
  validatePortableIdentifier(input.workspaceId, "workspaceId");
  validateActor(input.actor);
  validateDraftTuple(input.currentDraft);
  validateLayoutFrame(input.layoutFrame ?? DEFAULT_SEMANTIC_LAYOUT_FRAME);
  const request = input.authorization.normalizedRequest;
  if (request.artifactId !== input.currentDraft.artifactId) {
    throw semanticInvalid("request artifact does not match the current whiteboard draft");
  }
  if (
    JSON.stringify(request) !== input.authorization.normalizedRequestJson ||
    stableJsonHash({
      normalizationVersion: SEMANTIC_SCENE_NORMALIZATION_VERSION,
      request,
    }) !== input.authorization.requestHash
  ) {
    throw receiptCorrupt("semantic apply authorization is not bound to its normalized request");
  }

  const currentCanonical = canonicalizeWhiteboardScene(input.currentScene);
  const currentMap = readSemanticSceneMap(currentCanonical.scene) ?? emptySemanticSceneMap();
  const transformed = transformSemanticSceneMap(
    currentMap,
    request.operations,
    input.allocator,
    input.layoutFrame ?? DEFAULT_SEMANTIC_LAYOUT_FRAME,
  );
  const canonicalScene = transformed.changed
    ? canonicalizeWhiteboardScene(
        JSON.stringify(renderSemanticScene(currentCanonical.scene, transformed.map)),
      )
    : currentCanonical;
  const draftVersion = input.currentDraft.draftVersion + (transformed.changed ? 1 : 0);
  const changedTargets = changedTargetsFor(transformed.map, transformed.changedSemanticKeys);
  const changedBounds = combineBounds(changedTargets.map((target) => target.bounds));
  const response: SemanticSceneResponse = {
    protocol: SEMANTIC_SCENE_RESPONSE_PROTOCOL,
    status: "accepted",
    artifactId: request.artifactId,
    idempotencyKey: request.idempotencyKey,
    normalizationVersion: SEMANTIC_SCENE_NORMALIZATION_VERSION,
    baseRevisionId: input.currentDraft.baseRevisionId,
    draftVersion,
    sceneHash: canonicalScene.hash,
    elementIndexHash: canonicalScene.elementIndexHash,
    expectedHeadRevisionId: input.currentDraft.expectedHeadRevisionId,
    unchanged: !transformed.changed,
    changedTargets,
    changedBounds,
  };
  const responseJson = JSON.stringify(response);
  const invalidationDescriptor: SemanticDraftInvalidationDescriptor | null = transformed.changed
    ? {
        artifactId: response.artifactId,
        baseRevisionId: response.baseRevisionId,
        draftVersion: response.draftVersion,
        sceneHash: response.sceneHash,
        updatedBy: { kind: input.actor.kind, id: input.actor.id },
        deduplicationKey: invalidationDeduplicationKey(
          response.artifactId,
          response.draftVersion,
          response.sceneHash,
        ),
        changedTargets: response.changedTargets,
        changedBounds: response.changedBounds,
      }
    : null;
  const receiptInsert: SemanticSceneReceiptRecord = {
    protocol: SEMANTIC_SCENE_RECEIPT_PROTOCOL,
    workspaceId: input.workspaceId,
    artifactId: request.artifactId,
    idempotencyKey: request.idempotencyKey,
    normalizationVersion: SEMANTIC_SCENE_NORMALIZATION_VERSION,
    normalizedRequestJson: input.authorization.normalizedRequestJson,
    requestHash: input.authorization.requestHash,
    responseJson,
    invalidation: invalidationDescriptor,
    sourceProvenance: null,
  };
  return {
    canonicalScene,
    response,
    responseJson,
    receiptInsert,
    invalidation: invalidationDescriptor
      ? materializeSemanticDraftInvalidation(invalidationDescriptor, input.currentDraft.draftId)
      : null,
  };
}

export function materializeSemanticDraftInvalidation(
  descriptor: SemanticDraftInvalidationDescriptor,
  draftId: string,
): DraftInvalidation {
  validatePortableIdentifier(draftId, "draftId");
  return {
    protocol: "tweakloop.whiteboard-draft/v1",
    kind: "whiteboard-draft",
    artifactId: descriptor.artifactId,
    draftId,
    draftVersion: descriptor.draftVersion,
    baseRevisionId: descriptor.baseRevisionId,
    sceneHash: descriptor.sceneHash,
    updatedBy: descriptor.updatedBy,
    deduplicationKey: descriptor.deduplicationKey,
    changedTargets: descriptor.changedTargets,
    changedBounds: descriptor.changedBounds,
  };
}

export function rescopeSemanticSceneReceipt(
  receipt: SemanticSceneReceiptRecord,
  destinationWorkspaceId: string,
): SemanticSceneReceiptRecord {
  validateReceiptRecord(receipt);
  validatePortableIdentifier(destinationWorkspaceId, "destinationWorkspaceId");
  if (destinationWorkspaceId === receipt.workspaceId) return receipt;
  return {
    ...receipt,
    workspaceId: destinationWorkspaceId,
    sourceProvenance: {
      workspaceId: receipt.workspaceId,
      receiptHash: semanticReceiptHash(receipt),
    },
  };
}

export function semanticReceiptHash(receipt: SemanticSceneReceiptRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        protocol: receipt.protocol,
        workspaceId: receipt.workspaceId,
        artifactId: receipt.artifactId,
        idempotencyKey: receipt.idempotencyKey,
        normalizationVersion: receipt.normalizationVersion,
        normalizedRequestJson: receipt.normalizedRequestJson,
        requestHash: receipt.requestHash,
        responseJson: receipt.responseJson,
        invalidation: receipt.invalidation,
      }),
    )
    .digest("hex");
}

/** Decode and fail closed on a receipt arriving from a workspace bundle or another store. */
export function decodeSemanticSceneReceiptRecord(value: unknown): SemanticSceneReceiptRecord {
  const receipt = requireObject(value, "semantic receipt must be an object") as JsonObject;
  validateReceiptRecord(receipt as unknown as SemanticSceneReceiptRecord);
  return receipt as unknown as SemanticSceneReceiptRecord;
}

export function semanticSceneReceiptResponse(
  receipt: SemanticSceneReceiptRecord,
): SemanticSceneResponse {
  validateReceiptRecord(receipt);
  return parseReceiptResponse(receipt.responseJson);
}

export function normalizeSemanticSceneRequest(
  request: SemanticSceneRequest,
): NormalizedSemanticSceneRequest {
  const envelope = requireObject(request, "semantic scene request must be an object");
  assertOnlyKeys(envelope, ["protocol", "artifactId", "idempotencyKey", "operations"], "request");
  if (envelope.protocol !== SEMANTIC_SCENE_REQUEST_PROTOCOL) {
    throw semanticInvalid("semantic scene request protocol is unsupported");
  }
  validatePortableIdentifier(envelope.artifactId, "artifactId");
  validatePortableIdentifier(envelope.idempotencyKey, "idempotencyKey");
  if (!Array.isArray(envelope.operations) || envelope.operations.length < 1) {
    throw semanticInvalid("semantic scene request requires at least one operation");
  }
  if (envelope.operations.length > 100) {
    throw semanticInvalid("semantic scene request cannot contain more than 100 operations");
  }
  const seenOperationKeys = new Set<string>();
  let layoutSeen = false;
  const operations = envelope.operations.map((operation, index) => {
    const normalized = normalizeOperation(operation, index);
    const operationKey = operationSemanticKey(normalized);
    if (operationKey) {
      if (seenOperationKeys.has(operationKey)) {
        throw semanticInvalid(`duplicate semantic operation key ${operationKey}`);
      }
      seenOperationKeys.add(operationKey);
    }
    if (normalized.type === "layout.apply") {
      if (layoutSeen)
        throw semanticInvalid("only one layout.apply operation is allowed per request");
      layoutSeen = true;
    }
    return normalized;
  });
  return {
    protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
    artifactId: envelope.artifactId as string,
    idempotencyKey: envelope.idempotencyKey as string,
    operations,
  };
}

function transformSemanticSceneMap(
  source: SemanticSceneMap,
  operations: readonly NormalizedSemanticSceneOperation[],
  allocator: SemanticIdentityAllocator,
  frame: SemanticLayoutFrame,
): Readonly<{
  map: SemanticSceneMap;
  changed: boolean;
  changedSemanticKeys: ReadonlySet<string>;
}> {
  let entities: Record<string, SemanticSceneEntity> = { ...source.entities };
  const groups: Record<string, SemanticSceneGroup> = { ...source.groups };
  const changedSemanticKeys = new Set<string>();
  const geometryChangedSemanticKeys = new Set<string>();
  const membershipChangedGroups = new Set<string>();
  let changed = false;

  const replaceEntity = (entity: SemanticSceneEntity): void => {
    entities[entity.semanticKey] = entity;
    changedSemanticKeys.add(entity.semanticKey);
    changed = true;
  };

  for (const operation of operations) {
    if (operation.type === "node.upsert") {
      if (groups[operation.semanticKey]) {
        throw semanticInvalid(`semantic key ${operation.semanticKey} already belongs to a group`);
      }
      const existing = entities[operation.semanticKey];
      if (existing && existing.kind !== "node") {
        throw semanticInvalid(`semantic key ${operation.semanticKey} already belongs to an edge`);
      }
      const shape = operation.shape ?? existing?.shape ?? "rectangle";
      const label =
        operation.label.mode === "set" ? operation.label.value : (existing?.label ?? null);
      const placement =
        operation.placement ??
        (existing
          ? { x: existing.bounds.x, y: existing.bounds.y }
          : defaultNodePlacement(activeNodes(entities).length, frame));
      const bounds = existing
        ? { ...existing.bounds, x: placement.x, y: placement.y }
        : {
            x: placement.x,
            y: placement.y,
            width: frame.nodeWidth,
            height: frame.nodeHeight,
          };
      assertBoundsFitFrame(bounds, frame, operation.semanticKey);
      if (!existing) {
        replaceEntity(
          createEntity(
            {
              semanticKey: operation.semanticKey,
              kind: "node",
              shape,
              label,
              from: null,
              to: null,
              bounds,
            },
            allocator,
          ),
        );
      } else if (existing.deleted) {
        replaceEntity(
          reviveEntity(
            {
              ...existing,
              shape,
              label,
              bounds,
            },
            allocator,
          ),
        );
      } else {
        const updated = updateActiveEntity(
          existing,
          {
            shape,
            label,
            bounds,
          },
          allocator,
        );
        if (updated !== existing) replaceEntity(updated);
      }
      const currentNode = entities[operation.semanticKey];
      if (existing && currentNode && !sameBounds(existing.bounds, currentNode.bounds)) {
        geometryChangedSemanticKeys.add(operation.semanticKey);
        const edgeResult = refreshEdges(
          entities,
          allocator,
          changedSemanticKeys,
          geometryChangedSemanticKeys,
          operation.semanticKey,
        );
        entities = edgeResult.entities;
        changed ||= edgeResult.changed;
      }
      continue;
    }

    if (operation.type === "edge.upsert") {
      if (groups[operation.semanticKey]) {
        throw semanticInvalid(`semantic key ${operation.semanticKey} already belongs to a group`);
      }
      const from = requireActiveNode(entities, operation.from, "from");
      const to = requireActiveNode(entities, operation.to, "to");
      if (from.semanticKey === to.semanticKey) {
        throw semanticInvalid("edge endpoints must be different semantic nodes");
      }
      const bounds = edgeBounds(from, to);
      const existing = entities[operation.semanticKey];
      if (existing && existing.kind !== "edge") {
        throw semanticInvalid(`semantic key ${operation.semanticKey} already belongs to a node`);
      }
      const label =
        operation.label.mode === "set" ? operation.label.value : (existing?.label ?? null);
      if (!existing) {
        replaceEntity(
          createEntity(
            {
              semanticKey: operation.semanticKey,
              kind: "edge",
              shape: null,
              label,
              from: operation.from,
              to: operation.to,
              bounds,
            },
            allocator,
          ),
        );
      } else if (existing.deleted) {
        replaceEntity(
          reviveEntity(
            {
              ...existing,
              from: operation.from,
              to: operation.to,
              label,
              bounds,
            },
            allocator,
          ),
        );
      } else {
        const updated = updateActiveEntity(
          existing,
          {
            from: operation.from,
            to: operation.to,
            label,
            bounds,
          },
          allocator,
        );
        if (updated !== existing) replaceEntity(updated);
      }
      const currentEdge = entities[operation.semanticKey];
      if (existing && currentEdge && !sameBounds(existing.bounds, currentEdge.bounds)) {
        geometryChangedSemanticKeys.add(operation.semanticKey);
      }
      continue;
    }

    if (operation.type === "label.set") {
      if (groups[operation.target]) {
        throw semanticInvalid(
          `semantic group ${operation.target} does not support labels; set-label targets nodes and edges only`,
        );
      }
      const entity = requireActiveEntity(entities, operation.target);
      const updated = updateActiveEntity(entity, { label: operation.text }, allocator);
      if (updated !== entity) replaceEntity(updated);
      continue;
    }

    if (operation.type === "group.set") {
      if (entities[operation.semanticKey]) {
        throw semanticInvalid(`semantic key ${operation.semanticKey} already belongs to an entity`);
      }
      for (const member of operation.members) requireActiveEntity(entities, member);
      const existing = groups[operation.semanticKey];
      if (existing && sameStrings(existing.members, operation.members)) continue;
      const groupId = existing?.groupId ?? checkedId(allocator.newGroupId(), "groupId");
      const previousMembers = existing?.members ?? [];
      groups[operation.semanticKey] = {
        semanticKey: operation.semanticKey,
        groupId,
        members: [...operation.members],
        ...(existing && Object.hasOwn(existing, "boundary")
          ? { boundary: existing.boundary ?? null }
          : {}),
      };
      membershipChangedGroups.add(operation.semanticKey);
      for (const semanticKey of new Set([...previousMembers, ...operation.members])) {
        const entity = entities[semanticKey];
        if (!entity || entity.deleted) continue;
        entities[semanticKey] = bumpActiveRendererElements(entity, allocator);
        changedSemanticKeys.add(semanticKey);
      }
      changed = true;
      continue;
    }

    if (operation.type === "layout.apply") {
      let keys: string[];
      if (operation.scope) {
        keys = [...operation.scope];
      } else {
        const sortedGroups = Object.values(groups).sort(bySemanticKey);
        const membershipByKey = new Map(
          activeNodes(entities).map((entity) => [
            entity.semanticKey,
            sortedGroups
              .filter((group) => group.members.includes(entity.semanticKey))
              .map((group) => group.semanticKey)
              .join("\0"),
          ]),
        );
        keys = [...membershipByKey.keys()].sort((left, right) => {
          const leftMembership = membershipByKey.get(left) ?? "";
          const rightMembership = membershipByKey.get(right) ?? "";
          if (leftMembership < rightMembership) return -1;
          if (leftMembership > rightMembership) return 1;
          return left < right ? -1 : left > right ? 1 : 0;
        });
      }
      if (new Set(keys).size !== keys.length) {
        throw semanticInvalid("layout scope contains duplicate semantic keys");
      }
      for (const key of keys) requireActiveNode(entities, key, "layout scope");
      const placements = layoutPlacements(keys.length, operation.direction, operation.gap, frame);
      for (const [index, key] of keys.entries()) {
        const entity = entities[key] as SemanticSceneEntity;
        const placement = placements[index] as Readonly<{ x: number; y: number }>;
        const bounds = { ...entity.bounds, x: placement.x, y: placement.y };
        assertBoundsFitFrame(bounds, frame, key);
        if (!sameBounds(entity.bounds, bounds)) {
          geometryChangedSemanticKeys.add(key);
          replaceEntity(bumpActiveRendererElements({ ...entity, bounds }, allocator));
        }
      }
      const edgeResult = refreshEdges(
        entities,
        allocator,
        changedSemanticKeys,
        geometryChangedSemanticKeys,
      );
      entities = edgeResult.entities;
      changed ||= edgeResult.changed;
      continue;
    }

    if (operation.type === "entity.delete") {
      const entity = entities[operation.semanticKey];
      if (!entity || entity.deleted) continue;
      if (entity.kind === "node") {
        const references = Object.values(entities).filter(
          (candidate) =>
            candidate.kind === "edge" &&
            !candidate.deleted &&
            (candidate.from === entity.semanticKey || candidate.to === entity.semanticKey),
        );
        if (references.length > 0) {
          throw semanticInvalid(
            `semantic node ${entity.semanticKey} is still referenced by edge ${references[0]?.semanticKey}`,
          );
        }
      }
      replaceEntity(retireActiveEntity(entity, allocator));
      for (const [groupKey, group] of Object.entries(groups)) {
        if (!group.members.includes(entity.semanticKey)) continue;
        groups[groupKey] = {
          ...group,
          members: group.members.filter((member) => member !== entity.semanticKey),
        };
        membershipChangedGroups.add(groupKey);
      }
      continue;
    }

    if (operation.type === "element.repair") {
      const entity = requireActiveEntity(entities, operation.semanticKey);
      replaceEntity(repairEntityElement(entity, allocator));
      if (entity.kind === "node") {
        const edgeResult = refreshEdges(
          entities,
          allocator,
          changedSemanticKeys,
          geometryChangedSemanticKeys,
          entity.semanticKey,
          true,
        );
        entities = edgeResult.entities;
        changed ||= edgeResult.changed;
      }
      continue;
    }

    throw new WhiteboardError(
      "whiteboard.semantic-rename-unsupported",
      "semantic key rename is not supported in whiteboard scene protocol v1",
      409,
    );
  }

  const groupBoundaryChanges = reconcileGroupBoundaries(
    groups,
    entities,
    allocator,
    membershipChangedGroups,
    geometryChangedSemanticKeys,
  );
  changed ||= groupBoundaryChanges > 0;

  return {
    map: { ...source, entities, groups },
    changed,
    changedSemanticKeys,
  };
}

function createEntity(
  input: Readonly<{
    semanticKey: string;
    kind: "node" | "edge";
    shape: "rectangle" | "ellipse" | "diamond" | null;
    label: string | null;
    from: string | null;
    to: string | null;
    bounds: SemanticBounds;
  }>,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  const labelElement = input.label === null ? null : allocateRendererIdentity(allocator);
  const primary = allocateRendererIdentity(allocator);
  return {
    ...input,
    anchorId: checkedId(allocator.newAnchorId(), "anchorId"),
    elementId: primary.elementId,
    labelElementId: labelElement?.elementId ?? null,
    deleted: false,
    elementVersion: 1,
    elementVersionNonce: primary.versionNonce,
    elementSeed: primary.seed,
    labelVersion: labelElement ? 1 : null,
    labelVersionNonce: labelElement?.versionNonce ?? null,
    labelSeed: labelElement?.seed ?? null,
    retiredElements: [],
  };
}

function reviveEntity(
  entity: SemanticSceneEntity,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  const primary = allocateRendererIdentity(allocator);
  const label = entity.label === null ? null : allocateRendererIdentity(allocator);
  return {
    ...entity,
    deleted: false,
    elementId: primary.elementId,
    elementVersion: 1,
    elementVersionNonce: primary.versionNonce,
    elementSeed: primary.seed,
    labelElementId: label?.elementId ?? null,
    labelVersion: label ? 1 : null,
    labelVersionNonce: label?.versionNonce ?? null,
    labelSeed: label?.seed ?? null,
  };
}

function updateActiveEntity(
  entity: SemanticSceneEntity,
  updates: Partial<Pick<SemanticSceneEntity, "shape" | "label" | "from" | "to" | "bounds">>,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  const next = { ...entity, ...updates };
  if (
    entity.shape === next.shape &&
    entity.label === next.label &&
    entity.from === next.from &&
    entity.to === next.to &&
    sameBounds(entity.bounds, next.bounds)
  ) {
    return entity;
  }
  let updated: SemanticSceneEntity = bumpPrimary(next, allocator);
  if (entity.label === next.label) {
    return entity.labelElementId && !sameBounds(entity.bounds, next.bounds)
      ? bumpLabel(updated, allocator)
      : updated;
  }
  if (entity.labelElementId && next.label === null) {
    const retired = retireRendererElement(entity, "label", allocator);
    updated = {
      ...updated,
      labelElementId: null,
      labelVersion: null,
      labelVersionNonce: null,
      labelSeed: null,
      retiredElements: [...updated.retiredElements, retired],
    };
  } else if (!entity.labelElementId && next.label !== null) {
    const label = allocateRendererIdentity(allocator);
    updated = {
      ...updated,
      labelElementId: label.elementId,
      labelVersion: 1,
      labelVersionNonce: label.versionNonce,
      labelSeed: label.seed,
    };
  } else if (entity.labelElementId && next.label !== null) {
    updated = {
      ...updated,
      labelVersion: requireNumber(entity.labelVersion) + 1,
      labelVersionNonce: checkedNonce(allocator.newVersionNonce()),
    };
  }
  return updated;
}

function bumpPrimary(
  entity: SemanticSceneEntity,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  if (entity.deleted || !entity.elementId) return entity;
  return {
    ...entity,
    elementVersion: requireNumber(entity.elementVersion) + 1,
    elementVersionNonce: checkedNonce(allocator.newVersionNonce()),
  };
}

function bumpLabel(
  entity: SemanticSceneEntity,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  if (entity.deleted || !entity.labelElementId) return entity;
  return {
    ...entity,
    labelVersion: requireNumber(entity.labelVersion) + 1,
    labelVersionNonce: checkedNonce(allocator.newVersionNonce()),
  };
}

function bumpActiveRendererElements(
  entity: SemanticSceneEntity,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  return bumpLabel(bumpPrimary(entity, allocator), allocator);
}

function retireActiveEntity(
  entity: SemanticSceneEntity,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  const retiredElements = [
    ...entity.retiredElements,
    retireRendererElement(entity, "primary", allocator),
  ];
  if (entity.labelElementId)
    retiredElements.push(retireRendererElement(entity, "label", allocator));
  return {
    ...entity,
    deleted: true,
    elementId: null,
    labelElementId: null,
    elementVersion: null,
    elementVersionNonce: null,
    elementSeed: null,
    labelVersion: null,
    labelVersionNonce: null,
    labelSeed: null,
    retiredElements,
  };
}

function repairEntityElement(
  entity: SemanticSceneEntity,
  allocator: SemanticIdentityAllocator,
): SemanticSceneEntity {
  const retired = retireRendererElement(entity, "primary", allocator);
  const replacement = allocateRendererIdentity(allocator);
  return {
    ...entity,
    elementId: replacement.elementId,
    elementVersion: 1,
    elementVersionNonce: replacement.versionNonce,
    elementSeed: replacement.seed,
    labelVersion: entity.labelElementId ? requireNumber(entity.labelVersion) + 1 : null,
    labelVersionNonce: entity.labelElementId ? checkedNonce(allocator.newVersionNonce()) : null,
    retiredElements: [...entity.retiredElements, retired],
  };
}

function retireRendererElement(
  entity: SemanticSceneEntity,
  role: "primary" | "label",
  allocator: SemanticIdentityAllocator,
): RetiredRendererElement {
  const elementId = role === "primary" ? entity.elementId : entity.labelElementId;
  const version = role === "primary" ? entity.elementVersion : entity.labelVersion;
  const seed = role === "primary" ? entity.elementSeed : entity.labelSeed;
  if (!elementId || version === null || seed === null) {
    throw semanticInvalid(
      `cannot retire missing ${role} renderer identity for ${entity.semanticKey}`,
    );
  }
  return {
    elementId,
    elementType:
      role === "label" ? "text" : entity.kind === "edge" ? "arrow" : requireShape(entity),
    role,
    version: version + 1,
    versionNonce: checkedNonce(allocator.newVersionNonce()),
    seed,
  };
}

function refreshEdges(
  source: Record<string, SemanticSceneEntity>,
  allocator: SemanticIdentityAllocator,
  changedSemanticKeys: Set<string>,
  geometryChangedSemanticKeys: Set<string>,
  onlyForNode?: string,
  forceBindingRefresh = false,
): Readonly<{ entities: Record<string, SemanticSceneEntity>; changed: boolean }> {
  const entities = { ...source };
  let changed = false;
  for (const entity of Object.values(source)) {
    if (entity.kind !== "edge" || entity.deleted || !entity.from || !entity.to) continue;
    if (onlyForNode && entity.from !== onlyForNode && entity.to !== onlyForNode) continue;
    const bounds = edgeBounds(
      requireActiveNode(source, entity.from, "edge from"),
      requireActiveNode(source, entity.to, "edge to"),
    );
    const bindingChanged = forceBindingRefresh;
    if (!bindingChanged && sameBounds(entity.bounds, bounds)) continue;
    entities[entity.semanticKey] = bumpPrimary({ ...entity, bounds }, allocator);
    changedSemanticKeys.add(entity.semanticKey);
    if (!sameBounds(entity.bounds, bounds)) geometryChangedSemanticKeys.add(entity.semanticKey);
    changed = true;
  }
  return { entities, changed };
}

function reconcileGroupBoundaries(
  groups: Record<string, SemanticSceneGroup>,
  entities: Readonly<Record<string, SemanticSceneEntity>>,
  allocator: SemanticIdentityAllocator,
  membershipChangedGroups: ReadonlySet<string>,
  geometryChangedSemanticKeys: ReadonlySet<string>,
): number {
  let changed = 0;
  for (const group of Object.values(groups).sort(bySemanticKey)) {
    if (group.members.length === 0) {
      if (group.boundary !== null || !Object.hasOwn(group, "boundary")) {
        groups[group.semanticKey] = { ...group, boundary: null };
        changed += 1;
      }
      continue;
    }
    const bounds = semanticGroupBoundaryBounds(
      group.members.map((member) => requireActiveEntity(entities, member).bounds),
    );
    if (!group.boundary) {
      const identity = allocateRendererIdentity(allocator);
      groups[group.semanticKey] = {
        ...group,
        boundary: {
          elementId: identity.elementId,
          version: 1,
          versionNonce: identity.versionNonce,
          seed: identity.seed,
          bounds,
        },
      };
      changed += 1;
      continue;
    }
    const memberGeometryChanged = group.members.some((member) =>
      geometryChangedSemanticKeys.has(member),
    );
    if (
      !membershipChangedGroups.has(group.semanticKey) &&
      !memberGeometryChanged &&
      sameBounds(group.boundary.bounds, bounds)
    ) {
      continue;
    }
    groups[group.semanticKey] = {
      ...group,
      boundary: bumpGroupBoundary(group.boundary, bounds, allocator),
    };
    changed += 1;
  }
  return changed;
}

function bumpGroupBoundary(
  boundary: SemanticSceneGroupBoundary,
  bounds: SemanticBounds,
  allocator: SemanticIdentityAllocator,
): SemanticSceneGroupBoundary {
  return {
    ...boundary,
    version: boundary.version + 1,
    versionNonce: checkedNonce(allocator.newVersionNonce()),
    bounds,
  };
}

function renderSemanticScene(
  currentScene: Readonly<JsonObject>,
  map: SemanticSceneMap,
): JsonObject {
  const currentElements = Array.isArray(currentScene.elements) ? currentScene.elements : [];
  const unmanaged = currentElements.filter((candidate) => {
    const element = asObject(candidate);
    return !element || managedElementMetadata(element) === null;
  });
  const groupBoundaryElements = Object.values(map.groups)
    .filter((group) => group.boundary !== null && group.boundary !== undefined)
    .sort(bySemanticKey)
    .map(renderGroupBoundaryElement);
  const edgeElements: JsonObject[] = [];
  const nodeElements: JsonObject[] = [];
  const retiredElements: JsonObject[] = [];
  const activeEntities = Object.values(map.entities).filter((entity) => !entity.deleted);
  const activeEdges = activeEntities.filter((entity) => entity.kind === "edge");
  const activeNodes = activeEntities.filter((entity) => entity.kind === "node");
  for (const entity of Object.values(map.entities).sort(bySemanticKey)) {
    for (const retired of entity.retiredElements) {
      retiredElements.push(renderRetiredElement(entity, retired));
    }
  }
  for (const entity of [...activeEdges.sort(bySemanticKey), ...activeNodes.sort(bySemanticKey)]) {
    const target = entity.kind === "edge" ? edgeElements : nodeElements;
    target.push(renderPrimaryElement(entity, map, activeEdges));
    if (entity.labelElementId) target.push(renderLabelElement(entity, map));
  }
  const appState = { ...(asObject(currentScene.appState) ?? {}) };
  appState[SEMANTIC_SCENE_MAP_APP_STATE_KEY] = map;
  return {
    ...currentScene,
    elements: [
      ...unmanaged,
      ...retiredElements,
      ...groupBoundaryElements,
      ...edgeElements,
      ...nodeElements,
    ],
    appState,
  };
}

function renderGroupBoundaryElement(group: SemanticSceneGroup): JsonObject {
  const boundary = group.boundary;
  if (!boundary) throw semanticInvalid(`semantic group ${group.semanticKey} has no boundary`);
  return {
    id: boundary.elementId,
    type: "rectangle",
    ...boundary.bounds,
    angle: 0,
    strokeColor: "#868e96",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "dashed",
    roughness: 0,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: boundary.seed,
    version: boundary.version,
    versionNonce: boundary.versionNonce,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: true,
    customData: {
      tweakloop: {
        schema: 1,
        anchorId: group.groupId,
        semanticManaged: true,
        semanticKey: group.semanticKey,
        role: "group-boundary",
        retired: false,
      },
    },
  };
}

function renderPrimaryElement(
  entity: SemanticSceneEntity,
  map: SemanticSceneMap,
  activeEdges: readonly SemanticSceneEntity[],
): JsonObject {
  const common = commonRendererFields(
    entity,
    "primary",
    false,
    groupIdsFor(map, entity.semanticKey),
  );
  if (entity.kind === "edge") {
    const from = map.entities[requireString(entity.from)] as SemanticSceneEntity;
    const to = map.entities[requireString(entity.to)] as SemanticSceneEntity;
    const start = center(from.bounds);
    const end = center(to.bounds);
    return {
      ...common,
      type: "arrow",
      ...entity.bounds,
      points: [
        [start.x - entity.bounds.x, start.y - entity.bounds.y],
        [end.x - entity.bounds.x, end.y - entity.bounds.y],
      ],
      startBinding: bindingFor(requireString(from.elementId)),
      endBinding: bindingFor(requireString(to.elementId)),
      startArrowhead: null,
      endArrowhead: "arrow",
      boundElements: entity.labelElementId ? [{ id: entity.labelElementId, type: "text" }] : [],
    };
  }
  const boundElements: JsonObject[] = [];
  if (entity.labelElementId) boundElements.push({ id: entity.labelElementId, type: "text" });
  for (const edge of activeEdges) {
    if (edge.from === entity.semanticKey || edge.to === entity.semanticKey) {
      boundElements.push({ id: requireString(edge.elementId), type: "arrow" });
    }
  }
  return {
    ...common,
    type: requireShape(entity),
    ...entity.bounds,
    roundness: entity.shape === "rectangle" ? { type: 3 } : null,
    boundElements,
  };
}

function renderLabelElement(entity: SemanticSceneEntity, map: SemanticSceneMap): JsonObject {
  const label = requireString(entity.label);
  const width = Math.min(Math.max(label.length * 10, 40), Math.max(entity.bounds.width - 24, 40));
  const height = 25;
  return {
    ...commonRendererFields(entity, "label", false, groupIdsFor(map, entity.semanticKey)),
    type: "text",
    x: entity.bounds.x + (entity.bounds.width - width) / 2,
    y: entity.bounds.y + (entity.bounds.height - height) / 2,
    width,
    height,
    text: label,
    originalText: label,
    fontSize: 20,
    fontFamily: 1,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: entity.elementId,
    autoResize: true,
    lineHeight: 1.25,
    boundElements: null,
  };
}

function renderRetiredElement(
  entity: SemanticSceneEntity,
  retired: RetiredRendererElement,
): JsonObject {
  const label = entity.label ?? "";
  const common = {
    id: retired.elementId,
    type: retired.elementType,
    x: entity.bounds.x,
    y: entity.bounds.y,
    width: entity.bounds.width,
    height: entity.bounds.height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed: retired.seed,
    version: retired.version,
    versionNonce: retired.versionNonce,
    isDeleted: true,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    customData: managedCustomData(entity, retired.role, true),
  };
  return retired.role === "label"
    ? { ...common, text: label, originalText: label, containerId: null }
    : common;
}

function commonRendererFields(
  entity: SemanticSceneEntity,
  role: "primary" | "label",
  retired: boolean,
  groupIds: readonly string[],
): JsonObject {
  const elementId = role === "primary" ? entity.elementId : entity.labelElementId;
  const version = role === "primary" ? entity.elementVersion : entity.labelVersion;
  const versionNonce = role === "primary" ? entity.elementVersionNonce : entity.labelVersionNonce;
  const seed = role === "primary" ? entity.elementSeed : entity.labelSeed;
  return {
    id: requireString(elementId),
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: entity.kind === "node" && role === "primary" ? "#e7f5ff" : "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [...groupIds],
    frameId: null,
    roundness: null,
    seed: requireNumber(seed),
    version: requireNumber(version),
    versionNonce: requireNumber(versionNonce),
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
    customData: managedCustomData(entity, role, retired),
  };
}

function managedCustomData(
  entity: SemanticSceneEntity,
  role: "primary" | "label",
  retired: boolean,
): JsonObject {
  return {
    tweakloop: {
      schema: 1,
      anchorId: entity.anchorId,
      semanticManaged: true,
      semanticKey: entity.semanticKey,
      role,
      retired,
    },
  };
}

function normalizeOperation(value: unknown, index: number): NormalizedSemanticSceneOperation {
  const operation = requireObject(value, `operation ${index} must be an object`);
  const type = operation.type;
  if (type === "node.upsert") {
    assertOnlyKeys(
      operation,
      ["type", "semanticKey", "shape", "label", "placement"],
      `operation ${index}`,
    );
    validateSemanticKey(operation.semanticKey, `operation ${index} semanticKey`);
    const shape = operation.shape ?? null;
    if (shape !== null && shape !== "rectangle" && shape !== "ellipse" && shape !== "diamond") {
      throw semanticInvalid(`operation ${index} has unsupported node shape`);
    }
    const label = normalizeOptionalLabel(operation, index);
    const placement = normalizePlacement(operation.placement, index);
    return { type, semanticKey: operation.semanticKey, shape, label, placement };
  }
  if (type === "edge.upsert") {
    assertOnlyKeys(operation, ["type", "semanticKey", "from", "to", "label"], `operation ${index}`);
    validateSemanticKey(operation.semanticKey, `operation ${index} semanticKey`);
    validateSemanticKey(operation.from, `operation ${index} from`);
    validateSemanticKey(operation.to, `operation ${index} to`);
    return {
      type,
      semanticKey: operation.semanticKey,
      from: operation.from,
      to: operation.to,
      label: normalizeOptionalLabel(operation, index),
    };
  }
  if (type === "label.set") {
    assertOnlyKeys(operation, ["type", "target", "text"], `operation ${index}`);
    validateSemanticKey(operation.target, `operation ${index} target`);
    return {
      type,
      target: operation.target,
      text: normalizeLabel(operation.text, `operation ${index} text`),
    };
  }
  if (type === "group.set") {
    assertOnlyKeys(operation, ["type", "semanticKey", "members"], `operation ${index}`);
    validateSemanticKey(operation.semanticKey, `operation ${index} semanticKey`);
    if (!Array.isArray(operation.members) || operation.members.length < 1) {
      throw semanticInvalid(`operation ${index} group requires members`);
    }
    const members = operation.members.map((member, memberIndex) => {
      validateSemanticKey(member, `operation ${index} member ${memberIndex}`);
      return member;
    });
    if (new Set(members).size !== members.length) {
      throw semanticInvalid(`operation ${index} group contains duplicate members`);
    }
    return { type, semanticKey: operation.semanticKey, members };
  }
  if (type === "layout.apply") {
    assertOnlyKeys(operation, ["type", "direction", "gap", "scope"], `operation ${index}`);
    const direction = operation.direction ?? "lr";
    if (direction !== "lr" && direction !== "tb") {
      throw semanticInvalid(`operation ${index} has invalid layout direction`);
    }
    const gap = operation.gap ?? DEFAULT_SEMANTIC_LAYOUT_FRAME.gap;
    if (typeof gap !== "number" || !Number.isSafeInteger(gap) || gap < 24 || gap > 512) {
      throw semanticInvalid(`operation ${index} layout gap must be an integer from 24 to 512`);
    }
    let scope: string[] | null = null;
    if (operation.scope !== undefined) {
      if (!Array.isArray(operation.scope) || operation.scope.length < 1) {
        throw semanticInvalid(`operation ${index} layout scope must be a non-empty array`);
      }
      scope = operation.scope.map((entry, scopeIndex) => {
        validateSemanticKey(entry, `operation ${index} scope ${scopeIndex}`);
        return entry;
      });
      if (new Set(scope).size !== scope.length) {
        throw semanticInvalid(`operation ${index} layout scope contains duplicates`);
      }
    }
    return { type, direction, gap, scope };
  }
  if (type === "entity.delete" || type === "element.repair") {
    assertOnlyKeys(operation, ["type", "semanticKey"], `operation ${index}`);
    validateSemanticKey(operation.semanticKey, `operation ${index} semanticKey`);
    return { type, semanticKey: operation.semanticKey };
  }
  if (type === "semantic.rename") {
    assertOnlyKeys(operation, ["type", "semanticKey", "newSemanticKey"], `operation ${index}`);
    validateSemanticKey(operation.semanticKey, `operation ${index} semanticKey`);
    validateSemanticKey(operation.newSemanticKey, `operation ${index} newSemanticKey`);
    return { type, semanticKey: operation.semanticKey, newSemanticKey: operation.newSemanticKey };
  }
  throw semanticInvalid(`operation ${index} has unsupported type ${String(type)}`);
}

function validateReceiptRecord(receipt: SemanticSceneReceiptRecord): void {
  if (receipt.protocol !== SEMANTIC_SCENE_RECEIPT_PROTOCOL) {
    throw receiptCorrupt("semantic receipt protocol is unsupported");
  }
  if (receipt.normalizationVersion !== SEMANTIC_SCENE_NORMALIZATION_VERSION) {
    throw receiptCorrupt("semantic receipt normalization version is unsupported");
  }
  validatePortableIdentifier(receipt.workspaceId, "receipt workspaceId");
  validatePortableIdentifier(receipt.artifactId, "receipt artifactId");
  validatePortableIdentifier(receipt.idempotencyKey, "receipt idempotencyKey");
  const parsed = parseReceiptResponse(receipt.responseJson);
  if (
    parsed.artifactId !== receipt.artifactId ||
    parsed.idempotencyKey !== receipt.idempotencyKey
  ) {
    throw receiptCorrupt("semantic receipt response identity does not match its row key");
  }
  let normalized: unknown;
  try {
    normalized = JSON.parse(receipt.normalizedRequestJson);
  } catch {
    throw receiptCorrupt("semantic receipt normalized request is not valid JSON");
  }
  const normalizedObject = requireObject(
    normalized,
    "semantic receipt normalized request must be an object",
  );
  if (
    normalizedObject.protocol !== SEMANTIC_SCENE_REQUEST_PROTOCOL ||
    normalizedObject.artifactId !== receipt.artifactId ||
    normalizedObject.idempotencyKey !== receipt.idempotencyKey ||
    !Array.isArray(normalizedObject.operations)
  ) {
    throw receiptCorrupt("semantic receipt normalized request does not match its row identity");
  }
  if (
    stableJsonHash({ normalizationVersion: receipt.normalizationVersion, request: normalized }) !==
    receipt.requestHash
  ) {
    throw receiptCorrupt("semantic receipt request hash does not match normalized request bytes");
  }
  if (receipt.sourceProvenance !== null) {
    assertOnlyKeys(
      receipt.sourceProvenance as JsonObject,
      ["workspaceId", "receiptHash"],
      "receipt sourceProvenance",
    );
    validatePortableIdentifier(receipt.sourceProvenance.workspaceId, "source workspaceId");
    validateSha256(receipt.sourceProvenance.receiptHash, "source receiptHash");
  }
  validateReceiptInvalidation(receipt.invalidation, parsed);
}

function parseReceiptResponse(responseJson: string): SemanticSceneResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
  } catch {
    throw receiptCorrupt("semantic receipt response is not valid JSON");
  }
  const response = requireObject(parsed, "semantic receipt response must be an object");
  assertOnlyKeys(
    response,
    [
      "protocol",
      "status",
      "artifactId",
      "idempotencyKey",
      "normalizationVersion",
      "baseRevisionId",
      "draftVersion",
      "sceneHash",
      "elementIndexHash",
      "expectedHeadRevisionId",
      "unchanged",
      "changedTargets",
      "changedBounds",
    ],
    "semantic receipt response",
  );
  if (
    response.protocol !== SEMANTIC_SCENE_RESPONSE_PROTOCOL ||
    response.status !== "accepted" ||
    typeof response.artifactId !== "string" ||
    typeof response.idempotencyKey !== "string" ||
    response.normalizationVersion !== SEMANTIC_SCENE_NORMALIZATION_VERSION ||
    typeof response.baseRevisionId !== "string" ||
    !Number.isSafeInteger(response.draftVersion) ||
    typeof response.sceneHash !== "string" ||
    typeof response.elementIndexHash !== "string" ||
    typeof response.expectedHeadRevisionId !== "string" ||
    typeof response.unchanged !== "boolean" ||
    !Array.isArray(response.changedTargets)
  ) {
    throw receiptCorrupt("semantic receipt response has an invalid shape");
  }
  validatePortableIdentifier(response.artifactId, "response artifactId");
  validatePortableIdentifier(response.idempotencyKey, "response idempotencyKey");
  validatePortableIdentifier(response.baseRevisionId, "response baseRevisionId");
  validatePortableIdentifier(response.expectedHeadRevisionId, "response expectedHeadRevisionId");
  validateSha256(response.sceneHash as string, "response sceneHash");
  validateSha256(response.elementIndexHash as string, "response elementIndexHash");
  const semanticKeys = new Set<string>();
  for (const rawTarget of response.changedTargets) {
    const target = validateReceiptChangedTarget(rawTarget);
    if (semanticKeys.has(target.semanticKey)) {
      throw receiptCorrupt(
        `semantic receipt response repeats changed target ${target.semanticKey}`,
      );
    }
    semanticKeys.add(target.semanticKey);
  }
  const changedBounds = validateReceiptBounds(
    response.changedBounds,
    "response changedBounds",
    true,
  );
  const combined = combineBounds(
    (response.changedTargets as readonly DraftChangedTarget[]).map((target) => target.bounds),
  );
  if (JSON.stringify(changedBounds) !== JSON.stringify(combined)) {
    throw receiptCorrupt("semantic receipt response changedBounds does not cover changed targets");
  }
  if (
    (response.unchanged === true && response.changedTargets.length !== 0) ||
    (response.unchanged === false && response.changedTargets.length === 0)
  ) {
    throw receiptCorrupt("semantic receipt response unchanged flag disagrees with changed targets");
  }
  return parsed as SemanticSceneResponse;
}

function validateReceiptInvalidation(
  descriptor: SemanticDraftInvalidationDescriptor | null,
  response: SemanticSceneResponse,
): void {
  if (response.unchanged) {
    if (descriptor !== null) throw receiptCorrupt("unchanged receipt carries an invalidation");
    return;
  }
  if (
    !descriptor ||
    descriptor.artifactId !== response.artifactId ||
    descriptor.baseRevisionId !== response.baseRevisionId ||
    descriptor.draftVersion !== response.draftVersion ||
    descriptor.sceneHash !== response.sceneHash ||
    descriptor.deduplicationKey !==
      invalidationDeduplicationKey(response.artifactId, response.draftVersion, response.sceneHash)
  ) {
    throw receiptCorrupt("semantic receipt invalidation does not match its response tuple");
  }
  assertOnlyKeys(
    descriptor as JsonObject,
    [
      "artifactId",
      "baseRevisionId",
      "draftVersion",
      "sceneHash",
      "updatedBy",
      "deduplicationKey",
      "changedTargets",
      "changedBounds",
    ],
    "semantic receipt invalidation",
  );
  const actor = requireObject(
    descriptor.updatedBy,
    "semantic receipt invalidation actor must be an object",
  );
  assertOnlyKeys(actor, ["kind", "id"], "semantic receipt invalidation actor");
  validateActor(descriptor.updatedBy);
  if (
    JSON.stringify(descriptor.changedTargets) !== JSON.stringify(response.changedTargets) ||
    JSON.stringify(descriptor.changedBounds) !== JSON.stringify(response.changedBounds)
  ) {
    throw receiptCorrupt(
      "semantic receipt invalidation targets do not match the original response",
    );
  }
}

function validateReceiptChangedTarget(value: unknown): DraftChangedTarget {
  const target = requireObject(value, "semantic receipt changed target must be an object");
  assertOnlyKeys(
    target,
    [
      "semanticKey",
      "anchorId",
      "elementId",
      "elementType",
      "elementVersion",
      "elementVersionNonce",
      "deleted",
      "label",
      "bounds",
    ],
    "semantic receipt changed target",
  );
  validateSemanticKey(target.semanticKey, "changed target semanticKey");
  validatePortableIdentifier(target.anchorId, "changed target anchorId");
  if (target.elementId !== null)
    validatePortableIdentifier(target.elementId, "changed target elementId");
  if (!new Set(["rectangle", "ellipse", "diamond", "arrow"]).has(String(target.elementType))) {
    throw receiptCorrupt("semantic receipt changed target has invalid elementType");
  }
  if (typeof target.deleted !== "boolean") {
    throw receiptCorrupt("semantic receipt changed target has invalid deleted state");
  }
  if (target.label !== null && typeof target.label !== "string") {
    throw receiptCorrupt("semantic receipt changed target has invalid label");
  }
  if (target.deleted) {
    if (
      target.elementId !== null ||
      target.elementVersion !== null ||
      target.elementVersionNonce !== null
    ) {
      throw receiptCorrupt("deleted semantic receipt changed target retains renderer identity");
    }
  } else if (
    !Number.isSafeInteger(target.elementVersion) ||
    Number(target.elementVersion) < 1 ||
    !Number.isSafeInteger(target.elementVersionNonce) ||
    Number(target.elementVersionNonce) < 0
  ) {
    throw receiptCorrupt("live semantic receipt changed target has invalid renderer version");
  }
  validateReceiptBounds(target.bounds, "changed target bounds", false);
  return target as DraftChangedTarget;
}

function validateReceiptBounds(
  value: unknown,
  label: string,
  nullable: boolean,
): SemanticBounds | null {
  if (value === null && nullable) return null;
  const bounds = requireObject(value, `${label} must be an object`);
  assertOnlyKeys(bounds, ["x", "y", "width", "height"], label);
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof bounds[key] !== "number" || !Number.isFinite(bounds[key])) {
      throw receiptCorrupt(`${label}.${key} must be finite`);
    }
  }
  if (Number(bounds.width) < 0 || Number(bounds.height) < 0) {
    throw receiptCorrupt(`${label} width and height must be non-negative`);
  }
  return bounds as SemanticBounds;
}

function validateSha256(value: unknown, label: string): void {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw receiptCorrupt(`${label} must be a lowercase SHA-256 hash`);
  }
}

function changedTargetsFor(
  map: SemanticSceneMap,
  semanticKeys: ReadonlySet<string>,
): DraftChangedTarget[] {
  return [...semanticKeys].sort().flatMap((semanticKey) => {
    const entity = map.entities[semanticKey];
    if (!entity) return [];
    return [
      {
        semanticKey: entity.semanticKey,
        anchorId: entity.anchorId,
        elementId: entity.elementId,
        elementType: entity.kind === "edge" ? "arrow" : requireShape(entity),
        elementVersion: entity.elementVersion,
        elementVersionNonce: entity.elementVersionNonce,
        deleted: entity.deleted,
        label: entity.label,
        bounds: entity.bounds,
      },
    ];
  });
}

function combineBounds(bounds: readonly SemanticBounds[]): SemanticBounds | null {
  if (bounds.length === 0) return null;
  const minX = Math.min(...bounds.map((entry) => entry.x));
  const minY = Math.min(...bounds.map((entry) => entry.y));
  const maxX = Math.max(...bounds.map((entry) => entry.x + entry.width));
  const maxY = Math.max(...bounds.map((entry) => entry.y + entry.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function invalidationDeduplicationKey(
  artifactId: string,
  draftVersion: number,
  sceneHash: string,
): string {
  return `${artifactId}:${draftVersion}:${sceneHash}`;
}

function defaultNodePlacement(
  index: number,
  frame: SemanticLayoutFrame,
): Readonly<{ x: number; y: number }> {
  const columns = Math.max(
    1,
    Math.floor((frame.maxX - frame.minX + frame.gap) / (frame.nodeWidth + frame.gap)),
  );
  const column = index % columns;
  const row = Math.floor(index / columns);
  const placement = {
    x: frame.minX + column * (frame.nodeWidth + frame.gap),
    y: frame.minY + row * (frame.nodeHeight + frame.gap),
  };
  assertBoundsFitFrame(
    { ...placement, width: frame.nodeWidth, height: frame.nodeHeight },
    frame,
    `auto-${index}`,
  );
  return placement;
}

function layoutPlacements(
  count: number,
  direction: "lr" | "tb",
  gap: number,
  frame: SemanticLayoutFrame,
): readonly Readonly<{ x: number; y: number }>[] {
  const placements = Array.from({ length: count }, (_, index) => ({
    x: frame.minX + (direction === "lr" ? index * (frame.nodeWidth + gap) : 0),
    y: frame.minY + (direction === "tb" ? index * (frame.nodeHeight + gap) : 0),
  }));
  for (const [index, placement] of placements.entries()) {
    assertBoundsFitFrame(
      { ...placement, width: frame.nodeWidth, height: frame.nodeHeight },
      frame,
      `layout-${index}`,
    );
  }
  return placements;
}

function assertBoundsFitFrame(
  bounds: SemanticBounds,
  frame: SemanticLayoutFrame,
  semanticKey: string,
): void {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    bounds.x < frame.minX ||
    bounds.y < frame.minY ||
    bounds.x + bounds.width > frame.maxX ||
    bounds.y + bounds.height > frame.maxY
  ) {
    throw new WhiteboardError(
      "whiteboard.semantic-geometry-out-of-frame",
      `semantic entity ${semanticKey} does not fit the server logical LayoutFrame`,
      409,
      { bounds, frame },
    );
  }
}

function validateLayoutFrame(frame: SemanticLayoutFrame): void {
  for (const [key, value] of Object.entries(frame)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw semanticInvalid(`LayoutFrame.${key} must be a finite non-negative number`);
    }
  }
  if (
    frame.maxX <= frame.minX ||
    frame.maxY <= frame.minY ||
    frame.nodeWidth <= 0 ||
    frame.nodeHeight <= 0
  ) {
    throw semanticInvalid("LayoutFrame must have positive usable dimensions");
  }
}

function edgeBounds(from: SemanticSceneEntity, to: SemanticSceneEntity): SemanticBounds {
  const start = center(from.bounds);
  const end = center(to.bounds);
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function center(bounds: SemanticBounds): Readonly<{ x: number; y: number }> {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function bindingFor(elementId: string): JsonObject {
  return { elementId, focus: 0, gap: 8, fixedPoint: null };
}

function groupIdsFor(map: SemanticSceneMap, semanticKey: string): string[] {
  return Object.values(map.groups)
    .filter((group) => group.members.includes(semanticKey))
    .sort(bySemanticKey)
    .map((group) => group.groupId);
}

function activeNodes(
  entities: Readonly<Record<string, SemanticSceneEntity>>,
): SemanticSceneEntity[] {
  return Object.values(entities).filter((entity) => entity.kind === "node" && !entity.deleted);
}

function requireActiveEntity(
  entities: Readonly<Record<string, SemanticSceneEntity>>,
  semanticKey: string,
): SemanticSceneEntity {
  const entity = entities[semanticKey];
  if (!entity || entity.deleted) {
    throw semanticInvalid(`semantic entity ${semanticKey} does not exist or is deleted`);
  }
  return entity;
}

function requireActiveNode(
  entities: Readonly<Record<string, SemanticSceneEntity>>,
  semanticKey: string,
  label: string,
): SemanticSceneEntity {
  const entity = requireActiveEntity(entities, semanticKey);
  if (entity.kind !== "node")
    throw semanticInvalid(`${label} ${semanticKey} is not a semantic node`);
  return entity;
}

function allocateRendererIdentity(
  allocator: SemanticIdentityAllocator,
): Readonly<{ elementId: string; seed: number; versionNonce: number }> {
  return {
    elementId: checkedId(allocator.newElementId(), "elementId"),
    seed: checkedPositiveInteger(allocator.newSeed(), "seed"),
    versionNonce: checkedNonce(allocator.newVersionNonce()),
  };
}

function operationSemanticKey(operation: NormalizedSemanticSceneOperation): string | null {
  if (operation.type === "label.set") return operation.target;
  if (operation.type === "layout.apply") return null;
  return operation.semanticKey;
}

function normalizePlacement(
  value: unknown,
  index: number,
): Readonly<{ x: number; y: number }> | null {
  if (value === undefined) return null;
  const placement = requireObject(value, `operation ${index} placement must be an object`);
  assertOnlyKeys(placement, ["x", "y"], `operation ${index} placement`);
  if (
    typeof placement.x !== "number" ||
    !Number.isFinite(placement.x) ||
    typeof placement.y !== "number" ||
    !Number.isFinite(placement.y)
  ) {
    throw semanticInvalid(`operation ${index} placement must use finite scene coordinates`);
  }
  return { x: placement.x, y: placement.y };
}

function normalizeLabel(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 500 || hasControlCharacter(value)) {
    throw semanticInvalid(`${label} must be printable text no longer than 500 characters`);
  }
  return value;
}

function normalizeOptionalLabel(operation: JsonObject, index: number): NormalizedOptionalLabel {
  return Object.hasOwn(operation, "label")
    ? { mode: "set", value: normalizeLabel(operation.label, `operation ${index} label`) }
    : { mode: "preserve" };
}

function validateDraftTuple(value: SemanticDraftTuple): void {
  validatePortableIdentifier(value.artifactId, "currentDraft.artifactId");
  validatePortableIdentifier(value.draftId, "currentDraft.draftId");
  validatePortableIdentifier(value.baseRevisionId, "currentDraft.baseRevisionId");
  validatePortableIdentifier(value.expectedHeadRevisionId, "currentDraft.expectedHeadRevisionId");
  if (!Number.isSafeInteger(value.draftVersion) || value.draftVersion < 0) {
    throw semanticInvalid("currentDraft.draftVersion must be a non-negative safe integer");
  }
}

function validateActor(actor: ActorRef): void {
  if (
    !actor ||
    (actor.kind !== "human" && actor.kind !== "agent" && actor.kind !== "system") ||
    typeof actor.id !== "string"
  ) {
    throw semanticInvalid("trusted semantic scene actor is invalid");
  }
  validatePortableIdentifier(actor.kind, "actor.kind");
  validatePortableIdentifier(actor.id, "actor.id");
}

function validateSemanticKey(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/.test(value)
  ) {
    throw semanticInvalid(`${label} must be a stable lower-case semantic key`);
  }
}

function validatePortableIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    hasControlCharacter(value)
  ) {
    throw semanticInvalid(`${label} must be a non-empty printable identifier`);
  }
}

function checkedId(value: string, label: string): string {
  validatePortableIdentifier(value, label);
  if (!/^[!-~]+$/.test(value)) throw semanticInvalid(`${label} must not contain whitespace`);
  return value;
}

function checkedPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw semanticInvalid(`${label} allocator returned an invalid positive integer`);
  }
  return value;
}

function checkedNonce(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw semanticInvalid("versionNonce allocator returned an invalid non-negative integer");
  }
  return value;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBounds(left: SemanticBounds, right: SemanticBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function bySemanticKey<T extends Readonly<{ semanticKey: string }>>(left: T, right: T): number {
  return left.semanticKey.localeCompare(right.semanticKey);
}

function requireShape(entity: SemanticSceneEntity): "rectangle" | "ellipse" | "diamond" {
  if (entity.shape !== "rectangle" && entity.shape !== "ellipse" && entity.shape !== "diamond") {
    throw semanticInvalid(`semantic node ${entity.semanticKey} has no renderer shape`);
  }
  return entity.shape;
}

function requireNumber(value: number | null): number {
  if (value === null) throw semanticInvalid("managed renderer number is missing");
  return value;
}

function requireString(value: string | null): string {
  if (value === null) throw semanticInvalid("managed renderer identity is missing");
  return value;
}

function requireObject(value: unknown, message: string): JsonObject {
  const object = asObject(value);
  if (!object) throw semanticInvalid(message);
  return object;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw semanticInvalid(`${label} contains unknown field ${unknown}`);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) as number;
    if (codePoint < 0x20 || codePoint === 0x7f) return true;
  }
  return false;
}

function semanticInvalid(message: string): WhiteboardError {
  return new WhiteboardError("whiteboard.semantic-command-invalid", message, 400);
}

function receiptCorrupt(message: string): WhiteboardError {
  return new WhiteboardError("whiteboard.semantic-receipt-corrupt", message, 409);
}
