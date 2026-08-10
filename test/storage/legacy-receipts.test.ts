import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildProjections } from "../../src/daemon/projections.js";
import { createTransactor } from "../../src/daemon/transactor.js";
import type { ActorRef, CommandAccepted } from "../../src/protocol/envelopes.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import { runMigrations } from "../../src/storage/sqlite/migrations.js";

const WS = "ws_legacy";
const ROOT = "/repo/legacy";
const SOURCE = `${ROOT}/plan.html`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databaseAtV15(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  db.pragma("user_version = 15");
  return db;
}

function databaseFileAtV15(): Readonly<{ db: Database.Database; path: string }> {
  const root = mkdtempSync(join(tmpdir(), "tweakloop-legacy-receipts-"));
  roots.push(root);
  const path = join(root, "state.sqlite");
  const db = new Database(path);
  runMigrations(db);
  db.pragma("user_version = 15");
  return { db, path };
}

function insertEvent(
  db: Database.Database,
  seq: number,
  type: "workspace.opened" | "artifact.registered",
  actor: ActorRef,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO events (
       seq, event_id, workspace_id, stream_type, stream_id, stream_version,
       event_type, schema_version, recorded_at, actor_json,
       causation_id, correlation_id, payload_json
     ) VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    `evt_${seq}`,
    WS,
    type === "workspace.opened" ? "workspace" : "artifact",
    type === "workspace.opened" ? WS : String(payload.artifactId),
    type,
    `2026-08-08T00:00:0${seq}.000Z`,
    JSON.stringify(actor),
    `cmd_${seq}`,
    `cmd_${seq}`,
    JSON.stringify({ type, ...payload }),
  );
}

