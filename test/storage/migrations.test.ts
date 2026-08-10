import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createTransactor } from "../../src/daemon/transactor.js";
import { runMigrations } from "../../src/storage/sqlite/migrations.js";

function legacyChatTable(db: Database.Database, extra = ""): void {
  db.exec(`
    CREATE TABLE p_chat (
      message_id TEXT PRIMARY KEY,
      artifact_id TEXT,
      author TEXT NOT NULL,
      text TEXT NOT NULL,
      context_json TEXT,
      mentions_json TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      session_id TEXT,
      recipient_agent_id TEXT,
      thread_id TEXT,
      work_id TEXT,
      intent_id TEXT,
      references_json TEXT NOT NULL DEFAULT '[]',
      attachments_json TEXT NOT NULL DEFAULT '[]'
      ${extra}
    ) STRICT;
    PRAGMA user_version = 8;
  `);
}

describe("chat delivery migrations", () => {
  it("binds client-owned work recovery to a constrained durable capability hash", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runtime_leases (
        work_id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        process_nonce TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 14;
    `);

    runMigrations(db);

    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(
      (db.prepare("PRAGMA table_info(runtime_leases)").all() as readonly { name: string }[]).some(
        (column) => column.name === "request_capability_hash",
      ),
    ).toBe(true);
    expect(() =>
      db
        .prepare(
          `INSERT INTO runtime_leases (
             work_id, claim_id, agent_id, process_nonce, request_capability_hash,
             expires_at, last_heartbeat
           ) VALUES ('work', 'claim', 'agent', 'process', ?, 2, 1)`,
        )
        .run("a".repeat(62)),
    ).toThrow(/CHECK constraint failed/);
    db.close();
  });

  it("rejects a counterfeit work recovery capability column without its constraint", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runtime_leases (
        work_id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        process_nonce TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL,
        request_capability_hash TEXT
      ) STRICT;
      PRAGMA user_version = 14;
    `);

    expect(() => runMigrations(db)).toThrow(/missing nullable 64-character CHECK/);
    expect(db.pragma("user_version", { simple: true })).toBe(14);
    db.close();
  });

  it("reconciles a partial v8 delivery projection without duplicate-column failure", () => {
    const db = new Database(":memory:");
    legacyChatTable(db, ", delivery_status TEXT");
    runMigrations(db);

    const columns = new Set(
      (db.prepare("PRAGMA table_info(p_chat)").all() as readonly { name: string }[]).map(
        (column) => column.name,
      ),
    );
    for (const name of [
      "delivery_status",
      "delivery_attempt_id",
      "delivery_attempt_number",
      "delivery_agent_id",
      "delivery_offered_at",
      "delivery_acknowledged_at",
      "delivery_paused_at",
      "delivery_pause_reason",
    ]) {
      expect(columns.has(name), `missing ${name}`).toBe(true);
    }
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'p_chat_inbound_candidates'",
        )
        .get(),
    ).toEqual({ name: "p_chat_inbound_candidates" });
    db.close();
  });

  it("fails an incompatible partial column with an exact diagnostic and preserves v8", () => {
    const db = new Database(":memory:");
    legacyChatTable(db, ", delivery_attempt_number TEXT");
    expect(() => runMigrations(db)).toThrow(/incompatible column p_chat\.delivery_attempt_number/);
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_chat_deliveries'",
        )
        .get(),
    ).toBeUndefined();
    db.close();
  });

  it("keeps the explicitly supported missing-projection recovery path idempotent", () => {
    const db = new Database(":memory:");
    db.pragma("user_version = 8");
    runMigrations(db);
    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runtime_chat_deliveries'",
        )
        .get(),
    ).toEqual({ name: "runtime_chat_deliveries" });
    db.close();
  });

  it.each([
    {
      defect: "wrong type and nullable authority fields",
      table: `CREATE TABLE runtime_chat_deliveries (
        attempt_id TEXT, message_id TEXT, workspace_id TEXT, session_id TEXT,
        recipient_agent_id TEXT, process_nonce TEXT, attempt_number TEXT,
        capability_hash TEXT, offered_at TEXT, expires_at TEXT
      ) STRICT`,
    },
    {
      defect: "missing message uniqueness",
      table: `CREATE TABLE runtime_chat_deliveries (
        attempt_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL, process_nonce TEXT NOT NULL,
        attempt_number INTEGER NOT NULL, capability_hash TEXT NOT NULL,
        offered_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        CHECK (attempt_number >= 1), CHECK (length(capability_hash) = 64)
      ) STRICT`,
    },
    {
      defect: "missing attempt-number check",
      table: `CREATE TABLE runtime_chat_deliveries (
        attempt_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL, process_nonce TEXT NOT NULL,
        attempt_number INTEGER NOT NULL, capability_hash TEXT NOT NULL,
        offered_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        CHECK (length(capability_hash) = 64)
      ) STRICT`,
    },
    {
      defect: "missing capability-hash check",
      table: `CREATE TABLE runtime_chat_deliveries (
        attempt_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL, process_nonce TEXT NOT NULL,
        attempt_number INTEGER NOT NULL, capability_hash TEXT NOT NULL,
        offered_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        CHECK (attempt_number >= 1)
      ) STRICT`,
    },
    {
      defect: "unexpected extra column",
      table: `CREATE TABLE runtime_chat_deliveries (
        attempt_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL, recipient_agent_id TEXT NOT NULL, process_nonce TEXT NOT NULL,
        attempt_number INTEGER NOT NULL, capability_hash TEXT NOT NULL,
        offered_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, extra TEXT,
        CHECK (attempt_number >= 1), CHECK (length(capability_hash) = 64)
      ) STRICT`,
    },
  ])("rejects $defect without advancing the migration", ({ table }) => {
    const db = new Database(":memory:");
    db.exec(`${table}; PRAGMA user_version = 8;`);
    expect(() => runMigrations(db)).toThrow(
      /migration incompatible schema runtime_chat_deliveries/,
    );
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    db.close();
  });

  it("rejects commented checks and a partial message-id unique index behaviorally", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runtime_chat_deliveries (
        attempt_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        process_nonce TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        capability_hash TEXT NOT NULL,
        offered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
        /* CHECK (attempt_number >= 1) */
        /* CHECK (length(capability_hash) = 64) */
      ) STRICT;
      CREATE UNIQUE INDEX fake_message_unique
      ON runtime_chat_deliveries(message_id)
      WHERE attempt_number > 100;
      PRAGMA user_version = 8;
    `);
    expect(() => runMigrations(db)).toThrow(/single-column UNIQUE/);
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_chat_deliveries").get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it("rejects marker-targeted unrelated constraints instead of crediting any constraint error", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE runtime_chat_deliveries (
        attempt_id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        recipient_agent_id TEXT NOT NULL,
        process_nonce TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        capability_hash TEXT NOT NULL,
        offered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        CHECK (attempt_id NOT LIKE 'attempt_zero_%'),
        CHECK (attempt_id NOT LIKE 'attempt_hash_%')
        /* CHECK (attempt_number >= 1) */
        /* CHECK (length(capability_hash) = 64) */
      ) STRICT;
      CREATE UNIQUE INDEX fake_message_unique
      ON runtime_chat_deliveries(message_id)
      WHERE attempt_id LIKE 'attempt_duplicate_%';
      PRAGMA user_version = 8;
    `);
    expect(() => runMigrations(db)).toThrow(/single-column UNIQUE/);
    expect(db.pragma("user_version", { simple: true })).toBe(8);
    expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_chat_deliveries").get()).toEqual({
      count: 0,
    });
    db.close();
  });

  it("marks a real v11 receipt as identity-unverifiable and fails every replay closed", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE command_receipts (
        workspace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        command_id TEXT NOT NULL,
        first_event_seq INTEGER,
        last_event_seq INTEGER,
        response_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, idempotency_key)
      ) STRICT;
      CREATE TABLE p_chat (
        message_id TEXT PRIMARY KEY,
        artifact_id TEXT,
        author TEXT NOT NULL,
        text TEXT NOT NULL,
        context_json TEXT,
        mentions_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        created_seq INTEGER NOT NULL,
        session_id TEXT,
        recipient_agent_id TEXT,
        thread_id TEXT,
        work_id TEXT,
        intent_id TEXT,
        references_json TEXT NOT NULL DEFAULT '[]',
        attachments_json TEXT NOT NULL DEFAULT '[]',
        delivery_status TEXT,
        delivery_attempt_id TEXT,
        delivery_attempt_number INTEGER NOT NULL DEFAULT 0,
        delivery_agent_id TEXT,
        delivery_offered_at TEXT,
        delivery_acknowledged_at TEXT,
        delivery_paused_at TEXT,
        delivery_pause_reason TEXT,
        inbound_candidate INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      INSERT INTO command_receipts VALUES (
        'workspace-v11',
        'legacy-key',
        'legacy-command',
        1,
        1,
        '{"status":"accepted","commandId":"legacy-command","firstEventSeq":1,"lastEventSeq":1,"response":{"artifactId":"legacy-artifact"}}',
        '2026-08-07T00:00:00.000Z'
      );
      PRAGMA user_version = 11;
    `);

    runMigrations(db);
    expect(db.pragma("user_version", { simple: true })).toBe(19);
    expect(
      db
        .prepare(
          "SELECT reason FROM command_receipt_identity_gaps WHERE workspace_id = ? AND idempotency_key = ?",
        )
        .get("workspace-v11", "legacy-key"),
    ).toEqual({ reason: "legacy-request-identity-unverifiable" });

    const transactor = createTransactor({
      db,
      workspaceId: "workspace-v11",
      newEventId: () => "must-not-append",
      now: () => "2026-08-07T01:00:00.000Z",
      onCommitted: () => {
        throw new Error("legacy receipt replay must not commit");
      },
    });
    const replay = (artifactId: string) =>
      transactor.execute({
        protocol: "tweakloop.command/v1",
        commandId: `replay-${artifactId}`,
        idempotencyKey: "legacy-key",
        workspaceId: "workspace-v11",
        actor: { kind: "human", id: "alex" },
        type: "artifact.register",
        payload: {
          artifactId,
          name: "legacy.html",
          format: "html",
          sourcePath: "/repo/legacy.html",
        },
      });
    expect(replay("legacy-artifact")).toMatchObject({
      status: "rejected",
      code: "idempotency-identity-unverifiable",
    });
    expect(replay("changed-artifact")).toMatchObject({
      status: "rejected",
      code: "idempotency-identity-unverifiable",
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({
      count: 1,
    });
    db.close();
  });
});
