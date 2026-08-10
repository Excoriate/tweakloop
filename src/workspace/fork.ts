import type { EventEnvelope } from "../protocol/envelopes.js";

export const WORKSPACE_FORK_PROTOCOL = "tweakloop.workspace-fork/v1" as const;

export type WorkspaceForkCheckpoint = Readonly<{
  sourceSessionId: string;
  destinationSessionId: string;
  capturedSeq: number;
  baseRevisionId: string | null;
  agentId: string;
  status: "active" | "ended";
  artifacts: readonly Readonly<{
    artifactId: string;
    revisionId: string;
    role: "primary" | "opened" | "whiteboard";
    attachedSeq: number;
  }>[];
}>;

export type WorkspaceForkResult = Readonly<{
  protocol: typeof WORKSPACE_FORK_PROTOCOL;
  sourceWorkspaceId: string;
  destinationWorkspaceId: string;
  checkpoint: WorkspaceForkCheckpoint;
  events: readonly EventEnvelope[];
  provenance: Readonly<{
    eventIds: Readonly<Record<string, string>>;
    sessionIds: Readonly<Record<string, string>>;
    correlationIds: Readonly<Record<string, string>>;
  }>;
}>;

export class WorkspaceForkError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceForkError";
  }
}

/**
 * Re-identify one captured history for an independent destination. Content, artifact, and revision
 * identities remain stable; workspace, session, event, causation, and correlation namespaces do not.
 */
