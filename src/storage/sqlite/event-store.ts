import type { ActorRef, CommandResult, EventEnvelope } from "../../protocol/envelopes.js";
import type { Db } from "./db.js";

export type AppendInput = Readonly<{
  eventId: string;
  streamType: string;
  streamId: string;
  eventType: string;
  schemaVersion: number;
  recordedAt: string;
  actor: ActorRef;
  causationId: string | null;
  correlationId: string | null;
  payload: unknown;
}>;

interface EventRow {
  seq: number;
  event_id: string;
  workspace_id: string;
  stream_type: string;
  stream_id: string;
  stream_version: number;
  event_type: string;
  schema_version: number;
  recorded_at: string;
  actor_json: string;
  causation_id: string | null;
  correlation_id: string | null;
  payload_json: string;
}

function rowToEnvelope(row: EventRow): EventEnvelope {
  return {
    seq: row.seq,
    eventId: row.event_id,
    workspaceId: row.workspace_id,
    streamType: row.stream_type,
    streamId: row.stream_id,
    streamVersion: row.stream_version,
    eventType: row.event_type,
    schemaVersion: row.schema_version,
    recordedAt: row.recorded_at,
    actor: JSON.parse(row.actor_json),
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    payload: JSON.parse(row.payload_json),
  };
}

export function currentStreamVersion(db: Db, workspaceId: string, streamId: string): number {
  const row = db
    .prepare(
      "SELECT MAX(stream_version) AS version FROM events WHERE workspace_id = ? AND stream_id = ?",
    )
    .get(workspaceId, streamId) as { version: number | null };
  return row.version ?? 0;
}

/**
 * Append one fact. Must be called inside the transactor's immediate
 * transaction; the UNIQUE(workspace_id, stream_id, stream_version)
 * constraint is the final guard against concurrent writers.
 */
export function appendEvent(db: Db, workspaceId: string, input: AppendInput): EventEnvelope {
  const streamVersion = currentStreamVersion(db, workspaceId, input.streamId) + 1;
  const result = db
    .prepare(
      `INSERT INTO events (
         event_id, workspace_id, stream_type, stream_id, stream_version,
         event_type, schema_version, recorded_at, actor_json,
         causation_id, correlation_id, payload_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.eventId,
      workspaceId,
      input.streamType,
      input.streamId,
      streamVersion,
      input.eventType,
      input.schemaVersion,
      input.recordedAt,
      JSON.stringify(input.actor),
      input.causationId,
      input.correlationId,
      JSON.stringify(input.payload),
    );
  return {
    seq: Number(result.lastInsertRowid),
    eventId: input.eventId,
    workspaceId,
    streamType: input.streamType,
    streamId: input.streamId,
    streamVersion,
    eventType: input.eventType,
    schemaVersion: input.schemaVersion,
    recordedAt: input.recordedAt,
    actor: input.actor,
    causationId: input.causationId,
    correlationId: input.correlationId,
    payload: input.payload,
  };
}

export function readEvents(
  db: Db,
  workspaceId: string,
  afterSeq = 0,
  limit = 10_000,
): EventEnvelope[] {
  const rows = db
    .prepare("SELECT * FROM events WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(workspaceId, afterSeq, limit) as EventRow[];
  return rows.map(rowToEnvelope);
}

export function lastSeq(db: Db, workspaceId: string): number {
  const row = db
    .prepare("SELECT MAX(seq) AS seq FROM events WHERE workspace_id = ?")
    .get(workspaceId) as { seq: number | null };
  return row.seq ?? 0;
}

export function getReceipt(
  db: Db,
  workspaceId: string,
  idempotencyKey: string,
): CommandResult | null {
  const row = db
    .prepare(
      "SELECT response_json FROM command_receipts WHERE workspace_id = ? AND idempotency_key = ?",
    )
    .get(workspaceId, idempotencyKey) as { response_json: string } | undefined;
  return row ? (JSON.parse(row.response_json) as CommandResult) : null;
}

export function getReceiptRecord(
  db: Db,
  workspaceId: string,
  idempotencyKey: string,
): Readonly<{
  response: CommandResult;
  requestHash: string | null;
  identityStatus: "verified" | "legacy-unverifiable" | "missing";
}> | null {
  const row = db
    .prepare(
      `SELECT r.response_json, h.request_hash, g.reason AS identity_gap
       FROM command_receipts AS r
       LEFT JOIN command_request_hashes AS h
         ON h.workspace_id = r.workspace_id AND h.idempotency_key = r.idempotency_key
       LEFT JOIN command_receipt_identity_gaps AS g
         ON g.workspace_id = r.workspace_id AND g.idempotency_key = r.idempotency_key
       WHERE r.workspace_id = ? AND r.idempotency_key = ?`,
    )
    .get(workspaceId, idempotencyKey) as
    | {
        response_json: string;
        request_hash: string | null;
        identity_gap: "legacy-request-identity-unverifiable" | null;
      }
    | undefined;
  if (!row) return null;
  return {
    response: JSON.parse(row.response_json) as CommandResult,
    requestHash: row.request_hash,
    identityStatus:
      row.request_hash !== null
        ? "verified"
        : row.identity_gap !== null
          ? "legacy-unverifiable"
          : "missing",
  };
}

export function putReceipt(
  db: Db,
  workspaceId: string,
  idempotencyKey: string,
  commandId: string,
  firstEventSeq: number | null,
  lastEventSeq: number | null,
  response: CommandResult,
  requestHash: string,
  recordedAt: string,
): void {
  db.prepare(
    `INSERT INTO command_receipts (
       workspace_id, idempotency_key, command_id,
       first_event_seq, last_event_seq, response_json, recorded_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    workspaceId,
    idempotencyKey,
    commandId,
    firstEventSeq,
    lastEventSeq,
    JSON.stringify(response),
    recordedAt,
  );
  db.prepare(
    `INSERT INTO command_request_hashes (workspace_id, idempotency_key, request_hash)
     VALUES (?, ?, ?)`,
  ).run(workspaceId, idempotencyKey, requestHash);
}
