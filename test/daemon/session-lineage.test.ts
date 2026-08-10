import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import { rebuildProjections, sessionById } from "../../src/daemon/projections.js";
import { stateDirFor } from "../../src/daemon/runtime.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import { runMigrations } from "../../src/storage/sqlite/migrations.js";

let stateRoot: string;
let workspaceRoot: string;
let daemon: DaemonHandle;
let sequence: number;

beforeEach(async () => {
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-lineage-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-lineage-workspace-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
  sequence = 0;
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

async function command(type: string, payload: unknown, agentId = "agent-a", expectedStatus = 200) {
  sequence += 1;
  const headers = type.startsWith("review.submit")
    ? await authenticatedBrowserHeaders()
    : {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      };
  const response = await fetch(`http://127.0.0.1:${daemon.shellPort}/api/v1/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command_${sequence}`,
      idempotencyKey: `lineage_${sequence}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: agentId },
      type,
      payload,
    }),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

async function authenticatedBrowserHeaders(): Promise<Record<string, string>> {
  const mintedResponse = await fetch(
    `http://127.0.0.1:${daemon.shellPort}/api/v1/bootstrap-tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    },
  );
  expect(mintedResponse.status).toBe(201);
  const minted = (await mintedResponse.json()) as { url: string };
  const bootstrap = await fetch(minted.url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    cookie,
    origin: `http://127.0.0.1:${daemon.shellPort}`,
    "content-type": "application/json",
  };
}

async function humanCommand(type: string, payload: unknown, expectedStatus = 200) {
  sequence += 1;
  const response = await fetch(`http://127.0.0.1:${daemon.shellPort}/api/v1/commands`, {
    method: "POST",
    headers: await authenticatedBrowserHeaders(),
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command_${sequence}`,
      idempotencyKey: `lineage_${sequence}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "human", id: "alex" },
      type,
      payload,
    }),
  });
  expect(response.status).toBe(expectedStatus);
  return response.json();
}

