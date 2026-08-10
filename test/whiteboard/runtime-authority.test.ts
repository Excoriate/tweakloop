import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTransactor } from "../../src/daemon/transactor.js";
import type { Db } from "../../src/storage/sqlite/db.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import {
  RuntimeAuthorityStore,
  runtimeCapabilityHash,
  WHITEBOARD_AUTOMATION_METHOD,
  WHITEBOARD_AUTOMATION_OPERATION_ID,
  WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
} from "../../src/storage/sqlite/runtime-authority.js";
import {
  decideSemanticSceneReceipt,
  SEMANTIC_SCENE_REQUEST_PROTOCOL,
  type SemanticSceneRequest,
} from "../../src/whiteboard/semantic-scene.js";
import {
  createRuntimeAuthorityFixture,
  TEST_AUTOMATION_NOW,
  TEST_DAEMON_START_NONCE,
} from "./runtime-authority-fixture.js";

const WORKSPACE = "workspace-runtime-authority";

function request(
  idempotencyKey = "runtime-authority-request",
  label = "API",
): SemanticSceneRequest {
  return {
    protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
    artifactId: "artifact-board",
    idempotencyKey,
    operations: [{ type: "node.upsert", semanticKey: "api", label }],
  };
}

function credential(token: string, semanticRequest: SemanticSceneRequest) {
  const authorization = decideSemanticSceneReceipt(null, semanticRequest);
  if (authorization.status !== "apply") throw new Error("unexpected replay decision");
  return {
    token,
    artifactId: semanticRequest.artifactId,
    method: WHITEBOARD_AUTOMATION_METHOD,
    operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
    routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
    requestHash: authorization.requestHash,
  } as const;
}

function tokenRow(db: Db, token: string): { used_at: number | null; revoked_at: number | null } {
  return db
    .prepare(
      `SELECT used_at, revoked_at FROM runtime_whiteboard_automation_tokens
       WHERE token_hash = ?`,
    )
    .get(createHash("sha256").update(token).digest("hex")) as {
    used_at: number | null;
    revoked_at: number | null;
  };
}

