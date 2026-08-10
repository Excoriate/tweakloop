import type { SemanticIndex } from "./semantic-types.js";

export type GuardIntent = Readonly<{
  intentId: string;
  intentType: string;
  semanticId: string | null;
  status: "submitted" | "addressed";
  actorKind: "human" | "agent" | "system" | "unknown";
}>;

export type SemanticGuardResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false;
      code: "artifact.semantic-duplicate-id" | "artifact.protected-anchor-loss";
      message: string;
      details: Readonly<{ semanticIds: readonly string[]; intentIds: readonly string[] }>;
    }>;

export function guardSemanticPublish(
  head: SemanticIndex | null,
  candidate: SemanticIndex,
  intents: readonly GuardIntent[],
): SemanticGuardResult {
  const duplicateIds = [
    ...new Set(
      candidate.findings
        .filter((finding) => finding.code === "anchor.duplicate-id")
        .map((finding) => finding.semanticId)
        .filter((id): id is string => typeof id === "string"),
    ),
  ].sort();
  if (duplicateIds.length > 0) {
    return {
      ok: false,
      code: "artifact.semantic-duplicate-id",
      message: `candidate repeats semantic IDs: ${duplicateIds.join(", ")}`,
      details: { semanticIds: duplicateIds, intentIds: [] },
    };
  }
  if (!head) return { ok: true };

  const headIds = new Set(head.nodes.map((node) => node.id));
  const candidateIds = new Set(candidate.nodes.map((node) => node.id));
  const authorizedRemovals = new Set(
    intents
      .filter(
        (intent) =>
          intent.status === "submitted" &&
          intent.intentType === "remove" &&
          intent.actorKind === "human" &&
          intent.semanticId !== null,
      )
      .map((intent) => intent.semanticId as string),
  );
  const protectedById = new Map<string, string[]>();
  for (const intent of intents) {
    if (
      intent.status !== "submitted" ||
      intent.intentType === "remove" ||
      intent.semanticId === null
    ) {
      continue;
    }
    protectedById.set(intent.semanticId, [
      ...(protectedById.get(intent.semanticId) ?? []),
      intent.intentId,
    ]);
  }
  const lost = [...protectedById.keys()]
    .filter((id) => headIds.has(id) && !candidateIds.has(id) && !authorizedRemovals.has(id))
    .sort();
  if (lost.length === 0) return { ok: true };
  return {
    ok: false,
    code: "artifact.protected-anchor-loss",
    message: `candidate removes semantic IDs protected by unresolved human intent: ${lost.join(", ")}`,
    details: {
      semanticIds: lost,
      intentIds: lost.flatMap((id) => protectedById.get(id) ?? []),
    },
  };
}
