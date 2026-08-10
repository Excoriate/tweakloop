import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import { stateDirFor } from "../../src/daemon/runtime.js";
import type { Snapshot } from "../../src/protocol/snapshot.js";

let stateDir: string;
let workspaceRoot: string;
let daemon: DaemonHandle;
let browserHeaders: Record<string, string>;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-question-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-question-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateDir;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
  await expectAccepted(
    command(
      "session.start",
      "session:start",
      { kind: "agent", id: "codex" },
      {
        sessionId: "session_a",
        artifactId: null,
        agentId: "codex",
        processNonce: "process_codex",
        baseRevisionId: null,
        title: "Question session",
        goal: "answer exactly",
      },
    ),
  );
  browserHeaders = await authenticatedBrowserHeaders();
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("typed question daemon boundary", () => {
  it("derives pending, answered, and superseded state from immutable chat messages", async () => {
    await ask("question_1");
    expect(await getQuestion("question_1")).toMatchObject({
      messageId: "question_1",
      content: { type: "choice-question" },
      questionState: { status: "pending" },
      answerState: null,
    });

    await answer("answer_1", "keep", null);
    expect(await getQuestion("question_1")).toMatchObject({
      questionState: {
        status: "answered",
        answerMessageId: "answer_1",
        optionKey: "keep",
        optionLabel: "Keep the current approach",
      },
    });

    await answer("answer_2", "change", "answer_1");
    const after = await snapshot();
    expect(after.chat.find((message) => message.messageId === "question_1")).toMatchObject({
      questionState: {
        status: "answered",
        answerMessageId: "answer_2",
        optionKey: "change",
        optionLabel: "Change the approach",
      },
    });
    expect(after.chat.find((message) => message.messageId === "answer_1")).toMatchObject({
      content: { supersedesAnswerMessageId: null },
      answerState: { status: "superseded", supersededByMessageId: "answer_2" },
    });
    expect(after.chat.find((message) => message.messageId === "answer_2")).toMatchObject({
      content: { supersedesAnswerMessageId: "answer_1" },
      answerState: { status: "current" },
    });
    expect(after.work).toEqual([]);
    expect(after.intents).toEqual([]);
  });

  it("rejects self/cross-session answers atomically and never offers a typed answer as inbound chat", async () => {
    await ask("question_1");
    const before = await durableQuestionState();
    const self = await command(
      "chat.send",
      "answer:self",
      { kind: "human", id: "forged-cli-human" },
      answerPayload("answer_self", "keep", null),
    );
    expect(self.response.status).toBe(409);
    expect(self.body).toMatchObject({
      status: "rejected",
      code: "authority.browser-human-required",
    });
    expect(await durableQuestionState()).toEqual(before);

    const crossSession = await browserCommand("chat.send", "answer:cross-session", {
      ...answerPayload("answer_cross", "keep", null),
      sessionId: "session_missing",
    });
    expect(crossSession.response.status).toBe(409);
    expect(crossSession.body).toMatchObject({
      status: "rejected",
      code: "chat.answer-session-unknown",
    });
    expect(await durableQuestionState()).toEqual(before);

    await answer("answer_1", "keep", null);
    const next = await request("/api/v1/inbound/next", {
      sessionId: "session_a",
      agentId: "codex",
      processNonce: "process_codex",
      workLeaseTtlMs: 30_000,
    });
    expect(next.response.status).toBe(200);
    expect(next.body).toEqual({ kind: "none", timedOut: false });
  });
});

async function ask(messageId: string): Promise<void> {
  await expectAccepted(
    command(
      "chat.send",
      `question:${messageId}`,
      { kind: "agent", id: "codex" },
      {
        messageId,
        sessionId: "session_a",
        content: {
          type: "choice-question",
          prompt: "Which route?",
          options: [
            { key: "keep", label: "Keep the current approach" },
            { key: "change", label: "Change the approach" },
          ],
        },
      },
    ),
  );
}

async function answer(
  messageId: string,
  optionKey: string,
  supersedesAnswerMessageId: string | null,
): Promise<void> {
  await expectAccepted(
    browserCommand(
      "chat.send",
      `answer:${messageId}`,
      answerPayload(messageId, optionKey, supersedesAnswerMessageId),
    ),
  );
}

async function authenticatedBrowserHeaders(): Promise<Record<string, string>> {
  const minted = await request("/api/v1/bootstrap-tokens", {});
  expect(minted.response.status).toBe(201);
  const bootstrap = await fetch(String(minted.body.url), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return {
    cookie,
    origin: `http://127.0.0.1:${daemon.shellPort}`,
    "content-type": "application/json",
  };
}

async function browserCommand(
  type: string,
  idempotencyKey: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(shellUrl("/api/v1/commands"), {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `cmd_${idempotencyKey}`,
      idempotencyKey,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "forged-browser-body" },
      type,
      payload,
    }),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function answerPayload(
  messageId: string,
  optionKey: string,
  supersedesAnswerMessageId: string | null,
): Readonly<Record<string, unknown>> {
  return {
    messageId,
    sessionId: "session_a",
    content: {
      type: "choice-answer",
      questionMessageId: "question_1",
      optionKey,
      supersedesAnswerMessageId,
    },
  };
}

async function getQuestion(messageId: string): Promise<Record<string, unknown>> {
  const response = await fetch(
    shellUrl(`/api/v1/question?message=${encodeURIComponent(messageId)}`),
    { headers: { authorization: `Bearer ${daemon.cliToken}` } },
  );
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function snapshot(): Promise<Snapshot> {
  const response = await fetch(shellUrl("/api/v1/snapshot"), {
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  });
  return (await response.json()) as Snapshot;
}

async function durableQuestionState(): Promise<unknown> {
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

async function expectAccepted(
  result: Promise<{ response: Response; body: Record<string, unknown> }>,
): Promise<void> {
  const resolved = await result;
  expect(resolved.response.status).toBe(200);
  expect(resolved.body).toMatchObject({ status: "accepted" });
}

async function command(
  type: string,
  idempotencyKey: string,
  actor: Readonly<{ kind: "human" | "agent" | "system"; id: string }>,
  payload: Readonly<Record<string, unknown>>,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  return request("/api/v1/commands", {
    protocol: "tweakloop.command/v1",
    commandId: `cmd_${idempotencyKey}`,
    idempotencyKey,
    workspaceId: daemon.workspaceId,
    actor,
    type,
    payload,
  });
}

async function request(
  path: string,
  body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(shellUrl(path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function shellUrl(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}
