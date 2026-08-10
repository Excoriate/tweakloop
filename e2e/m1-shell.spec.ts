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

type Delivery = null | {
  status: "offered" | "acknowledged" | "paused";
  attemptId: string | null;
  attemptNumber: number;
  agentId: string | null;
  offeredAt: string | null;
  acknowledgedAt: string | null;
  pausedAt: string | null;
  pauseReason: "retry-budget-exhausted" | null;
};

type ChatMessage = {
  messageId: string;
  artifactId: null;
  author: string;
  text: string;
  createdSeq: number;
  recordedAt: string;
  sessionId: string;
  context: null;
  references: never[];
  attachments: never[];
  delivery: Delivery;
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
  payload: Record<string, unknown>;
};

const recordedAt = "2026-08-07T12:00:00.000Z";
let server: Server;
let origin: string;
let snapshot: Snapshot;
let sessionContext: { artifactId: null; sessionId: string; agentId: string };
let presence: Array<{ agentId: string; state: string }>;
let commands: BrowserCommand[];
const eventClients = new Set<ServerResponse>();

function message(
  messageId: string,
  author: string,
  text: string,
  createdSeq: number,
  delivery: Delivery = null,
): ChatMessage {
  return {
    messageId,
    artifactId: null,
    author,
    text,
    createdSeq,
    recordedAt,
    sessionId: "session_m1_shell",
    context: null,
    references: [],
    attachments: [],
    delivery,
  };
}

