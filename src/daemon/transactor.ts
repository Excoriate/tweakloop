import type { DomainCommand } from "../domain/commands.js";
import { decide } from "../domain/decide.js";
import { type DomainEvent, type RevisionFile, streamOf } from "../domain/events.js";
import { replay } from "../domain/evolve.js";
import {
  type ChatAttachment,
  type ChatContent,
  type ChatContext,
  type ChatReference,
  chatContentOrText,
  chatContentText,
} from "../protocol/chat.js";
import { INBOUND_CHAT_BACKLOG_LIMIT } from "../protocol/chat-delivery.js";
import { commandRequestHash } from "../protocol/command-identity.js";
import type {
  ActorRef,
  CommandAccepted,
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
} from "../protocol/envelopes.js";
import type { IntentInput } from "../protocol/intents.js";
import { validateCommand } from "../protocol/validation.js";
import { EVENT_SCHEMA_VERSION } from "../protocol/versions.js";
import type { Db } from "../storage/sqlite/db.js";
import {
  appendEvent,
  currentStreamVersion,
  getReceiptRecord,
  putReceipt,
  readEvents,
} from "../storage/sqlite/event-store.js";
import { applySessionRuntimeAuthority } from "../storage/sqlite/runtime-authority.js";
import { applyProjections } from "./projections.js";

export type TransactorDeps = Readonly<{
  db: Db;
  workspaceId: string;
  daemonStartNonce?: string;
  newEventId: () => string;
  now: () => string;
  onCommitted: (envelopes: readonly EventEnvelope[]) => void;
  failureInjection?: (point: "after-events" | "after-projections" | "after-receipt") => void;
}>;

export type Transactor = Readonly<{
  execute: (input: unknown) => CommandResult;
  executeWithTransportPrincipal: (
    input: unknown,
    principal: CommandTransportPrincipal,
  ) => CommandResult;
  executeWithTransactionHooks: (input: unknown, hooks: TransactorTransactionHooks) => CommandResult;
  executeWithChatDeliveryReservation: (
    input: unknown,
    reservation: ChatDeliveryReservation,
  ) => CommandResult;
  executeWithWorkLease: (input: unknown, lease: RuntimeLease) => CommandResult;
  restoreHistory: (input: RestoreHistoryInput) => readonly EventEnvelope[];
  heartbeatLease: (input: LeaseHeartbeat) => boolean;
  leaseIsRecoverable: (workId: string, claimId: string, nowMs: number) => boolean;
  leaseMatches: (
    workId: string,
    claimId: string,
    agentId: string,
    processNonce: string,
    nowMs: number,
  ) => boolean;
  chatDeliveryReservation: (attemptId: string) => ChatDeliveryReservation | null;
}>;

export type CommandTransportPrincipal = Readonly<{
  kind: "human" | "agent";
  id: string;
}>;

export type TransactorTransactionHooks = Readonly<{
  /** Runs after the IMMEDIATE transaction begins and before any event, projection, or receipt. */
  beforeMutation: () => CommandResult | null;
  /** Runs after the command receipt is written but before the same transaction commits. */
  afterAccepted: (result: CommandAccepted) => void;
}>;

export type RestoreHistoryInput = Readonly<{
  events: readonly EventEnvelope[];
  blobs: readonly Readonly<{
    hash: string;
    byteLength: number;
    mediaType: string;
    createdAt: string;
  }>[];
}>;

export type RuntimeLease = Readonly<{
  workId: string;
  claimId: string;
  agentId: string;
  processNonce: string;
  requestCapabilityHash: string | null;
  expiresAt: number;
  lastHeartbeat: number;
}>;

export type LeaseHeartbeat = Readonly<{
  workId: string;
  claimId: string;
  agentId: string;
  processNonce: string;
  nowMs: number;
  expiresAt: number;
}>;

export type ChatDeliveryReservation = Readonly<{
  workspaceId: string;
  sessionId: string;
  messageId: string;
  recipientAgentId: string;
  processNonce: string;
  attemptId: string;
  attemptNumber: number;
  capabilityHash: string;
  offeredAt: number;
  expiresAt: number;
}>;

export type CommandReceiptResolution =
  | Readonly<{ kind: "missing"; requestHash: string }>
  | Readonly<{ kind: "resolved"; requestHash: string; result: CommandResult }>;

/**
 * Resolve a durable command receipt only after proving that the current
 * normalized request has the same identity. Legacy receipts deliberately
 * carry no wildcard semantics: an unknowable request identity fails closed.
 */
