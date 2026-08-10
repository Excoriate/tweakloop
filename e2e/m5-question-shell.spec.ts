import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const shellRoot = fileURLToPath(new URL("../web/shell/", import.meta.url));
const shellAssets = {
  "/app": { type: "text/html; charset=utf-8", body: readFileSync(`${shellRoot}index.html`) },
  "/app/shell.css": {
    type: "text/css; charset=utf-8",
    body: readFileSync(`${shellRoot}shell.css`),
  },
  "/app/shell.js": {
    type: "text/javascript; charset=utf-8",
    body: readFileSync(`${shellRoot}shell.js`),
  },
};

type ChoiceOption = { key: string; label: string };
type ChatContent =
  | { type: "text"; text: string }
  | { type: "choice-question"; prompt: string; options: ChoiceOption[] }
  | {
      type: "choice-answer";
      questionMessageId: string;
      optionKey: string;
      supersedesAnswerMessageId: string | null;
    };
type QuestionState =
  | null
  | { status: "pending" }
  | { status: "answered"; answerMessageId: string; optionKey: string; optionLabel: string };
type AnswerState =
  | null
  | { status: "current" }
  | { status: "superseded"; supersededByMessageId: string };
type ChatMessage = {
  messageId: string;
  artifactId: null;
  author: string;
  text: string;
  content: ChatContent;
  createdSeq: number;
  recordedAt: string;
  sessionId: string;
  context: null;
  references: never[];
  attachments: never[];
  delivery: null;
  questionState: QuestionState;
  answerState: AnswerState;
};
type Snapshot = {
  workspace: {
    workspaceId: string;
    projectId: string;
    rootPath: string;
    protocolVersion: number;
    artifactOrigin: string;
  };
  artifacts: never[];
  revisions: never[];
  sessionArtifacts: never[];
  intents: never[];
  work: never[];
  chat: ChatMessage[];
  events: never[];
  lastSeq: number;
};
type BrowserCommand = {
  protocol: string;
  commandId: string;
  idempotencyKey: string;
  workspaceId: string;
  actor: { kind: string; id: string };
  type: string;
  payload: {
    messageId: string;
    sessionId: string;
    content: ChatContent;
  };
};

const recordedAt = "2026-08-07T15:00:00.000Z";
let server: Server;
let origin: string;
let snapshot: Snapshot;
let commands: BrowserCommand[];
let staleQuestionId: string | null;
const eventClients = new Set<ServerResponse>();
const sessionContext = {
  artifactId: null,
  sessionId: "session_exact",
  agentId: "agent:codex",
};

function question(
  messageId: string,
  sessionId: string,
  createdSeq: number,
  options: ChoiceOption[] = [
    { key: "postgres", label: "Use PostgreSQL" },
    { key: "sqlite", label: "Keep SQLite" },
  ],
  author = "agent:codex",
): ChatMessage {
  const prompt = `Choose storage for ${messageId}`;
  return {
    messageId,
    artifactId: null,
    author,
    text: prompt,
    content: { type: "choice-question", prompt, options },
    createdSeq,
    recordedAt,
    sessionId,
    context: null,
    references: [],
    attachments: [],
    delivery: null,
    questionState: { status: "pending" },
    answerState: null,
  };
}

function answerMessage(
  messageId: string,
  questionMessageId: string,
  sessionId: string,
  optionKey: string,
  createdSeq: number,
  supersedesAnswerMessageId: string | null = null,
): ChatMessage {
  return {
    messageId,
    artifactId: null,
    author: "human:browser",
    text: optionKey,
    content: {
      type: "choice-answer",
      questionMessageId,
      optionKey,
      supersedesAnswerMessageId,
    },
    createdSeq,
    recordedAt,
    sessionId,
    context: null,
    references: [],
    attachments: [],
    delivery: null,
    questionState: null,
    answerState: { status: "current" },
  };
}

function emptySnapshot(chat: ChatMessage[] = []): Snapshot {
  return {
    workspace: {
      workspaceId: "workspace_m5_shell",
      projectId: "project_m5_shell",
      rootPath: "/tmp/m5-shell",
      protocolVersion: 1,
      artifactOrigin: origin,
    },
    artifacts: [],
    revisions: [],
    sessionArtifacts: [],
    intents: [],
    work: [],
    chat,
    events: [],
    lastSeq: Math.max(7, ...chat.map((item) => item.createdSeq)),
  };
}

