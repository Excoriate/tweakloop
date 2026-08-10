import type { ChatAttachment, ChatContent, ChatContext, ChatReference } from "./chat.js";
import type { ActorRef } from "./envelopes.js";
import type { IntentTarget } from "./intents.js";
import type { SessionArtifactRecord } from "./session-lineage.js";

/**
 * The projection snapshot served to browsers and the CLI —
 * versioned public data, like every protocol shape.
 */

export type SnapshotArtifact = Readonly<{
  artifactId: string;
  name: string;
  format: string;
  sourcePath: string | null;
  provenance: Readonly<{
    kind: "workspace-source" | "imported-snapshot" | "generated";
    originalName?: string;
  }>;
  registeredSeq: number;
}>;

export type SnapshotRevision = Readonly<{
  revisionId: string;
  artifactId: string;
  parentId: string | null;
  seq: number;
  format: string;
  entryPath: string;
  entryHash: string;
  producer: ActorRef;
  createdSeq: number;
}>;

export type SnapshotIntent = Readonly<{
  intentId: string;
  batchId: string;
  artifactId: string;
  revisionId: string;
  intentType: string;
  target: IntentTarget;
  body: Readonly<Record<string, unknown>>;
  status: "submitted" | "addressed";
  createdSeq: number;
}>;

export type SnapshotWork = Readonly<{
  workId: string;
  artifactId: string;
  baseRevisionId: string;
  intentIds: readonly string[];
  status: "open" | "claimed" | "addressed";
  assigneeAgentId: string | null;
  sessionId: string | null;
  claim: Readonly<{ claimId: string; agentId: string }> | null;
  result: Readonly<{ summary: string; revisionId: string | null; agentId: string }> | null;
  progress: readonly Readonly<{
    summary: string;
    revisionId: string | null;
    agentId: string;
    addressedIntentIds: readonly string[];
    seq: number;
    recordedAt: string;
  }>[];
  decision: "pending" | "accepted" | "reopened";
  createdSeq: number;
}>;

export type SnapshotChatDelivery = Readonly<{
  status: "offered" | "acknowledged" | "paused";
  attemptId: string | null;
  attemptNumber: number;
  agentId: string | null;
  offeredAt: string | null;
  acknowledgedAt: string | null;
  pausedAt: string | null;
  pauseReason: "retry-budget-exhausted" | null;
}>;

export type SnapshotChatMessage = Readonly<{
  messageId: string;
  artifactId: string | null;
  author: string;
  text: string;
  content: ChatContent;
  context: ChatContext | null;
  mentions: readonly string[];
  references: readonly ChatReference[];
  attachments: readonly ChatAttachment[];
  sessionId: string | null;
  recipientAgentId: string | null;
  threadId: string | null;
  workId: string | null;
  intentId: string | null;
  delivery: SnapshotChatDelivery | null;
  questionState:
    | Readonly<{ status: "pending" }>
    | Readonly<{
        status: "answered";
        answerMessageId: string;
        optionKey: string;
        optionLabel: string;
      }>
    | null;
  answerState:
    | Readonly<{ status: "current" }>
    | Readonly<{ status: "superseded"; supersededByMessageId: string }>
    | null;
  recordedAt: string;
  createdSeq: number;
}>;

export type SnapshotTimelineEntry = Readonly<{
  seq: number;
  recordedAt: string;
  eventType: string;
  streamType: string;
  streamId: string;
  summary: string;
}>;

export type Snapshot = Readonly<{
  protocol: "tweakloop.snapshot/v1";
  workspace: Readonly<{
    workspaceId: string;
    projectId: string;
    rootPath: string;
    protocolVersion: number;
    artifactOrigin: string;
  }>;
  artifacts: readonly SnapshotArtifact[];
  sessionArtifacts: readonly (SessionArtifactRecord & Readonly<{ sessionId: string }>)[];
  revisions: readonly SnapshotRevision[];
  intents: readonly SnapshotIntent[];
  work: readonly SnapshotWork[];
  chat: readonly SnapshotChatMessage[];
  timeline: readonly SnapshotTimelineEntry[];
  lastSeq: number;
}>;
