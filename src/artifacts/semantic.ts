import { extractHtmlSemanticIndex } from "./html-semantic.js";
import { extractMarkdownSemanticIndex } from "./markdown-semantic.js";
import type {
  SemanticFinding,
  SemanticFormat,
  SemanticIndex,
  SemanticNode,
} from "./semantic-types.js";

export * from "./semantic-types.js";

export function extractSemanticIndex(
  format: SemanticFormat,
  source: string | Buffer,
): SemanticIndex {
  const text = typeof source === "string" ? source : source.toString("utf8");
  return format === "html" ? extractHtmlSemanticIndex(text) : extractMarkdownSemanticIndex(text);
}

export function lintSemantic(
  format: SemanticFormat,
  source: string | Buffer,
): Readonly<{
  ok: boolean;
  index: SemanticIndex;
  findings: readonly SemanticFinding[];
}> {
  const index = extractSemanticIndex(format, source);
  return {
    ok: !index.findings.some((finding) => finding.severity === "error"),
    index,
    findings: index.findings,
  };
}

export type SemanticChange = Readonly<{ before: SemanticNode; after: SemanticNode }>;
export type PossibleRename = Readonly<{
  removedId: string;
  addedId: string;
  reason: "unique-content-kind-and-parent-match";
}>;

export type SemanticDiff = Readonly<{
  added: readonly SemanticNode[];
  removed: readonly SemanticNode[];
  changed: readonly SemanticChange[];
  moved: readonly SemanticChange[];
  kindChanged: readonly SemanticChange[];
  unchanged: readonly SemanticNode[];
  collisions: readonly string[];
  unaddressable: readonly SemanticFinding[];
  possibleRenames: readonly PossibleRename[];
}>;

export function diffSemanticIndexes(before: SemanticIndex, after: SemanticIndex): SemanticDiff {
  const beforeGroups = groupNodes(before.nodes);
  const afterGroups = groupNodes(after.nodes);
  const collisions = [
    ...new Set(
      [...beforeGroups, ...afterGroups].filter(([, nodes]) => nodes.length > 1).map(([id]) => id),
    ),
  ].sort();
  const beforeUnique = uniqueNodes(beforeGroups);
  const afterUnique = uniqueNodes(afterGroups);
  const added = [...afterUnique.entries()]
    .filter(([id]) => !beforeUnique.has(id))
    .map(([, node]) => node);
  const removed = [...beforeUnique.entries()]
    .filter(([id]) => !afterUnique.has(id))
    .map(([, node]) => node);
  const changed: SemanticChange[] = [];
  const moved: SemanticChange[] = [];
  const kindChanged: SemanticChange[] = [];
  const unchanged: SemanticNode[] = [];
  for (const [id, previous] of beforeUnique) {
    const candidate = afterUnique.get(id);
    if (!candidate) continue;
    const contentChanged = previous.contentFingerprint !== candidate.contentFingerprint;
    const positionChanged =
      previous.structuralPosition.parentId !== candidate.structuralPosition.parentId ||
      JSON.stringify(previous.structuralPosition.path) !==
        JSON.stringify(candidate.structuralPosition.path);
    const kindOnlyOrAlsoChanged = previous.kind !== candidate.kind;
    if (contentChanged) changed.push({ before: previous, after: candidate });
    if (positionChanged) moved.push({ before: previous, after: candidate });
    if (kindOnlyOrAlsoChanged) kindChanged.push({ before: previous, after: candidate });
    if (!contentChanged && !positionChanged && !kindOnlyOrAlsoChanged) unchanged.push(candidate);
  }
  const possibleRenames = renameSuggestions(removed, added);
  return {
    added,
    removed,
    changed,
    moved,
    kindChanged,
    unchanged,
    collisions,
    unaddressable: [...before.findings, ...after.findings].filter((finding) =>
      ["anchor.missing-id", "anchor.invalid-id"].includes(finding.code),
    ),
    possibleRenames,
  };
}

function groupNodes(nodes: readonly SemanticNode[]): Map<string, SemanticNode[]> {
  const groups = new Map<string, SemanticNode[]>();
  for (const node of nodes) groups.set(node.id, [...(groups.get(node.id) ?? []), node]);
  return groups;
}

function uniqueNodes(groups: Map<string, SemanticNode[]>): Map<string, SemanticNode> {
  const unique = new Map<string, SemanticNode>();
  for (const [id, nodes] of groups) {
    if (nodes.length === 1 && nodes[0]) unique.set(id, nodes[0]);
  }
  return unique;
}

function renameSuggestions(
  removed: readonly SemanticNode[],
  added: readonly SemanticNode[],
): PossibleRename[] {
  const suggestions: PossibleRename[] = [];
  for (const previous of removed) {
    const matches = added.filter(
      (candidate) =>
        candidate.contentFingerprint === previous.contentFingerprint &&
        candidate.kind === previous.kind &&
        candidate.structuralPosition.parentId === previous.structuralPosition.parentId,
    );
    if (matches.length !== 1) continue;
    const candidate = matches[0];
    if (!candidate) continue;
    const reverse = removed.filter(
      (other) =>
        other.contentFingerprint === candidate.contentFingerprint &&
        other.kind === candidate.kind &&
        other.structuralPosition.parentId === candidate.structuralPosition.parentId,
    );
    if (reverse.length === 1) {
      suggestions.push({
        removedId: previous.id,
        addedId: candidate.id,
        reason: "unique-content-kind-and-parent-match",
      });
    }
  }
  return suggestions;
}
