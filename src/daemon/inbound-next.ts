import { createHash, timingSafeEqual } from "node:crypto";
import type { ChatDelivery, NextDelivery } from "../protocol/chat-delivery.js";
import type { CommandResult } from "../protocol/envelopes.js";
import type { SnapshotChatMessage } from "../protocol/snapshot.js";
import { COMMAND_PROTOCOL } from "../protocol/versions.js";
import type { Db } from "../storage/sqlite/db.js";
import { getReceipt } from "../storage/sqlite/event-store.js";
import type { Transactor } from "./transactor.js";

const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_WORK_LEASE_MS = 30_000;

export type InboundIdentity = Readonly<{
  sessionId: string;
  agentId: string;
  processNonce: string;
}>;

export type InboundKind = "chat" | "work";

type InboundNextRequest = InboundIdentity &
  Readonly<{
    workLeaseTtlMs?: number;
    requestId?: string;
    requestCapability?: string;
    kind?: InboundKind;
  }>;

export type InboundService = Readonly<{
  next: (identity: InboundNextRequest) => NextDelivery;
  acknowledge: (
    input: InboundIdentity & Readonly<{ messageId: string; attemptId: string; capability: string }>,
  ) => Readonly<Record<string, unknown>>;
}>;

export class InboundError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 409,
  ) {
    super(message);
  }
}

type InboundDeps = Readonly<{
  db: Db;
  workspaceId: string;
  transactor: Transactor;
  now: () => number;
  newId: () => string;
  newCapability: () => string;
}>;

type ChatRow = Readonly<{
  message_id: string;
  artifact_id: string | null;
  author: string;
  text: string;
  context_json: string | null;
  mentions_json: string;
  references_json: string;
  attachments_json: string;
  session_id: string | null;
  recipient_agent_id: string | null;
  thread_id: string | null;
  work_id: string | null;
  intent_id: string | null;
  recorded_at: string;
  created_seq: number;
  delivery_status: "offered" | "acknowledged" | "paused" | null;
  delivery_attempt_id: string | null;
  delivery_attempt_number: number;
  delivery_agent_id: string | null;
  delivery_offered_at: string | null;
  delivery_acknowledged_at: string | null;
  delivery_paused_at: string | null;
  delivery_pause_reason: "retry-budget-exhausted" | null;
}>;

type SessionOwnerRow = Readonly<{
  agent_id: string;
  process_nonce: string;
  status: "active" | "handed-off" | "ended";
}>;

type WorkRow = Readonly<{
  work_id: string;
  created_seq: number;
  status: "open" | "claimed";
  claim_id: string | null;
}>;

