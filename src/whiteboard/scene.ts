import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";
import { durableWhiteboardAppState } from "./app-state.js";
import { WhiteboardError } from "./errors.js";
import {
  semanticElementIndexFields,
  validateSemanticSceneRepresentation,
} from "./semantic-representation.js";

export const WHITEBOARD_DRAFT_PROTOCOL = "tweakloop.whiteboard-draft/v1" as const;
export const WHITEBOARD_INDEX_PROTOCOL = "tweakloop.whiteboard-index/v1" as const;
export const WHITEBOARD_SCENE_MEDIA_TYPE = "application/vnd.excalidraw+json";
export const WHITEBOARD_INDEX_MEDIA_TYPE = "application/vnd.tweakloop.whiteboard-index+json";
export const WHITEBOARD_SCENE_MAX_BYTES = 8 * 1024 * 1024;
export const WHITEBOARD_MAX_ELEMENTS = 10_000;
export const WHITEBOARD_MAX_FILES = 100;
export const WHITEBOARD_MAX_ELEMENT_ID_LENGTH = 128;
export const WHITEBOARD_MAX_NESTING_DEPTH = 64;

type JsonObject = Record<string, unknown>;

export type WhiteboardElementIndex = Readonly<{
  protocol: typeof WHITEBOARD_INDEX_PROTOCOL;
  sceneHash: string;
  elements: readonly Readonly<{
    elementId: string;
    elementVersion: number;
    elementVersionNonce: number;
    elementType: string;
    isDeleted: boolean;
    label: string | null;
    semanticKey?: string;
    anchorId?: string;
    semanticRole?: "primary" | "label";
    semanticRetired?: boolean;
  }>[];
}>;

export type CanonicalWhiteboardScene = Readonly<{
  scene: Readonly<JsonObject>;
  bytes: Buffer;
  hash: string;
  elementIndex: WhiteboardElementIndex;
  elementIndexBytes: Buffer;
  elementIndexHash: string;
}>;

export function canonicalizeWhiteboardScene(input: Buffer | string): CanonicalWhiteboardScene {
  const byteLength = typeof input === "string" ? Buffer.byteLength(input) : input.byteLength;
  if (byteLength > WHITEBOARD_SCENE_MAX_BYTES) {
    throw new WhiteboardError(
      "whiteboard.scene-too-large",
      `whiteboard scene exceeds ${WHITEBOARD_SCENE_MAX_BYTES} bytes`,
      413,
      { byteLength, maxBytes: WHITEBOARD_SCENE_MAX_BYTES },
    );
  }
  let raw: string;
  try {
    raw =
      typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  } catch {
    throw invalid("whiteboard scene must be valid UTF-8");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WhiteboardError(
      "whiteboard.scene-invalid",
      "whiteboard scene must be valid JSON",
      400,
    );
  }
  validateJsonValue(parsed, 0);
  const scene = validateScene(parsed);
  const canonical = canonicalValue(scene) as JsonObject;
  const bytes = Buffer.from(JSON.stringify(canonical));
  if (bytes.length > WHITEBOARD_SCENE_MAX_BYTES) {
    throw new WhiteboardError(
      "whiteboard.scene-too-large",
      `canonical whiteboard scene exceeds ${WHITEBOARD_SCENE_MAX_BYTES} bytes`,
      413,
      { byteLength: bytes.length, maxBytes: WHITEBOARD_SCENE_MAX_BYTES },
    );
  }
  const hash = sha256(bytes);
  const elementIndex = buildElementIndex(canonical, hash);
  const elementIndexBytes = Buffer.from(JSON.stringify(canonicalValue(elementIndex)));
  return {
    scene: canonical,
    bytes,
    hash,
    elementIndex,
    elementIndexBytes,
    elementIndexHash: sha256(elementIndexBytes),
  };
}

export function stableJsonHash(value: unknown): string {
  return sha256(Buffer.from(JSON.stringify(canonicalValue(value))));
}

