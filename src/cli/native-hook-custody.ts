import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { stateDirFor } from "../daemon/runtime.js";
import type { NativeHookClient } from "../protocol/native-hook-observation.js";

const CUSTODY_PROTOCOL = "tweakloop.native-hook-custody/v1" as const;

type NativeHookCustodyRecord = Readonly<{
  protocol: typeof CUSTODY_PROTOCOL;
  workspaceId: string;
  daemonStartNonce: string;
  client: NativeHookClient;
  profileHash: string;
  nativeConversationHash: string;
  sessionId: string;
  agentId: string;
  processNonce: string;
  bindingSecret: string;
  createdAt: string;
}>;

export type NativeHookBindingCustody = Readonly<{
  sessionId: string;
  agentId: string;
  processNonce: string;
  bindingSecret: string;
  unchanged: boolean;
}>;

export class NativeHookCustodyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NativeHookCustodyError";
  }
}

export function prepareNativeHookBindingCustody(
  input: Readonly<{
    workspaceId: string;
    workspaceRoot: string;
    daemonStartNonce: string;
    client: NativeHookClient;
    profileId: string;
    nativeConversationId: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
): NativeHookBindingCustody {
  const path = custodyPath(input);
  if (existsSync(path)) {
    const existing = readCustody(path, input);
    if (existing.daemonStartNonce === input.daemonStartNonce) {
      if (
        existing.sessionId !== input.sessionId ||
        existing.agentId !== input.agentId ||
        existing.processNonce !== input.processNonce
      ) {
        throw new NativeHookCustodyError(
          "native-hook.custody-conflict",
          "native conversation custody is already bound to a different active session",
        );
      }
      return {
        sessionId: existing.sessionId,
        agentId: existing.agentId,
        processNonce: existing.processNonce,
        bindingSecret: existing.bindingSecret,
        unchanged: true,
      };
    }
  }

  const record: NativeHookCustodyRecord = {
    protocol: CUSTODY_PROTOCOL,
    workspaceId: input.workspaceId,
    daemonStartNonce: input.daemonStartNonce,
    client: input.client,
    profileHash: sha256(input.profileId),
    nativeConversationHash: sha256(input.nativeConversationId),
    sessionId: input.sessionId,
    agentId: input.agentId,
    processNonce: input.processNonce,
    bindingSecret: randomBytes(32).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  writeAtomicPrivateJson(path, record);
  return {
    sessionId: record.sessionId,
    agentId: record.agentId,
    processNonce: record.processNonce,
    bindingSecret: record.bindingSecret,
    unchanged: false,
  };
}

export function loadNativeHookBindingCustody(
  input: Readonly<{
    workspaceId: string;
    workspaceRoot: string;
    daemonStartNonce: string;
    client: NativeHookClient;
    profileId: string;
    nativeConversationId: string;
  }>,
): NativeHookBindingCustody {
  const path = custodyPath(input);
  if (!existsSync(path)) {
    throw new NativeHookCustodyError(
      "native-hook.binding-missing",
      "native conversation is not bound to a Tweakloop session",
    );
  }
  const record = readCustody(path, input);
  if (record.daemonStartNonce !== input.daemonStartNonce) {
    throw new NativeHookCustodyError(
      "native-hook.custody-stale",
      "native hook custody belongs to a stale daemon generation; bind the current session again",
    );
  }
  return {
    sessionId: record.sessionId,
    agentId: record.agentId,
    processNonce: record.processNonce,
    bindingSecret: record.bindingSecret,
    unchanged: true,
  };
}

export function removeNativeHookBindingCustody(
  input: Readonly<{
    workspaceId: string;
    workspaceRoot: string;
    client: NativeHookClient;
    profileId: string;
    nativeConversationId: string;
  }>,
): void {
  rmSync(custodyPath(input), { force: true });
}

function custodyPath(
  input: Readonly<{
    workspaceId: string;
    workspaceRoot: string;
    client: NativeHookClient;
    profileId: string;
    nativeConversationId: string;
  }>,
): string {
  const root = join(stateDirFor(input.workspaceId), "native-hook-bindings");
  const resolvedRoot = resolve(root);
  const resolvedWorkspace = resolve(input.workspaceRoot);
  if (resolvedRoot === resolvedWorkspace || resolvedRoot.startsWith(`${resolvedWorkspace}${sep}`)) {
    throw new NativeHookCustodyError(
      "native-hook.workspace-custody-forbidden",
      "native hook custody must be outside the workspace",
    );
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  return join(
    root,
    `${sha256(JSON.stringify([input.workspaceId, input.client, input.profileId, input.nativeConversationId]))}.json`,
  );
}

function readCustody(
  path: string,
  expected: Readonly<{
    workspaceId: string;
    client: NativeHookClient;
    profileId: string;
    nativeConversationId: string;
  }>,
): NativeHookCustodyRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new NativeHookCustodyError(
      "native-hook.custody-invalid",
      `native hook custody is unreadable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) return invalidCustody();
  const record = parsed as Partial<NativeHookCustodyRecord>;
  if (
    record.protocol !== CUSTODY_PROTOCOL ||
    record.workspaceId !== expected.workspaceId ||
    record.client !== expected.client ||
    record.profileHash !== sha256(expected.profileId) ||
    record.nativeConversationHash !== sha256(expected.nativeConversationId) ||
    typeof record.daemonStartNonce !== "string" ||
    typeof record.sessionId !== "string" ||
    typeof record.agentId !== "string" ||
    typeof record.processNonce !== "string" ||
    typeof record.bindingSecret !== "string" ||
    record.bindingSecret.length < 32 ||
    typeof record.createdAt !== "string"
  ) {
    return invalidCustody();
  }
  return record as NativeHookCustodyRecord;
}

function invalidCustody(): never {
  throw new NativeHookCustodyError(
    "native-hook.custody-invalid",
    "native hook custody does not match the requested conversation",
  );
}

function writeAtomicPrivateJson(path: string, value: unknown): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
