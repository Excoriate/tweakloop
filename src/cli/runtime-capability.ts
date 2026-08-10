import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { stateDirFor } from "../daemon/runtime.js";

const CUSTODY_PROTOCOL = "tweakloop.runtime-capability-custody/v1" as const;
const PENDING_PROTOCOL = "tweakloop.runtime-capability-pending/v1" as const;

type CustodyRecord = Readonly<{
  protocol: typeof CUSTODY_PROTOCOL;
  workspaceId: string;
  daemonStartNonce: string;
  sessionId: string;
  agentId: string;
  processNonce: string;
  capability: string;
  capabilityHash: string;
  createdAt: string;
}>;

type PendingRecord = Readonly<{
  protocol: typeof PENDING_PROTOCOL;
  operationIdentity: string;
  sessionId: string;
  agentId: string;
  processNonce: string;
}>;

export type RuntimeCapabilityPreparation = Readonly<{
  sessionId: string;
  processNonce: string;
  capabilityHash: string;
  createdCustody: boolean;
  custodyPath: string;
  pendingPath: string;
}>;

export type RuntimeCapability = Readonly<{
  capability: string;
  capabilityHash: string;
}>;

export class RuntimeCapabilityError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "RuntimeCapabilityError";
    this.code = code;
    this.details = details;
  }
}

export function preflightRuntimeCapabilityCustody(
  input: Readonly<{ workspaceId: string; workspaceRoot: string }>,
): void {
  capabilityPaths(input.workspaceId, input.workspaceRoot);
}

export function prepareRuntimeCapability(
  input: Readonly<{
    workspaceId: string;
    workspaceRoot: string;
    daemonStartNonce: string;
    operationIdentity: string;
    agentId: string;
    sessionId?: string;
    processNonce?: string;
  }>,
): RuntimeCapabilityPreparation {
  const paths = capabilityPaths(input.workspaceId, input.workspaceRoot);
  const pendingPath = join(
    paths.pendingDir,
    `${digestKey([input.workspaceId, input.agentId, input.operationIdentity])}.json`,
  );
  const recovered = readOptionalJson(pendingPath);
  if (recovered !== null) {
    const pending = validatePending(recovered, input.operationIdentity, input.agentId);
    if (input.sessionId !== undefined && input.sessionId !== pending.sessionId) {
      throw custodyError("runtime-capability.pending-mismatch", "pending session identity differs");
    }
    if (input.processNonce !== undefined && input.processNonce !== pending.processNonce) {
      throw custodyError("runtime-capability.pending-mismatch", "pending process identity differs");
    }
    const custodyPath = custodyPathFor(paths.activeDir, {
      workspaceId: input.workspaceId,
      sessionId: pending.sessionId,
      agentId: pending.agentId,
      processNonce: pending.processNonce,
    });
    const custody = loadCustody(custodyPath, {
      workspaceId: input.workspaceId,
      daemonStartNonce: input.daemonStartNonce,
      sessionId: pending.sessionId,
      agentId: pending.agentId,
      processNonce: pending.processNonce,
    });
    return {
      sessionId: pending.sessionId,
      processNonce: pending.processNonce,
      capabilityHash: custody.capabilityHash,
      createdCustody: false,
      custodyPath,
      pendingPath,
    };
  }

  const sessionId = input.sessionId ?? `session_${randomUUID()}`;
  const processNonce = input.processNonce ?? `process_${randomUUID()}`;
  const scope = {
    workspaceId: input.workspaceId,
    daemonStartNonce: input.daemonStartNonce,
    sessionId,
    agentId: input.agentId,
    processNonce,
  };
  const custodyPath = custodyPathFor(paths.activeDir, scope);
  let createdCustody = false;
  let custody: CustodyRecord;
  if (existsSync(custodyPath)) {
    const existing = loadCustodyIdentity(custodyPath, scope);
    if (existing.daemonStartNonce === scope.daemonStartNonce) {
      custody = existing;
    } else {
      custody = newCustody(scope);
      replaceAtomicJson(custodyPath, custody);
      createdCustody = true;
    }
  } else {
    custody = newCustody(scope);
    createdCustody = installExclusiveJson(custodyPath, custody);
    if (!createdCustody) custody = loadCustody(custodyPath, scope);
  }

  const pending: PendingRecord = {
    protocol: PENDING_PROTOCOL,
    operationIdentity: input.operationIdentity,
    sessionId,
    agentId: input.agentId,
    processNonce,
  };
  if (!installExclusiveJson(pendingPath, pending)) {
    if (createdCustody) removeCustodyIfHash(custodyPath, custody.capabilityHash);
    return prepareRuntimeCapability(input);
  }
  return {
    sessionId,
    processNonce,
    capabilityHash: custody.capabilityHash,
    createdCustody,
    custodyPath,
    pendingPath,
  };
}

export function completeRuntimeCapabilityPreparation(
  preparation: RuntimeCapabilityPreparation,
): void {
  rmSync(preparation.pendingPath, { force: true });
}

export function abandonRuntimeCapabilityPreparation(
  preparation: RuntimeCapabilityPreparation,
): void {
  rmSync(preparation.pendingPath, { force: true });
  if (preparation.createdCustody) {
    removeCustodyIfHash(preparation.custodyPath, preparation.capabilityHash);
  }
}

