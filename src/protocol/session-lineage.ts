import type { SnapshotChatMessage, SnapshotIntent, SnapshotWork } from "./snapshot.js";

export type SessionStatus = "active" | "handed-off" | "ended";

export type SessionArtifactRecord = Readonly<{
  artifactId: string;
  name: string;
  format: "html" | "markdown" | "whiteboard";
  sourcePath: string | null;
  provenance: Readonly<{
    kind: "workspace-source" | "imported-snapshot" | "generated";
    originalName?: string;
  }>;
  attachedRevisionId: string;
  attachedEntryHash: string;
  currentRevisionId: string;
  currentEntryHash: string;
  role: "primary" | "opened" | "whiteboard";
  attachedSeq: number;
}>;

/**
 * Durable session lineage plus query-time derived collaboration state.
 * `lastActiveAt` is the timestamp of the last committed correlated fact;
 * it is deliberately not a live-presence signal.
 */
export type SessionRecord = Readonly<{
  sessionId: string;
  primaryArtifactId: string | null;
  /** Compatibility alias for primaryArtifactId. */
  artifactId: string | null;
  artifactName: string | null;
  artifactFormat: "html" | "markdown" | "whiteboard" | null;
  sourcePath: string | null;
  originatingAgentId: string;
  agentId: string;
  processNonce: string;
  status: SessionStatus;
  baseRevisionId: string | null;
  headRevisionId: string | null;
  latestSessionRevisionId: string | null;
  title: string;
  goal: string;
  summary: string | null;
  predecessorSessionId: string | null;
  successorSessionIds: readonly string[];
  handoff: Readonly<{ toAgentId: string; summary: string }> | null;
  createdAt: string;
  lastActiveAt: string;
  endedAt: string | null;
  /** Presence cannot be inferred from durable history; use the live presence/lease APIs. */
  presence: "unknown";
  work: readonly SnapshotWork[];
  intents: readonly SnapshotIntent[];
  chat: readonly SnapshotChatMessage[];
  openIntentIds: readonly string[];
  transcriptComplete: true;
  artifacts: readonly SessionArtifactRecord[];
  relatedArtifacts: readonly Readonly<{
    artifactId: string;
    name: string;
    format: "html" | "markdown" | "whiteboard";
    sourcePath: string | null;
  }>[];
}>;

export type SessionListResponse = Readonly<{
  protocol: "tweakloop.sessions/v1";
  sessions: readonly SessionRecord[];
}>;
