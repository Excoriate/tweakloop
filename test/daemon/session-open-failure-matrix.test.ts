import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTransactor, type TransactorDeps } from "../../src/daemon/transactor.js";
import { stageAtomicObjectBatch } from "../../src/storage/object-store/atomic-batch.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inventory(directory: string): string[] {
  const files: string[] = [];
  const walk = (path: string, prefix: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(path, entry.name), relative);
      else files.push(relative);
    }
  };
  try {
    walk(directory, "");
  } catch {
    return [];
  }
  return files.sort();
}

describe("session open transaction failure matrix", () => {
  it("rolls events, projections, receipts, metadata, and physical CAS back together", () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-open-failure-"));
    roots.push(root);
    const objectsDir = join(root, "objects");
    const db = openDatabase(join(root, "events.sqlite"));
    let eventId = 0;
    const common = {
      db,
      workspaceId: "ws",
      newEventId: () => `event_${++eventId}`,
      now: () => "2026-08-08T00:00:00Z",
      onCommitted: () => {},
    } satisfies TransactorDeps;
    const seed = createTransactor(common);
    seed.execute({
      protocol: "tweakloop.command/v1",
      commandId: "workspace",
      idempotencyKey: "workspace.open:ws",
      workspaceId: "ws",
      actor: { kind: "system", id: "daemon" },
      type: "workspace.open",
      payload: { projectId: "project", rootPath: "/repo" },
    });
    seed.execute({
      protocol: "tweakloop.command/v1",
      commandId: "session",
      idempotencyKey: "session.start:existing",
      workspaceId: "ws",
      actor: { kind: "agent", id: "codex" },
      type: "session.start",
      payload: {
        sessionId: "existing",
        artifactId: null,
        agentId: "codex",
        processNonce: "process",
        baseRevisionId: null,
        title: "Existing",
        goal: "Atomic open",
      },
    });
    const baseline = {
      events: db.prepare("SELECT COUNT(*) AS count FROM events").get(),
      receipts: db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get(),
      cas: inventory(objectsDir),
    };

    for (const point of ["after-events", "after-projections", "after-receipt"] as const) {
      const idempotencyKey = `session.open-artifact:${point}`;
      const bytes = Buffer.from(`bytes-${point}`);
      const batch = stageAtomicObjectBatch(objectsDir, db, "ws", idempotencyKey, [
        { bytes, mediaType: "text/html" },
      ]);
      batch.install("2026-08-08T00:00:00Z");
      const hash = batch.objects[0]?.hash ?? "";
      const transactor = createTransactor({
        ...common,
        failureInjection: (candidate) => {
          if (candidate === point) throw new Error(`injected ${point}`);
        },
      });
      expect(() =>
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: `command_${point}`,
          idempotencyKey,
          workspaceId: "ws",
          actor: { kind: "agent", id: "codex" },
          type: "session.open-artifact",
          payload: {
            sessionId: "existing",
            artifactId: `artifact_${point}`,
            name: "plan.html",
            format: "html",
            sourcePath: `/repo/${point}.html`,
            provenance: { kind: "workspace-source" },
            revisionId: `revision_${point}`,
            entryPath: "plan.html",
            entryHash: hash,
            files: [{ path: "plan.html", hash, mediaType: "text/html" }],
            producer: { kind: "agent", id: "codex" },
            role: "opened",
          },
        }),
      ).toThrow(`injected ${point}`);
      batch.rollback();
      expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(baseline.events);
      expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual(
        baseline.receipts,
      );
      expect(db.prepare("SELECT COUNT(*) AS count FROM p_artifacts").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM p_revisions").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM p_session_artifacts").get()).toEqual({
        count: 0,
      });
      expect(inventory(objectsDir)).toEqual(baseline.cas);
    }
    db.close();
  });
});
