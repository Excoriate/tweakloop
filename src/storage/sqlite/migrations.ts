import type Database from "better-sqlite3";
import { INBOUND_CHAT_BACKLOG_LIMIT } from "../../protocol/chat-delivery.js";
import { reconstructSupportedLegacyReceiptHashes } from "./legacy-receipts.js";

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
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE p_revisions (
            revision_id        TEXT PRIMARY KEY,
            artifact_id        TEXT NOT NULL,
            parent_id          TEXT,
            seq                INTEGER NOT NULL,
            format             TEXT NOT NULL,
            entry_path         TEXT NOT NULL,
            entry_hash         TEXT NOT NULL,
            files_json         TEXT NOT NULL,
            producer_json      TEXT NOT NULL,
            source_path        TEXT,
            created_seq        INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX p_revisions_by_artifact ON p_revisions(artifact_id, seq);

        CREATE TABLE p_intents (
            intent_id          TEXT PRIMARY KEY,
            batch_id           TEXT NOT NULL,
            artifact_id        TEXT NOT NULL,
            revision_id        TEXT NOT NULL,
            intent_type        TEXT NOT NULL,
            target_json        TEXT NOT NULL,
            body_json          TEXT NOT NULL,
            status             TEXT NOT NULL,
            created_seq        INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE p_work (
            work_id            TEXT PRIMARY KEY,
            artifact_id        TEXT NOT NULL,
            base_revision_id   TEXT NOT NULL,
            intent_ids_json    TEXT NOT NULL,
            status             TEXT NOT NULL,
            claim_json         TEXT,
            result_json        TEXT,
            created_seq        INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        CREATE TABLE p_chat (
            message_id         TEXT PRIMARY KEY,
            artifact_id        TEXT,
            author             TEXT NOT NULL,
            text               TEXT NOT NULL,
            context_json       TEXT,
            mentions_json      TEXT NOT NULL,
            recorded_at        TEXT NOT NULL,
            created_seq        INTEGER NOT NULL
        ) STRICT;
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        ALTER TABLE p_work ADD COLUMN assignee_agent_id TEXT;
        ALTER TABLE p_work ADD COLUMN session_id TEXT;
        ALTER TABLE p_work ADD COLUMN progress_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE p_work ADD COLUMN decision_status TEXT NOT NULL DEFAULT 'pending';

        ALTER TABLE p_chat ADD COLUMN session_id TEXT;
        ALTER TABLE p_chat ADD COLUMN recipient_agent_id TEXT;
        ALTER TABLE p_chat ADD COLUMN thread_id TEXT;
        ALTER TABLE p_chat ADD COLUMN work_id TEXT;
        ALTER TABLE p_chat ADD COLUMN intent_id TEXT;

        CREATE TABLE runtime_leases (
            work_id            TEXT PRIMARY KEY,
            claim_id           TEXT NOT NULL,
            agent_id           TEXT NOT NULL,
            process_nonce      TEXT NOT NULL,
            expires_at         INTEGER NOT NULL,
            last_heartbeat     INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX runtime_leases_by_expiry ON runtime_leases(expires_at);
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      db.exec(`
        CREATE TABLE whiteboard_drafts (
            artifact_id          TEXT PRIMARY KEY,
            draft_id             TEXT NOT NULL,
            base_revision_id     TEXT NOT NULL,
            scene_hash           TEXT NOT NULL,
            element_index_hash   TEXT NOT NULL,
            draft_version        INTEGER NOT NULL,
            updated_by_json      TEXT NOT NULL,
            updated_at           TEXT NOT NULL,
            client_id            TEXT NOT NULL,
            client_sequence      INTEGER NOT NULL,
            published_revision_id TEXT,
            CHECK (draft_version >= 1),
            CHECK (client_sequence >= 1)
        ) STRICT;

        CREATE TABLE whiteboard_draft_conflicts (
            conflict_id          TEXT PRIMARY KEY,
            artifact_id          TEXT NOT NULL,
            draft_id             TEXT NOT NULL,
            expected_version     INTEGER NOT NULL,
            current_version      INTEGER NOT NULL,
            submitted_scene_hash TEXT NOT NULL,
            current_scene_hash   TEXT NOT NULL,
            submitted_by_json    TEXT NOT NULL,
            created_at           TEXT NOT NULL,
            resolution           TEXT,
            resolved_at          TEXT,
            CHECK (expected_version >= 0),
            CHECK (current_version >= 1)
        ) STRICT;

        CREATE INDEX whiteboard_conflicts_by_artifact
        ON whiteboard_draft_conflicts(artifact_id, created_at);

        CREATE TABLE whiteboard_draft_receipts (
            artifact_id          TEXT NOT NULL,
            client_id            TEXT NOT NULL,
            client_sequence      INTEGER NOT NULL,
            request_hash         TEXT NOT NULL,
            response_json        TEXT NOT NULL,
            recorded_at          TEXT NOT NULL,
            PRIMARY KEY (artifact_id, client_id, client_sequence),
            CHECK (client_sequence >= 1)
        ) STRICT;
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        ALTER TABLE p_revisions ADD COLUMN session_id TEXT;

        CREATE TABLE p_sessions (
            session_id            TEXT PRIMARY KEY,
            artifact_id           TEXT NOT NULL,
            originating_agent_id  TEXT NOT NULL,
            agent_id              TEXT NOT NULL,
            process_nonce         TEXT NOT NULL,
            status                TEXT NOT NULL,
            base_revision_id      TEXT,
            title                 TEXT NOT NULL,
            goal                  TEXT NOT NULL,
            predecessor_session_id TEXT,
            handoff_to_agent_id   TEXT,
            handoff_summary       TEXT,
            summary               TEXT,
            created_at            TEXT NOT NULL,
            last_active_at        TEXT NOT NULL,
            ended_at              TEXT,
            created_seq           INTEGER NOT NULL,
            last_seq              INTEGER NOT NULL,
            CHECK (status IN ('active', 'handed-off', 'ended'))
        ) STRICT;

        CREATE INDEX p_sessions_by_artifact
        ON p_sessions(artifact_id, created_seq DESC);

        CREATE INDEX p_sessions_by_agent
        ON p_sessions(agent_id, created_seq DESC);

        CREATE INDEX p_revisions_by_session
        ON p_revisions(session_id, seq DESC);
      `);
    },
  },
  {
    version: 7,
    up: (db) => {
      db.exec(`
        ALTER TABLE p_chat ADD COLUMN references_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE p_chat ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
      `);
    },
  },
  {
    version: 8,
    up: (db) => {
      db.exec(`
        ALTER TABLE p_artifacts
        ADD COLUMN provenance_json TEXT NOT NULL DEFAULT '{"kind":"workspace-source"}';

        UPDATE p_artifacts
        SET provenance_json = CASE
          WHEN source_path IS NULL THEN '{"kind":"imported-snapshot"}'
          ELSE '{"kind":"workspace-source"}'
        END;

        DROP INDEX p_sessions_by_artifact;
        DROP INDEX p_sessions_by_agent;
        ALTER TABLE p_sessions RENAME TO p_sessions_v7;

        CREATE TABLE p_sessions (
            session_id            TEXT PRIMARY KEY,
            artifact_id           TEXT,
            originating_agent_id  TEXT NOT NULL,
            agent_id              TEXT NOT NULL,
            process_nonce         TEXT NOT NULL,
            status                TEXT NOT NULL,
            base_revision_id      TEXT,
            title                 TEXT NOT NULL,
            goal                  TEXT NOT NULL,
            predecessor_session_id TEXT,
            handoff_to_agent_id   TEXT,
            handoff_summary       TEXT,
            summary               TEXT,
            created_at            TEXT NOT NULL,
            last_active_at        TEXT NOT NULL,
            ended_at              TEXT,
            created_seq           INTEGER NOT NULL,
            last_seq              INTEGER NOT NULL,
            CHECK (status IN ('active', 'handed-off', 'ended'))
        ) STRICT;

        INSERT INTO p_sessions
        SELECT * FROM p_sessions_v7;

        DROP TABLE p_sessions_v7;

        CREATE INDEX p_sessions_by_artifact
        ON p_sessions(artifact_id, created_seq DESC);

        CREATE INDEX p_sessions_by_agent
        ON p_sessions(agent_id, created_seq DESC);

        CREATE TABLE p_session_artifacts (
            session_id            TEXT NOT NULL,
            artifact_id           TEXT NOT NULL,
            attached_revision_id  TEXT NOT NULL,
            role                  TEXT NOT NULL,
            attached_seq          INTEGER NOT NULL,
            PRIMARY KEY (session_id, artifact_id),
            CHECK (role IN ('primary', 'opened', 'whiteboard'))
        ) STRICT;

        CREATE INDEX p_session_artifacts_by_artifact
        ON p_session_artifacts(artifact_id, attached_seq);

        CREATE UNIQUE INDEX p_session_artifacts_one_primary
        ON p_session_artifacts(session_id)
        WHERE role = 'primary';

        INSERT INTO p_session_artifacts (
          session_id, artifact_id, attached_revision_id, role, attached_seq
        )
        SELECT
          s.session_id,
          s.artifact_id,
          COALESCE(
            s.base_revision_id,
            (
              SELECT r.revision_id
              FROM p_revisions r
              WHERE r.artifact_id = s.artifact_id
                AND r.created_seq <= s.created_seq
              ORDER BY r.seq DESC
              LIMIT 1
            )
          ),
          'primary',
          s.created_seq
        FROM p_sessions s
        WHERE s.artifact_id IS NOT NULL
          AND COALESCE(
            s.base_revision_id,
            (
              SELECT r.revision_id
              FROM p_revisions r
              WHERE r.artifact_id = s.artifact_id
                AND r.created_seq <= s.created_seq
              ORDER BY r.seq DESC
              LIMIT 1
            )
          ) IS NOT NULL;
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      const chatProjectionExists = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'p_chat'")
        .get();
      if (chatProjectionExists) {
        addMissingColumns(db, "p_chat", {
          delivery_status: "TEXT",
          delivery_attempt_id: "TEXT",
          delivery_attempt_number: "INTEGER NOT NULL DEFAULT 0",
          delivery_agent_id: "TEXT",
          delivery_offered_at: "TEXT",
          delivery_acknowledged_at: "TEXT",
          delivery_paused_at: "TEXT",
          delivery_pause_reason: "TEXT",
        });
      }
      const deliveryRuntimeExists = db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'runtime_chat_deliveries'",
        )
        .get();
      if (deliveryRuntimeExists) {
        requireRuntimeChatDeliveriesSchema(db);
      } else {
        db.exec(`CREATE TABLE runtime_chat_deliveries (
            attempt_id          TEXT PRIMARY KEY,
            message_id          TEXT NOT NULL UNIQUE,
            workspace_id        TEXT NOT NULL,
            session_id          TEXT NOT NULL,
            recipient_agent_id  TEXT NOT NULL,
            process_nonce       TEXT NOT NULL,
            attempt_number      INTEGER NOT NULL,
            capability_hash     TEXT NOT NULL,
            offered_at          INTEGER NOT NULL,
            expires_at          INTEGER NOT NULL,
            CHECK (attempt_number >= 1),
            CHECK (length(capability_hash) = 64)
        ) STRICT;`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS runtime_chat_deliveries_by_expiry
        ON runtime_chat_deliveries(expires_at);
      `);
    },
  },
  {
    version: 10,
    up: (db) => {
      const chatProjectionExists = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'p_chat'")
        .get();
      if (chatProjectionExists) {
        db.exec(`
          CREATE INDEX IF NOT EXISTS p_chat_inbound_candidates
          ON p_chat(session_id, delivery_status, created_seq);
        `);
      }
    },
  },
  {
    version: 11,
    up: (db) => {
      const chatProjectionExists = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'p_chat'")
        .get();
      if (chatProjectionExists) {
        addMissingColumns(db, "p_chat", {
          inbound_candidate: "INTEGER NOT NULL DEFAULT 0",
        });
        db.exec(`
          UPDATE p_chat
          SET inbound_candidate = CASE
            WHEN session_id IS NOT NULL
              AND author LIKE 'human:%'
              AND work_id IS NULL
              AND intent_id IS NULL
              AND (delivery_status IS NULL OR delivery_status = 'offered')
            THEN 1 ELSE 0 END;
          DROP INDEX IF EXISTS p_chat_inbound_candidates;
          CREATE INDEX p_chat_inbound_candidates
          ON p_chat(session_id, inbound_candidate, created_seq);
        `);
        const overloaded = db
          .prepare(
            `SELECT session_id, COUNT(*) AS count
             FROM p_chat
             WHERE inbound_candidate = 1
             GROUP BY session_id
             HAVING COUNT(*) > ?
             LIMIT 1`,
          )
          .get(INBOUND_CHAT_BACKLOG_LIMIT) as { session_id: string; count: number } | undefined;
        if (overloaded !== undefined) {
          throw new Error(
            `migration inbound chat limit exceeded for ${overloaded.session_id}: ${overloaded.count}`,
          );
        }
      }
    },
  },
  {
    version: 12,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS command_request_hashes (
          workspace_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          request_hash TEXT NOT NULL CHECK (length(request_hash) = 64),
          PRIMARY KEY (workspace_id, idempotency_key)
        ) STRICT;
      `);
    },
  },
  {
    version: 13,
    up: (db) => {
      const chatProjectionExists = db
        .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'p_chat'")
        .get();
      if (!chatProjectionExists) return;
      addMissingColumns(db, "p_chat", {
        content_json: "TEXT",
        reply_to_message_id: "TEXT",
        supersedes_message_id: "TEXT",
      });
      const legacyRows = db
        .prepare("SELECT message_id, text FROM p_chat WHERE content_json IS NULL")
        .all() as readonly { message_id: string; text: string }[];
      const backfill = db.prepare("UPDATE p_chat SET content_json = ? WHERE message_id = ?");
      for (const row of legacyRows) {
        backfill.run(JSON.stringify({ type: "text", text: row.text }), row.message_id);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS p_chat_replies
        ON p_chat(reply_to_message_id, created_seq);
      `);
    },
  },
  {
    version: 14,
    up: (db) => {
      db.exec(`
        CREATE TABLE command_receipt_identity_gaps (
          workspace_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          reason TEXT NOT NULL CHECK (reason = 'legacy-request-identity-unverifiable'),
          PRIMARY KEY (workspace_id, idempotency_key)
        ) STRICT;
      `);
      const receiptTableExists = db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'command_receipts'",
        )
        .get();
      if (!receiptTableExists) return;
      db.exec(`
        INSERT INTO command_receipt_identity_gaps (workspace_id, idempotency_key, reason)
        SELECT r.workspace_id, r.idempotency_key, 'legacy-request-identity-unverifiable'
        FROM command_receipts AS r
        LEFT JOIN command_request_hashes AS h
          ON h.workspace_id = r.workspace_id AND h.idempotency_key = r.idempotency_key
        WHERE h.request_hash IS NULL;
      `);
    },
  },
  {
    version: 15,
    up: (db) => {
      const runtimeLeasesExists = db
        .prepare(
          "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'runtime_leases'",
        )
        .get();
      if (!runtimeLeasesExists) return;
      addMissingColumns(db, "runtime_leases", {
        request_capability_hash:
          "TEXT CHECK (request_capability_hash IS NULL OR length(request_capability_hash) = 64)",
      });
      requireRuntimeLeaseRequestCapabilitySchema(db);
    },
  },
  {
    version: 16,
    up: (db) => {
      reconstructSupportedLegacyReceiptHashes(db);
    },
  },
  {
    version: 17,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS whiteboard_semantic_receipts (
            workspace_id            TEXT NOT NULL,
            artifact_id             TEXT NOT NULL,
            idempotency_key         TEXT NOT NULL,
            request_hash            TEXT NOT NULL,
            normalization_version   INTEGER NOT NULL,
            receipt_json            TEXT NOT NULL,
            draft_id                TEXT,
            recorded_at             TEXT NOT NULL,
            PRIMARY KEY (workspace_id, artifact_id, idempotency_key),
            CHECK (length(request_hash) = 64),
            CHECK (normalization_version >= 1)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS whiteboard_semantic_receipts_by_workspace
        ON whiteboard_semantic_receipts(workspace_id, artifact_id, idempotency_key);
      `);
      requireWhiteboardSemanticReceiptSchema(db);
    },
  },
  {
    version: 18,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_session_authorities (
            workspace_id          TEXT NOT NULL,
            session_id            TEXT NOT NULL,
            principal_kind        TEXT NOT NULL,
            capability_hash       TEXT NOT NULL,
            declared_agent_id     TEXT NOT NULL,
            process_nonce         TEXT NOT NULL,
            runtime_generation    INTEGER NOT NULL,
            daemon_start_nonce    TEXT NOT NULL,
            issued_at             INTEGER NOT NULL,
            revoked_at            INTEGER,
            PRIMARY KEY (workspace_id, session_id),
            CHECK (principal_kind = 'session-capability-holder'),
            CHECK (length(capability_hash) = 64 AND capability_hash NOT GLOB '*[^0-9a-f]*'),
            CHECK (runtime_generation >= 1),
            CHECK (issued_at >= 0),
            CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS runtime_session_authorities_by_capability
        ON runtime_session_authorities(workspace_id, capability_hash);

        CREATE TABLE IF NOT EXISTS runtime_whiteboard_automation_tokens (
            token_hash            TEXT NOT NULL PRIMARY KEY,
            workspace_id          TEXT NOT NULL,
            session_id            TEXT NOT NULL,
            runtime_generation    INTEGER NOT NULL,
            daemon_start_nonce    TEXT NOT NULL,
            artifact_id           TEXT NOT NULL,
            method                TEXT NOT NULL,
            operation_id          TEXT NOT NULL,
            route_set_version     INTEGER NOT NULL,
            request_hash          TEXT NOT NULL,
            issued_at             INTEGER NOT NULL,
            expires_at            INTEGER NOT NULL,
            used_at               INTEGER,
            revoked_at            INTEGER,
            CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
            CHECK (runtime_generation >= 1),
            CHECK (method = 'POST'),
            CHECK (operation_id = 'whiteboard.semantic-scene.apply.v1'),
            CHECK (route_set_version = 1),
            CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
            CHECK (issued_at >= 0),
            CHECK (expires_at > issued_at),
            CHECK (used_at IS NULL OR used_at >= issued_at),
            CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS runtime_whiteboard_tokens_by_session
        ON runtime_whiteboard_automation_tokens(workspace_id, session_id, runtime_generation);
      `);
      requireRuntimeSessionAuthoritySchema(db);
      requireRuntimeWhiteboardAutomationTokenSchema(db);
    },
  },
  {
    version: 19,
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS runtime_native_hook_bindings (
            workspace_id              TEXT NOT NULL,
            client                    TEXT NOT NULL,
            profile_hash              TEXT NOT NULL,
            native_conversation_hash  TEXT NOT NULL,
            binding_secret_hash       TEXT NOT NULL,
            session_id                TEXT NOT NULL,
            agent_id                  TEXT NOT NULL,
            process_nonce             TEXT NOT NULL,
            runtime_generation        INTEGER NOT NULL,
            daemon_start_nonce        TEXT NOT NULL,
            issued_at                 INTEGER NOT NULL,
            revoked_at                INTEGER,
            PRIMARY KEY (workspace_id, client, profile_hash, native_conversation_hash),
            CHECK (client IN ('codex', 'claude-code', 'cursor')),
            CHECK (length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'),
            CHECK (length(native_conversation_hash) = 64 AND native_conversation_hash NOT GLOB '*[^0-9a-f]*'),
            CHECK (length(binding_secret_hash) = 64 AND binding_secret_hash NOT GLOB '*[^0-9a-f]*'),
            CHECK (runtime_generation >= 1),
            CHECK (issued_at >= 0),
            CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
        ) STRICT;

        CREATE INDEX IF NOT EXISTS runtime_native_hook_bindings_by_session
        ON runtime_native_hook_bindings(workspace_id, session_id, runtime_generation);
      `);
      requireRuntimeNativeHookBindingSchema(db);
    },
  },
];

function requireRuntimeNativeHookBindingSchema(db: Database.Database): void {
  requireExactRuntimeTable(db, "runtime_native_hook_bindings", [
    ["workspace_id", "TEXT", 1, 1],
    ["client", "TEXT", 1, 2],
    ["profile_hash", "TEXT", 1, 3],
    ["native_conversation_hash", "TEXT", 1, 4],
    ["binding_secret_hash", "TEXT", 1, 0],
    ["session_id", "TEXT", 1, 0],
    ["agent_id", "TEXT", 1, 0],
    ["process_nonce", "TEXT", 1, 0],
    ["runtime_generation", "INTEGER", 1, 0],
    ["daemon_start_nonce", "TEXT", 1, 0],
    ["issued_at", "INTEGER", 1, 0],
    ["revoked_at", "INTEGER", 0, 0],
  ]);
  const sql = runtimeTableSql(db, "runtime_native_hook_bindings");
  requireRuntimeSql(sql, "runtime_native_hook_bindings", [
    /CHECK\s*\(\s*client\s+IN\s*\(\s*'codex'\s*,\s*'claude-code'\s*,\s*'cursor'\s*\)\s*\)/i,
    /CHECK\s*\(\s*length\s*\(\s*profile_hash\s*\)\s*=\s*64\s+AND\s+profile_hash\s+NOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'\s*\)/i,
    /CHECK\s*\(\s*length\s*\(\s*native_conversation_hash\s*\)\s*=\s*64\s+AND\s+native_conversation_hash\s+NOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'\s*\)/i,
    /CHECK\s*\(\s*length\s*\(\s*binding_secret_hash\s*\)\s*=\s*64\s+AND\s+binding_secret_hash\s+NOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'\s*\)/i,
    /CHECK\s*\(\s*runtime_generation\s*>=\s*1\s*\)/i,
  ]);
  requireRuntimeNativeHookBindingConstraints(db);
}

function requireRuntimeNativeHookBindingConstraints(db: Database.Database): void {
  const randomHex = (bytes: number): string =>
    (db.prepare("SELECT lower(hex(randomblob(?))) AS value").get(bytes) as { value: string }).value;
  const insert = db.prepare(
    `INSERT INTO runtime_native_hook_bindings (
       workspace_id, client, profile_hash, native_conversation_hash,
       binding_secret_hash, session_id, agent_id, process_nonce,
       runtime_generation, daemon_start_nonce, issued_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const row = (overrides: Readonly<Record<number, unknown>> = {}): unknown[] => {
    const values: unknown[] = [
      randomHex(16),
      "codex",
      randomHex(32),
      randomHex(32),
      randomHex(32),
      randomHex(16),
      randomHex(16),
      randomHex(16),
      1,
      randomHex(16),
      10,
      null,
    ];
    for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
    return values;
  };
  db.exec("SAVEPOINT tweakloop_runtime_native_hook_binding_probe");
  try {
    insert.run(...row());
    expectRuntimeConstraint(insert, row({ 1: "other" }), "native hook client");
    expectRuntimeConstraint(insert, row({ 2: randomHex(31) }), "profile hash length");
    expectRuntimeConstraint(insert, row({ 3: "A".repeat(64) }), "conversation lowercase hash");
    expectRuntimeConstraint(insert, row({ 4: randomHex(31) }), "binding secret hash length");
    expectRuntimeConstraint(insert, row({ 8: 0 }), "native hook runtime generation");
    expectRuntimeConstraint(insert, row({ 11: 9 }), "native hook revocation chronology");
  } finally {
    db.exec(
      "ROLLBACK TO tweakloop_runtime_native_hook_binding_probe; RELEASE tweakloop_runtime_native_hook_binding_probe",
    );
  }
}

function requireRuntimeSessionAuthoritySchema(db: Database.Database): void {
  requireExactRuntimeTable(db, "runtime_session_authorities", [
    ["workspace_id", "TEXT", 1, 1],
    ["session_id", "TEXT", 1, 2],
    ["principal_kind", "TEXT", 1, 0],
    ["capability_hash", "TEXT", 1, 0],
    ["declared_agent_id", "TEXT", 1, 0],
    ["process_nonce", "TEXT", 1, 0],
    ["runtime_generation", "INTEGER", 1, 0],
    ["daemon_start_nonce", "TEXT", 1, 0],
    ["issued_at", "INTEGER", 1, 0],
    ["revoked_at", "INTEGER", 0, 0],
  ]);
  const sql = runtimeTableSql(db, "runtime_session_authorities");
  requireRuntimeSql(sql, "runtime_session_authorities", [
    /CHECK\s*\(\s*principal_kind\s*=\s*'session-capability-holder'\s*\)/i,
    /CHECK\s*\(\s*length\s*\(\s*capability_hash\s*\)\s*=\s*64\s+AND\s+capability_hash\s+NOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'\s*\)/i,
    /CHECK\s*\(\s*runtime_generation\s*>=\s*1\s*\)/i,
  ]);
  requireRuntimeSessionAuthorityConstraints(db);
}

function requireRuntimeWhiteboardAutomationTokenSchema(db: Database.Database): void {
  requireExactRuntimeTable(db, "runtime_whiteboard_automation_tokens", [
    ["token_hash", "TEXT", 1, 1],
    ["workspace_id", "TEXT", 1, 0],
    ["session_id", "TEXT", 1, 0],
    ["runtime_generation", "INTEGER", 1, 0],
    ["daemon_start_nonce", "TEXT", 1, 0],
    ["artifact_id", "TEXT", 1, 0],
    ["method", "TEXT", 1, 0],
    ["operation_id", "TEXT", 1, 0],
    ["route_set_version", "INTEGER", 1, 0],
    ["request_hash", "TEXT", 1, 0],
    ["issued_at", "INTEGER", 1, 0],
    ["expires_at", "INTEGER", 1, 0],
    ["used_at", "INTEGER", 0, 0],
    ["revoked_at", "INTEGER", 0, 0],
  ]);
  const sql = runtimeTableSql(db, "runtime_whiteboard_automation_tokens");
  requireRuntimeSql(sql, "runtime_whiteboard_automation_tokens", [
    /CHECK\s*\(\s*length\s*\(\s*token_hash\s*\)\s*=\s*64\s+AND\s+token_hash\s+NOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'\s*\)/i,
    /CHECK\s*\(\s*runtime_generation\s*>=\s*1\s*\)/i,
    /CHECK\s*\(\s*method\s*=\s*'POST'\s*\)/i,
    /CHECK\s*\(\s*operation_id\s*=\s*'whiteboard\.semantic-scene\.apply\.v1'\s*\)/i,
    /CHECK\s*\(\s*route_set_version\s*=\s*1\s*\)/i,
    /CHECK\s*\(\s*length\s*\(\s*request_hash\s*\)\s*=\s*64\s+AND\s+request_hash\s+NOT\s+GLOB\s+'\*\[\^0-9a-f\]\*'\s*\)/i,
    /CHECK\s*\(\s*expires_at\s*>\s*issued_at\s*\)/i,
  ]);
  requireRuntimeWhiteboardTokenConstraints(db);
}

function requireRuntimeSessionAuthorityConstraints(db: Database.Database): void {
  const randomHex = (bytes: number): string =>
    (db.prepare("SELECT lower(hex(randomblob(?))) AS value").get(bytes) as { value: string }).value;
  const insert = db.prepare(
    `INSERT INTO runtime_session_authorities (
       workspace_id, session_id, principal_kind, capability_hash,
       declared_agent_id, process_nonce, runtime_generation,
       daemon_start_nonce, issued_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const row = (overrides: Readonly<Record<number, unknown>> = {}): unknown[] => {
    const values: unknown[] = [
      randomHex(16),
      randomHex(16),
      "session-capability-holder",
      randomHex(32),
      randomHex(16),
      randomHex(16),
      1,
      randomHex(16),
      10,
      null,
    ];
    for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
    return values;
  };
  db.exec("SAVEPOINT tweakloop_runtime_session_authority_probe");
  try {
    insert.run(...row());
    expectRuntimeConstraint(insert, row({ 2: "agent" }), "principal kind");
    expectRuntimeConstraint(insert, row({ 3: randomHex(31) }), "capability hash length");
    expectRuntimeConstraint(insert, row({ 3: "A".repeat(64) }), "lowercase hash");
    expectRuntimeConstraint(insert, row({ 6: 0 }), "runtime generation");
    expectRuntimeConstraint(insert, row({ 9: 9 }), "revocation chronology");
  } finally {
    db.exec(
      "ROLLBACK TO tweakloop_runtime_session_authority_probe; RELEASE tweakloop_runtime_session_authority_probe",
    );
  }
}

function requireRuntimeWhiteboardTokenConstraints(db: Database.Database): void {
  const randomHex = (bytes: number): string =>
    (db.prepare("SELECT lower(hex(randomblob(?))) AS value").get(bytes) as { value: string }).value;
  const insert = db.prepare(
    `INSERT INTO runtime_whiteboard_automation_tokens (
       token_hash, workspace_id, session_id, runtime_generation,
       daemon_start_nonce, artifact_id, method, operation_id,
       route_set_version, request_hash, issued_at, expires_at, used_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const row = (overrides: Readonly<Record<number, unknown>> = {}): unknown[] => {
    const values: unknown[] = [
      randomHex(32),
      randomHex(16),
      randomHex(16),
      1,
      randomHex(16),
      randomHex(16),
      "POST",
      "whiteboard.semantic-scene.apply.v1",
      1,
      randomHex(32),
      10,
      20,
      null,
      null,
    ];
    for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
    return values;
  };
  db.exec("SAVEPOINT tweakloop_runtime_whiteboard_token_probe");
  try {
    insert.run(...row());
    expectRuntimeConstraint(insert, row({ 0: randomHex(31) }), "token hash length");
    expectRuntimeConstraint(insert, row({ 0: "A".repeat(64) }), "lowercase token hash");
    expectRuntimeConstraint(insert, row({ 3: 0 }), "runtime generation");
    expectRuntimeConstraint(insert, row({ 6: "PUT" }), "method binding");
    expectRuntimeConstraint(insert, row({ 7: "whiteboard.future.v2" }), "operation binding");
    expectRuntimeConstraint(insert, row({ 8: 2 }), "route-set binding");
    expectRuntimeConstraint(insert, row({ 9: randomHex(31) }), "request hash length");
    expectRuntimeConstraint(insert, row({ 11: 10 }), "expiry chronology");
  } finally {
    db.exec(
      "ROLLBACK TO tweakloop_runtime_whiteboard_token_probe; RELEASE tweakloop_runtime_whiteboard_token_probe",
    );
  }
}

function expectRuntimeConstraint(
  insert: Database.Statement,
  values: readonly unknown[],
  contract: string,
): void {
  try {
    insert.run(...values);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String(error.code) === "SQLITE_CONSTRAINT_CHECK"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`migration incompatible runtime authority schema; ${contract} is not enforced`);
}

function requireExactRuntimeTable(
  db: Database.Database,
  table: string,
  expected: readonly (readonly [string, string, number, number])[],
): void {
  const actual = db.prepare(`PRAGMA table_info(${table})`).all() as readonly Readonly<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>[];
  if (actual.length !== expected.length) {
    throw new Error(
      `migration incompatible schema ${table}.columns; expected ${expected.length}, found ${actual.length}`,
    );
  }
  for (const [index, wanted] of expected.entries()) {
    const column = actual[index];
    if (
      !column ||
      column.cid !== index ||
      column.name !== wanted[0] ||
      column.type.toUpperCase() !== wanted[1] ||
      column.notnull !== wanted[2] ||
      column.dflt_value !== null ||
      column.pk !== wanted[3]
    ) {
      throw new Error(`migration incompatible schema ${table}.${wanted[0]}`);
    }
  }
}

function runtimeTableSql(db: Database.Database, table: string): string {
  const definition = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  return stripSqlComments(definition?.sql ?? "");
}

function requireRuntimeSql(sql: string, table: string, checks: readonly RegExp[]): void {
  if (!/\)\s*STRICT\s*;?\s*$/i.test(sql)) {
    throw new Error(`migration incompatible schema ${table}; expected STRICT table`);
  }
  for (const check of checks) {
    if (!check.test(sql)) {
      throw new Error(`migration incompatible schema ${table}; required CHECK is missing`);
    }
  }
}

function addMissingColumns(
  db: Database.Database,
  table: string,
  definitions: Readonly<Record<string, string>>,
): void {
  const existing = new Map(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as readonly Readonly<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
      }>[]
    ).map((column) => [column.name, column]),
  );
  for (const [name, definition] of Object.entries(definitions)) {
    const column = existing.get(name);
    if (!column) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
      continue;
    }
    const expectedType = definition.split(" ")[0] ?? "";
    const expectedNotNull = definition.includes("NOT NULL") ? 1 : 0;
    const expectedDefault = definition.includes("DEFAULT 0") ? "0" : null;
    if (
      column.type.toUpperCase() !== expectedType ||
      column.notnull !== expectedNotNull ||
      column.dflt_value !== expectedDefault
    ) {
      throw new Error(
        `migration incompatible column ${table}.${name}; expected ${definition}, found ${column.type}`,
      );
    }
  }
}

function requireWhiteboardSemanticReceiptSchema(db: Database.Database): void {
  const table = "whiteboard_semantic_receipts";
  const expected = [
    { name: "workspace_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "artifact_id", type: "TEXT", notnull: 1, pk: 2 },
    { name: "idempotency_key", type: "TEXT", notnull: 1, pk: 3 },
    { name: "request_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "normalization_version", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "receipt_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "draft_id", type: "TEXT", notnull: 0, pk: 0 },
    { name: "recorded_at", type: "TEXT", notnull: 1, pk: 0 },
  ] as const;
  const actual = db.prepare(`PRAGMA table_info(${table})`).all() as readonly Readonly<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>[];
  if (actual.length !== expected.length) {
    throw new Error(
      `migration incompatible schema ${table}.columns; expected ${expected.length}, found ${actual.length}`,
    );
  }
  for (const [index, wanted] of expected.entries()) {
    const column = actual[index];
    if (
      !column ||
      column.cid !== index ||
      column.name !== wanted.name ||
      column.type.toUpperCase() !== wanted.type ||
      column.notnull !== wanted.notnull ||
      column.dflt_value !== null ||
      column.pk !== wanted.pk
    ) {
      throw new Error(
        `migration incompatible schema ${table}.${wanted.name}; expected ${wanted.type} notnull=${wanted.notnull} pk=${wanted.pk}`,
      );
    }
  }
  const definition = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  const sql = stripSqlComments(definition?.sql ?? "");
  if (!/\)\s*STRICT\s*;?\s*$/i.test(sql)) {
    throw new Error(`migration incompatible schema ${table}; expected STRICT table`);
  }
  if (!/CHECK\s*\(\s*length\s*\(\s*request_hash\s*\)\s*=\s*64\s*\)/i.test(sql)) {
    throw new Error(
      `migration incompatible schema ${table}.request_hash; missing length = 64 CHECK`,
    );
  }
  if (!/CHECK\s*\(\s*normalization_version\s*>=\s*1\s*\)/i.test(sql)) {
    throw new Error(
      `migration incompatible schema ${table}.normalization_version; missing >= 1 CHECK`,
    );
  }
}

function requireRuntimeChatDeliveriesSchema(db: Database.Database): void {
  const table = "runtime_chat_deliveries";
  const expected = [
    { name: "attempt_id", type: "TEXT", notnull: 1, pk: 1 },
    { name: "message_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "workspace_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "session_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "recipient_agent_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "process_nonce", type: "TEXT", notnull: 1, pk: 0 },
    { name: "attempt_number", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "capability_hash", type: "TEXT", notnull: 1, pk: 0 },
    { name: "offered_at", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "expires_at", type: "INTEGER", notnull: 1, pk: 0 },
  ] as const;
  const actual = db.prepare(`PRAGMA table_info(${table})`).all() as readonly Readonly<{
    cid: number;
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>[];
  if (actual.length !== expected.length) {
    throw new Error(
      `migration incompatible schema ${table}.columns; expected ${expected.length}, found ${actual.length}`,
    );
  }
  for (const [index, wanted] of expected.entries()) {
    const column = actual[index];
    if (
      column === undefined ||
      column.cid !== index ||
      column.name !== wanted.name ||
      column.type.toUpperCase() !== wanted.type ||
      column.notnull !== wanted.notnull ||
      column.dflt_value !== null ||
      column.pk !== wanted.pk
    ) {
      throw new Error(
        `migration incompatible schema ${table}.${wanted.name}; expected ${wanted.type} NOT NULL pk=${wanted.pk}`,
      );
    }
  }

  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as readonly Readonly<{
    name: string;
    unique: number;
    partial: number;
  }>[];
  const uniqueMessageId = indexes.some((index) => {
    if (index.unique !== 1 || index.partial !== 0) return false;
    const columns = db
      .prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`)
      .all() as readonly {
      name: string;
    }[];
    return columns.length === 1 && columns[0]?.name === "message_id";
  });
  if (!uniqueMessageId) {
    throw new Error(
      `migration incompatible schema ${table}.message_id; expected a single-column UNIQUE constraint`,
    );
  }

  const definition = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  const sql = stripSqlComments(definition?.sql ?? "");
  if (!/\)\s*STRICT\s*;?\s*$/i.test(sql)) {
    throw new Error(`migration incompatible schema ${table}; expected STRICT table`);
  }
  if (!/CHECK\s*\(\s*attempt_number\s*>=\s*1\s*\)/i.test(sql)) {
    throw new Error(
      `migration incompatible schema ${table}.attempt_number; missing CHECK attempt_number >= 1`,
    );
  }
  if (!/CHECK\s*\(\s*length\s*\(\s*capability_hash\s*\)\s*=\s*64\s*\)/i.test(sql)) {
    throw new Error(
      `migration incompatible schema ${table}.capability_hash; missing CHECK length = 64`,
    );
  }
  requireRuntimeChatDeliveryConstraints(db);
}

function requireRuntimeLeaseRequestCapabilitySchema(db: Database.Database): void {
  const table = "runtime_leases";
  const column = (
    db.prepare(`PRAGMA table_info(${table})`).all() as readonly Readonly<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
    }>[]
  ).find((candidate) => candidate.name === "request_capability_hash");
  if (
    column === undefined ||
    column.type.toUpperCase() !== "TEXT" ||
    column.notnull !== 0 ||
    column.dflt_value !== null
  ) {
    throw new Error(
      `migration incompatible schema ${table}.request_capability_hash; expected nullable TEXT`,
    );
  }
  const definition = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  const sql = stripSqlComments(definition?.sql ?? "");
  if (
    !/CHECK\s*\(\s*request_capability_hash\s+IS\s+NULL\s+OR\s+length\s*\(\s*request_capability_hash\s*\)\s*=\s*64\s*\)/i.test(
      sql,
    )
  ) {
    throw new Error(
      `migration incompatible schema ${table}.request_capability_hash; missing nullable 64-character CHECK`,
    );
  }

  const randomHex = (bytes: number): string =>
    (db.prepare("SELECT lower(hex(randomblob(?))) AS value").get(bytes) as { value: string }).value;
  db.exec("SAVEPOINT tweakloop_runtime_lease_capability_probe");
  try {
    const insert = db.prepare(
      `INSERT INTO runtime_leases (
         work_id, claim_id, agent_id, process_nonce, request_capability_hash,
         expires_at, last_heartbeat
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(randomHex(16), randomHex(16), randomHex(16), randomHex(16), null, 2, 1);
    try {
      insert.run(randomHex(16), randomHex(16), randomHex(16), randomHex(16), randomHex(31), 2, 1);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        String(error.code) === "SQLITE_CONSTRAINT_CHECK"
      ) {
        return;
      }
      throw error;
    }
    throw new Error(
      `migration incompatible schema ${table}.request_capability_hash; CHECK is not enforced`,
    );
  } finally {
    db.exec(
      "ROLLBACK TO tweakloop_runtime_lease_capability_probe; RELEASE tweakloop_runtime_lease_capability_probe",
    );
  }
}

function requireRuntimeChatDeliveryConstraints(db: Database.Database): void {
  const randomHex = (bytes: number): string =>
    (db.prepare("SELECT lower(hex(randomblob(?))) AS value").get(bytes) as { value: string }).value;
  const row = (overrides: Readonly<Record<number, unknown>> = {}): unknown[] => {
    const values: unknown[] = [
      randomHex(16),
      randomHex(16),
      randomHex(16),
      randomHex(16),
      randomHex(16),
      randomHex(16),
      1,
      randomHex(32),
      1,
      2,
    ];
    for (const [index, value] of Object.entries(overrides)) values[Number(index)] = value;
    return values;
  };
  db.exec("SAVEPOINT tweakloop_runtime_chat_schema_probe");
  try {
    const insert = db.prepare(
      `INSERT INTO runtime_chat_deliveries (
         attempt_id, message_id, workspace_id, session_id, recipient_agent_id,
         process_nonce, attempt_number, capability_hash, offered_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const valid = row();
    insert.run(...valid);
    expectConstraint(insert, row({ 1: valid[1] }), "message_id UNIQUE", "SQLITE_CONSTRAINT_UNIQUE");
    expectConstraint(
      insert,
      row({ 6: 0 }),
      "attempt_number CHECK at zero",
      "SQLITE_CONSTRAINT_CHECK",
    );
    expectConstraint(
      insert,
      row({ 6: -1 }),
      "attempt_number CHECK below zero",
      "SQLITE_CONSTRAINT_CHECK",
    );
    expectConstraint(
      insert,
      row({ 7: randomHex(31) }),
      "capability_hash CHECK at 62 characters",
      "SQLITE_CONSTRAINT_CHECK",
    );
    expectConstraint(
      insert,
      row({ 7: randomHex(33) }),
      "capability_hash CHECK at 66 characters",
      "SQLITE_CONSTRAINT_CHECK",
    );
  } finally {
    db.exec(
      "ROLLBACK TO tweakloop_runtime_chat_schema_probe; RELEASE tweakloop_runtime_chat_schema_probe",
    );
  }
}

function expectConstraint(
  insert: Database.Statement,
  values: readonly unknown[],
  contract: string,
  expectedCode: string,
): void {
  try {
    insert.run(...values);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String(error.code) === expectedCode
    ) {
      return;
    }
    throw error;
  }
  throw new Error(
    `migration incompatible schema runtime_chat_deliveries; ${contract} is not enforced`,
  );
}

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\r\n]*/g, " ");
}

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
