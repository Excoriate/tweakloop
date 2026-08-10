import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page, test } from "@playwright/test";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const AGENT_ID = "codex";
const SESSION_ID = "session-r24-resilience";
const PROCESS_NONCE = "process-r24-resilience";
const ORDINARY_CHAT = "Ordinary chat stays available while the typed question remains pending.";
const LONG_LABEL =
  "A-super-long-unbroken-label-that-must-wrap-without-covering-the-question-controls-or-growing-the-page-horizontally";
const DOCUMENT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>R24 resilience proof</title></head>
<body>
<main>
  <h1>R24 resilience proof</h1>
  <section data-tweak-id="r24.overview" data-tweak-kind="plan-section">
    <h2>Overview</h2>
    <p>One durable artifact used to attack question, acknowledgement, race, and restart truth.</p>
  </section>
</main>
</body>
</html>
`;

type OpenReceipt = {
  artifactId: string;
  revisionId: string;
  sessionId: string;
  processNonce: string;
  url: string;
};

type SessionStartReceipt = {
  session: {
    artifactId: string;
    sessionId: string;
    processNonce: string;
  };
  processNonce: string;
  url: string;
};

type DaemonReceipt = {
  pid: number;
  shellPort: number;
};

type CliResult = {
  status: number;
  stdout: string;
  stderr: string;
};

type QuestionReceipt = { messageId: string };

type NextChatReceipt = {
  kind: "chat";
  delivery: {
    attemptId: string;
    capability: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
    message: { messageId: string; text: string };
  };
};

let stateDir: string;
let workspaceDir: string;
let documentPath: string;
let env: NodeJS.ProcessEnv;
let opened: OpenReceipt;
let daemon: DaemonReceipt;
let twoOptionQuestionId: string;

function tweakResult(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [cli, "--workspace", workspaceDir, ...args], {
    env,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function tweak(args: string[]): string {
  return execFileSync(process.execPath, [cli, "--workspace", workspaceDir, ...args], {
    env,
    encoding: "utf8",
  });
}

function tweakJson<T>(args: string[]): T {
  return JSON.parse(tweak(["--json", ...args])) as T;
}

function startSession(): OpenReceipt {
  const published = tweakJson<Pick<OpenReceipt, "artifactId" | "revisionId">>([
    "publish",
    documentPath,
    "--agent",
    AGENT_ID,
  ]);
  const started = tweakJson<SessionStartReceipt>([
    "session",
    "start",
    documentPath,
    "--agent",
    AGENT_ID,
    "--session-id",
    SESSION_ID,
    "--process",
    PROCESS_NONCE,
    "--title",
    "R24 resilience",
    "--goal",
    "Prove truthful real-time collaboration under races and restart",
  ]);
  if (
    started.session.artifactId !== published.artifactId ||
    started.session.sessionId !== SESSION_ID ||
    started.session.processNonce !== PROCESS_NONCE ||
    started.processNonce !== PROCESS_NONCE
  ) {
    throw new Error(
      "session start did not preserve the exact R24 artifact/session/process identity",
    );
  }
  return { ...published, sessionId: SESSION_ID, processNonce: PROCESS_NONCE, url: started.url };
}

function openSession(): OpenReceipt {
  return tweakJson<OpenReceipt>([
    "open",
    documentPath,
    "--agent",
    AGENT_ID,
    "--session",
    SESSION_ID,
    "--process",
    PROCESS_NONCE,
    "--no-browser",
  ]);
}

function ask(prompt: string, options: readonly string[]): string {
  return tweakJson<QuestionReceipt>([
    "question",
    "ask",
    prompt,
    "--session",
    SESSION_ID,
    "--option",
    ...options,
  ]).messageId;
}

function chatMessages(): Array<Record<string, unknown>> {
  return tweakJson<{ messages: Array<Record<string, unknown>> }>(["chat", "list"]).messages;
}

async function tabTo(page: Page, selector: string, limit = 120): Promise<void> {
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  for (let index = 0; index < limit; index += 1) {
    await page.keyboard.press("Tab");
    if (
      await page.evaluate((target) => document.activeElement?.matches(target) ?? false, selector)
    ) {
      return;
    }
  }
  throw new Error(`keyboard focus did not reach ${selector} in ${limit} Tab presses`);
}

async function openChat(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await page.getByTestId("rail-tab-chat").click();
  await expect(page.locator("#chat-list")).toBeVisible();
}

async function mintIndependentPages(browser: Browser): Promise<{
  first: Page;
  second: Page;
  close: () => Promise<void>;
}> {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const firstOpen = openSession();
  const secondOpen = openSession();
  await Promise.all([openChat(first, firstOpen.url), openChat(second, secondOpen.url)]);
  return {
    first,
    second,
    close: async () => {
      await Promise.all([firstContext.close(), secondContext.close()]);
    },
  };
}

test.beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-r24-state-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "tweakloop-r24-workspace-"));
  documentPath = join(workspaceDir, "r24-resilience.html");
  env = { ...process.env, TWEAKLOOP_STATE_DIR: stateDir };
  writeFileSync(documentPath, DOCUMENT);
  daemon = tweakJson<DaemonReceipt>(["daemon", "start"]);
  opened = startSession();
});

test.afterAll(() => {
  try {
    tweak(["daemon", "stop"]);
  } catch {
    // The owned daemon may already be down if a restart assertion failed.
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

test("question boundaries, literal labels, ordinary-chat escape, keyboard loop, and 200% scale remain truthful", async ({
  page,
}) => {
  const baselineMessages = chatMessages();
  const invalidAttempts = [
    ["--json", "question", "ask", "Zero options", "--session", SESSION_ID],
    [
      "--json",
      "question",
      "ask",
      "One option",
      "--session",
      SESSION_ID,
      "--option",
      "one=Only one",
    ],
    [
      "--json",
      "question",
      "ask",
      "Nine options",
      "--session",
      SESSION_ID,
      "--option",
      ...Array.from({ length: 9 }, (_, index) => `k${index + 1}=Option ${index + 1}`),
    ],
    [
      "--json",
      "question",
      "ask",
      "Duplicate keys",
      "--session",
      SESSION_ID,
      "--option",
      "same=First",
      "same=Second",
    ],
    [
      "--json",
      "question",
      "ask",
      "Duplicate labels",
      "--session",
      SESSION_ID,
      "--option",
      "first=Same label",
      "second=Same label",
    ],
  ];
  for (const attempt of invalidAttempts) {
    const result = tweakResult(attempt);
    expect(result.status, result.stderr).not.toBe(0);
  }
  expect(chatMessages()).toHaveLength(baselineMessages.length);

  twoOptionQuestionId = ask("Choose the durable route", [
    "keep=Keep SQLite",
    "move=Use PostgreSQL",
  ]);
  const eightOptionQuestionId = ask("Choose one bounded option", [
    "one=First",
    "two=Second",
    `long=${LONG_LABEL}`,
    "markup=<b>Literal markup stays text</b>",
    "five=Fifth",
    "six=Sixth",
    "seven=Seventh",
    "eight=Eighth",
  ]);

  await openChat(page, opened.url);
  const twoCard = page.locator(`[data-question-id="${twoOptionQuestionId}"]`);
  const eightCard = page.locator(`[data-question-id="${eightOptionQuestionId}"]`);
  await expect(twoCard.getByTestId("question-option")).toHaveCount(2);
  await expect(eightCard.getByTestId("question-option")).toHaveCount(8);
  const markupLabel = eightCard.locator(".chat-question-option-label").filter({
    hasText: "<b>Literal markup stays text</b>",
  });
  await expect(markupLabel).toHaveCount(1);
  await expect(markupLabel.locator("b")).toHaveCount(0);
  const longLabel = eightCard
    .locator(".chat-question-option-label")
    .filter({ hasText: LONG_LABEL });
  expect(
    await longLabel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
  ).toBe(true);

  await tabTo(page, '[data-testid="rail-tab-chat"]');
  await page.keyboard.press("Enter");
  await tabTo(page, '[data-testid="chat-input"]');
  await page.keyboard.type(ORDINARY_CHAT);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("chat-item").filter({ hasText: ORDINARY_CHAT })).toHaveCount(1);
  const pending = tweakResult([
    "--json",
    "question",
    "wait",
    eightOptionQuestionId,
    "--timeout",
    "0",
  ]);
  expect(pending.status).toBe(2);
  expect(JSON.parse(pending.stdout)).toMatchObject({
    questionMessageId: eightOptionQuestionId,
    status: "pending",
    timedOut: true,
  });

  await tabTo(page, `[data-question-id="${twoOptionQuestionId}"] [data-testid="question-option"]`);
  await page.keyboard.press("Enter");
  const answered = tweakJson<{
    questionMessageId: string;
    status: string;
    answerMessageId: string;
    optionKey: string;
  }>(["question", "wait", twoOptionQuestionId, "--timeout", "5000"]);
  expect(answered).toMatchObject({
    questionMessageId: twoOptionQuestionId,
    status: "answered",
    optionKey: "keep",
  });
  await expect(twoCard).toHaveAttribute("data-question-state", "answered");
  await expect(twoCard.getByRole("button", { name: /Keep SQLite/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    await page.evaluate(
      (questionId) =>
        document.activeElement?.closest(`[data-question-id="${questionId}"]`) !== null,
      twoOptionQuestionId,
    ),
  ).toBe(true);

  await page.setViewportSize({ width: 320, height: 800 });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.setViewportSize({ width: 900, height: 800 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
  const collaborationSheet = page.getByRole("button", { name: /Codex ·/ });
  await collaborationSheet.focus();
  await page.keyboard.press("Enter");
  await expect(twoCard.getByRole("button", { name: /Keep SQLite/ })).toBeVisible();
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
});

test("bad acknowledgement never paints success and answer plus ack survive an owned daemon SIGTERM", async ({
  page,
}) => {
  const fresh = openSession();
  await openChat(page, fresh.url);
  const humanMessage = page.getByTestId("chat-item").filter({ hasText: ORDINARY_CHAT });
  await expect(humanMessage.getByTestId("chat-delivery")).toHaveText("Saved");
  await expect(humanMessage.getByTestId("chat-delivery")).not.toContainText("Acknowledged");

  const selected = tweakJson<NextChatReceipt>([
    "next",
    "--session",
    SESSION_ID,
    "--agent",
    AGENT_ID,
    "--process",
    PROCESS_NONCE,
    "--wait",
    "--timeout",
    "0",
  ]);
  expect(selected.kind).toBe("chat");
  expect(selected.delivery.message.text).toBe(ORDINARY_CHAT);
  await expect(humanMessage.getByTestId("chat-delivery")).toHaveText("Offered to agent runner");

  const badAck = tweakResult([
    "--json",
    "chat",
    "acknowledge",
    selected.delivery.message.messageId,
    "--delivery",
    selected.delivery.attemptId,
    "--capability",
    "0".repeat(64),
    "--session",
    SESSION_ID,
    "--agent",
    AGENT_ID,
    "--process",
    PROCESS_NONCE,
  ]);
  expect(badAck.status, badAck.stderr).not.toBe(0);
  await expect(humanMessage.getByTestId("chat-delivery")).toHaveText("Offered to agent runner");
  await expect(humanMessage.getByTestId("chat-delivery")).not.toContainText("Acknowledged");

  const acknowledged = tweakJson<{ status: string; messageId: string; attemptId: string }>([
    "chat",
    "acknowledge",
    selected.delivery.message.messageId,
    "--delivery",
    selected.delivery.attemptId,
    "--capability",
    selected.delivery.capability,
    "--session",
    SESSION_ID,
    "--agent",
    AGENT_ID,
    "--process",
    PROCESS_NONCE,
  ]);
  expect(acknowledged).toMatchObject({
    status: "acknowledged",
    messageId: selected.delivery.message.messageId,
    attemptId: selected.delivery.attemptId,
  });
  await expect(humanMessage.getByTestId("chat-delivery")).toContainText("Acknowledged by Codex");

  tweak(["presence", "thinking", "--agent", AGENT_ID, "--ttl", "30000"]);
  await expect(page.locator("#agent-status")).toHaveText("Thinking", { timeout: 6_000 });

  const offeredText = "Offered-state census message";
  await page.getByTestId("chat-input").fill(offeredText);
  await page.getByTestId("chat-input").press("Enter");
  const offeredMessage = page.getByTestId("chat-item").filter({ hasText: offeredText });
  await expect(offeredMessage.getByTestId("chat-delivery")).toHaveText("Saved");
  const offered = tweakJson<NextChatReceipt>([
    "next",
    "--session",
    SESSION_ID,
    "--agent",
    AGENT_ID,
    "--process",
    PROCESS_NONCE,
    "--wait",
    "--timeout",
    "0",
  ]);
  expect(offered.delivery.message.text).toBe(offeredText);
  await expect(offeredMessage.getByTestId("chat-delivery")).toHaveText("Offered to agent runner");

  const savedText = "Saved-state census message";
  await page.getByTestId("chat-input").fill(savedText);
  await page.getByTestId("chat-input").press("Enter");
  const savedMessage = page.getByTestId("chat-item").filter({ hasText: savedText });
  await expect(savedMessage.getByTestId("chat-delivery")).toHaveText("Saved");

  const answerBeforeRestart = tweakJson<{
    questionMessageId: string;
    answerMessageId: string;
    optionKey: string;
  }>(["question", "wait", twoOptionQuestionId, "--timeout", "0"]);

  const census = {
    save: {
      entity: await savedMessage.getAttribute("data-message-id"),
      action: "persist human chat",
      state: await savedMessage.getByTestId("chat-delivery").textContent(),
    },
    delivery: {
      entity: await offeredMessage.getAttribute("data-message-id"),
      action: "offer chat to assigned agent",
      state: await offeredMessage.getByTestId("chat-delivery").textContent(),
    },
    acknowledgement: {
      entity: selected.delivery.message.messageId,
      action: "acknowledge exact delivery attempt",
      state: await humanMessage.getByTestId("chat-delivery").textContent(),
    },
    availability: {
      entity: AGENT_ID,
      action: "report live thinking presence",
      state: await page.locator("#agent-status").textContent(),
    },
    assignment: {
      entity: SESSION_ID,
      action: "identify assigned collaborator",
      state: await page.locator("#agent-name").getAttribute("title"),
    },
    question: {
      entity: twoOptionQuestionId,
      action: "record current typed answer",
      state: await page
        .locator(`[data-question-id="${twoOptionQuestionId}"]`)
        .getByTestId("question-status")
        .textContent(),
    },
    revision: {
      entity: opened.artifactId,
      action: "identify selected immutable revision",
      state: await page.getByTestId("revision-select").inputValue(),
    },
  };
  expect(census.save.state).toBe("Saved");
  expect(census.delivery.state).toBe("Offered to agent runner");
  expect(census.acknowledgement.state).toContain("Acknowledged by Codex");
  expect(census.availability.state).toBe("Thinking");
  expect(census.assignment.state).toBe(AGENT_ID);
  expect(census.question.state).toContain("Answered: Keep SQLite");
  expect(census.revision.state).toBe(opened.revisionId);
  expect(Object.values(census).every((dimension) => dimension.entity && dimension.action)).toBe(
    true,
  );
  await test.info().attach("r24-state-census.json", {
    body: Buffer.from(`${JSON.stringify(census, null, 2)}\n`),
    contentType: "application/json",
  });

  const oldDaemon = daemon;
  process.kill(oldDaemon.pid, "SIGTERM");
  await expect(page.getByTestId("connection")).toHaveText("reconnecting…", { timeout: 10_000 });
  await expect(page.locator("#agent-status")).toContainText(/reconnecting|offline/, {
    timeout: 10_000,
  });
  await expect(page.locator("#agent-status")).not.toHaveText("Thinking");
  await expect
    .poll(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${oldDaemon.shellPort}/health`)).ok;
      } catch {
        return false;
      }
    })
    .toBe(false);
  daemon = tweakJson<DaemonReceipt>(["daemon", "start"]);
  expect(daemon.pid).not.toBe(oldDaemon.pid);

  const sameAnswer = tweakJson<{
    questionMessageId: string;
    answerMessageId: string;
    optionKey: string;
  }>(["question", "wait", twoOptionQuestionId, "--timeout", "0"]);
  expect(sameAnswer).toMatchObject({
    questionMessageId: twoOptionQuestionId,
    answerMessageId: answerBeforeRestart.answerMessageId,
    optionKey: "keep",
  });
  const sameChat = chatMessages().find(
    (message) => message.messageId === selected.delivery.message.messageId,
  ) as { delivery?: { status?: string; attemptId?: string } } | undefined;
  expect(sameChat?.delivery).toMatchObject({
    status: "acknowledged",
    attemptId: selected.delivery.attemptId,
  });

  const reopened = openSession();
  await openChat(page, reopened.url);
  await expect(
    page.locator(`[data-question-id="${twoOptionQuestionId}"]`).getByTestId("question-status"),
  ).toContainText("Answered: Keep SQLite");
  await expect(
    page.getByTestId("chat-item").filter({ hasText: ORDINARY_CHAT }).getByTestId("chat-delivery"),
  ).toContainText("Acknowledged by Codex");
});