export function forkWorkspaceHistory(
  input: Readonly<{
    events: readonly EventEnvelope[];
    sourceWorkspaceId: string;
    destinationWorkspaceId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    destinationRootPath: string;
    destinationAgentId: string;
    destinationProcessNonce: string;
    recordedAt: string;
    title?: string;
    goal?: string;
    forkCommandId: string;
    forkCorrelationId: string;
    mint: (kind: "event" | "session" | "correlation", sourceId: string) => string;
  }>,
): WorkspaceForkResult {
  requireNewIdentity(input.destinationWorkspaceId, input.sourceWorkspaceId, "workspace");
  requireNewIdentity(input.destinationSessionId, input.sourceSessionId, "session");
  const first = input.events[0];
  if (
    first === undefined ||
    first.seq !== 1 ||
    first.workspaceId !== input.sourceWorkspaceId ||
    (first.eventType !== "workspace.opened" && first.eventType !== "workspace.restored")
  ) {
    throw forkError(
      "workspace-fork.source-invalid",
      "captured history must begin with its source workspace fact",
    );
  }
  const sourceEventIds = new Set(input.events.map((event) => event.eventId));
  if (sourceEventIds.size !== input.events.length) {
    throw forkError(
      "workspace-fork.source-event-duplicate",
      "source event identities are not unique",
    );
  }
  if (sourceEventIds.has(input.forkCommandId)) {
    throw forkError("workspace-fork.command-collision", "fork command aliases a source event");
  }

  const checkpoint = sessionCheckpoint(
    input.events,
    input.sourceSessionId,
    input.destinationSessionId,
  );
  const sourceSessionIds = collectSessionIds(input.events);
  if (!sourceSessionIds.includes(input.sourceSessionId)) {
    throw forkError(
      "workspace-fork.session-unknown",
      `source session is not present at the checkpoint: ${input.sourceSessionId}`,
    );
  }
  const sessionIds = new Map<string, string>();
  for (const sourceId of sourceSessionIds) {
    const destinationId = input.mint("session", sourceId);
    requireNewIdentity(destinationId, sourceId, "session");
    if (destinationId === input.destinationSessionId) {
      throw forkError(
        "workspace-fork.session-mint-collision",
        "historical session identity collides with the new fork session",
      );
    }
    sessionIds.set(sourceId, destinationId);
  }
  assertUniqueValues(sessionIds, "workspace-fork.session-mint-collision");

  const eventIds = new Map<string, string>();
  for (const event of input.events) {
    const destinationId = input.mint("event", event.eventId);
    requireNewIdentity(destinationId, event.eventId, "event");
    eventIds.set(event.eventId, destinationId);
  }
  assertUniqueValues(eventIds, "workspace-fork.event-mint-collision");

  const correlationIds = new Map<string, string>();
  if (first.correlationId !== null) {
    correlationIds.set(first.correlationId, input.forkCorrelationId);
  }
  const destinationCorrelationIds = new Set<string>([input.forkCorrelationId]);
  const importedEvents = input.events.map((event, index): EventEnvelope => {
    if (event.seq !== index + 1 || event.workspaceId !== input.sourceWorkspaceId) {
      throw forkError(
        "workspace-fork.source-sequence",
        `source history diverges at captured sequence ${index + 1}`,
      );
    }
    const sourcePayload = requireRecord(event.payload, `event ${event.seq} payload`);
    const mappedCorrelation = mapCorrelation(
      event.correlationId,
      input,
      correlationIds,
      destinationCorrelationIds,
    );
    const provenance = {
      workspaceId: input.sourceWorkspaceId,
      eventId: event.eventId,
      sessionId: sourceSessionIdFrom(sourcePayload),
      causationId: event.causationId,
      correlationId: event.correlationId,
    };
    const payload =
      index === 0
        ? {
            type: "workspace.restored",
            workspaceId: input.destinationWorkspaceId,
            projectId: String(sourcePayload.projectId),
            rootPath: input.destinationRootPath,
            sourceWorkspaceId: input.sourceWorkspaceId,
            sourceProjectId: String(sourcePayload.projectId),
            sourceRootPath: String(sourcePayload.rootPath),
            capturedSeq: input.events.length,
            sourceProvenance: provenance,
          }
        : remapPayload(sourcePayload, sessionIds, input, provenance);
    return {
      ...event,
      eventId: eventIds.get(event.eventId) as string,
      workspaceId: input.destinationWorkspaceId,
      streamId:
        event.streamId === input.sourceWorkspaceId
          ? input.destinationWorkspaceId
          : (sessionIds.get(event.streamId) ?? event.streamId),
      eventType: index === 0 ? "workspace.restored" : event.eventType,
      causationId:
        index === 0
          ? input.forkCommandId
          : event.causationId !== null && eventIds.has(event.causationId)
            ? (eventIds.get(event.causationId) as string)
            : input.forkCommandId,
      correlationId: mappedCorrelation,
      payload,
    };
  });

  const events = [
    ...importedEvents,
    ...forkSessionEvents(input, checkpoint, sessionIds, eventIds, importedEvents.length),
  ];
  return {
    protocol: WORKSPACE_FORK_PROTOCOL,
    sourceWorkspaceId: input.sourceWorkspaceId,
    destinationWorkspaceId: input.destinationWorkspaceId,
    checkpoint,
    events,
    provenance: {
      eventIds: Object.fromEntries(eventIds),
      sessionIds: Object.fromEntries(sessionIds),
      correlationIds: Object.fromEntries(correlationIds),
    },
  };
}

