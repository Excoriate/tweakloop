import { describe, expect, it } from "vitest";
import {
  createInboundService,
  InboundError,
  type InboundService,
} from "../../src/daemon/inbound-next.js";
import { rebuildProjections, snapshot } from "../../src/daemon/projections.js";
import { createTransactor, type Transactor } from "../../src/daemon/transactor.js";
import type { ChatDelivery } from "../../src/protocol/chat-delivery.js";
import type { ActorRef, CommandResult } from "../../src/protocol/envelopes.js";
import { type Db, openDatabase } from "../../src/storage/sqlite/db.js";

const WORKSPACE_ID = "ws_inbound";
const IDENTITY = { sessionId: "session_1", agentId: "codex", processNonce: "process_1" };

type Fixture = Readonly<{
  db: Db;
  transactor: Transactor;
  service: () => InboundService;
  execute: (type: string, payload: unknown, actor?: ActorRef) => CommandResult;
  setNow: (value: number) => void;
  now: () => number;
}>;

function fixture(): Fixture {
  const db = openDatabase(":memory:");
  let commandNumber = 0;
  let eventNumber = 0;
  let generatedNumber = 0;
  let currentNow = 1_000;
  const transactor = createTransactor({
    db,
    workspaceId: WORKSPACE_ID,
    newEventId: () => `event_${++eventNumber}`,
    now: () => new Date(currentNow).toISOString(),
    onCommitted: () => {},
  });
  const execute = (
    type: string,
    payload: unknown,
    actor: ActorRef = { kind: "human", id: "alex" },
  ) =>
    transactor.execute({
      protocol: "tweakloop.command/v1",
      commandId: `command_${++commandNumber}`,
      idempotencyKey: `key_${commandNumber}`,
      workspaceId: WORKSPACE_ID,
      actor,
      type,
      payload,
    });
  expect(
    execute(
      "session.start",
      {
        sessionId: IDENTITY.sessionId,
        artifactId: null,
        agentId: IDENTITY.agentId,
        processNonce: IDENTITY.processNonce,
        title: "M1",
        goal: "deliver chat",
      },
      { kind: "agent", id: IDENTITY.agentId },
    ),
  ).toMatchObject({ status: "accepted" });
  const service = () =>
    createInboundService({
      db,
      workspaceId: WORKSPACE_ID,
      transactor,
      now: () => currentNow,
      newId: () => `${++generatedNumber}`,
      newCapability: () => generatedNumber.toString(16).padStart(64, "0"),
    });
  return {
    db,
    transactor,
    service,
    execute,
    setNow: (value) => {
      currentNow = value;
    },
    now: () => currentNow,
  };
}

function sendChat(fx: Fixture, messageId: string, actor: ActorRef = { kind: "human", id: "alex" }) {
  const result = fx.execute(
    "chat.send",
    {
      messageId,
      text: `message ${messageId}`,
      sessionId: IDENTITY.sessionId,
      recipientAgentId: IDENTITY.agentId,
    },
    actor,
  );
  expect(result).toMatchObject({ status: "accepted" });
}

function serializedDelivery(delivery: ChatDelivery): Record<string, unknown> {
  return JSON.parse(JSON.stringify(delivery)) as Record<string, unknown>;
}

