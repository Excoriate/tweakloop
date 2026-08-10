import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalWorkspacePath } from "../daemon/runtime.js";

export type DocumentResolution =
  | Readonly<{ status: "registered"; artifactId: string; sourcePath: string | null }>
  | Readonly<{ status: "unregistered"; absolutePath: string }>
  | Readonly<{ status: "ambiguous"; selector: string; matchCount: number }>
  | Readonly<{ status: "corrupt"; selector: string; reason: string }>
  | Readonly<{ status: "path-invalid"; selector: string; reason: string }>;

type ArtifactIdentity = Readonly<{ artifactId: string; sourcePath: string | null }>;

/**
 * Resolve identity without collapsing absence, ambiguity, or corrupt registry
 * state. The caller alone decides whether `unregistered` is a successful query.
 */
export function resolveDocumentReference(
  artifacts: readonly unknown[],
  selector: string,
  workspaceRoot: string,
): DocumentResolution {
  if (selector.length === 0 || selector.includes("\0")) {
    return { status: "path-invalid", selector, reason: "document selector is empty or malformed" };
  }

  const pathSelector = isPathSelector(selector);
  const absolutePath = pathSelector
    ? isAbsolute(selector)
      ? resolve(selector)
      : resolve(workspaceRoot, selector)
    : null;
  let canonicalAbsolutePath: string | null = null;
  if (absolutePath !== null) {
    try {
      canonicalAbsolutePath = canonicalDocumentPath(absolutePath);
      if (!isWithin(canonicalWorkspacePath(workspaceRoot), canonicalAbsolutePath)) {
        return {
          status: "path-invalid",
          selector,
          reason: "document path escapes the workspace root",
        };
      }
    } catch {
      return {
        status: "path-invalid",
        selector,
        reason: "document path cannot be canonicalized",
      };
    }
  }

  const checked = validateRegistry(artifacts, selector);
  if (checked.status === "corrupt") return checked;
  const matches: ArtifactIdentity[] = [];
  for (const artifact of checked.artifacts) {
    if (artifact.artifactId === selector) {
      matches.push(artifact);
      continue;
    }
    if (canonicalAbsolutePath === null || artifact.sourcePath === null) continue;
    let canonicalSourcePath: string;
    try {
      canonicalSourcePath = canonicalDocumentPath(artifact.sourcePath);
    } catch {
      return {
        status: "corrupt",
        selector,
        reason: "artifact registry source path cannot be canonicalized",
      };
    }
    if (canonicalSourcePath === canonicalAbsolutePath) matches.push(artifact);
  }
  if (matches.length > 1) {
    return { status: "ambiguous", selector, matchCount: matches.length };
  }
  const match = matches[0];
  if (match) {
    return { status: "registered", artifactId: match.artifactId, sourcePath: match.sourcePath };
  }
  if (absolutePath !== null) return { status: "unregistered", absolutePath };
  return {
    status: "path-invalid",
    selector,
    reason: "selector is neither a registered artifact identity nor a document path",
  };
}

function validateRegistry(
  artifacts: readonly unknown[],
  selector: string,
):
  | Readonly<{ status: "valid"; artifacts: readonly ArtifactIdentity[] }>
  | Extract<DocumentResolution, { status: "corrupt" }> {
  const checked: ArtifactIdentity[] = [];
  const artifactIds = new Set<string>();
  for (const value of artifacts) {
    if (!isRecord(value)) {
      return { status: "corrupt", selector, reason: "artifact registry contains a non-object row" };
    }
    const artifactId = value.artifactId;
    const sourcePath = value.sourcePath;
    if (typeof artifactId !== "string" || artifactId.length === 0) {
      return {
        status: "corrupt",
        selector,
        reason: "artifact registry contains an invalid identity",
      };
    }
    if (artifactIds.has(artifactId)) {
      return {
        status: "corrupt",
        selector,
        reason: "artifact registry repeats an artifact identity",
      };
    }
    artifactIds.add(artifactId);
    if (
      sourcePath !== null &&
      (typeof sourcePath !== "string" ||
        sourcePath.length === 0 ||
        sourcePath.includes("\0") ||
        !isAbsolute(sourcePath) ||
        resolve(sourcePath) !== sourcePath)
    ) {
      return {
        status: "corrupt",
        selector,
        reason: "artifact registry contains an invalid source path",
      };
    }
    checked.push({ artifactId, sourcePath: sourcePath as string | null });
  }
  return { status: "valid", artifacts: checked };
}

function isPathSelector(selector: string): boolean {
  return (
    isAbsolute(selector) ||
    selector.startsWith(".") ||
    selector.includes("/") ||
    selector.includes("\\") ||
    extname(selector) !== ""
  );
}

/**
 * Collapse aliases in the parent identity while preserving the registered final path component.
 * This deliberately does not equate a source-file symlink with its target.
 */
function canonicalDocumentPath(path: string): string {
  const absolutePath = resolve(path);
  return join(canonicalWorkspacePath(dirname(absolutePath)), basename(absolutePath));
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