function insertReceipt(
  db: Database.Database,
  key: string,
  seq: number,
  response: CommandAccepted,
  lastSeq = seq,
): void {
  db.prepare(
    `INSERT INTO command_receipts (
       workspace_id, idempotency_key, command_id, first_event_seq,
       last_event_seq, response_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    WS,
    key,
    response.commandId,
    seq,
    lastSeq,
    JSON.stringify(response),
    "2026-08-08T00:00:00Z",
  );
  db.prepare(
    `INSERT INTO command_receipt_identity_gaps (workspace_id, idempotency_key, reason)
     VALUES (?, ?, 'legacy-request-identity-unverifiable')`,
  ).run(WS, key);
}

function accepted(commandId: string, seq: number, response: unknown): CommandAccepted {
  return { status: "accepted", commandId, firstEventSeq: seq, lastEventSeq: seq, response };
}

describe("deterministic legacy receipt reconstruction", () => {
  it("reconstructs and replays exactly workspace.open and artifact.register", () => {
    const db = databaseAtV15();
    const system = { kind: "system", id: "daemon" } as const;
    const agent = { kind: "agent", id: "codex" } as const;
    insertEvent(db, 1, "workspace.opened", system, {
      workspaceId: WS,
      projectId: "project_legacy",
      rootPath: ROOT,
    });
    insertReceipt(
      db,
      `workspace.open:${WS}`,
      1,
      accepted("cmd_1", 1, { alreadyOpen: false, projectId: "project_legacy" }),
    );
    insertEvent(db, 2, "artifact.registered", agent, {
      artifactId: "artifact_legacy",
      name: "plan.html",
      format: "html",
      sourcePath: SOURCE,
    });
    insertReceipt(
      db,
      `artifact.register:${SOURCE}`,
      2,
      accepted("cmd_2", 2, { artifactId: "artifact_legacy" }),
    );

    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_request_hashes").get()).toEqual({
      count: 2,
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipt_identity_gaps").get()).toEqual(
      {
        count: 0,
      },
    );
    const transactor = createTransactor({
      db,
      workspaceId: WS,
      newEventId: () => "must_not_append",
      now: () => "2026-08-08T01:00:00Z",
      onCommitted: () => {
        throw new Error("legacy replay must not commit");
      },
    });
    expect(
      transactor.execute({
        protocol: "tweakloop.command/v1",
        commandId: "retry_workspace",
        idempotencyKey: `workspace.open:${WS}`,
        workspaceId: WS,
        actor: system,
        type: "workspace.open",
        payload: { projectId: "project_legacy", rootPath: ROOT },
      }),
    ).toEqual(accepted("cmd_1", 1, { alreadyOpen: false, projectId: "project_legacy" }));
    expect(
      transactor.execute({
        protocol: "tweakloop.command/v1",
        commandId: "retry_artifact",
        idempotencyKey: `artifact.register:${SOURCE}`,
        workspaceId: WS,
        actor: agent,
        type: "artifact.register",
        payload: {
          artifactId: "artifact_legacy",
          name: "plan.html",
          format: "html",
          sourcePath: SOURCE,
        },
      }),
    ).toEqual(accepted("cmd_2", 2, { artifactId: "artifact_legacy" }));
    expect(
      transactor.execute({
        protocol: "tweakloop.command/v1",
        commandId: "wrong_artifact_actor",
        idempotencyKey: `artifact.register:${SOURCE}`,
        workspaceId: WS,
        actor: { kind: "agent", id: "other-agent" },
        type: "artifact.register",
        payload: {
          artifactId: "artifact_legacy",
          name: "plan.html",
          format: "html",
          sourcePath: SOURCE,
        },
      }),
    ).toMatchObject({ status: "rejected", code: "idempotency-key-conflict" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    db.close();
  });

  it("keeps payload, response, and event-range mismatches gapped for both families", () => {
    for (const family of ["workspace", "artifact"] as const) {
      for (const mismatch of ["payload", "response", "event-range"] as const) {
        const db = databaseAtV15();
        const seq = 1;
        const key = family === "workspace" ? `workspace.open:${WS}` : `artifact.register:${SOURCE}`;
        if (family === "workspace") {
          insertEvent(
            db,
            seq,
            "workspace.opened",
            { kind: "system", id: "daemon" },
            {
              workspaceId: mismatch === "payload" ? "wrong_workspace" : WS,
              projectId: "project_legacy",
              rootPath: ROOT,
            },
          );
          insertReceipt(
            db,
            key,
            seq,
            accepted("cmd_1", seq, {
              alreadyOpen: false,
              projectId: mismatch === "response" ? "wrong_project" : "project_legacy",
            }),
            mismatch === "event-range" ? seq + 1 : seq,
          );
        } else {
          insertEvent(
            db,
            seq,
            "artifact.registered",
            { kind: "agent", id: "codex" },
            {
              artifactId: "artifact_legacy",
              name: "plan.html",
              format: "html",
              sourcePath: mismatch === "payload" ? "/wrong/source.html" : SOURCE,
            },
          );
          insertReceipt(
            db,
            key,
            seq,
            accepted("cmd_1", seq, {
              artifactId: mismatch === "response" ? "wrong_artifact" : "artifact_legacy",
            }),
            mismatch === "event-range" ? seq + 1 : seq,
          );
        }
        runMigrations(db);
        expect(
          db
            .prepare(
              `SELECT reason FROM command_receipt_identity_gaps
               WHERE workspace_id = ? AND idempotency_key = ?`,
            )
            .get(WS, key),
          `${family} ${mismatch}`,
        ).toEqual({ reason: "legacy-request-identity-unverifiable" });
        expect(
          db
            .prepare(
              `SELECT request_hash FROM command_request_hashes
               WHERE workspace_id = ? AND idempotency_key = ?`,
            )
            .get(WS, key),
        ).toBeUndefined();
        db.close();
      }
    }
  });

  it("fails closed on actor, payload, response, event-range, and unnamed-family mismatches", () => {
    const db = databaseAtV15();
    const system = { kind: "system", id: "daemon" } as const;
    const agent = { kind: "agent", id: "codex" } as const;
    insertEvent(db, 1, "workspace.opened", system, {
      workspaceId: WS,
      projectId: "project_legacy",
      rootPath: ROOT,
    });
    insertReceipt(
      db,
      `workspace.open:${WS}`,
      1,
      accepted("cmd_1", 1, { alreadyOpen: false, projectId: "project_legacy" }),
    );
    insertEvent(db, 2, "artifact.registered", agent, {
      artifactId: "artifact_legacy",
      name: "plan.html",
      format: "html",
      sourcePath: SOURCE,
    });
    insertReceipt(
      db,
      `artifact.register:${SOURCE}`,
      2,
      accepted("cmd_2", 2, { artifactId: "wrong_response" }),
    );
    insertReceipt(db, "unrelated:deterministic", 1, accepted("cmd_other", 1, { ok: true }));
    runMigrations(db);

    const transactor = createTransactor({
      db,
      workspaceId: WS,
      newEventId: () => "must_not_append",
      now: () => "2026-08-08T01:00:00Z",
      onCommitted: () => {},
    });
    expect(
      transactor.execute({
        protocol: "tweakloop.command/v1",
        commandId: "wrong_actor",
        idempotencyKey: `workspace.open:${WS}`,
        workspaceId: WS,
        actor: { kind: "system", id: "different-daemon" },
        type: "workspace.open",
        payload: { projectId: "project_legacy", rootPath: ROOT },
      }),
    ).toMatchObject({ status: "rejected", code: "idempotency-key-conflict" });
    for (const key of [`artifact.register:${SOURCE}`, "unrelated:deterministic"]) {
      const row = db
        .prepare(
          `SELECT reason FROM command_receipt_identity_gaps
           WHERE workspace_id = ? AND idempotency_key = ?`,
        )
        .get(WS, key);
      expect(row).toEqual({ reason: "legacy-request-identity-unverifiable" });
    }
    expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 2 });
    db.close();
  });

  it("replays supported receipts across file restarts and rebuild while corruption stays gapped", () => {
    const { db: seeded, path } = databaseFileAtV15();
    const system = { kind: "system", id: "daemon" } as const;
    const agent = { kind: "agent", id: "codex" } as const;
    const corruptSource = `${ROOT}/corrupt.html`;

    insertEvent(seeded, 1, "workspace.opened", system, {
      workspaceId: WS,
      projectId: "project_legacy",
      rootPath: ROOT,
    });
    insertReceipt(
      seeded,
      `workspace.open:${WS}`,
      1,
      accepted("cmd_1", 1, { alreadyOpen: false, projectId: "project_legacy" }),
    );
    insertEvent(seeded, 2, "artifact.registered", agent, {
      artifactId: "artifact_legacy",
      name: "plan.html",
      format: "html",
      sourcePath: SOURCE,
    });
    insertReceipt(
      seeded,
      `artifact.register:${SOURCE}`,
      2,
      accepted("cmd_2", 2, { artifactId: "artifact_legacy" }),
    );
    insertEvent(seeded, 3, "artifact.registered", agent, {
      artifactId: "artifact_corrupt",
      name: "corrupt.html",
      format: "html",
      sourcePath: corruptSource,
    });
    insertReceipt(
      seeded,
      `artifact.register:${corruptSource}`,
      3,
      accepted("cmd_3", 3, { artifactId: "wrong_response" }),
    );
    seeded.close();

    const assertReceiptState = (db: Database.Database): void => {
      expect(db.pragma("user_version", { simple: true })).toBe(19);
      expect(db.prepare("SELECT COUNT(*) AS count FROM command_request_hashes").get()).toEqual({
        count: 2,
      });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM command_receipt_identity_gaps").get(),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            `SELECT reason FROM command_receipt_identity_gaps
             WHERE workspace_id = ? AND idempotency_key = ?`,
          )
          .get(WS, `artifact.register:${corruptSource}`),
      ).toEqual({ reason: "legacy-request-identity-unverifiable" });

      const transactor = createTransactor({
        db,
        workspaceId: WS,
        newEventId: () => "must_not_append",
        now: () => "2026-08-08T01:00:00Z",
        onCommitted: () => {
          throw new Error("legacy replay must not commit");
        },
      });
      expect(
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: "retry_workspace",
          idempotencyKey: `workspace.open:${WS}`,
          workspaceId: WS,
          actor: system,
          type: "workspace.open",
          payload: { projectId: "project_legacy", rootPath: ROOT },
        }),
      ).toEqual(accepted("cmd_1", 1, { alreadyOpen: false, projectId: "project_legacy" }));
      expect(
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: "retry_artifact",
          idempotencyKey: `artifact.register:${SOURCE}`,
          workspaceId: WS,
          actor: agent,
          type: "artifact.register",
          payload: {
            artifactId: "artifact_legacy",
            name: "plan.html",
            format: "html",
            sourcePath: SOURCE,
          },
        }),
      ).toEqual(accepted("cmd_2", 2, { artifactId: "artifact_legacy" }));
      expect(
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: "retry_corrupt",
          idempotencyKey: `artifact.register:${corruptSource}`,
          workspaceId: WS,
          actor: agent,
          type: "artifact.register",
          payload: {
            artifactId: "artifact_corrupt",
            name: "corrupt.html",
            format: "html",
            sourcePath: corruptSource,
          },
        }),
      ).toMatchObject({ status: "rejected", code: "idempotency-identity-unverifiable" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 3 });
    };

    const firstRestart = openDatabase(path);
    assertReceiptState(firstRestart);
    rebuildProjections(firstRestart, WS);
    expect(firstRestart.prepare("SELECT COUNT(*) AS count FROM p_artifacts").get()).toEqual({
      count: 2,
    });
    firstRestart.close();

    const secondRestart = openDatabase(path);
    assertReceiptState(secondRestart);
    secondRestart.close();
  });
});
