import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTransactor } from "../../src/daemon/transactor.js";
import {
  repairAtomicObjectBatches,
  stageAtomicObjectBatch,
} from "../../src/storage/object-store/atomic-batch.js";
import { objectPath, putObject } from "../../src/storage/object-store/index.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "tweakloop-atomic-objects-"));
  roots.push(root);
  const objectsDir = join(root, "objects");
  const db = openDatabase(join(root, "events.sqlite"));
  return { root, objectsDir, db };
}

function inventory(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  walk(root, "");
  return files.sort();
}

describe("atomic object batches", () => {
  it("cleans stage and CAS-install injection failures", () => {
    const { root, objectsDir, db } = setup();
    expect(() =>
      stageAtomicObjectBatch(
        objectsDir,
        db,
        "ws",
        "stage_failure",
        [{ bytes: Buffer.from("stage"), mediaType: "text/plain" }],
        {
          failureInjection: (point) => {
            if (point === "after-stage") throw new Error("injected stage failure");
          },
        },
      ),
    ).toThrow("injected stage failure");
    expect(inventory(join(root, "object-staging"))).toEqual([]);
    expect(inventory(objectsDir)).toEqual([]);

    const batch = stageAtomicObjectBatch(
      objectsDir,
      db,
      "ws",
      "install_failure",
      [{ bytes: Buffer.from("install"), mediaType: "text/plain" }],
      {
        failureInjection: (point) => {
          if (point === "after-cas-install") throw new Error("injected CAS install failure");
        },
      },
    );
    expect(() => batch.install("2026-08-08T00:00:00Z")).toThrow("injected CAS install failure");
    batch.rollback();
    expect(inventory(join(root, "object-staging"))).toEqual([]);
    expect(inventory(objectsDir)).toEqual([]);
    db.close();
  });

  it("normal rollback restores the exact physical CAS inventory", () => {
    const { objectsDir, db } = setup();
    const existing = Buffer.from("already durable");
    putObject(objectsDir, db, existing, "text/plain", "2026-08-08T00:00:00Z");
    const before = inventory(objectsDir);
    const batch = stageAtomicObjectBatch(objectsDir, db, "ws", "rejected", [
      { bytes: existing, mediaType: "text/plain" },
      { bytes: Buffer.from("must roll back"), mediaType: "text/plain" },
    ]);
    batch.install("2026-08-08T00:00:01Z");
    expect(inventory(objectsDir)).toHaveLength(before.length + 1);
    batch.rollback();
    expect(inventory(objectsDir)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM blobs").get()).toEqual({ count: 1 });
    db.close();
  });

  it("startup repair removes uncommitted crash residue", () => {
    const { root, objectsDir, db } = setup();
    const bytes = Buffer.from("crash residue");
    const batch = stageAtomicObjectBatch(objectsDir, db, "ws", "crashed", [
      { bytes, mediaType: "text/plain" },
    ]);
    batch.install("2026-08-08T00:00:00Z");
    const [object] = batch.objects;
    expect(object && existsSync(objectPath(objectsDir, object.hash))).toBe(true);
    batch.abandon();
    expect(repairAtomicObjectBatches(objectsDir, db)).toBe(1);
    expect(object && existsSync(objectPath(objectsDir, object.hash))).toBe(false);
    expect(inventory(join(root, "object-staging"))).toEqual([]);
    db.close();
  });

  it("repair preserves committed bytes and the command receipt replays", () => {
    const { objectsDir, db } = setup();
    let event = 0;
    const transactor = createTransactor({
      db,
      workspaceId: "ws",
      newEventId: () => `event_${++event}`,
      now: () => "2026-08-08T00:00:00Z",
      onCommitted: () => {},
    });
    transactor.execute({
      protocol: "tweakloop.command/v1",
      commandId: "open",
      idempotencyKey: "workspace.open:ws",
      workspaceId: "ws",
      actor: { kind: "system", id: "daemon" },
      type: "workspace.open",
      payload: { projectId: "project", rootPath: "/repo" },
    });
    const bytes = Buffer.from("committed object");
    const idempotencyKey = "artifact.create:committed";
    const batch = stageAtomicObjectBatch(objectsDir, db, "ws", idempotencyKey, [
      { bytes, mediaType: "text/html" },
    ]);
    batch.install("2026-08-08T00:00:00Z");
    const hash = batch.objects[0]?.hash ?? "";
    const command = {
      protocol: "tweakloop.command/v1",
      commandId: "create",
      idempotencyKey,
      workspaceId: "ws",
      actor: { kind: "agent", id: "codex" },
      type: "artifact.create",
      payload: {
        artifactId: "artifact",
        name: "plan.html",
        format: "html",
        sourcePath: "/repo/plan.html",
        provenance: { kind: "workspace-source" },
        revisionId: "revision",
        entryPath: "plan.html",
        entryHash: hash,
        files: [{ path: "plan.html", hash, mediaType: "text/html" }],
        producer: { kind: "agent", id: "codex" },
        attachment: null,
      },
    } as const;
    const committed = transactor.execute(command);
    expect(committed.status).toBe("accepted");
    batch.abandon();
    expect(repairAtomicObjectBatches(objectsDir, db)).toBe(1);
    expect(existsSync(objectPath(objectsDir, hash))).toBe(true);
    expect(transactor.execute({ ...command, commandId: "retry" })).toEqual(committed);
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 3 });
    db.close();
  });
});
