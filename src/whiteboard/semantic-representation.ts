import { WhiteboardError } from "./errors.js";

export const SEMANTIC_SCENE_MAP_PROTOCOL = "tweakloop.semantic-scene-map/v1" as const;
export const SEMANTIC_SCENE_MAP_APP_STATE_KEY = "tweakloopSemanticScene" as const;
/** Fixed logical-space inset between member bounds and their visual enclosure. */
export const SEMANTIC_GROUP_BOUNDARY_PADDING = 32;

export type SemanticBounds = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type RetiredRendererElement = Readonly<{
  elementId: string;
  elementType: "rectangle" | "ellipse" | "diamond" | "arrow" | "text";
  role: "primary" | "label";
  version: number;
  versionNonce: number;
  seed: number;
}>;

export type SemanticSceneEntity = Readonly<{
  semanticKey: string;
  kind: "node" | "edge";
  anchorId: string;
  elementId: string | null;
  labelElementId: string | null;
  deleted: boolean;
  label: string | null;
  shape: "rectangle" | "ellipse" | "diamond" | null;
  from: string | null;
  to: string | null;
  bounds: SemanticBounds;
  elementVersion: number | null;
  elementVersionNonce: number | null;
  elementSeed: number | null;
  labelVersion: number | null;
  labelVersionNonce: number | null;
  labelSeed: number | null;
  retiredElements: readonly RetiredRendererElement[];
}>;

export type SemanticSceneGroup = Readonly<{
  semanticKey: string;
  groupId: string;
  members: readonly string[];
  /** Internal renderer authority; absent only on legacy v1 maps until their next mutation. */
  boundary?: SemanticSceneGroupBoundary | null;
}>;

export type SemanticSceneGroupBoundary = Readonly<{
  elementId: string;
  version: number;
  versionNonce: number;
  seed: number;
  bounds: SemanticBounds;
}>;

export type SemanticSceneMap = Readonly<{
  protocol: typeof SEMANTIC_SCENE_MAP_PROTOCOL;
  entities: Readonly<Record<string, SemanticSceneEntity>>;
  groups: Readonly<Record<string, SemanticSceneGroup>>;
}>;

export type ManagedElementMetadata = Readonly<{
  semanticKey: string;
  anchorId: string;
  role: "primary" | "label" | "group-boundary";
  retired: boolean;
}>;

type JsonObject = Record<string, unknown>;

export function emptySemanticSceneMap(): SemanticSceneMap {
  return { protocol: SEMANTIC_SCENE_MAP_PROTOCOL, entities: {}, groups: {} };
}

export function readSemanticSceneMap(scene: Readonly<JsonObject>): SemanticSceneMap | null {
  const appState = asObject(scene.appState);
  const candidate = appState?.[SEMANTIC_SCENE_MAP_APP_STATE_KEY];
  if (candidate === undefined) return null;
  validateSemanticSceneMap(candidate);
  return candidate as SemanticSceneMap;
}

