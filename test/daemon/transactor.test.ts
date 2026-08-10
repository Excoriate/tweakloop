import { describe, expect, it } from "vitest";
import { rebuildProjections } from "../../src/daemon/projections.js";
import { createTransactor } from "../../src/daemon/transactor.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";

const WS = "ws_test";

function setup() {
  const db = openDatabase(":memory:");
  const published: EventEnvelope[] = [];
  let eventCounter = 0;
  const transactor = createTransactor({
    db,
    workspaceId: WS,
    newEventId: () => `evt_${++eventCounter}`,
    now: () => "2026-08-03T00:00:00.000Z",
    onCommitted: (envelopes) => published.push(...envelopes),
  });
  return { db, transactor, published };
}

function registerEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "tweakloop.command/v1",
    commandId: "cmd-1",
    idempotencyKey: "key-1",
    workspaceId: WS,
    actor: { kind: "human", id: "alex" },
    type: "artifact.register",
    payload: {
      artifactId: "artifact_1",
      name: "plan.html",
      format: "html",
      sourcePath: "/repo/plan.html",
    },
    ...overrides,
  };
}

describe("transactor", () => {
  it("commits events, projections, and receipts atomically", () => {
    const { db, transactor, published } = setup();
    const result = transactor.execute(registerEnvelope());
    expect(result).toMatchObject({
      status: "accepted",
      firstEventSeq: 1,
      lastEventSeq: 1,
      response: { artifactId: "artifact_1" },
    });

    const artifactRows = db.prepare("SELECT * FROM p_artifacts").all();
    expect(artifactRows).toHaveLength(1);
    const timelineRows = db.prepare("SELECT * FROM p_timeline").all();
    expect(timelineRows).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.eventType).toBe("artifact.registered");
  });

  it("returns the original receipt for a retried idempotency key", () => {
    const { db, transactor } = setup();
    const first = transactor.execute(registerEnvelope());
    const retry = transactor.execute(registerEnvelope({ commandId: "cmd-2" }));
    expect(retry).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("rejects reuse of an idempotency key for a different normalized command", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    const conflict = transactor.execute(
      registerEnvelope({
        commandId: "cmd-conflict",
        payload: {
          artifactId: "artifact_2",
          name: "other.html",
          format: "html",
          sourcePath: "/repo/other.html",
        },
      }),
    );
    expect(conflict).toMatchObject({ status: "rejected", code: "idempotency-key-conflict" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("rejects domain violations without durable effects", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    const duplicate = transactor.execute(
      registerEnvelope({ commandId: "cmd-3", idempotencyKey: "key-3" }),
    );
    expect(duplicate).toMatchObject({ status: "rejected", code: "artifact.already-registered" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("rejects stale expected stream versions", () => {
    const { transactor } = setup();
    transactor.execute(registerEnvelope());
    const stale = transactor.execute(
      registerEnvelope({
        commandId: "cmd-4",
        idempotencyKey: "key-4",
        expected: { streamId: "artifact_1", streamVersion: 0 },
        payload: {
          artifactId: "artifact_2",
          name: "plan2.html",
          format: "html",
          sourcePath: "/repo/plan2.html",
        },
      }),
    );
    expect(stale).toMatchObject({ status: "rejected", code: "concurrency.version-conflict" });
  });

  it("rejects malformed and unknown commands at the protocol boundary", () => {
    const { transactor } = setup();
    expect(transactor.execute({ nonsense: true })).toMatchObject({
      status: "rejected",
      code: "protocol.invalid-envelope",
    });
    expect(transactor.execute(registerEnvelope({ type: "artifact.explode" }))).toMatchObject({
      status: "rejected",
      code: "protocol.unknown-command",
    });
  });

  it("rebuilds projections identically from the event log", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    transactor.execute(
      registerEnvelope({
        commandId: "cmd-5",
        idempotencyKey: "key-5",
        payload: {
          artifactId: "artifact_2",
          name: "notes.md",
          format: "markdown",
          sourcePath: "/repo/notes.md",
        },
      }),
    );

    const before = {
      artifacts: db.prepare("SELECT * FROM p_artifacts ORDER BY artifact_id").all(),
      timeline: db.prepare("SELECT * FROM p_timeline ORDER BY seq").all(),
    };
    rebuildProjections(db, WS);
    const after = {
      artifacts: db.prepare("SELECT * FROM p_artifacts ORDER BY artifact_id").all(),
      timeline: db.prepare("SELECT * FROM p_timeline ORDER BY seq").all(),
    };
    expect(after).toEqual(before);
  });

  it("rejects chat descriptors whose bytes are absent without writing an event or receipt", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    const hash = "a".repeat(64);
    const rejected = transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-chat-missing",
      idempotencyKey: "key-chat-missing",
      type: "chat.send",
      payload: {
        messageId: "message_missing",
        text: "see attachment",
        attachments: [{ hash, fileName: "missing.txt", mediaType: "text/plain", byteLength: 7 }],
      },
    });
    expect(rejected).toMatchObject({ status: "rejected", code: "attachment.unknown" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM command_receipts").get()).toEqual({ n: 1 });
  });

  it("preserves typed chat references and attachments across projection rebuild", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-session-durable",
      idempotencyKey: "key-session-durable",
      actor: { kind: "agent", id: "agent:codex" },
      type: "session.start",
      payload: {
        sessionId: "session_1",
        artifactId: null,
        agentId: "agent:codex",
        processNonce: "process_1",
        baseRevisionId: null,
        title: "Durable chat",
        goal: "Preserve references",
      },
    });
    const hash = "b".repeat(64);
    db.prepare(
      "INSERT INTO blobs (hash, byte_length, media_type, created_at) VALUES (?, ?, ?, ?)",
    ).run(hash, 7, "text/plain", "2026-08-03T00:00:00.000Z");

    const result = transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-chat-durable",
      idempotencyKey: "key-chat-durable",
      type: "chat.send",
      payload: {
        messageId: "message_durable",
        artifactId: "artifact_1",
        text: "",
        sessionId: "session_1",
        references: [
          { kind: "document", label: "Plan", artifactId: "artifact_1" },
          { kind: "file", label: "notes.txt", hash },
        ],
        attachments: [{ hash, fileName: "notes.txt", mediaType: "text/plain", byteLength: 7 }],
      },
    });
    expect(result).toMatchObject({ status: "accepted" });

    const before = db.prepare("SELECT * FROM p_chat WHERE message_id = ?").get("message_durable");
    rebuildProjections(db, WS);
    const after = db.prepare("SELECT * FROM p_chat WHERE message_id = ?").get("message_durable");
    expect(after).toEqual(before);
    expect(JSON.parse((after as { references_json: string }).references_json)).toEqual([
      { kind: "document", label: "Plan", artifactId: "artifact_1" },
      { kind: "file", label: "notes.txt", hash },
    ]);
    expect(JSON.parse((after as { attachments_json: string }).attachments_json)).toEqual([
      { hash, fileName: "notes.txt", mediaType: "text/plain", byteLength: 7 },
    ]);
  });

  it("atomically links an explicit chat promotion while ordinary chat remains task-free", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-publish",
      idempotencyKey: "key-publish",
      type: "artifact.publish",
      payload: {
        artifactId: "artifact_1",
        revisionId: "revision_1",
        format: "html",
        entryPath: "plan.html",
        entryHash: "hash-1",
        files: [{ path: "plan.html", hash: "hash-1", mediaType: "text/html" }],
        producer: { kind: "agent", id: "agent:codex" },
        sourcePath: "/repo/plan.html",
      },
    });
    transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-session-promote",
      idempotencyKey: "key-session-promote",
      actor: { kind: "agent", id: "agent:codex" },
      type: "session.start",
      payload: {
        sessionId: "session_1",
        artifactId: "artifact_1",
        agentId: "agent:codex",
        processNonce: "process_1",
        baseRevisionId: "revision_1",
        title: "Promote chat",
        goal: "Track explicit work",
      },
    });
    transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-chat-promote",
      idempotencyKey: "key-chat-promote",
      type: "chat.send",
      payload: {
        messageId: "message_promote",
        artifactId: "artifact_1",
        text: "Make rollback a measurable decision gate.",
        context: { revisionId: "revision_1", semanticId: "poc.rollback" },
        sessionId: "session_1",
        recipientAgentId: "agent:codex",
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_intents").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_work").get()).toEqual({ n: 0 });

    const promotion = {
      ...registerEnvelope(),
      commandId: "cmd-promote",
      idempotencyKey: "chat.promote:message_promote",
      type: "review.submit-batch",
      payload: {
        batchId: "batch_promote",
        workId: "work_promote",
        artifactId: "artifact_1",
        revisionId: "revision_1",
        sourceMessageId: "message_promote",
        assigneeAgentId: "agent:codex",
        sessionId: "session_1",
        intents: [
          {
            intentId: "intent_promote",
            intentType: "comment",
            target: { semanticId: "poc.rollback" },
            body: {
              text: "Make rollback a measurable decision gate.",
              sourceMessageId: "message_promote",
            },
          },
        ],
      },
    };
    const result = transactor.execute(promotion);
    expect(result).toMatchObject({
      status: "accepted",
      response: {
        batchId: "batch_promote",
        workId: "work_promote",
        intentIds: ["intent_promote"],
      },
    });
    expect(
      db
        .prepare("SELECT work_id, intent_id FROM p_chat WHERE message_id = ?")
        .get("message_promote"),
    ).toEqual({ work_id: "work_promote", intent_id: "intent_promote" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_intents").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_work").get()).toEqual({ n: 1 });

    const retry = transactor.execute({
      ...promotion,
      commandId: "cmd-promote-retry",
    });
    expect(retry).toEqual(result);

    const conflict = transactor.execute({
      ...promotion,
      commandId: "cmd-promote-conflict",
      payload: { ...promotion.payload, workId: "work_would_duplicate" },
    });
    expect(conflict).toMatchObject({ status: "rejected", code: "idempotency-key-conflict" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_work").get()).toEqual({ n: 1 });

    rebuildProjections(db, WS);
    expect(
      db
        .prepare("SELECT work_id, intent_id FROM p_chat WHERE message_id = ?")
        .get("message_promote"),
    ).toEqual({ work_id: "work_promote", intent_id: "intent_promote" });
  });

  it("rejects a mutated chat promotion without any partial intent, work, or linkage", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-publish-reject",
      idempotencyKey: "key-publish-reject",
      type: "artifact.publish",
      payload: {
        artifactId: "artifact_1",
        revisionId: "revision_1",
        format: "html",
        entryPath: "plan.html",
        entryHash: "hash-1",
        files: [{ path: "plan.html", hash: "hash-1", mediaType: "text/html" }],
        producer: { kind: "agent", id: "agent:codex" },
        sourcePath: "/repo/plan.html",
      },
    });
    transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-chat-reject",
      idempotencyKey: "key-chat-reject",
      type: "chat.send",
      payload: {
        messageId: "message_reject",
        artifactId: "artifact_1",
        text: "Preserve this exact instruction.",
      },
    });
    const rejected = transactor.execute({
      ...registerEnvelope(),
      commandId: "cmd-promote-reject",
      idempotencyKey: "chat.promote:message_reject",
      type: "review.submit-batch",
      payload: {
        batchId: "batch_reject",
        workId: "work_reject",
        artifactId: "artifact_1",
        revisionId: "revision_1",
        sourceMessageId: "message_reject",
        intents: [
          {
            intentId: "intent_reject",
            intentType: "comment",
            target: {},
            body: { text: "Changed instruction.", sourceMessageId: "message_reject" },
          },
        ],
      },
    });
    expect(rejected).toMatchObject({ status: "rejected", code: "chat.message-content-mismatch" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_intents").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM p_work").get()).toEqual({ n: 0 });
    expect(
      db
        .prepare("SELECT work_id, intent_id FROM p_chat WHERE message_id = ?")
        .get("message_reject"),
    ).toEqual({ work_id: null, intent_id: null });
  });
});
