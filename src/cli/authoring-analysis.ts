import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import {
  diffSemanticIndexes,
  extractSemanticIndex,
  lintSemantic,
  type SemanticDiff,
  type SemanticFinding,
  type SemanticFormat,
  type SemanticNode,
} from "../artifacts/semantic.js";

export type ArtifactLintReceipt = Readonly<{
  status: "pass" | "fail";
  path: string;
  format: SemanticFormat;
  nodeCount: number;
  errorCount: number;
  warningCount: number;
  findings: readonly SemanticFinding[];
}>;

export type ArtifactDiffReceipt = Readonly<{
  status: "pass" | "fail";
  path: string;
  format: SemanticFormat;
  baseline: "empty" | "revision";
  beforeRevisionId: string | null;
  artifactId: string | null;
  added: readonly ConciseSemanticNode[];
  removed: readonly ConciseSemanticNode[];
  changed: readonly ConciseSemanticChange[];
  moved: readonly ConciseSemanticChange[];
  kindChanged: readonly ConciseSemanticChange[];
  unchanged: readonly ConciseSemanticNode[];
  collisions: readonly string[];
  unaddressable: readonly SemanticFinding[];
  possibleRenames: SemanticDiff["possibleRenames"];
}>;

type ConciseSemanticNode = Readonly<{
  id: string;
  kind: string | null;
  parentId: string | null;
  order: number;
  contentFingerprint: string;
}>;

type ConciseSemanticChange = Readonly<{
  before: ConciseSemanticNode;
  after: ConciseSemanticNode;
}>;

export class AuthoringAnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "AuthoringAnalysisError";
  }
}

export function lintArtifactFile(path: string): ArtifactLintReceipt {
  const absolutePath = resolve(path);
  const format = semanticFormatForPath(absolutePath);
  const result = lintSemantic(format, readFileSync(absolutePath));
  const errorCount = result.findings.filter((finding) => finding.severity === "error").length;
  const warningCount = result.findings.length - errorCount;
  return {
    status: result.ok ? "pass" : "fail",
    path: absolutePath,
    format,
    nodeCount: result.index.nodes.length,
    errorCount,
    warningCount,
    findings: result.findings,
  };
}

export function diffArtifactBytes(
  input: Readonly<{
    path: string;
    artifactId: string;
    beforeRevisionId: string;
    before: string | Buffer;
  }>,
): ArtifactDiffReceipt {
  return diffAgainstBaseline({ ...input, baseline: "revision" });
}

export function diffNewArtifactBytes(path: string): ArtifactDiffReceipt {
  return diffAgainstBaseline({
    path,
    artifactId: null,
    beforeRevisionId: null,
    before: "",
    baseline: "empty",
  });
}

function diffAgainstBaseline(
  input: Readonly<{
    path: string;
    artifactId: string | null;
    beforeRevisionId: string | null;
    before: string | Buffer;
    baseline: "empty" | "revision";
  }>,
): ArtifactDiffReceipt {
  const path = resolve(input.path);
  const format = semanticFormatForPath(path);
  const before = extractSemanticIndex(format, input.before);
  const after = extractSemanticIndex(format, readFileSync(path));
  const diff = diffSemanticIndexes(before, after);
  const blocked =
    diff.collisions.length > 0 ||
    diff.unaddressable.some((finding) => finding.severity === "error");
  return {
    status: blocked ? "fail" : "pass",
    path,
    format,
    baseline: input.baseline,
    beforeRevisionId: input.beforeRevisionId,
    artifactId: input.artifactId,
    added: diff.added.map(conciseNode),
    removed: diff.removed.map(conciseNode),
    changed: diff.changed.map(conciseChange),
    moved: diff.moved.map(conciseChange),
    kindChanged: diff.kindChanged.map(conciseChange),
    unchanged: diff.unchanged.map(conciseNode),
    collisions: diff.collisions,
    unaddressable: diff.unaddressable,
    possibleRenames: diff.possibleRenames,
  };
}

export function semanticFormatForPath(path: string): SemanticFormat {
  const extension = extname(path).toLowerCase();
  if ([".html", ".htm"].includes(extension)) return "html";
  if ([".md", ".markdown", ".mdown", ".mkd"].includes(extension)) return "markdown";
  throw new AuthoringAnalysisError(
    "authoring.unsupported-format",
    "authoring analysis supports HTML and Markdown",
    { path: resolve(path) },
  );
}

function conciseNode(node: SemanticNode): ConciseSemanticNode {
  return {
    id: node.id,
    kind: node.kind,
    parentId: node.structuralPosition.parentId,
    order: node.structuralPosition.order,
    contentFingerprint: node.contentFingerprint,
  };
}

function conciseChange(change: Readonly<{ before: SemanticNode; after: SemanticNode }>) {
  return { before: conciseNode(change.before), after: conciseNode(change.after) };
}