export function validateSemanticSceneRepresentation(scene: Readonly<JsonObject>): void {
  const elements = Array.isArray(scene.elements) ? scene.elements : [];
  const map = readSemanticSceneMap(scene);
  const claimed = new Map<
    string,
    ManagedElementMetadata & Readonly<{ expectedDeleted: boolean }>
  >();

  if (map) {
    for (const entity of Object.values(map.entities)) {
      if (!entity.deleted && entity.elementId) {
        claim(claimed, entity.elementId, {
          semanticKey: entity.semanticKey,
          anchorId: entity.anchorId,
          role: "primary",
          retired: false,
          expectedDeleted: false,
        });
      }
      if (!entity.deleted && entity.labelElementId) {
        claim(claimed, entity.labelElementId, {
          semanticKey: entity.semanticKey,
          anchorId: entity.anchorId,
          role: "label",
          retired: false,
          expectedDeleted: false,
        });
      }
      for (const retired of entity.retiredElements) {
        claim(claimed, retired.elementId, {
          semanticKey: entity.semanticKey,
          anchorId: entity.anchorId,
          role: retired.role,
          retired: true,
          expectedDeleted: true,
        });
      }
    }
    for (const group of Object.values(map.groups)) {
      if (!group.boundary) continue;
      claim(claimed, group.boundary.elementId, {
        semanticKey: group.semanticKey,
        anchorId: group.groupId,
        role: "group-boundary",
        retired: false,
        expectedDeleted: false,
      });
    }
  }

  const observed = new Set<string>();
  const observedSemanticRoles = new Map<string, string>();
  for (const candidate of elements) {
    const element = asObject(candidate);
    if (!element || typeof element.id !== "string") continue;
    const metadata = managedElementMetadata(element);
    const rawSemanticKey = rawSemanticKeyForElement(element);
    if (!metadata) {
      if (rawSemanticKey !== null) {
        throw representationInvalid(
          `element ${element.id} carries semanticKey without authoritative managed metadata`,
        );
      }
      continue;
    }
    if (!map) {
      throw representationInvalid(
        `managed element ${element.id} exists without ${SEMANTIC_SCENE_MAP_APP_STATE_KEY}`,
      );
    }
    const semanticRole = `${metadata.semanticKey}\u0000${metadata.role}`;
    const previous = observedSemanticRoles.get(semanticRole);
    if (previous && previous !== element.id && !metadata.retired) {
      throw representationInvalid(
        `duplicate live semantic role ${metadata.semanticKey}/${metadata.role}: ${previous}, ${element.id}`,
      );
    }
    if (!metadata.retired) observedSemanticRoles.set(semanticRole, element.id);
    const expected = claimed.get(element.id);
    if (!expected || !sameMetadata(expected, metadata)) {
      throw representationInvalid(
        `managed element ${element.id} disagrees with the authoritative SemanticSceneMap`,
      );
    }
    const isDeleted = element.isDeleted === true;
    if (isDeleted !== expected.expectedDeleted) {
      throw representationInvalid(
        `managed element ${element.id} deletion state disagrees with the authoritative SemanticSceneMap`,
      );
    }
    validateManagedElementProjection(element, map, metadata);
    if (observed.has(element.id)) {
      throw representationInvalid(`managed element ${element.id} is represented more than once`);
    }
    observed.add(element.id);
  }

  for (const elementId of claimed.keys()) {
    if (!observed.has(elementId)) {
      throw representationInvalid(
        `SemanticSceneMap references managed element ${elementId} that is missing from the scene`,
      );
    }
  }
}

export function managedElementMetadata(
  element: Readonly<JsonObject>,
): ManagedElementMetadata | null {
  const customData = asObject(element.customData);
  const tweakloop = asObject(customData?.tweakloop);
  if (tweakloop?.semanticManaged !== true) return null;
  const semanticKey = tweakloop.semanticKey;
  const anchorId = tweakloop.anchorId;
  const role = tweakloop.role;
  const retired = tweakloop.retired === true;
  if (
    typeof semanticKey !== "string" ||
    typeof anchorId !== "string" ||
    (role !== "primary" && role !== "label" && role !== "group-boundary")
  ) {
    throw representationInvalid(
      `managed element ${String(element.id)} has incomplete semantic metadata`,
    );
  }
  return { semanticKey, anchorId, role, retired };
}

export function semanticElementIndexFields(element: Readonly<JsonObject>): Readonly<{
  semanticKey: string;
  anchorId?: string;
  semanticRole: "primary" | "label";
  semanticRetired: boolean;
}> | null {
  const metadata = managedElementMetadata(element);
  if (metadata?.role === "group-boundary") return null;
  return metadata
    ? {
        semanticKey: metadata.semanticKey,
        semanticRole: metadata.role,
        semanticRetired: metadata.retired,
        ...(metadata.role === "primary" && !metadata.retired
          ? { anchorId: metadata.anchorId }
          : {}),
      }
    : null;
}