export function createInboundService(deps: InboundDeps): InboundService {
  function next(input: InboundNextRequest): NextDelivery {
    assertSessionOwner(input);
    validateRequestAuthority(input);
    const recovered = recoverRequestedResult(input);
    if (recovered !== null) return recovered;
    const now = deps.now();
    if (input.kind !== "work") pauseOneExpiredChat(input, now);
    const chat = input.kind === "work" ? null : firstEligibleChat(input, now);
    const work = input.kind === "chat" ? null : firstEligibleWork(input, now);

    if (work && (!chat || work.created_seq < chat.created_seq)) {
      const claimed = acquireWork(input, work, input.workLeaseTtlMs, requestedClaimId(input));
      if (claimed !== null) return { kind: "work", claim: claimed };
    }
    if (chat) return offerChat(input, chat, now);
    if (work) {
      const claimed = acquireWork(input, work, input.workLeaseTtlMs, requestedClaimId(input));
      if (claimed !== null) return { kind: "work", claim: claimed };
    }
    return { kind: "none", timedOut: false };
  }

  function validateRequestAuthority(input: InboundNextRequest): void {
    if ((input.requestId === undefined) !== (input.requestCapability === undefined)) {
      throw new InboundError(
        "inbound.request-authority-incomplete",
        "requestId and requestCapability must be supplied together",
        400,
      );
    }
    if (input.requestId !== undefined && !/^next_[0-9a-f-]{36}$/.test(input.requestId)) {
      throw new InboundError("inbound.request-id-invalid", "requestId is invalid", 400);
    }
    if (input.requestCapability !== undefined && !/^[0-9a-f]{64}$/.test(input.requestCapability)) {
      throw new InboundError(
        "inbound.request-capability-invalid",
        "requestCapability is invalid",
        400,
      );
    }
    if (input.kind !== undefined && input.kind !== "chat" && input.kind !== "work") {
      throw new InboundError("inbound.kind-invalid", "kind must be chat or work", 400);
    }
  }

  function recoverRequestedResult(input: InboundNextRequest): NextDelivery | null {
    if (input.requestId === undefined || input.requestCapability === undefined) return null;
    const attemptId = requestedAttemptId(input.requestId);
    const reservation = deps.transactor.chatDeliveryReservation(attemptId);
    if (reservation !== null) {
      if (
        reservation.workspaceId !== deps.workspaceId ||
        reservation.sessionId !== input.sessionId ||
        reservation.recipientAgentId !== input.agentId ||
        reservation.processNonce !== input.processNonce ||
        !capabilityMatches(input.requestCapability, reservation.capabilityHash)
      ) {
        throw new InboundError(
          "inbound.request-authority-mismatch",
          "the request is already bound to different delivery authority",
          403,
        );
      }
      const row = deps.db
        .prepare("SELECT * FROM p_chat WHERE message_id = ? AND delivery_attempt_id = ?")
        .get(reservation.messageId, attemptId) as ChatRow | undefined;
      if (!row) {
        throw new InboundError(
          "inbound.request-state-missing",
          "the durable delivery exists but its projection is unavailable",
          500,
        );
      }
      assertRequestedKind(input, "chat");
      return chatNextDelivery(row, input, reservation, input.requestCapability);
    }

    const claimId = requestedClaimId(input);
    if (claimId === undefined) return null;
    const claimed = deps.db
      .prepare("SELECT work_id FROM p_work WHERE json_extract(claim_json, '$.claimId') = ?")
      .get(claimId) as { work_id: string } | undefined;
    if (!claimed) return null;
    const lease = deps.db
      .prepare(
        `SELECT agent_id, process_nonce, request_capability_hash, last_heartbeat, expires_at
         FROM runtime_leases WHERE work_id = ? AND claim_id = ?`,
      )
      .get(claimed.work_id, claimId) as
      | {
          agent_id: string;
          process_nonce: string;
          request_capability_hash: string | null;
          last_heartbeat: number;
          expires_at: number;
        }
      | undefined;
    if (!lease || lease.expires_at <= deps.now()) {
      throw new InboundError(
        "inbound.request-expired",
        "the committed work request expired; run a new next command to recover the work",
      );
    }
    if (
      lease.agent_id !== input.agentId ||
      lease.process_nonce !== input.processNonce ||
      lease.request_capability_hash === null ||
      !capabilityMatches(input.requestCapability, lease.request_capability_hash)
    ) {
      throw new InboundError(
        "inbound.request-authority-mismatch",
        "the request is already bound to different work authority",
        403,
      );
    }
    const receipt = getReceipt(deps.db, deps.workspaceId, `inbound.work:${claimId}`);
    if (receipt === null) {
      throw new InboundError(
        "inbound.request-receipt-missing",
        "the committed work request has no durable receipt",
        500,
      );
    }
    assertRequestedKind(input, "work");
    return {
      kind: "work",
      claim: {
        ...acceptedResponse(receipt),
        processNonce: input.processNonce,
        leaseTtlMs: lease.expires_at - lease.last_heartbeat,
        leaseExpiresAt: new Date(lease.expires_at).toISOString(),
      },
    };
  }

  function assertRequestedKind(input: InboundNextRequest, actual: InboundKind): void {
    if (input.kind !== undefined && input.kind !== actual) {
      throw new InboundError(
        "inbound.request-kind-mismatch",
        `the request is already bound to a ${actual} result`,
        409,
      );
    }
  }

  function acknowledge(
    input: InboundIdentity & Readonly<{ messageId: string; attemptId: string; capability: string }>,
  ): Readonly<Record<string, unknown>> {
    assertSessionOwner(input);
    const reservation = deps.transactor.chatDeliveryReservation(input.attemptId);
    if (
      reservation === null ||
      reservation.workspaceId !== deps.workspaceId ||
      reservation.sessionId !== input.sessionId ||
      reservation.messageId !== input.messageId ||
      reservation.recipientAgentId !== input.agentId ||
      reservation.processNonce !== input.processNonce ||
      !capabilityMatches(input.capability, reservation.capabilityHash)
    ) {
      throw new InboundError(
        "chat.delivery-capability-invalid",
        "capability is missing, stale, or bound to a different delivery context",
        403,
      );
    }
    const message = deps.db
      .prepare(
        `SELECT session_id, recipient_agent_id, delivery_status, delivery_attempt_id
         FROM p_chat WHERE message_id = ?`,
      )
      .get(input.messageId) as
      | {
          session_id: string | null;
          recipient_agent_id: string | null;
          delivery_status: "offered" | "acknowledged" | "paused" | null;
          delivery_attempt_id: string | null;
        }
      | undefined;
    if (
      !message ||
      message.session_id !== input.sessionId ||
      (message.recipient_agent_id !== null && message.recipient_agent_id !== input.agentId) ||
      message.delivery_attempt_id !== input.attemptId ||
      !["offered", "acknowledged"].includes(message.delivery_status ?? "")
    ) {
      throw new InboundError(
        "chat.delivery-stale-attempt",
        "acknowledgment requires the latest non-paused delivery generation",
      );
    }
    const result = deps.transactor.execute({
      protocol: COMMAND_PROTOCOL,
      commandId: `cmd_${deps.newId()}`,
      idempotencyKey: `chat.delivery-ack:${input.attemptId}`,
      workspaceId: deps.workspaceId,
      actor: { kind: "agent", id: input.agentId },
      type: "chat.delivery-acknowledge",
      payload: {
        messageId: input.messageId,
        sessionId: input.sessionId,
        agentId: input.agentId,
        processNonce: input.processNonce,
        attemptId: input.attemptId,
        acknowledgedAt: new Date(deps.now()).toISOString(),
      },
    });
    return acceptedResponse(result);
  }

  function assertSessionOwner(identity: InboundIdentity): void {
    const session = deps.db
      .prepare("SELECT agent_id, process_nonce, status FROM p_sessions WHERE session_id = ?")
      .get(identity.sessionId) as SessionOwnerRow | undefined;
    if (!session) throw new InboundError("session.unknown", "unknown session", 404);
    if (session.status !== "active") {
      throw new InboundError("session.inactive", "session is not active");
    }
    if (session.agent_id !== identity.agentId || session.process_nonce !== identity.processNonce) {
      throw new InboundError(
        "session.owner-mismatch",
        "agent and process must exactly match the active session owner",
        403,
      );
    }
  }

  function firstEligibleChat(identity: InboundIdentity, now: number): ChatRow | null {
    return (
      (deps.db
        .prepare(
          `SELECT * FROM p_chat
           WHERE session_id = ?
             AND inbound_candidate = 1
             AND (recipient_agent_id IS NULL OR recipient_agent_id = ?)
             AND author LIKE 'human:%'
             AND work_id IS NULL AND intent_id IS NULL
             AND (
               delivery_status IS NULL
               OR (
                 delivery_status = 'offered'
                 AND delivery_attempt_number < 5
                 AND (
                   delivery_offered_at IS NULL
                   OR (delivery_attempt_number = 1 AND delivery_offered_at <= ?)
                   OR (delivery_attempt_number = 2 AND delivery_offered_at <= ?)
                   OR (delivery_attempt_number = 3 AND delivery_offered_at <= ?)
                   OR (delivery_attempt_number >= 4 AND delivery_offered_at <= ?)
                 )
               )
             )
           ORDER BY created_seq
           LIMIT 1`,
        )
        .get(
          identity.sessionId,
          identity.agentId,
          eligibleOfferedAt(now, 1_000),
          eligibleOfferedAt(now, 2_000),
          eligibleOfferedAt(now, 4_000),
          eligibleOfferedAt(now, 8_000),
        ) as ChatRow | undefined) ?? null
    );
  }

  function pauseOneExpiredChat(identity: InboundIdentity, now: number): void {
    const expired = deps.db
      .prepare(
        `SELECT * FROM p_chat
         WHERE session_id = ?
           AND inbound_candidate = 1
           AND (recipient_agent_id IS NULL OR recipient_agent_id = ?)
           AND author LIKE 'human:%'
           AND work_id IS NULL AND intent_id IS NULL
           AND delivery_status = 'offered'
           AND delivery_attempt_number >= 5
           AND (delivery_offered_at IS NULL OR delivery_offered_at <= ?)
         ORDER BY created_seq
         LIMIT 1`,
      )
      .get(identity.sessionId, identity.agentId, eligibleOfferedAt(now, 8_000)) as
      | ChatRow
      | undefined;
    if (expired) pauseChat(expired, now);
  }

  function firstEligibleWork(identity: InboundIdentity, now: number): WorkRow | null {
    return (
      (deps.db
        .prepare(
          `SELECT work_id, created_seq, status,
                  json_extract(claim_json, '$.claimId') AS claim_id
           FROM p_work
           WHERE session_id = ?
             AND (assignee_agent_id IS NULL OR assignee_agent_id = ?)
             AND (
               (status = 'open' AND claim_json IS NULL)
               OR (
                 status = 'claimed'
                 AND json_extract(claim_json, '$.agentId') = ?
                 AND NOT EXISTS (
                   SELECT 1 FROM runtime_leases lease
                   WHERE lease.work_id = p_work.work_id
                     AND lease.claim_id = json_extract(p_work.claim_json, '$.claimId')
                     AND lease.expires_at > ?
                 )
               )
             )
           ORDER BY created_seq
           LIMIT 1`,
        )
        .get(identity.sessionId, identity.agentId, identity.agentId, now) as WorkRow | undefined) ??
      null
    );
  }

  function pauseChat(row: ChatRow, now: number): void {
    if (row.delivery_attempt_id === null) return;
    const result = deps.transactor.execute({
      protocol: COMMAND_PROTOCOL,
      commandId: `cmd_${deps.newId()}`,
      idempotencyKey: `chat.delivery-pause:${row.delivery_attempt_id}`,
      workspaceId: deps.workspaceId,
      actor: { kind: "system", id: "daemon" },
      type: "chat.delivery-pause",
      payload: {
        messageId: row.message_id,
        attemptId: row.delivery_attempt_id,
        pausedAt: new Date(now).toISOString(),
        reason: "retry-budget-exhausted",
      },
    });
    acceptedResponse(result);
  }

  function offerChat(identity: InboundIdentity, row: ChatRow, now: number): NextDelivery {
    const attemptNumber = row.delivery_attempt_number + 1;
    const request = identity as InboundNextRequest;
    const attemptId =
      request.requestId === undefined
        ? `delivery_${deps.newId()}`
        : requestedAttemptId(request.requestId);
    const capability = request.requestCapability ?? deps.newCapability();
    const offeredAt = new Date(now).toISOString();
    const expiresAtMs = now + retryDelay(attemptNumber);
    const command = {
      protocol: COMMAND_PROTOCOL,
      commandId: `cmd_${deps.newId()}`,
      idempotencyKey: `chat.delivery-offer:${attemptId}`,
      workspaceId: deps.workspaceId,
      actor: { kind: "agent", id: identity.agentId },
      type: "chat.delivery-offer",
      payload: {
        messageId: row.message_id,
        sessionId: identity.sessionId,
        agentId: identity.agentId,
        processNonce: identity.processNonce,
        attemptId,
        attemptNumber,
        offeredAt,
      },
    } as const;
    const result = deps.transactor.executeWithChatDeliveryReservation(command, {
      workspaceId: deps.workspaceId,
      sessionId: identity.sessionId,
      messageId: row.message_id,
      recipientAgentId: identity.agentId,
      processNonce: identity.processNonce,
      attemptId,
      attemptNumber,
      capabilityHash: createHash("sha256").update(capability).digest("hex"),
      offeredAt: now,
      expiresAt: expiresAtMs,
    });
    acceptedResponse(result);
    const projected = deps.db
      .prepare("SELECT * FROM p_chat WHERE message_id = ?")
      .get(row.message_id) as ChatRow;
    return chatNextDelivery(
      projected,
      identity,
      {
        attemptId,
        attemptNumber,
        offeredAt: now,
        expiresAt: expiresAtMs,
      },
      capability,
    );
  }

  function chatNextDelivery(
    row: ChatRow,
    identity: InboundIdentity,
    reservation: Readonly<{
      attemptId: string;
      attemptNumber: number;
      offeredAt: number;
      expiresAt: number;
    }>,
    capability: string,
  ): NextDelivery {
    const delivery: ChatDelivery = {
      protocol: "tweakloop.chat-delivery/v1",
      status: "offered",
      message: toSnapshotChat(row),
      attemptId: reservation.attemptId,
      attemptNumber: reservation.attemptNumber,
      agentId: identity.agentId,
      sessionId: identity.sessionId,
      processNonce: identity.processNonce,
      offeredAt: new Date(reservation.offeredAt).toISOString(),
      redeliveryEligibleAt: new Date(reservation.expiresAt).toISOString(),
      processingAuthority: "none",
      requiresWorkClaimForSideEffects: true,
      capability,
    };
    return { kind: "chat", delivery };
  }

  function claimWork(
    identity: InboundIdentity,
    workId: string,
    requestedTtlMs: number | undefined,
    requestedClaimId?: string,
    requestCapability?: string,
  ): Readonly<Record<string, unknown>> | null {
    const claimId = requestedClaimId ?? `claim_${deps.newId()}`;
    const ttlMs = validTtl(requestedTtlMs);
    const now = deps.now();
    const leaseExpiresAt = now + ttlMs;
    const result = deps.transactor.executeWithWorkLease(
      {
        protocol: COMMAND_PROTOCOL,
        commandId: `cmd_${deps.newId()}`,
        idempotencyKey: `inbound.work:${claimId}`,
        workspaceId: deps.workspaceId,
        actor: { kind: "agent", id: identity.agentId },
        type: "work.claim",
        payload: { claimId, agentId: identity.agentId, workId },
      },
      {
        workId,
        claimId,
        agentId: identity.agentId,
        processNonce: identity.processNonce,
        requestCapabilityHash: capabilityHashOrNull(requestCapability),
        lastHeartbeat: now,
        expiresAt: leaseExpiresAt,
      },
    );
    const response = acceptedResponse(result);
    if (response.status !== "claimed") return null;
    return {
      ...response,
      processNonce: identity.processNonce,
      leaseTtlMs: ttlMs,
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
    };
  }

  function recoverWork(
    identity: InboundIdentity,
    workId: string,
    staleClaimId: string,
    requestedTtlMs: number | undefined,
    requestedClaimId?: string,
    requestCapability?: string,
  ): Readonly<Record<string, unknown>> | null {
    if (!deps.transactor.leaseIsRecoverable(workId, staleClaimId, deps.now())) return null;
    const claimId = requestedClaimId ?? `claim_${deps.newId()}`;
    const ttlMs = validTtl(requestedTtlMs);
    const now = deps.now();
    const leaseExpiresAt = now + ttlMs;
    const result = deps.transactor.executeWithWorkLease(
      {
        protocol: COMMAND_PROTOCOL,
        commandId: `cmd_${deps.newId()}`,
        idempotencyKey: `inbound.work:${claimId}`,
        workspaceId: deps.workspaceId,
        actor: { kind: "agent", id: identity.agentId },
        type: "work.reclaim",
        payload: { workId, staleClaimId, claimId, agentId: identity.agentId },
      },
      {
        workId,
        claimId,
        agentId: identity.agentId,
        processNonce: identity.processNonce,
        requestCapabilityHash: capabilityHashOrNull(requestCapability),
        lastHeartbeat: now,
        expiresAt: leaseExpiresAt,
      },
    );
    const response = acceptedResponse(result);
    if (response.status !== "claimed") return null;
    return {
      ...response,
      processNonce: identity.processNonce,
      leaseTtlMs: ttlMs,
      leaseExpiresAt: new Date(leaseExpiresAt).toISOString(),
    };
  }

  function acquireWork(
    identity: InboundNextRequest,
    work: WorkRow,
    requestedTtlMs: number | undefined,
    requestedClaimId?: string,
  ): Readonly<Record<string, unknown>> | null {
    return work.status === "claimed" && work.claim_id !== null
      ? recoverWork(
          identity,
          work.work_id,
          work.claim_id,
          requestedTtlMs,
          requestedClaimId,
          identity.requestCapability,
        )
      : claimWork(
          identity,
          work.work_id,
          requestedTtlMs,
          requestedClaimId,
          identity.requestCapability,
        );
  }

  return { next, acknowledge };
}

