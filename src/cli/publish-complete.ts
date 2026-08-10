import { resolve } from "node:path";
import type { CommandResult } from "../protocol/envelopes.js";
import type { Snapshot } from "../protocol/snapshot.js";
import type { PublishResult } from "./daemon-client.js";
import type { Invocation } from "./invocation.js";
import { renderInvocation } from "./invocation.js";

export type PublishCompleteContext = Readonly<{
  workId: string;
  artifactId: string;
  baseRevisionId: string;
  sessionId: string | null;
  claimId: string;
  agentId: string;
}>;

export type PublishCompleteInput = Readonly<{
  snapshot: Snapshot;
  path: string;
  rootPath: string;
  workId: string;
  summary: string;
  intentIds?: readonly string[];
  invocation: Invocation;
}>;

type PublishCompleteDeps = Readonly<{
  publish: (context: PublishCompleteContext) => Promise<PublishResult>;
  complete: (context: PublishCompleteContext, published: PublishResult) => Promise<CommandResult>;
}>;

export type PublishCompleteOutcome =
  | Readonly<{
      kind: "completed";
      receipt: Readonly<{
        artifactId: string;
        revisionId: string;
        seq: number;
        unchanged: boolean;
        workId: string;
        status: string;
      }>;
    }>
  | Readonly<{
      kind: "partial";
      code: "publish-complete.partial";
      message: string;
      receipt: Readonly<{
        artifactId: string;
        revisionId: string;
        seq: number;
        unchanged: boolean;
        workId: string;
        status: "published";
      }>;
      recoveryKind: "inspect-current-work" | "retry-completion";
      recoveryCommand: string;
    }>
  | Readonly<{
      kind: "unchanged-base";
      code: "publish-complete.unchanged-base";
      message: string;
      receipt: Readonly<{
        artifactId: string;
        revisionId: string;
        seq: number;
        unchanged: boolean;
        workId: string;
        status: "claimed";
      }>;
      recoveryKind: "retry-completion";
      recoveryCommand: string;
    }>;

export function derivePublishCompleteContext(
  snapshot: Snapshot,
  workId: string,
  path: string,
): PublishCompleteContext {
  const work = snapshot.work.find((candidate) => candidate.workId === workId);
  if (!work) throw new Error(`publish-complete.work-missing: unknown work item ${workId}`);
  if (work.status !== "claimed" || !work.claim) {
    throw new Error(`publish-complete.not-claimed: work ${workId} has no active claim`);
  }
  const artifact = snapshot.artifacts.find((candidate) => candidate.artifactId === work.artifactId);
  if (!artifact) {
    throw new Error(
      `publish-complete.artifact-missing: work ${workId} references unknown artifact ${work.artifactId}`,
    );
  }
  const absolutePath = resolve(path);
  if (artifact.sourcePath !== null && artifact.sourcePath !== absolutePath) {
    throw new Error(
      `publish-complete.artifact-mismatch: ${absolutePath} does not resolve to work artifact ${work.artifactId}`,
    );
  }
  if (artifact.sourcePath === null && work.sessionId === null) {
    throw new Error(
      `publish-complete.session-missing: imported artifact ${work.artifactId} requires a work session`,
    );
  }
  return {
    workId,
    artifactId: work.artifactId,
    baseRevisionId: work.baseRevisionId,
    sessionId: work.sessionId,
    claimId: work.claim.claimId,
    agentId: work.claim.agentId,
  };
}

export async function publishAndComplete(
  input: PublishCompleteInput,
  deps: PublishCompleteDeps,
): Promise<PublishCompleteOutcome> {
  const context = derivePublishCompleteContext(input.snapshot, input.workId, input.path);
  const published = await deps.publish(context);
  if (published.artifactId !== context.artifactId) {
    throw new Error(
      `publish-complete.artifact-mismatch: publish returned ${published.artifactId}, expected ${context.artifactId}`,
    );
  }
  const recoveryCommand = completeRecoveryCommand(input, context, published.revisionId);
  const baseReceipt = {
    artifactId: published.artifactId,
    revisionId: published.revisionId,
    seq: published.seq,
    unchanged: published.unchanged,
    workId: context.workId,
  };
  if (published.unchanged && published.revisionId === context.baseRevisionId) {
    return {
      kind: "unchanged-base",
      code: "publish-complete.unchanged-base",
      message:
        "the file is unchanged at the reviewed base; make the intended artifact change or deliberately run the summary-only recovery command without --revision-id",
      receipt: { ...baseReceipt, status: "claimed" },
      recoveryKind: "retry-completion",
      recoveryCommand: completeRecoveryCommand(input, context),
    };
  }
  const completed = await deps.complete(context, published);
  if (completed.status === "rejected") {
    const staleClaim = completed.code === "work.stale-claim";
    return {
      kind: "partial",
      code: "publish-complete.partial",
      message: `${completed.code}: ${completed.message}`,
      receipt: { ...baseReceipt, status: "published" },
      recoveryKind: staleClaim ? "inspect-current-work" : "retry-completion",
      recoveryCommand: staleClaim ? currentWorkRecoveryCommand(input, context) : recoveryCommand,
    };
  }
  const response = completed.response as { status?: unknown };
  return {
    kind: "completed",
    receipt: {
      ...baseReceipt,
      status: typeof response.status === "string" ? response.status : "addressed",
    },
  };
}

function currentWorkRecoveryCommand(
  input: PublishCompleteInput,
  context: PublishCompleteContext,
): string {
  return renderInvocation(input.invocation, [
    "--workspace",
    input.rootPath,
    "work",
    "list",
    "--work",
    context.workId,
    "--status",
    "all",
    "--json",
  ]);
}

function completeRecoveryCommand(
  input: PublishCompleteInput,
  context: PublishCompleteContext,
  revisionId?: string,
): string {
  return renderInvocation(input.invocation, [
    "--workspace",
    input.rootPath,
    "work",
    "complete",
    context.workId,
    "--claim",
    context.claimId,
    "--summary",
    input.summary,
    ...(revisionId ? ["--revision-id", revisionId] : []),
    ...(input.intentIds ? ["--intent-ids", input.intentIds.join(",")] : []),
    "--json",
  ]);
}