function validateSemanticSceneMap(value: unknown): void {
  const map = requireObject(value, "SemanticSceneMap must be an object");
  assertOnlyKeys(map, ["protocol", "entities", "groups"], "SemanticSceneMap");
  if (map.protocol !== SEMANTIC_SCENE_MAP_PROTOCOL) {
    throw representationInvalid("SemanticSceneMap protocol is unsupported");
  }
  const entities = requireObject(map.entities, "SemanticSceneMap entities must be an object");
  const groups = requireObject(map.groups, "SemanticSceneMap groups must be an object");
  const anchors = new Set<string>();
  const rendererIds = new Set<string>();
  for (const [semanticKey, rawEntity] of Object.entries(entities)) {
    validateSemanticKey(semanticKey, "semantic entity key");
    const entity = requireObject(rawEntity, `semantic entity ${semanticKey} must be an object`);
    assertOnlyKeys(
      entity,
      [
        "semanticKey",
        "kind",
        "anchorId",
        "elementId",
        "labelElementId",
        "deleted",
        "label",
        "shape",
        "from",
        "to",
        "bounds",
        "elementVersion",
        "elementVersionNonce",
        "elementSeed",
        "labelVersion",
        "labelVersionNonce",
        "labelSeed",
        "retiredElements",
      ],
      `semantic entity ${semanticKey}`,
    );
    if (entity.semanticKey !== semanticKey) {
      throw representationInvalid(`semantic entity ${semanticKey} has a mismatched semanticKey`);
    }
    if (entity.kind !== "node" && entity.kind !== "edge") {
      throw representationInvalid(`semantic entity ${semanticKey} has an invalid kind`);
    }
    validateIdentifier(entity.anchorId, `semantic entity ${semanticKey} anchorId`);
    if (anchors.has(entity.anchorId as string)) {
      throw representationInvalid(`duplicate semantic anchorId ${String(entity.anchorId)}`);
    }
    anchors.add(entity.anchorId as string);
    if (typeof entity.deleted !== "boolean") {
      throw representationInvalid(`semantic entity ${semanticKey} has invalid deleted state`);
    }
    if (entity.deleted && (entity.elementId !== null || entity.labelElementId !== null)) {
      throw representationInvalid(
        `deleted semantic entity ${semanticKey} retains a live elementId`,
      );
    }
    if (!entity.deleted && typeof entity.elementId !== "string") {
      throw representationInvalid(`live semantic entity ${semanticKey} is missing elementId`);
    }
    validateNullableIdentifier(entity.elementId, `semantic entity ${semanticKey} elementId`);
    validateNullableIdentifier(
      entity.labelElementId,
      `semantic entity ${semanticKey} labelElementId`,
    );
    addRendererId(rendererIds, entity.elementId, semanticKey);
    addRendererId(rendererIds, entity.labelElementId, semanticKey);
    if (entity.label !== null && typeof entity.label !== "string") {
      throw representationInvalid(`semantic entity ${semanticKey} has an invalid label`);
    }
    if (!entity.deleted && (entity.label !== null) !== (entity.labelElementId !== null)) {
      throw representationInvalid(
        `live semantic entity ${semanticKey} label and labelElementId disagree`,
      );
    }
    if (entity.kind === "node") {
      if (!new Set(["rectangle", "ellipse", "diamond"]).has(String(entity.shape))) {
        throw representationInvalid(`semantic node ${semanticKey} has an invalid shape`);
      }
      if (entity.from !== null || entity.to !== null) {
        throw representationInvalid(`semantic node ${semanticKey} carries edge endpoints`);
      }
    } else {
      if (entity.shape !== null) {
        throw representationInvalid(`semantic edge ${semanticKey} carries a node shape`);
      }
      validateSemanticKey(entity.from, `semantic edge ${semanticKey} from`);
      validateSemanticKey(entity.to, `semantic edge ${semanticKey} to`);
    }
    validateBounds(entity.bounds, `semantic entity ${semanticKey} bounds`);
    validateRendererTuple(entity, semanticKey);
    if (!Array.isArray(entity.retiredElements)) {
      throw representationInvalid(
        `semantic entity ${semanticKey} retiredElements must be an array`,
      );
    }
    for (const rawRetired of entity.retiredElements) {
      const retired = requireObject(
        rawRetired,
        `semantic entity ${semanticKey} retired element must be an object`,
      );
      assertOnlyKeys(
        retired,
        ["elementId", "elementType", "role", "version", "versionNonce", "seed"],
        `semantic entity ${semanticKey} retired element`,
      );
      validateIdentifier(retired.elementId, `semantic entity ${semanticKey} retired elementId`);
      if (
        !new Set(["rectangle", "ellipse", "diamond", "arrow", "text"]).has(
          String(retired.elementType),
        )
      ) {
        throw representationInvalid(
          `semantic entity ${semanticKey} has invalid retired element type`,
        );
      }
      if (retired.role !== "primary" && retired.role !== "label") {
        throw representationInvalid(`semantic entity ${semanticKey} has invalid retired role`);
      }
      validatePositiveInteger(retired.version, `semantic entity ${semanticKey} retired version`);
      validateNonNegativeInteger(
        retired.versionNonce,
        `semantic entity ${semanticKey} retired versionNonce`,
      );
      validatePositiveInteger(retired.seed, `semantic entity ${semanticKey} retired seed`);
      addRendererId(rendererIds, retired.elementId, semanticKey);
    }
  }

  for (const [semanticKey, rawEntity] of Object.entries(entities)) {
    const entity = rawEntity as JsonObject;
    if (entity.kind !== "edge" || entity.deleted === true) continue;
    const from = entities[entity.from as string] as JsonObject | undefined;
    const to = entities[entity.to as string] as JsonObject | undefined;
    if (
      !from ||
      !to ||
      from.kind !== "node" ||
      to.kind !== "node" ||
      from.deleted === true ||
      to.deleted === true ||
      entity.from === entity.to
    ) {
      throw representationInvalid(
        `semantic edge ${semanticKey} has missing, deleted, non-node, or identical endpoints`,
      );
    }
    const start = center(from.bounds as SemanticBounds);
    const end = center(to.bounds as SemanticBounds);
    const expectedBounds = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    if (!sameBounds(entity.bounds as SemanticBounds, expectedBounds)) {
      throw representationInvalid(
        `semantic edge ${semanticKey} bounds disagree with its authoritative endpoints`,
      );
    }
  }

  const groupIds = new Set<string>();
  for (const [semanticKey, rawGroup] of Object.entries(groups)) {
    validateSemanticKey(semanticKey, "semantic group key");
    if (entities[semanticKey] !== undefined) {
      throw representationInvalid(`semantic key ${semanticKey} is used by an entity and group`);
    }
    const group = requireObject(rawGroup, `semantic group ${semanticKey} must be an object`);
    assertOnlyKeys(
      group,
      ["semanticKey", "groupId", "members", "boundary"],
      `semantic group ${semanticKey}`,
    );
    if (group.semanticKey !== semanticKey) {
      throw representationInvalid(`semantic group ${semanticKey} has a mismatched semanticKey`);
    }
    validateIdentifier(group.groupId, `semantic group ${semanticKey} groupId`);
    if (groupIds.has(group.groupId as string)) {
      throw representationInvalid(`duplicate semantic groupId ${String(group.groupId)}`);
    }
    groupIds.add(group.groupId as string);
    if (!Array.isArray(group.members) || new Set(group.members).size !== group.members.length) {
      throw representationInvalid(`semantic group ${semanticKey} has invalid or duplicate members`);
    }
    for (const member of group.members) {
      validateSemanticKey(member, `semantic group ${semanticKey} member`);
      const entity = entities[member as string] as JsonObject | undefined;
      if (!entity || entity.deleted === true) {
        throw representationInvalid(
          `semantic group ${semanticKey} references missing/deleted ${String(member)}`,
        );
      }
    }
    const hasBoundary = Object.hasOwn(group, "boundary");
    if (!hasBoundary) continue;
    if (group.boundary === null) {
      if (group.members.length > 0) {
        throw representationInvalid(`non-empty semantic group ${semanticKey} is missing boundary`);
      }
      continue;
    }
    if (group.members.length === 0) {
      throw representationInvalid(`empty semantic group ${semanticKey} retains boundary`);
    }
    const boundary = requireObject(
      group.boundary,
      `semantic group ${semanticKey} boundary must be an object or null`,
    );
    assertOnlyKeys(
      boundary,
      ["elementId", "version", "versionNonce", "seed", "bounds"],
      `semantic group ${semanticKey} boundary`,
    );
    validateIdentifier(boundary.elementId, `semantic group ${semanticKey} boundary elementId`);
    validatePositiveInteger(boundary.version, `semantic group ${semanticKey} boundary version`);
    validateNonNegativeInteger(
      boundary.versionNonce,
      `semantic group ${semanticKey} boundary versionNonce`,
    );
    validatePositiveInteger(boundary.seed, `semantic group ${semanticKey} boundary seed`);
    validateBounds(boundary.bounds, `semantic group ${semanticKey} boundary bounds`);
    addRendererId(rendererIds, boundary.elementId, semanticKey);
    const expectedBounds = semanticGroupBoundaryBounds(
      group.members.map(
        (member) => (entities[member as string] as JsonObject).bounds as SemanticBounds,
      ),
    );
    if (!sameBounds(boundary.bounds as SemanticBounds, expectedBounds)) {
      throw representationInvalid(
        `semantic group ${semanticKey} boundary bounds disagree with its active members`,
      );
    }
  }
}

