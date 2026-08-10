import type { ChatAttachment, ChatContent, ChatContext, ChatReference } from "../protocol/chat.js";
import type { IntentTarget, IntentType } from "../protocol/intents.js";

/**
 * Domain state is a derived value: fold events with evolve() to produce
 * it. It is never stored; projections materialize what queries need.
 */

export type ArtifactFormat = "html" | "markdown" | "whiteboard";

export type ArtifactProvenance = Readonly<{
  kind: "workspace-source" | "imported-snapshot" | "generated";
  originalName?: string;
}>;

export type ArtifactState = Readonly<{
  artifactId: string;
  name: string;
  format: ArtifactFormat;
  sourcePath: string | null;
  provenance: ArtifactProvenance;
}>;

export type RevisionState = Readonly<{
  revisionId: string;
  artifactId: string;
  parentId: string | null;
  seq: number;
  entryHash: string;
}>;

export type IntentState = Readonly<{
  intentId: string;
  batchId: string;
  artifactId: string;
  revisionId: string;
  intentType: IntentType;
  target: IntentTarget;
  body: Readonly<Record<string, unknown>>;
  sourceMessageId: string | null;
  addressedByWorkId: string | null;
}>;

export type WorkState = Readonly<{
  workId: string;
  artifactId: string;
  baseRevisionId: string;
  intentIds: readonly string[];
  sourceMessageId: string | null;
  assigneeAgentId: string | null;
  sessionId: string | null;
  claim: Readonly<{ claimId: string; agentId: string }> | null;
  addressed: boolean;
  decisionStatus: "pending" | "accepted" | "reopened";
}>;

export type ChatMessageState = Readonly<{
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
  correlatedWorkId: string | null;
  correlatedIntentId: string | null;
  promotedWorkId: string | null;
  promotedIntentId: string | null;
  delivery: ChatDeliveryState | null;
}>;

export type ChatDeliveryState = Readonly<{
  status: "offered" | "acknowledged" | "paused";
  attemptId: string;
  attemptNumber: number;
  agentId: string;
  offeredAt: string;
  acknowledgedAt: string | null;
  pausedAt: string | null;
  pauseReason: "retry-budget-exhausted" | null;
}>;

export type SessionState = Readonly<{
  sessionId: string;
  primaryArtifactId: string | null;
  artifacts: readonly Readonly<{
    artifactId: string;
    attachedRevisionId: string;
    role: "primary" | "opened" | "whiteboard";
  }>[];
  originatingAgentId: string;
  agentId: string;
  processNonce: string;
  baseRevisionId: string | null;
  title: string;
  goal: string;
  predecessorSessionId: string | null;
  status: "active" | "handed-off" | "ended";
  handoffToAgentId: string | null;
  handoffSummary: string | null;
  summary: string | null;
}>;

export type DomainState = Readonly<{
  workspaceOpened: boolean;
  projectId: string | null;
  artifacts: ReadonlyMap<string, ArtifactState>;
  revisions: ReadonlyMap<string, RevisionState>;
  /** artifactId → revisionId of the newest revision. */
  heads: ReadonlyMap<string, string>;
  intents: ReadonlyMap<string, IntentState>;
  work: ReadonlyMap<string, WorkState>;
  chat: ReadonlyMap<string, ChatMessageState>;
  sessions: ReadonlyMap<string, SessionState>;
}>;

export const initialState: DomainState = {
  workspaceOpened: false,
  projectId: null,
  artifacts: new Map(),
  revisions: new Map(),
  heads: new Map(),
  intents: new Map(),
  work: new Map(),
  chat: new Map(),
  sessions: new Map(),
};
