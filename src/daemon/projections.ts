import type { EventEnvelope } from "../protocol/envelopes.js";
import type { Snapshot } from "../protocol/snapshot.js";
import { SNAPSHOT_PROTOCOL } from "../protocol/versions.js";
import type { Db } from "../storage/sqlite/db.js";
import { lastSeq, readEvents } from "../storage/sqlite/event-store.js";

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
        `INSERT INTO p_artifacts (artifact_id, name, format, source_path, registered_seq)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        payload.artifactId,
        payload.name,
        payload.format,
        payload.sourcePath ?? null,
        envelope.seq,
      );
      break;
    default:
      break;
  }
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
    case "artifact.registered":
      return `artifact "${String(payload.name)}" registered (${String(payload.format)})`;
    default:
      return envelope.eventType;
  }
}

export function rebuildProjections(db: Db, workspaceId: string): void {
  const rebuild = db.transaction(() => {
    db.prepare("DELETE FROM p_artifacts").run();
    db.prepare("DELETE FROM p_timeline").run();
    for (const envelope of readEvents(db, workspaceId, 0, Number.MAX_SAFE_INTEGER)) {
      applyProjections(db, envelope);
    }
  });
  rebuild.immediate();
}

export function snapshot(
  db: Db,
  workspace: { workspaceId: string; projectId: string; rootPath: string; protocolVersion: number },
): Snapshot {
  const artifacts = (
    db.prepare("SELECT * FROM p_artifacts ORDER BY registered_seq").all() as {
      artifact_id: string;
      name: string;
      format: string;
      source_path: string | null;
      registered_seq: number;
    }[]
  ).map((row) => ({
    artifactId: row.artifact_id,
    name: row.name,
    format: row.format,
    sourcePath: row.source_path,
    registeredSeq: row.registered_seq,
  }));
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
    workspace,
    artifacts,
    timeline,
    lastSeq: lastSeq(db, workspace.workspaceId),
  };
}