function validateManagedElementProjection(
  element: Readonly<JsonObject>,
  map: SemanticSceneMap,
  metadata: ManagedElementMetadata,
): void {
  if (metadata.role === "group-boundary") {
    validateManagedGroupBoundaryProjection(element, map, metadata);
    return;
  }
  const entity = map.entities[metadata.semanticKey];
  if (!entity) {
    throw representationInvalid(
      `managed element ${String(element.id)} has no authoritative semantic entity`,
    );
  }
  const retired = metadata.retired
    ? entity.retiredElements.find((candidate) => candidate.elementId === element.id)
    : null;
  const expectedType = retired
    ? retired.elementType
    : metadata.role === "label"
      ? "text"
      : entity.kind === "edge"
        ? "arrow"
        : entity.shape;
  const expectedVersion = retired
    ? retired.version
    : metadata.role === "label"
      ? entity.labelVersion
      : entity.elementVersion;
  const expectedVersionNonce = retired
    ? retired.versionNonce
    : metadata.role === "label"
      ? entity.labelVersionNonce
      : entity.elementVersionNonce;
  const expectedSeed = retired
    ? retired.seed
    : metadata.role === "label"
      ? entity.labelSeed
      : entity.elementSeed;
  if (
    element.type !== expectedType ||
    element.version !== expectedVersion ||
    element.versionNonce !== expectedVersionNonce ||
    element.seed !== expectedSeed
  ) {
    throw representationInvalid(
      `managed element ${String(element.id)} renderer tuple disagrees with the authoritative SemanticSceneMap`,
    );
  }
  if (retired) return;

  const expectedGroupIds = Object.values(map.groups)
    .filter((group) => group.members.includes(entity.semanticKey))
    .sort((left, right) => left.semanticKey.localeCompare(right.semanticKey))
    .map((group) => group.groupId);
  if (!sameStringArray(element.groupIds, expectedGroupIds)) {
    throw representationInvalid(
      `managed element ${String(element.id)} group projection disagrees with the authoritative SemanticSceneMap`,
    );
  }
  if (metadata.role === "label") {
    const label = entity.label;
    if (label === null || element.text !== label || element.containerId !== entity.elementId) {
      throw representationInvalid(
        `managed label ${String(element.id)} content or container disagrees with the authoritative SemanticSceneMap`,
      );
    }
    const width = Math.min(Math.max(label.length * 10, 40), Math.max(entity.bounds.width - 24, 40));
    validateElementBounds(element, {
      x: entity.bounds.x + (entity.bounds.width - width) / 2,
      y: entity.bounds.y + (entity.bounds.height - 25) / 2,
      width,
      height: 25,
    });
    return;
  }
  if (entity.kind === "node") {
    validateElementBounds(element, entity.bounds);
    return;
  }
  const from = map.entities[entity.from as string];
  const to = map.entities[entity.to as string];
  if (!from?.elementId || !to?.elementId) {
    throw representationInvalid(
      `managed edge ${entity.semanticKey} has invalid endpoint ownership`,
    );
  }
  const start = center(from.bounds);
  const end = center(to.bounds);
  validateElementBounds(element, entity.bounds);
  const points = element.points;
  if (
    !Array.isArray(points) ||
    !samePoint(points[0], [start.x - entity.bounds.x, start.y - entity.bounds.y]) ||
    !samePoint(points[1], [end.x - entity.bounds.x, end.y - entity.bounds.y]) ||
    bindingElementId(element.startBinding) !== from.elementId ||
    bindingElementId(element.endBinding) !== to.elementId
  ) {
    throw representationInvalid(
      `managed edge ${entity.semanticKey} geometry or bindings disagree with the authoritative SemanticSceneMap`,
    );
  }
}

