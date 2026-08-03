/**
 * Public protocol value types. Protocols are data: these shapes are
 * versioned (see schemas/) and never expose internal classes.
 */

export type ActorRef = Readonly<{
  kind: "human" | "agent" | "system";
  id: string;
  runId?: string;
}>;

/** The single entry point for every durable mutation. */
export type CommandEnvelope = Readonly<{
  protocol: "tweakloop.command/v1";
  commandId: string;
  idempotencyKey: string;
  workspaceId: string;
  actor: ActorRef;
  type: string;
  expected?: Readonly<{ streamId: string; streamVersion: number }>;
  payload: unknown;
}>;

/** One committed fact as observed by clients (browser, CLI, agents). */
export type EventEnvelope = Readonly<{
  seq: number;
  eventId: string;
  workspaceId: string;
  streamType: string;
  streamId: string;
  streamVersion: number;
  eventType: string;
  schemaVersion: number;
  recordedAt: string;
  actor: ActorRef;
  causationId: string | null;
  correlationId: string | null;
  payload: unknown;
}>;

export type CommandAccepted = Readonly<{
  status: "accepted";
  commandId: string;
  firstEventSeq: number | null;
  lastEventSeq: number | null;
  response: unknown;
}>;

export type CommandRejected = Readonly<{
  status: "rejected";
  commandId: string;
  code: string;
  message: string;
  details?: unknown;
}>;

export type CommandResult = CommandAccepted | CommandRejected;
