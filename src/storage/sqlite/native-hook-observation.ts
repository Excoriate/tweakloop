import { createHash, timingSafeEqual } from "node:crypto";
import {
  NATIVE_HOOK_BINDING_PROTOCOL,
  NATIVE_HOOK_OBSERVATION_PROTOCOL,
  type NativeHookBindingResponse,
  type NativeHookBindRequest,
  type NativeHookObservation,
  type NativeHookObserveRequest,
} from "../../protocol/native-hook-observation.js";
import type { Db } from "./db.js";
import { runtimeCapabilityHash } from "./runtime-authority.js";

const LOWER_HEX_SHA256 = /^[a-f0-9]{64}$/;

type RuntimeAuthorityRow = Readonly<{
  session_id: string;
  capability_hash: string;
  declared_agent_id: string;
  process_nonce: string;
  runtime_generation: number;
  daemon_start_nonce: string;
  revoked_at: number | null;
}>;

type NativeHookBindingRow = Readonly<{
  binding_secret_hash: string;
  session_id: string;
  agent_id: string;
  process_nonce: string;
  runtime_generation: number;
  daemon_start_nonce: string;
  revoked_at: number | null;
}>;

type SessionRow = Readonly<{
  agent_id: string;
  process_nonce: string;
  status: string;
}>;

export class NativeHookObservationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "NativeHookObservationError";
  }
}

export class NativeHookObservationStore {
  constructor(
    private readonly db: Db,
    private readonly options: Readonly<{
      workspaceId: string;
      daemonStartNonce: string;
      now: () => number;
    }>,
  ) {}