function validateManagedGroupBoundaryProjection(
  element: Readonly<JsonObject>,
  map: SemanticSceneMap,
  metadata: ManagedElementMetadata,
): void {
  const group = map.groups[metadata.semanticKey];
  const boundary = group?.boundary;
  if (!group || !boundary || metadata.anchorId !== group.groupId) {
    throw representationInvalid(
      `managed group boundary ${String(element.id)} has no authoritative semantic group`,
    );
  }
  assertOnlyKeys(
    element as JsonObject,
    [
      "id",
      "type",
      "x",
      "y",
      "width",
      "height",
      "angle",
      "strokeColor",
      "backgroundColor",
      "fillStyle",
      "strokeWidth",
      "strokeStyle",
      "roughness",
      "opacity",
      "groupIds",
      "frameId",
      "roundness",
      "seed",
      "version",
      "versionNonce",
      "isDeleted",
      "boundElements",
      "updated",
      "link",
      "locked",
      "customData",
    ],
    `managed group boundary ${String(element.id)}`,
  );
  if (
    element.id !== boundary.elementId ||
    element.type !== "rectangle" ||
    element.version !== boundary.version ||
    element.versionNonce !== boundary.versionNonce ||
    element.seed !== boundary.seed
  ) {
    throw representationInvalid(
      `managed group boundary ${String(element.id)} renderer tuple disagrees with the authoritative SemanticSceneMap`,
    );
  }
  validateElementBounds(element, boundary.bounds);
  if (
    element.angle !== 0 ||
    element.strokeColor !== "#868e96" ||
    element.backgroundColor !== "transparent" ||
    element.fillStyle !== "solid" ||
    element.strokeWidth !== 2 ||
    element.strokeStyle !== "dashed" ||
    element.roughness !== 0 ||
    element.opacity !== 100 ||
    !sameStringArray(element.groupIds, []) ||
    element.frameId !== null ||
    element.roundness !== null ||
    element.isDeleted !== false ||
    element.boundElements !== null ||
    element.updated !== 1 ||
    element.link !== null ||
    element.locked !== true
  ) {
    throw representationInvalid(
      `managed group boundary ${String(element.id)} renderer bytes disagree with the authoritative projection`,
    );
  }
  const customData = requireObject(
    element.customData,
    `managed group boundary ${String(element.id)} customData must be an object`,
  );
  assertOnlyKeys(
    customData,
    ["tweakloop"],
    `managed group boundary ${String(element.id)} customData`,
  );
  const tweakloop = requireObject(
    customData.tweakloop,
    `managed group boundary ${String(element.id)} tweakloop metadata must be an object`,
  );
  assertOnlyKeys(
    tweakloop,
    ["schema", "anchorId", "semanticManaged", "semanticKey", "role", "retired"],
    `managed group boundary ${String(element.id)} tweakloop metadata`,
  );
  if (tweakloop.schema !== 1) {
    throw representationInvalid(
      `managed group boundary ${String(element.id)} has unsupported metadata schema`,
    );
  }
}

