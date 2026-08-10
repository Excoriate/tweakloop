import { type ChatContent, type ChatReference, chatContentOrText } from "../protocol/chat.js";
import type { EventEnvelope } from "../protocol/envelopes.js";
import type {
  SessionArtifactRecord,
  SessionRecord,
  SessionStatus,
} from "../protocol/session-lineage.js";
import type {
  Snapshot,
  SnapshotChatMessage,
  SnapshotIntent,
  SnapshotRevision,
  SnapshotWork,
} from "../protocol/snapshot.js";
import { SESSION_QUERY_PROTOCOL, SNAPSHOT_PROTOCOL } from "../protocol/versions.js";
import type { Db } from "../storage/sqlite/db.js";
import { lastSeq, readEvents } from "../storage/sqlite/event-store.js";

const PROJECTION_TABLES = [
  "p_artifacts",
  "p_revisions",
  "p_intents",
  "p_work",
  "p_chat",
  "p_sessions",
  "p_session_artifacts",
  "p_timeline",
];

/**
 * Projections are disposable derived state. Reducers must be
 * deterministic: rebuildProjections() from the event log must produce
 * exactly what incremental application produced.
 */

export function applyProjections(db: Db, envelope: EventEnvelope): void {
  const payload = envelope.payload as Record<string, unknown>;
  switch (envelope.eventType) {
    case "artifact.registered":
      db.prepare(
        `INSERT INTO p_artifacts (
           artifact_id, name, format, source_path, registered_seq, provenance_json
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        payload.artifactId,
        payload.name,
        payload.format,
        payload.sourcePath ?? null,
        envelope.seq,
        JSON.stringify(
          payload.provenance ??
            (payload.sourcePath == null
              ? { kind: "imported-snapshot" }
              : { kind: "workspace-source" }),
        ),
      );
      break;
    case "artifact.revision-published":
      db.prepare(
        `INSERT INTO p_revisions (
           revision_id, artifact_id, parent_id, seq, format, entry_path,
           entry_hash, files_json, producer_json, source_path, created_seq, session_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        payload.revisionId,
        payload.artifactId,
        payload.parentId ?? null,
        payload.seq,
        payload.format,
        payload.entryPath,
        payload.entryHash,
        JSON.stringify(payload.files),
        JSON.stringify(payload.producer),
        payload.sourcePath ?? null,
        envelope.seq,
        payload.sessionId ?? null,
      );
      break;
    case "session.started":
      db.prepare(
        `INSERT INTO p_sessions (
           session_id, artifact_id, originating_agent_id, agent_id, process_nonce,
           status, base_revision_id, title, goal, predecessor_session_id,
           handoff_summary, created_at, last_active_at, created_seq, last_seq
         ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        payload.sessionId,
        payload.artifactId,
        payload.originatingAgentId,
        payload.agentId,
        payload.processNonce,
        payload.baseRevisionId ?? null,
        payload.title,
        payload.goal,
        payload.predecessorSessionId ?? null,
        payload.handoffSummary ?? null,
        envelope.recordedAt,
        envelope.recordedAt,
        envelope.seq,
        envelope.seq,
      );
      if (typeof payload.artifactId === "string") {
        const revisionId =
          typeof payload.baseRevisionId === "string"
            ? payload.baseRevisionId
            : (
                db
                  .prepare(
                    `SELECT revision_id FROM p_revisions
                     WHERE artifact_id = ? AND created_seq <= ?
                     ORDER BY seq DESC LIMIT 1`,
                  )
                  .get(payload.artifactId, envelope.seq) as { revision_id: string } | undefined
              )?.revision_id;
        if (revisionId !== undefined) {
          db.prepare(
            `INSERT OR IGNORE INTO p_session_artifacts (
               session_id, artifact_id, attached_revision_id, role, attached_seq
             ) VALUES (?, ?, ?, 'primary', ?)`,
          ).run(payload.sessionId, payload.artifactId, revisionId, envelope.seq);
        }
      }
      break;
    case "session.artifact-attached":
      db.prepare(
        `INSERT INTO p_session_artifacts (
           session_id, artifact_id, attached_revision_id, role, attached_seq
         ) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id, artifact_id) DO UPDATE SET
           attached_revision_id = excluded.attached_revision_id,
           role = excluded.role,
           attached_seq = excluded.attached_seq`,
      ).run(payload.sessionId, payload.artifactId, payload.revisionId, payload.role, envelope.seq);
      if (payload.role === "primary") {
        db.prepare("UPDATE p_sessions SET artifact_id = ? WHERE session_id = ?").run(
          payload.artifactId,
          payload.sessionId,
        );
      }
      break;
    case "session.handoff-offered":
      db.prepare(
        `UPDATE p_sessions
         SET status = 'handed-off', handoff_to_agent_id = ?, handoff_summary = ?,
             last_active_at = ?, last_seq = ?
         WHERE session_id = ?`,
      ).run(
        payload.toAgentId,
        payload.summary,
        envelope.recordedAt,
        envelope.seq,
        payload.sessionId,
      );
      break;
    case "session.ended":
      db.prepare(
        `UPDATE p_sessions
         SET status = 'ended', summary = ?, ended_at = ?, last_active_at = ?, last_seq = ?
         WHERE session_id = ?`,
      ).run(
        payload.summary,
        envelope.recordedAt,
        envelope.recordedAt,
        envelope.seq,
        payload.sessionId,
      );
      break;
    case "intent.created":
      db.prepare(
        `INSERT INTO p_intents (
           intent_id, batch_id, artifact_id, revision_id, intent_type,
           target_json, body_json, status, created_seq
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)`,
      ).run(
        payload.intentId,
        payload.batchId,
        payload.artifactId,
        payload.revisionId,
        payload.intentType,
        JSON.stringify(payload.target),
        JSON.stringify(payload.body),
        envelope.seq,
      );
      if (typeof payload.sourceMessageId === "string") {
        db.prepare(
          "UPDATE p_chat SET intent_id = ?, inbound_candidate = 0 WHERE message_id = ?",
        ).run(payload.intentId, payload.sourceMessageId);
      }
      break;
    case "work.created":
      db.prepare(
        `INSERT INTO p_work (
           work_id, artifact_id, base_revision_id, intent_ids_json,
           status, claim_json, result_json, created_seq,
           assignee_agent_id, session_id, progress_json, decision_status
         ) VALUES (?, ?, ?, ?, 'open', NULL, NULL, ?, ?, ?, '[]', 'pending')`,
      ).run(
        payload.workId,
        payload.artifactId,
        payload.baseRevisionId,
        JSON.stringify(payload.intentIds),
        envelope.seq,
        payload.assigneeAgentId ?? null,
        payload.sessionId ?? null,
      );
      if (typeof payload.sourceMessageId === "string") {
        db.prepare("UPDATE p_chat SET work_id = ?, inbound_candidate = 0 WHERE message_id = ?").run(
          payload.workId,
          payload.sourceMessageId,
        );
      }
      break;
    case "work.claimed":
      db.prepare("UPDATE p_work SET status = 'claimed', claim_json = ? WHERE work_id = ?").run(
        JSON.stringify({ claimId: payload.claimId, agentId: payload.agentId }),
        payload.workId,
      );
      break;
    case "chat.message": {
      const content = chatContentOrText(
        payload.content as ChatContent | undefined,
        String(payload.text ?? ""),
      );
      db.prepare(
        `INSERT INTO p_chat (
           message_id, artifact_id, author, text, context_json, mentions_json,
           recorded_at, created_seq, session_id, recipient_agent_id, thread_id,
           work_id, intent_id, references_json, attachments_json, inbound_candidate,
           content_json, reply_to_message_id, supersedes_message_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        payload.messageId,
        payload.artifactId ?? null,
        payload.author,
        payload.text,
        payload.context == null ? null : JSON.stringify(payload.context),
        JSON.stringify(payload.mentions ?? []),
        envelope.recordedAt,
        envelope.seq,
        payload.sessionId ?? null,
        payload.recipientAgentId ?? null,
        payload.threadId ?? null,
        payload.workId ?? null,
        payload.intentId ?? null,
        JSON.stringify(payload.references ?? []),
        JSON.stringify(payload.attachments ?? []),
        typeof payload.author === "string" &&
          payload.author.startsWith("human:") &&
          content.type === "text" &&
          payload.sessionId != null &&
          payload.workId == null &&
          payload.intentId == null
          ? 1
          : 0,
        JSON.stringify(content),
        content.type === "choice-answer" ? content.questionMessageId : null,
        content.type === "choice-answer" ? content.supersedesAnswerMessageId : null,
      );
      break;
    }
    case "chat.delivery-offered":
      db.prepare(
        `UPDATE p_chat
         SET delivery_status = 'offered', delivery_attempt_id = ?,
             delivery_attempt_number = ?, delivery_agent_id = ?, delivery_offered_at = ?,
             delivery_acknowledged_at = NULL, delivery_paused_at = NULL,
             delivery_pause_reason = NULL
         WHERE message_id = ?`,
      ).run(
        payload.attemptId,
        payload.attemptNumber,
        payload.agentId,
        payload.offeredAt,
        payload.messageId,
      );
      break;
    case "chat.delivery-acknowledged":
      db.prepare(
        `UPDATE p_chat
         SET delivery_status = 'acknowledged', delivery_acknowledged_at = ?,
             delivery_paused_at = NULL, delivery_pause_reason = NULL,
             inbound_candidate = 0
         WHERE message_id = ? AND delivery_attempt_id = ?`,
      ).run(payload.acknowledgedAt, payload.messageId, payload.attemptId);
      break;
    case "chat.delivery-paused":
      db.prepare(
        `UPDATE p_chat
         SET delivery_status = 'paused', delivery_paused_at = ?,
             delivery_acknowledged_at = NULL, delivery_pause_reason = ?,
             inbound_candidate = 0
         WHERE message_id = ? AND delivery_attempt_id = ?`,
      ).run(payload.pausedAt, payload.reason, payload.messageId, payload.attemptId);
      break;
    case "chat.delivery-resumed":
      db.prepare(
        `UPDATE p_chat
         SET delivery_status = NULL, delivery_attempt_id = NULL,
             delivery_attempt_number = 0, delivery_agent_id = NULL,
             delivery_offered_at = NULL, delivery_acknowledged_at = NULL,
             delivery_paused_at = NULL, delivery_pause_reason = NULL,
             inbound_candidate = 1
         WHERE message_id = ?`,
      ).run(payload.messageId);
      break;
    case "work.progressed": {
      appendProgress(db, envelope, payload);
      for (const intentId of payload.addressedIntentIds as string[]) {
        db.prepare("UPDATE p_intents SET status = 'addressed' WHERE intent_id = ?").run(intentId);
      }
      break;
    }
    case "work.claim-released":
    case "work.abandoned":
      db.prepare("UPDATE p_work SET status = 'open', claim_json = NULL WHERE work_id = ?").run(
        payload.workId,
      );
      break;
    case "work.addressed": {
      db.prepare(
        "UPDATE p_work SET status = 'addressed', claim_json = NULL, result_json = ?, decision_status = 'pending' WHERE work_id = ?",
      ).run(
        JSON.stringify({
          summary: payload.summary,
          revisionId: payload.revisionId ?? null,
          agentId: payload.agentId,
        }),
        payload.workId,
      );
      for (const intentId of payload.addressedIntentIds as string[]) {
        db.prepare("UPDATE p_intents SET status = 'addressed' WHERE intent_id = ?").run(intentId);
      }
      break;
    }
    case "decision.accepted":
      db.prepare("UPDATE p_work SET decision_status = 'accepted' WHERE work_id = ?").run(
        payload.workId,
      );
      break;
    case "decision.reopened":
      db.prepare(
        "UPDATE p_work SET status = 'open', claim_json = NULL, decision_status = 'reopened' WHERE work_id = ?",
      ).run(payload.workId);
      reopenIntents(db, String(payload.workId));
      break;
    default:
      break;
  }
  touchCorrelatedSession(db, envelope, payload);
  db.prepare(
    `INSERT INTO p_timeline (seq, recorded_at, event_type, stream_type, stream_id, actor_json, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    envelope.seq,
    envelope.recordedAt,
    envelope.eventType,
    envelope.streamType,
    envelope.streamId,
    JSON.stringify(envelope.actor),
    summarize(envelope),
  );
}

function summarize(envelope: EventEnvelope): string {
  const payload = envelope.payload as Record<string, unknown>;
  switch (envelope.eventType) {
    case "workspace.opened":
      return `workspace opened at ${String(payload.rootPath)}`;
    case "workspace.restored":
      return `workspace restored from ${String(payload.sourceWorkspaceId)} at seq ${String(payload.capturedSeq)}`;
    case "artifact.registered":
      return `artifact "${String(payload.name)}" registered (${String(payload.format)})`;
    case "artifact.revision-published":
      return `revision ${String(payload.seq)} published by ${actorLabel(envelope)}`;
    case "review.batch-submitted":
      return `review submitted with ${(payload.intentIds as string[]).length} intent(s)`;
    case "intent.created": {
      const target = payload.target as { semanticId?: string };
      return `${String(payload.intentType)} on ${target.semanticId ?? "the artifact"}`;
    }
    case "work.created":
      return `work created for ${(payload.intentIds as string[]).length} intent(s)`;
    case "work.claimed":
      return `work claimed by ${String(payload.agentId)}`;
    case "work.addressed":
      return `work addressed by ${String(payload.agentId)}: ${String(payload.summary)}`;
    case "work.progressed":
      return `work progress by ${String(payload.agentId)}: ${String(payload.summary)}`;
    case "work.claim-released":
      return `claim released by ${String(payload.agentId)}`;
    case "work.abandoned":
      return `stale claim abandoned (${String(payload.claimId)})`;
    case "decision.accepted":
      return "human accepted the addressed work";
    case "decision.reopened":
      return `human reopened the work: ${String(payload.reason)}`;
    case "chat.message":
      return `chat — ${String(payload.author)}: ${String(payload.text).slice(0, 80)}`;
    case "chat.delivery-offered":
      return `chat offered to agent ${String(payload.agentId)} (attempt ${String(payload.attemptNumber)})`;
    case "chat.delivery-acknowledged":
      return `chat acknowledged by agent ${String(payload.agentId)}`;
    case "chat.delivery-paused":
      return "chat delivery paused after retry budget exhaustion";
    case "chat.delivery-resumed":
      return "chat delivery resumed by a human";
    case "session.started":
      return `session started by ${String(payload.agentId)}`;
    case "session.artifact-attached":
      return `artifact ${String(payload.artifactId)} attached to session`;
    case "session.handoff-offered":
      return `session handed off to ${String(payload.toAgentId)}`;
    case "session.ended":
      return `session ended by ${String(payload.agentId)}`;
    default:
      return envelope.eventType;
  }
}

function touchCorrelatedSession(
  db: Db,
  envelope: EventEnvelope,
  payload: Record<string, unknown>,
): void {
  let sessionId = typeof payload.sessionId === "string" ? payload.sessionId : null;
  if (sessionId === null && typeof payload.workId === "string") {
    const row = db.prepare("SELECT session_id FROM p_work WHERE work_id = ?").get(payload.workId) as
      | { session_id: string | null }
      | undefined;
    sessionId = row?.session_id ?? null;
  }
  if (sessionId === null) return;
  db.prepare(
    `UPDATE p_sessions SET last_active_at = ?, last_seq = ?
     WHERE session_id = ? AND last_seq <= ?`,
  ).run(envelope.recordedAt, envelope.seq, sessionId, envelope.seq);
}

function actorLabel(envelope: EventEnvelope): string {
  return `${envelope.actor.kind}:${envelope.actor.id}`;
}

function appendProgress(db: Db, envelope: EventEnvelope, payload: Record<string, unknown>): void {
  const row = db
    .prepare("SELECT progress_json FROM p_work WHERE work_id = ?")
    .get(payload.workId) as { progress_json: string } | undefined;
  if (!row) return;
  const progress = JSON.parse(row.progress_json) as unknown[];
  progress.push({
    summary: payload.summary,
    revisionId: payload.revisionId ?? null,
    agentId: payload.agentId,
    addressedIntentIds: payload.addressedIntentIds,
    seq: envelope.seq,
    recordedAt: envelope.recordedAt,
  });
  db.prepare("UPDATE p_work SET progress_json = ? WHERE work_id = ?").run(
    JSON.stringify(progress),
    payload.workId,
  );
}

type WorkProgress = SnapshotWork["progress"][number];
type MaterializedWorkProgress = Array<Partial<WorkProgress>>;

function parseMaterializedWorkProgress(progressJson: string): MaterializedWorkProgress {
  return JSON.parse(progressJson) as MaterializedWorkProgress;
}

function needsProgressRecovery(progress: readonly Partial<WorkProgress>[]): boolean {
  return progress.some(
    (item) =>
      !Number.isSafeInteger(item.seq) ||
      Number(item.seq) <= 0 ||
      typeof item.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(item.recordedAt)),
  );
}

/**
 * Recover only legacy work rows. Current projections already contain the event envelope and must
 * not turn every snapshot into an event-history replay. The stream index keeps each legacy query
 * bounded to the affected WorkIds; a migration may later persist this one-time repair.
 */
function authoritativeWorkProgress(
  db: Db,
  legacyWorkIds: readonly string[],
): Map<string, WorkProgress[]> {
  const byWorkId = new Map<string, WorkProgress[]>();
  if (legacyWorkIds.length === 0) return byWorkId;
  const workspace = db.prepare("SELECT workspace_id FROM events ORDER BY seq LIMIT 1").get() as
    | { workspace_id: string }
    | undefined;
  if (!workspace) throw new Error("cannot recover legacy work progress without event history");

  const chunkSize = 250;
  for (let offset = 0; offset < legacyWorkIds.length; offset += chunkSize) {
    const workIds = legacyWorkIds.slice(offset, offset + chunkSize);
    const placeholders = workIds.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT seq, recorded_at, stream_id, payload_json
         FROM events INDEXED BY events_by_stream
         WHERE workspace_id = ?
           AND stream_type = 'work'
           AND stream_id IN (${placeholders})
           AND event_type = 'work.progressed'
         ORDER BY seq`,
      )
      .all(workspace.workspace_id, ...workIds) as Array<{
      seq: number;
      recorded_at: string;
      stream_id: string;
      payload_json: string;
    }>;
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      if (payload.workId !== row.stream_id) {
        throw new Error(`work progress event stream/payload mismatch for ${row.stream_id}`);
      }
      const progress = byWorkId.get(row.stream_id) ?? [];
      progress.push({
        summary: String(payload.summary),
        revisionId: typeof payload.revisionId === "string" ? payload.revisionId : null,
        agentId: String(payload.agentId),
        addressedIntentIds: Array.isArray(payload.addressedIntentIds)
          ? payload.addressedIntentIds.map(String)
          : [],
        seq: row.seq,
        recordedAt: row.recorded_at,
      });
      byWorkId.set(row.stream_id, progress);
    }
  }
  return byWorkId;
}

