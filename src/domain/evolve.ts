import { type ChatContent, chatContentOrText } from "../protocol/chat.js";
import type { DomainEvent } from "./events.js";
import { type DomainState, initialState } from "./state.js";

/** Deterministic fold step: same events in the same order, same state. */
export function evolve(state: DomainState, event: DomainEvent): DomainState {
  switch (event.type) {
    case "workspace.opened":
    case "workspace.restored":
      return { ...state, workspaceOpened: true, projectId: event.projectId };

    case "artifact.registered": {
      const artifacts = new Map(state.artifacts);
      artifacts.set(event.artifactId, {
        artifactId: event.artifactId,
        name: event.name,
        format: event.format,
        sourcePath: event.sourcePath,
        provenance:
          event.provenance ??
          (event.sourcePath === null
            ? { kind: "imported-snapshot" as const }
            : { kind: "workspace-source" as const }),
      });
      return { ...state, artifacts };
    }

    case "artifact.revision-published": {
      const revisions = new Map(state.revisions);
      revisions.set(event.revisionId, {
        revisionId: event.revisionId,
        artifactId: event.artifactId,
        parentId: event.parentId,
        seq: event.seq,
        entryHash: event.entryHash,
      });
      const heads = new Map(state.heads);
      heads.set(event.artifactId, event.revisionId);
      return { ...state, revisions, heads };
    }

    case "session.started": {
      const sessions = new Map(state.sessions);
      const inferredRevisionId =
        event.artifactId === null
          ? null
          : (event.baseRevisionId ?? state.heads.get(event.artifactId) ?? null);
      sessions.set(event.sessionId, {
        sessionId: event.sessionId,
        primaryArtifactId: event.artifactId,
        artifacts:
          event.artifactId !== null && inferredRevisionId !== null
            ? [
                {
                  artifactId: event.artifactId,
                  attachedRevisionId: inferredRevisionId,
                  role: "primary",
                },
              ]
            : [],
        originatingAgentId: event.originatingAgentId,
        agentId: event.agentId,
        processNonce: event.processNonce,
        baseRevisionId: event.baseRevisionId,
        title: event.title,
        goal: event.goal,
        predecessorSessionId: event.predecessorSessionId,
        status: "active",
        handoffToAgentId: null,
        handoffSummary: event.handoffSummary,
        summary: null,
      });
      return { ...state, sessions };
    }

    case "session.artifact-attached": {
      const existing = state.sessions.get(event.sessionId);
      if (!existing) return state;
      const current = existing.artifacts.find((item) => item.artifactId === event.artifactId);
      const artifacts = current
        ? existing.artifacts.map((item) =>
            item.artifactId === event.artifactId
              ? {
                  artifactId: event.artifactId,
                  attachedRevisionId: event.revisionId,
                  role: event.role,
                }
              : item,
          )
        : [
            ...existing.artifacts,
            {
              artifactId: event.artifactId,
              attachedRevisionId: event.revisionId,
              role: event.role,
            },
          ];
      const sessions = new Map(state.sessions);
      sessions.set(event.sessionId, {
        ...existing,
        primaryArtifactId: event.role === "primary" ? event.artifactId : existing.primaryArtifactId,
        artifacts,
      });
      return { ...state, sessions };
    }

    case "session.handoff-offered": {
      const existing = state.sessions.get(event.sessionId);
      if (!existing) return state;
      const sessions = new Map(state.sessions);
      sessions.set(event.sessionId, {
        ...existing,
        status: "handed-off",
        handoffToAgentId: event.toAgentId,
        handoffSummary: event.summary,
      });
      return { ...state, sessions };
    }

    case "session.ended": {
      const existing = state.sessions.get(event.sessionId);
      if (!existing) return state;
      const sessions = new Map(state.sessions);
      sessions.set(event.sessionId, { ...existing, status: "ended", summary: event.summary });
      return { ...state, sessions };
    }

    case "review.batch-submitted":
      // Queryable history with no decision-relevant state; projections render it.
      return state;

    case "chat.message": {
      const chat = new Map(state.chat);
      chat.set(event.messageId, {
        messageId: event.messageId,
        artifactId: event.artifactId,
        author: event.author,
        text: event.text,
        content: chatContentOrText(
          (event as typeof event & { content?: ChatContent }).content,
          event.text,
        ),
        context: event.context,
        mentions: event.mentions,
        references: event.references,
        attachments: event.attachments,
        sessionId: event.sessionId,
        recipientAgentId: event.recipientAgentId,
        correlatedWorkId: event.workId,
        correlatedIntentId: event.intentId,
        promotedWorkId: null,
        promotedIntentId: null,
        delivery: null,
      });
      return { ...state, chat };
    }

    case "chat.delivery-offered": {
      const message = state.chat.get(event.messageId);
      if (!message) return state;
      const chat = new Map(state.chat);
      chat.set(event.messageId, {
        ...message,
        delivery: {
          status: "offered",
          attemptId: event.attemptId,
          attemptNumber: event.attemptNumber,
          agentId: event.agentId,
          offeredAt: event.offeredAt,
          acknowledgedAt: null,
          pausedAt: null,
          pauseReason: null,
        },
      });
      return { ...state, chat };
    }

    case "chat.delivery-acknowledged": {
      const message = state.chat.get(event.messageId);
      if (!message) return state;
      const chat = new Map(state.chat);
      chat.set(event.messageId, {
        ...message,
        delivery: {
          status: "acknowledged",
          attemptId: event.attemptId,
          attemptNumber: event.attemptNumber,
          agentId: event.agentId,
          offeredAt: event.offeredAt,
          acknowledgedAt: event.acknowledgedAt,
          pausedAt: null,
          pauseReason: null,
        },
      });
      return { ...state, chat };
    }

    case "chat.delivery-paused": {
      const message = state.chat.get(event.messageId);
      if (!message) return state;
      const chat = new Map(state.chat);
      chat.set(event.messageId, {
        ...message,
        delivery: {
          status: "paused",
          attemptId: event.attemptId,
          attemptNumber: event.attemptNumber,
          agentId: event.agentId,
          offeredAt: event.offeredAt,
          acknowledgedAt: null,
          pausedAt: event.pausedAt,
          pauseReason: event.reason,
        },
      });
      return { ...state, chat };
    }

    case "chat.delivery-resumed": {
      const message = state.chat.get(event.messageId);
      if (!message) return state;
      const chat = new Map(state.chat);
      chat.set(event.messageId, { ...message, delivery: null });
      return { ...state, chat };
    }

    case "intent.created": {
      const intents = new Map(state.intents);
      intents.set(event.intentId, {
        intentId: event.intentId,
        batchId: event.batchId,
        artifactId: event.artifactId,
        revisionId: event.revisionId,
        intentType: event.intentType,
        target: event.target,
        body: event.body,
        sourceMessageId: event.sourceMessageId ?? null,
        addressedByWorkId: null,
      });
      if (event.sourceMessageId == null) return { ...state, intents };
      const message = state.chat.get(event.sourceMessageId);
      if (!message) return { ...state, intents };
      const chat = new Map(state.chat);
      chat.set(event.sourceMessageId, { ...message, promotedIntentId: event.intentId });
      return { ...state, intents, chat };
    }

    case "work.created": {
      const work = new Map(state.work);
      work.set(event.workId, {
        workId: event.workId,
        artifactId: event.artifactId,
        baseRevisionId: event.baseRevisionId,
        intentIds: event.intentIds,
        sourceMessageId: event.sourceMessageId ?? null,
        assigneeAgentId: event.assigneeAgentId ?? null,
        sessionId: event.sessionId ?? null,
        claim: null,
        addressed: false,
        decisionStatus: "pending",
      });
      if (event.sourceMessageId == null) return { ...state, work };
      const message = state.chat.get(event.sourceMessageId);
      if (!message) return { ...state, work };
      const chat = new Map(state.chat);
      chat.set(event.sourceMessageId, { ...message, promotedWorkId: event.workId });
      return { ...state, work, chat };
    }

    case "work.claimed": {
      const existing = state.work.get(event.workId);
      if (!existing) return state;
      const work = new Map(state.work);
      work.set(event.workId, {
        ...existing,
        claim: { claimId: event.claimId, agentId: event.agentId },
      });
      return { ...state, work };
    }

    case "work.addressed": {
      const existing = state.work.get(event.workId);
      if (!existing) return state;
      const work = new Map(state.work);
      work.set(event.workId, {
        ...existing,
        addressed: true,
        claim: null,
        decisionStatus: "pending",
      });
      const intents = new Map(state.intents);
      for (const intentId of event.addressedIntentIds) {
        const intent = intents.get(intentId);
        if (intent) intents.set(intentId, { ...intent, addressedByWorkId: event.workId });
      }
      return { ...state, work, intents };
    }

    case "work.progressed": {
      const existing = state.work.get(event.workId);
      if (!existing) return state;
      const intents = new Map(state.intents);
      for (const intentId of event.addressedIntentIds) {
        const intent = intents.get(intentId);
        if (intent) intents.set(intentId, { ...intent, addressedByWorkId: event.workId });
      }
      return { ...state, intents };
    }

    case "work.claim-released":
    case "work.abandoned": {
      const existing = state.work.get(event.workId);
      if (!existing || existing.claim?.claimId !== event.claimId) return state;
      const work = new Map(state.work);
      work.set(event.workId, { ...existing, claim: null });
      return { ...state, work };
    }

    case "decision.accepted": {
      const existing = state.work.get(event.workId);
      if (!existing) return state;
      const work = new Map(state.work);
      work.set(event.workId, { ...existing, decisionStatus: "accepted" });
      return { ...state, work };
    }

    case "decision.reopened": {
      const existing = state.work.get(event.workId);
      if (!existing) return state;
      const work = new Map(state.work);
      work.set(event.workId, {
        ...existing,
        addressed: false,
        claim: null,
        decisionStatus: "reopened",
      });
      const intents = new Map(state.intents);
      for (const intentId of existing.intentIds) {
        const intent = intents.get(intentId);
        if (intent?.addressedByWorkId === event.workId) {
          intents.set(intentId, { ...intent, addressedByWorkId: null });
        }
      }
      return { ...state, work, intents };
    }
  }
}

export function replay(events: readonly DomainEvent[]): DomainState {
  return events.reduce(evolve, initialState);
}