test("two independent browser clients race one question to one explicit winner and one explicit loser", async ({
  browser,
}) => {
  const raceQuestionId = ask("Choose exactly one concurrent winner", [
    "keep=Keep SQLite",
    "move=Use PostgreSQL",
  ]);
  const clients = await mintIndependentPages(browser);
  try {
    const firstCard = clients.first.locator(`[data-question-id="${raceQuestionId}"]`);
    const secondCard = clients.second.locator(`[data-question-id="${raceQuestionId}"]`);
    await expect(firstCard).toHaveAttribute("data-question-state", "pending");
    await expect(secondCard).toHaveAttribute("data-question-state", "pending");

    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const intercept = async (
      route: Parameters<Page["route"]>[1] extends (route: infer R) => unknown ? R : never,
    ) => {
      const command = route.request().postDataJSON() as {
        type?: string;
        payload?: { content?: { type?: string; questionMessageId?: string } };
      };
      if (
        command.type === "chat.send" &&
        command.payload?.content?.type === "choice-answer" &&
        command.payload.content.questionMessageId === raceQuestionId
      ) {
        arrivals += 1;
        if (arrivals === 2) release();
        await barrier;
      }
      await route.continue();
    };
    await clients.first.route("**/api/v1/commands", intercept);
    await clients.second.route("**/api/v1/commands", intercept);

    await Promise.all([
      firstCard.getByRole("button", { name: /Keep SQLite/ }).click(),
      secondCard.getByRole("button", { name: /Use PostgreSQL/ }).click(),
    ]);
    await expect.poll(() => arrivals).toBe(2);
    await expect(firstCard).toHaveAttribute("data-question-state", "answered");
    await expect(secondCard).toHaveAttribute("data-question-state", "answered");

    const firstStatus = (await firstCard.getByTestId("question-status").textContent()) ?? "";
    const secondStatus = (await secondCard.getByTestId("question-status").textContent()) ?? "";
    expect(firstStatus).toBe(secondStatus);
    const flashes = [
      (await clients.first.locator("#chat-flash").textContent()) ?? "",
      (await clients.second.locator("#chat-flash").textContent()) ?? "",
    ];
    expect(flashes.filter((message) => message.includes("Answer not saved"))).toHaveLength(1);
    expect(flashes.filter((message) => message.includes("Answer saved"))).toHaveLength(1);

    const final = tweakJson<{
      questionMessageId: string;
      status: string;
      answerMessageId: string;
      optionKey: string;
      optionLabel: string;
    }>(["question", "wait", raceQuestionId, "--timeout", "0"]);
    expect(final.status).toBe("answered");
    expect(firstStatus).toContain(`Answered: ${final.optionLabel}`);
    const durableAnswers = chatMessages().filter((message) => {
      const content = message.content as { type?: string; questionMessageId?: string } | undefined;
      return content?.type === "choice-answer" && content.questionMessageId === raceQuestionId;
    });
    expect(durableAnswers).toHaveLength(1);
    expect(durableAnswers[0]?.messageId).toBe(final.answerMessageId);

    const eventAnswers = tweakJson<{
      events: Array<{ eventType: string; payload?: Record<string, unknown> }>;
    }>(["events", "list"]).events.filter((event) => {
      const content = event.payload?.content as
        | { type?: string; questionMessageId?: string }
        | undefined;
      return (
        event.eventType === "chat.message" &&
        content?.type === "choice-answer" &&
        content.questionMessageId === raceQuestionId
      );
    });
    expect(eventAnswers).toHaveLength(1);

    const firstLost = flashes[0]?.includes("Answer not saved") ?? false;
    const losingPage = firstLost ? clients.first : clients.second;
    const losingChoice = firstLost ? "Keep SQLite" : "Use PostgreSQL";
    const priorAnswerId = final.answerMessageId;
    await losingPage
      .locator(`[data-question-id="${raceQuestionId}"]`)
      .getByRole("button", { name: losingChoice })
      .click();
    await expect(
      losingPage.locator(`[data-question-id="${raceQuestionId}"]`).getByTestId("question-status"),
    ).toContainText(`Answered: ${losingChoice}`);
    await expect(losingPage.locator("#chat-flash")).toContainText("Answer saved");

    const retried = tweakJson<{
      questionMessageId: string;
      status: string;
      answerMessageId: string;
      optionLabel: string;
    }>(["question", "wait", raceQuestionId, "--timeout", "0"]);
    expect(retried).toMatchObject({
      questionMessageId: raceQuestionId,
      status: "answered",
      optionLabel: losingChoice,
    });
    expect(retried.answerMessageId).not.toBe(priorAnswerId);
    const answersAfterRetry = chatMessages().filter((message) => {
      const content = message.content as { type?: string; questionMessageId?: string } | undefined;
      return content?.type === "choice-answer" && content.questionMessageId === raceQuestionId;
    });
    expect(answersAfterRetry).toHaveLength(2);
    expect(answersAfterRetry.map((message) => message.messageId)).toEqual(
      expect.arrayContaining([priorAnswerId, retried.answerMessageId]),
    );
    const visiblePrior = losingPage
      .locator(`[data-message-id="${priorAnswerId}"]`)
      .getByTestId("choice-answer");
    const visibleCurrent = losingPage
      .locator(`[data-message-id="${retried.answerMessageId}"]`)
      .getByTestId("choice-answer");
    await expect(visiblePrior).toHaveAttribute("data-answer-state", "superseded");
    await expect(visiblePrior).toContainText(`Previous answer: ${final.optionLabel}`);
    await expect(visiblePrior).toContainText("Superseded by a later answer");
    await expect(visibleCurrent).toHaveAttribute("data-answer-state", "current");
    await expect(visibleCurrent).toContainText(`Selected: ${losingChoice}`);
  } finally {
    await clients.close();
  }
});