function progressSemantics(progress: readonly Partial<WorkProgress>[]) {
  return progress.map((item) => ({
    summary: item.summary,
    revisionId: item.revisionId ?? null,
    agentId: item.agentId,
    addressedIntentIds: item.addressedIntentIds ?? [],
  }));
}

function reconcileWorkProgress(
  workId: string,
  stored: MaterializedWorkProgress,
  authoritativeByWorkId: ReadonlyMap<string, WorkProgress[]>,
): WorkProgress[] {
  if (!needsProgressRecovery(stored)) return stored as WorkProgress[];
  const authoritative = authoritativeByWorkId.get(workId) ?? [];
  if (
    JSON.stringify(progressSemantics(stored)) !== JSON.stringify(progressSemantics(authoritative))
  ) {
    throw new Error(
      `work progress projection diverges from event history for ${workId}; rebuild projections`,
    );
  }
  return authoritative;
}

function reopenIntents(db: Db, workId: string): void {
  const row = db.prepare("SELECT intent_ids_json FROM p_work WHERE work_id = ?").get(workId) as
    | { intent_ids_json: string }
    | undefined;
  if (!row) return;
  for (const intentId of JSON.parse(row.intent_ids_json) as string[]) {
    db.prepare("UPDATE p_intents SET status = 'submitted' WHERE intent_id = ?").run(intentId);
  }
}

