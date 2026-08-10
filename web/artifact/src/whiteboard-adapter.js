const NATIVE_TOP_LEVEL_KEYS = new Set([
  "type",
  "version",
  "source",
  "elements",
  "appState",
  "files",
]);

const EXCALIDRAW_ELEMENT_TYPES = new Set([
  "arrow",
  "diamond",
  "ellipse",
  "embeddable",
  "frame",
  "freedraw",
  "iframe",
  "image",
  "line",
  "magicframe",
  "rectangle",
  "text",
]);

const STROKE_COLORS = Object.freeze({
  black: "#1e1e1e",
  blue: "#1971c2",
  green: "#2f9e44",
  grey: "#868e96",
  gray: "#868e96",
  orange: "#e8590c",
  red: "#c92a2a",
  violet: "#7048e8",
  yellow: "#f08c00",
});

const FILL_COLORS = Object.freeze({
  black: "#ced4da",
  blue: "#a5d8ff",
  green: "#b2f2bb",
  grey: "#e9ecef",
  gray: "#e9ecef",
  orange: "#ffd8a8",
  red: "#ffc9c9",
  violet: "#d0bfff",
  yellow: "#ffec99",
});

export const NATIVE_MIME = "application/vnd.excalidraw+json";
export const LEGACY_MIME = "application/vnd.tldraw+json";
export const SCENE_SOURCE = "https://tweakloop.local";

export class WhiteboardDataError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "WhiteboardDataError";
    this.details = details;
  }
}