function emptySnapshot(chat: ChatMessage[] = []): Snapshot {
  return {
    workspace: {
      workspaceId: "workspace_m1_shell",
      projectId: "project_m1_shell",
      rootPath: "/tmp/m1-shell",
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
    const command = JSON.parse(await requestBody(request)) as BrowserCommand;
    commands.push(command);
    if (command.type === "chat.delivery-resume") {
      snapshot = {
        ...snapshot,
        chat: snapshot.chat.map((item) =>
          item.messageId === command.payload.messageId ? { ...item, delivery: null } : item,
        ),
        lastSeq: snapshot.lastSeq + 1,
      };
    }
    json(response, { status: "accepted", response: {} });
    return;
  }
  response.writeHead(404);
  response.end("not found");
}

function broadcastSnapshotChange(): void {
  const data = JSON.stringify({
    protocol: "tweakloop.event/v1",
    eventId: `event_${snapshot.lastSeq}`,
    seq: snapshot.lastSeq,
    type: "chat.delivery-acknowledged",
    payload: {},
  });
  for (const client of eventClients) client.write(`data: ${data}\n\n`);
}

async function openShell(page: Page): Promise<void> {
  await page.goto(`${origin}/app`);
  await expect(page.getByTestId("connection")).toHaveText("synced");
}

function parseRgb(color: string): [number, number, number] {
  const channels = color
    .match(/[\d.]+/g)
    ?.slice(0, 3)
    .map(Number);
  if (channels?.length !== 3) throw new Error(`Expected rgb color, received ${color}`);
  return channels.map((channel) => (color.startsWith("color(srgb ") ? channel * 255 : channel)) as [
    number,
    number,
    number,
  ];
}

function relativeLuminance(color: string): number {
  const channels = parseRgb(color).map((channel) => channel / 255);
  const linear = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}

function contrastRatio(first: string, second: string): number {
  const values = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

async function themeEvidence(page: Page) {
  return page.evaluate(() => {
    const style = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      return getComputedStyle(element);
    };
    const body = style("body");
    const toolbar = style(".toolbar");
    const action = style("#chat-send");
    return {
      bodyBackground: body.backgroundColor,
      bodyText: body.color,
      toolbarBackground: toolbar.backgroundColor,
      actionBackground: action.backgroundColor,
      actionText: action.color,
      surfaces: [
        body.backgroundColor,
        style(".side-pane").backgroundColor,
        style(".viewer-body").backgroundColor,
      ],
      flat: [".toolbar", ".side-pane", ".viewer-body", ".chat-section", ".start-surface"].map(
        (selector) => {
          const computed = style(selector);
          return {
            backgroundImage: computed.backgroundImage,
            backdropFilter: computed.backdropFilter,
            boxShadow: computed.boxShadow,
          };
        },
      ),
      overflows: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

test.beforeAll(async () => {
  server = createServer((request, response) => {
    handleRequest(request, response).catch((error) =>
      json(response, { error: String(error) }, 500),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
  for (const client of eventClients) client.end();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test.beforeEach(() => {
  snapshot = emptySnapshot();
  sessionContext = {
    artifactId: null,
    sessionId: "session_m1_shell",
    agentId: "agent:codex",
  };
  presence = [];
  commands = [];
});

test("defaults to light under dark OS and keeps both flat themes accessible at wide and narrow sizes", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript(() => localStorage.clear());
  await page.setViewportSize({ width: 1280, height: 820 });
  await openShell(page);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("theme-toggle")).toHaveAttribute("aria-pressed", "false");
  const lightWide = await themeEvidence(page);
  expect(lightWide.flat).toEqual(
    lightWide.flat.map(() => ({
      backgroundImage: "none",
      backdropFilter: "none",
      boxShadow: "none",
    })),
  );
  expect(lightWide.overflows).toBe(false);
  expect(contrastRatio(lightWide.bodyText, lightWide.bodyBackground)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(lightWide.actionText, lightWide.actionBackground)).toBeGreaterThanOrEqual(
    4.5,
  );

  const toggle = page.getByTestId("theme-toggle");
  await toggle.focus();
  await toggle.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const darkWide = await themeEvidence(page);
  expect(new Set(darkWide.surfaces).size).toBe(3);
  expect(contrastRatio(darkWide.bodyText, darkWide.bodyBackground)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio(darkWide.actionText, darkWide.actionBackground)).toBeGreaterThanOrEqual(4.5);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#agent-sheet-toggle").click();
  await expect(page.locator("#agent-rail")).toHaveClass(/sheet-open/);
  const darkNarrow = await themeEvidence(page);
  expect(darkNarrow.overflows).toBe(false);
  await toggle.focus();
  await toggle.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const lightNarrow = await themeEvidence(page);
  expect(lightNarrow.overflows).toBe(false);
  expect(await page.evaluate(() => location.hash)).toBe("");
  expect(commands).toEqual([]);
  expect(snapshot.lastSeq).toBe(7);
  const transitionDurationMs = await page.evaluate(() => {
    const duration = getComputedStyle(document.body).transitionDuration;
    return Number.parseFloat(duration) * (duration.endsWith("ms") ? 1 : 1000);
  });
  expect(transitionDurationMs).toBeLessThanOrEqual(0.01);

  const css = readFileSync(`${shellRoot}shell.css`, "utf8");
  expect(css).not.toMatch(/(?:linear|radial)-gradient|backdrop-filter\s*:/);
  expect([...css.matchAll(/box-shadow\s*:\s*([^;]+);/g)].map((match) => match[1].trim())).toEqual([
    "none",
    "none",
  ]);
});

test("switches both chat body foregrounds before dark card backgrounds can strand light-theme text", async ({
  page,
}) => {
  const acknowledged: Delivery = {
    status: "acknowledged",
    attemptId: "attempt_theme",
    attemptNumber: 1,
    agentId: "agent:codex",
    offeredAt: recordedAt,
    acknowledgedAt: recordedAt,
    pausedAt: null,
    pauseReason: null,
  };
  snapshot = emptySnapshot([
    message("theme-human", "human:browser", "Human theme probe", 1, acknowledged),
    message("theme-agent", "agent:codex", "Agent theme probe", 2),
  ]);
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
  await page.addInitScript(() => localStorage.clear());
  await openShell(page);
  await page.getByTestId("rail-tab-chat").click();

  const samples = await page.evaluate(async () => {
    const computed = (selector: string) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
      return getComputedStyle(element);
    };
    const sample = () => ({
      bodyText: computed("body").color,
      human: {
        text: computed('[data-message-id="theme-human"] .chat-bubble .body').color,
        background: computed('[data-message-id="theme-human"] .chat-bubble').backgroundColor,
      },
      agent: {
        text: computed('[data-message-id="theme-agent"] .chat-bubble .body').color,
        background: computed('[data-message-id="theme-agent"] .chat-bubble').backgroundColor,
      },
      humanAuthor: computed('[data-message-id="theme-human"] .chat-author').color,
      agentAuthor: computed('[data-message-id="theme-agent"] .chat-author').color,
      acknowledgment: computed('[data-message-id="theme-human"] .chat-delivery').color,
    });

    const light = sample();
    const toggle = document.querySelector('[data-testid="theme-toggle"]');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error("Missing theme toggle");
    toggle.click();
    const immediate = sample();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const early = sample();
    await new Promise((resolve) => setTimeout(resolve, 220));
    const settled = sample();
    return { light, immediate, early, settled };
  });

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(samples.light.human.text).not.toBe(samples.settled.human.text);
  for (const sample of [samples.immediate, samples.early, samples.settled]) {
    expect(sample.human.text).toBe(samples.settled.human.text);
    expect(sample.agent.text).toBe(samples.settled.agent.text);
    expect(contrastRatio(sample.human.text, sample.human.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(sample.agent.text, sample.agent.background)).toBeGreaterThanOrEqual(4.5);
  }
  expect(relativeLuminance(samples.settled.human.text)).toBeLessThan(
    relativeLuminance(samples.settled.bodyText),
  );
  expect(samples.settled.humanAuthor).not.toBe(samples.settled.human.text);
  expect(samples.settled.agentAuthor).not.toBe(samples.settled.agent.text);
  expect(samples.settled.humanAuthor).not.toBe(samples.settled.agentAuthor);
  expect(samples.settled.acknowledgment).toBe(samples.settled.humanAuthor);
  expect(samples.settled.acknowledgment).not.toBe(samples.settled.agentAuthor);
});

test("resolves exact profiles, preserves raw near-name fallbacks, and never relabels history on handoff", async ({
  page,
}) => {
  snapshot = emptySnapshot([
    message("claude", "agent:Claude_Code", "Claude message", 1),
    message("codex", "agent:openai-codex", "Codex message", 2),
    message("grok", "agent:xai:grok", "Grok message", 3),
    message("cursor", "agent:cursor-agent", "Cursor message", 4),
    message("cursorless", "agent:cursorless", "Near cursor", 5),
    message("grokking", "agent:grokking", "Near grok", 6),
    message("fallback", "agent:Zed Alpha", "Unknown agent", 7),
  ]);
  sessionContext.agentId = "agent:openai-codex";
  await openShell(page);

  await expect(page.locator("#agent-name")).toHaveText("Codex");
  await expect(page.getByTestId("agent-header-mark")).toHaveAttribute(
    "data-agent-profile",
    "codex",
  );
  await expect(page.getByTestId("agent-header-mark")).toHaveText("CD");
  await expect(page.locator(".chat-author")).toHaveText([
    "Claude Code",
    "Codex",
    "Grok",
    "Cursor",
    "cursorless",
    "grokking",
    "Zed Alpha",
  ]);
  expect(
    await page
      .locator(".chat-avatar")
      .evaluateAll((avatars) => avatars.map((avatar) => avatar.dataset.agentProfile)),
  ).toEqual(["claude-code", "codex", "grok", "cursor", "custom", "custom", "custom"]);
  const fallbackMark = await page
    .locator('[data-message-id="fallback"] .chat-avatar')
    .textContent();
  expect(fallbackMark).toBe("ZA");

  sessionContext.agentId = "agent:cursor";
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(page.locator("#agent-name")).toHaveText("Cursor");
  await expect(page.getByTestId("agent-sheet-mark")).toHaveAttribute(
    "data-agent-profile",
    "cursor",
  );
  await expect(page.locator(".chat-author")).toHaveText([
    "Claude Code",
    "Codex",
    "Grok",
    "Cursor",
    "cursorless",
    "grokking",
    "Zed Alpha",
  ]);
  await expect(page.locator('[data-message-id="fallback"] .chat-avatar')).toHaveText("ZA");
});

test("renders only frozen delivery facts, preserves transcript nodes, and retries with the human resume command", async ({
  page,
}) => {
  const offered: Delivery = {
    status: "offered",
    attemptId: "attempt_offered",
    attemptNumber: 2,
    agentId: "agent:codex",
    offeredAt: recordedAt,
    acknowledgedAt: null,
    pausedAt: null,
    pauseReason: null,
  };
  const acknowledged: Delivery = {
    ...offered,
    status: "acknowledged",
    attemptId: "attempt_acknowledged",
    agentId: "agent:claude-code",
    acknowledgedAt: recordedAt,
  };
  const paused: Delivery = {
    ...offered,
    status: "paused",
    attemptId: "attempt_paused",
    attemptNumber: 5,
    agentId: "agent:codex",
    pausedAt: recordedAt,
    pauseReason: "retry-budget-exhausted",
  };
  snapshot = emptySnapshot([
    message("saved", "human:browser", "Saved message", 1),
    message("offered", "human:browser", "Offered message", 2, offered),
    message("acknowledged", "human:browser", "Acknowledged message", 3, acknowledged),
    message("paused", "human:browser", "Paused message", 4, paused),
    message("agent-reply", "agent:grok", "Agent message", 5),
  ]);
  presence = [{ agentId: "agent:codex", state: "listening" }];
  await openShell(page);

  const receipts = page.getByTestId("chat-delivery");
  await expect(receipts).toHaveText([
    "Saved",
    "Offered to agent runner",
    "Acknowledged by Claude Code✓✓",
    "Delivery paused after 5 attemptsRetry budget exhaustedRetry",
    "Agent reply",
  ]);
  await expect(page.locator('[data-message-id="acknowledged"] .chat-delivery-checks')).toHaveText(
    "✓✓",
  );
  await expect(page.locator('[data-message-id="paused"] .chat-delivery-cause')).toHaveText(
    "Retry budget exhausted",
  );
  expect((await receipts.allTextContents()).join(" ")).not.toMatch(
    /delivered|\bread\b|understood|completed/i,
  );

  await page.locator('[data-message-id="offered"]').evaluate((item) => {
    item.setAttribute("data-node-probe", "preserved");
  });
  snapshot = {
    ...snapshot,
    chat: snapshot.chat.map((item) =>
      item.messageId === "offered"
        ? {
            ...item,
            delivery: {
              ...offered,
              status: "acknowledged",
              acknowledgedAt: "2026-08-07T12:01:00.000Z",
            },
          }
        : item,
    ),
    lastSeq: snapshot.lastSeq + 1,
  };
  broadcastSnapshotChange();
  await expect(page.locator('[data-message-id="offered"] .chat-delivery')).toContainText(
    "Acknowledged by Codex",
  );
  await expect(page.locator('[data-message-id="offered"]')).toHaveAttribute(
    "data-node-probe",
    "preserved",
  );

  const retry = page.locator('[data-message-id="paused"] [data-testid="chat-delivery-retry"]');
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press("Enter");
  await expect(page.locator('[data-message-id="paused"] .chat-delivery')).toHaveText("Saved");
  expect(commands).toHaveLength(1);
  expect(commands[0]).toMatchObject({
    protocol: "tweakloop.command/v1",
    workspaceId: "workspace_m1_shell",
    actor: { kind: "human", id: "browser" },
    type: "chat.delivery-resume",
    payload: { messageId: "paused" },
  });
  expect(commands[0].payload.resumedAt).toEqual(expect.any(String));
  expect(commands[0].type).not.toContain("ack");
});
