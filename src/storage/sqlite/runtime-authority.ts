import { createHash, timingSafeEqual } from "node:crypto";
import type { CommandEnvelope } from "../../protocol/envelopes.js";
import type { Db } from "./db.js";

export const WHITEBOARD_AUTOMATION_METHOD = "POST" as const;
export const WHITEBOARD_AUTOMATION_OPERATION_ID = "whiteboard.semantic-scene.apply.v1" as const;
export const WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION = 1 as const;
export const DEFAULT_WHITEBOARD_AUTOMATION_TTL_MS = 30_000;

const LOWER_HEX_SHA256 = /^[a-f0-9]{64}$/;

export class RuntimeAuthorityError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RuntimeAuthorityError";
  }
}

export type AgentAutomationPrincipal = Readonly<{
  kind: "agent-automation";
  workspaceId: string;
  sessionId: string;
  runtimeGeneration: number;
  declaredAgentId: string;
  processNonce: string;
  artifactId: string;
  operationId: typeof WHITEBOARD_AUTOMATION_OPERATION_ID;
  routeSetVersion: typeof WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION;
}>;

export type WhiteboardAutomationMintInput = Readonly<{
  sessionId: string;
  runtimeCapability: string;
  artifactId: string;
  method: typeof WHITEBOARD_AUTOMATION_METHOD;
  operationId: typeof WHITEBOARD_AUTOMATION_OPERATION_ID;
  routeSetVersion: typeof WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION;
  requestHash: string;
}>;

export type WhiteboardAutomationMint = Readonly<{
  token: string;
  expiresAt: number;
}>;

export type WhiteboardAutomationCredential = Readonly<{
  token: string;
  artifactId: string;
  method: typeof WHITEBOARD_AUTOMATION_METHOD;
  operationId: typeof WHITEBOARD_AUTOMATION_OPERATION_ID;
  routeSetVersion: typeof WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION;
  requestHash: string;
}>;

type RuntimeAuthorityRow = Readonly<{
  session_id: string;
  capability_hash: string;
  declared_agent_id: string;
  process_nonce: string;
  runtime_generation: number;
  daemon_start_nonce: string;
  revoked_at: number | null;
}>;

type AutomationTokenRow = Readonly<{
  workspace_id: string;
  session_id: string;
  runtime_generation: number;
  daemon_start_nonce: string;
  artifact_id: string;
  method: string;
  operation_id: string;
  route_set_version: number;
  request_hash: string;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
}>;

type SessionRow = Readonly<{
  agent_id: string;
  process_nonce: string;
  status: string;
}>;

export class RuntimeAuthorityStore {
  constructor(
    private readonly db: Db,
    private readonly options: Readonly<{
      workspaceId: string;
      daemonStartNonce: string;
      now: () => number;
      newAutomationToken: () => string;
      automationTtlMs?: number;
    }>,
  ) {}