function forkSessionEvents(
  input: Readonly<{
    sourceWorkspaceId: string;
    destinationWorkspaceId: string;
    sourceSessionId: string;
    destinationSessionId: string;
    destinationAgentId: string;
    destinationProcessNonce: string;
    recordedAt: string;
    title?: string;
    goal?: string;
    forkCommandId: string;
    forkCorrelationId: string;
    mint: (kind: "event" | "session" | "correlation", sourceId: string) => string;
  }>,
  checkpoint: WorkspaceForkCheckpoint,
  historicalSessionIds: ReadonlyMap<string, string>,
  sourceEventIds: ReadonlyMap<string, string>,
  importedCount: number,
): EventEnvelope[] {
  const usedIds = new Set(sourceEventIds.values());
  const startId = mintNewEventId(input, `fork-session-start:${input.sourceSessionId}`, usedIds);
  const primary = checkpoint.artifacts.find((artifact) => artifact.role === "primary") ?? null;
  const startSeq = importedCount + 1;
  const start: EventEnvelope = {
    seq: startSeq,
    eventId: startId,
    workspaceId: input.destinationWorkspaceId,
    streamType: "session",
    streamId: input.destinationSessionId,
    streamVersion: 1,
    eventType: "session.started",
    schemaVersion: 1,
    recordedAt: input.recordedAt,
    actor: { kind: "agent", id: input.destinationAgentId },
    causationId: input.forkCommandId,
    correlationId: input.forkCorrelationId,
    payload: {
      type: "session.started",
      sessionId: input.destinationSessionId,
      artifactId: primary?.artifactId ?? null,
      originatingAgentId: input.destinationAgentId,
      agentId: input.destinationAgentId,
      processNonce: input.destinationProcessNonce,
      baseRevisionId: checkpoint.baseRevisionId ?? primary?.revisionId ?? null,
      title: input.title ?? "Forked workspace session",
      goal: input.goal ?? "Continue independently from the saved session checkpoint",
      predecessorSessionId: historicalSessionIds.get(input.sourceSessionId) ?? null,
      handoffSummary: "Forked from an immutable saved session checkpoint",
      sourceProvenance: {
        workspaceId: input.sourceWorkspaceId,
        sessionId: input.sourceSessionId,
        capturedSeq: checkpoint.capturedSeq,
      },
    },
  };
  const attachments = checkpoint.artifacts.map(
    (artifact, index): EventEnvelope => ({
      seq: startSeq + index + 1,
      eventId: mintNewEventId(
        input,
        `fork-session-attachment:${input.sourceSessionId}:${index}`,
        usedIds,
      ),
      workspaceId: input.destinationWorkspaceId,
      streamType: "session",
      streamId: input.destinationSessionId,
      streamVersion: index + 2,
      eventType: "session.artifact-attached",
      schemaVersion: 1,
      recordedAt: input.recordedAt,
      actor: { kind: "agent", id: input.destinationAgentId },
      causationId: input.forkCommandId,
      correlationId: input.forkCorrelationId,
      payload: {
        type: "session.artifact-attached",
        sessionId: input.destinationSessionId,
        artifactId: artifact.artifactId,
        revisionId: artifact.revisionId,
        role: artifact.role,
        sourceProvenance: {
          workspaceId: input.sourceWorkspaceId,
          sessionId: input.sourceSessionId,
          attachedSeq: artifact.attachedSeq,
        },
      },
    }),
  );
  return [start, ...attachments];
}

function mintNewEventId(
  input: Readonly<{
    mint: (kind: "event" | "session" | "correlation", sourceId: string) => string;
  }>,
  sourceId: string,
  used: Set<string>,
): string {
  const minted = input.mint("event", sourceId);
  requireNewIdentity(minted, sourceId, "event");
  if (used.has(minted)) {
    throw forkError("workspace-fork.event-mint-collision", `minted event collides: ${minted}`);
  }
  used.add(minted);
  return minted;
}

