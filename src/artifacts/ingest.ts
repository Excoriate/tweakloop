import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { RevisionFile } from "../domain/events.js";
import { putObject } from "../storage/object-store/index.js";
import type { Db } from "../storage/sqlite/db.js";
import {
  canonicalizeWhiteboardScene,
  WHITEBOARD_INDEX_MEDIA_TYPE,
  WHITEBOARD_SCENE_MEDIA_TYPE,
} from "../whiteboard/scene.js";

export type ArtifactFormat = "html" | "markdown" | "whiteboard";

export type IngestedRevision = Readonly<{
  format: ArtifactFormat;
  entryPath: string;
  entryHash: string;
  files: readonly RevisionFile[];
}>;

export type PreparedObject = Readonly<{
  hash: string;
  bytes: Buffer;
  mediaType: string;
}>;

export type PreparedIngest = Readonly<{
  revision: IngestedRevision;
  objects: readonly PreparedObject[];
}>;

export const SESSION_ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd"]);
const WHITEBOARD_EXTENSIONS = new Set([".excalidraw"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);

export function formatForPath(sourcePath: string): ArtifactFormat {
  const extension = extname(sourcePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (WHITEBOARD_EXTENSIONS.has(extension)) return "whiteboard";
  return "html";
}

/**
 * Validate and canonicalize browser-provided bytes without granting a host
 * path. The returned objects are immutable values; callers decide when to
 * stage them and when to submit the semantic command.
 */
export function ingestBytes(
  displayName: string,
  bytes: Buffer,
  maxBytes = SESSION_ARTIFACT_MAX_BYTES,
): PreparedIngest {
  if (bytes.byteLength > maxBytes) {
    throw new IngestBytesError("artifact.too-large", `artifact exceeds the ${maxBytes} byte limit`);
  }
  const entryPath = sanitizeDisplayName(displayName);
  const extension = extname(entryPath).toLowerCase();
  if (
    !HTML_EXTENSIONS.has(extension) &&
    !MARKDOWN_EXTENSIONS.has(extension) &&
    !WHITEBOARD_EXTENSIONS.has(extension)
  ) {
    throw new IngestBytesError(
      "artifact.unsupported-format",
      "supported files are HTML, Markdown, and Excalidraw",
    );
  }

  const format: ArtifactFormat = WHITEBOARD_EXTENSIONS.has(extension)
    ? "whiteboard"
    : MARKDOWN_EXTENSIONS.has(extension)
      ? "markdown"
      : "html";
  if (format !== "whiteboard") validateTextBytes(bytes, format);

  if (format === "whiteboard") {
    let canonical: ReturnType<typeof canonicalizeWhiteboardScene>;
    try {
      canonical = canonicalizeWhiteboardScene(bytes);
    } catch (error) {
      throw new IngestBytesError(
        "artifact.malformed",
        error instanceof Error ? error.message : "invalid Excalidraw document",
      );
    }
    const scene = preparedObject(canonical.bytes, WHITEBOARD_SCENE_MEDIA_TYPE);
    const elementIndex = preparedObject(canonical.elementIndexBytes, WHITEBOARD_INDEX_MEDIA_TYPE);
    return {
      revision: {
        format,
        entryPath,
        entryHash: scene.hash,
        files: [
          { path: entryPath, hash: scene.hash, mediaType: scene.mediaType },
          {
            path: ".tweakloop/elements.json",
            hash: elementIndex.hash,
            mediaType: elementIndex.mediaType,
          },
        ],
      },
      objects: [scene, elementIndex],
    };
  }

  const entry = preparedObject(bytes, format === "markdown" ? "text/markdown" : "text/html");
  return {
    revision: {
      format,
      entryPath,
      entryHash: entry.hash,
      files: [{ path: entryPath, hash: entry.hash, mediaType: entry.mediaType }],
    },
    objects: [entry],
  };
}

export class IngestBytesError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IngestBytesError";
  }
}

export function sanitizeDisplayName(value: string): string {
  const name = basename(value.replaceAll("\\", "/"))
    .normalize("NFC")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32 && character !== "\u007f")
    .join("")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/^\.+$/, "")
    .trim();
  if (name === "") throw new IngestBytesError("artifact.filename-invalid", "filename is empty");
  if (Buffer.byteLength(name, "utf8") > 255) {
    throw new IngestBytesError("artifact.filename-invalid", "filename is too long");
  }
  return name;
}

function preparedObject(bytes: Buffer, mediaType: string): PreparedObject {
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    bytes,
    mediaType,
  };
}

function validateTextBytes(bytes: Buffer, format: "html" | "markdown"): void {
  if (bytes.byteLength === 0) {
    throw new IngestBytesError("artifact.malformed", `${format} document is empty`);
  }
  const text = bytes.toString("utf8");
  if (text.includes("\ufffd") || !Buffer.from(text, "utf8").equals(bytes)) {
    throw new IngestBytesError("artifact.malformed", `${format} document is not valid UTF-8`);
  }
  if (format === "html" && !/(?:<!doctype\s+html|<html[\s>])/i.test(text)) {
    throw new IngestBytesError(
      "artifact.malformed",
      "HTML document requires a doctype or html root element",
    );
  }
}

/**
 * Snapshot a source file into the object store. Phase 1 ingests the
 * entry document only; sibling asset discovery arrives with the HTML
 * adapter work (docs/architecture/06-artifacts.md).
 */
export function ingestFile(
  deps: { db: Db; objectsDir: string; now: () => string },
  sourcePath: string,
): IngestedRevision {
  const bytes = readFileSync(sourcePath);
  const format = formatForPath(sourcePath);
  const entryPath = basename(sourcePath);
  if (format === "whiteboard") {
    const canonical = canonicalizeWhiteboardScene(bytes);
    const entryHash = putObject(
      deps.objectsDir,
      deps.db,
      canonical.bytes,
      WHITEBOARD_SCENE_MEDIA_TYPE,
      deps.now(),
    );
    const elementIndexHash = putObject(
      deps.objectsDir,
      deps.db,
      canonical.elementIndexBytes,
      WHITEBOARD_INDEX_MEDIA_TYPE,
      deps.now(),
    );
    return {
      format,
      entryPath,
      entryHash,
      files: [
        { path: entryPath, hash: entryHash, mediaType: WHITEBOARD_SCENE_MEDIA_TYPE },
        {
          path: ".tweakloop/elements.json",
          hash: elementIndexHash,
          mediaType: WHITEBOARD_INDEX_MEDIA_TYPE,
        },
      ],
    };
  }
  const mediaType = format === "markdown" ? "text/markdown" : "text/html";
  const hash = putObject(deps.objectsDir, deps.db, bytes, mediaType, deps.now());
  return {
    format,
    entryPath,
    entryHash: hash,
    files: [{ path: entryPath, hash, mediaType }],
  };
}