function json(response: ServerResponse, value: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

function applyAnswer(command: BrowserCommand): void {
  const content = command.payload.content;
  if (content.type !== "choice-answer") return;
  const questionMessage = snapshot.chat.find(
    (message) => message.messageId === content.questionMessageId,
  );
  if (questionMessage?.content.type !== "choice-question") return;
  const selected = questionMessage.content.options.find(
    (option) => option.key === content.optionKey,
  );
  if (!selected) return;
  const answer = answerMessage(
    command.payload.messageId,
    questionMessage.messageId,
    command.payload.sessionId,
    content.optionKey,
    snapshot.lastSeq + 1,
    content.supersedesAnswerMessageId,
  );
  snapshot = {
    ...snapshot,
    chat: [
      ...snapshot.chat.map((message) => {
        if (message.messageId === questionMessage.messageId) {
          return {
            ...message,
            questionState: {
              status: "answered" as const,
              answerMessageId: answer.messageId,
              optionKey: selected.key,
              optionLabel: selected.label,
            },
          };
        }
        if (message.messageId === content.supersedesAnswerMessageId) {
          return {
            ...message,
            answerState: {
              status: "superseded" as const,
              supersededByMessageId: answer.messageId,
            },
          };
        }
        return message;
      }),
      answer,
    ],
    lastSeq: answer.createdSeq,
  };
}

function makeQuestionStale(questionId: string): void {
  const external = answerMessage(
    "answer_external",
    questionId,
    "session_exact",
    "sqlite",
    snapshot.lastSeq + 1,
  );
  snapshot = {
    ...snapshot,
    chat: [
      ...snapshot.chat.map((message) =>
        message.messageId === questionId
          ? {
              ...message,
              questionState: {
                status: "answered" as const,
                answerMessageId: external.messageId,
                optionKey: "sqlite",
                optionLabel: "Keep SQLite",
              },
            }
          : message,
      ),
      external,
    ],
    lastSeq: external.createdSeq,
  };
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", origin);
  const asset = shellAssets[url.pathname as keyof typeof shellAssets];
  if (asset) {
    response.writeHead(200, { "content-type": asset.type });
    response.end(asset.body);
    return;
  }
  if (url.pathname === "/api/v1/snapshot") {
    json(response, snapshot);
    return;
  }
  if (url.pathname === "/api/v1/session-context") {
    json(response, sessionContext);
    return;
  }
  if (url.pathname === "/api/v1/presence") {
    json(response, { agents: [{ agentId: "agent:codex", state: "listening" }] });
    return;
  }
  if (url.pathname === "/api/v1/events") {
    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream",
    });
    response.write(": connected\n\n");
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
    return;
  }
  if (url.pathname === "/api/v1/commands" && request.method === "POST") {
    const command = JSON.parse(await requestBody(request)) as BrowserCommand;
    commands.push(command);
    if (
      command.payload.content.type === "choice-answer" &&
      command.payload.content.questionMessageId === staleQuestionId
    ) {
      makeQuestionStale(staleQuestionId);
      staleQuestionId = null;
      json(
        response,
        {
          status: "rejected",
          error: "chat.answer-supersession-required",
          message: "the question already has a current answer",
        },
        409,
      );
      return;
    }
    applyAnswer(command);
    json(response, {
      status: "accepted",
      response: { messageId: command.payload.messageId },
    });
    return;
  }
  response.writeHead(404);
  response.end("not found");
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`${origin}/app`);
  await expect(page.getByTestId("connection")).toHaveText("synced");
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  for (const client of eventClients) client.end();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

test.beforeEach(() => {
  snapshot = emptySnapshot();
  commands = [];
  staleQuestionId = null;
});

test("renders an agent choice question as a named native group, never a plain paragraph", async ({
  page,
}) => {
  snapshot = emptySnapshot([
    question("question_exact", "session_exact", 8),
    question("question_human", "session_exact", 9, undefined, "human:browser"),
  ]);

  await openShell(page);

  const card = page.locator('[data-question-id="question_exact"]');
  await expect(card).toHaveJSProperty("tagName", "FIELDSET");
  await expect(
    page.getByRole("group", { name: "Choose storage for question_exact" }),
  ).toBeVisible();
  await expect(card.locator("legend")).toHaveText("Choose storage for question_exact");
  await expect(card.getByRole("button")).toHaveCount(2);
  await expect(card.getByTestId("question-status")).toContainText("Pending");

  const humanQuestion = page.locator('[data-question-id="question_human"]');
  await expect(humanQuestion.getByTestId("question-status")).toHaveText(
    "Only agent-authored questions can be answered here.",
  );
  await expect(humanQuestion.getByRole("button")).toHaveCount(2);
  expect(
    await humanQuestion
      .getByRole("button")
      .evaluateAll((buttons) => buttons.every((button) => button.disabled)),
  ).toBe(true);
});

