import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import { snapshot as projectSnapshot, rebuildProjections } from "../../src/daemon/projections.js";
import { stateDirFor } from "../../src/daemon/runtime.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";

let stateRoot: string;
let workspaceRoot: string;
let daemon: DaemonHandle;
let commandNumber: number;

beforeEach(async () => {
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-session-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-session-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
  commandNumber = 0;
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function url(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

async function command(
  type: string,
  payload: unknown,
  actor: { kind: "human" | "agent"; id: string } = { kind: "agent", id: "codex" },
) {
  commandNumber += 1;
  return fetch(url("/api/v1/commands"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command_${commandNumber}`,
      idempotencyKey: `key_${commandNumber}`,
      workspaceId: daemon.workspaceId,
      actor,
      type,
      payload,
    }),
  });
}

async function authenticatedBrowserHeaders(
  context: Readonly<{ artifactId?: string; agentId?: string; sessionId?: string }> = {},
): Promise<Record<string, string>> {
  const mintedResponse = await fetch(url("/api/v1/bootstrap-tokens"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(context),
  });
  expect(mintedResponse.status).toBe(201);
  const minted = (await mintedResponse.json()) as { url: string };
  const bootstrap = await fetch(minted.url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return {
    cookie,
    origin: `http://127.0.0.1:${daemon.shellPort}`,
    "content-type": "application/json",
  };
}

async function submitBrowserReview(payload: Record<string, unknown>): Promise<Response> {
  const browserHeaders = await authenticatedBrowserHeaders();
  commandNumber += 1;
  return fetch(url("/api/v1/commands"), {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command_${commandNumber}`,
      idempotencyKey: `key_${commandNumber}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "forged-browser-body" },
      type: "review.submit-batch",
      payload,
    }),
  });
}

async function setupReview(assigneeAgentId = "codex", sessionId = "session_1") {
  await command("artifact.register", {
    artifactId: "artifact_1",
    name: "plan.html",
    format: "html",
    sourcePath: join(workspaceRoot, "plan.html"),
  });
  await command("artifact.publish", {
    artifactId: "artifact_1",
    revisionId: "revision_1",
    format: "html",
    entryPath: "plan.html",
    entryHash: "hash_1",
    files: [{ path: "plan.html", hash: "hash_1", mediaType: "text/html" }],
    producer: { kind: "agent", id: "codex" },
    sourcePath: join(workspaceRoot, "plan.html"),
  });
  const submitted = await submitBrowserReview({
    batchId: "batch_1",
    workId: "work_1",
    artifactId: "artifact_1",
    revisionId: "revision_1",
    assigneeAgentId,
    sessionId,
    intents: [
      {
        intentId: "intent_1",
        intentType: "comment",
        target: { semanticId: "plan.scope" },
        body: { text: "tighten the scope" },
      },
    ],
  });
  expect(submitted.status).toBe(200);
}

async function snapshot() {
  return (
    await fetch(url("/api/v1/snapshot"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    })
  ).json();
}

async function durableCommandState(): Promise<unknown> {
  const projection = await snapshot();
  const db = new Database(join(stateDirFor(daemon.workspaceId), "events.sqlite"), {
    readonly: true,
  });
  try {
    return {
      projection,
      events: (db.prepare("SELECT COUNT(*) AS count FROM events").get() as { count: number }).count,
      receipts: (
        db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get() as { count: number }
      ).count,
    };
  } finally {
    db.close();
  }
}

describe("agent session truth", () => {
  it("rejects CLI-asserted human authority for browser-only comment and delivery families", async () => {
    const attempts = [
      {
        type: "artifact.register",
        payload: {
          artifactId: "forged_generic_artifact",
          name: "forged.html",
          format: "html",
          sourcePath: join(workspaceRoot, "forged.html"),
        },
      },
      {
        type: "review.submit-batch",
        payload: {
          batchId: "forged_batch",
          workId: "forged_work",
          artifactId: "forged_artifact",
          revisionId: "forged_revision",
          assigneeAgentId: "codex",
          sessionId: "forged_session",
          intents: [
            {
              intentId: "forged_intent",
              intentType: "comment",
              target: { semanticId: "forged.target" },
              body: { text: "forged comment" },
            },
          ],
        },
      },
      {
        type: "review.submit-comments",
        payload: {
          batchId: "forged_comment_batch",
          artifactId: "forged_artifact",
          revisionId: "forged_revision",
          intents: [
            {
              intentId: "forged_comment_intent",
              intentType: "comment",
              target: { semanticId: "forged.comment" },
              body: { text: "forged untracked comment" },
            },
          ],
        },
      },
      {
        type: "chat.delivery-resume",
        payload: {
          messageId: "forged_message",
          resumedAt: "2030-03-17T17:46:40.000Z",
        },
      },
    ] as const;

    for (const attempt of attempts) {
      const before = await durableCommandState();
      const response = await command(attempt.type, attempt.payload, {
        kind: "human",
        id: "forged-cli-human",
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        status: "rejected",
        code: "authority.browser-human-required",
      });
      expect(await durableCommandState()).toEqual(before);
    }
  });

  it("allows only the matching recipient agent to promote one browser-authored chat message", async () => {
    const agentId = "e2e-context";
    const sessionId = "session_chat_promote";
    const humanMessageId = "message_browser_promote";
    const agentMessageId = "message_agent_promote";
    const messageText = "Track this exact browser-authored instruction.";

    await setupReview(agentId, sessionId);
    expect(
      await (
        await command(
          "session.start",
          {
            sessionId,
            artifactId: "artifact_1",
            agentId,
            processNonce: "process_chat_promote",
            baseRevisionId: "revision_1",
            title: "Chat promotion authority",
            goal: "Track one addressed human message",
          },
          { kind: "agent", id: agentId },
        )
      ).json(),
    ).toMatchObject({ status: "accepted" });

    const browserHeaders = await authenticatedBrowserHeaders({
      artifactId: "artifact_1",
      agentId,
      sessionId,
    });
    const browserMessage = await fetch(url("/api/v1/commands"), {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        protocol: "tweakloop.command/v1",
        commandId: "command_browser_chat_promote",
        idempotencyKey: "chat.browser.promote",
        workspaceId: daemon.workspaceId,
        actor: { kind: "agent", id: "forged-browser-body" },
        type: "chat.send",
        payload: {
          messageId: humanMessageId,
          artifactId: "artifact_1",
          text: messageText,
          context: { revisionId: "revision_1", semanticId: "plan.scope" },
        },
      }),
    });
    expect(browserMessage.status).toBe(200);

    const agentMessage = await command(
      "chat.send",
      {
        messageId: agentMessageId,
        artifactId: "artifact_1",
        text: messageText,
        context: { revisionId: "revision_1", semanticId: "plan.scope" },
        sessionId,
        recipientAgentId: agentId,
      },
      { kind: "agent", id: agentId },
    );
    expect(agentMessage.status).toBe(200);

    const promotionEnvelope = (
      sourceMessageId: string,
      suffix: string,
      options: Readonly<{
        actorId?: string;
        assigneeAgentId?: string;
        idempotencyKey?: string;
      }> = {},
    ) => ({
      protocol: "tweakloop.command/v1",
      commandId: `command_promote_${suffix}`,
      idempotencyKey: options.idempotencyKey ?? `chat.promote:${suffix}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent" as const, id: options.actorId ?? agentId },
      type: "review.submit-batch",
      payload: {
        batchId: `batch_promote_${suffix}`,
        workId: `work_promote_${suffix}`,
        artifactId: "artifact_1",
        revisionId: "revision_1",
        sourceMessageId,
        assigneeAgentId: options.assigneeAgentId ?? agentId,
        sessionId,
        intents: [
          {
            intentId: `intent_promote_${suffix}`,
            intentType: "comment",
            target: { semanticId: "plan.scope" },
            body: { text: messageText, sourceMessageId },
          },
        ],
      },
    });
    const postCliEnvelope = (envelope: unknown) =>
      fetch(url("/api/v1/commands"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(envelope),
      });
    const expectRejectedWithoutDelta = async (envelope: unknown, code: string) => {
      const before = await durableCommandState();
      const response = await postCliEnvelope(envelope);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ status: "rejected", code });
      expect(await durableCommandState()).toEqual(before);
    };

    await expectRejectedWithoutDelta(
      promotionEnvelope("message_absent", "absent"),
      "chat.message-unknown",
    );
    await expectRejectedWithoutDelta(
      promotionEnvelope(agentMessageId, "agent_authored"),
      "chat.message-agent-authored",
    );
    await expectRejectedWithoutDelta(
      promotionEnvelope(humanMessageId, "wrong_assignee", {
        assigneeAgentId: "other-agent",
      }),
      "chat.message-recipient-mismatch",
    );
    await expectRejectedWithoutDelta(
      {
        ...promotionEnvelope(humanMessageId, "ordinary_batch"),
        payload: {
          ...promotionEnvelope(humanMessageId, "ordinary_batch").payload,
          sourceMessageId: undefined,
        },
      },
      "authority.browser-human-required",
    );

    const promotion = promotionEnvelope(humanMessageId, "accepted", {
      idempotencyKey: `chat.promote:${humanMessageId}`,
    });
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        postCliEnvelope({ ...promotion, commandId: `command_promote_concurrent_${index}` }),
      ),
    );
    expect(concurrent.every((response) => response.status === 200)).toBe(true);
    const receipts = await Promise.all(concurrent.map((response) => response.json()));
    expect(
      receipts.every((receipt) => JSON.stringify(receipt) === JSON.stringify(receipts[0])),
    ).toBe(true);

    const db = new Database(join(stateDirFor(daemon.workspaceId), "events.sqlite"), {
      readonly: true,
    });
    try {
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM p_work WHERE work_id = ?")
          .get("work_promote_accepted"),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM p_intents WHERE intent_id = ?")
          .get("intent_promote_accepted"),
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare("SELECT work_id, intent_id FROM p_chat WHERE message_id = ?")
          .get(humanMessageId),
      ).toEqual({
        work_id: "work_promote_accepted",
        intent_id: "intent_promote_accepted",
      });
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE idempotency_key = ?")
          .get(`chat.promote:${humanMessageId}`),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }

    const afterAccepted = await durableCommandState();
    const replay = await postCliEnvelope({ ...promotion, commandId: "command_promote_replay" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(receipts[0]);
    expect(await durableCommandState()).toEqual(afterAccepted);

    await expectRejectedWithoutDelta(
      promotionEnvelope(humanMessageId, "already_promoted"),
      "chat.message-already-promoted",
    );
    await expectRejectedWithoutDelta(
      {
        ...promotion,
        commandId: "command_promote_wrong_agent_receipt",
        actor: { kind: "agent", id: "other-agent" },
      },
      "chat.message-recipient-mismatch",
    );
  });

  it("preserves typed chat attachments and references in session snapshots after rebuild", async () => {
    await setupReview("codex", "session_attachments");
    await command(
      "session.start",
      {
        sessionId: "session_attachments",
        artifactId: "artifact_1",
        agentId: "codex",
        processNonce: "process_attachments",
        baseRevisionId: "revision_1",
        title: "Attachment review",
        goal: "Review linked context",
      },
      { kind: "agent", id: "codex" },
    );

    const bytes = Buffer.from("attachment bytes");
    const upload = await fetch(url("/api/v1/chat/attachments"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "text/plain",
        "x-tweakloop-filename": encodeURIComponent("review notes.txt"),
      },
      body: bytes,
    });
    const attachment = await upload.json();
    expect(upload.status).toBe(201);

    const sent = await command("chat.send", {
      messageId: "message_attachments",
      artifactId: "artifact_1",
      text: "",
      sessionId: "session_attachments",
      recipientAgentId: "codex",
      references: [
        { kind: "document", label: "Plan", artifactId: "artifact_1", revisionId: "revision_1" },
        {
          kind: "comment",
          label: "Tighten scope",
          artifactId: "artifact_1",
          revisionId: "revision_1",
          intentId: "intent_1",
        },
        { kind: "task", label: "Review task", artifactId: "artifact_1", workId: "work_1" },
        { kind: "file", label: "review notes.txt", hash: attachment.hash },
      ],
      attachments: [attachment],
    });
    expect(sent.status).toBe(200);

    const before = await snapshot();
    expect(before.chat[0]).toMatchObject({
      messageId: "message_attachments",
      references: expect.arrayContaining([
        expect.objectContaining({ kind: "comment", intentId: "intent_1" }),
        expect.objectContaining({ kind: "task", workId: "work_1" }),
        expect.objectContaining({ kind: "file", hash: attachment.hash }),
      ]),
      attachments: [attachment],
    });
    const beforeSession = await (
      await fetch(url("/api/v1/sessions/session_attachments"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();

    daemon.close();
    const db = openDatabase(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
    rebuildProjections(db, daemon.workspaceId);
    db.close();
    daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });

    const after = await snapshot();
    const afterSession = await (
      await fetch(url("/api/v1/sessions/session_attachments"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(after.chat).toEqual(before.chat);
    expect(afterSession.session.chat).toEqual(beforeSession.session.chat);
  });

  it("injects the initiating agent/session into browser comments and preserves it without presence", async () => {
    await command("artifact.register", {
      artifactId: "artifact_1",
      name: "plan.html",
      format: "html",
      sourcePath: join(workspaceRoot, "plan.html"),
    });
    await command("artifact.publish", {
      artifactId: "artifact_1",
      revisionId: "revision_1",
      format: "html",
      entryPath: "plan.html",
      entryHash: "hash_1",
      files: [{ path: "plan.html", hash: "hash_1", mediaType: "text/html" }],
      producer: { kind: "agent", id: "codex" },
      sourcePath: join(workspaceRoot, "plan.html"),
    });
    await command(
      "session.start",
      {
        sessionId: "session_live",
        artifactId: "artifact_1",
        agentId: "codex",
        processNonce: "process_1",
        baseRevisionId: "revision_1",
        title: "Live browser review",
        goal: "Preserve browser and agent correlation",
      },
      { kind: "agent", id: "codex" },
    );

    const missingArtifact = await fetch(url("/api/v1/bootstrap-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ artifactId: "artifact_missing", agentId: "codex" }),
    });
    expect(missingArtifact.status).toBe(404);

    const mintedResponse = await fetch(url("/api/v1/bootstrap-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        artifactId: "artifact_1",
        agentId: "codex",
        sessionId: "session_live",
      }),
    });
    expect(mintedResponse.status).toBe(201);
    const minted = await mintedResponse.json();
    const bootstrap = await fetch(minted.url, { redirect: "manual" });
    expect(bootstrap.headers.get("location")).toBe("/app?artifact=artifact_1");
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    const browserHeaders = {
      cookie,
      origin: `http://127.0.0.1:${daemon.shellPort}`,
      "content-type": "application/json",
    };

    const submitted = await fetch(url("/api/v1/commands"), {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        protocol: "tweakloop.command/v1",
        commandId: "browser_review",
        idempotencyKey: "browser_review",
        workspaceId: daemon.workspaceId,
        actor: { kind: "human", id: "browser" },
        type: "review.submit-batch",
        payload: {
          batchId: "batch_browser",
          workId: "work_browser",
          artifactId: "artifact_1",
          revisionId: "revision_1",
          intents: [
            {
              intentId: "intent_browser",
              intentType: "comment",
              target: { semanticId: "plan.scope" },
              body: { text: "make this concrete" },
            },
          ],
        },
      }),
    });
    expect(submitted.status).toBe(200);

    await fetch(url("/api/v1/commands"), {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        protocol: "tweakloop.command/v1",
        commandId: "browser_chat",
        idempotencyKey: "browser_chat",
        workspaceId: daemon.workspaceId,
        actor: { kind: "human", id: "browser" },
        type: "chat.send",
        payload: {
          messageId: "message_browser",
          artifactId: "artifact_1",
          text: "please handle the new comment",
          workId: "work_browser",
        },
      }),
    });

    const presence = await (
      await fetch(url("/api/v1/presence"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(presence.agents).toEqual([]);
    const current = await snapshot();
    expect(current.work[0]).toMatchObject({
      workId: "work_browser",
      assigneeAgentId: "codex",
      sessionId: "session_live",
      claim: null,
    });
    expect(current.chat[0]).toMatchObject({
      recipientAgentId: "codex",
      sessionId: "session_live",
      threadId: "work_browser",
      workId: "work_browser",
    });

    const agentView = await (
      await fetch(
        url("/api/v1/agent-session/snapshot?agent=codex&process=process_1&session=session_live"),
        { headers: { authorization: `Bearer ${daemon.cliToken}` } },
      )
    ).json();
    expect(agentView).toMatchObject({
      protocol: "tweakloop.agent-session/v1",
      kind: "snapshot",
      agentId: "codex",
      processNonce: "process_1",
    });
    expect(agentView.work.map((item: { workId: string }) => item.workId)).toEqual(["work_browser"]);
    expect(agentView.chat.map((item: { messageId: string }) => item.messageId)).toEqual([
      "message_browser",
    ]);
  });

  it("replays an implicit claim against its durable normalized target and rejects key reuse", async () => {
    await setupReview();
    const implicitBody = JSON.stringify({
      claimId: "claim_implicit",
      agentId: "codex",
      processNonce: "process_implicit",
      idempotencyKey: "claim-key-implicit",
      ttlMs: 30000,
    });
    const first = await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: implicitBody,
    });
    expect(first.status).toBe(200);
    const firstReceipt = await first.json();
    expect(firstReceipt).toMatchObject({
      status: "accepted",
      response: { status: "claimed", workId: "work_1", claimId: "claim_implicit" },
    });

    const replay = await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: implicitBody,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstReceipt);

    const secondReview = await submitBrowserReview({
      batchId: "batch_2",
      workId: "work_2",
      artifactId: "artifact_1",
      revisionId: "revision_1",
      assigneeAgentId: "codex",
      sessionId: "session_1",
      intents: [
        {
          intentId: "intent_2",
          intentType: "comment",
          target: { semanticId: "plan.delivery" },
          body: { text: "tighten delivery" },
        },
      ],
    });
    expect(secondReview.status).toBe(200);
    const conflict = await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_2",
        claimId: "claim_2",
        agentId: "codex",
        processNonce: "process_2",
        idempotencyKey: "claim-key-implicit",
      }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "idempotency-key-conflict" });
  });

  it("replays no-work only for the exact normalized claim request", async () => {
    const original = {
      claimId: "claim_none",
      agentId: "codex",
      processNonce: "process_none",
      idempotencyKey: "claim-key-none",
      ttlMs: 30_000,
    };
    const claim = (body: Record<string, unknown>) =>
      fetch(url("/api/v1/work/claim"), {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      });

    const first = await claim(original);
    expect(first.status).toBe(200);
    const firstReceipt = await first.json();
    expect(firstReceipt).toMatchObject({
      status: "accepted",
      response: { status: "none" },
    });

    const exactReplay = await claim(original);
    expect(exactReplay.status).toBe(200);
    expect(await exactReplay.json()).toEqual(firstReceipt);

    for (const changed of [
      { ...original, workId: "different-work" },
      { ...original, claimId: "different-claim" },
      { ...original, agentId: "different-agent" },
    ]) {
      const conflict = await claim(changed);
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toMatchObject({ code: "idempotency-key-conflict" });
    }
  });

  it("recovers an expired lease once and rejects recovery while a lease is active", async () => {
    await setupReview();
    const activeReview = await submitBrowserReview({
      batchId: "batch_active",
      workId: "work_active",
      artifactId: "artifact_1",
      revisionId: "revision_1",
      assigneeAgentId: "codex",
      sessionId: "session_1",
      intents: [
        {
          intentId: "intent_active",
          intentType: "comment",
          target: { semanticId: "plan.active" },
          body: { text: "keep this claim active" },
        },
      ],
    });
    expect(activeReview.status).toBe(200);
    await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_active",
        claimId: "claim_active",
        agentId: "codex",
        processNonce: "process_active",
        ttlMs: 30000,
      }),
    });
    const processTakeover = await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_active",
        claimId: "claim_active",
        agentId: "codex",
        processNonce: "different_process",
        ttlMs: 30000,
      }),
    });
    expect(processTakeover.status).toBe(409);
    const activeRecovery = await fetch(url("/api/v1/work/recover"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_active",
        staleClaimId: "claim_active",
        claimId: "claim_stolen",
        agentId: "codex",
        processNonce: "process_stolen",
        ttlMs: 30000,
      }),
    });
    expect(activeRecovery.status).toBe(409);

    const claim = await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_1",
        claimId: "claim_old",
        agentId: "codex",
        processNonce: "process_old",
        ttlMs: 1,
      }),
    });
    expect(claim.status).toBe(200);

    const early = await fetch(url("/api/v1/work/recover"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_1",
        staleClaimId: "claim_old",
        claimId: "claim_new",
        agentId: "codex",
        processNonce: "process_new",
        ttlMs: 30000,
      }),
    });
    if (early.status === 409) await delay(5);

    const misleadingRetry = await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_1",
        claimId: "claim_old",
        agentId: "codex",
        processNonce: "process_new",
        ttlMs: 30000,
      }),
    });
    expect(misleadingRetry.status).toBe(409);
    expect(await misleadingRetry.json()).toMatchObject({
      code: "work.claim-recovery-required",
    });

    const recoveryBody = JSON.stringify({
      workId: "work_1",
      staleClaimId: "claim_old",
      claimId: "claim_new",
      agentId: "codex",
      processNonce: "process_new",
      ttlMs: 30000,
    });
    const recovered = await fetch(url("/api/v1/work/recover"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: recoveryBody,
    });
    expect(recovered.status).toBe(200);
    const retry = await fetch(url("/api/v1/work/recover"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: recoveryBody,
    });
    expect(retry.status).toBe(200);

    const events = await (
      await fetch(url("/api/v1/events?after=0"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(
      events.filter((event: { eventType: string }) => event.eventType === "work.abandoned"),
    ).toHaveLength(1);
    expect(
      events.filter((event: { eventType: string }) => event.eventType === "work.claimed"),
    ).toHaveLength(3);
    expect(
      (await snapshot()).work.find((item: { workId: string }) => item.workId === "work_1").claim,
    ).toEqual({ claimId: "claim_new", agentId: "codex" });
  });

  it("keeps addressed separate from acceptance and rebuilds correlation from events", async () => {
    await setupReview();
    await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_1",
        claimId: "claim_1",
        agentId: "codex",
        processNonce: "process_1",
      }),
    });
    await command(
      "work.complete",
      {
        workId: "work_1",
        claimId: "claim_1",
        agentId: "codex",
        summary: "implemented",
        revisionId: null,
      },
      { kind: "agent", id: "codex" },
    );
    expect((await snapshot()).work[0]).toMatchObject({
      status: "addressed",
      decision: "pending",
      assigneeAgentId: "codex",
      sessionId: "session_1",
    });

    const beforeForgedAccept = await durableCommandState();
    const forgedAccept = await command(
      "decision.accept",
      {
        decisionId: "decision_forged_accept",
        workId: "work_1",
        reason: "caller asserted a human label",
      },
      { kind: "human", id: "forged-cli-human" },
    );
    expect(forgedAccept.status).toBe(409);
    expect(await forgedAccept.json()).toMatchObject({
      status: "rejected",
      code: "authority.browser-human-required",
    });
    expect(await durableCommandState()).toEqual(beforeForgedAccept);

    const acceptBrowserHeaders = await authenticatedBrowserHeaders();
    const accepted = await fetch(url("/api/v1/commands"), {
      method: "POST",
      headers: acceptBrowserHeaders,
      body: JSON.stringify({
        protocol: "tweakloop.command/v1",
        commandId: "decision_browser_accept",
        idempotencyKey: "decision.browser.accept",
        workspaceId: daemon.workspaceId,
        actor: { kind: "agent", id: "forged-browser-body" },
        type: "decision.accept",
        payload: {
          decisionId: "decision_1",
          workId: "work_1",
          reason: "matches the request",
        },
      }),
    });
    expect(accepted.status).toBe(200);
    expect((await snapshot()).work[0].decision).toBe("accepted");

    daemon.close();
    const db = openDatabase(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
    rebuildProjections(db, daemon.workspaceId);
    db.close();
    daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
    expect((await snapshot()).work[0]).toMatchObject({
      status: "addressed",
      decision: "accepted",
      assigneeAgentId: "codex",
      sessionId: "session_1",
    });

    const beforeAgentReopen = await durableCommandState();
    const agentReopen = await command(
      "decision.reopen",
      {
        decisionId: "decision_agent_must_not_reopen",
        workId: "work_1",
        reason: "agent attempted retrack",
      },
      { kind: "agent", id: "codex" },
    );
    expect(await agentReopen.json()).toMatchObject({
      status: "rejected",
      code: "authority.browser-human-required",
    });
    expect(await durableCommandState()).toEqual(beforeAgentReopen);
    expect((await snapshot()).work[0]).toMatchObject({
      status: "addressed",
      decision: "accepted",
    });

    const reopenEnvelope = {
      protocol: "tweakloop.command/v1",
      commandId: "command_reopen_concurrent",
      idempotencyKey: "decision.reopen:concurrent",
      workspaceId: daemon.workspaceId,
      actor: { kind: "human", id: "alex" },
      type: "decision.reopen",
      payload: {
        decisionId: "decision_2",
        workId: "work_1",
        reason: "one edge case remains",
      },
    };
    const beforeForgedHumanReopen = await durableCommandState();
    const forgedHumanReopen = await fetch(url("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(reopenEnvelope),
    });
    expect(forgedHumanReopen.status).toBe(409);
    expect(await forgedHumanReopen.json()).toMatchObject({
      status: "rejected",
      code: "authority.browser-human-required",
    });
    expect(await durableCommandState()).toEqual(beforeForgedHumanReopen);

    const reopenBrowserHeaders = await authenticatedBrowserHeaders();
    const concurrentReopens = await Promise.all(
      Array.from({ length: 8 }, () =>
        fetch(url("/api/v1/commands"), {
          method: "POST",
          headers: reopenBrowserHeaders,
          body: JSON.stringify(reopenEnvelope),
        }),
      ),
    );
    const reopenReceipts = await Promise.all(concurrentReopens.map((response) => response.json()));
    expect(
      reopenReceipts.every(
        (receipt) => JSON.stringify(receipt) === JSON.stringify(reopenReceipts[0]),
      ),
    ).toBe(true);
    expect((await snapshot()).work[0]).toMatchObject({
      status: "open",
      decision: "reopened",
      result: { summary: "implemented" },
    });
    expect((await snapshot()).intents[0].status).toBe("submitted");
    const allEvents = (await (
      await fetch(url("/api/v1/events?after=0"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json()) as { eventType: string }[];
    expect(allEvents.filter((event) => event.eventType === "decision.reopened")).toHaveLength(1);

    daemon.close();
    const reopenedDb = openDatabase(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
    rebuildProjections(reopenedDb, daemon.workspaceId);
    reopenedDb.close();
    daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
    expect((await snapshot()).work[0]).toMatchObject({ status: "open", decision: "reopened" });
  });

  it("recovers authoritative progress sequence and time on normal restart and rebuild", async () => {
    await setupReview();
    const claimed = await fetch(url("/api/v1/work/claim"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workId: "work_1",
        claimId: "claim_progress",
        agentId: "codex",
        processNonce: "process_progress",
      }),
    });
    expect(claimed.status).toBe(200);
    const progressed = await command(
      "work.progress",
      {
        workId: "work_1",
        claimId: "claim_progress",
        agentId: "codex",
        summary: "validated the focused projection",
        revisionId: null,
        addressedIntentIds: [],
        releaseClaim: false,
      },
      { kind: "agent", id: "codex" },
    );
    expect(progressed.status).toBe(200);

    const events = (await (
      await fetch(url("/api/v1/events?after=0"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json()) as Array<{ seq: number; recordedAt: string; eventType: string }>;
    const progressEvent = events.find((item) => item.eventType === "work.progressed");
    expect(progressEvent).toBeDefined();
    const current = await snapshot();
    const before = current.work[0].progress;
    expect(before).toEqual([
      {
        summary: "validated the focused projection",
        revisionId: null,
        agentId: "codex",
        addressedIntentIds: [],
        seq: progressEvent?.seq,
        recordedAt: progressEvent?.recordedAt,
      },
    ]);

    daemon.close();
    let db = openDatabase(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
    const currentPrepare = vi.spyOn(db, "prepare");
    expect(
      projectSnapshot(
        db,
        {
          workspaceId: current.workspace.workspaceId,
          projectId: current.workspace.projectId,
          rootPath: current.workspace.rootPath,
          protocolVersion: current.workspace.protocolVersion,
        },
        current.workspace.artifactOrigin,
      ).work[0].progress,
    ).toEqual(before);
    expect(
      currentPrepare.mock.calls.some(([sql]) =>
        String(sql).includes("FROM events INDEXED BY events_by_stream"),
      ),
    ).toBe(false);
    currentPrepare.mockRestore();
    const legacy = db
      .prepare("SELECT progress_json FROM p_work WHERE work_id = ?")
      .get("work_1") as {
      progress_json: string;
    };
    db.prepare("UPDATE p_work SET progress_json = ? WHERE work_id = ?").run(
      JSON.stringify(
        (JSON.parse(legacy.progress_json) as Array<Record<string, unknown>>).map(
          ({ seq: _seq, recordedAt: _recordedAt, ...progress }) => progress,
        ),
      ),
      "work_1",
    );
    const legacyPrepare = vi.spyOn(db, "prepare");
    expect(
      projectSnapshot(
        db,
        {
          workspaceId: current.workspace.workspaceId,
          projectId: current.workspace.projectId,
          rootPath: current.workspace.rootPath,
          protocolVersion: current.workspace.protocolVersion,
        },
        current.workspace.artifactOrigin,
      ).work[0].progress,
    ).toEqual(before);
    const recoveryQueries = legacyPrepare.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("FROM events INDEXED BY events_by_stream"));
    expect(recoveryQueries).toHaveLength(1);
    expect(recoveryQueries[0]).toContain("WHERE workspace_id = ?");
    expect(recoveryQueries[0]).toContain("AND stream_type = 'work'");
    expect(recoveryQueries[0]).toContain("AND stream_id IN (?)");
    expect(recoveryQueries[0]).toContain("AND event_type = 'work.progressed'");
    legacyPrepare.mockRestore();
    db.close();
    daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
    expect((await snapshot()).work[0].progress).toEqual(before);

    daemon.close();
    db = openDatabase(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
    rebuildProjections(db, daemon.workspaceId);
    db.close();
    daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
    expect((await snapshot()).work[0].progress).toEqual(before);
  });
});
