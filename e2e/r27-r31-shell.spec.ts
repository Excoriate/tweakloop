import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const shellRoot = fileURLToPath(new URL("../web/shell/", import.meta.url));
const bridgeRoot = fileURLToPath(new URL("../web/bridge/", import.meta.url));
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
  "/bridge/bridge.js": {
    type: "text/javascript; charset=utf-8",
    body: readFileSync(`${bridgeRoot}bridge.js`),
  },
};

type Intent = {
  intentId: string;
  batchId: string;
  artifactId: string;
  revisionId: string;
  intentType: string;
  target: { semanticId: string; textQuote: { exact: string } };
  body: { text: string };
  status: "submitted" | "addressed";
  createdSeq: number;
};

type Progress = {
  summary: string;
  revisionId: string | null;
  agentId: string;
  addressedIntentIds: string[];
  seq: number;
  recordedAt: string;
};

type Work = {
  workId: string;
  artifactId: string;
  baseRevisionId: string;
  intentIds: string[];
  status: "open" | "claimed" | "addressed";
  assigneeAgentId: string | null;
  sessionId: string;
  claim: { claimId: string; agentId: string } | null;
  result: { summary: string; revisionId: string | null; agentId: string } | null;
  progress: Progress[];
  decision: "pending" | "accepted" | "reopened";
  createdSeq: number;
};

type ChatMessage = {
  messageId: string;
  artifactId: null;
  author: string;
  text: string;
  content: { type: "text"; text: string };
  context: null;
  mentions: string[];
  references: never[];
  attachments: never[];
  sessionId: string;
  recipientAgentId: string;
  threadId: null;
  workId: null;
  intentId: null;
  delivery: null | {
    status: "offered" | "acknowledged";
    attemptId: string;
    attemptNumber: number;
    agentId: string;
    offeredAt: string;
    acknowledgedAt: string | null;
    pausedAt: null;
    pauseReason: null;
  };
  questionState: null;
  answerState: null;
  recordedAt: string;
  createdSeq: number;
};

type Snapshot = {
  workspace: {
    workspaceId: string;
    projectId: string;
    rootPath: string;
    protocolVersion: number;
    artifactOrigin: string;
  };
  artifacts: Array<{
    artifactId: string;
    name: string;
    format: string;
    sourcePath: string;
    provenance: { kind: "workspace-source" };
    registeredSeq: number;
  }>;
  revisions: Array<{
    revisionId: string;
    artifactId: string;
    parentId: null;
    seq: number;
    format: string;
    entryPath: string;
    entryHash: string;
    producer: { kind: "agent"; id: string };
    createdSeq: number;
  }>;
  sessionArtifacts: never[];
  intents: Intent[];
  work: Work[];
  chat: ChatMessage[];
  events: never[];
  lastSeq: number;
};

const recordedAt = "2026-08-08T12:00:00.000Z";
const progressBoundaryNow = Date.parse(recordedAt);
const recentProgressAt = new Date(progressBoundaryNow - 5 * 60 * 1000).toISOString();
const oldProgressAt = new Date(progressBoundaryNow - 5 * 60 * 1000 - 1).toISOString();
function artifactHtml(revisionId: string): string {
  return `<!doctype html>
<html lang="en">
<body data-revision-id="${revisionId}">
  <button id="select-target" type="button">Select target</button>
  <section data-tweak-id="section.truth"><h2>Truth section</h2><p>Truthful collaboration text.</p></section>
  <script>
    const protocol = "tweakloop.bridge/v1";
    let port = null;
    window.__revealCount = 0;
    window.addEventListener("message", (event) => {
      if (event.data?.protocol !== protocol || event.data?.type !== "connect") return;
      port = event.ports[0];
      port.onmessage = (message) => {
        if (message.data?.type !== "reveal-target") return;
        window.__revealCount += 1;
        port.postMessage({
          protocol,
          type: "target-revealed",
          revisionId: "${revisionId}",
          payload: { semanticId: message.data.payload?.semanticId },
        });
      };
      port.start();
      port.postMessage({
        protocol,
        type: "ready",
        revisionId: "${revisionId}",
        payload: {
          nodes: [{ semanticId: "section.truth", kind: "section", label: "Truth section" }],
          whiteboards: [],
        },
      });
    });
    document.querySelector("#select-target").addEventListener("click", () => {
      port?.postMessage({
        protocol,
        type: "target-selected",
        revisionId: "${revisionId}",
        payload: {
          semanticId: "section.truth",
          textQuote: { exact: "Truthful collaboration text." },
        },
      });
    });
  </script>
</body>
</html>`;
}