export function rebuildProjections(db: Db, workspaceId: string): void {
  const rebuild = db.transaction(() => {
    for (const table of PROJECTION_TABLES) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
    for (const envelope of readEvents(db, workspaceId, 0, Number.MAX_SAFE_INTEGER)) {
      applyProjections(db, envelope);
    }
  });
  rebuild.immediate();
}

type ChatProjectionRow = Readonly<{
  message_id: string;
  artifact_id: string | null;
  author: string;
  text: string;
  content_json: string | null;
  context_json: string | null;
  mentions_json: string;
  references_json: string;
  attachments_json: string;
  recorded_at: string;
  created_seq: number;
  session_id: string | null;
  recipient_agent_id: string | null;
  thread_id: string | null;
  work_id: string | null;
  intent_id: string | null;
  delivery_status: "offered" | "acknowledged" | "paused" | null;
  delivery_attempt_id: string | null;
  delivery_attempt_number: number;
  delivery_agent_id: string | null;
  delivery_offered_at: string | null;
  delivery_acknowledged_at: string | null;
  delivery_paused_at: string | null;
  delivery_pause_reason: "retry-budget-exhausted" | null;
}>;

function chatRowsToSnapshot(rows: readonly ChatProjectionRow[]): SnapshotChatMessage[] {
  const messages: SnapshotChatMessage[] = rows.map((row) => ({
    messageId: row.message_id,
    artifactId: row.artifact_id,
    author: row.author,
    text: row.text,
    content: chatContentOrText(
      row.content_json === null ? undefined : (JSON.parse(row.content_json) as ChatContent),
      row.text,
    ),
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
  }));
  const supersededBy = new Map<string, string>();
  for (const message of messages) {
    if (
      message.content.type === "choice-answer" &&
      message.content.supersedesAnswerMessageId !== null
    ) {
      supersededBy.set(message.content.supersedesAnswerMessageId, message.messageId);
    }
  }
  return messages.map((message) => {
    if (message.content.type === "choice-answer") {
      const supersedingMessageId = supersededBy.get(message.messageId);
      return {
        ...message,
        answerState:
          supersedingMessageId === undefined
            ? { status: "current" }
            : { status: "superseded", supersededByMessageId: supersedingMessageId },
      };
    }
    if (message.content.type !== "choice-question") return message;
    const currentAnswer = messages.find(
      (candidate) =>
        candidate.content.type === "choice-answer" &&
        candidate.content.questionMessageId === message.messageId &&
        !supersededBy.has(candidate.messageId),
    );
    if (currentAnswer?.content.type !== "choice-answer") {
      return { ...message, questionState: { status: "pending" } };
    }
    const optionKey = currentAnswer.content.optionKey;
    const option = message.content.options.find((candidate) => candidate.key === optionKey);
    return option === undefined
      ? { ...message, questionState: { status: "pending" } }
      : {
          ...message,
          questionState: {
            status: "answered",
            answerMessageId: currentAnswer.messageId,
            optionKey: option.key,
            optionLabel: option.label,
          },
        };
  });
}

