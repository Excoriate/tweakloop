import { createHash } from "node:crypto";
import type { CommandEnvelope } from "./envelopes.js";

export type NormalizedCommandRequest = Pick<
  CommandEnvelope,
  "workspaceId" | "actor" | "type" | "payload"
> &
  Readonly<{ expected?: CommandEnvelope["expected"] }>;

/** Hash the command fields that define idempotency identity. commandId is retry-local. */
export function commandRequestHash(command: NormalizedCommandRequest): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        workspaceId: command.workspaceId,
        actor: command.actor,
        type: command.type,
        expected: command.expected ?? null,
        payload: command.payload,
      }),
    )
    .digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("command identity cannot encode undefined");
  return encoded;
}