export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function deterministicId(value, prefix = "tl") {
  const input = typeof value === "string" ? value : stableStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(36)}`;
}

function requireObject(value, message, details = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WhiteboardDataError(message, details);
  }
  return value;
}

function finite(value, field, details) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new WhiteboardDataError(`Whiteboard ${field} must be a finite number`, details);
  }
  return value;
}

function positive(value, field, details) {
  const number = finite(value, field, details);
  if (number <= 0) {
    throw new WhiteboardDataError(`Whiteboard ${field} must be greater than zero`, details);
  }
  return number;
}

function colorFor(value, palette, fallback) {
  if (typeof value !== "string") return fallback;
  if (/^#[0-9a-f]{3,8}$/i.test(value)) return value;
  return palette[value.toLowerCase()] || fallback;
}

function anchorData(anchorId, previous = {}) {
  const priorTweakloop =
    previous.tweakloop && typeof previous.tweakloop === "object" ? previous.tweakloop : {};
  return {
    ...previous,
    tweakloop: {
      ...priorTweakloop,
      schema: 1,
      anchorId,
    },
  };
}

function legacyShapeId(shape, boardId, index) {
  if (typeof shape.id === "string" && shape.id.trim()) return shape.id;
  return deterministicId({ boardId, index, shape }, "legacy");
}

function legacyLabel(id, text, strokeColor, props) {
  if (typeof text !== "string" || !text.trim()) return undefined;
  const labelId = `${id}_label`;
  return {
    id: labelId,
    text,
    fontSize: props.size === "s" ? 16 : props.size === "l" ? 24 : 20,
    textAlign: props.align === "start" ? "left" : props.align === "end" ? "right" : "center",
    verticalAlign:
      props.verticalAlign === "start" ? "top" : props.verticalAlign === "end" ? "bottom" : "middle",
    strokeColor,
    customData: anchorData(labelId),
  };
}

function convertLegacyGeo(shape, boardId, index) {
  const details = { index, type: shape.type };
  const props = requireObject(shape.props, `Legacy shape ${index} is missing props`, details);
  const geo = props.geo || "rectangle";
  if (!new Set(["rectangle", "ellipse", "diamond"]).has(geo)) {
    throw new WhiteboardDataError(`Unsupported legacy geo shape "${String(geo)}"`, details);
  }
  const id = legacyShapeId(shape, boardId, index);
  const strokeColor = colorFor(props.color, STROKE_COLORS, STROKE_COLORS.black);
  const filled = props.fill && props.fill !== "none";
  return {
    id,
    type: geo,
    x: finite(shape.x ?? 0, "x", details),
    y: finite(shape.y ?? 0, "y", details),
    width: positive(props.w, "width", details),
    height: positive(props.h, "height", details),
    strokeColor,
    backgroundColor: filled ? colorFor(props.color, FILL_COLORS, FILL_COLORS.grey) : "transparent",
    fillStyle: "solid",
    customData: anchorData(id),
    label: legacyLabel(id, props.text, strokeColor, props),
  };
}

function convertLegacyArrow(shape, boardId, index) {
  const details = { index, type: shape.type };
  const props = requireObject(shape.props, `Legacy arrow ${index} is missing props`, details);
  const start = requireObject(
    props.start,
    `Legacy arrow ${index} is missing its start point`,
    details,
  );
  const end = requireObject(props.end, `Legacy arrow ${index} is missing its end point`, details);
  if (
    start.type === "binding" ||
    end.type === "binding" ||
    start.boundShapeId ||
    end.boundShapeId
  ) {
    throw new WhiteboardDataError(
      `Legacy arrow ${index} uses a binding schema that the one-way importer does not support`,
      details,
    );
  }
  const baseX = finite(shape.x ?? 0, "x", details);
  const baseY = finite(shape.y ?? 0, "y", details);
  const startX = baseX + finite(start.x, "arrow start.x", details);
  const startY = baseY + finite(start.y, "arrow start.y", details);
  const endX = baseX + finite(end.x, "arrow end.x", details);
  const endY = baseY + finite(end.y, "arrow end.y", details);
  const id = legacyShapeId(shape, boardId, index);
  const strokeColor = colorFor(props.color, STROKE_COLORS, STROKE_COLORS.black);
  return {
    id,
    type: "arrow",
    x: startX,
    y: startY,
    points: [
      [0, 0],
      [endX - startX, endY - startY],
    ],
    strokeColor,
    startArrowhead: null,
    endArrowhead: "arrow",
    customData: anchorData(id),
    label: legacyLabel(id, props.text, strokeColor, props),
  };
}

function convertLegacyText(shape, boardId, index) {
  const details = { index, type: shape.type };
  const props = requireObject(shape.props, `Legacy text ${index} is missing props`, details);
  if (typeof props.text !== "string") {
    throw new WhiteboardDataError(`Legacy text ${index} is missing text`, details);
  }
  const id = legacyShapeId(shape, boardId, index);
  return {
    id,
    type: "text",
    text: props.text,
    x: finite(shape.x ?? 0, "x", details),
    y: finite(shape.y ?? 0, "y", details),
    fontSize: props.size === "s" ? 16 : props.size === "l" ? 24 : 20,
    strokeColor: colorFor(props.color, STROKE_COLORS, STROKE_COLORS.black),
    textAlign:
      props.align === "middle" || props.align === "center"
        ? "center"
        : props.align === "end"
          ? "right"
          : "left",
    customData: anchorData(id),
  };
}

export function legacyToSkeleton(data, { boardId = "whiteboard" } = {}) {
  const root = requireObject(data, "Legacy whiteboard data must be an object");
  if (!Array.isArray(root.shapes)) {
    throw new WhiteboardDataError(
      "Unsupported legacy whiteboard snapshot. Only the simple shapes payload can be imported safely.",
    );
  }
  const seenIds = new Set();
  const skeleton = root.shapes.map((rawShape, index) => {
    const shape = requireObject(rawShape, `Legacy shape ${index} must be an object`, { index });
    let converted;
    if (shape.type === "geo") converted = convertLegacyGeo(shape, boardId, index);
    else if (shape.type === "arrow") converted = convertLegacyArrow(shape, boardId, index);
    else if (shape.type === "text") converted = convertLegacyText(shape, boardId, index);
    else {
      throw new WhiteboardDataError(
        `Unsupported legacy shape type "${String(shape.type)}" at index ${index}`,
        { index, type: shape.type },
      );
    }
    if (seenIds.has(converted.id)) {
      throw new WhiteboardDataError(`Duplicate legacy shape id "${converted.id}"`, {
        index,
        id: converted.id,
      });
    }
    seenIds.add(converted.id);
    return converted;
  });
  return skeleton;
}

export function normalizeElementAnchors(elements) {
  if (!Array.isArray(elements)) return { elements: [], changed: false };
  const usedAnchors = new Set();
  let changed = false;
  const normalized = elements.map((element) => {
    if (!element || typeof element !== "object" || typeof element.id !== "string") return element;
    const current = element.customData?.tweakloop?.anchorId;
    const anchorId =
      typeof current === "string" && current && !usedAnchors.has(current) ? current : element.id;
    usedAnchors.add(anchorId);
    if (current === anchorId && element.customData?.tweakloop?.schema === 1) return element;
    changed = true;
    return {
      ...element,
      customData: anchorData(anchorId, element.customData),
    };
  });
  return { elements: normalized, changed };
}

export function validateNativeScene(data) {
  const scene = requireObject(data, "Excalidraw scene must be a JSON object");
  const unknownKeys = Object.keys(scene).filter((key) => !NATIVE_TOP_LEVEL_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new WhiteboardDataError(
      `Unsupported Excalidraw scene field${unknownKeys.length === 1 ? "" : "s"}: ${unknownKeys.join(", ")}`,
      { unknownKeys },
    );
  }
  if (scene.type !== "excalidraw") {
    throw new WhiteboardDataError('Excalidraw scene "type" must be "excalidraw"');
  }
  if (!Number.isInteger(scene.version) || scene.version < 1) {
    throw new WhiteboardDataError("Excalidraw scene version must be a positive integer");
  }
  if (typeof scene.source !== "string" || !scene.source) {
    throw new WhiteboardDataError("Excalidraw scene source must be a non-empty string");
  }
  if (!Array.isArray(scene.elements)) {
    throw new WhiteboardDataError("Excalidraw scene elements must be an array");
  }
  requireObject(scene.appState, "Excalidraw scene appState must be an object");
  requireObject(scene.files, "Excalidraw scene files must be an object");
  const ids = new Set();
  for (const [index, element] of scene.elements.entries()) {
    requireObject(element, `Excalidraw element ${index} must be an object`, { index });
    if (typeof element.id !== "string" || !element.id) {
      throw new WhiteboardDataError(`Excalidraw element ${index} is missing a stable id`, {
        index,
      });
    }
    if (ids.has(element.id)) {
      throw new WhiteboardDataError(`Duplicate Excalidraw element id "${element.id}"`, {
        index,
        id: element.id,
      });
    }
    ids.add(element.id);
    if (!EXCALIDRAW_ELEMENT_TYPES.has(element.type)) {
      throw new WhiteboardDataError(
        `Unsupported Excalidraw element type "${String(element.type)}" at index ${index}`,
        { index, type: element.type },
      );
    }
  }
  return scene;
}

export function convertLegacyScene(data, { boardId = "whiteboard", convert }) {
  if (typeof convert !== "function") {
    throw new WhiteboardDataError("Excalidraw conversion API is unavailable");
  }
  const skeleton = legacyToSkeleton(data, { boardId });
  const converted = convert(skeleton, { regenerateIds: false });
  if (!Array.isArray(converted)) {
    throw new WhiteboardDataError("Excalidraw converter returned an invalid element set");
  }
  const expectedPrimaryIds = new Set(skeleton.map((element) => element.id));
  const convertedIds = new Set(converted.map((element) => element?.id));
  const missingIds = Array.from(expectedPrimaryIds).filter((id) => !convertedIds.has(id));
  if (missingIds.length > 0) {
    throw new WhiteboardDataError(
      `Legacy conversion lost ${missingIds.length} shape${missingIds.length === 1 ? "" : "s"}: ${missingIds.join(", ")}`,
      { missingIds },
    );
  }
  const normalized = normalizeElementAnchors(converted).elements;
  return {
    type: "excalidraw",
    version: 2,
    source: SCENE_SOURCE,
    elements: normalized,
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function elementLabel(element, elementsById) {
  if (element.type === "text" && typeof element.text === "string" && element.text.trim()) {
    return element.text.trim().replace(/\s+/g, " ").slice(0, 100);
  }
  for (const bound of element.boundElements || []) {
    if (bound.type !== "text") continue;
    const label = elementsById.get(bound.id);
    if (label?.text?.trim()) return label.text.trim().replace(/\s+/g, " ").slice(0, 100);
  }
  return `${element.type} · ${element.id}`;
}

export function sceneElementNodes(boardId, elements, context = {}) {
  const active = (Array.isArray(elements) ? elements : []).filter(
    (element) => element && !element.isDeleted && typeof element.id === "string",
  );
  const elementsById = new Map(active.map((element) => [element.id, element]));
  return active.map((element) => {
    const anchorId = element.customData?.tweakloop?.anchorId || element.id;
    const label = elementLabel(element, elementsById);
    if (
      typeof element.type !== "string" ||
      !Number.isInteger(element.version) ||
      !Number.isInteger(element.versionNonce)
    ) {
      throw new WhiteboardDataError(
        `Excalidraw element "${element.id}" is missing durable selection metadata`,
        { elementId: element.id },
      );
    }
    const boardAnchor = {
      semanticId: boardId,
      whiteboardArtifactId: context.whiteboardArtifactId || context.artifactId,
      baseRevisionId: context.baseRevisionId || context.revisionId,
      elementAnchor: {
        anchorId,
        elementId: element.id,
        type: element.type,
        version: element.version,
        versionNonce: element.versionNonce,
        label,
      },
    };
    if (typeof context.sceneHash === "string" && context.sceneHash) {
      boardAnchor.sceneHash = context.sceneHash;
    }
    if (typeof context.draftId === "string" && context.draftId) {
      boardAnchor.draftId = context.draftId;
    }
    if (Number.isInteger(context.draftVersion)) {
      boardAnchor.draftVersion = context.draftVersion;
    }
    return {
      semanticId: `${boardId}#${anchorId}`,
      kind: "whiteboard-element",
      source: null,
      label,
      boardAnchor,
    };
  });
}

export function elementsFingerprint(elements) {
  return deterministicId(
    (Array.isArray(elements) ? elements : []).map((element) => ({
      id: element?.id,
      version: element?.version,
      versionNonce: element?.versionNonce,
      isDeleted: element?.isDeleted,
      x: element?.x,
      y: element?.y,
      width: element?.width,
      height: element?.height,
      angle: element?.angle,
      points: element?.points,
      text: element?.text,
      customData: element?.customData,
      startBinding: element?.startBinding,
      endBinding: element?.endBinding,
      boundElements: element?.boundElements,
    })),
    "scene",
  );
}