function seedWork(fx: Fixture, workId = "work_recover"): void {
  const hash = `hash_${workId}`;
  fx.db
    .prepare("INSERT INTO blobs (hash, byte_length, media_type, created_at) VALUES (?, ?, ?, ?)")
    .run(hash, 1, "text/html", new Date(fx.now()).toISOString());
  expect(
    fx.execute("artifact.register", {
      artifactId: `artifact_${workId}`,
      name: `${workId}.html`,
      format: "html",
      sourcePath: `/repo/${workId}.html`,
    }),
  ).toMatchObject({ status: "accepted" });
  expect(
    fx.execute("artifact.publish", {
      artifactId: `artifact_${workId}`,
      revisionId: `revision_${workId}`,
      format: "html",
      entryPath: `${workId}.html`,
      entryHash: hash,
      files: [{ path: `${workId}.html`, hash, mediaType: "text/html" }],
      producer: { kind: "agent", id: IDENTITY.agentId },
      sourcePath: `/repo/${workId}.html`,
    }),
  ).toMatchObject({ status: "accepted" });
  expect(
    fx.execute("review.submit-batch", {
      batchId: `batch_${workId}`,
      workId,
      artifactId: `artifact_${workId}`,
      revisionId: `revision_${workId}`,
      sessionId: IDENTITY.sessionId,
      assigneeAgentId: IDENTITY.agentId,
      intents: [
        {
          intentId: `intent_${workId}`,
          intentType: "comment",
          target: { semanticId: "scope" },
          body: { text: "tighten" },
        },
      ],
    }),
  ).toMatchObject({ status: "accepted" });
}