export function loadRuntimeCapability(
  input: Readonly<{
    workspaceId: string;
    workspaceRoot: string;
    daemonStartNonce: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
): RuntimeCapability {
  const { activeDir } = capabilityPaths(input.workspaceId, input.workspaceRoot);
  const custodyPath = custodyPathFor(activeDir, input);
  const custody = loadCustody(custodyPath, input);
  return { capability: custody.capability, capabilityHash: custody.capabilityHash };
}

export function removeRuntimeCapability(
  input: Readonly<{
    workspaceId: string;
    workspaceRoot: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
): void {
  const { activeDir } = capabilityPaths(input.workspaceId, input.workspaceRoot);
  rmSync(custodyPathFor(activeDir, input), { force: true });
}

function capabilityPaths(
  workspaceId: string,
  workspaceRoot: string,
): Readonly<{
  activeDir: string;
  pendingDir: string;
}> {
  const root = join(stateDirFor(workspaceId), "runtime-capabilities");
  const resolvedRoot = resolve(root);
  const resolvedWorkspace = resolve(workspaceRoot);
  if (resolvedRoot === resolvedWorkspace || resolvedRoot.startsWith(`${resolvedWorkspace}${sep}`)) {
    throw custodyError(
      "runtime-capability.workspace-custody-forbidden",
      "runtime capability custody must be outside the workspace",
    );
  }
  const activeDir = join(root, "active");
  const pendingDir = join(root, "pending");
  mkdirPrivate(root);
  mkdirPrivate(activeDir);
  mkdirPrivate(pendingDir);
  return { activeDir, pendingDir };
}

function mkdirPrivate(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function custodyPathFor(
  activeDir: string,
  input: Readonly<{
    workspaceId: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
): string {
  return join(
    activeDir,
    `${digestKey([input.workspaceId, input.sessionId, input.agentId, input.processNonce])}.json`,
  );
}

function digestKey(parts: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function installExclusiveJson(path: string, value: unknown): boolean {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    chmodSync(temporary, 0o600);
    try {
      linkSync(temporary, path);
      return true;
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      // The temp name is unique and may already have been cleaned up.
    }
  }
}

function replaceAtomicJson(path: string, value: unknown): void {
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

function newCustody(
  input: Readonly<{
    workspaceId: string;
    daemonStartNonce: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
): CustodyRecord {
  const capability = randomBytes(32).toString("base64url");
  return {
    protocol: CUSTODY_PROTOCOL,
    ...input,
    capability,
    capabilityHash: createHash("sha256").update(capability).digest("hex"),
    createdAt: new Date().toISOString(),
  };
}

function loadCustody(
  path: string,
  expected: Readonly<{
    workspaceId: string;
    daemonStartNonce: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
): CustodyRecord {
  const custody = loadCustodyIdentity(path, expected);
  if (custody.daemonStartNonce !== expected.daemonStartNonce) {
    throw custodyError(
      "runtime-capability.scope-mismatch",
      "runtime capability custody does not match the active session process",
      { reason: "daemon-generation-changed" },
    );
  }
  return custody;
}

function loadCustodyIdentity(
  path: string,
  expected: Readonly<{
    workspaceId: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
): CustodyRecord {
  const value = readOptionalJson(path);
  if (value === null) {
    throw custodyError(
      "runtime-capability.missing",
      "runtime capability custody is unavailable for this session process",
    );
  }
  if (!isRecord(value) || value.protocol !== CUSTODY_PROTOCOL) {
    throw custodyError("runtime-capability.corrupt", "runtime capability custody is invalid");
  }
  for (const key of [
    "workspaceId",
    "daemonStartNonce",
    "sessionId",
    "agentId",
    "processNonce",
    "capability",
    "capabilityHash",
    "createdAt",
  ] as const) {
    if (typeof value[key] !== "string") {
      throw custodyError("runtime-capability.corrupt", "runtime capability custody is invalid");
    }
  }
  for (const key of ["workspaceId", "sessionId", "agentId", "processNonce"] as const) {
    if (value[key] !== expected[key]) {
      throw custodyError(
        "runtime-capability.scope-mismatch",
        "runtime capability custody does not match the active session process",
        { reason: "identity-mismatch", dimension: key },
      );
    }
  }
  const capability = value.capability as string;
  const capabilityHash = value.capabilityHash as string;
  const actualHash = createHash("sha256").update(capability).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(capabilityHash) || actualHash !== capabilityHash) {
    throw custodyError("runtime-capability.corrupt", "runtime capability custody is invalid");
  }
  return value as unknown as CustodyRecord;
}

function removeCustodyIfHash(path: string, capabilityHash: string): void {
  const value = readOptionalJson(path);
  if (isRecord(value) && value.capabilityHash === capabilityHash) {
    rmSync(path, { force: true });
  }
}

function validatePending(
  value: unknown,
  operationIdentity: string,
  agentId: string,
): PendingRecord {
  if (
    !isRecord(value) ||
    value.protocol !== PENDING_PROTOCOL ||
    value.operationIdentity !== operationIdentity ||
    value.agentId !== agentId ||
    typeof value.sessionId !== "string" ||
    typeof value.processNonce !== "string"
  ) {
    throw custodyError(
      "runtime-capability.pending-corrupt",
      "pending runtime capability recovery state is invalid",
    );
  }
  return value as unknown as PendingRecord;
}

function readOptionalJson(path: string): unknown | null {
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > 16_384) {
      throw custodyError("runtime-capability.corrupt", "runtime capability custody is oversized");
    }
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    if (isMissing(error)) return null;
    if (error instanceof RuntimeCapabilityError) throw error;
    throw custodyError("runtime-capability.corrupt", "runtime capability custody is invalid");
  }
}

function custodyError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): RuntimeCapabilityError {
  return new RuntimeCapabilityError(code, message, details);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
