import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { Db } from "../sqlite/db.js";
import { objectPath } from "./index.js";

export type AtomicObjectInput = Readonly<{ bytes: Buffer; mediaType: string }>;

type JournalObject = Readonly<{
  hash: string;
  byteLength: number;
  mediaType: string;
  preexisting: boolean;
}>;

type Journal = Readonly<{
  version: 1;
  workspaceId: string;
  idempotencyKey: string;
  objects: readonly JournalObject[];
}>;

export type AtomicObjectBatch = Readonly<{
  objects: readonly JournalObject[];
  install: (recordedAt: string) => void;
  commit: () => void;
  rollback: () => void;
  /** Test/crash harness only: leave the journal and installed files untouched. */
  abandon: () => void;
}>;

export type AtomicObjectBatchOptions = Readonly<{
  failureInjection?: (point: "after-stage" | "after-cas-install") => void;
}>;

/** Stage command-owned bytes outside the addressable CAS namespace. */
export function stageAtomicObjectBatch(
  objectsDir: string,
  db: Db,
  workspaceId: string,
  idempotencyKey: string,
  inputs: readonly AtomicObjectInput[],
  options: AtomicObjectBatchOptions = {},
): AtomicObjectBatch {
  const uniqueInputs = deduplicate(inputs);
  const root = stagingRoot(objectsDir);
  mkdirSync(root, { recursive: true });
  const batchDir = join(root, `${safeKey(idempotencyKey)}-${randomUUID()}`);
  mkdirSync(batchDir, { recursive: false });
  const objects = uniqueInputs.map((input): JournalObject => {
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    writeFileSync(join(batchDir, hash), input.bytes, { flag: "wx" });
    return {
      hash,
      byteLength: input.bytes.length,
      mediaType: input.mediaType,
      preexisting: existsSync(objectPath(objectsDir, hash)),
    };
  });
  const journal: Journal = { version: 1, workspaceId, idempotencyKey, objects };
  writeFileSync(join(batchDir, "journal.json"), JSON.stringify(journal), { flag: "wx" });
  try {
    options.failureInjection?.("after-stage");
  } catch (error) {
    rmSync(batchDir, { recursive: true, force: true });
    throw error;
  }
  let finished = false;

  const cleanupDirectory = () => rmSync(batchDir, { recursive: true, force: true });
  const rollback = () => {
    if (finished) return;
    for (const object of objects) {
      if (object.preexisting) continue;
      db.prepare("DELETE FROM blobs WHERE hash = ?").run(object.hash);
      const destination = objectPath(objectsDir, object.hash);
      if (existsSync(destination)) unlinkSync(destination);
    }
    cleanupDirectory();
    finished = true;
  };

  return {
    objects,
    install: (recordedAt) => {
      if (finished) throw new Error("atomic object batch is already closed");
      for (const object of objects) {
        const staged = join(batchDir, object.hash);
        const destination = objectPath(objectsDir, object.hash);
        if (!existsSync(destination)) {
          mkdirSync(dirname(destination), { recursive: true });
          renameSync(staged, destination);
        }
        db.prepare(
          `INSERT OR IGNORE INTO blobs (hash, byte_length, media_type, created_at)
           VALUES (?, ?, ?, ?)`,
        ).run(object.hash, object.byteLength, object.mediaType, recordedAt);
      }
      options.failureInjection?.("after-cas-install");
    },
    commit: () => {
      if (finished) return;
      cleanupDirectory();
      finished = true;
    },
    rollback,
    abandon: () => {
      finished = true;
    },
  };
}

/** Repair command-owned crash residue before any HTTP listener can serve. */
export function repairAtomicObjectBatches(objectsDir: string, db: Db): number {
  const root = stagingRoot(objectsDir);
  if (!existsSync(root)) return 0;
  let repaired = 0;
  for (const name of readdirSync(root)) {
    const batchDir = join(root, name);
    const journalPath = join(batchDir, "journal.json");
    if (!existsSync(journalPath)) {
      rmSync(batchDir, { recursive: true, force: true });
      repaired += 1;
      continue;
    }
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    if (journal.version !== 1 || !Array.isArray(journal.objects)) {
      throw new Error(`invalid atomic object journal: ${journalPath}`);
    }
    const committed =
      db
        .prepare(
          `SELECT 1 FROM command_receipts
           WHERE workspace_id = ? AND idempotency_key = ?`,
        )
        .get(journal.workspaceId, journal.idempotencyKey) !== undefined;
    if (!committed) {
      for (const object of journal.objects) {
        if (object.preexisting) continue;
        db.prepare("DELETE FROM blobs WHERE hash = ?").run(object.hash);
        const destination = objectPath(objectsDir, object.hash);
        if (existsSync(destination)) unlinkSync(destination);
      }
    }
    rmSync(batchDir, { recursive: true, force: true });
    repaired += 1;
  }
  return repaired;
}

function stagingRoot(objectsDir: string): string {
  return join(dirname(objectsDir), "object-staging");
}

function safeKey(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function deduplicate(inputs: readonly AtomicObjectInput[]): readonly AtomicObjectInput[] {
  const values = new Map<string, AtomicObjectInput>();
  for (const input of inputs) {
    const hash = createHash("sha256").update(input.bytes).digest("hex");
    const existing = values.get(hash);
    if (existing && existing.mediaType !== input.mediaType) {
      throw new Error(`object ${hash} was staged with conflicting media types`);
    }
    values.set(hash, input);
  }
  return [...values.values()];
}
