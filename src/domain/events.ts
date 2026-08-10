import type { ChatAttachment, ChatContent, ChatContext, ChatReference } from "../protocol/chat.js";
import type { ActorRef } from "../protocol/envelopes.js";
import type { IntentTarget, IntentType } from "../protocol/intents.js";
import type { SessionArtifactRole } from "./commands.js";
import type { ArtifactFormat, ArtifactProvenance } from "./state.js";

export type RevisionFile = Readonly<{ path: string; hash: string; mediaType: string }>;

/**
 * Durable domain facts. Events are values: never rewritten, only
 * appended. The stored payload is exactly one of these objects, so each
 * fact is self-contained (revision seq, parents, etc. are recorded, not
 * recomputed).
 */
export type DomainEvent =
  | Readonly<{
      type: "workspace.opened";
      workspaceId: string;
      projectId: string;
      rootPath: string;
    }>
  | Readonly<{
      type: "workspace.restored";
      workspaceId: string;
      projectId: string;
      rootPath: string;
      sourceWorkspaceId: string;
      sourceProjectId: string;
      sourceRootPath: string;
      capturedSeq: number;
    }>
  | Readonly<{
      type: "artifact.registered";
      artifactId: string;
      name: string;
      format: ArtifactFormat;
      sourcePath: string | null;
      provenance?: ArtifactProvenance;
    }>
  | Readonly<{
      type: "artifact.revision-published";
      artifactId: string;
      revisionId: string;
      parentId: string | null;
      seq: number;
      format: ArtifactFormat;
      entryPath: string;
      entryHash: string;
      files: readonly RevisionFile[];
      producer: ActorRef;
      sourcePath: string | null;
      sessionId: string | null;
    }>
  | Readonly<{
      type: "review.batch-submitted";
      batchId: string;
      artifactId: string;
      revisionId: string;
      intentIds: readonly string[];
      sourceMessageId?: string | null;
      assigneeAgentId: string | null;
      sessionId: string | null;
    }>
  | Readonly<{
      type: "intent.created";
      intentId: string;
      batchId: string;
      artifactId: string;
      revisionId: string;
      intentType: IntentType;
      target: IntentTarget;
      body: Readonly<Record<string, unknown>>;
      sourceMessageId?: string | null;
    }>
  | Readonly<{
      type: "work.created";
      workId: string;
      artifactId: string;
      baseRevisionId: string;
      intentIds: readonly string[];
      sourceMessageId?: string | null;
      assigneeAgentId: string | null;
      sessionId: string | null;
    }>
  | Readonly<{
      type: "work.claimed";
      workId: string;
      claimId: string;
      agentId: string;
    }>
  | Readonly<{
      type: "work.addressed";
      workId: string;
      claimId: string;
      agentId: string;
      summary: string;
      revisionId: string | null;
      addressedIntentIds: readonly string[];
    }>
  | Readonly<{
      type: "work.progressed";
      workId: string;
      claimId: string;
      agentId: string;
      summary: string;
      revisionId: string | null;
      addressedIntentIds: readonly string[];
    }>
  | Readonly<{
      type: "work.claim-released";
      workId: string;
      claimId: string;
      agentId: string;
      reason: "progress" | "reopened";
    }>
  | Readonly<{
      type: "work.abandoned";
      workId: string;
      claimId: string;
      agentId: string;
    }>
  | Readonly<{
      type: "decision.accepted";
      decisionId: string;
      workId: string;
      reason: string | null;
    }>
  | Readonly<{
      type: "decision.reopened";
      decisionId: string;
      workId: string;
      reason: string;
    }>
  | Readonly<{
      type: "chat.message";
      messageId: string;
      artifactId: string | null;
      author: string;
      text: string;
      content: ChatContent;
      context: ChatContext | null;
      /** Artifact ids referenced with @-mentions — whole-file context. */
      mentions: readonly string[];
      references: readonly ChatReference[];
      attachments: readonly ChatAttachment[];
      sessionId: string | null;
      recipientAgentId: string | null;
      threadId: string | null;
      workId: string | null;
      intentId: string | null;
    }>
  | Readonly<{
      type: "chat.delivery-offered";
      messageId: string;
      sessionId: string;
      attemptId: string;
      attemptNumber: number;
      agentId: string;
      offeredAt: string;
    }>
  | Readonly<{
      type: "chat.delivery-acknowledged";
      messageId: string;
      sessionId: string;
      attemptId: string;
      attemptNumber: number;
      agentId: string;
      offeredAt: string;
      acknowledgedAt: string;
    }>
  | Readonly<{
      type: "chat.delivery-paused";
      messageId: string;
      sessionId: string;
      attemptId: string;
      attemptNumber: number;
      agentId: string;
      offeredAt: string;
      pausedAt: string;
      reason: "retry-budget-exhausted";
    }>
  | Readonly<{
      type: "chat.delivery-resumed";
      messageId: string;
      sessionId: string;
      resumedAt: string;
    }>
  | Readonly<{
      type: "session.started";
      sessionId: string;
      artifactId: string | null;
      originatingAgentId: string;
      agentId: string;
      processNonce: string;
      baseRevisionId: string | null;
      title: string;
      goal: string;
      predecessorSessionId: string | null;
      handoffSummary: string | null;
    }>
  | Readonly<{
      type: "session.artifact-attached";
      sessionId: string;
      artifactId: string;
      revisionId: string;
      role: SessionArtifactRole;
    }>
  | Readonly<{
      type: "session.handoff-offered";
      sessionId: string;
      agentId: string;
      toAgentId: string;
      summary: string;
    }>
  | Readonly<{
      type: "session.ended";
      sessionId: string;
      agentId: string;
      summary: string;
    }>;

export type DomainEventType = DomainEvent["type"];

export type StreamRef = Readonly<{ streamType: string; streamId: string }>;

/** Which stream a fact belongs to; stream versions gate optimistic concurrency. */
export function streamOf(event: DomainEvent): StreamRef {
  switch (event.type) {
    case "workspace.opened":
    case "workspace.restored":
      return { streamType: "workspace", streamId: event.workspaceId };
    case "artifact.registered":
    case "artifact.revision-published":
      return { streamType: "artifact", streamId: event.artifactId };
    case "review.batch-submitted":
    case "intent.created":
      return { streamType: "review", streamId: event.batchId };
    case "work.created":
    case "work.claimed":
    case "work.addressed":
    case "work.progressed":
    case "work.claim-released":
    case "work.abandoned":
    case "decision.accepted":
    case "decision.reopened":
      return { streamType: "work", streamId: event.workId };
    case "chat.message":
      return { streamType: "chat", streamId: event.artifactId ?? "workspace" };
    case "chat.delivery-offered":
    case "chat.delivery-acknowledged":
    case "chat.delivery-paused":
    case "chat.delivery-resumed":
      return { streamType: "chat-delivery", streamId: event.messageId };
    case "session.started":
    case "session.artifact-attached":
    case "session.handoff-offered":
    case "session.ended":
      return { streamType: "session", streamId: event.sessionId };
  }
}
