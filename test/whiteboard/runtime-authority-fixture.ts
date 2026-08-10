import { createHash } from "node:crypto";
import type { Db } from "../../src/storage/sqlite/db.js";
import {
  RuntimeAuthorityStore,
  WHITEBOARD_AUTOMATION_METHOD,
  WHITEBOARD_AUTOMATION_OPERATION_ID,
  WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
} from "../../src/storage/sqlite/runtime-authority.js";
import {
  decideSemanticSceneReceipt,
  type SemanticSceneRequest,
} from "../../src/whiteboard/semantic-scene.js";

export const TEST_AUTOMATION_NOW = 1_900_000_000_000;
export const TEST_DAEMON_START_NONCE = "test-daemon-start-nonce";

export type RuntimeAuthorityFixture = Readonly<{
  authorityStore: RuntimeAuthorityStore;
  tokenFor: (request: SemanticSceneRequest) => string;
}>;

export function createRuntimeAuthorityFixture(
  db: Db,
  options: Readonly<{
    workspaceId: string;
    artifactId?: string;
    sessionId?: string;
    agentId?: string;
    processNonce?: string;
    daemonStartNonce?: string;
    now?: number;
  }>,
): RuntimeAuthorityFixture {
  const artifactId = options.artifactId ?? "artifact-board";
  const sessionId = options.sessionId ?? "session-automation";
  const agentId = options.agentId ?? "codex";
  const processNonce = options.processNonce ?? "process-automation";
  const daemonStartNonce = options.daemonStartNonce ?? TEST_DAEMON_START_NONCE;
  const now = options.now ?? TEST_AUTOMATION_NOW;
  db.prepare(
    `INSERT OR IGNORE INTO p_sessions (
       session_id, artifact_id, originating_agent_id, agent_id, process_nonce,
       status, base_revision_id, title, goal, predecessor_session_id,
       handoff_to_agent_id, handoff_summary, summary, created_at, last_active_at,
       ended_at, created_seq, last_seq
     ) VALUES (?, ?, ?, ?, ?, 'active', NULL, 'Automation test', 'Focused fixture',
       NULL, NULL, NULL, NULL, ?, ?, NULL, 1, 1)`,
  ).run(
    sessionId,
    artifactId,
    agentId,
    agentId,
    processNonce,
    new Date(now).toISOString(),
    new Date(now).toISOString(),
  );
  db.prepare(
    `INSERT OR IGNORE INTO p_session_artifacts (
       session_id, artifact_id, attached_revision_id, role, attached_seq
     ) VALUES (?, ?, 'revision-base', 'whiteboard', 1)`,
  ).run(sessionId, artifactId);
  db.prepare(
    `INSERT OR REPLACE INTO runtime_session_authorities (
       workspace_id, session_id, principal_kind, capability_hash,
       declared_agent_id, process_nonce, runtime_generation,
       daemon_start_nonce, issued_at, revoked_at
     ) VALUES (?, ?, 'session-capability-holder', ?, ?, ?, 1, ?, ?, NULL)`,
  ).run(
    options.workspaceId,
    sessionId,
    sha256("runtime-capability-for-focused-tests"),
    agentId,
    processNonce,
    daemonStartNonce,
    now - 1_000,
  );

  let serial = 0;
  const authorityStore = new RuntimeAuthorityStore(db, {
    workspaceId: options.workspaceId,
    daemonStartNonce,
    now: () => now,
    newAutomationToken: () => {
      throw new Error("focused fixture mints tokens directly");
    },
  });
  return {
    authorityStore,
    tokenFor: (request) => {
      serial += 1;
      const token = `focused-automation-token-${serial}-${"x".repeat(48)}`;
      const authorization = decideSemanticSceneReceipt(null, request);
      if (authorization.status !== "apply") throw new Error("unexpected replay decision");
      db.prepare(
        `INSERT INTO runtime_whiteboard_automation_tokens (
           token_hash, workspace_id, session_id, runtime_generation,
           daemon_start_nonce, artifact_id, method, operation_id,
           route_set_version, request_hash, issued_at, expires_at,
           used_at, revoked_at
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      ).run(
        sha256(token),
        options.workspaceId,
        sessionId,
        daemonStartNonce,
        request.artifactId,
        WHITEBOARD_AUTOMATION_METHOD,
        WHITEBOARD_AUTOMATION_OPERATION_ID,
        WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
        authorization.requestHash,
        now - 1,
        now + 60_000,
      );
      return token;
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