export function resolveCommandReceipt(
  db: Db,
  workspaceId: string,
  envelope: CommandEnvelope,
): CommandReceiptResolution {
  const requestHash = commandRequestHash(envelope);
  const receipt = getReceiptRecord(db, workspaceId, envelope.idempotencyKey);
  if (receipt === null) return { kind: "missing", requestHash };
  if (receipt.identityStatus !== "verified" || receipt.requestHash === null) {
    return {
      kind: "resolved",
      requestHash,
      result: rejected(
        envelope,
        "idempotency-identity-unverifiable",
        legacyReceiptRepairMessage(envelope.idempotencyKey),
      ),
    };
  }
  if (receipt.requestHash !== requestHash) {
    return {
      kind: "resolved",
      requestHash,
      result: rejected(
        envelope,
        "idempotency-key-conflict",
        "the idempotency key is already bound to a different normalized command",
      ),
    };
  }
  return { kind: "resolved", requestHash, result: receipt.response };
}

function legacyReceiptRepairMessage(idempotencyKey: string): string {
  if (
    idempotencyKey.startsWith("workspace.open:") ||
    idempotencyKey.startsWith("artifact.register:")
  ) {
    return `the stored receipt cannot be replayed because its event range, actor, payload, and response do not prove one normalized request; restore the original receipt and exact linked events for ${idempotencyKey} from backup, then restart (the receipt was retained and will not be re-executed)`;
  }
  return "the stored receipt cannot be replayed because its normalized request identity is unavailable; this hashless command family is unsupported and remains fail-closed";
}

/**
 * The single serialized writer. Validate → receipt check → load →
 * decide (pure) → append + project + receipt in one immediate
 * transaction → publish only after commit.
 */
