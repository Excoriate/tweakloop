import { createHash } from "node:crypto";

export type SemanticFormat = "html" | "markdown";

export type SourceRange = Readonly<{
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}>;

export type StructuralPosition = Readonly<{
  parentId: string | null;
  path: readonly number[];
  order: number;
}>;

export type SemanticNode = Readonly<{
  id: string;
  kind: string | null;
  normalizedContent: string;
  contentFingerprint: string;
  structuralPosition: StructuralPosition;
  sourceRange?: SourceRange;
}>;

export type SemanticFinding = Readonly<{
  code:
    | "anchor.duplicate-id"
    | "anchor.missing-id"
    | "anchor.missing-kind"
    | "anchor.invalid-id"
    | "anchor.invalid-kind"
    | "template.placeholder";
  severity: "error" | "warning";
  message: string;
  semanticId?: string;
  sourceRange?: SourceRange;
}>;

export type SemanticIndex = Readonly<{
  format: SemanticFormat;
  nodes: readonly SemanticNode[];
  findings: readonly SemanticFinding[];
}>;

/** Only these values have behavior beyond pass-through metadata in v0.1. */
export const BEHAVIOR_RESERVED_KINDS = ["document-title", "whiteboard"] as const;

export const LOWER_KEBAB_KIND = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SEMANTIC_ID = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9][a-z0-9-]*)*$/;

export function sourceRange(source: string, startOffset: number, endOffset: number): SourceRange {
  return {
    startOffset,
    endOffset,
    startLine: lineAt(source, startOffset),
    endLine: lineAt(source, Math.max(startOffset, endOffset - 1)),
  };
}

export function normalizeSemanticContent(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function fingerprintContent(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function semanticNode(
  id: string,
  kind: string | null,
  content: string,
  structuralPosition: StructuralPosition,
  range?: SourceRange,
): SemanticNode {
  const normalizedContent = normalizeSemanticContent(content);
  return {
    id,
    kind,
    normalizedContent,
    contentFingerprint: fingerprintContent(normalizedContent),
    structuralPosition,
    ...(range ? { sourceRange: range } : {}),
  };
}

export function placeholderFindings(source: string): SemanticFinding[] {
  return [...source.matchAll(/\[\[[^\]\n]+\]\]/g)].map((match) => {
    const start = match.index;
    const token = match[0];
    return {
      code: "template.placeholder",
      severity: "error",
      message: `unreplaced template placeholder ${token}`,
      sourceRange: sourceRange(source, start, start + token.length),
    };
  });
}

export function idFindings(id: string, range: SourceRange | undefined): SemanticFinding[] {
  if (!SEMANTIC_ID.test(id)) {
    return [
      {
        code: "anchor.invalid-id",
        severity: "error",
        message: `semantic ID ${JSON.stringify(id)} is malformed`,
        semanticId: id,
        ...(range ? { sourceRange: range } : {}),
      },
    ];
  }
  if (
    /(?:^|[._:-])(?:left|right|blue|red|green|row|column|col|div|card|box)(?:[._:-]|$)/.test(id)
  ) {
    return [
      {
        code: "anchor.invalid-id",
        severity: "warning",
        message: `semantic ID ${JSON.stringify(id)} appears presentation-shaped`,
        semanticId: id,
        ...(range ? { sourceRange: range } : {}),
      },
    ];
  }
  return [];
}

export function duplicateIdFindings(nodes: readonly SemanticNode[]): SemanticFinding[] {
  const byId = new Map<string, SemanticNode[]>();
  for (const node of nodes) byId.set(node.id, [...(byId.get(node.id) ?? []), node]);
  return [...byId.entries()].flatMap(([id, matches]) =>
    matches.length < 2
      ? []
      : matches.map((node) => ({
          code: "anchor.duplicate-id" as const,
          severity: "error" as const,
          message: `semantic ID ${JSON.stringify(id)} appears ${matches.length} times`,
          semanticId: id,
          ...(node.sourceRange ? { sourceRange: node.sourceRange } : {}),
        })),
  );
}

export function claimSemanticId(requestedId: string, usedIds: Set<string>): string {
  let candidate = requestedId;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${requestedId}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

export function slugifySemanticText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(offset, source.length); index += 1) {
    if (source.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