async function post(path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:${daemon.shellPort}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function get(path: string) {
  const response = await fetch(`http://127.0.0.1:${daemon.shellPort}${path}`, {
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function stageObject(bytes: Buffer, mediaType: string, fileName: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${daemon.shellPort}/api/v1/chat/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": mediaType,
      "x-tweakloop-filename": encodeURIComponent(fileName),
    },
    body: bytes,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { hash: string }).hash;
}

async function registerArtifact(
  artifactId: string,
  name: string,
  format: "markdown" | "whiteboard",
  revisionId: string,
) {
  await command("artifact.register", {
    artifactId,
    name,
    format,
    sourcePath: join(workspaceRoot, name),
  });
  await command("artifact.publish", {
    artifactId,
    revisionId,
    format,
    entryPath: name,
    entryHash: `${revisionId}_hash`,
    files: [
      {
        path: name,
        hash: `${revisionId}_hash`,
        mediaType: format === "whiteboard" ? "application/vnd.excalidraw+json" : "text/markdown",
      },
    ],
    producer: { kind: "agent", id: "agent-a" },
    sourcePath: join(workspaceRoot, name),
  });
}

describe("session lineage projection and takeover queries", () => {
  it.each([
    {
      transition: "session.handoff",
      payload: {
        sessionId: "session_pending",
        agentId: "agent-a",
        toAgentId: "agent-b",
        summary: "continue after draining inbound chat",
      },
      eventType: "session.handoff-offered",
      finalStatus: "handed-off",
    },
    {
      transition: "session.end",
      payload: {
        sessionId: "session_pending",
        agentId: "agent-a",
        summary: "end after draining inbound chat",
      },
      eventType: "session.ended",
      finalStatus: "ended",
    },
  ])(
    "rejects $transition atomically until every admitted inbound candidate is acknowledged",
    async ({ transition, payload, eventType, finalStatus }) => {
      await command("session.start", {
        sessionId: "session_pending",
        artifactId: null,
        agentId: "agent-a",
        processNonce: "process-a",
        baseRevisionId: null,
        title: "Pending inbound",
        goal: "Conserve admitted chat across authority changes",
      });
      for (const messageId of ["pending_1", "pending_2"]) {
        await humanCommand("chat.send", {
          messageId,
          artifactId: null,
          text: `message ${messageId}`,
          sessionId: "session_pending",
          recipientAgentId: "agent-a",
        });
      }
      const before = (await get("/api/v1/events?after=0")) as readonly unknown[];

      const rejected = await command(transition, payload, "agent-a", 409);
      expect(rejected).toEqual({
        status: "rejected",
        commandId: expect.any(String),
        code: "session.inbound-pending",
        message: `session session_pending has 2 unresolved inbound chat candidate(s); acknowledge or recover them before ${transition}`,
        details: {
          sessionId: "session_pending",
          pendingCount: 2,
          pendingMessageIds: ["pending_1", "pending_2"],
        },
      });
      expect(await get("/api/v1/events?after=0")).toHaveLength(before.length);
      const activeSessions = (await get("/api/v1/sessions?status=active")) as {
        sessions: readonly { sessionId: string }[];
      };
      expect(activeSessions.sessions.map((session) => session.sessionId)).toContain(
        "session_pending",
      );

      for (const messageId of ["pending_1", "pending_2"]) {
        const delivery = (await post("/api/v1/inbound/next", {
          sessionId: "session_pending",
          agentId: "agent-a",
          processNonce: "process-a",
        })) as {
          kind: "chat";
          delivery: { attemptId: string; capability: string; message: { messageId: string } };
        };
        expect(delivery).toMatchObject({
          kind: "chat",
          delivery: { message: { messageId } },
        });
        await post("/api/v1/chat/acknowledge", {
          sessionId: "session_pending",
          agentId: "agent-a",
          processNonce: "process-a",
          messageId,
          attemptId: delivery.delivery.attemptId,
          capability: delivery.delivery.capability,
        });
      }

      const beforeSuccess = (await get("/api/v1/events?after=0")) as readonly unknown[];
      const accepted = await command(transition, payload);
      expect(accepted).toMatchObject({ status: "accepted" });
      const afterSuccess = (await get("/api/v1/events?after=0")) as readonly {
        eventType: string;
      }[];
      expect(afterSuccess).toHaveLength(beforeSuccess.length + 1);
      expect(afterSuccess.at(-1)?.eventType).toBe(eventType);
      const transitionedSessions = (await get(`/api/v1/sessions?status=${finalStatus}`)) as {
        sessions: readonly { sessionId: string }[];
      };
      expect(transitionedSessions.sessions.map((session) => session.sessionId)).toContain(
        "session_pending",
      );
    },
  );

  it("migrates legacy primary sessions into nullable primary plus exact membership", () => {
    const legacyPath = join(stateRoot, "legacy-v7.sqlite");
    const db = new Database(legacyPath);
    db.exec(`
      CREATE TABLE p_artifacts (
        artifact_id TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL,
        source_path TEXT, registered_seq INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE p_revisions (
        revision_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL, parent_id TEXT,
        seq INTEGER NOT NULL, format TEXT NOT NULL, entry_path TEXT NOT NULL,
        entry_hash TEXT NOT NULL, files_json TEXT NOT NULL, producer_json TEXT NOT NULL,
        source_path TEXT, created_seq INTEGER NOT NULL, session_id TEXT
      ) STRICT;
      CREATE TABLE p_sessions (
        session_id TEXT PRIMARY KEY, artifact_id TEXT NOT NULL,
        originating_agent_id TEXT NOT NULL, agent_id TEXT NOT NULL,
        process_nonce TEXT NOT NULL, status TEXT NOT NULL, base_revision_id TEXT,
        title TEXT NOT NULL, goal TEXT NOT NULL, predecessor_session_id TEXT,
        handoff_to_agent_id TEXT, handoff_summary TEXT, summary TEXT,
        created_at TEXT NOT NULL, last_active_at TEXT NOT NULL, ended_at TEXT,
        created_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX p_sessions_by_artifact ON p_sessions(artifact_id, created_seq DESC);
      CREATE INDEX p_sessions_by_agent ON p_sessions(agent_id, created_seq DESC);
      INSERT INTO p_artifacts VALUES ('legacy_artifact', 'legacy.md', 'markdown', '/repo/legacy.md', 1);
      INSERT INTO p_revisions VALUES (
        'legacy_revision', 'legacy_artifact', NULL, 1, 'markdown', 'legacy.md',
        'legacy_hash', '[]', '{}', '/repo/legacy.md', 2, NULL
      );
      INSERT INTO p_sessions VALUES (
        'legacy_session', 'legacy_artifact', 'agent-a', 'agent-a', 'process-a',
        'active', 'legacy_revision', 'Legacy', 'Migrate', NULL, NULL, NULL, NULL,
        '2026-08-04T00:00:00Z', '2026-08-04T00:00:00Z', NULL, 3, 3
      );
      PRAGMA user_version = 7;
    `);
    runMigrations(db);
    expect(
      db.prepare("SELECT * FROM p_session_artifacts WHERE session_id = ?").get("legacy_session"),
    ).toMatchObject({
      artifact_id: "legacy_artifact",
      attached_revision_id: "legacy_revision",
      role: "primary",
      attached_seq: 3,
    });
    const artifactColumn = db
      .prepare("PRAGMA table_info(p_sessions)")
      .all()
      .find((column) => (column as { name: string }).name === "artifact_id") as {
      notnull: number;
    };
    expect(artifactColumn.notnull).toBe(0);
    db.close();
  });

  it("returns exact document history and reconstructs a complete A to B resume packet", async () => {
    await registerArtifact("document_1", "design.md", "markdown", "revision_1");
    await registerArtifact("board_1", "architecture.excalidraw", "whiteboard", "board_revision_1");

    await command("session.start", {
      sessionId: "session_a",
      artifactId: "document_1",
      agentId: "agent-a",
      processNonce: "process-a",
      baseRevisionId: "revision_1",
      title: "Design takeover",
      goal: "Resolve the API contract",
    });
    await command("session.start", {
      sessionId: "session_other",
      artifactId: "board_1",
      agentId: "agent-a",
      processNonce: "process-other",
      baseRevisionId: "board_revision_1",
      title: "Unrelated board",
      goal: "Must not leak into document history",
    });
    await command("session.handoff", {
      sessionId: "session_a",
      agentId: "agent-a",
      toAgentId: "agent-b",
      summary: "The API comment is still open; use the attached architecture board",
    });
    await command(
      "session.resume",
      {
        sessionId: "session_b",
        predecessorSessionId: "session_a",
        agentId: "agent-b",
        processNonce: "process-b",
        baseRevisionId: null,
        title: null,
        goal: null,
      },
      "agent-b",
    );
    await command("review.submit-batch", {
      batchId: "batch_b",
      workId: "work_b",
      artifactId: "document_1",
      revisionId: "revision_1",
      assigneeAgentId: "agent-b",
      sessionId: "session_b",
      intents: [
        {
          intentId: "intent_b",
          intentType: "comment",
          target: { semanticId: "api.contract" },
          body: { text: "Specify the error shape" },
        },
      ],
    });
    await command(
      "chat.send",
      {
        messageId: "message_b",
        artifactId: "document_1",
        text: "The board shows the expected boundary",
        mentions: ["board_1"],
        sessionId: "session_b",
        recipientAgentId: "agent-b",
        workId: "work_b",
      },
      "agent-a",
    );
    await command(
      "artifact.publish",
      {
        artifactId: "document_1",
        revisionId: "revision_2",
        format: "markdown",
        entryPath: "design.md",
        entryHash: "revision_2_hash",
        files: [{ path: "design.md", hash: "revision_2_hash", mediaType: "text/markdown" }],
        producer: { kind: "agent", id: "agent-b" },
        sourcePath: join(workspaceRoot, "design.md"),
        sessionId: "session_b",
      },
      "agent-b",
    );
    await command("review.submit-batch", {
      batchId: "batch_legacy",
      workId: "work_without_session",
      artifactId: "document_1",
      revisionId: "revision_2",
      assigneeAgentId: "agent-b",
      sessionId: null,
      intents: [
        {
          intentId: "intent_without_session",
          intentType: "comment",
          target: { semanticId: "legacy.comment" },
          body: { text: "must not leak into an exact session" },
        },
      ],
    });
    await command("chat.send", {
      messageId: "message_without_session",
      artifactId: "document_1",
      text: "uncorrelated traffic",
      sessionId: null,
      recipientAgentId: "agent-b",
    });

    const exactAgentView = await get(
      "/api/v1/agent-session/snapshot?agent=agent-b&process=process-b&session=session_b&artifact=document_1",
    );
    expect(exactAgentView.work.map((item: { workId: string }) => item.workId)).toEqual(["work_b"]);
    expect(exactAgentView.chat.map((item: { messageId: string }) => item.messageId)).toEqual([
      "message_b",
    ]);

    const history = await get("/api/v1/sessions?artifact=document_1");
    expect(history.protocol).toBe("tweakloop.sessions/v1");
    expect(history.sessions.map((item: { sessionId: string }) => item.sessionId)).toEqual([
      "session_b",
      "session_a",
    ]);

    const detail = (await get("/api/v1/sessions/session_b")).session;
    expect(detail).toMatchObject({
      artifactId: "document_1",
      originatingAgentId: "agent-a",
      agentId: "agent-b",
      predecessorSessionId: "session_a",
      baseRevisionId: "revision_1",
      headRevisionId: "revision_2",
      latestSessionRevisionId: "revision_2",
      presence: "unknown",
      transcriptComplete: true,
      openIntentIds: ["intent_b"],
    });
    expect(detail.intents[0]).toMatchObject({ intentId: "intent_b", status: "submitted" });
    expect(detail.chat.map((item: { messageId: string }) => item.messageId)).toEqual(["message_b"]);
    expect(detail.relatedArtifacts).toEqual([
      {
        artifactId: "board_1",
        name: "architecture.excalidraw",
        format: "whiteboard",
        sourcePath: join(workspaceRoot, "architecture.excalidraw"),
      },
    ]);
    expect((await get("/api/v1/sessions/session_a")).session.successorSessionIds).toEqual([
      "session_b",
    ]);

    const db = openDatabase(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
    rebuildProjections(db, daemon.workspaceId);
    const rebuilt = sessionById(db, "session_b");
    expect(rebuilt).toMatchObject({
      headRevisionId: "revision_2",
      latestSessionRevisionId: "revision_2",
      openIntentIds: ["intent_b"],
    });
    expect(rebuilt?.chat).toHaveLength(1);
    db.close();
  });

  it("projects zero, later-many, exact hashes, wrong-neighbor isolation, and rebuild parity", async () => {
    await command("session.start", {
      sessionId: "session_empty",
      artifactId: null,
      agentId: "agent-a",
      processNonce: "process-empty",
      baseRevisionId: null,
      title: "Empty room",
      goal: "Attach exact snapshots later",
    });
    expect((await get("/api/v1/sessions/session_empty")).session).toMatchObject({
      primaryArtifactId: null,
      artifactId: null,
      artifacts: [],
    });

    const hashA1 = await stageObject(Buffer.from("# A1\n"), "text/markdown", "a.md");
    const hashA2 = await stageObject(Buffer.from("# A2\n"), "text/markdown", "a.md");
    const hashBoard1 = await stageObject(
      Buffer.from('{"type":"excalidraw","version":2,"elements":[]}'),
      "application/vnd.excalidraw+json",
      "board.excalidraw",
    );
    await command("artifact.create", {
      artifactId: "document_a",
      name: "a.md",
      format: "markdown",
      sourcePath: null,
      provenance: { kind: "imported-snapshot", originalName: "a.md" },
      revisionId: "revision_a1",
      entryPath: "a.md",
      entryHash: hashA1,
      files: [{ path: "a.md", hash: hashA1, mediaType: "text/markdown" }],
      producer: { kind: "agent", id: "agent-a" },
      attachment: { sessionId: "session_empty", role: "opened" },
    });
    await command("artifact.create", {
      artifactId: "board_a",
      name: "board.excalidraw",
      format: "whiteboard",
      sourcePath: null,
      provenance: { kind: "generated" },
      revisionId: "revision_board1",
      entryPath: "board.excalidraw",
      entryHash: hashBoard1,
      files: [
        {
          path: "board.excalidraw",
          hash: hashBoard1,
          mediaType: "application/vnd.excalidraw+json",
        },
      ],
      producer: { kind: "agent", id: "agent-a" },
      attachment: { sessionId: "session_empty", role: "whiteboard" },
    });
    await command("artifact.publish", {
      artifactId: "document_a",
      revisionId: "revision_a2",
      format: "markdown",
      entryPath: "a.md",
      entryHash: hashA2,
      files: [{ path: "a.md", hash: hashA2, mediaType: "text/markdown" }],
      producer: { kind: "agent", id: "agent-a" },
      sourcePath: null,
      sessionId: "session_empty",
    });

    const duplicate = await command("session.attach-artifact", {
      sessionId: "session_empty",
      artifactId: "document_a",
      revisionId: "revision_a1",
      role: "opened",
    });
    expect(duplicate).toMatchObject({
      status: "accepted",
      firstEventSeq: null,
      response: { alreadyAttached: true },
    });
    const conflictingDuplicate = await command(
      "session.attach-artifact",
      {
        sessionId: "session_empty",
        artifactId: "document_a",
        revisionId: "revision_a2",
        role: "opened",
      },
      "agent-a",
      409,
    );
    expect(conflictingDuplicate).toMatchObject({
      status: "rejected",
      code: "session.attachment-conflict",
    });
    const wrongRevision = await command(
      "session.attach-artifact",
      {
        sessionId: "session_empty",
        artifactId: "document_a",
        revisionId: "revision_board1",
        role: "opened",
      },
      "agent-a",
      409,
    );
    expect(wrongRevision).toMatchObject({ status: "rejected", code: "revision.unknown" });

    await command("session.start", {
      sessionId: "session_same_agent_neighbor",
      artifactId: "board_a",
      agentId: "agent-a",
      processNonce: "process-neighbor",
      baseRevisionId: "revision_board1",
      title: "Neighbor",
      goal: "Must remain disjoint",
    });

    const before = (await get("/api/v1/sessions/session_empty")).session;
    expect(before.artifacts).toMatchObject([
      {
        artifactId: "document_a",
        attachedRevisionId: "revision_a1",
        attachedEntryHash: hashA1,
        currentRevisionId: "revision_a2",
        currentEntryHash: hashA2,
        role: "opened",
        provenance: { kind: "imported-snapshot", originalName: "a.md" },
      },
      {
        artifactId: "board_a",
        attachedRevisionId: "revision_board1",
        attachedEntryHash: hashBoard1,
        currentRevisionId: "revision_board1",
        currentEntryHash: hashBoard1,
        role: "whiteboard",
        provenance: { kind: "generated" },
      },
    ]);
    const neighbor = (await get("/api/v1/sessions/session_same_agent_neighbor")).session;
    expect(neighbor.artifacts.map((item: { artifactId: string }) => item.artifactId)).toEqual([
      "board_a",
    ]);

    const db = openDatabase(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
    rebuildProjections(db, daemon.workspaceId);
    expect(sessionById(db, "session_empty")?.artifacts).toEqual(before.artifacts);
    db.close();
  });
});
