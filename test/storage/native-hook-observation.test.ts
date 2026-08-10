import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NATIVE_HOOK_BIND_REQUEST_PROTOCOL,
  NATIVE_HOOK_OBSERVATION_PROTOCOL,
  NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL,
} from "../../src/protocol/native-hook-observation.js";
import type { Db } from "../../src/storage/sqlite/db.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import {
  NativeHookObservationError,
  NativeHookObservationStore,
} from "../../src/storage/sqlite/native-hook-observation.js";

const WORKSPACE = "workspace-native-hook";
const DAEMON = "daemon-native-hook";
const NOW = 1_900_000_000_000;
const RUNTIME_CAPABILITY = "runtime-capability-for-native-hook-focused-test";

describe("native hook observation store", () => {
  it("binds one exact native conversation and observes only its oldest eligible chat without product mutation", () => {
    const db = openDatabase(":memory:");
    try {
      installSession(db, "session-a", "codex", "process-a", DAEMON, 1);
      installSession(db, "session-b", "codex", "process-b", DAEMON, 1);
      insertChat(db, { messageId: "neighbor", sessionId: "session-b", createdSeq: 1 });
      insertChat(db, {
        messageId: "self-authored",
        sessionId: "session-a",
        createdSeq: 2,
        author: "agent:codex",
      });
      insertChat(db, {
        messageId: "work-linked",
        sessionId: "session-a",
        createdSeq: 3,
        workId: "work-neighbor",
      });
      insertChat(db, {
        messageId: "wrong-recipient",
        sessionId: "session-a",
        createdSeq: 4,
        recipientAgentId: "claude",
      });
      insertChat(db, {
        messageId: "already-offered",
        sessionId: "session-a",
        createdSeq: 5,
        deliveryStatus: "offered",
      });
      insertChat(db, { messageId: "exact-direct", sessionId: "session-a", createdSeq: 6 });
      insertChat(db, {
        messageId: "exact-broadcast",
        sessionId: "session-a",
        createdSeq: 7,
        recipientAgentId: null,
      });

      const store = service(db);
      expect(store.bind(bindRequest())).toEqual({
        protocol: "tweakloop.native-hook-binding/v1",
        kind: "bound",
        sessionId: "session-a",
        client: "codex",
        unchanged: false,
      });
      expect(store.bind(bindRequest())).toMatchObject({ unchanged: true });

      const before = mutationSurface(db);
      expect(store.observe(observeRequest())).toEqual({
        protocol: NATIVE_HOOK_OBSERVATION_PROTOCOL,
        kind: "continue",
        sessionId: "session-a",
        messageId: "exact-direct",
      });
      expect(store.observe(observeRequest())).toMatchObject({ messageId: "exact-direct" });
      expect(mutationSurface(db)).toEqual(before);

      db.prepare(
        "UPDATE p_chat SET delivery_status = 'offered' WHERE message_id = 'exact-direct'",
      ).run();
      expect(store.observe(observeRequest())).toMatchObject({ messageId: "exact-broadcast" });
      db.prepare(
        "UPDATE p_chat SET delivery_status = 'offered' WHERE message_id = 'exact-broadcast'",
      ).run();
      expect(store.observe(observeRequest())).toEqual({
        protocol: NATIVE_HOOK_OBSERVATION_PROTOCOL,
        kind: "none",
      });
    } finally {
      db.close();
    }
  });

  it("rejects wrong native/profile/secret neighbors and preserves the first current binding", () => {
    const db = openDatabase(":memory:");
    try {
      installSession(db, "session-a", "codex", "process-a", DAEMON, 1);
      installSession(db, "session-b", "codex", "process-b", DAEMON, 1);
      const store = service(db);
      store.bind(bindRequest());
      const original = bindingRows(db);

      for (const changed of [
        { profileId: "profile-neighbor" },
        { nativeConversationId: "conversation-neighbor" },
        { bindingSecret: "wrong-binding-secret-that-is-long-enough" },
      ]) {
        expect(() => store.observe({ ...observeRequest(), ...changed })).toThrow(
          NativeHookObservationError,
        );
        expect(bindingRows(db)).toEqual(original);
      }

      expect(() =>
        store.bind({
          ...bindRequest(),
          sessionId: "session-b",
          runtimeCapability: RUNTIME_CAPABILITY,
        }),
      ).toThrow(/already bound to different authority/);
      expect(bindingRows(db)).toEqual(original);
    } finally {
      db.close();
    }
  });

  it("fails closed after daemon rotation and permits an exact successor rebind only after authority rotates", () => {
    const db = openDatabase(":memory:");
    try {
      installSession(db, "session-a", "codex", "process-a", DAEMON, 1);
      const first = service(db);
      first.bind(bindRequest());

      const nextDaemon = "daemon-native-hook-successor";
      db.prepare(
        `UPDATE runtime_session_authorities
         SET daemon_start_nonce = ?, runtime_generation = 2
         WHERE workspace_id = ? AND session_id = 'session-a'`,
      ).run(nextDaemon, WORKSPACE);
      const successor = service(db, nextDaemon);
      expect(() => successor.observe(observeRequest())).toThrow(/stale daemon generation/);
      expect(
        successor.bind({
          ...bindRequest(),
          bindingSecret: "successor-binding-secret-that-is-long-enough",
        }),
      ).toMatchObject({ unchanged: false });
      expect(() => successor.observe(observeRequest())).toThrow(/binding is invalid/);
      expect(
        successor.observe({
          ...observeRequest(),
          bindingSecret: "successor-binding-secret-that-is-long-enough",
        }),
      ).toEqual({ protocol: NATIVE_HOOK_OBSERVATION_PROTOCOL, kind: "none" });
    } finally {
      db.close();
    }
  });

  it("stores only binding/runtime hashes and enforces the strict migration contract", () => {
    const db = openDatabase(":memory:");
    try {
      installSession(db, "session-a", "codex", "process-a", DAEMON, 1);
      service(db).bind(bindRequest());
      const sql = (
        db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get("runtime_native_hook_bindings") as { sql: string }
      ).sql;
      expect(sql).toContain("STRICT");
      expect(db.pragma("user_version", { simple: true })).toBe(19);
      expect(databaseContainsText(db, "binding-secret-that-is-long-enough")).toBe(false);
      expect(databaseContainsText(db, RUNTIME_CAPABILITY)).toBe(false);
      expect(databaseContainsText(db, "conversation-a")).toBe(false);
      expect(databaseContainsText(db, "profile-a")).toBe(false);
      expect(() =>
        db
          .prepare(
            `INSERT INTO runtime_native_hook_bindings (
             workspace_id, client, profile_hash, native_conversation_hash,
             binding_secret_hash, session_id, agent_id, process_nonce,
             runtime_generation, daemon_start_nonce, issued_at, revoked_at
           ) VALUES ('bad', 'other', ?, ?, ?, 's', 'a', 'p', 0, 'd', 10, 9)`,
          )
          .run("a".repeat(64), "b".repeat(64), "c".repeat(64)),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

function service(db: Db, daemonStartNonce = DAEMON): NativeHookObservationStore {
  return new NativeHookObservationStore(db, {
    workspaceId: WORKSPACE,
    daemonStartNonce,
    now: () => NOW,
  });
}

function bindRequest() {
  return {
    protocol: NATIVE_HOOK_BIND_REQUEST_PROTOCOL,
    sessionId: "session-a",
    runtimeCapability: RUNTIME_CAPABILITY,
    client: "codex",
    profileId: "profile-a",
    nativeConversationId: "conversation-a",
    bindingSecret: "binding-secret-that-is-long-enough",
  } as const;
}

function observeRequest() {
  return {
    protocol: NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL,
    client: "codex",
    profileId: "profile-a",
    nativeConversationId: "conversation-a",
    bindingSecret: "binding-secret-that-is-long-enough",
  } as const;
}

function installSession(
  db: Db,
  sessionId: string,
  agentId: string,
  processNonce: string,
  daemonStartNonce: string,
  runtimeGeneration: number,
): void {
  db.prepare(
    `INSERT INTO p_sessions (
       session_id, artifact_id, originating_agent_id, agent_id, process_nonce,
       status, base_revision_id, title, goal, predecessor_session_id,
       handoff_to_agent_id, handoff_summary, summary, created_at, last_active_at,
       ended_at, created_seq, last_seq
     ) VALUES (?, NULL, ?, ?, ?, 'active', NULL, 'Native hook', 'Exact observation',
       NULL, NULL, NULL, NULL, ?, ?, NULL, 1, 1)`,
  ).run(
    sessionId,
    agentId,
    agentId,
    processNonce,
    new Date(NOW).toISOString(),
    new Date(NOW).toISOString(),
  );
  db.prepare(
    `INSERT INTO runtime_session_authorities (
       workspace_id, session_id, principal_kind, capability_hash,
       declared_agent_id, process_nonce, runtime_generation,
       daemon_start_nonce, issued_at, revoked_at
     ) VALUES (?, ?, 'session-capability-holder', ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    WORKSPACE,
    sessionId,
    sha256(RUNTIME_CAPABILITY),
    agentId,
    processNonce,
    runtimeGeneration,
    daemonStartNonce,
    NOW - 1,
  );
}

function insertChat(
  db: Db,
  input: Readonly<{
    messageId: string;
    sessionId: string;
    createdSeq: number;
    author?: string;
    recipientAgentId?: string | null;
    workId?: string;
    intentId?: string;
    deliveryStatus?: string;
  }>,
): void {
  db.prepare(
    `INSERT INTO p_chat (
       message_id, author, text, mentions_json, references_json, attachments_json,
       recorded_at, created_seq, session_id, recipient_agent_id, work_id, intent_id,
       delivery_status, inbound_candidate
     ) VALUES (?, ?, 'message', '[]', '[]', '[]', ?, ?, ?, ?, ?, ?, ?, 1)`,
  ).run(
    input.messageId,
    input.author ?? "human:browser",
    new Date(NOW).toISOString(),
    input.createdSeq,
    input.sessionId,
    input.recipientAgentId === undefined ? "codex" : input.recipientAgentId,
    input.workId ?? null,
    input.intentId ?? null,
    input.deliveryStatus ?? null,
  );
}

function mutationSurface(db: Db): string {
  const tables = (
    db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table'
           AND (name LIKE 'p\\_%' ESCAPE '\\' OR name IN (
             'events', 'command_receipts', 'runtime_chat_deliveries',
             'runtime_leases', 'runtime_native_hook_bindings'
           ))
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  return JSON.stringify(
    tables.map((table) => ({ table, rows: db.prepare(`SELECT * FROM ${table}`).all() })),
  );
}

function bindingRows(db: Db): unknown[] {
  return db
    .prepare(
      `SELECT * FROM runtime_native_hook_bindings
       ORDER BY workspace_id, client, profile_hash, native_conversation_hash`,
    )
    .all();
}

function databaseContainsText(db: Db, needle: string): boolean {
  return JSON.stringify(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
        name: string;
      }>
    ).flatMap(({ name }) => db.prepare(`SELECT * FROM ${name}`).all()),
  ).includes(needle);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