export function snapshot(
  db: Db,
  workspace: { workspaceId: string; projectId: string; rootPath: string; protocolVersion: number },
  artifactOrigin: string,
): Snapshot {
  const artifacts = (
    db.prepare("SELECT * FROM p_artifacts ORDER BY registered_seq").all() as {
      artifact_id: string;
      name: string;
      format: string;
      source_path: string | null;
      registered_seq: number;
      provenance_json: string;
    }[]
  ).map((row) => ({
    artifactId: row.artifact_id,
    name: row.name,
    format: row.format,
    sourcePath: row.source_path,
    provenance: JSON.parse(row.provenance_json),
    registeredSeq: row.registered_seq,
  }));

  const sessionArtifacts = (
    db.prepare("SELECT session_id FROM p_sessions ORDER BY created_seq").all() as {
      session_id: string;
    }[]
  ).flatMap((row) =>
    sessionArtifactsFor(db, row.session_id).map((artifact) => ({
      sessionId: row.session_id,
      ...artifact,
    })),
  );

  const revisions: SnapshotRevision[] = (
    db.prepare("SELECT * FROM p_revisions ORDER BY artifact_id, seq").all() as {
      revision_id: string;
      artifact_id: string;
      parent_id: string | null;
      seq: number;
      format: string;
      entry_path: string;
      entry_hash: string;
      producer_json: string;
      created_seq: number;
    }[]
  ).map((row) => ({
    revisionId: row.revision_id,
    artifactId: row.artifact_id,
    parentId: row.parent_id,
    seq: row.seq,
    format: row.format,
    entryPath: row.entry_path,
    entryHash: row.entry_hash,
    producer: JSON.parse(row.producer_json),
    createdSeq: row.created_seq,
  }));

  const intents: SnapshotIntent[] = (
    db.prepare("SELECT * FROM p_intents ORDER BY created_seq").all() as {
      intent_id: string;
      batch_id: string;
      artifact_id: string;
      revision_id: string;
      intent_type: string;
      target_json: string;
      body_json: string;
      status: "submitted" | "addressed";
      created_seq: number;
    }[]
  ).map((row) => ({
    intentId: row.intent_id,
    batchId: row.batch_id,
    artifactId: row.artifact_id,
    revisionId: row.revision_id,
    intentType: row.intent_type,
    target: JSON.parse(row.target_json),
    body: JSON.parse(row.body_json),
    status: row.status,
    createdSeq: row.created_seq,
  }));

  const workRows = (
    db.prepare("SELECT * FROM p_work ORDER BY created_seq").all() as {
      work_id: string;
      artifact_id: string;
      base_revision_id: string;
      intent_ids_json: string;
      status: "open" | "claimed" | "addressed";
      claim_json: string | null;
      result_json: string | null;
      assignee_agent_id: string | null;
      session_id: string | null;
      progress_json: string;
      decision_status: "pending" | "accepted" | "reopened";
      created_seq: number;
    }[]
  ).map((row) => ({ row, progress: parseMaterializedWorkProgress(row.progress_json) }));
  const progressByWorkId = authoritativeWorkProgress(
    db,
    workRows
      .filter(({ progress }) => needsProgressRecovery(progress))
      .map(({ row }) => row.work_id),
  );
  const work: SnapshotWork[] = workRows.map(({ row, progress }) => ({
    workId: row.work_id,
    artifactId: row.artifact_id,
    baseRevisionId: row.base_revision_id,
    intentIds: JSON.parse(row.intent_ids_json),
    status: row.status,
    assigneeAgentId: row.assignee_agent_id,
    sessionId: row.session_id,
    claim: row.claim_json === null ? null : JSON.parse(row.claim_json),
    result: row.result_json === null ? null : JSON.parse(row.result_json),
    progress: reconcileWorkProgress(row.work_id, progress, progressByWorkId),
    decision: row.decision_status,
    createdSeq: row.created_seq,
  }));

  const chat = chatRowsToSnapshot(
    (
      db
        .prepare("SELECT * FROM p_chat ORDER BY created_seq DESC LIMIT 200")
        .all() as ChatProjectionRow[]
    ).reverse(),
  );

  const timeline = (
    db.prepare("SELECT * FROM p_timeline ORDER BY seq DESC LIMIT 200").all() as {
      seq: number;
      recorded_at: string;
      event_type: string;
      stream_type: string;
      stream_id: string;
      summary: string;
    }[]
  ).map((row) => ({
    seq: row.seq,
    recordedAt: row.recorded_at,
    eventType: row.event_type,
    streamType: row.stream_type,
    streamId: row.stream_id,
    summary: row.summary,
  }));

  return {
    protocol: SNAPSHOT_PROTOCOL,
    workspace: {
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
      rootPath: workspace.rootPath,
      protocolVersion: workspace.protocolVersion,
      artifactOrigin,
    },
    artifacts,
    sessionArtifacts,
    revisions,
    intents,
    work,
    chat,
    timeline,
    lastSeq: lastSeq(db, workspace.workspaceId),
  };
}