describe("inbound next chat delivery", () => {
  it("publishes retry eligibility separately from generation, ack, and processing authority", () => {
    const lateAck = fixture();
    sendChat(lateAck, "message_public_contract_late_ack");
    const first = lateAck.service().next(IDENTITY);
    if (first.kind !== "chat") throw new Error("expected first chat delivery");

    const firstPublic = serializedDelivery(first.delivery);
    expect(firstPublic).toMatchObject({
      attemptNumber: 1,
      redeliveryEligibleAt: new Date(lateAck.now() + 1_000).toISOString(),
      capability: first.delivery.capability,
      processingAuthority: "none",
      requiresWorkClaimForSideEffects: true,
    });
    // Plausibly-wrong regression: the runtime reservation deadline must never
    // leak as a public authority-expiry field.
    expect(firstPublic).not.toHaveProperty("expiresAt");
    expect(JSON.stringify(firstPublic)).not.toContain('"expiresAt"');

    lateAck.setNow(lateAck.now() + 1_000);
    expect(
      lateAck.service().acknowledge({
        ...IDENTITY,
        messageId: "message_public_contract_late_ack",
        attemptId: first.delivery.attemptId,
        capability: first.delivery.capability,
      }),
    ).toMatchObject({ status: "acknowledged", attemptNumber: 1 });

    const superseded = fixture();
    sendChat(superseded, "message_public_contract_superseded");
    const generationOne = superseded.service().next(IDENTITY);
    if (generationOne.kind !== "chat") throw new Error("expected generation one");
    superseded.setNow(superseded.now() + 1_000);
    const generationTwo = superseded.service().next(IDENTITY);
    if (generationTwo.kind !== "chat") throw new Error("expected generation two");

    expect(serializedDelivery(generationTwo.delivery)).toMatchObject({
      attemptNumber: 2,
      redeliveryEligibleAt: new Date(superseded.now() + 2_000).toISOString(),
      processingAuthority: "none",
      requiresWorkClaimForSideEffects: true,
    });
    expect(generationTwo.delivery.attemptId).not.toBe(generationOne.delivery.attemptId);
    expect(generationTwo.delivery.capability).not.toBe(generationOne.delivery.capability);
    expect(serializedDelivery(generationTwo.delivery)).not.toHaveProperty("expiresAt");
    expect(() =>
      superseded.service().acknowledge({
        ...IDENTITY,
        messageId: "message_public_contract_superseded",
        attemptId: generationOne.delivery.attemptId,
        capability: generationOne.delivery.capability,
      }),
    ).toThrowError(/stale/);
  });

  it("replays one client-owned chat reservation exactly after a lost response", () => {
    const fx = fixture();
    sendChat(fx, "message_replay");
    const request = {
      ...IDENTITY,
      requestId: "next_00000000-0000-4000-8000-000000000001",
      requestCapability: "a".repeat(64),
    };
    const first = fx.service().next(request);
    const eventCount = fx.db.prepare("SELECT COUNT(*) AS count FROM events").get();

    expect(fx.service().next(request)).toEqual(first);
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(eventCount);
    expect(first).toMatchObject({
      kind: "chat",
      delivery: {
        attemptId: `delivery_${request.requestId}`,
        capability: request.requestCapability,
      },
    });
    expect(() => fx.service().next({ ...request, requestCapability: "b".repeat(64) })).toThrowError(
      /different delivery authority/,
    );
    expect(() => fx.service().next({ ...request, kind: "work" })).toThrowError(
      /already bound to a chat result/,
    );
  });

  it("replays one client-owned work claim exactly after a lost response", () => {
    const fx = fixture();
    seedWork(fx, "work_request_replay");
    const request = {
      ...IDENTITY,
      requestId: "next_00000000-0000-4000-8000-000000000002",
      requestCapability: "c".repeat(64),
      workLeaseTtlMs: 30_000,
    };
    const first = fx.service().next(request);
    const eventCount = fx.db.prepare("SELECT COUNT(*) AS count FROM events").get();

    expect(fx.service().next(request)).toEqual(first);
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(eventCount);
    expect(first).toMatchObject({
      kind: "work",
      claim: { claimId: `claim_${request.requestId}`, workId: "work_request_replay" },
    });
    expect(() => fx.service().next({ ...request, requestCapability: "d".repeat(64) })).toThrowError(
      /different work authority/,
    );
    expect(() => fx.service().next({ ...request, kind: "chat" })).toThrowError(
      /already bound to a work result/,
    );
  });

  it("filters chat next without claiming earlier work", () => {
    const fx = fixture();
    seedWork(fx, "work_before_chat");
    sendChat(fx, "message_after_work");

    expect(fx.service().next({ ...IDENTITY, kind: "chat" })).toMatchObject({
      kind: "chat",
      delivery: { message: { messageId: "message_after_work" } },
    });
    expect(
      fx.db.prepare("SELECT status FROM p_work WHERE work_id = ?").get("work_before_chat"),
    ).toEqual({ status: "open" });
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM runtime_leases").get()).toEqual({
      count: 0,
    });
  });

  it("filters work next without reserving earlier chat", () => {
    const fx = fixture();
    sendChat(fx, "message_before_work");
    seedWork(fx, "work_after_chat");

    expect(fx.service().next({ ...IDENTITY, kind: "work" })).toMatchObject({
      kind: "work",
      claim: { workId: "work_after_chat" },
    });
    expect(
      fx.db
        .prepare("SELECT delivery_status FROM p_chat WHERE message_id = ?")
        .get("message_before_work"),
    ).toEqual({ delivery_status: null });
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM runtime_chat_deliveries").get()).toEqual({
      count: 0,
    });
  });

  it("rejects an invalid kind before selecting or mutating inbound state", () => {
    const fx = fixture();
    sendChat(fx, "message_invalid_kind");
    const before = fx.db.prepare("SELECT COUNT(*) AS count FROM events").get();

    expect(() => fx.service().next({ ...IDENTITY, kind: "invalid" as "chat" })).toThrowError(
      /kind must be chat or work/,
    );
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(before);
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM runtime_chat_deliveries").get()).toEqual({
      count: 0,
    });
  });

  it("does not wake on agent-authored chat", () => {
    const fx = fixture();
    sendChat(fx, "agent_message", { kind: "agent", id: IDENTITY.agentId });
    expect(fx.service().next(IDENTITY)).toEqual({ kind: "none", timedOut: false });
    expect(
      fx.db.prepare("SELECT delivery_status FROM p_chat WHERE message_id = ?").get("agent_message"),
    ).toEqual({ delivery_status: null });
  });

  it("keeps raw chat task-free, reserves one generation, and requires exact capability authority", () => {
    const fx = fixture();
    sendChat(fx, "message_1");

    const first = fx.service().next(IDENTITY);
    expect(first).toMatchObject({
      kind: "chat",
      delivery: {
        status: "offered",
        attemptNumber: 1,
        agentId: IDENTITY.agentId,
        message: { messageId: "message_1", delivery: { status: "offered" } },
      },
    });
    if (first.kind !== "chat") throw new Error("expected chat");
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM p_work").get()).toEqual({ count: 0 });
    expect(fx.service().next(IDENTITY)).toEqual({ kind: "none", timedOut: false });

    const reservation = fx.db
      .prepare("SELECT capability_hash FROM runtime_chat_deliveries WHERE message_id = ?")
      .get("message_1") as { capability_hash: string };
    expect(reservation.capability_hash).not.toBe(first.delivery.capability);
    expect(JSON.stringify(fx.db.prepare("SELECT payload_json FROM events").all())).not.toContain(
      first.delivery.capability,
    );

    expect(() =>
      fx.service().acknowledge({
        ...IDENTITY,
        messageId: "message_1",
        attemptId: first.delivery.attemptId,
        capability: "wrong",
      }),
    ).toThrowError(InboundError);
    expect(() =>
      fx.service().acknowledge({
        ...IDENTITY,
        processNonce: "wrong-process",
        messageId: "message_1",
        attemptId: first.delivery.attemptId,
        capability: first.delivery.capability,
      }),
    ).toThrowError(/exactly match/);

    const ack = fx.service().acknowledge({
      ...IDENTITY,
      messageId: "message_1",
      attemptId: first.delivery.attemptId,
      capability: first.delivery.capability,
    });
    expect(ack).toMatchObject({ status: "acknowledged", agentId: IDENTITY.agentId });
    expect(
      fx.service().acknowledge({
        ...IDENTITY,
        messageId: "message_1",
        attemptId: first.delivery.attemptId,
        capability: first.delivery.capability,
      }),
    ).toEqual(ack);

    const before = snapshot(
      fx.db,
      { workspaceId: WORKSPACE_ID, projectId: "project", rootPath: "/repo", protocolVersion: 1 },
      "http://artifact",
    ).chat[0]?.delivery;
    expect(before).toEqual({
      status: "acknowledged",
      attemptId: first.delivery.attemptId,
      attemptNumber: 1,
      agentId: IDENTITY.agentId,
      offeredAt: new Date(1_000).toISOString(),
      acknowledgedAt: new Date(1_000).toISOString(),
      pausedAt: null,
      pauseReason: null,
    });
    rebuildProjections(fx.db, WORKSPACE_ID);
    expect(
      snapshot(
        fx.db,
        {
          workspaceId: WORKSPACE_ID,
          projectId: "project",
          rootPath: "/repo",
          protocolVersion: 1,
        },
        "http://artifact",
      ).chat[0]?.delivery,
    ).toEqual(before);
  });

  it("rotates authority after expiry and rejects the stale generation", () => {
    const fx = fixture();
    sendChat(fx, "message_retry");
    const first = fx.service().next(IDENTITY);
    if (first.kind !== "chat") throw new Error("expected first chat");
    fx.db.prepare("DELETE FROM runtime_chat_deliveries WHERE message_id = ?").run("message_retry");
    expect(fx.service().next(IDENTITY)).toEqual({ kind: "none", timedOut: false });

    fx.setNow(fx.now() + 1_000);
    const second = fx.service().next(IDENTITY);
    expect(second).toMatchObject({ kind: "chat", delivery: { attemptNumber: 2 } });
    if (second.kind !== "chat") throw new Error("expected redelivery");
    expect(second.delivery.attemptId).not.toBe(first.delivery.attemptId);
    expect(() =>
      fx.service().acknowledge({
        ...IDENTITY,
        messageId: "message_retry",
        attemptId: first.delivery.attemptId,
        capability: first.delivery.capability,
      }),
    ).toThrowError(/stale/);
    expect(
      fx.service().acknowledge({
        ...IDENTITY,
        messageId: "message_retry",
        attemptId: second.delivery.attemptId,
        capability: second.delivery.capability,
      }),
    ).toMatchObject({ status: "acknowledged", attemptNumber: 2 });
  });

  it("rolls back the offer, projection, receipt, and runtime authority when reservation insertion fails", () => {
    const fx = fixture();
    sendChat(fx, "message_atomic");
    const beforeEvents = fx.db.prepare("SELECT COUNT(*) AS count FROM events").get();
    const command = {
      protocol: "tweakloop.command/v1",
      commandId: "command_atomic_offer",
      idempotencyKey: "key_atomic_offer",
      workspaceId: WORKSPACE_ID,
      actor: { kind: "agent", id: IDENTITY.agentId } as const,
      type: "chat.delivery-offer",
      payload: {
        messageId: "message_atomic",
        sessionId: IDENTITY.sessionId,
        agentId: IDENTITY.agentId,
        processNonce: IDENTITY.processNonce,
        attemptId: "delivery_atomic",
        attemptNumber: 1,
        offeredAt: new Date(fx.now()).toISOString(),
      },
    };
    expect(() =>
      fx.transactor.executeWithChatDeliveryReservation(command, {
        workspaceId: WORKSPACE_ID,
        sessionId: IDENTITY.sessionId,
        messageId: "message_atomic",
        recipientAgentId: IDENTITY.agentId,
        processNonce: IDENTITY.processNonce,
        attemptId: "delivery_atomic",
        attemptNumber: 1,
        capabilityHash: "invalid-check-constraint",
        offeredAt: fx.now(),
        expiresAt: fx.now() + 1_000,
      }),
    ).toThrow();
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(beforeEvents);
    expect(
      fx.db
        .prepare("SELECT delivery_status FROM p_chat WHERE message_id = ?")
        .get("message_atomic"),
    ).toEqual({ delivery_status: null });
    expect(
      fx.db
        .prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE idempotency_key = ?")
        .get("key_atomic_offer"),
    ).toEqual({ count: 0 });
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM runtime_chat_deliveries").get()).toEqual({
      count: 0,
    });

    expect(fx.service().next(IDENTITY)).toMatchObject({
      kind: "chat",
      delivery: { message: { messageId: "message_atomic" }, attemptNumber: 1 },
    });
  });

  it("pauses after the fifth expired offer, lets later chat progress, and resets on human resume", () => {
    const fx = fixture();
    sendChat(fx, "poison");
    let delivery = fx.service().next(IDENTITY);
    expect(delivery).toMatchObject({ kind: "chat", delivery: { attemptNumber: 1 } });
    for (const backoff of [1_000, 2_000, 4_000, 8_000]) {
      fx.setNow(fx.now() + backoff);
      delivery = fx.service().next(IDENTITY);
    }
    expect(delivery).toMatchObject({ kind: "chat", delivery: { attemptNumber: 5 } });
    sendChat(fx, "later");
    const later = fx.service().next(IDENTITY);
    expect(later).toMatchObject({
      kind: "chat",
      delivery: { message: { messageId: "later" }, attemptNumber: 1 },
    });
    if (later.kind !== "chat") throw new Error("expected later chat");
    fx.service().acknowledge({
      ...IDENTITY,
      messageId: "later",
      attemptId: later.delivery.attemptId,
      capability: later.delivery.capability,
    });

    fx.setNow(fx.now() + 8_000);
    expect(fx.service().next(IDENTITY)).toEqual({ kind: "none", timedOut: false });
    expect(
      fx.db
        .prepare("SELECT delivery_status, delivery_pause_reason FROM p_chat WHERE message_id = ?")
        .get("poison"),
    ).toEqual({
      delivery_status: "paused",
      delivery_pause_reason: "retry-budget-exhausted",
    });

    expect(
      fx.execute("chat.delivery-resume", {
        messageId: "poison",
        resumedAt: new Date(fx.now()).toISOString(),
      }),
    ).toMatchObject({ status: "accepted", response: { status: "resumed" } });
    expect(fx.service().next(IDENTITY)).toMatchObject({
      kind: "chat",
      delivery: { message: { messageId: "poison" }, attemptNumber: 1 },
    });
  });

  it("selects one eligible message without materializing a large backed-off backlog", () => {
    const fx = fixture();
    const insert = fx.db.prepare(
      `INSERT INTO p_chat (
         message_id, author, text, mentions_json, references_json, attachments_json,
         recorded_at, created_seq, session_id, recipient_agent_id,
         delivery_status, delivery_attempt_id, delivery_attempt_number,
         delivery_agent_id, delivery_offered_at, inbound_candidate
       ) VALUES (?, 'human:backlog', 'waiting', '[]', '[]', '[]', ?, ?, ?, ?,
                 'offered', ?, 1, ?, ?, 1)`,
    );
    fx.db
      .transaction(() => {
        for (let index = 0; index < 10_000; index += 1) {
          insert.run(
            `backlog_${index}`,
            new Date(fx.now()).toISOString(),
            index + 1,
            IDENTITY.sessionId,
            IDENTITY.agentId,
            `delivery_backlog_${index}`,
            IDENTITY.agentId,
            new Date(fx.now()).toISOString(),
          );
        }
      })
      .immediate();
    sendChat(fx, "eligible_after_backlog");

    const startedAt = performance.now();
    const selected = fx.service().next(IDENTITY);
    const elapsedMs = performance.now() - startedAt;
    expect(selected).toMatchObject({
      kind: "chat",
      delivery: { message: { messageId: "eligible_after_backlog" } },
    });
    expect(elapsedMs).toBeLessThan(1_000);
    const queryPlan = fx.db
      .prepare(
        `EXPLAIN QUERY PLAN SELECT * FROM p_chat
         WHERE session_id = ? AND inbound_candidate = 1
         ORDER BY created_seq LIMIT 1`,
      )
      .all(IDENTITY.sessionId) as readonly Readonly<{ detail: string }>[];
    expect(queryPlan.some((row) => row.detail.includes("p_chat_inbound_candidates"))).toBe(true);
  });

  it("rejects candidate 20001 at human chat ingress while keeping the admitted backlog drainable", () => {
    const fx = fixture();
    sendChat(fx, "capacity_real");
    const insert = fx.db.prepare(
      `INSERT INTO p_chat (
         message_id, author, text, mentions_json, references_json, attachments_json,
         recorded_at, created_seq, session_id, recipient_agent_id, inbound_candidate
       ) VALUES (?, 'human:backlog', 'waiting', '[]', '[]', '[]', ?, ?, ?, ?, 1)`,
    );
    fx.db
      .transaction(() => {
        for (let index = 0; index < 19_999; index += 1) {
          insert.run(
            `capacity_${index}`,
            new Date(fx.now()).toISOString(),
            index + 100,
            IDENTITY.sessionId,
            IDENTITY.agentId,
          );
        }
      })
      .immediate();

    const rejected = fx.execute("chat.send", {
      messageId: "candidate_20001",
      text: "must be rejected before the session becomes undrainable",
      sessionId: IDENTITY.sessionId,
      recipientAgentId: IDENTITY.agentId,
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "chat.delivery-backlog-limit",
    });
    expect(
      fx.db.prepare("SELECT COUNT(*) AS count FROM p_chat WHERE inbound_candidate = 1").get(),
    ).toEqual({ count: 20_000 });
    expect(fx.service().next(IDENTITY)).toMatchObject({
      kind: "chat",
      delivery: { message: { messageId: "capacity_real" } },
    });
  });

  it("rejects an inbound recipient that is not the active session owner before it consumes capacity", () => {
    const fx = fixture();
    const before = fx.db
      .prepare("SELECT COUNT(*) AS count FROM p_chat WHERE inbound_candidate = 1")
      .get();
    const rejected = fx.execute("chat.send", {
      messageId: "wrong_recipient",
      text: "this must not become an undrainable candidate",
      sessionId: IDENTITY.sessionId,
      recipientAgentId: "other",
    });
    expect(rejected).toMatchObject({
      status: "rejected",
      code: "chat.recipient-not-session-owner",
    });
    expect(
      fx.db.prepare("SELECT COUNT(*) AS count FROM p_chat WHERE inbound_candidate = 1").get(),
    ).toEqual(before);
    expect(fx.service().next(IDENTITY)).toEqual({ kind: "none", timedOut: false });
  });

  it("can drain a legacy over-cap projection instead of blocking its recovery path", () => {
    const fx = fixture();
    sendChat(fx, "legacy_real");
    const insert = fx.db.prepare(
      `INSERT INTO p_chat (
         message_id, author, text, mentions_json, references_json, attachments_json,
         recorded_at, created_seq, session_id, recipient_agent_id, inbound_candidate
       ) VALUES (?, 'human:legacy', 'waiting', '[]', '[]', '[]', ?, ?, ?, ?, 1)`,
    );
    fx.db
      .transaction(() => {
        for (let index = 0; index < 20_000; index += 1) {
          insert.run(
            `legacy_${index}`,
            new Date(fx.now()).toISOString(),
            index + 100,
            IDENTITY.sessionId,
            IDENTITY.agentId,
          );
        }
      })
      .immediate();
    const offered = fx.service().next(IDENTITY);
    expect(offered).toMatchObject({
      kind: "chat",
      delivery: { message: { messageId: "legacy_real" } },
    });
    if (offered.kind !== "chat") throw new Error("expected a drainable chat offer");
    fx.service().acknowledge({
      ...IDENTITY,
      messageId: offered.delivery.message.messageId,
      attemptId: offered.delivery.attemptId,
      capability: offered.delivery.capability,
    });
    expect(
      fx.db.prepare("SELECT COUNT(*) AS count FROM p_chat WHERE inbound_candidate = 1").get(),
    ).toEqual({ count: 20_000 });
  });

  it("returns an existing work claim as the distinct tagged branch", () => {
    const fx = fixture();
    fx.db
      .prepare("INSERT INTO blobs (hash, byte_length, media_type, created_at) VALUES (?, ?, ?, ?)")
      .run("hash_1", 1, "text/html", new Date(fx.now()).toISOString());
    expect(
      fx.execute("artifact.register", {
        artifactId: "artifact_1",
        name: "plan.html",
        format: "html",
        sourcePath: "/repo/plan.html",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      fx.execute("artifact.publish", {
        artifactId: "artifact_1",
        revisionId: "revision_1",
        format: "html",
        entryPath: "plan.html",
        entryHash: "hash_1",
        files: [{ path: "plan.html", hash: "hash_1", mediaType: "text/html" }],
        producer: { kind: "agent", id: "codex" },
        sourcePath: "/repo/plan.html",
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      fx.execute("review.submit-batch", {
        batchId: "batch_1",
        workId: "work_1",
        artifactId: "artifact_1",
        revisionId: "revision_1",
        sessionId: IDENTITY.sessionId,
        assigneeAgentId: IDENTITY.agentId,
        intents: [
          {
            intentId: "intent_1",
            intentType: "comment",
            target: { semanticId: "scope" },
            body: { text: "tighten" },
          },
        ],
      }),
    ).toMatchObject({ status: "accepted" });

    const selected = fx.service().next(IDENTITY);
    expect(selected).toMatchObject({
      kind: "work",
      claim: { status: "claimed", workId: "work_1", agentId: IDENTITY.agentId },
    });
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM runtime_leases").get()).toEqual({
      count: 1,
    });
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM runtime_chat_deliveries").get()).toEqual({
      count: 0,
    });
  });

  it("recovers the same work with a fresh claim after the first result and lease are lost", () => {
    const fx = fixture();
    seedWork(fx);
    const first = fx.service().next({ ...IDENTITY, workLeaseTtlMs: 1_000 });
    expect(first).toMatchObject({
      kind: "work",
      claim: {
        status: "claimed",
        workId: "work_recover",
        processNonce: IDENTITY.processNonce,
        leaseTtlMs: 1_000,
      },
    });
    if (first.kind !== "work") throw new Error("expected first work claim");
    const staleClaimId = String(first.claim.claimId);

    fx.setNow(fx.now() + 1_001);
    const recovered = fx.service().next({ ...IDENTITY, workLeaseTtlMs: 1_000 });
    expect(recovered).toMatchObject({
      kind: "work",
      claim: {
        status: "claimed",
        recovered: true,
        workId: "work_recover",
        processNonce: IDENTITY.processNonce,
        leaseTtlMs: 1_000,
      },
    });
    if (recovered.kind !== "work") throw new Error("expected recovered work claim");
    expect(recovered.claim.claimId).not.toBe(staleClaimId);
    expect(fx.service().next(IDENTITY)).toEqual({ kind: "none", timedOut: false });
    expect(
      fx.execute(
        "work.complete",
        {
          workId: "work_recover",
          claimId: staleClaimId,
          agentId: IDENTITY.agentId,
          summary: "stale completion must fail",
        },
        { kind: "agent", id: IDENTITY.agentId },
      ),
    ).toMatchObject({ status: "rejected", code: "work.stale-claim" });
    expect(
      fx.db
        .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'work.abandoned'")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back an initial claim when runtime lease authority cannot be installed", () => {
    const fx = fixture();
    seedWork(fx);
    const beforeEvents = fx.db.prepare("SELECT COUNT(*) AS count FROM events").get();
    const beforeReceipts = fx.db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get();
    fx.db.exec(`CREATE TRIGGER reject_runtime_lease
      BEFORE INSERT ON runtime_leases
      BEGIN SELECT RAISE(ABORT, 'persistent lease fault'); END;`);

    expect(() => fx.service().next(IDENTITY)).toThrowError("persistent lease fault");
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(beforeEvents);
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual(
      beforeReceipts,
    );
    expect(
      fx.db
        .prepare(
          "SELECT status, json_extract(claim_json, '$.claimId') AS claim_id FROM p_work WHERE work_id = ?",
        )
        .get("work_recover"),
    ).toEqual({ status: "open", claim_id: null });
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM runtime_leases").get()).toEqual({
      count: 0,
    });
  });

  it("rolls back reclaim facts and retains the old lease when replacement authority fails", () => {
    const fx = fixture();
    seedWork(fx);
    const first = fx.service().next({ ...IDENTITY, workLeaseTtlMs: 1_000 });
    if (first.kind !== "work") throw new Error("expected first work claim");
    const staleClaimId = String(first.claim.claimId);
    fx.setNow(fx.now() + 1_001);
    const beforeEvents = fx.db.prepare("SELECT COUNT(*) AS count FROM events").get();
    const beforeReceipts = fx.db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get();
    fx.db.exec(`
      CREATE TRIGGER reject_runtime_lease_insert
      BEFORE INSERT ON runtime_leases
      BEGIN SELECT RAISE(ABORT, 'persistent lease fault'); END;
      CREATE TRIGGER reject_runtime_lease_update
      BEFORE UPDATE ON runtime_leases
      BEGIN SELECT RAISE(ABORT, 'persistent lease fault'); END;
    `);

    expect(() => fx.service().next(IDENTITY)).toThrowError("persistent lease fault");
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual(beforeEvents);
    expect(fx.db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual(
      beforeReceipts,
    );
    expect(
      fx.db
        .prepare(
          "SELECT status, json_extract(claim_json, '$.claimId') AS claim_id FROM p_work WHERE work_id = ?",
        )
        .get("work_recover"),
    ).toEqual({ status: "claimed", claim_id: staleClaimId });
    expect(
      fx.db.prepare("SELECT claim_id FROM runtime_leases WHERE work_id = ?").get("work_recover"),
    ).toEqual({ claim_id: staleClaimId });
    expect(
      fx.db
        .prepare("SELECT COUNT(*) AS count FROM events WHERE event_type = 'work.abandoned'")
        .get(),
    ).toEqual({ count: 0 });
  });
});