const bridgeFixtureHtml = `<!doctype html>
<html lang="en">
<body>
  <button id="selection-invoker" type="button">Comment on selection</button>
  <main id="document-editor" data-tweakloop-editor contenteditable="true" tabindex="0">Document editor fallback.</main>
  <section data-tweak-id="section.bridge"><p id="selection-text">Selection focus must return truthfully.</p></section>
  <script>
    window.__TWEAKLOOP__ = {
      artifactId: "artifact_bridge",
      revisionId: "revision_bridge",
      shellOrigin: ${JSON.stringify("__ORIGIN__")},
    };
  </script>
  <script src="/bridge/bridge.js"></script>
</body>
</html>`;

let server: Server;
let origin: string;
let snapshot: Snapshot;
let presence: Array<{ agentId: string; state: string; expiresAt?: string }>;
let commands: Array<{
  commandId: string;
  idempotencyKey: string;
  type: string;
  payload: Record<string, unknown>;
}>;
let commandFailures: Map<string, number>;
const eventClients = new Set<ServerResponse>();

function intent(intentId: string, status: Intent["status"] = "submitted"): Intent {
  return {
    intentId,
    batchId: `batch_${intentId}`,
    artifactId: "artifact_r27",
    revisionId: "revision_r27",
    intentType: "comment",
    target: { semanticId: "section.truth", textQuote: { exact: "Truthful collaboration text." } },
    body: { text: `Comment ${intentId}` },
    status,
    createdSeq: 2,
  };
}

function work(
  workId: string,
  intentId: string,
  status: Work["status"],
  decision: Work["decision"],
  agentId = `agent:${workId}`,
  progress: Progress[] = [],
): Work {
  return {
    workId,
    artifactId: "artifact_r27",
    baseRevisionId: "revision_r27",
    intentIds: [intentId],
    status,
    assigneeAgentId: agentId,
    sessionId: "session_r27",
    claim: status === "claimed" ? { claimId: `claim_${workId}`, agentId } : null,
    result:
      status === "addressed" ? { summary: `Result ${workId}`, revisionId: null, agentId } : null,
    progress,
    decision,
    createdSeq: 3,
  };
}

function chatMessage(
  messageId: string,
  delivery: ChatMessage["delivery"],
  createdSeq: number,
): ChatMessage {
  return {
    messageId,
    artifactId: null,
    author: "human:browser",
    text: `Message ${messageId}`,
    content: { type: "text", text: `Message ${messageId}` },
    context: null,
    mentions: [],
    references: [],
    attachments: [],
    sessionId: "session_r27",
    recipientAgentId: "agent:codex",
    threadId: null,
    workId: null,
    intentId: null,
    delivery,
    questionState: null,
    answerState: null,
    recordedAt,
    createdSeq,
  };
}

function baseSnapshot(): Snapshot {
  return {
    workspace: {
      workspaceId: "workspace_r27",
      projectId: "project_r27",
      rootPath: "/tmp/r27",
      protocolVersion: 1,
      artifactOrigin: origin,
    },
    artifacts: [
      {
        artifactId: "artifact_r27",
        name: "truth.html",
        format: "html",
        sourcePath: "/tmp/r27/truth.html",
        provenance: { kind: "workspace-source" },
        registeredSeq: 1,
      },
    ],
    revisions: [
      {
        revisionId: "revision_r27",
        artifactId: "artifact_r27",
        parentId: null,
        seq: 1,
        format: "html",
        entryPath: "truth.html",
        entryHash: "hash_r27",
        producer: { kind: "agent", id: "codex" },
        createdSeq: 1,
      },
    ],
    sessionArtifacts: [],
    intents: [],
    work: [],
    chat: [],
    events: [],
    lastSeq: 7,
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

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", origin);
  const asset = shellAssets[url.pathname as keyof typeof shellAssets];
  if (asset) {
    response.writeHead(200, { "content-type": asset.type });
    response.end(asset.body);
    return;
  }
  const revisionRoute = url.pathname.match(/^\/r\/([^/]+)\/$/);
  if (revisionRoute) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(artifactHtml(revisionRoute[1]));
    return;
  }
  if (url.pathname === "/bridge-fixture") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(bridgeFixtureHtml.replace("__ORIGIN__", origin));
    return;
  }
  if (url.pathname === "/api/v1/snapshot") {
    json(response, snapshot);
    return;
  }
  if (url.pathname === "/api/v1/session-context") {
    json(response, {
      artifactId: "artifact_r27",
      sessionId: "session_r27",
      agentId: "agent:codex",
    });
    return;
  }
  if (url.pathname === "/api/v1/presence") {
    json(response, { agents: presence });
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
    const command = JSON.parse(await requestBody(request)) as {
      commandId: string;
      idempotencyKey: string;
      type: string;
      payload: Record<string, unknown>;
    };
    commands.push(command);
    const failuresRemaining = commandFailures.get(command.type) ?? 0;
    if (failuresRemaining > 0) {
      commandFailures.set(command.type, failuresRemaining - 1);
      json(response, { status: "unavailable", message: "injected retryable failure" }, 503);
      return;
    }
    json(response, { status: "accepted", response: {} });
    return;
  }
  response.writeHead(404);
  response.end("not found");
}

