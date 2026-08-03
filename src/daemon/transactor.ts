import type { DomainCommand } from "../domain/commands.js";
import { decide } from "../domain/decide.js";
import { type DomainEvent, streamOf } from "../domain/events.js";
import { replay } from "../domain/evolve.js";
import type {
  CommandAccepted,
  CommandEnvelope,
  CommandResult,
  EventEnvelope,
} from "../protocol/envelopes.js";
import { validateCommand } from "../protocol/validation.js";
import { EVENT_SCHEMA_VERSION } from "../protocol/versions.js";
import type { Db } from "../storage/sqlite/db.js";
import {
  appendEvent,
  currentStreamVersion,
  getReceipt,
  putReceipt,
  readEvents,
} from "../storage/sqlite/event-store.js";
import { applyProjections } from "./projections.js";

export type TransactorDeps = Readonly<{
  db: Db;
  workspaceId: string;
  newEventId: () => string;
  now: () => string;
  onCommitted: (envelopes: readonly EventEnvelope[]) => void;
}>;

export type Transactor = Readonly<{
  execute: (input: unknown) => CommandResult;
}>;

/**
 * The single serialized writer. Validate → receipt check → load →
 * decide (pure) → append + project + receipt in one immediate
 * transaction → publish only after commit.
 */
export function createTransactor(deps: TransactorDeps): Transactor {
  function execute(input: unknown): CommandResult {
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

    if (envelope.workspaceId !== deps.workspaceId) {
      return rejected(
        envelope,
        "protocol.wrong-workspace",
        `this daemon serves ${deps.workspaceId}`,
      );
    }

    const receipt = getReceipt(deps.db, deps.workspaceId, envelope.idempotencyKey);
    if (receipt) return receipt;

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

    const recordedAt = deps.now();
    const tx = deps.db.transaction((): { result: CommandResult; committed: EventEnvelope[] } => {
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
      for (const envelopeStored of committed) {
        applyProjections(deps.db, envelopeStored);
      }
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
        recordedAt,
      );
      return { result, committed };
    });
    const { result, committed } = tx.immediate();

    if (committed.length > 0) deps.onCommitted(committed);
    return result;
  }

  return { execute };
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
        format: payload.format as "html" | "markdown",
        sourcePath: (payload.sourcePath as string | undefined) ?? null,
      };
    default:
      // validateCommand guarantees a known type; keep the guard explicit.
      throw new Error(`unmapped command type: ${envelope.type}`);
  }
}