function validateScene(value: unknown): JsonObject {
  const scene = requireObject(value, "whiteboard scene must be an object");
  if (scene.type !== "excalidraw") {
    throw invalid('whiteboard scene `type` must be "excalidraw"');
  }
  if (!Number.isSafeInteger(scene.version) || Number(scene.version) < 1) {
    throw invalid("whiteboard scene `version` must be a positive integer");
  }
  if (!Array.isArray(scene.elements)) {
    throw invalid("whiteboard scene `elements` must be an array");
  }
  if (scene.elements.length > WHITEBOARD_MAX_ELEMENTS) {
    throw new WhiteboardError(
      "whiteboard.scene-too-large",
      `whiteboard scene has more than ${WHITEBOARD_MAX_ELEMENTS} elements`,
      413,
    );
  }
  const files =
    scene.files === undefined ? {} : requireObject(scene.files, "`files` must be an object");
  if (Object.keys(files).length > WHITEBOARD_MAX_FILES) {
    throw new WhiteboardError(
      "whiteboard.scene-too-large",
      `whiteboard scene has more than ${WHITEBOARD_MAX_FILES} embedded files`,
      413,
    );
  }
  for (const [fileId, file] of Object.entries(files)) {
    if (fileId.length < 1 || fileId.length > WHITEBOARD_MAX_ELEMENT_ID_LENGTH) {
      throw invalid("whiteboard scene contains an invalid embedded file id");
    }
    requireObject(file, `embedded file ${fileId} must be an object`);
  }

  const elementIds = new Set<string>();
  const elements = scene.elements.map((candidate, index) => {
    const element = requireObject(candidate, `element ${index} must be an object`);
    const id = element.id;
    if (
      typeof id !== "string" ||
      id.length < 1 ||
      id.length > WHITEBOARD_MAX_ELEMENT_ID_LENGTH ||
      !/^[!-~]+$/.test(id)
    ) {
      throw invalid(`element ${index} has an invalid id`);
    }
    if (typeof element.type !== "string" || element.type.length === 0) {
      throw invalid(`element ${id} has an invalid type`);
    }
    if (!Number.isSafeInteger(element.version) || Number(element.version) < 1) {
      throw invalid(`element ${id} has an invalid version`);
    }
    if (!Number.isSafeInteger(element.versionNonce) || Number(element.versionNonce) < 0) {
      throw invalid(`element ${id} has an invalid versionNonce`);
    }
    if (element.isDeleted !== undefined && typeof element.isDeleted !== "boolean") {
      throw invalid(`element ${id} has an invalid isDeleted flag`);
    }
    if (elementIds.has(id)) throw invalid(`duplicate element id: ${id}`);
    elementIds.add(id);
    return element;
  });

  const appState =
    scene.appState === undefined
      ? {}
      : requireObject(scene.appState, "whiteboard scene `appState` must be an object");
  const durableAppState = durableWhiteboardAppState(appState);

  const validated = {
    ...scene,
    elements,
    appState: durableAppState,
    files,
  };
  validateSemanticSceneRepresentation(validated);
  return validated;
}

function buildElementIndex(scene: JsonObject, sceneHash: string): WhiteboardElementIndex {
  const elements = scene.elements as JsonObject[];
  return {
    protocol: WHITEBOARD_INDEX_PROTOCOL,
    sceneHash,
    elements: elements.map((element) => {
      const semantic = semanticElementIndexFields(element);
      return {
        elementId: element.id as string,
        elementVersion: element.version as number,
        elementVersionNonce: element.versionNonce as number,
        elementType: element.type as string,
        isDeleted: element.isDeleted === true,
        label: labelFor(element),
        ...(semantic ?? {}),
      };
    }),
  };
}

function labelFor(element: JsonObject): string | null {
  if (element.type !== "text") return null;
  const text =
    typeof element.text === "string"
      ? element.text
      : typeof element.originalText === "string"
        ? element.originalText
        : null;
  if (text === null) return null;
  return text.replace(/\s+/g, " ").trim().slice(0, 160) || null;
}

function requireObject(value: unknown, message: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value as JsonObject;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    const result = Object.create(null) as JsonObject;
    for (const key of Object.keys(value as JsonObject).sort()) {
      const entry = (value as JsonObject)[key];
      if (entry !== undefined) result[key] = canonicalValue(entry);
    }
    return result;
  }
  return value;
}

function validateJsonValue(value: unknown, depth: number): void {
  if (depth > WHITEBOARD_MAX_NESTING_DEPTH) {
    throw invalid(`whiteboard scene exceeds ${WHITEBOARD_MAX_NESTING_DEPTH} levels of nesting`);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw invalid("whiteboard scene contains a non-finite number");
  }
  if (Array.isArray(value)) {
    for (const entry of value) validateJsonValue(entry, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as JsonObject)) validateJsonValue(entry, depth + 1);
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalid(message: string): WhiteboardError {
  return new WhiteboardError("whiteboard.scene-invalid", message, 400);
}