export function semanticGroupBoundaryBounds(
  memberBounds: readonly SemanticBounds[],
): SemanticBounds {
  if (memberBounds.length === 0) {
    throw representationInvalid("semantic group boundary requires at least one active member");
  }
  const minX = Math.min(...memberBounds.map((bounds) => bounds.x));
  const minY = Math.min(...memberBounds.map((bounds) => bounds.y));
  const maxX = Math.max(...memberBounds.map((bounds) => bounds.x + bounds.width));
  const maxY = Math.max(...memberBounds.map((bounds) => bounds.y + bounds.height));
  return {
    x: minX - SEMANTIC_GROUP_BOUNDARY_PADDING,
    y: minY - SEMANTIC_GROUP_BOUNDARY_PADDING,
    width: maxX - minX + SEMANTIC_GROUP_BOUNDARY_PADDING * 2,
    height: maxY - minY + SEMANTIC_GROUP_BOUNDARY_PADDING * 2,
  };
}

function validateElementBounds(element: Readonly<JsonObject>, expected: SemanticBounds): void {
  for (const key of ["x", "y", "width", "height"] as const) {
    if (element[key] !== expected[key]) {
      throw representationInvalid(
        `managed element ${String(element.id)} ${key} disagrees with the authoritative SemanticSceneMap`,
      );
    }
  }
}

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function samePoint(value: unknown, expected: readonly [number, number]): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] === expected[0] &&
    value[1] === expected[1]
  );
}

function bindingElementId(value: unknown): unknown {
  return asObject(value)?.elementId;
}

function center(bounds: SemanticBounds): Readonly<{ x: number; y: number }> {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
}

function sameBounds(left: SemanticBounds, right: SemanticBounds): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}