test("keyboard answer targets the rendered question and exact session instead of ambient latest", async ({
  page,
}) => {
  snapshot = emptySnapshot([
    question("question_exact", "session_exact", 8),
    question("question_ambient_latest", "session_other", 9),
  ]);

  await openShell(page);

  const exactCard = page.locator('[data-question-id="question_exact"]');
  const exactOption = exactCard.getByRole("button", { name: /Use PostgreSQL/ });
  await exactOption.focus();
  await page.keyboard.press("Enter");

  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    actor: { kind: "human", id: "browser" },
    type: "chat.send",
    payload: {
      sessionId: "session_exact",
      content: {
        type: "choice-answer",
        questionMessageId: "question_exact",
        optionKey: "postgres",
        supersedesAnswerMessageId: null,
      },
    },
  });
  expect(commands[0].type).not.toMatch(/work|decision|acknowledge/);
  await expect(exactCard).toHaveAttribute("data-question-state", "answered");
  await expect(exactCard.getByTestId("question-status")).toContainText("Answered: Use PostgreSQL");
  await expect(exactCard.getByRole("button", { name: /Use PostgreSQL/ })).toBeDisabled();

  const otherSession = page.locator('[data-question-id="question_ambient_latest"]');
  await expect(otherSession.getByTestId("question-status")).toHaveText(
    "This question belongs to another session.",
  );
  await expect(otherSession.getByRole("button")).toHaveCount(2);
  expect(
    await otherSession
      .getByRole("button")
      .evaluateAll((buttons) => buttons.every((button) => button.disabled)),
  ).toBe(true);
  await expect(page.locator("#chat-flash")).toHaveText("Answer saved in this conversation.");
  await expect(page.locator("#chat-flash")).not.toContainText(
    /acknowledged|delivered|\bread\b|understood/i,
  );
});

test("a stale rejection refreshes projection truth and never paints the attempted option as answered", async ({
  page,
}) => {
  staleQuestionId = "question_stale";
  snapshot = emptySnapshot([question("question_stale", "session_exact", 8)]);

  await openShell(page);

  const card = page.locator('[data-question-id="question_stale"]');
  const attempted = card.getByRole("button", { name: /Use PostgreSQL/ });
  await attempted.focus();
  await page.keyboard.press(" ");

  await expect.poll(() => commands.length).toBe(1);
  await expect(card).toHaveAttribute("data-question-state", "answered");
  await expect(card.getByTestId("question-status")).toContainText("Answered: Keep SQLite");
  await expect(card.getByRole("button", { name: /Keep SQLite/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(attempted).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#chat-flash")).toContainText(
    "Answer not saved: the question already has a current answer",
  );
  await expect(page.locator("#chat-flash")).not.toContainText(
    /acknowledged|delivered|\bread\b|understood/i,
  );
});

test("changing an answer supersedes the exact current message and a double activation submits once", async ({
  page,
}) => {
  const answeredQuestion = question("question_change", "session_exact", 8);
  answeredQuestion.questionState = {
    status: "answered",
    answerMessageId: "answer_current",
    optionKey: "sqlite",
    optionLabel: "Keep SQLite",
  };
  snapshot = emptySnapshot([
    answeredQuestion,
    answerMessage("answer_current", "question_change", "session_exact", "sqlite", 9),
  ]);

  await openShell(page);

  const card = page.locator('[data-question-id="question_change"]');
  await expect(card.getByRole("button", { name: /Keep SQLite/ })).toBeDisabled();
  const replacement = card.getByRole("button", { name: /Use PostgreSQL/ });
  await replacement.evaluate((button) => {
    button.click();
    button.click();
  });

  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0].payload).toMatchObject({
    sessionId: "session_exact",
    content: {
      type: "choice-answer",
      questionMessageId: "question_change",
      optionKey: "postgres",
      supersedesAnswerMessageId: "answer_current",
    },
  });
  await expect(card.getByTestId("question-status")).toContainText("Answered: Use PostgreSQL");
  const previousAnswer = page.locator(
    '[data-message-id="answer_current"] [data-testid="choice-answer"]',
  );
  await expect(previousAnswer).toHaveAttribute("data-answer-state", "superseded");
  await expect(previousAnswer).toHaveJSProperty("tagName", "DETAILS");
  await expect(previousAnswer).not.toHaveAttribute("open", "");
});