  mintWhiteboardAutomationToken(input: WhiteboardAutomationMintInput): WhiteboardAutomationMint {
    validateRuntimeCapability(input.runtimeCapability);
    requireHash(input.requestHash, "normalized semantic request hash");
    if (
      input.method !== WHITEBOARD_AUTOMATION_METHOD ||
      input.operationId !== WHITEBOARD_AUTOMATION_OPERATION_ID ||
      input.routeSetVersion !== WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION
    ) {
      throw new RuntimeAuthorityError(
        "whiteboard.automation-request-invalid",
        "automation token request does not match the canonical scene-command operation",
        400,
      );
    }
    const now = this.options.now();
    const ttl = this.options.automationTtlMs ?? DEFAULT_WHITEBOARD_AUTOMATION_TTL_MS;
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttl) || ttl < 1) {
      throw new Error("runtime automation clock/TTL is invalid");
    }
    const tx = this.db.transaction(() => {
      const authority = this.activeAuthority(input.sessionId);
      if (!hashMatches(input.runtimeCapability, authority.capability_hash)) {
        throw forbidden(
          "whiteboard.runtime-capability-invalid",
          "runtime capability is invalid for the active session",
        );
      }
      this.requireCurrentSession(authority, input.artifactId);
      const token = this.options.newAutomationToken();
      validateAutomationToken(token);
      const tokenHash = sha256(token);
      const expiresAt = now + ttl;
      if (!Number.isSafeInteger(expiresAt)) {
        throw new Error("runtime automation token expiry is invalid");
      }
      this.db
        .prepare(
          `INSERT INTO runtime_whiteboard_automation_tokens (
             token_hash, workspace_id, session_id, runtime_generation,
             daemon_start_nonce, artifact_id, method, operation_id,
             route_set_version, request_hash, issued_at, expires_at,
             used_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        )
        .run(
          tokenHash,
          this.options.workspaceId,
          authority.session_id,
          authority.runtime_generation,
          this.options.daemonStartNonce,
          input.artifactId,
          input.method,
          input.operationId,
          input.routeSetVersion,
          input.requestHash,
          now,
          expiresAt,
        );
      return { token, expiresAt };
    });
    return tx.immediate();
  }

  /** Must be called as the first operation inside the semantic IMMEDIATE transaction. */
  authorizeAndConsumeWhiteboardToken(
    credential: WhiteboardAutomationCredential,
  ): AgentAutomationPrincipal {
    requireHash(credential.requestHash, "normalized semantic request hash");
    const now = this.options.now();
    if (!Number.isSafeInteger(now) || now < 0)
      throw new Error("runtime automation clock is invalid");
    const tokenHash = sha256(credential.token);
    const token = this.db
      .prepare(
        `SELECT workspace_id, session_id, runtime_generation, daemon_start_nonce,
                artifact_id, method, operation_id, route_set_version, request_hash,
                expires_at, used_at, revoked_at
         FROM runtime_whiteboard_automation_tokens WHERE token_hash = ?`,
      )
      .get(tokenHash) as AutomationTokenRow | undefined;
    if (!token)
      throw forbidden("whiteboard.automation-token-invalid", "automation token is invalid");
    if (token.used_at !== null) {
      throw forbidden("whiteboard.automation-token-used", "automation token has already been used");
    }
    if (token.revoked_at !== null) {
      throw forbidden("whiteboard.automation-token-revoked", "automation token is revoked");
    }
    if (now >= token.expires_at) {
      throw forbidden("whiteboard.automation-token-expired", "automation token has expired");
    }
    if (
      token.workspace_id !== this.options.workspaceId ||
      token.daemon_start_nonce !== this.options.daemonStartNonce ||
      token.artifact_id !== credential.artifactId ||
      token.method !== credential.method ||
      token.operation_id !== credential.operationId ||
      token.route_set_version !== credential.routeSetVersion ||
      token.request_hash !== credential.requestHash
    ) {
      throw forbidden(
        "whiteboard.automation-token-scope-mismatch",
        "automation token does not authorize this semantic request",
      );
    }
    const authority = this.activeAuthority(token.session_id);
    if (
      authority.runtime_generation !== token.runtime_generation ||
      authority.daemon_start_nonce !== token.daemon_start_nonce
    ) {
      throw forbidden(
        "whiteboard.automation-token-stale",
        "automation token belongs to a stale runtime generation",
      );
    }
    this.requireCurrentSession(authority, credential.artifactId);
    const consumed = this.db
      .prepare(
        `UPDATE runtime_whiteboard_automation_tokens SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL`,
      )
      .run(now, tokenHash);
    if (consumed.changes !== 1) {
      throw forbidden("whiteboard.automation-token-used", "automation token has already been used");
    }
    return {
      kind: "agent-automation",
      workspaceId: this.options.workspaceId,
      sessionId: authority.session_id,
      runtimeGeneration: authority.runtime_generation,
      declaredAgentId: authority.declared_agent_id,
      processNonce: authority.process_nonce,
      artifactId: credential.artifactId,
      operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
      routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
    };
  }

  private activeAuthority(sessionId: string): RuntimeAuthorityRow {
    const row = this.db
      .prepare(
        `SELECT session_id, capability_hash, declared_agent_id, process_nonce,
                runtime_generation, daemon_start_nonce, revoked_at
         FROM runtime_session_authorities
         WHERE workspace_id = ? AND session_id = ?`,
      )
      .get(this.options.workspaceId, sessionId) as RuntimeAuthorityRow | undefined;
    if (
      !row ||
      row.revoked_at !== null ||
      row.daemon_start_nonce !== this.options.daemonStartNonce
    ) {
      throw forbidden(
        "whiteboard.runtime-authority-unavailable",
        "session has no active runtime automation authority",
      );
    }
    return row;
  }

  private requireCurrentSession(authority: RuntimeAuthorityRow, artifactId: string): void {
    const session = this.db
      .prepare("SELECT agent_id, process_nonce, status FROM p_sessions WHERE session_id = ?")
      .get(authority.session_id) as SessionRow | undefined;
    if (
      session?.status !== "active" ||
      session.agent_id !== authority.declared_agent_id ||
      session.process_nonce !== authority.process_nonce
    ) {
      throw forbidden(
        "whiteboard.runtime-authority-stale",
        "runtime authority no longer matches the active session",
      );
    }
    const attached = this.db
      .prepare(
        `SELECT 1 AS present FROM p_session_artifacts
         WHERE session_id = ? AND artifact_id = ?`,
      )
      .get(authority.session_id, artifactId) as { present: number } | undefined;
    if (!attached) {
      throw forbidden(
        "whiteboard.automation-target-forbidden",
        "whiteboard is not attached to the authorized session",
      );
    }
  }
}

/** Apply runtime authority lifecycle state inside the command transaction. */
export function applySessionRuntimeAuthority(
  db: Db,
  input: Readonly<{
    workspaceId: string;
    daemonStartNonce: string;
    envelope: CommandEnvelope;
    recordedAt: string;
  }>,
): void {
  if (!input.envelope.type.startsWith("session.")) return;
  const payload = input.envelope.payload as Record<string, unknown>;
  const recordedAt = Date.parse(input.recordedAt);
  if (!Number.isSafeInteger(recordedAt) || recordedAt < 0) {
    throw new Error("session authority recordedAt is invalid");
  }
  if (input.envelope.type === "session.handoff" || input.envelope.type === "session.end") {
    revokeSessionAuthority(db, input.workspaceId, String(payload.sessionId), recordedAt);
    return;
  }
  if (input.envelope.type !== "session.start" && input.envelope.type !== "session.resume") return;

  let generation = 1;
  if (input.envelope.type === "session.resume") {
    const predecessorSessionId = String(payload.predecessorSessionId);
    const predecessor = db
      .prepare(
        `SELECT runtime_generation FROM runtime_session_authorities
         WHERE workspace_id = ? AND session_id = ?`,
      )
      .get(input.workspaceId, predecessorSessionId) as { runtime_generation: number } | undefined;
    generation = (predecessor?.runtime_generation ?? 0) + 1;
    revokeSessionAuthority(db, input.workspaceId, predecessorSessionId, recordedAt);
  }

  const capabilityHash = payload.runtimeCapabilityHash;
  if (capabilityHash === undefined) return;
  if (typeof capabilityHash !== "string") {
    throw new Error("validated runtime capability hash is not a string");
  }
  requireHash(capabilityHash, "runtime capability hash");
  db.prepare(
    `INSERT INTO runtime_session_authorities (
       workspace_id, session_id, principal_kind, capability_hash,
       declared_agent_id, process_nonce, runtime_generation,
       daemon_start_nonce, issued_at, revoked_at
     ) VALUES (?, ?, 'session-capability-holder', ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(
    input.workspaceId,
    String(payload.sessionId),
    capabilityHash,
    String(payload.agentId),
    String(payload.processNonce),
    generation,
    input.daemonStartNonce,
    recordedAt,
  );
}

function revokeSessionAuthority(
  db: Db,
  workspaceId: string,
  sessionId: string,
  revokedAt: number,
): void {
  db.prepare(
    `UPDATE runtime_session_authorities SET revoked_at = COALESCE(revoked_at, ?)
     WHERE workspace_id = ? AND session_id = ?`,
  ).run(revokedAt, workspaceId, sessionId);
  db.prepare(
    `UPDATE runtime_whiteboard_automation_tokens SET revoked_at = COALESCE(revoked_at, ?)
     WHERE workspace_id = ? AND session_id = ? AND used_at IS NULL`,
  ).run(revokedAt, workspaceId, sessionId);
  db.prepare(
    `UPDATE runtime_native_hook_bindings SET revoked_at = COALESCE(revoked_at, ?)
     WHERE workspace_id = ? AND session_id = ?`,
  ).run(revokedAt, workspaceId, sessionId);
}

export function runtimeCapabilityHash(runtimeCapability: string): string {
  validateRuntimeCapability(runtimeCapability);
  return sha256(runtimeCapability);
}

function validateRuntimeCapability(value: string): void {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 1024 ||
    hasAsciiControlCharacter(value)
  ) {
    throw new RuntimeAuthorityError(
      "whiteboard.runtime-capability-invalid",
      "runtime capability has an invalid format",
      400,
    );
  }
}

function validateAutomationToken(value: string): void {
  if (typeof value !== "string" || value.length < 43 || value.length > 1024) {
    throw new Error("automation token allocator returned an invalid token");
  }
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function requireHash(value: string, label: string): void {
  if (!LOWER_HEX_SHA256.test(value))
    throw new Error(`${label} must be 64 lowercase hex characters`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashMatches(value: string, expected: string): boolean {
  if (!LOWER_HEX_SHA256.test(expected)) return false;
  return timingSafeEqual(Buffer.from(sha256(value), "hex"), Buffer.from(expected, "hex"));
}

function forbidden(code: string, message: string): RuntimeAuthorityError {
  return new RuntimeAuthorityError(code, message, 403);
}