/** Locate an artifact identity by its source locator, if any. */
export function artifactIdForSource(db: Db, sourcePath: string): string | null {
  const row = db
    .prepare("SELECT artifact_id FROM p_artifacts WHERE source_path = ?")
    .get(sourcePath) as { artifact_id: string } | undefined;
  return row?.artifact_id ?? null;
}

export function listSessions(
  db: Db,
  filters: Readonly<{ artifactId?: string; agentId?: string; status?: SessionStatus }> = {},
): Readonly<{ protocol: typeof SESSION_QUERY_PROTOCOL; sessions: readonly SessionRecord[] }> {
  const clauses: string[] = [];
  const parameters: string[] = [];
  if (filters.artifactId) {
    clauses.push(
      "EXISTS (SELECT 1 FROM p_session_artifacts sa WHERE sa.session_id = s.session_id AND sa.artifact_id = ?)",
    );
    parameters.push(filters.artifactId);
  }
  if (filters.agentId) {
    clauses.push("s.agent_id = ?");
    parameters.push(filters.agentId);
  }
  if (filters.status) {
    clauses.push("s.status = ?");
    parameters.push(filters.status);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT s.session_id FROM p_sessions s ${where} ORDER BY s.created_seq DESC`)
    .all(...parameters) as { session_id: string }[];
  return {
    protocol: SESSION_QUERY_PROTOCOL,
    sessions: rows
      .map((row) => sessionById(db, row.session_id))
      .filter((session): session is SessionRecord => session !== null),
  };
}

export function sessionById(db: Db, sessionId: string): SessionRecord | null {
  const row = db
    .prepare(
      `SELECT s.*, primary_membership.artifact_id AS primary_artifact_id,
              a.name AS artifact_name, a.format AS artifact_format, a.source_path
       FROM p_sessions s
       LEFT JOIN p_session_artifacts primary_membership
         ON primary_membership.session_id = s.session_id
        AND primary_membership.role = 'primary'
       LEFT JOIN p_artifacts a ON a.artifact_id = primary_membership.artifact_id
       WHERE s.session_id = ?`,
    )
    .get(sessionId) as
    | {
        session_id: string;
        artifact_id: string | null;
        primary_artifact_id: string | null;
        artifact_name: string | null;
        artifact_format: "html" | "markdown" | "whiteboard" | null;
        source_path: string | null;
        originating_agent_id: string;
        agent_id: string;
        process_nonce: string;
        status: SessionStatus;
        base_revision_id: string | null;
        title: string;
        goal: string;
        predecessor_session_id: string | null;
        handoff_to_agent_id: string | null;
        handoff_summary: string | null;
        summary: string | null;
        created_at: string;
        last_active_at: string;
        ended_at: string | null;
      }
    | undefined;
  if (!row) return null;

  const work = sessionWork(db, sessionId);
  const chat = sessionChat(db, sessionId);
  const intentIds = work.flatMap((item) => item.intentIds);
  const intents = intentIds
    .map((intentId) => sessionIntent(db, intentId))
    .filter((intent): intent is SnapshotIntent => intent !== null);
  const openIntentIds = intents
    .filter((intent) => intent.status === "submitted")
    .map((intent) => intent.intentId);
  const head =
    row.primary_artifact_id === null
      ? undefined
      : (db
          .prepare(
            "SELECT revision_id FROM p_revisions WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1",
          )
          .get(row.primary_artifact_id) as { revision_id: string } | undefined);
  const latestSession = db
    .prepare("SELECT revision_id FROM p_revisions WHERE session_id = ? ORDER BY seq DESC LIMIT 1")
    .get(sessionId) as { revision_id: string } | undefined;
  const successors = db
    .prepare(
      "SELECT session_id FROM p_sessions WHERE predecessor_session_id = ? ORDER BY created_seq",
    )
    .all(sessionId) as { session_id: string }[];
  const relatedArtifactIds = new Set<string>(
    chat
      .flatMap((message) => [
        ...message.mentions,
        ...message.references.flatMap(referenceArtifactIds),
      ])
      .filter((id) => id !== row.primary_artifact_id),
  );
  const relatedArtifacts = [...relatedArtifactIds]
    .map((artifactId) => {
      return db
        .prepare(
          "SELECT artifact_id, name, format, source_path FROM p_artifacts WHERE artifact_id = ?",
        )
        .get(artifactId) as
        | {
            artifact_id: string;
            name: string;
            format: "html" | "markdown" | "whiteboard";
            source_path: string | null;
          }
        | undefined;
    })
    .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== undefined)
    .map((artifact) => ({
      artifactId: artifact.artifact_id,
      name: artifact.name,
      format: artifact.format,
      sourcePath: artifact.source_path,
    }));

  return {
    sessionId: row.session_id,
    primaryArtifactId: row.primary_artifact_id,
    artifactId: row.primary_artifact_id,
    artifactName: row.artifact_name,
    artifactFormat: row.artifact_format,
    sourcePath: row.source_path,
    originatingAgentId: row.originating_agent_id,
    agentId: row.agent_id,
    processNonce: row.process_nonce,
    status: row.status,
    baseRevisionId: row.base_revision_id,
    headRevisionId: head?.revision_id ?? null,
    latestSessionRevisionId: latestSession?.revision_id ?? null,
    title: row.title,
    goal: row.goal,
    summary: row.summary,
    predecessorSessionId: row.predecessor_session_id,
    successorSessionIds: successors.map((successor) => successor.session_id),
    handoff:
      row.handoff_to_agent_id !== null && row.handoff_summary !== null
        ? { toAgentId: row.handoff_to_agent_id, summary: row.handoff_summary }
        : null,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    endedAt: row.ended_at,
    presence: "unknown",
    work,
    intents,
    chat,
    openIntentIds,
    transcriptComplete: true,
    artifacts: sessionArtifactsFor(db, sessionId),
    relatedArtifacts,
  };
}

export function sessionExists(db: Db, sessionId: string): boolean {
  return db.prepare("SELECT 1 FROM p_sessions WHERE session_id = ?").get(sessionId) !== undefined;
}

export function sessionHasArtifact(db: Db, sessionId: string, artifactId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM p_session_artifacts WHERE session_id = ? AND artifact_id = ?")
      .get(sessionId, artifactId) !== undefined
  );
}

export function sessionArtifactsFor(db: Db, sessionId: string): readonly SessionArtifactRecord[] {
  const rows = db
    .prepare(
      `SELECT
         sa.artifact_id,
         sa.attached_revision_id,
         sa.role,
         sa.attached_seq,
         a.name,
         a.format,
         a.source_path,
         a.provenance_json,
         attached.entry_hash AS attached_entry_hash,
         current.revision_id AS current_revision_id,
         current.entry_hash AS current_entry_hash
       FROM p_session_artifacts sa
       JOIN p_artifacts a ON a.artifact_id = sa.artifact_id
       JOIN p_revisions attached ON attached.revision_id = sa.attached_revision_id
       JOIN p_revisions current ON current.revision_id = (
         SELECT r.revision_id
         FROM p_revisions r
         WHERE r.artifact_id = sa.artifact_id
         ORDER BY r.seq DESC
         LIMIT 1
       )
       WHERE sa.session_id = ?
       ORDER BY sa.attached_seq, sa.artifact_id`,
    )
    .all(sessionId) as {
    artifact_id: string;
    attached_revision_id: string;
    role: "primary" | "opened" | "whiteboard";
    attached_seq: number;
    name: string;
    format: "html" | "markdown" | "whiteboard";
    source_path: string | null;
    provenance_json: string;
    attached_entry_hash: string;
    current_revision_id: string;
    current_entry_hash: string;
  }[];
  return rows.map((row) => ({
    artifactId: row.artifact_id,
    name: row.name,
    format: row.format,
    sourcePath: row.source_path,
    provenance: JSON.parse(row.provenance_json),
    attachedRevisionId: row.attached_revision_id,
    attachedEntryHash: row.attached_entry_hash,
    currentRevisionId: row.current_revision_id,
    currentEntryHash: row.current_entry_hash,
    role: row.role,
    attachedSeq: row.attached_seq,
  }));
}

function sessionIntent(db: Db, intentId: string): SnapshotIntent | null {
  const row = db.prepare("SELECT * FROM p_intents WHERE intent_id = ?").get(intentId) as
    | {
        intent_id: string;
        batch_id: string;
        artifact_id: string;
        revision_id: string;
        intent_type: string;
        target_json: string;
        body_json: string;
        status: "submitted" | "addressed";
        created_seq: number;
      }
    | undefined;
  if (!row) return null;
  return {
    intentId: row.intent_id,
    batchId: row.batch_id,
    artifactId: row.artifact_id,
    revisionId: row.revision_id,
    intentType: row.intent_type,
    target: JSON.parse(row.target_json),
    body: JSON.parse(row.body_json),
    status: row.status,
    createdSeq: row.created_seq,
  };
}

function sessionWork(db: Db, sessionId: string): SnapshotWork[] {
  const workRows = (
    db.prepare("SELECT * FROM p_work WHERE session_id = ? ORDER BY created_seq").all(sessionId) as {
      work_id: string;
      artifact_id: string;
      base_revision_id: string;
      intent_ids_json: string;
      status: "open" | "claimed" | "addressed";
      claim_json: string | null;
      result_json: string | null;
      assignee_agent_id: string | null;
      session_id: string | null;
      progress_json: string;
      decision_status: "pending" | "accepted" | "reopened";
      created_seq: number;
    }[]
  ).map((row) => ({ row, progress: parseMaterializedWorkProgress(row.progress_json) }));
  const progressByWorkId = authoritativeWorkProgress(
    db,
    workRows
      .filter(({ progress }) => needsProgressRecovery(progress))
      .map(({ row }) => row.work_id),
  );
  return workRows.map(({ row: item, progress }) => ({
    workId: item.work_id,
    artifactId: item.artifact_id,
    baseRevisionId: item.base_revision_id,
    intentIds: JSON.parse(item.intent_ids_json),
    status: item.status,
    assigneeAgentId: item.assignee_agent_id,
    sessionId: item.session_id,
    claim: item.claim_json === null ? null : JSON.parse(item.claim_json),
    result: item.result_json === null ? null : JSON.parse(item.result_json),
    progress: reconcileWorkProgress(item.work_id, progress, progressByWorkId),
    decision: item.decision_status,
    createdSeq: item.created_seq,
  }));
}

function sessionChat(db: Db, sessionId: string): SnapshotChatMessage[] {
  return chatRowsToSnapshot(
    db
      .prepare("SELECT * FROM p_chat WHERE session_id = ? ORDER BY created_seq")
      .all(sessionId) as ChatProjectionRow[],
  );
}

/** Exact, untruncated read model used by block-one-result question consumers. */
export function questionSnapshot(db: Db, messageId: string): SnapshotChatMessage | null {
  const row = db.prepare("SELECT session_id FROM p_chat WHERE message_id = ?").get(messageId) as
    | { session_id: string | null }
    | undefined;
  if (row?.session_id == null) return null;
  return sessionChat(db, row.session_id).find((message) => message.messageId === messageId) ?? null;
}

function referenceArtifactIds(reference: ChatReference): string[] {
  if (reference.kind === "file") {
    return reference.artifactId === undefined ? [] : [reference.artifactId];
  }
  if (reference.kind === "selection" && reference.boardAnchor !== undefined) {
    return [reference.artifactId, reference.boardAnchor.whiteboardArtifactId];
  }
  return [reference.artifactId];
}

export type RevisionRecord = Readonly<{
  revisionId: string;
  artifactId: string;
  format: "html" | "markdown" | "whiteboard";
  entryPath: string;
  entryHash: string;
  sourcePath: string | null;
  files: readonly { path: string; hash: string; mediaType: string }[];
}>;

export function revisionById(db: Db, revisionId: string): RevisionRecord | null {
  const row = db.prepare("SELECT * FROM p_revisions WHERE revision_id = ?").get(revisionId) as
    | {
        revision_id: string;
        artifact_id: string;
        format: "html" | "markdown" | "whiteboard";
        entry_path: string;
        entry_hash: string;
        source_path: string | null;
        files_json: string;
      }
    | undefined;
  if (!row) return null;
  return {
    revisionId: row.revision_id,
    artifactId: row.artifact_id,
    format: row.format,
    entryPath: row.entry_path,
    entryHash: row.entry_hash,
    sourcePath: row.source_path,
    files: JSON.parse(row.files_json),
  };
}
