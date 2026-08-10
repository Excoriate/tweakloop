import type { ChatAttachment, ChatContent, ChatContext, ChatReference } from "../protocol/chat.js";
import type { ActorRef } from "../protocol/envelopes.js";
import type { IntentInput } from "../protocol/intents.js";
import type { RevisionFile } from "./events.js";
import type { ArtifactFormat, ArtifactProvenance } from "./state.js";

export type SessionArtifactRole = "primary" | "opened" | "whiteboard";

/**
 * Domain commands are values built at the boundary from validated
 * command envelopes. IDs, hashes, and paths arrive as inputs — the
 * domain never generates identity, time, or randomness.
 */
export type DomainCommand =
  | Readonly<{
      type: "workspace.open";
      workspaceId: string;
      projectId: string;
      rootPath: string;
    }>
  | Readonly<{
      type: "artifact.register";
      artifactId: string;
      name: string;
      format: ArtifactFormat;
      sourcePath: string | null;
      provenance?: ArtifactProvenance;
    }>
  | Readonly<{
      type: "artifact.create";
      artifactId: string;
      name: string;
      format: ArtifactFormat;
      sourcePath: string | null;
      provenance: ArtifactProvenance;
      revisionId: string;
      entryPath: string;
      entryHash: string;
      files: readonly RevisionFile[];
      producer: ActorRef;
      attachment: Readonly<{ sessionId: string; role: SessionArtifactRole }> | null;
    }>
  | Readonly<{
      type: "session.open-artifact";
      sessionId: string;
      artifactId: string;
      name: string;
      format: ArtifactFormat;
      sourcePath: string;
      provenance: ArtifactProvenance;
      revisionId: string;
      entryPath: string;
      entryHash: string;
      files: readonly RevisionFile[];
      producer: ActorRef;
      role: SessionArtifactRole;
    }>
  | Readonly<{
      type: "artifact.publish";
      artifactId: string;
      revisionId: string;
      format: ArtifactFormat;
      entryPath: string;
      entryHash: string;
      files: readonly RevisionFile[];
      producer: ActorRef;
      sourcePath: string | null;
      sessionId?: string | null;
    }>
  | Readonly<{
      type: "review.submit-batch";
      batchId: string;
      workId: string;
      artifactId: string;
      revisionId: string;
      intents: readonly IntentInput[];
      sourceMessageId?: string | null;
      assigneeAgentId?: string | null;
      sessionId?: string | null;
    }>
  | Readonly<{
      type: "review.submit-comments";
      batchId: string;
      artifactId: string;
      revisionId: string;
      intents: readonly IntentInput[];
      assigneeAgentId?: string | null;
      sessionId?: string | null;
    }>
  | Readonly<{
      type: "work.create-from-intents";
      workId: string;
      intentIds: readonly string[];
      decisionId: string;
      reason: string;
      assigneeAgentId?: string | null;
      sessionId?: string | null;
    }>
  | Readonly<{
      type: "work.claim";
      claimId: string;
      agentId: string;
      workId?: string | null;
    }>
  | Readonly<{
      type: "work.complete";
      workId: string;
      claimId: string;
      agentId: string;
      summary: string;
      revisionId: string | null;
      addressedIntentIds: readonly string[] | null;
    }>
  | Readonly<{
      type: "work.progress";
      workId: string;
      claimId: string;
      agentId: string;
      summary: string;
      revisionId: string | null;
      addressedIntentIds: readonly string[];
      releaseClaim: boolean;
    }>
  | Readonly<{
      type: "work.reclaim";
      workId: string;
      staleClaimId: string;
      claimId: string;
      agentId: string;
    }>
  | Readonly<{
      type: "decision.accept";
      decisionId: string;
      workId: string;
      reason: string | null;
      actor: ActorRef;
    }>
  | Readonly<{
      type: "decision.reopen";
      decisionId: string;
      workId: string;
      reason: string;
      actor: ActorRef;
    }>
  | Readonly<{
      type: "chat.send";
      messageId: string;
      artifactId: string | null;
      author: string;
      text: string;
      content?: ChatContent;
      actor?: ActorRef;
      context: ChatContext | null;
      mentions: readonly string[];
      references?: readonly ChatReference[];
      attachments?: readonly ChatAttachment[];
      sessionId?: string | null;
      recipientAgentId?: string | null;
      threadId?: string | null;
      workId?: string | null;
      intentId?: string | null;
    }>
  | Readonly<{
      type: "chat.delivery-offer";
      messageId: string;
      sessionId: string;
      agentId: string;
      processNonce: string;
      attemptId: string;
      attemptNumber: number;
      offeredAt: string;
    }>
  | Readonly<{
      type: "chat.delivery-acknowledge";
      messageId: string;
      sessionId: string;
      agentId: string;
      processNonce: string;
      attemptId: string;
      acknowledgedAt: string;
    }>
  | Readonly<{
      type: "chat.delivery-pause";
      messageId: string;
      attemptId: string;
      pausedAt: string;
      reason: "retry-budget-exhausted";
    }>
  | Readonly<{
      type: "chat.delivery-resume";
      messageId: string;
      resumedAt: string;
    }>
  | Readonly<{
      type: "session.start";
      sessionId: string;
      artifactId: string | null;
      agentId: string;
      processNonce: string;
      runtimeCapabilityHash?: string;
      baseRevisionId: string | null;
      title: string;
      goal: string;
    }>
  | Readonly<{
      type: "session.attach-artifact";
      sessionId: string;
      artifactId: string;
      revisionId: string;
      role: SessionArtifactRole;
    }>
  | Readonly<{
      type: "session.handoff";
      sessionId: string;
      agentId: string;
      toAgentId: string;
      summary: string;
    }>
  | Readonly<{
      type: "session.resume";
      sessionId: string;
      predecessorSessionId: string;
      agentId: string;
      processNonce: string;
      runtimeCapabilityHash?: string;
      baseRevisionId: string | null;
      title: string | null;
      goal: string | null;
    }>
  | Readonly<{
      type: "session.end";
      sessionId: string;
      agentId: string;
      summary: string;
    }>;
