import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../sqlite/db.js";

/**
 * Content-addressed object store: bytes live on the filesystem under
 * their SHA-256; SQLite keeps only metadata. An object at a known hash
 * is never overwritten.
 */

export function objectPath(objectsDir: string, hash: string): string {
  return join(objectsDir, "sha256", hash.slice(0, 2), hash.slice(2, 4), hash);
}

export function putObject(
  objectsDir: string,
  db: Db,
  bytes: Buffer,
  mediaType: string,
  recordedAt: string,
): string {
  return putObjectTracked(objectsDir, db, bytes, mediaType, recordedAt).hash;
}

export type PutObjectResult = Readonly<{ hash: string; createdFile: boolean }>;

/**
 * The tracked form lets a transaction owner compensate a newly-created physical file when its
 * SQLite transaction aborts. Callers must only remove files reported as created by their own call.
 */
export function putObjectTracked(
  objectsDir: string,
  db: Db,
  bytes: Buffer,
  mediaType: string,
  recordedAt: string,
): PutObjectResult {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const destination = objectPath(objectsDir, hash);
  let createdFile = false;
  if (!existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    const tmp = `${destination}.${process.pid}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, destination);
    createdFile = true;
  }
  db.prepare(
    "INSERT OR IGNORE INTO blobs (hash, byte_length, media_type, created_at) VALUES (?, ?, ?, ?)",
  ).run(hash, bytes.length, mediaType, recordedAt);
  return { hash, createdFile };
}

/** Remove one caller-created file only when no committed blob row owns it. */
export function removeObjectFileIfUntracked(objectsDir: string, db: Db, hash: string): boolean {
  const tracked = db.prepare("SELECT 1 AS present FROM blobs WHERE hash = ?").get(hash);
  if (tracked !== undefined) return false;
  const path = objectPath(objectsDir, hash);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

export function readObject(objectsDir: string, hash: string): Buffer {
  const path = objectPath(objectsDir, hash);
  if (!existsSync(path)) {
    throw new Error(`object store integrity failure: missing object ${hash}`);
  }
  return readFileSync(path);
}
