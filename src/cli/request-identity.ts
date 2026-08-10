import { createHash } from "node:crypto";
import { canonicalJson } from "../protocol/command-identity.js";

/**
 * Stable logical identity for retryable CLI operations. The namespace is part
 * of the preimage so equal inputs in different command families never alias.
 */
export function stableCliIdentity(namespace: string, input: unknown): string {
  if (namespace.length === 0) throw new TypeError("identity namespace must not be empty");
  const digest = createHash("sha256").update(canonicalJson({ namespace, input })).digest("hex");
  return `${namespace}_${digest.slice(0, 32)}`;
}

export function contentSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
