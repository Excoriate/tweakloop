import type { EventEnvelope } from "../protocol/envelopes.js";
import type { SnapshotIntent } from "../protocol/snapshot.js";
import type { ArtifactDiffReceipt, ArtifactLintReceipt } from "./authoring-analysis.js";

export type ProtectionContext = Readonly<{
  artifactId: string | null;
  intents: readonly SnapshotIntent[];
  events: readonly EventEnvelope[];
}>;

export function summarizeArtifactLint(
  receipt: ArtifactLintReceipt,
  candidateAnchorIds: readonly string[],
  protection: ProtectionContext,
) {
  const protectedIds = protectionSets(protection).protectedIds;
  const anchorIds = new Set(candidateAnchorIds);
  const protectedAnchors = new Set([...anchorIds].filter((id) => protectedIds.has(id))).size;
  return {
    status: receipt.status,
    path: receipt.path,
    format: receipt.format,
    summary: true as const,
    counts: {
      nodes: receipt.nodeCount,
      anchors: anchorIds.size,
      protectedAnchors,
      findings: receipt.findings.length,
      errors: receipt.errorCount,
      warnings: receipt.warningCount,
      info: 0,
    },
  };
}

export function summarizeArtifactDiff(receipt: ArtifactDiffReceipt, protection: ProtectionContext) {
  const { protectedIds, authorizedRemovalIds } = protectionSets(protection);
  const protectedLossIds = new Set(
    receipt.removed
      .map((node) => node.id)
      .filter((id) => protectedIds.has(id) && !authorizedRemovalIds.has(id)),
  );
  const protectedChangeIds = new Set(
    [...receipt.changed, ...receipt.moved, ...receipt.kindChanged]
      .map((change) => change.after.id)
      .filter((id) => protectedIds.has(id)),
  );
  return {
    status: receipt.status === "fail" || protectedLossIds.size > 0 ? ("fail" as const) : "pass",
    path: receipt.path,
    format: receipt.format,
    baseline: receipt.baseline,
    beforeRevisionId: receipt.beforeRevisionId,
    artifactId: receipt.artifactId,
    summary: true as const,
    counts: {
      added: receipt.added.length,
      removed: receipt.removed.length,
      changed: receipt.changed.length,
      moved: receipt.moved.length,
      kindChanged: receipt.kindChanged.length,
      protectedLosses: protectedLossIds.size,
      protectedChanges: protectedChangeIds.size,
      unchanged: receipt.unchanged.length,
      collisions: receipt.collisions.length,
      unaddressable: receipt.unaddressable.length,
      possibleRenames: receipt.possibleRenames.length,
    },
  };
}

function protectionSets(context: ProtectionContext): Readonly<{
  protectedIds: ReadonlySet<string>;
  authorizedRemovalIds: ReadonlySet<string>;
}> {
  if (context.artifactId === null) {
    return { protectedIds: new Set(), authorizedRemovalIds: new Set() };
  }
  const actorKinds = new Map<string, string>();
  for (const event of context.events) {
    if (event.eventType !== "intent.created" || !isRecord(event.payload)) continue;
    const intentId = event.payload.intentId;
    if (typeof intentId === "string") actorKinds.set(intentId, event.actor.kind);
  }
  const protectedIds = new Set<string>();
  const authorizedRemovalIds = new Set<string>();
  for (const intent of context.intents) {
    if (intent.artifactId !== context.artifactId || intent.status !== "submitted") continue;
    const semanticId = intent.target.semanticId;
    if (typeof semanticId !== "string") continue;
    if (intent.intentType === "remove") {
      if (actorKinds.get(intent.intentId) === "human") authorizedRemovalIds.add(semanticId);
    } else {
      protectedIds.add(semanticId);
    }
  }
  return { protectedIds, authorizedRemovalIds };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