function acceptedResponse(result: CommandResult): Readonly<Record<string, unknown>> {
  if (result.status === "rejected") {
    throw new InboundError(result.code, result.message);
  }
  if (!result.response || typeof result.response !== "object") {
    throw new InboundError(
      "inbound.invalid-response",
      "accepted command returned no response",
      500,
    );
  }
  return result.response as Readonly<Record<string, unknown>>;
}

function retryDelay(attemptNumber: number): number {
  const index = Math.min(Math.max(attemptNumber - 1, 0), RETRY_BACKOFF_MS.length - 1);
  return RETRY_BACKOFF_MS[index] ?? 8_000;
}

function eligibleOfferedAt(now: number, delayMs: number): string {
  return new Date(now - delayMs).toISOString();
}

function validTtl(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_WORK_LEASE_MS;
}

function requestedAttemptId(requestId: string): string {
  return `delivery_${requestId}`;
}

function requestedClaimId(input: InboundNextRequest): string | undefined {
  return input.requestId === undefined ? undefined : `claim_${input.requestId}`;
}

function capabilityMatches(capability: string, expectedHash: string): boolean {
  const actual = createHash("sha256").update(capability).digest();
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function capabilityHashOrNull(capability: string | undefined): string | null {
  return capability === undefined ? null : createHash("sha256").update(capability).digest("hex");
}

function toSnapshotChat(row: ChatRow): SnapshotChatMessage {
  return {
    messageId: row.message_id,
    artifactId: row.artifact_id,
    author: row.author,
    text: row.text,
    content: { type: "text", text: row.text },
    context: row.context_json === null ? null : JSON.parse(row.context_json),
    mentions: JSON.parse(row.mentions_json),
    references: JSON.parse(row.references_json),
    attachments: JSON.parse(row.attachments_json),
    sessionId: row.session_id,
    recipientAgentId: row.recipient_agent_id,
    threadId: row.thread_id,
    workId: row.work_id,
    intentId: row.intent_id,
    delivery:
      row.delivery_status === null
        ? null
        : {
            status: row.delivery_status,
            attemptId: row.delivery_attempt_id,
            attemptNumber: row.delivery_attempt_number,
            agentId: row.delivery_agent_id,
            offeredAt: row.delivery_offered_at,
            acknowledgedAt: row.delivery_acknowledged_at,
            pausedAt: row.delivery_paused_at,
            pauseReason: row.delivery_pause_reason,
          },
    questionState: null,
    answerState: null,
    recordedAt: row.recorded_at,
    createdSeq: row.created_seq,
  };
}