async function openShell(page: Page): Promise<void> {
  await page.addInitScript(() => localStorage.clear());
  await page.goto(`${origin}/app`);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(page.locator("#viewer-body")).toHaveAttribute("aria-busy", "false");
  await expect(page.frameLocator("#viewer-frame").locator("#select-target")).toBeVisible();
}

async function revealCount(page: Page): Promise<number> {
  return page
    .frameLocator("#viewer-frame")
    .locator("body")
    .evaluate(() => (window as typeof window & { __revealCount: number }).__revealCount);
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    handleRequest(request, response).catch((error) =>
      json(response, { error: String(error) }, 500),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  for (const client of eventClients) client.end();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(() => {
  snapshot = baseSnapshot();
  presence = [];
  commands = [];
  commandFailures = new Map();
});

async function openBridgeSelectionPopover(page: Page, invokerSelector: string): Promise<void> {
  await page.locator(invokerSelector).focus();
  await page.locator("#selection-text").evaluate((node) => {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.locator("#selection-text").dispatchEvent("mouseup");
  await expect(page.locator("[data-tweakloop-selection-popover] textarea")).toBeFocused();
}

test("bridge selection popover Escape and Cancel restore current focus or fall back without stale context", async ({
  page,
}) => {
  await page.goto(`${origin}/bridge-fixture`);
  const invoker = "#selection-invoker";
  const popover = page.locator("[data-tweakloop-selection-popover]");

  await openBridgeSelectionPopover(page, invoker);
  await popover.locator("textarea").press("Escape");
  await expect(page.locator(invoker)).toBeFocused();
  await expect(popover).toBeHidden();

  await openBridgeSelectionPopover(page, invoker);
  await popover.getByRole("button", { name: "Add to review" }).focus();
  await popover.getByRole("button", { name: "Add to review" }).press("Escape");
  await expect(page.locator(invoker)).toBeFocused();

  await openBridgeSelectionPopover(page, invoker);
  await page.locator(invoker).evaluate((node) => {
    const replacement = node.cloneNode(true);
    node.replaceWith(replacement);
  });
  await popover.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#document-editor")).toBeFocused();
  await expect(page.locator(invoker)).not.toBeFocused();

  await openBridgeSelectionPopover(page, invoker);
  await popover.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(invoker)).toBeFocused();
  await expect(popover).toBeHidden();
});

test("Escape and neutral Cancel close every composer field and restore the exact shell invoker", async ({
  page,
}) => {
  await openShell(page);
  const frame = page.frameLocator("#viewer-frame");
  const viewer = page.getByTestId("viewer-frame");

  const openComposer = async () => {
    await frame.locator("#select-target").click();
    await expect(page.getByTestId("draft-form")).toBeVisible();
  };

  await openComposer();
  await page.getByTestId("draft-text").press("Escape");
  await expect(page.getByTestId("draft-form")).toBeHidden();
  await expect(viewer).toBeFocused();

  await openComposer();
  if (
    !(await page
      .locator(".advanced-intent")
      .evaluate((details) => (details as HTMLDetailsElement).open))
  ) {
    await page.locator(".advanced-intent summary").click();
  }
  await page.getByTestId("draft-intent-type").focus();
  await page.getByTestId("draft-intent-type").press("Escape");
  await expect(page.getByTestId("draft-form")).toBeHidden();
  await expect(viewer).toBeFocused();

  await openComposer();
  if (
    !(await page
      .locator(".advanced-intent")
      .evaluate((details) => (details as HTMLDetailsElement).open))
  ) {
    await page.locator(".advanced-intent summary").click();
  }
  await page.getByTestId("draft-intent-type").selectOption("add-constraint");
  await page.locator("#draft-rationale").focus();
  await page.locator("#draft-rationale").press("Escape");
  await expect(page.getByTestId("draft-form")).toBeHidden();
  await expect(viewer).toBeFocused();

  await openComposer();
  await page.getByTestId("draft-cancel").click();
  await expect(page.getByTestId("draft-form")).toBeHidden();
  await expect(viewer).toBeFocused();
  expect(commands).toEqual([]);
});

test("ordinary comments stay comment-only while explicit task tracking retries one stable operation and reuses accepted work", async ({
  page,
}) => {
  await openShell(page);
  const frame = page.frameLocator("#viewer-frame");
  await frame.locator("#select-target").click();
  await page.getByTestId("draft-text").fill("Keep this as a durable review comment.");
  await page.getByTestId("draft-send").click();
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    type: "review.submit-comments",
    payload: {
      artifactId: "artifact_r27",
      revisionId: "revision_r27",
      intents: [expect.objectContaining({ intentType: "comment" })],
    },
  });
  expect(commands[0]?.payload).not.toHaveProperty("workId");

  const untrackedIntent = intent("intent_track");
  snapshot.intents = [untrackedIntent];
  snapshot.work = [];
  commands = [];
  commandFailures.set("work.create-from-intents", 1);
  await openShell(page);
  await page.getByTestId("rail-tab-feedback").click();
  const untrackedCard = page
    .locator('[data-testid="intent-item"]')
    .filter({ hasText: "Comment intent_track" });
  const track = untrackedCard.getByTestId("comment-track");
  await expect(track).toHaveText("Track as task");
  await track.click();
  await expect.poll(() => commands.length).toBe(1);
  await expect(track).toBeEnabled();
  await track.click();
  await expect.poll(() => commands.length).toBe(2);
  await expect(page.locator("#flash")).toContainText("Comment tracked as a task");
  const [firstAttempt, retryAttempt] = commands;
  expect(firstAttempt).toMatchObject({
    type: "work.create-from-intents",
    payload: { intentIds: ["intent_track"] },
  });
  expect(retryAttempt).toMatchObject({ type: "work.create-from-intents" });
  expect(retryAttempt?.commandId).toBe(firstAttempt?.commandId);
  expect(retryAttempt?.idempotencyKey).toBe(firstAttempt?.idempotencyKey);
  expect(retryAttempt?.payload.workId).toBe(firstAttempt?.payload.workId);
  expect(retryAttempt?.payload.decisionId).toBe(firstAttempt?.payload.decisionId);

  const acceptedIntent = intent("intent_accepted", "addressed");
  snapshot.intents = [acceptedIntent];
  snapshot.work = [
    work("work_accepted", acceptedIntent.intentId, "addressed", "accepted", "agent:codex"),
  ];
  commands = [];
  await openShell(page);
  await page.getByTestId("rail-tab-feedback").click();
  await page.locator("#comment-history summary").click();
  const reopen = page.getByTestId("comment-reopen");
  await expect(reopen).toHaveText("Reopen task");
  await reopen.click();
  await expect.poll(() => commands.length).toBe(1);
  await expect(page.locator("#flash")).toContainText("Task reopened for another pass");
  expect(commands[0]).toMatchObject({
    type: "work.create-from-intents",
    payload: {
      workId: "work_accepted",
      intentIds: ["intent_accepted"],
    },
  });
  expect(commands).not.toContainEqual(expect.objectContaining({ type: "decision.reopen" }));
});

test("card bodies locate while nested controls and text selection stay isolated; receipts stay compact and named", async ({
  page,
}) => {
  const openIntent = intent("intent_open");
  const resolvedIntent = intent("intent_resolved", "addressed");
  const taskIntent = intent("intent_task");
  snapshot.intents = [openIntent, resolvedIntent, taskIntent];
  snapshot.work = [
    work("work_resolved", resolvedIntent.intentId, "addressed", "accepted", "agent:codex"),
    work("work_task", taskIntent.intentId, "open", "pending", "agent:codex"),
  ];
  const offered = {
    status: "offered" as const,
    attemptId: "attempt_offered",
    attemptNumber: 2,
    agentId: "agent:codex",
    offeredAt: recordedAt,
    acknowledgedAt: null,
    pausedAt: null,
    pauseReason: null,
  };
  snapshot.chat = [
    chatMessage("saved", null, 4),
    chatMessage("offered", offered, 5),
    chatMessage(
      "acknowledged",
      { ...offered, status: "acknowledged", acknowledgedAt: recordedAt },
      6,
    ),
  ];
  await openShell(page);

  await page.getByTestId("rail-tab-feedback").click();
  const commentSurface = page
    .locator('#intent-list [data-testid="intent-item"]')
    .filter({ hasText: "Comment intent_open" });
  await expect(commentSurface).toHaveAttribute("role", "button");
  await expect(commentSurface.locator('button[aria-label*="Locate comment target"]')).toHaveCount(
    0,
  );
  await commentSurface.click();
  await expect.poll(() => revealCount(page)).toBe(1);
  await commentSurface.focus();
  await commentSurface.press("Enter");
  await expect.poll(() => revealCount(page)).toBe(2);

  await page.locator("#comment-history summary").click();
  await page.getByTestId("comment-reopen").click();
  await expect.poll(() => revealCount(page)).toBe(2);
  await expect(page.locator("#flash")).toContainText("Task reopened for another pass");
  expect(commands.at(-1)?.type).toBe("work.create-from-intents");
  expect(commands.at(-1)?.payload.workId).toBe("work_resolved");

  await commentSurface.evaluate((surface) => {
    const body = surface.querySelector(".body");
    if (!body) throw new Error("comment body missing");
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    body.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await expect.poll(() => revealCount(page)).toBe(2);

  await commentSurface.evaluate((surface) => {
    const link = document.createElement("a");
    link.href = "#nested-control";
    link.textContent = "Nested reference";
    surface.append(link);
    link.click();
  });
  await expect.poll(() => revealCount(page)).toBe(2);

  await page.getByTestId("rail-tab-work").click();
  const taskSurface = page.locator('[data-work-id="work_task"] [data-testid="task-item"]');
  await expect(taskSurface).toHaveJSProperty("tagName", "BUTTON");
  await expect(taskSurface.locator('button[aria-label*="Locate task target"]')).toHaveCount(0);
  await taskSurface.focus();
  await taskSurface.press("Space");
  await expect.poll(() => revealCount(page)).toBe(3);
  await taskSurface.evaluate((button) => {
    const label = button.querySelector(".task-label");
    if (!label) throw new Error("task label missing");
    const range = document.createRange();
    range.selectNodeContents(label);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    label.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
  });
  await expect.poll(() => revealCount(page)).toBe(3);

  await page.getByTestId("rail-tab-chat").click();
  const saved = page.locator('[data-message-id="saved"] [data-testid="chat-delivery"]');
  const offeredReceipt = page.locator('[data-message-id="offered"] [data-testid="chat-delivery"]');
  const acknowledged = page.locator(
    '[data-message-id="acknowledged"] [data-testid="chat-delivery"]',
  );
  await expect(saved).toHaveAttribute("aria-label", "Saved in Tweakloop");
  await expect(saved).toHaveAttribute("aria-description", `Saved in Tweakloop at ${recordedAt}`);
  await expect(offeredReceipt).toHaveAttribute("aria-label", "Offered to agent runner, attempt 2");
  await expect(offeredReceipt).toHaveAttribute(
    "aria-description",
    `Offered to agent runner at ${recordedAt}; attempt 2`,
  );
  await expect(acknowledged).toHaveAttribute("aria-label", "Acknowledged by Codex");
  await expect(acknowledged).toHaveAttribute("aria-description", /attempt 2/);
  await expect(page.getByRole("status", { name: "Saved in Tweakloop" })).toBeVisible();
  await expect(page.getByRole("status", { name: "Acknowledged by Codex" })).toBeVisible();
  await expect(acknowledged.locator(".chat-delivery-checks")).toHaveText("✓✓");
  const receiptGeometry = await page.evaluate(() =>
    ["saved", "offered", "acknowledged"].map((id) => {
      const receipt = document.querySelector(
        `[data-message-id="${id}"] [data-testid="chat-delivery"]`,
      );
      if (!(receipt instanceof HTMLElement)) throw new Error(`missing ${id} receipt`);
      return {
        id,
        width: receipt.getBoundingClientRect().width,
        fontSize: getComputedStyle(receipt).fontSize,
        after: getComputedStyle(receipt, "::after").content,
      };
    }),
  );
  expect(receiptGeometry.every(({ width }) => width <= 24)).toBe(true);
  expect(receiptGeometry.every(({ fontSize }) => fontSize === "0px")).toBe(true);
  expect(receiptGeometry.find(({ id }) => id === "saved")?.after).toBe('"✓"');
  expect(receiptGeometry.find(({ id }) => id === "offered")?.after).toBe('"✓✓"');
});

test("card navigation opens its exact immutable revision and rejects a missing revision instead of a neighbor", async ({
  page,
}) => {
  snapshot.revisions.push({
    revisionId: "revision_r28",
    artifactId: "artifact_r27",
    parentId: null,
    seq: 2,
    format: "html",
    entryPath: "truth.html",
    entryHash: "hash_r28",
    producer: { kind: "agent", id: "codex" },
    createdSeq: 8,
  });
  snapshot.intents = [intent("intent_revision_one")];

  await openShell(page);
  await expect(page.frameLocator("#viewer-frame").locator("body")).toHaveAttribute(
    "data-revision-id",
    "revision_r28",
  );
  await page.getByTestId("rail-tab-feedback").click();
  await page.getByTestId("intent-item").click();
  await expect(page.getByTestId("revision-select")).toHaveValue("revision_r27");
  await expect(page.frameLocator("#viewer-frame").locator("body")).toHaveAttribute(
    "data-revision-id",
    "revision_r27",
  );
  await expect.poll(() => revealCount(page)).toBe(1);

  const missingRevisionIntent = intent("intent_missing_revision");
  missingRevisionIntent.revisionId = "revision_missing";
  snapshot.intents = [missingRevisionIntent];
  await openShell(page);
  await expect(page.frameLocator("#viewer-frame").locator("body")).toHaveAttribute(
    "data-revision-id",
    "revision_r28",
  );
  await page.getByTestId("rail-tab-feedback").click();
  await page.getByTestId("intent-item").click();
  await expect(page.locator("#viewer-flash")).toContainText(
    "exact artifact revision is no longer available",
  );
  await expect(page.getByTestId("revision-select")).toHaveValue("revision_r28");
  await expect(page.frameLocator("#viewer-frame").locator("body")).toHaveAttribute(
    "data-revision-id",
    "revision_r28",
  );
  await expect.poll(() => revealCount(page)).toBe(0);
});

test("durable acknowledgement and claimed work stay distinct from live presence", async ({
  page,
}) => {
  await page.clock.install({ time: progressBoundaryNow });
  const offered = {
    status: "offered" as const,
    attemptId: "attempt_activity",
    attemptNumber: 1,
    agentId: "agent:codex",
    offeredAt: recordedAt,
    acknowledgedAt: null,
    pausedAt: null,
    pauseReason: null,
  };
  snapshot.chat = [
    chatMessage(
      "recent-codex-ack",
      { ...offered, status: "acknowledged", acknowledgedAt: recordedAt },
      6,
    ),
    {
      ...chatMessage(
        "newer-wrong-agent-ack",
        {
          ...offered,
          status: "acknowledged",
          agentId: "agent:claude",
          acknowledgedAt: recordedAt,
        },
        7,
      ),
      recipientAgentId: "agent:claude",
    },
  ];

  await openShell(page);
  const status = page.locator("#agent-status");
  await expect(status).toHaveText("Acknowledged recently");
  await expect(status).toHaveAttribute("data-activity-state", "acknowledged-recently");
  await expect(status).toHaveAttribute(
    "aria-label",
    /Codex acknowledged a message recently.*Live presence is unavailable/i,
  );
  await expect(status).not.toHaveText("Available");
  await expect(status).not.toHaveText("Working");

  await page.clock.fastForward(5 * 60 * 1000 + 1);
  await expect(status).toHaveText("Assigned · offline");
  await expect(status).toHaveAttribute("data-activity-state", "offline");

  const claimedIntent = intent("intent_claimed");
  snapshot.intents = [claimedIntent];
  snapshot.work = [
    work("work_claimed", claimedIntent.intentId, "claimed", "pending", "agent:codex"),
  ];
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(status).toHaveText("Claimed");
  await expect(status).toHaveAttribute("data-activity-state", "claimed-work");
  await expect(status).toHaveAttribute(
    "aria-label",
    /Codex owns claimed work.*Live presence is unavailable/i,
  );
  await expect(page.locator("#taskbar-current")).toContainText("Claimed · codex");
  await expect(page.locator("#taskbar-current .task-spinner")).toHaveCount(0);
  await expect(page.getByTestId("document-item").first()).toHaveAttribute(
    "aria-label",
    /1 claimed/,
  );
  await expect(page.getByTestId("document-item").first().locator(".task-spinner")).toHaveCount(0);
  await page.getByTestId("rail-tab-work").click();
  await expect(page.getByTestId("work-status")).toContainText("Work · claimed · Codex");
  await expect(page.getByTestId("work-item").locator(".task-spinner")).toHaveCount(0);

  presence = [{ agentId: "agent:codex", state: "working" }];
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(status).toHaveText("Working");
  await expect(status).toHaveAttribute("data-activity-state", "live");
  await expect(page.locator("#taskbar-current")).toContainText("Working · codex");
  await expect(page.locator("#taskbar-current .task-spinner")).toHaveCount(1);
  await expect(page.getByTestId("document-item").first()).toHaveAttribute(
    "aria-label",
    /1 working/,
  );
  await expect(page.getByTestId("document-item").first().locator(".task-spinner")).toHaveCount(1);
  await expect(page.getByTestId("work-status")).toContainText("Work · claimed · Codex");
  await expect(page.getByTestId("work-item").locator(".task-spinner")).toHaveCount(1);

  presence = [{ agentId: "agent:codex", state: "thinking" }];
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(status).toHaveText("Thinking");
  await expect(status).toHaveAttribute("data-activity-state", "live");
  await expect(page.locator("#taskbar-current")).toContainText("Thinking · codex");
  await expect(page.locator("#taskbar-current .task-spinner")).toHaveCount(0);
  await expect(page.getByTestId("document-item").first()).toHaveAttribute(
    "aria-label",
    /1 claimed/,
  );
  await expect(page.getByTestId("document-item").first().locator(".task-spinner")).toHaveCount(0);

  presence = [];
  snapshot.work = [];
  snapshot.chat = [
    chatMessage(
      "old-codex-ack",
      { ...offered, status: "acknowledged", acknowledgedAt: oldProgressAt },
      8,
    ),
  ];
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(status).toHaveText("Assigned · offline");
  await expect(status).toHaveAttribute("data-activity-state", "offline");
});

test("legal work, decision, progress, and presence axes render independently at 320px and 200%", async ({
  page,
}) => {
  await page.addInitScript((now) => {
    Date.now = () => now;
  }, progressBoundaryNow);
  const legalPairs: Array<[Work["status"], Work["decision"]]> = [
    ["open", "pending"],
    ["open", "reopened"],
    ["claimed", "pending"],
    ["claimed", "reopened"],
    ["addressed", "pending"],
    ["addressed", "accepted"],
  ];
  let sequence = 10;
  const progressExpectations = new Map<string, { seq: number; recordedAt: string }>();
  for (const [status, decision] of legalPairs) {
    for (const progressState of ["none", "recent", "old"] as const) {
      for (const presenceState of ["live", "expired"] as const) {
        const id = `${status}-${decision}-${progressState}-${presenceState}`;
        const intentId = `intent-${id}`;
        const agentId = `agent:${id}`;
        snapshot.intents.push(intent(intentId, status === "addressed" ? "addressed" : "submitted"));
        snapshot.work.push(
          work(
            `work-${id}`,
            intentId,
            status,
            decision,
            agentId,
            progressState !== "none"
              ? [
                  {
                    summary: `Validated ${id}`,
                    revisionId: null,
                    agentId,
                    addressedIntentIds: [intentId],
                    seq: sequence,
                    recordedAt: progressState === "recent" ? recentProgressAt : oldProgressAt,
                  },
                ]
              : [],
          ),
        );
        if (progressState !== "none") {
          progressExpectations.set(id, {
            seq: sequence,
            recordedAt: progressState === "recent" ? recentProgressAt : oldProgressAt,
          });
        }
        if (presenceState === "live") presence.push({ agentId, state: "thinking" });
        else presence.push({ agentId, state: "expired", expiresAt: "2026-08-08T11:59:00.000Z" });
        sequence += 1;
      }
    }
  }
  const impossiblePairs: Array<[Work["status"], Work["decision"]]> = [
    ["open", "accepted"],
    ["claimed", "accepted"],
    ["addressed", "reopened"],
  ];
  for (const [status, decision] of impossiblePairs) {
    const id = `invalid-${status}-${decision}`;
    const intentId = `intent-${id}`;
    snapshot.intents.push(intent(intentId, status === "addressed" ? "addressed" : "submitted"));
    snapshot.work.push(work(`work-${id}`, intentId, status, decision));
  }
  snapshot.lastSeq = sequence;
  await page.setViewportSize({ width: 320, height: 720 });
  await openShell(page);
  if (!(await page.getByTestId("rail-tab-work").isVisible())) {
    await page.locator("#agent-sheet-toggle").click();
  }
  await page.getByTestId("rail-tab-work").click();

  for (const [status, decision] of legalPairs) {
    for (const progressState of ["none", "recent", "old"] as const) {
      for (const presenceState of ["live", "expired"] as const) {
        const id = `${status}-${decision}-${progressState}-${presenceState}`;
        const card = page.locator(`[data-work-id="work-${id}"]`);
        await expect(card).toHaveAttribute("data-work-status", status);
        await expect(card).toHaveAttribute("data-decision-status", decision);
        await expect(card).toHaveAttribute("data-progress-state", progressState);
        await expect(card).toHaveAttribute(
          "data-presence-state",
          presenceState === "live" ? "live" : "unavailable",
        );
        await expect(card).toHaveAttribute("data-invalid-state", "false");
        await expect(card.getByTestId("work-status")).toHaveAttribute(
          "aria-label",
          new RegExp(`Work status: ${status}`),
        );
        await expect(card.getByTestId("work-decision")).toHaveAttribute(
          "aria-label",
          `Human decision: ${decision}`,
        );
        await expect(card.getByTestId("work-progress")).toContainText(
          progressState !== "none" ? `Validated ${id}` : "No durable progress recorded",
        );
        if (progressState !== "none") {
          const expected = progressExpectations.get(id);
          if (!expected) throw new Error(`missing progress expectation for ${id}`);
          await expect(card.getByTestId("work-progress")).toContainText(`By ${id}`);
          await expect(card.getByTestId("work-progress")).toContainText("⌖ section.truth");
          await expect(card.getByTestId("work-progress")).toContainText(`event #${expected.seq}`);
          await expect(card.getByTestId("work-progress")).toContainText(expected.recordedAt);
          await expect(card.getByTestId("work-progress")).toHaveAttribute(
            "data-progress-window-ms",
            String(5 * 60 * 1000),
          );
          await expect(card.getByTestId("work-progress-age")).toHaveText(
            progressState === "recent" ? "Recent · ≤5m" : "Old · >5m",
          );
        }
        if (presenceState === "expired") {
          await expect(card.getByTestId("work-presence")).toContainText("unavailable");
        }
        await expect(card.locator(".task-spinner")).toHaveCount(0);
        if (decision === "accepted") await expect(card.locator(".task-spinner")).toHaveCount(0);
      }
    }
  }

  for (const [status, decision] of impossiblePairs) {
    const card = page.locator(`[data-work-id="work-invalid-${status}-${decision}"]`);
    await expect(card).toHaveAttribute("data-invalid-state", "true");
    await expect(card.locator(".work-state-error")).toContainText("not a legal");
    await expect(card.getByTestId("work-status")).toHaveText("Work · unavailable");
    await expect(card.getByTestId("work-status")).toHaveAttribute(
      "aria-label",
      `Work status unavailable: ${status}/${decision} is not a legal pair`,
    );
    await expect(card).not.toContainText("Working");
    await expect(card.locator(".task-spinner")).toHaveCount(0);
  }

  const formerlyLiveOpen = page.locator('[data-work-id="work-open-pending-none-live"]');
  await expect(formerlyLiveOpen).toHaveAttribute("data-presence-state", "live");
  await page.route("**/api/v1/presence", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await expect(formerlyLiveOpen).toHaveAttribute("data-presence-state", "unavailable", {
    timeout: 5_000,
  });
  await expect(formerlyLiveOpen.locator(".task-spinner")).toHaveCount(0);
  await page.unroute("**/api/v1/presence");

  const staleProgressLivePresence = page.locator('[data-work-id="work-open-pending-old-live"]');
  await expect(staleProgressLivePresence).toHaveAttribute("data-progress-state", "old");
  await expect(staleProgressLivePresence).toHaveAttribute("data-presence-state", "live");
  await expect(staleProgressLivePresence.getByTestId("work-progress-age")).toHaveText("Old · >5m");
  await expect(staleProgressLivePresence.getByTestId("work-presence")).toContainText("thinking");
  await expect(staleProgressLivePresence).not.toContainText("Working");

  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await page.setViewportSize({ width: 900, height: 800 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
  await expect.poll(() => page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(2);
  const zoomedCard = page.locator('[data-work-id="work-addressed-accepted-recent-expired"]');
  await expect(zoomedCard).toBeVisible();
  await expect(zoomedCard.getByTestId("task-item")).toHaveJSProperty("tagName", "BUTTON");
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
  await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
});
