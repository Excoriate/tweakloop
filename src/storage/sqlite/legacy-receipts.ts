import type Database from "better-sqlite3";
import { canonicalJson, commandRequestHash } from "../../protocol/command-identity.js";
import type { ActorRef, CommandAccepted } from "../../protocol/envelopes.js";

type LegacyReceiptRow = Readonly<{
  workspace_id: string;
  idempotency_key: string;
  command_id: string;
  first_event_seq: number | null;
  last_event_seq: number | null;
  response_json: string;
}>;

type LegacyEventRow = Readonly<{
  seq: number;
  workspace_id: string;
  event_type: string;
  actor_json: string;
  payload_json: string;
}>;

/**
 * Repair only the two deterministic legacy families whose original normalized
 * request can be proven from their one-event receipt. Every mismatch remains
 * in command_receipt_identity_gaps and therefore fails closed.
 */
export function reconstructSupportedLegacyReceiptHashes(db: Database.Database): number {
  for (const table of [
    "events",
    "command_receipts",
    "command_request_hashes",
    "command_receipt_identity_gaps",
  ]) {
    if (
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) ===
      undefined
    ) {
      return 0;
    }
  }
  const rows = db
    .prepare(
      `SELECT r.workspace_id, r.idempotency_key, r.command_id,
              r.first_event_seq, r.last_event_seq, r.response_json
       FROM command_receipts r
       JOIN command_receipt_identity_gaps g
         ON g.workspace_id = r.workspace_id AND g.idempotency_key = r.idempotency_key
       LEFT JOIN command_request_hashes h
         ON h.workspace_id = r.workspace_id AND h.idempotency_key = r.idempotency_key
       WHERE h.request_hash IS NULL
       ORDER BY r.workspace_id, r.idempotency_key`,
    )
    .all() as LegacyReceiptRow[];
  const putHash = db.prepare(
    `INSERT INTO command_request_hashes (workspace_id, idempotency_key, request_hash)
     VALUES (?, ?, ?)`,
  );
  const clearGap = db.prepare(
    `DELETE FROM command_receipt_identity_gaps
     WHERE workspace_id = ? AND idempotency_key = ?`,
  );
  let repaired = 0;
  for (const row of rows) {
    const requestHash = reconstructRow(db, row);
    if (requestHash === null) continue;
    putHash.run(row.workspace_id, row.idempotency_key, requestHash);
    clearGap.run(row.workspace_id, row.idempotency_key);
    repaired += 1;
  }
  return repaired;
}

function reconstructRow(db: Database.Database, row: LegacyReceiptRow): string | null {
  if (
    row.first_event_seq === null ||
    row.last_event_seq === null ||
    row.first_event_seq !== row.last_event_seq
  ) {
    return null;
  }
  const event = db
    .prepare(
      `SELECT seq, workspace_id, event_type, actor_json, payload_json
       FROM events WHERE workspace_id = ? AND seq = ?`,
    )
    .get(row.workspace_id, row.first_event_seq) as LegacyEventRow | undefined;
  if (event === undefined || event.workspace_id !== row.workspace_id) return null;
  const actor = parseActor(event.actor_json);
  const payload = parseRecord(event.payload_json);
  const response = parseAccepted(row.response_json);
  if (
    actor === null ||
    payload === null ||
    response === null ||
    response.commandId !== row.command_id ||
    response.firstEventSeq !== event.seq ||
    response.lastEventSeq !== event.seq
  ) {
    return null;
  }

  if (row.idempotency_key === `workspace.open:${row.workspace_id}`) {
    if (
      event.event_type !== "workspace.opened" ||
      payload.type !== "workspace.opened" ||
      payload.workspaceId !== row.workspace_id ||
      typeof payload.projectId !== "string" ||
      typeof payload.rootPath !== "string" ||
      !sameJson(response.response, { alreadyOpen: false, projectId: payload.projectId })
    ) {
      return null;
    }
    return commandRequestHash({
      workspaceId: row.workspace_id,
      actor,
      type: "workspace.open",
      payload: { projectId: payload.projectId, rootPath: payload.rootPath },
    });
  }

  if (!row.idempotency_key.startsWith("artifact.register:")) return null;
  const sourcePath = row.idempotency_key.slice("artifact.register:".length);
  if (
    sourcePath.length === 0 ||
    event.event_type !== "artifact.registered" ||
    payload.type !== "artifact.registered" ||
    payload.sourcePath !== sourcePath ||
    typeof payload.artifactId !== "string" ||
    typeof payload.name !== "string" ||
    !["html", "markdown", "whiteboard"].includes(String(payload.format)) ||
    !sameJson(response.response, { artifactId: payload.artifactId })
  ) {
    return null;
  }
  return commandRequestHash({
    workspaceId: row.workspace_id,
    actor,
    type: "artifact.register",
    payload: {
      artifactId: payload.artifactId,
      name: payload.name,
      format: payload.format,
      sourcePath,
    },
  });
}

function parseAccepted(value: string): CommandAccepted | null {
  try {
    const parsed = JSON.parse(value) as Partial<CommandAccepted>;
    return parsed.status === "accepted" && typeof parsed.commandId === "string"
      ? (parsed as CommandAccepted)
      : null;
  } catch {
    return null;
  }
}

function parseActor(value: string): ActorRef | null {
  const parsed = parseRecord(value);
  return parsed !== null &&
    ["human", "agent", "system"].includes(String(parsed.kind)) &&
    typeof parsed.id === "string"
    ? (parsed as ActorRef)
    : null;
}

function parseRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
