import type Database from "better-sqlite3";

type Migration = Readonly<{ version: number; up: (db: Database.Database) => void }>;

/**
 * Durable tables follow docs/architecture.md §8.1. Tables prefixed p_
 * are disposable projections rebuildable from the event log.
 */
const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE events (
            seq                INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id           TEXT NOT NULL UNIQUE,
            workspace_id       TEXT NOT NULL,
            stream_type        TEXT NOT NULL,
            stream_id          TEXT NOT NULL,
            stream_version     INTEGER NOT NULL,
            event_type         TEXT NOT NULL,
            schema_version     INTEGER NOT NULL,
            recorded_at        TEXT NOT NULL,
            actor_json         TEXT NOT NULL,
            causation_id       TEXT,
            correlation_id     TEXT,
            payload_json       TEXT NOT NULL,

            UNIQUE (workspace_id, stream_id, stream_version)
        ) STRICT;

        CREATE INDEX events_by_stream
        ON events(workspace_id, stream_id, stream_version);

        CREATE INDEX events_by_type
        ON events(workspace_id, event_type, seq);

        CREATE TABLE command_receipts (
            workspace_id       TEXT NOT NULL,
            idempotency_key    TEXT NOT NULL,
            command_id         TEXT NOT NULL,
            first_event_seq    INTEGER,
            last_event_seq     INTEGER,
            response_json      TEXT NOT NULL,
            recorded_at        TEXT NOT NULL,

            PRIMARY KEY (workspace_id, idempotency_key)
        ) STRICT;

        CREATE TABLE blobs (
            hash               TEXT PRIMARY KEY,
            byte_length        INTEGER NOT NULL,
            media_type         TEXT NOT NULL,
            created_at         TEXT NOT NULL
        ) STRICT;

        CREATE TABLE p_artifacts (
            artifact_id        TEXT PRIMARY KEY,
            name               TEXT NOT NULL,
            format             TEXT NOT NULL,
            source_path        TEXT,
            registered_seq     INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE p_timeline (
            seq                INTEGER PRIMARY KEY,
            recorded_at        TEXT NOT NULL,
            event_type         TEXT NOT NULL,
            stream_type        TEXT NOT NULL,
            stream_id          TEXT NOT NULL,
            actor_json         TEXT NOT NULL,
            summary            TEXT NOT NULL
        ) STRICT;
      `);
    },
  },
];

export function runMigrations(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    });
    apply.immediate();
  }
}
