import type {
  WorkspaceActivation,
  WorkspaceActivationResolution,
  WorkspaceRuntimeAttempt,
} from "./restore-journal.js";

export type WorkspaceRuntimeObservation = "ready" | "live-no-ready" | "absent" | "dead" | "alien";

export function runtimeAttemptDecision(
  input: Readonly<{
    attempt: WorkspaceRuntimeAttempt;
    observed: WorkspaceRuntimeObservation;
    now: string;
  }>,
): "ready" | "pending" | "stuck" | "failed" | "conflict" {
  if (input.observed === "ready") return "ready";
  if (input.observed === "alien") return "conflict";
  if (input.observed === "absent" || input.observed === "dead") return "failed";
  return Date.parse(input.now) < Date.parse(input.attempt.deadline) ? "pending" : "stuck";
}

type SessionLineageState = Readonly<{
  state: "active" | "ended" | "handed-off";
  successor: string | null;
}>;

export function resolveWorkspaceActivation(
  events: readonly Readonly<{
    seq: number;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
  }>[],
  sessionId: string,
): WorkspaceActivationResolution {
  const lineage = new Map<string, SessionLineageState>([
    [sessionId, { state: "active", successor: null }],
  ]);
  let currentSessionId = sessionId;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const eventSession = text(event.payload.sessionId);
    const predecessor = text(event.payload.predecessorSessionId);
    if (
      (event.eventType === "session.ended" || event.eventType === "session.handoff-offered") &&
      eventSession !== null &&
      lineage.has(eventSession)
    ) {
      const current = lineage.get(eventSession) as SessionLineageState;
      if (eventSession !== currentSessionId && current.successor === null) return recovery();
      const nextState =
        event.eventType === "session.handoff-offered" || current.state === "handed-off"
          ? "handed-off"
          : "ended";
      lineage.set(eventSession, { ...current, state: nextState });
      continue;
    }
    if (
      event.eventType !== "session.started" ||
      predecessor === null ||
      !lineage.has(predecessor)
    ) {
      continue;
    }
    if (eventSession === null) return recovery();
    const parent = lineage.get(predecessor) as SessionLineageState;
    if (predecessor !== currentSessionId) {
      if (parent.successor === eventSession) continue;
      return recovery();
    }
    if (parent.state === "active" || lineage.has(eventSession)) return recovery();
    lineage.set(predecessor, { ...parent, successor: eventSession });
    lineage.set(eventSession, { state: "active", successor: null });
    currentSessionId = eventSession;
  }
  const current = lineage.get(currentSessionId) as SessionLineageState;
  if (current.state === "ended") return terminal("session-ended");
  if (current.state === "handed-off") return terminal("handed-off");
  return currentSessionId === sessionId
    ? { activation: "attach", locatorSessionId: sessionId }
    : { activation: "successor-active", locatorSessionId: currentSessionId };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function recovery(): WorkspaceActivationResolution {
  return { activation: "recovery", locatorSessionId: null };
}

function terminal(activation: Extract<WorkspaceActivation, "session-ended" | "handed-off">) {
  return { activation, locatorSessionId: null } as const;
}