function sessionCheckpoint(
  events: readonly EventEnvelope[],
  sourceSessionId: string,
  destinationSessionId: string,
): WorkspaceForkCheckpoint {
  const started = events.find((event) => {
    const payload = optionalRecord(event.payload);
    return event.eventType === "session.started" && payload?.sessionId === sourceSessionId;
  });
  if (started === undefined) {
    throw forkError("workspace-fork.session-start-missing", "source session has no start fact");
  }
  const startPayload = requireRecord(started.payload, "session start payload");
  const artifacts: Array<{
    artifactId: string;
    revisionId: string;
    role: "primary" | "opened" | "whiteboard";
    attachedSeq: number;
  }> = [];
  for (const event of events) {
    const payload = optionalRecord(event.payload);
    if (event.eventType !== "session.artifact-attached" || payload?.sessionId !== sourceSessionId) {
      continue;
    }
    if (
      typeof payload.artifactId !== "string" ||
      typeof payload.revisionId !== "string" ||
      (payload.role !== "primary" && payload.role !== "opened" && payload.role !== "whiteboard")
    ) {
      throw forkError(
        "workspace-fork.checkpoint-invalid",
        `session artifact checkpoint is invalid at seq ${event.seq}`,
      );
    }
    artifacts.push({
      artifactId: payload.artifactId,
      revisionId: payload.revisionId,
      role: payload.role,
      attachedSeq: event.seq,
    });
  }
  if (typeof startPayload.agentId !== "string") {
    throw forkError("workspace-fork.checkpoint-invalid", "source session has no agent identity");
  }
  return {
    sourceSessionId,
    destinationSessionId,
    capturedSeq: events.length,
    baseRevisionId:
      typeof startPayload.baseRevisionId === "string" ? startPayload.baseRevisionId : null,
    agentId: startPayload.agentId,
    status: "active",
    artifacts,
  };
}

function remapPayload(
  source: Record<string, unknown>,
  sessionIds: ReadonlyMap<string, string>,
  input: Readonly<{
    sourceWorkspaceId: string;
    destinationWorkspaceId: string;
    destinationRootPath: string;
  }>,
  sourceProvenance: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...source, sourceProvenance };
  if (payload.workspaceId === input.sourceWorkspaceId) {
    payload.workspaceId = input.destinationWorkspaceId;
  }
  if (payload.rootPath !== undefined) payload.rootPath = input.destinationRootPath;
  for (const key of ["sessionId", "predecessorSessionId"] as const) {
    const value = payload[key];
    if (typeof value === "string" && sessionIds.has(value)) {
      payload[key] = sessionIds.get(value);
    }
  }
  return payload;
}

function collectSessionIds(events: readonly EventEnvelope[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const payload = optionalRecord(event.payload);
    for (const candidate of [
      event.streamType === "session" ? event.streamId : null,
      payload?.sessionId,
      payload?.predecessorSessionId,
    ]) {
      if (typeof candidate === "string" && !seen.has(candidate)) {
        seen.add(candidate);
        result.push(candidate);
      }
    }
  }
  return result;
}

function mapCorrelation(
  sourceId: string | null,
  input: Readonly<{
    forkCorrelationId: string;
    mint: (kind: "event" | "session" | "correlation", sourceId: string) => string;
  }>,
  correlations: Map<string, string>,
  destinations: Set<string>,
): string {
  if (sourceId === null) return input.forkCorrelationId;
  const existing = correlations.get(sourceId);
  if (existing !== undefined) return existing;
  const destination = input.mint("correlation", sourceId);
  requireNewIdentity(destination, sourceId, "correlation");
  if (destinations.has(destination)) {
    throw forkError(
      "workspace-fork.correlation-mint-collision",
      `minted correlation identity collides: ${destination}`,
    );
  }
  destinations.add(destination);
  correlations.set(sourceId, destination);
  return destination;
}

function sourceSessionIdFrom(payload: Record<string, unknown>): string | null {
  return typeof payload.sessionId === "string" ? payload.sessionId : null;
}

function assertUniqueValues(values: ReadonlyMap<string, string>, code: string): void {
  if (new Set(values.values()).size !== values.size) {
    throw forkError(code, "minted identities are not unique");
  }
}

function requireNewIdentity(destination: string, source: string, kind: string): void {
  if (destination.length === 0 || destination === source) {
    throw forkError(`workspace-fork.${kind}-identity`, `destination ${kind} identity must be new`);
  }
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  const record = optionalRecord(value);
  if (record === null) throw forkError("workspace-fork.payload-invalid", `${field} is invalid`);
  return record;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function forkError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): WorkspaceForkError {
  return new WorkspaceForkError(code, message, details);
}