test("every recovery state explains its cause and next action, then visibly recovers", async ({
  page,
}) => {
  test.setTimeout(60_000);
  const matrix: Array<{
    state: string;
    cause: string;
    nextAction: string;
    observation: string;
  }> = [];

  const emptyStateDir = mkdtempSync(join(tmpdir(), "tweakloop-r24-empty-state-"));
  const emptyWorkspaceDir = mkdtempSync(join(tmpdir(), "tweakloop-r24-empty-workspace-"));
  const emptyEnv = { ...process.env, TWEAKLOOP_STATE_DIR: emptyStateDir };
  const emptyTweakJson = <T>(args: string[]): T =>
    JSON.parse(
      execFileSync(process.execPath, [cli, "--workspace", emptyWorkspaceDir, "--json", ...args], {
        env: emptyEnv,
        encoding: "utf8",
      }),
    ) as T;
  emptyTweakJson<DaemonReceipt>(["daemon", "start"]);
  try {
    const emptySession = emptyTweakJson<OpenReceipt>([
      "session",
      "start",
      "--empty",
      "--agent",
      AGENT_ID,
      "--process",
      PROCESS_NONCE,
      "--session-id",
      "session-r24-empty",
      "--title",
      "R24 empty start",
    ]);
    await page.goto(emptySession.url);
    await expect(page.getByTestId("start-surface")).toBeVisible();
    const firstRun = (await page.getByTestId("start-surface").textContent()) ?? "";
    expect(firstRun).toContain("What do you want to work on?");
    expect(firstRun).toContain("Open files");
    expect(firstRun).toContain("Open a workspace");
    expect(firstRun).toContain("New whiteboard");
    matrix.push({
      state: "first-run",
      cause: "the workspace and session have no artifacts",
      nextAction: "open files, open a workspace, or create a whiteboard",
      observation: firstRun,
    });
  } finally {
    try {
      emptyTweakJson<Record<string, unknown>>(["daemon", "stop"]);
    } finally {
      rmSync(emptyStateDir, { recursive: true, force: true });
      rmSync(emptyWorkspaceDir, { recursive: true, force: true });
    }
  }

  let releaseArtifact!: () => void;
  const artifactBarrier = new Promise<void>((resolve) => {
    releaseArtifact = resolve;
  });
  await page.route("**/r/**", async (route) => {
    await artifactBarrier;
    await route.continue();
  });
  const slowOpen = openSession();
  await page.goto(slowOpen.url, { waitUntil: "domcontentloaded" });
  await expect(page.locator("#viewer-transition")).toContainText(
    "Wait while Tweakloop verifies this revision",
  );
  matrix.push({
    state: "loading-slow",
    cause: "the selected revision is still being verified",
    nextAction: "wait for verification to finish",
    observation: (await page.locator("#viewer-transition").textContent()) ?? "",
  });
  releaseArtifact();
  await expect(page.locator("#viewer-transition")).toBeHidden({ timeout: 10_000 });
  await page.unroute("**/r/**");

  await page.route("**/api/v1/snapshot", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "{invalid-json" }),
  );
  const corruptOpen = openSession();
  await page.goto(corruptOpen.url);
  await expect(page.getByTestId("connection")).toHaveText("invalid workspace data");
  const corruptRecovery = (await page.locator("#viewer-empty").textContent()) ?? "";
  expect(corruptRecovery).toContain("could not read");
  expect(corruptRecovery).toContain("Restart the daemon");
  expect(corruptRecovery).toContain("Nothing was changed");
  matrix.push({
    state: "corrupt-invalid",
    cause: "workspace data could not be read",
    nextAction: "restart the daemon and reopen with tweak open",
    observation: corruptRecovery,
  });
  await page.unroute("**/api/v1/snapshot");
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  matrix.push({
    state: "post-failure",
    cause: "the invalid response was removed",
    nextAction: "reload the same durable session",
    observation: (await page.getByTestId("connection").getAttribute("aria-label")) ?? "",
  });

  tweak(["presence", "thinking", "--agent", AGENT_ID, "--ttl", "30000"]);
  const hasRecentAcknowledgement = chatMessages().some((message) => {
    const delivery = message.delivery as
      | { status?: string; agentId?: string; acknowledgedAt?: string | null }
      | null
      | undefined;
    if (
      delivery?.status !== "acknowledged" ||
      delivery.agentId?.replace(/^agent:/, "") !== AGENT_ID ||
      !delivery.acknowledgedAt
    ) {
      return false;
    }
    const acknowledgedAt = Date.parse(delivery.acknowledgedAt);
    return Number.isFinite(acknowledgedAt) && Date.now() - acknowledgedAt <= 5 * 60 * 1000;
  });
  await page.route("**/api/v1/events?**", (route) => route.abort("failed"));
  await page.route("**/api/v1/presence", (route) =>
    route.fulfill({ status: 503, body: "presence unavailable" }),
  );
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("reconnecting…", { timeout: 8_000 });
  const reconnectHelp = (await page.getByTestId("connection").getAttribute("aria-label")) ?? "";
  expect(reconnectHelp).toContain("interrupted");
  expect(reconnectHelp).toContain("retrying automatically");
  await expect(page.locator("#agent-status")).toHaveText(
    hasRecentAcknowledgement ? "Acknowledged recently" : "Assigned · offline",
    {
      timeout: 9_000,
    },
  );
  const agentWithoutPresence =
    (await page.locator("#agent-status").getAttribute("aria-label")) ?? "";
  if (hasRecentAcknowledgement) {
    expect(agentWithoutPresence).toContain("acknowledged a message recently");
    expect(agentWithoutPresence).toContain("Live presence is unavailable");
    expect(agentWithoutPresence).toContain("not that the agent is still connected or working");
  } else {
    expect(agentWithoutPresence).toContain("assigned but not connected");
    expect(agentWithoutPresence).toContain("until the agent reconnects");
  }
  matrix.push(
    {
      state: "offline-reconnect",
      cause: "the live update connection was interrupted",
      nextAction: "allow automatic retry or restart and reopen",
      observation: reconnectHelp,
    },
    {
      state: hasRecentAcknowledgement ? "receipt-without-presence" : "unavailable-agent",
      cause: hasRecentAcknowledgement
        ? "a durable acknowledgement remains recent while live presence is unavailable"
        : "the assigned agent is not connected and has no recent acknowledgement",
      nextAction: hasRecentAcknowledgement
        ? "retain the receipt without calling the agent connected or working"
        : "leave saved work in the inbox until the agent reconnects",
      observation: agentWithoutPresence,
    },
  );
  await page.unroute("**/api/v1/events?**");
  await page.unroute("**/api/v1/presence");
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(page.locator("#agent-status")).toHaveText("Thinking", { timeout: 6_000 });

  const conflictQuestionId = ask("Recover from one rejected answer", [
    "keep=Keep current",
    "replace=Replace current",
  ]);
  await openChat(page, openSession().url);
  let rejectOnce = true;
  await page.route("**/api/v1/commands", async (route) => {
    const command = route.request().postDataJSON() as {
      type?: string;
      payload?: { content?: { type?: string; questionMessageId?: string } };
    };
    if (
      rejectOnce &&
      command.type === "chat.send" &&
      command.payload?.content?.type === "choice-answer" &&
      command.payload.content.questionMessageId === conflictQuestionId
    ) {
      rejectOnce = false;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ status: "rejected", message: "another answer became current" }),
      });
      return;
    }
    await route.continue();
  });
  const conflictCard = page.locator(`[data-question-id="${conflictQuestionId}"]`);
  await conflictCard.getByRole("button", { name: "Keep current" }).click();
  await expect(page.locator("#chat-flash")).toContainText("Answer not saved");
  await expect(page.locator("#chat-flash")).toContainText("choose again");
  matrix.push({
    state: "conflict",
    cause: "another answer became current",
    nextAction: "review the latest answer and choose again to replace it",
    observation: (await page.locator("#chat-flash").textContent()) ?? "",
  });
  await conflictCard.getByRole("button", { name: "Keep current" }).click();
  await expect(page.locator("#chat-flash")).toContainText("Answer saved");
  await expect(conflictCard).toHaveAttribute("data-question-state", "answered");
  matrix.push({
    state: "post-retry",
    cause: "the explicit retry reached the durable command path",
    nextAction: "continue from the visibly saved answer",
    observation: (await conflictCard.getByTestId("question-status").textContent()) ?? "",
  });

  expect(matrix.map((entry) => entry.state)).toEqual([
    "first-run",
    "loading-slow",
    "corrupt-invalid",
    "post-failure",
    "offline-reconnect",
    hasRecentAcknowledgement ? "receipt-without-presence" : "unavailable-agent",
    "conflict",
    "post-retry",
  ]);
  expect(matrix.every((entry) => entry.cause.length > 0 && entry.nextAction.length > 0)).toBe(true);
  await test.info().attach("r24-recovery-state-matrix.json", {
    body: Buffer.from(`${JSON.stringify(matrix, null, 2)}\n`),
    contentType: "application/json",
  });
});