  bind(input: NativeHookBindRequest): NativeHookBindingResponse {
    const now = this.options.now();
    requireTimestamp(now);
    const profileHash = sha256(input.profileId);
    const conversationHash = sha256(input.nativeConversationId);
    const secretHash = sha256(input.bindingSecret);
    const capabilityHash = runtimeCapabilityHash(input.runtimeCapability);
    const transaction = this.db.transaction(() => {
      const authority = this.requireCurrentAuthority(input.sessionId);
      if (!hashEquals(capabilityHash, authority.capability_hash)) {
        throw forbidden(
          "native-hook.runtime-capability-invalid",
          "runtime capability is invalid for the active session",
        );
      }
      const existing = this.binding(input.client, profileHash, conversationHash);
      if (existing) {
        const exact =
          existing.revoked_at === null &&
          hashEquals(secretHash, existing.binding_secret_hash) &&
          existing.session_id === authority.session_id &&
          existing.agent_id === authority.declared_agent_id &&
          existing.process_nonce === authority.process_nonce &&
          existing.runtime_generation === authority.runtime_generation &&
          existing.daemon_start_nonce === authority.daemon_start_nonce;
        if (!exact) {
          if (
            existing.revoked_at !== null ||
            existing.daemon_start_nonce !== this.options.daemonStartNonce
          ) {
            this.db
              .prepare(
                `UPDATE runtime_native_hook_bindings
                 SET binding_secret_hash = ?, session_id = ?, agent_id = ?, process_nonce = ?,
                     runtime_generation = ?, daemon_start_nonce = ?, issued_at = ?, revoked_at = NULL
                 WHERE workspace_id = ? AND client = ? AND profile_hash = ?
                   AND native_conversation_hash = ?`,
              )
              .run(
                secretHash,
                authority.session_id,
                authority.declared_agent_id,
                authority.process_nonce,
                authority.runtime_generation,
                authority.daemon_start_nonce,
                now,
                this.options.workspaceId,
                input.client,
                profileHash,
                conversationHash,
              );
            return response(authority.session_id, input.client, false);
          }
          throw new NativeHookObservationError(
            "native-hook.binding-conflict",
            "native conversation is already bound to different authority",
            409,
          );
        }
        return response(authority.session_id, input.client, true);
      }
      this.db
        .prepare(
          `INSERT INTO runtime_native_hook_bindings (
             workspace_id, client, profile_hash, native_conversation_hash,
             binding_secret_hash, session_id, agent_id, process_nonce,
             runtime_generation, daemon_start_nonce, issued_at, revoked_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          this.options.workspaceId,
          input.client,
          profileHash,
          conversationHash,
          secretHash,
          authority.session_id,
          authority.declared_agent_id,
          authority.process_nonce,
          authority.runtime_generation,
          authority.daemon_start_nonce,
          now,
        );
      return response(authority.session_id, input.client, false);
    });
    return transaction.immediate();
  }

  observe(input: NativeHookObserveRequest): NativeHookObservation {
    const profileHash = sha256(input.profileId);
    const conversationHash = sha256(input.nativeConversationId);
    const row = this.binding(input.client, profileHash, conversationHash);
    if (!row || !hashEquals(sha256(input.bindingSecret), row.binding_secret_hash)) {
      throw forbidden("native-hook.binding-invalid", "native hook binding is invalid");
    }
    if (row.revoked_at !== null) {
      throw forbidden("native-hook.binding-revoked", "native hook binding is revoked");
    }
    if (row.daemon_start_nonce !== this.options.daemonStartNonce) {
      throw forbidden(
        "native-hook.binding-stale",
        "native hook binding belongs to a stale daemon generation",
      );
    }
    const authority = this.requireCurrentAuthority(row.session_id);
    if (
      row.agent_id !== authority.declared_agent_id ||
      row.process_nonce !== authority.process_nonce ||
      row.runtime_generation !== authority.runtime_generation ||
      row.daemon_start_nonce !== authority.daemon_start_nonce
    ) {
      throw forbidden(
        "native-hook.binding-stale",
        "native hook binding no longer matches the active runtime authority",
      );
    }
    const candidate = this.db
      .prepare(
        `SELECT message_id FROM p_chat
         WHERE session_id = ?
           AND inbound_candidate = 1
           AND (recipient_agent_id IS NULL OR recipient_agent_id = ?)
           AND author LIKE 'human:%'
           AND work_id IS NULL
           AND intent_id IS NULL
           AND delivery_status IS NULL
         ORDER BY created_seq
         LIMIT 1`,
      )
      .get(row.session_id, row.agent_id) as { message_id: string } | undefined;
    if (!candidate) return { protocol: NATIVE_HOOK_OBSERVATION_PROTOCOL, kind: "none" };
    return {
      protocol: NATIVE_HOOK_OBSERVATION_PROTOCOL,
      kind: "continue",
      sessionId: row.session_id,
      messageId: candidate.message_id,
    };
  }

  private binding(
    client: string,
    profileHash: string,
    conversationHash: string,
  ): NativeHookBindingRow | undefined {
    return this.db
      .prepare(
        `SELECT binding_secret_hash, session_id, agent_id, process_nonce,
                runtime_generation, daemon_start_nonce, revoked_at
         FROM runtime_native_hook_bindings
         WHERE workspace_id = ? AND client = ? AND profile_hash = ?
           AND native_conversation_hash = ?`,
      )
      .get(this.options.workspaceId, client, profileHash, conversationHash) as
      | NativeHookBindingRow
      | undefined;
  }

  private requireCurrentAuthority(sessionId: string): RuntimeAuthorityRow {
    const authority = this.db
      .prepare(
        `SELECT session_id, capability_hash, declared_agent_id, process_nonce,
                runtime_generation, daemon_start_nonce, revoked_at
         FROM runtime_session_authorities
         WHERE workspace_id = ? AND session_id = ?`,
      )
      .get(this.options.workspaceId, sessionId) as RuntimeAuthorityRow | undefined;
    if (
      !authority ||
      authority.revoked_at !== null ||
      authority.daemon_start_nonce !== this.options.daemonStartNonce
    ) {
      throw forbidden(
        "native-hook.runtime-authority-unavailable",
        "session has no current runtime authority",
      );
    }
    const session = this.db
      .prepare("SELECT agent_id, process_nonce, status FROM p_sessions WHERE session_id = ?")
      .get(sessionId) as SessionRow | undefined;
    if (
      session?.status !== "active" ||
      session.agent_id !== authority.declared_agent_id ||
      session.process_nonce !== authority.process_nonce
    ) {
      throw forbidden(
        "native-hook.runtime-authority-stale",
        "runtime authority no longer matches the active session",
      );
    }
    return authority;
  }
}

function response(
  sessionId: string,
  client: NativeHookBindRequest["client"],
  unchanged: boolean,
): NativeHookBindingResponse {
  return {
    protocol: NATIVE_HOOK_BINDING_PROTOCOL,
    kind: "bound",
    sessionId,
    client,
    unchanged,
  };
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("native hook observation clock is invalid");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashEquals(left: string, right: string): boolean {
  if (!LOWER_HEX_SHA256.test(left) || !LOWER_HEX_SHA256.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function forbidden(code: string, message: string): NativeHookObservationError {
  return new NativeHookObservationError(code, message, 403);
}
