import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runMigrations } from "../../src/storage/sqlite/migrations.js";

describe("runtime authority migrations", () => {
  it("fails closed on a counterfeit session-authority table before version or token placement", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec(`
      DROP TABLE runtime_whiteboard_automation_tokens;
      DROP TABLE runtime_session_authorities;
      PRAGMA user_version = 17;
      CREATE TABLE runtime_session_authorities (
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        principal_kind TEXT NOT NULL,
        capability_hash TEXT NOT NULL,
        declared_agent_id TEXT NOT NULL,
        process_nonce TEXT NOT NULL,
        runtime_generation INTEGER NOT NULL,
        daemon_start_nonce TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (workspace_id, session_id)
      );
    `);
    expect(() => runMigrations(db)).toThrow(/runtime_session_authorities.*STRICT/);
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'runtime_whiteboard_automation_tokens'",
        )
        .get(),
    ).toEqual({ count: 0 });
    db.close();
  });

  it("rejects an exact-column token table whose route, hash, and expiry checks are missing", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    const sessionSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("runtime_session_authorities") as { sql: string }
    ).sql;
    db.exec(`
      DROP TABLE runtime_whiteboard_automation_tokens;
      DROP TABLE runtime_session_authorities;
      PRAGMA user_version = 17;
      ${sessionSql};
      CREATE TABLE runtime_whiteboard_automation_tokens (
        token_hash TEXT NOT NULL PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        runtime_generation INTEGER NOT NULL,
        daemon_start_nonce TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        method TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        route_set_version INTEGER NOT NULL,
        request_hash TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        used_at INTEGER,
        revoked_at INTEGER
      ) STRICT;
    `);
    expect(() => runMigrations(db)).toThrow(
      /runtime_whiteboard_automation_tokens.*required CHECK is missing/,
    );
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    db.close();
  });

  it("rejects a counterfeit native-hook binding table before promoting migration 19", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    db.exec(`
      DROP TABLE runtime_native_hook_bindings;
      PRAGMA user_version = 18;
      CREATE TABLE runtime_native_hook_bindings (
        workspace_id TEXT NOT NULL,
        client TEXT NOT NULL,
        profile_hash TEXT NOT NULL,
        native_conversation_hash TEXT NOT NULL,
        binding_secret_hash TEXT NOT NULL,
        session_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        process_nonce TEXT NOT NULL,
        runtime_generation INTEGER NOT NULL,
        daemon_start_nonce TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        revoked_at INTEGER,
        PRIMARY KEY (workspace_id, client, profile_hash, native_conversation_hash)
      ) STRICT;
    `);
    expect(() => runMigrations(db)).toThrow(
      /runtime_native_hook_bindings.*required CHECK is missing/,
    );
    expect(db.pragma("user_version", { simple: true })).toBe(18);
    db.close();
  });
});