export function createTransactor(deps: TransactorDeps): Transactor {
  function execute(input: unknown): CommandResult {
    return executeInternal(input, null, null, null, null);
  }

  function executeWithTransportPrincipal(
    input: unknown,
    principal: CommandTransportPrincipal,
  ): CommandResult {
    return executeInternal(input, null, null, null, principal);
  }

  function executeWithTransactionHooks(
    input: unknown,
    hooks: TransactorTransactionHooks,
  ): CommandResult {
    return executeInternal(input, null, null, hooks, null);
  }

  function executeWithChatDeliveryReservation(
    input: unknown,
    reservation: ChatDeliveryReservation,
  ): CommandResult {
    return executeInternal(input, reservation, null, null, null);
  }

  function executeWithWorkLease(input: unknown, lease: RuntimeLease): CommandResult {
    return executeInternal(input, null, lease, null, null);
  }

  function executeInternal(
    input: unknown,
    chatReservation: ChatDeliveryReservation | null,
    workLease: RuntimeLease | null,
    transactionHooks: TransactorTransactionHooks | null,
    transportPrincipal: CommandTransportPrincipal | null,
  ): CommandResult {
    const validated = validateCommand(input);
    if (!validated.ok) {
      return {
        status: "rejected",
        commandId: extractCommandId(input),
        code: validated.code,
        message: validated.message,
      };
    }
    const envelope = validated.envelope;

    if (chatReservation !== null && !reservationMatchesOffer(envelope, chatReservation)) {
      return rejected(
        envelope,
        "chat.delivery-reservation-mismatch",
        "runtime delivery authority must exactly match its durable offer command",
      );
    }
    if (workLease !== null && !leaseMatchesClaimCommand(envelope, workLease)) {
      return rejected(
        envelope,
        "work.lease-mismatch",
        "runtime work authority must exactly match its durable claim command",
      );
    }

    if (envelope.workspaceId !== deps.workspaceId) {
      return rejected(
        envelope,
        "protocol.wrong-workspace",
        `this daemon serves ${deps.workspaceId}`,
      );
    }

    const actorMismatch = validateMutationActor(envelope);
    if (actorMismatch) return actorMismatch;
    const principalMismatch = validateCommandTransportPrincipal(
      deps.db,
      envelope,
      transportPrincipal,
    );
    if (principalMismatch) return principalMismatch;

    const receipt = resolveCommandReceipt(deps.db, deps.workspaceId, envelope);
    if (receipt.kind === "resolved") return receipt.result;
    const requestHash = receipt.requestHash;

    const invalidAttachment = validateChatAttachmentBlobs(deps.db, envelope);
    if (invalidAttachment) return invalidAttachment;
    const invalidArtifactObjects = validateArtifactCreateBlobs(deps.db, envelope);
    if (invalidArtifactObjects) return invalidArtifactObjects;
    if (wouldExceedInboundChatCapacity(envelope)) {
      return rejected(
        envelope,
        "chat.delivery-backlog-limit",
        `session already has ${INBOUND_CHAT_BACKLOG_LIMIT} unresolved inbound messages; drain or split the session before sending another`,
      );
    }

    if (envelope.expected) {
      const actual = currentStreamVersion(deps.db, deps.workspaceId, envelope.expected.streamId);
      if (actual !== envelope.expected.streamVersion) {
        return rejected(
          envelope,
          "concurrency.version-conflict",
          `stream ${envelope.expected.streamId} is at version ${actual}, expected ${envelope.expected.streamVersion}`,
        );
      }
    }

    // Phase 0 replays the full log per command — honest and correct at this
    // scale. The cutover point when it hurts is per-stream state loading.
    const stored = readEvents(deps.db, deps.workspaceId, 0, Number.MAX_SAFE_INTEGER);
    const state = replay(stored.map((e) => e.payload as DomainEvent));

    const decision = decide(state, toDomainCommand(envelope));
    if (!decision.ok) {
      return {
        status: "rejected",
        commandId: envelope.commandId,
        code: decision.code,
        message: decision.message,
        details: decision.details,
      };
    }
    if (
      decision.events.some((event) => event.type === "decision.reopened") &&
      (envelope.actor.kind !== "human" || transportPrincipal?.kind === "agent")
    ) {
      return rejected(
        envelope,
        "decision.human-required",
        "only a human may reopen an addressed decision",
      );
    }
    const acceptedWorkLease =
      workLease !== null && responseClaimsLease(decision.response, workLease) ? workLease : null;

    const recordedAt = deps.now();
    const tx = deps.db.transaction((): { result: CommandResult; committed: EventEnvelope[] } => {
      const guarded = transactionHooks?.beforeMutation() ?? null;
      if (guarded !== null) return { result: guarded, committed: [] };
      const pendingInbound = pendingInboundSessionTransition(deps.db, envelope);
      if (pendingInbound !== null) return { result: pendingInbound, committed: [] };
      const committed: EventEnvelope[] = [];
      for (const event of decision.events) {
        const stream = streamOf(event);
        committed.push(
          appendEvent(deps.db, deps.workspaceId, {
            eventId: deps.newEventId(),
            streamType: stream.streamType,
            streamId: stream.streamId,
            eventType: event.type,
            schemaVersion: EVENT_SCHEMA_VERSION,
            recordedAt,
            actor: envelope.actor,
            causationId: envelope.commandId,
            correlationId: envelope.commandId,
            payload: event,
          }),
        );
      }
      deps.failureInjection?.("after-events");
      for (const envelopeStored of committed) {
        applyProjections(deps.db, envelopeStored);
        const payload = envelopeStored.payload as Record<string, unknown>;
        if (
          ["work.addressed", "work.claim-released", "work.abandoned"].includes(
            envelopeStored.eventType,
          )
        ) {
          deps.db
            .prepare("DELETE FROM runtime_leases WHERE work_id = ? AND claim_id = ?")
            .run(payload.workId, payload.claimId);
        }
        if (["chat.delivery-paused", "chat.delivery-resumed"].includes(envelopeStored.eventType)) {
          deps.db
            .prepare("DELETE FROM runtime_chat_deliveries WHERE message_id = ?")
            .run(payload.messageId);
        }
      }
      applySessionRuntimeAuthority(deps.db, {
        workspaceId: deps.workspaceId,
        daemonStartNonce: deps.daemonStartNonce ?? "in-process-daemon",
        envelope,
        recordedAt,
      });
      deps.failureInjection?.("after-projections");
      if (chatReservation !== null) writeChatDeliveryReservation(chatReservation);
      if (acceptedWorkLease !== null) writeLease(acceptedWorkLease);
      const first = committed[0];
      const last = committed[committed.length - 1];
      const result: CommandAccepted = {
        status: "accepted",
        commandId: envelope.commandId,
        firstEventSeq: first?.seq ?? null,
        lastEventSeq: last?.seq ?? null,
        response: decision.response,
      };
      putReceipt(
        deps.db,
        deps.workspaceId,
        envelope.idempotencyKey,
        envelope.commandId,
        result.firstEventSeq,
        result.lastEventSeq,
        result,
        requestHash,
        recordedAt,
      );
      deps.failureInjection?.("after-receipt");
      transactionHooks?.afterAccepted(result);
      return { result, committed };
    });
    const { result, committed } = tx.immediate();

    if (committed.length > 0) deps.onCommitted(committed);
    return result;
  }

  function writeLease(lease: RuntimeLease): void {
    deps.db
      .prepare(
        `INSERT INTO runtime_leases (
           work_id, claim_id, agent_id, process_nonce, request_capability_hash,
           expires_at, last_heartbeat
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(work_id) DO UPDATE SET
           claim_id = excluded.claim_id,
           agent_id = excluded.agent_id,
           process_nonce = excluded.process_nonce,
           request_capability_hash = excluded.request_capability_hash,
           expires_at = excluded.expires_at,
           last_heartbeat = excluded.last_heartbeat`,
      )
      .run(
        lease.workId,
        lease.claimId,
        lease.agentId,
        lease.processNonce,
        lease.requestCapabilityHash,
        lease.expiresAt,
        lease.lastHeartbeat,
      );
  }

  function restoreHistory(input: RestoreHistoryInput): readonly EventEnvelope[] {
    const eventCount = deps.db.prepare("SELECT COUNT(*) AS count FROM events").get() as {
      count: number;
    };
    if (eventCount.count !== 0) {
      throw new Error("workspace restore requires an empty destination event store");
    }
    const tx = deps.db.transaction(() => {
      for (const blob of input.blobs) {
        deps.db
          .prepare(
            "INSERT INTO blobs (hash, byte_length, media_type, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(blob.hash, blob.byteLength, blob.mediaType, blob.createdAt);
      }
      const committed: EventEnvelope[] = [];
      for (const source of input.events) {
        const stored = appendEvent(deps.db, deps.workspaceId, {
          eventId: source.eventId,
          streamType: source.streamType,
          streamId: source.streamId,
          eventType: source.eventType,
          schemaVersion: source.schemaVersion,
          recordedAt: source.recordedAt,
          actor: source.actor,
          causationId: source.causationId,
          correlationId: source.correlationId,
          payload: source.payload,
        });
        if (stored.seq !== source.seq || stored.streamVersion !== source.streamVersion) {
          throw new Error(`restored event order diverged at source seq ${source.seq}`);
        }
        applyProjections(deps.db, stored);
        committed.push(stored);
      }
      const overloaded = deps.db
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
          `workspace restore exceeds inbound chat limit for ${overloaded.session_id}: ${overloaded.count}`,
        );
      }
      return committed;
    });
    const committed = tx.immediate();
    if (committed.length > 0) deps.onCommitted(committed);
    return committed;
  }

  function heartbeatLease(input: LeaseHeartbeat): boolean {
    const result = deps.db
      .prepare(
        `UPDATE runtime_leases
         SET expires_at = ?, last_heartbeat = ?
         WHERE work_id = ? AND claim_id = ? AND agent_id = ?
           AND process_nonce = ? AND expires_at > ?`,
      )
      .run(
        input.expiresAt,
        input.nowMs,
        input.workId,
        input.claimId,
        input.agentId,
        input.processNonce,
        input.nowMs,
      );
    return result.changes === 1;
  }

  function leaseIsRecoverable(workId: string, claimId: string, nowMs: number): boolean {
    const row = deps.db
      .prepare("SELECT claim_id, expires_at FROM runtime_leases WHERE work_id = ?")
      .get(workId) as { claim_id: string; expires_at: number } | undefined;
    return row === undefined || row.claim_id !== claimId || row.expires_at <= nowMs;
  }

  function leaseMatches(
    workId: string,
    claimId: string,
    agentId: string,
    processNonce: string,
    nowMs: number,
  ): boolean {
    const row = deps.db
      .prepare(
        `SELECT 1 AS present FROM runtime_leases
         WHERE work_id = ? AND claim_id = ? AND agent_id = ? AND process_nonce = ?
           AND expires_at > ?`,
      )
      .get(workId, claimId, agentId, processNonce, nowMs) as { present: number } | undefined;
    return row !== undefined;
  }

  function writeChatDeliveryReservation(reservation: ChatDeliveryReservation): void {
    deps.db
      .prepare("DELETE FROM runtime_chat_deliveries WHERE message_id = ?")
      .run(reservation.messageId);
    deps.db
      .prepare(
        `INSERT INTO runtime_chat_deliveries (
           attempt_id, message_id, workspace_id, session_id, recipient_agent_id,
           process_nonce, attempt_number, capability_hash, offered_at, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        reservation.attemptId,
        reservation.messageId,
        reservation.workspaceId,
        reservation.sessionId,
        reservation.recipientAgentId,
        reservation.processNonce,
        reservation.attemptNumber,
        reservation.capabilityHash,
        reservation.offeredAt,
        reservation.expiresAt,
      );
  }

  function chatDeliveryReservation(attemptId: string): ChatDeliveryReservation | null {
    const row = deps.db
      .prepare("SELECT * FROM runtime_chat_deliveries WHERE attempt_id = ?")
      .get(attemptId) as
      | {
          attempt_id: string;
          message_id: string;
          workspace_id: string;
          session_id: string;
          recipient_agent_id: string;
          process_nonce: string;
          attempt_number: number;
          capability_hash: string;
          offered_at: number;
          expires_at: number;
        }
      | undefined;
    return row
      ? {
          attemptId: row.attempt_id,
          messageId: row.message_id,
          workspaceId: row.workspace_id,
          sessionId: row.session_id,
          recipientAgentId: row.recipient_agent_id,
          processNonce: row.process_nonce,
          attemptNumber: row.attempt_number,
          capabilityHash: row.capability_hash,
          offeredAt: row.offered_at,
          expiresAt: row.expires_at,
        }
      : null;
  }

  function wouldExceedInboundChatCapacity(envelope: CommandEnvelope): boolean {
    if (envelope.type !== "chat.send" || envelope.actor.kind !== "human") return false;
    const payload = envelope.payload as Record<string, unknown>;
    const content = chatContentOrText(
      payload.content as ChatContent | undefined,
      typeof payload.text === "string" ? payload.text : "",
    );
    if (
      content.type !== "text" ||
      typeof payload.sessionId !== "string" ||
      payload.workId != null ||
      payload.intentId != null
    ) {
      return false;
    }
    return (
      deps.db
        .prepare(
          `SELECT 1 AS present
           FROM p_chat INDEXED BY p_chat_inbound_candidates
           WHERE session_id = ? AND inbound_candidate = 1
           LIMIT 1 OFFSET ?`,
        )
        .get(payload.sessionId, INBOUND_CHAT_BACKLOG_LIMIT - 1) !== undefined
    );
  }

  return {
    execute,
    executeWithTransportPrincipal,
    executeWithTransactionHooks,
    executeWithChatDeliveryReservation,
    executeWithWorkLease,
    restoreHistory,
    heartbeatLease,
    leaseIsRecoverable,
    leaseMatches,
    chatDeliveryReservation,
  };
}

function pendingInboundSessionTransition(db: Db, envelope: CommandEnvelope): CommandResult | null {
  if (envelope.type !== "session.handoff" && envelope.type !== "session.end") return null;
  const payload = envelope.payload as Record<string, unknown>;
  const sessionId = payload.sessionId as string;
  const rows = db
    .prepare(
      `SELECT message_id
       FROM p_chat INDEXED BY p_chat_inbound_candidates
       WHERE session_id = ? AND inbound_candidate = 1
       ORDER BY created_seq`,
    )
    .all(sessionId) as readonly { message_id: string }[];
  if (rows.length === 0) return null;
  const pendingMessageIds = rows.map((row) => row.message_id);
  return {
    status: "rejected",
    commandId: envelope.commandId,
    code: "session.inbound-pending",
    message: `session ${sessionId} has ${rows.length} unresolved inbound chat candidate(s); acknowledge or recover them before ${envelope.type}`,
    details: {
      sessionId,
      pendingCount: rows.length,
      pendingMessageIds,
    },
  };
}

function leaseMatchesClaimCommand(envelope: CommandEnvelope, lease: RuntimeLease): boolean {
  if (envelope.type !== "work.claim" && envelope.type !== "work.reclaim") return false;
  const payload = envelope.payload as Record<string, unknown>;
  return (
    envelope.actor.kind === "agent" &&
    envelope.actor.id === lease.agentId &&
    payload.workId === lease.workId &&
    payload.claimId === lease.claimId &&
    payload.agentId === lease.agentId &&
    Number.isSafeInteger(lease.lastHeartbeat) &&
    Number.isSafeInteger(lease.expiresAt) &&
    lease.expiresAt > lease.lastHeartbeat
  );
}

function responseClaimsLease(response: unknown, lease: RuntimeLease): boolean {
  if (typeof response !== "object" || response === null) return false;
  const value = response as Record<string, unknown>;
  return (
    value.status === "claimed" &&
    value.workId === lease.workId &&
    value.claimId === lease.claimId &&
    value.agentId === lease.agentId
  );
}

function reservationMatchesOffer(
  envelope: CommandEnvelope,
  reservation: ChatDeliveryReservation,
): boolean {
  if (envelope.type !== "chat.delivery-offer") return false;
  const payload = envelope.payload as Record<string, unknown>;
  return (
    envelope.workspaceId === reservation.workspaceId &&
    payload.messageId === reservation.messageId &&
    payload.sessionId === reservation.sessionId &&
    payload.agentId === reservation.recipientAgentId &&
    payload.processNonce === reservation.processNonce &&
    payload.attemptId === reservation.attemptId &&
    payload.attemptNumber === reservation.attemptNumber
  );
}

function rejected(envelope: CommandEnvelope, code: string, message: string): CommandResult {
  return { status: "rejected", commandId: envelope.commandId, code, message };
}

function extractCommandId(input: unknown): string {
  if (input && typeof input === "object" && "commandId" in input) {
    const id = (input as { commandId: unknown }).commandId;
    if (typeof id === "string") return id;
  }
  return "unknown";
}

function toDomainCommand(envelope: CommandEnvelope): DomainCommand {
  const payload = envelope.payload as Record<string, unknown>;
  switch (envelope.type) {
    case "workspace.open":
      return {
        type: "workspace.open",
        workspaceId: envelope.workspaceId,
        projectId: payload.projectId as string,
        rootPath: payload.rootPath as string,
      };
    case "artifact.register":
      return {
        type: "artifact.register",
        artifactId: payload.artifactId as string,
        name: payload.name as string,
        format: payload.format as "html" | "markdown" | "whiteboard",
        sourcePath: (payload.sourcePath as string | undefined) ?? null,
        provenance: payload.provenance as
          | {
              kind: "workspace-source" | "imported-snapshot" | "generated";
              originalName?: string;
            }
          | undefined,
      };
    case "artifact.create":
      return {
        type: "artifact.create",
        artifactId: payload.artifactId as string,
        name: payload.name as string,
        format: payload.format as "html" | "markdown" | "whiteboard",
        sourcePath: (payload.sourcePath as string | null | undefined) ?? null,
        provenance: payload.provenance as {
          kind: "workspace-source" | "imported-snapshot" | "generated";
          originalName?: string;
        },
        revisionId: payload.revisionId as string,
        entryPath: payload.entryPath as string,
        entryHash: payload.entryHash as string,
        files: payload.files as RevisionFile[],
        producer: payload.producer as ActorRef,
        attachment: payload.attachment as {
          sessionId: string;
          role: "primary" | "opened" | "whiteboard";
        } | null,
      };
    case "session.open-artifact":
      return {
        type: "session.open-artifact",
        sessionId: payload.sessionId as string,
        artifactId: payload.artifactId as string,
        name: payload.name as string,
        format: payload.format as "html" | "markdown" | "whiteboard",
        sourcePath: payload.sourcePath as string,
        provenance: payload.provenance as {
          kind: "workspace-source" | "imported-snapshot" | "generated";
          originalName?: string;
        },
        revisionId: payload.revisionId as string,
        entryPath: payload.entryPath as string,
        entryHash: payload.entryHash as string,
        files: payload.files as RevisionFile[],
        producer: payload.producer as ActorRef,
        role: payload.role as "primary" | "opened" | "whiteboard",
      };
    case "artifact.publish":
      return {
        type: "artifact.publish",
        artifactId: payload.artifactId as string,
        revisionId: payload.revisionId as string,
        format: payload.format as "html" | "markdown" | "whiteboard",
        entryPath: payload.entryPath as string,
        entryHash: payload.entryHash as string,
        files: payload.files as RevisionFile[],
        producer: payload.producer as ActorRef,
        sourcePath: (payload.sourcePath as string | undefined) ?? null,
        sessionId: (payload.sessionId as string | null | undefined) ?? null,
      };
    case "review.submit-batch":
      return {
        type: "review.submit-batch",
        batchId: payload.batchId as string,
        workId: payload.workId as string,
        artifactId: payload.artifactId as string,
        revisionId: payload.revisionId as string,
        intents: payload.intents as IntentInput[],
        sourceMessageId: (payload.sourceMessageId as string | null | undefined) ?? null,
        assigneeAgentId: (payload.assigneeAgentId as string | null | undefined) ?? null,
        sessionId: (payload.sessionId as string | null | undefined) ?? null,
      };
    case "review.submit-comments":
      return {
        type: "review.submit-comments",
        batchId: payload.batchId as string,
        artifactId: payload.artifactId as string,
        revisionId: payload.revisionId as string,
        intents: payload.intents as IntentInput[],
        assigneeAgentId: (payload.assigneeAgentId as string | null | undefined) ?? null,
        sessionId: (payload.sessionId as string | null | undefined) ?? null,
      };
    case "work.create-from-intents":
      return {
        type: "work.create-from-intents",
        workId: payload.workId as string,
        intentIds: payload.intentIds as string[],
        decisionId: payload.decisionId as string,
        reason: payload.reason as string,
        assigneeAgentId: (payload.assigneeAgentId as string | null | undefined) ?? null,
        sessionId: (payload.sessionId as string | null | undefined) ?? null,
      };
    case "work.claim":
      return {
        type: "work.claim",
        claimId: payload.claimId as string,
        agentId: payload.agentId as string,
        workId: (payload.workId as string | null | undefined) ?? null,
      };
    case "work.complete":
      return {
        type: "work.complete",
        workId: payload.workId as string,
        claimId: payload.claimId as string,
        agentId: payload.agentId as string,
        summary: payload.summary as string,
        revisionId: (payload.revisionId as string | undefined) ?? null,
        addressedIntentIds: (payload.addressedIntentIds as string[] | undefined) ?? null,
      };
    case "work.progress":
      return {
        type: "work.progress",
        workId: payload.workId as string,
        claimId: payload.claimId as string,
        agentId: payload.agentId as string,
        summary: payload.summary as string,
        revisionId: (payload.revisionId as string | null | undefined) ?? null,
        addressedIntentIds: (payload.addressedIntentIds as string[] | undefined) ?? [],
        releaseClaim: (payload.releaseClaim as boolean | undefined) ?? false,
      };
    case "work.reclaim":
      return {
        type: "work.reclaim",
        workId: payload.workId as string,
        staleClaimId: payload.staleClaimId as string,
        claimId: payload.claimId as string,
        agentId: payload.agentId as string,
      };
    case "decision.accept":
      return {
        type: "decision.accept",
        decisionId: payload.decisionId as string,
        workId: payload.workId as string,
        reason: (payload.reason as string | null | undefined) ?? null,
        actor: envelope.actor,
      };
    case "decision.reopen":
      return {
        type: "decision.reopen",
        decisionId: payload.decisionId as string,
        workId: payload.workId as string,
        reason: payload.reason as string,
        actor: envelope.actor,
      };
    case "chat.send": {
      const content = chatContentOrText(
        payload.content as ChatContent | undefined,
        typeof payload.text === "string" ? payload.text : "",
      );
      return {
        type: "chat.send",
        messageId: payload.messageId as string,
        artifactId: (payload.artifactId as string | null | undefined) ?? null,
        // Authorship comes from the authenticated envelope, never the payload.
        author: `${envelope.actor.kind}:${envelope.actor.id}`,
        text: typeof payload.text === "string" ? payload.text : chatContentText(content),
        content,
        actor: envelope.actor,
        context: (payload.context as ChatContext | undefined) ?? null,
        mentions: (payload.mentions as string[] | undefined) ?? [],
        references: (payload.references as ChatReference[] | undefined) ?? [],
        attachments: (payload.attachments as ChatAttachment[] | undefined) ?? [],
        sessionId: (payload.sessionId as string | null | undefined) ?? null,
        recipientAgentId: (payload.recipientAgentId as string | null | undefined) ?? null,
        threadId: (payload.threadId as string | null | undefined) ?? null,
        workId: (payload.workId as string | null | undefined) ?? null,
        intentId: (payload.intentId as string | null | undefined) ?? null,
      };
    }
    case "chat.delivery-offer":
      return {
        type: "chat.delivery-offer",
        messageId: payload.messageId as string,
        sessionId: payload.sessionId as string,
        agentId: payload.agentId as string,
        processNonce: payload.processNonce as string,
        attemptId: payload.attemptId as string,
        attemptNumber: payload.attemptNumber as number,
        offeredAt: payload.offeredAt as string,
      };
    case "chat.delivery-acknowledge":
      return {
        type: "chat.delivery-acknowledge",
        messageId: payload.messageId as string,
        sessionId: payload.sessionId as string,
        agentId: payload.agentId as string,
        processNonce: payload.processNonce as string,
        attemptId: payload.attemptId as string,
        acknowledgedAt: payload.acknowledgedAt as string,
      };
    case "chat.delivery-pause":
      return {
        type: "chat.delivery-pause",
        messageId: payload.messageId as string,
        attemptId: payload.attemptId as string,
        pausedAt: payload.pausedAt as string,
        reason: payload.reason as "retry-budget-exhausted",
      };
    case "chat.delivery-resume":
      return {
        type: "chat.delivery-resume",
        messageId: payload.messageId as string,
        resumedAt: payload.resumedAt as string,
      };
    case "session.start":
      return {
        type: "session.start",
        sessionId: payload.sessionId as string,
        artifactId: (payload.artifactId as string | null | undefined) ?? null,
        agentId: payload.agentId as string,
        processNonce: payload.processNonce as string,
        ...(typeof payload.runtimeCapabilityHash === "string"
          ? { runtimeCapabilityHash: payload.runtimeCapabilityHash }
          : {}),
        baseRevisionId: (payload.baseRevisionId as string | null | undefined) ?? null,
        title: payload.title as string,
        goal: payload.goal as string,
      };
    case "session.attach-artifact":
      return {
        type: "session.attach-artifact",
        sessionId: payload.sessionId as string,
        artifactId: payload.artifactId as string,
        revisionId: payload.revisionId as string,
        role: payload.role as "primary" | "opened" | "whiteboard",
      };
    case "session.handoff":
      return {
        type: "session.handoff",
        sessionId: payload.sessionId as string,
        agentId: payload.agentId as string,
        toAgentId: payload.toAgentId as string,
        summary: payload.summary as string,
      };
    case "session.resume":
      return {
        type: "session.resume",
        sessionId: payload.sessionId as string,
        predecessorSessionId: payload.predecessorSessionId as string,
        agentId: payload.agentId as string,
        processNonce: payload.processNonce as string,
        ...(typeof payload.runtimeCapabilityHash === "string"
          ? { runtimeCapabilityHash: payload.runtimeCapabilityHash }
          : {}),
        baseRevisionId: (payload.baseRevisionId as string | null | undefined) ?? null,
        title: (payload.title as string | null | undefined) ?? null,
        goal: (payload.goal as string | null | undefined) ?? null,
      };
    case "session.end":
      return {
        type: "session.end",
        sessionId: payload.sessionId as string,
        agentId: payload.agentId as string,
        summary: payload.summary as string,
      };
    default:
      // validateCommand guarantees a known type; keep the guard explicit.
      throw new Error(`unmapped command type: ${envelope.type}`);
  }
}

function validateChatAttachmentBlobs(db: Db, envelope: CommandEnvelope): CommandResult | null {
  if (envelope.type !== "chat.send") return null;
  const payload = envelope.payload as Record<string, unknown>;
  const attachments = (payload.attachments as ChatAttachment[] | undefined) ?? [];
  for (const attachment of attachments) {
    const blob = db
      .prepare("SELECT byte_length, media_type FROM blobs WHERE hash = ?")
      .get(attachment.hash) as { byte_length: number; media_type: string } | undefined;
    if (!blob) {
      return rejected(
        envelope,
        "attachment.unknown",
        `attachment bytes are missing for hash ${attachment.hash}`,
      );
    }
    if (blob.byte_length !== attachment.byteLength || blob.media_type !== attachment.mediaType) {
      return rejected(
        envelope,
        "attachment.metadata-mismatch",
        `attachment metadata does not match stored blob ${attachment.hash}`,
      );
    }
  }
  return null;
}

function validateArtifactCreateBlobs(db: Db, envelope: CommandEnvelope): CommandResult | null {
  if (envelope.type !== "artifact.create" && envelope.type !== "session.open-artifact") return null;
  const payload = envelope.payload as Record<string, unknown>;
  const files = payload.files as RevisionFile[];
  for (const file of files) {
    const blob = db.prepare("SELECT media_type FROM blobs WHERE hash = ?").get(file.hash) as
      | { media_type: string }
      | undefined;
    if (!blob) {
      return rejected(
        envelope,
        "artifact.object-missing",
        `artifact object is missing for hash ${file.hash}`,
      );
    }
    if (blob.media_type !== file.mediaType) {
      return rejected(
        envelope,
        "artifact.object-metadata-mismatch",
        `artifact object media type does not match stored blob ${file.hash}`,
      );
    }
  }
  return null;
}

export function validateCommandTransportPrincipal(
  db: Db,
  envelope: CommandEnvelope,
  principal: CommandTransportPrincipal | null,
): CommandResult | null {
  if (principal === null || principal.kind === "human") {
    return null;
  }
  const promotionMismatch = validateAgentChatPromotionAuthority(db, envelope);
  if (promotionMismatch !== undefined) return promotionMismatch;
  if (envelope.actor.kind !== "human" && !requiresBrowserHuman(envelope)) return null;
  return rejected(
    envelope,
    "authority.browser-human-required",
    "human authority requires an authenticated browser context",
  );
}

function validateAgentChatPromotionAuthority(
  db: Db,
  envelope: CommandEnvelope,
): CommandResult | null | undefined {
  if (envelope.type !== "review.submit-batch" || envelope.actor.kind !== "agent") {
    return undefined;
  }
  const payload = envelope.payload as Record<string, unknown>;
  const sourceMessageId = payload.sourceMessageId;
  if (typeof sourceMessageId !== "string") return undefined;

  const source = db
    .prepare(
      `SELECT author, recipient_agent_id
       FROM p_chat
       WHERE message_id = ?`,
    )
    .get(sourceMessageId) as
    | Readonly<{ author: string; recipient_agent_id: string | null }>
    | undefined;
  if (source === undefined) {
    return rejected(envelope, "chat.message-unknown", `unknown chat message: ${sourceMessageId}`);
  }
  if (source.author !== "human:browser") {
    return rejected(
      envelope,
      "chat.message-agent-authored",
      `only a browser-authored human chat message may be promoted by its recipient agent`,
    );
  }
  if (
    source.recipient_agent_id === null ||
    envelope.actor.id !== source.recipient_agent_id ||
    payload.assigneeAgentId !== source.recipient_agent_id
  ) {
    return rejected(
      envelope,
      "chat.message-recipient-mismatch",
      `chat message ${sourceMessageId} may only be promoted by its assigned recipient agent`,
    );
  }
  return null;
}

function requiresBrowserHuman(envelope: CommandEnvelope): boolean {
  if (
    [
      "decision.accept",
      "decision.reopen",
      "review.submit-batch",
      "review.submit-comments",
      "chat.delivery-resume",
    ].includes(envelope.type)
  ) {
    return true;
  }
  if (envelope.type !== "chat.send") return false;
  const payload = envelope.payload as Record<string, unknown>;
  const content = payload.content;
  return (
    content !== null &&
    typeof content === "object" &&
    (content as { type?: unknown }).type === "choice-answer"
  );
}

function validateMutationActor(envelope: CommandEnvelope): CommandResult | null {
  if (
    [
      "work.claim",
      "work.complete",
      "work.progress",
      "work.reclaim",
      "chat.delivery-offer",
      "chat.delivery-acknowledge",
      "session.start",
      "session.handoff",
      "session.resume",
      "session.end",
    ].includes(envelope.type)
  ) {
    const payload = envelope.payload as Record<string, unknown>;
    if (envelope.actor.kind !== "agent" || payload.agentId !== envelope.actor.id) {
      return rejected(
        envelope,
        "protocol.actor-mismatch",
        "agent mutations require an agent actor matching payload.agentId",
      );
    }
  }
  if (envelope.type === "chat.delivery-pause" && envelope.actor.kind !== "system") {
    return rejected(
      envelope,
      "chat.delivery-system-required",
      "only the daemon may pause exhausted delivery",
    );
  }
  if (envelope.type === "chat.delivery-resume" && envelope.actor.kind !== "human") {
    return rejected(
      envelope,
      "chat.delivery-human-required",
      "only a human may resume paused delivery",
    );
  }
  if (
    ["decision.accept", "decision.reopen"].includes(envelope.type) &&
    envelope.actor.kind !== "human"
  ) {
    return rejected(
      envelope,
      "decision.human-required",
      "only a human actor may accept or reopen work",
    );
  }
  return null;
}
