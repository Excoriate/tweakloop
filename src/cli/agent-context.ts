import type { ChatReference } from "../protocol/chat.js";
import type { SessionRecord } from "../protocol/session-lineage.js";
import type { Snapshot, SnapshotWork } from "../protocol/snapshot.js";
import type { Invocation } from "./invocation.js";
import { currentInvocation, renderInvocation } from "./invocation.js";

export class AgentContextError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentContextError";
    this.code = code;
  }
}

export type SessionTrafficScope = Readonly<{
  sessionId?: string;
  artifactId?: string;
}>;

export type SessionTrafficIdentity = Readonly<{
  sessionId: string | null;
  artifactId: string | null;
}>;

/**
 * A durable session is the collaboration boundary. `artifactId` narrows
 * durable traffic only for an artifact-only listener; when `sessionId` is
 * present it remains available to select one board's draft stream.
 */
export function sessionTrafficMatches(
  scope: SessionTrafficScope,
  candidate: SessionTrafficIdentity,
): boolean {
  if (scope.sessionId !== undefined) return candidate.sessionId === scope.sessionId;
  if (scope.artifactId !== undefined) return candidate.artifactId === scope.artifactId;
  return true;
}

export function agentSnapshotScope(scope: SessionTrafficScope): Readonly<{
  sessionId?: string;
  artifactId?: string;
}> {
  if (scope.sessionId !== undefined) return { sessionId: scope.sessionId };
  if (scope.artifactId !== undefined) return { artifactId: scope.artifactId };
  return {};
}

export function resolveSessionAgentContext(
  session: SessionRecord,
  explicit: Readonly<{ agentId?: string; processNonce?: string }> = {},
  invocation: Invocation = currentInvocation(),
): Readonly<{
  agentId: string;
  processNonce: string;
  artifactId: string | null;
  sessionId: string;
}> {
  if (session.status !== "active") {
    throw new AgentContextError(
      "agent-context.session-not-active",
      `session ${session.sessionId} is ${session.status}; inspect it with ${renderInvocation(invocation, ["session", "show", session.sessionId])}, then create an active successor with ${renderInvocation(invocation, ["session", "resume", session.sessionId])}`,
    );
  }
  if (explicit.agentId !== undefined && explicit.agentId !== session.agentId) {
    throw new AgentContextError(
      "agent-context.agent-mismatch",
      `session ${session.sessionId} belongs to agent ${session.agentId}, not ${explicit.agentId}; omit --agent to derive it, or resume the session as the intended agent`,
    );
  }
  if (explicit.processNonce !== undefined && explicit.processNonce !== session.processNonce) {
    throw new AgentContextError(
      "agent-context.process-mismatch",
      `session ${session.sessionId} belongs to process ${session.processNonce}; omit --process to derive it, or resume the session to create a new process identity`,
    );
  }
  return {
    agentId: session.agentId,
    processNonce: session.processNonce,
    artifactId: session.artifactId,
    sessionId: session.sessionId,
  };
}

export function resolveClaimAgent(
  work: SnapshotWork | undefined,
  claimId: string,
  explicitAgentId?: string,
  invocation: Invocation = currentInvocation(),
): string {
  if (!work) {
    throw new AgentContextError(
      "agent-context.work-missing",
      `work item is not in the current snapshot; run ${renderInvocation(invocation, ["work", "list", "--json"])} and use an exact workId`,
    );
  }
  if (!work.claim || work.claim.claimId !== claimId) {
    throw new AgentContextError(
      "agent-context.claim-mismatch",
      `claim ${claimId} is not the active claim for work ${work.workId}; reclaim or recover the work before completing it`,
    );
  }
  if (explicitAgentId !== undefined && explicitAgentId !== work.claim.agentId) {
    throw new AgentContextError(
      "agent-context.claim-agent-mismatch",
      `claim ${claimId} belongs to agent ${work.claim.agentId}, not ${explicitAgentId}; omit --agent to derive it from the claim`,
    );
  }
  return work.claim.agentId;
}

export type DerivedWorkChatContext = Readonly<{
  workId: string;
  sessionId: string | null;
  artifactId: string;
  agentId: string;
  references: readonly ChatReference[];
}>;

/** Derive stable chat references and correlation from one durable work item. */
export function deriveWorkChatContext(
  snapshot: Snapshot,
  workId: string,
  invocation: Invocation = currentInvocation(),
): DerivedWorkChatContext {
  const work = snapshot.work.find((candidate) => candidate.workId === workId);
  if (!work) {
    throw new AgentContextError(
      "agent-context.work-missing",
      `unknown work item ${workId}; run ${renderInvocation(invocation, ["work", "list", "--json"])} and pass a returned workId`,
    );
  }
  const agentId = work.claim?.agentId ?? work.assigneeAgentId;
  if (!agentId) {
    throw new AgentContextError(
      "agent-context.work-agent-missing",
      `work ${workId} has no assigned or claiming agent; claim it first or pass explicit references instead of --from-work`,
    );
  }
  const intents = work.intentIds.map((intentId) => {
    const intent = snapshot.intents.find((candidate) => candidate.intentId === intentId);
    if (!intent) {
      throw new AgentContextError(
        "agent-context.intent-missing",
        `work ${workId} references missing intent ${intentId}; refresh the snapshot before sending chat`,
      );
    }
    return intent;
  });
  const firstIntent = intents[0];
  const taskLabel =
    work.result?.summary ??
    (firstIntent ? collaborationLabel(firstIntent.body, workId) : `Work ${workId}`);
  const references: ChatReference[] = [
    {
      kind: "task",
      label: `@task: ${taskLabel}`,
      artifactId: work.artifactId,
      workId,
    },
  ];
  for (const intent of intents) {
    references.push({
      kind: "comment",
      label: `@comment: ${collaborationLabel(intent.body, intent.intentId)}`,
      artifactId: intent.artifactId,
      revisionId: intent.revisionId,
      intentId: intent.intentId,
    });
    if (
      intent.target.textQuote === undefined &&
      intent.target.semanticId === undefined &&
      intent.target.boardAnchor === undefined
    ) {
      continue;
    }
    references.push({
      kind: "selection",
      label:
        intent.target.textQuote?.exact ??
        intent.target.boardAnchor?.elementAnchor.label ??
        intent.target.semanticId ??
        "Selected content",
      artifactId: intent.artifactId,
      revisionId: intent.revisionId,
      ...(intent.target.textQuote ? { textQuote: intent.target.textQuote } : {}),
      ...(intent.target.semanticId ? { semanticId: intent.target.semanticId } : {}),
      ...(intent.target.boardAnchor ? { boardAnchor: intent.target.boardAnchor } : {}),
    });
  }
  return {
    workId,
    sessionId: work.sessionId,
    artifactId: work.artifactId,
    agentId,
    references,
  };
}

function collaborationLabel(body: Readonly<Record<string, unknown>>, fallback: string): string {
  for (const key of ["comment", "text", "message", "instruction", "summary", "reason"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return fallback;
}