function validateRendererTuple(entity: JsonObject, semanticKey: string): void {
  for (const key of ["elementVersion", "elementSeed"] as const) {
    const value = entity[key];
    if (entity.deleted) {
      if (value !== null) {
        throw representationInvalid(`deleted semantic entity ${semanticKey} retains ${key}`);
      }
    } else {
      validatePositiveInteger(value, `semantic entity ${semanticKey} ${key}`);
    }
  }
  if (entity.deleted) {
    if (entity.elementVersionNonce !== null) {
      throw representationInvalid(
        `deleted semantic entity ${semanticKey} retains elementVersionNonce`,
      );
    }
  } else {
    validateNonNegativeInteger(
      entity.elementVersionNonce,
      `semantic entity ${semanticKey} elementVersionNonce`,
    );
  }
  const hasLabel = entity.labelElementId !== null;
  for (const key of ["labelVersion", "labelSeed"] as const) {
    const value = entity[key];
    if (hasLabel) validatePositiveInteger(value, `semantic entity ${semanticKey} ${key}`);
    else if (value !== null) {
      throw representationInvalid(
        `semantic entity ${semanticKey} has ${key} without label element`,
      );
    }
  }
  if (hasLabel) {
    validateNonNegativeInteger(
      entity.labelVersionNonce,
      `semantic entity ${semanticKey} labelVersionNonce`,
    );
  } else if (entity.labelVersionNonce !== null) {
    throw representationInvalid(
      `semantic entity ${semanticKey} has labelVersionNonce without label element`,
    );
  }
}

function validateBounds(value: unknown, label: string): void {
  const bounds = requireObject(value, `${label} must be an object`);
  assertOnlyKeys(bounds, ["x", "y", "width", "height"], label);
  for (const key of ["x", "y", "width", "height"] as const) {
    if (typeof bounds[key] !== "number" || !Number.isFinite(bounds[key])) {
      throw representationInvalid(`${label}.${key} must be finite`);
    }
  }
  if ((bounds.width as number) < 0 || (bounds.height as number) < 0) {
    throw representationInvalid(`${label} width and height must be non-negative`);
  }
}

function rawSemanticKeyForElement(element: Readonly<JsonObject>): string | null {
  const customData = asObject(element.customData);
  const tweakloop = asObject(customData?.tweakloop);
  return typeof tweakloop?.semanticKey === "string" ? tweakloop.semanticKey : null;
}

function sameMetadata(expected: ManagedElementMetadata, observed: ManagedElementMetadata): boolean {
  return (
    expected.semanticKey === observed.semanticKey &&
    expected.anchorId === observed.anchorId &&
    expected.role === observed.role &&
    expected.retired === observed.retired
  );
}

function claim(
  claimed: Map<string, ManagedElementMetadata & Readonly<{ expectedDeleted: boolean }>>,
  elementId: string,
  metadata: ManagedElementMetadata & Readonly<{ expectedDeleted: boolean }>,
): void {
  if (claimed.has(elementId)) {
    throw representationInvalid(`renderer element ${elementId} is claimed more than once`);
  }
  claimed.set(elementId, metadata);
}

function addRendererId(ids: Set<string>, value: unknown, semanticKey: string): void {
  if (value === null) return;
  if (typeof value !== "string" || ids.has(value)) {
    throw representationInvalid(`semantic entity ${semanticKey} has duplicate renderer identity`);
  }
  ids.add(value);
}

function assertOnlyKeys(value: JsonObject, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw representationInvalid(`${label} contains unknown field ${unknown}`);
}

function validateSemanticKey(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/.test(value)
  ) {
    throw representationInvalid(`${label} must be a stable lower-case semantic key`);
  }
}

function validateIdentifier(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 160 ||
    !/^[!-~]+$/.test(value)
  ) {
    throw representationInvalid(`${label} must be a printable identifier`);
  }
}

function validateNullableIdentifier(value: unknown, label: string): void {
  if (value !== null) validateIdentifier(value, label);
}

function validatePositiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw representationInvalid(`${label} must be a positive safe integer`);
  }
}

function validateNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw representationInvalid(`${label} must be a non-negative safe integer`);
  }
}

function requireObject(value: unknown, message: string): JsonObject {
  const object = asObject(value);
  if (!object) throw representationInvalid(message);
  return object;
}

function asObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function representationInvalid(message: string): WhiteboardError {
  return new WhiteboardError("whiteboard.semantic-representation-invalid", message, 400);
}
