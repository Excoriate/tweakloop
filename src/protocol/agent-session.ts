import type { SessionArtifactRecord } from "./session-lineage.js";
import type { SnapshotChatMessage, SnapshotWork } from "./snapshot.js";
import { AGENT_SESSION_PROTOCOL } from "./versions.js";

export type AgentSessionSnapshot = Readonly<{
  protocol: typeof AGENT_SESSION_PROTOCOL;
  kind: "snapshot";
  appliedSeq: number;
  agentId: string;
  processNonce: string;
  sessionId: string | null;
  artifactId: string | null;
  artifacts: readonly SessionArtifactRecord[];
  work: readonly SnapshotWork[];
  chat: readonly SnapshotChatMessage[];
}>;

export type AgentSessionDelta = Readonly<{
  protocol: typeof AGENT_SESSION_PROTOCOL;
  kind: "delta";
  seq: number;
  eventType: string;
  streamType: string;
  streamId: string;
  payload: unknown;
}>;

export type AgentSessionHeartbeat = Readonly<{
  protocol: typeof AGENT_SESSION_PROTOCOL;
  kind: "heartbeat";
  appliedSeq: number;
}>;

export type AgentSessionResync = Readonly<{
  protocol: typeof AGENT_SESSION_PROTOCOL;
  kind: "resync";
  afterSeq: number;
  reason: string;
}>;

export type AgentSessionError = Readonly<{
  protocol: typeof AGENT_SESSION_PROTOCOL;
  kind: "error";
  code: string;
  message: string;
}>;

export type AgentSessionRecord =
  | AgentSessionSnapshot
  | AgentSessionDelta
  | AgentSessionHeartbeat
  | AgentSessionResync
  | AgentSessionError;

export type AgentSessionUnknown = Readonly<{
  protocol: typeof AGENT_SESSION_PROTOCOL;
  kind: string;
  value: Readonly<Record<string, unknown>>;
}>;

export type AgentSessionParseResult =
  | Readonly<{ status: "known"; record: AgentSessionRecord }>
  | Readonly<{ status: "unknown"; record: AgentSessionUnknown }>
  | Readonly<{ status: "invalid"; message: string }>;

/**
 * Forward-compatible parser for JSONL consumers. Unknown kinds are data,
 * not fatal errors; malformed records and protocol mismatches remain explicit.
 */
export function parseAgentSessionRecord(input: unknown): AgentSessionParseResult {
  if (!input || typeof input !== "object") {
    return { status: "invalid", message: "session record must be an object" };
  }
  const value = input as Record<string, unknown>;
  if (value.protocol !== AGENT_SESSION_PROTOCOL) {
    return {
      status: "invalid",
      message: `unsupported session protocol: ${String(value.protocol)}`,
    };
  }
  if (typeof value.kind !== "string" || value.kind.length === 0) {
    return { status: "invalid", message: "session record requires a kind" };
  }
  const required: Readonly<Record<string, readonly string[]>> = {
    snapshot: ["appliedSeq", "agentId", "processNonce", "artifacts", "work", "chat"],
    delta: ["seq", "eventType", "streamType", "streamId", "payload"],
    heartbeat: ["appliedSeq"],
    resync: ["afterSeq", "reason"],
    error: ["code", "message"],
  };
  const fields = required[value.kind];
  if (!fields) {
    return {
      status: "unknown",
      record: { protocol: AGENT_SESSION_PROTOCOL, kind: value.kind, value },
    };
  }
  const missing = fields.find((field) => !(field in value));
  if (missing) {
    return { status: "invalid", message: `${value.kind} record is missing ${missing}` };
  }
  return { status: "known", record: value as AgentSessionRecord };
}