describe("runtime capability-holder authority", () => {
  it("mints only for the exact attached operation and never widens an issued token", () => {
    const db = openDatabase(":memory:");
    try {
      createRuntimeAuthorityFixture(db, { workspaceId: WORKSPACE });
      const mintedToken = `minted-token-${"m".repeat(64)}`;
      const authority = new RuntimeAuthorityStore(db, {
        workspaceId: WORKSPACE,
        daemonStartNonce: TEST_DAEMON_START_NONCE,
        now: () => TEST_AUTOMATION_NOW,
        newAutomationToken: () => mintedToken,
      });
      const original = request();
      const originalAuthorization = decideSemanticSceneReceipt(null, original);
      if (originalAuthorization.status !== "apply") throw new Error("unexpected replay decision");
      const mintInput = {
        sessionId: "session-automation",
        runtimeCapability: "runtime-capability-for-focused-tests",
        artifactId: original.artifactId,
        method: WHITEBOARD_AUTOMATION_METHOD,
        operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
        routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
        requestHash: originalAuthorization.requestHash,
      } as const;

      expect(() =>
        authority.mintWhiteboardAutomationToken({
          ...mintInput,
          runtimeCapability: "counterfeit-runtime-capability-holder",
        }),
      ).toThrow(/runtime capability is invalid/);
      expect(() =>
        authority.mintWhiteboardAutomationToken({
          ...mintInput,
          sessionId: "session-counterfeit",
        }),
      ).toThrow(/no active runtime automation authority/);
      expect(() =>
        authority.mintWhiteboardAutomationToken({
          ...mintInput,
          method: "PUT",
        } as unknown as typeof mintInput),
      ).toThrow(/canonical scene-command operation/);

      const unattached = request("unattached-mint");
      const unattachedAuthorization = decideSemanticSceneReceipt(null, unattached);
      if (unattachedAuthorization.status !== "apply") throw new Error("unexpected replay decision");
      expect(() =>
        authority.mintWhiteboardAutomationToken({
          ...mintInput,
          artifactId: "artifact-not-attached",
          requestHash: unattachedAuthorization.requestHash,
        }),
      ).toThrow(/not attached/);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM runtime_whiteboard_automation_tokens").get(),
      ).toEqual({ count: 0 });

      expect(authority.mintWhiteboardAutomationToken(mintInput)).toEqual({
        token: mintedToken,
        expiresAt: TEST_AUTOMATION_NOW + 30_000,
      });
      expect(databaseContainsText(db, mintedToken)).toBe(false);

      db.prepare(
        `INSERT INTO p_session_artifacts (
           session_id, artifact_id, attached_revision_id, role, attached_seq
         ) VALUES ('session-automation', 'artifact-later', 'revision-later', 'whiteboard', 2)`,
      ).run();
      const later = {
        ...request("later-attachment"),
        artifactId: "artifact-later",
      };
      expect(() =>
        authority.authorizeAndConsumeWhiteboardToken(credential(mintedToken, later)),
      ).toThrow(/does not authorize this semantic request/);
      expect(tokenRow(db, mintedToken).used_at).toBeNull();
      expect(
        authority.authorizeAndConsumeWhiteboardToken(credential(mintedToken, original)),
      ).toMatchObject({
        kind: "agent-automation",
        artifactId: original.artifactId,
      });
    } finally {
      db.close();
    }
  });

  it("binds exact request/generation/daemon/expiry and consumes once at expiry-1", () => {
    const db = openDatabase(":memory:");
    try {
      const fixture = createRuntimeAuthorityFixture(db, { workspaceId: WORKSPACE });
      let now = TEST_AUTOMATION_NOW;
      const authority = new RuntimeAuthorityStore(db, {
        workspaceId: WORKSPACE,
        daemonStartNonce: TEST_DAEMON_START_NONCE,
        now: () => now,
        newAutomationToken: () => {
          throw new Error("not minting in this test");
        },
      });
      const original = request();
      const changed = request("runtime-authority-request", "changed");
      const token = fixture.tokenFor(original);

      expect(() =>
        authority.authorizeAndConsumeWhiteboardToken(credential(token, changed)),
      ).toThrow(/does not authorize this semantic request/);
      expect(tokenRow(db, token).used_at).toBeNull();

      now = TEST_AUTOMATION_NOW + 59_999;
      expect(
        authority.authorizeAndConsumeWhiteboardToken(credential(token, original)),
      ).toMatchObject({
        kind: "agent-automation",
        declaredAgentId: "codex",
        artifactId: "artifact-board",
      });
      expect(tokenRow(db, token).used_at).toBe(now);
      expect(() =>
        authority.authorizeAndConsumeWhiteboardToken(credential(token, original)),
      ).toThrow(/already been used/);

      const exactExpiryToken = fixture.tokenFor(request("expiry-exact"));
      now = TEST_AUTOMATION_NOW + 60_000;
      expect(() =>
        authority.authorizeAndConsumeWhiteboardToken(
          credential(exactExpiryToken, request("expiry-exact")),
        ),
      ).toThrow(/expired/);
      expect(tokenRow(db, exactExpiryToken).used_at).toBeNull();

      const afterExpiryToken = fixture.tokenFor(request("expiry-after"));
      now = TEST_AUTOMATION_NOW + 60_001;
      expect(() =>
        authority.authorizeAndConsumeWhiteboardToken(
          credential(afterExpiryToken, request("expiry-after")),
        ),
      ).toThrow(/expired/);
      expect(tokenRow(db, afterExpiryToken).used_at).toBeNull();

      const staleToken = fixture.tokenFor(request("generation-stale"));
      db.prepare(
        `UPDATE runtime_session_authorities SET runtime_generation = 2
         WHERE workspace_id = ? AND session_id = 'session-automation'`,
      ).run(WORKSPACE);
      now = TEST_AUTOMATION_NOW;
      expect(() =>
        authority.authorizeAndConsumeWhiteboardToken(
          credential(staleToken, request("generation-stale")),
        ),
      ).toThrow(/stale runtime generation/);
      expect(tokenRow(db, staleToken).used_at).toBeNull();

      const wrongDaemon = new RuntimeAuthorityStore(db, {
        workspaceId: WORKSPACE,
        daemonStartNonce: "different-daemon-start",
        now: () => TEST_AUTOMATION_NOW,
        newAutomationToken: () => "unused-token-value-that-is-long-enough-0000000000000000",
      });
      expect(() =>
        wrongDaemon.authorizeAndConsumeWhiteboardToken(
          credential(staleToken, request("generation-stale")),
        ),
      ).toThrow(/does not authorize this semantic request|stale runtime generation/);
    } finally {
      db.close();
    }
  });

  it("commits start/resume/end lifecycle atomically, replays exactly, and leaves legacy sessions unable to mint", () => {
    const db = openDatabase(":memory:");
    let eventSerial = 0;
    const transactor = createTransactor({
      db,
      workspaceId: WORKSPACE,
      daemonStartNonce: TEST_DAEMON_START_NONCE,
      newEventId: () => `event-${++eventSerial}`,
      now: () => "2030-03-17T17:46:40.000Z",
      onCommitted: () => {},
    });
    const runtimeCapability = "runtime-capability-holder-secret-0001";
    const capabilityHash = runtimeCapabilityHash(runtimeCapability);
    const start = {
      protocol: "tweakloop.command/v1",
      commandId: "command-session-start",
      idempotencyKey: "runtime-session-start",
      workspaceId: WORKSPACE,
      actor: { kind: "agent", id: "codex" },
      type: "session.start",
      payload: {
        sessionId: "session-runtime",
        artifactId: null,
        agentId: "codex",
        processNonce: "process-runtime",
        runtimeCapabilityHash: capabilityHash,
        baseRevisionId: null,
        title: "Runtime authority",
        goal: "Prove lifecycle atomicity",
      },
    } as const;
    try {
      const accepted = transactor.execute(start);
      expect(accepted).toMatchObject({ status: "accepted" });
      expect(transactor.execute(start)).toEqual(accepted);
      expect(
        db
          .prepare(
            `SELECT capability_hash, runtime_generation, revoked_at
             FROM runtime_session_authorities WHERE session_id = 'session-runtime'`,
          )
          .get(),
      ).toEqual({ capability_hash: capabilityHash, runtime_generation: 1, revoked_at: null });
      expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_session_authorities").get()).toEqual(
        {
          count: 1,
        },
      );
      expect(databaseContainsText(db, runtimeCapability)).toBe(false);

      db.prepare(
        `INSERT INTO p_session_artifacts (
           session_id, artifact_id, attached_revision_id, role, attached_seq
         ) VALUES ('session-runtime', 'artifact-board', 'revision-runtime', 'whiteboard', 2)`,
      ).run();
      const lifecycleRequest = request("lifecycle-outstanding-token");
      const lifecycleAuthorization = decideSemanticSceneReceipt(null, lifecycleRequest);
      if (lifecycleAuthorization.status !== "apply") throw new Error("unexpected replay decision");
      const lifecycleToken = `lifecycle-token-${"l".repeat(64)}`;
      const authority = new RuntimeAuthorityStore(db, {
        workspaceId: WORKSPACE,
        daemonStartNonce: TEST_DAEMON_START_NONCE,
        now: () => TEST_AUTOMATION_NOW,
        newAutomationToken: () => lifecycleToken,
      });
      authority.mintWhiteboardAutomationToken({
        sessionId: "session-runtime",
        runtimeCapability,
        artifactId: lifecycleRequest.artifactId,
        method: WHITEBOARD_AUTOMATION_METHOD,
        operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
        routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
        requestHash: lifecycleAuthorization.requestHash,
      });
      expect(tokenRow(db, lifecycleToken).revoked_at).toBeNull();

      const differentHash = transactor.execute({
        ...start,
        commandId: "command-session-start-conflict",
        payload: { ...start.payload, runtimeCapabilityHash: "f".repeat(64) },
      });
      expect(differentHash).toMatchObject({
        status: "rejected",
        code: "idempotency-key-conflict",
      });

      expect(
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: "command-session-handoff",
          idempotencyKey: "runtime-session-handoff",
          workspaceId: WORKSPACE,
          actor: { kind: "agent", id: "codex" },
          type: "session.handoff",
          payload: {
            sessionId: "session-runtime",
            agentId: "codex",
            toAgentId: "claude",
            summary: "continue",
          },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(
        db
          .prepare("SELECT revoked_at FROM runtime_session_authorities WHERE session_id = ?")
          .get("session-runtime"),
      ).toEqual({ revoked_at: TEST_AUTOMATION_NOW });
      expect(tokenRow(db, lifecycleToken).revoked_at).toBe(TEST_AUTOMATION_NOW);

      const successorCapability = "runtime-capability-holder-secret-0002";
      expect(
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: "command-session-resume",
          idempotencyKey: "runtime-session-resume",
          workspaceId: WORKSPACE,
          actor: { kind: "agent", id: "claude" },
          type: "session.resume",
          payload: {
            sessionId: "session-successor",
            predecessorSessionId: "session-runtime",
            agentId: "claude",
            processNonce: "process-successor",
            runtimeCapabilityHash: runtimeCapabilityHash(successorCapability),
            baseRevisionId: null,
            title: null,
            goal: null,
          },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(
        db
          .prepare(
            `SELECT declared_agent_id, runtime_generation, revoked_at
             FROM runtime_session_authorities WHERE session_id = 'session-successor'`,
          )
          .get(),
      ).toEqual({ declared_agent_id: "claude", runtime_generation: 2, revoked_at: null });

      expect(
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: "command-session-end",
          idempotencyKey: "runtime-session-end",
          workspaceId: WORKSPACE,
          actor: { kind: "agent", id: "claude" },
          type: "session.end",
          payload: { sessionId: "session-successor", agentId: "claude", summary: "done" },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(
        db
          .prepare("SELECT revoked_at FROM runtime_session_authorities WHERE session_id = ?")
          .get("session-successor"),
      ).toEqual({ revoked_at: TEST_AUTOMATION_NOW });

      const { runtimeCapabilityHash: _omitted, ...legacyPayload } = start.payload;
      expect(
        transactor.execute({
          ...start,
          commandId: "command-legacy-session",
          idempotencyKey: "runtime-legacy-session",
          payload: {
            ...legacyPayload,
            sessionId: "session-legacy",
            processNonce: "process-legacy",
          },
        }),
      ).toMatchObject({ status: "accepted" });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM runtime_session_authorities WHERE session_id = ?")
          .get("session-legacy"),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("rolls the capability row, event, and receipt back together and persists no plaintext", () => {
    const db = openDatabase(":memory:");
    const plaintext = "runtime-capability-plaintext-must-never-persist";
    const transactor = createTransactor({
      db,
      workspaceId: WORKSPACE,
      daemonStartNonce: TEST_DAEMON_START_NONCE,
      newEventId: () => "event-rollback",
      now: () => "2030-03-17T17:46:40.000Z",
      onCommitted: () => {},
      failureInjection: (point) => {
        if (point === "after-receipt") throw new Error("injected authority rollback");
      },
    });
    try {
      expect(() =>
        transactor.execute({
          protocol: "tweakloop.command/v1",
          commandId: "command-rollback",
          idempotencyKey: "runtime-authority-rollback",
          workspaceId: WORKSPACE,
          actor: { kind: "agent", id: "codex" },
          type: "session.start",
          payload: {
            sessionId: "session-rollback",
            artifactId: null,
            agentId: "codex",
            processNonce: "process-rollback",
            runtimeCapabilityHash: runtimeCapabilityHash(plaintext),
            baseRevisionId: null,
            title: "Rollback",
            goal: "No split commit",
          },
        }),
      ).toThrow(/injected authority rollback/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get()).toEqual({
        count: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM runtime_session_authorities").get()).toEqual(
        {
          count: 0,
        },
      );
      expect(databaseContainsText(db, plaintext)).toBe(false);
    } finally {
      db.close();
    }
  });
});

function databaseContainsText(db: Db, needle: string): boolean {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as {
      name: string;
      type: string;
    }[];
    for (const column of columns) {
      if (column.type.toUpperCase() !== "TEXT") continue;
      const found = db
        .prepare(`SELECT 1 AS present FROM ${name} WHERE instr(${column.name}, ?) > 0 LIMIT 1`)
        .get(needle);
      if (found) return true;
    }
  }
  return false;
}
