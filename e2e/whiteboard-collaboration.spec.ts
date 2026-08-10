import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));

const EMPTY_BOARD = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://tweakloop.local",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

type OpenReceipt = {
  artifactId: string;
  revisionId: string;
  sessionId: string;
  seq: number;
  url: string;
};

type DraftReceipt = {
  artifactId: string;
  baseRevisionId: string;
  draftId: string;
  draftVersion: number;
  sceneHash: string;
  updatedBy: { kind: string; id: string };
};

type ExcalidrawElement = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  versionNonce: number;
  isDeleted?: boolean;
  [key: string]: unknown;
};

type ExcalidrawScene = {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

type BrowserBoard = {
  getScene(): ExcalidrawScene;
  getViewportState(): {
    scrollX: number;
    scrollY: number;
    zoom: number;
    offsetLeft: number;
    offsetTop: number;
  };
};

declare global {
  interface Window {
    __TWEAKLOOP_WHITEBOARDS__?: Map<string, BrowserBoard>;
  }
}

let stateDir: string;
let workspaceDir: string;
let env: NodeJS.ProcessEnv;

function tweak(args: string[]): string {
  return execFileSync(process.execPath, [cli, "--workspace", workspaceDir, ...args], {
    env,
    encoding: "utf8",
  });
}

type DurableEvent = {
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
};

function durableEvents(after = 0): DurableEvent[] {
  return JSON.parse(tweak(["--json", "events", "list", "--after", String(after)]))
    .events as DurableEvent[];
}

function readScene(path: string): ExcalidrawScene {
  return JSON.parse(readFileSync(path, "utf8")) as ExcalidrawScene;
}

async function allowOnlyLoopback(page: Page): Promise<void> {
  const routeHttp = async (
    route: Parameters<Page["route"]>[1] extends (route: infer T) => unknown ? T : never,
  ) => {
    const url = new URL(route.request().url());
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
      await route.continue();
      return;
    }
    await route.abort("blockedbyclient");
  };
  await page.route("http://**/*", routeHttp);
  await page.route("https://**/*", routeHttp);
}

async function boardScene(page: Page): Promise<ExcalidrawScene> {
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  return frame.locator("body").evaluate(() => {
    const board = window.__TWEAKLOOP_WHITEBOARDS__?.get("whiteboard.canvas");
    if (!board) throw new Error("standalone whiteboard adapter is not registered");
    return board.getScene();
  });
}

async function boardViewportState(
  page: Page,
): Promise<ReturnType<BrowserBoard["getViewportState"]>> {
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  return frame.locator("body").evaluate(() => {
    const board = window.__TWEAKLOOP_WHITEBOARDS__?.get("whiteboard.canvas");
    if (!board) throw new Error("standalone whiteboard adapter is not registered");
    return board.getViewportState();
  });
}

async function semanticViewportVisibility(page: Page): Promise<{
  viewport: { width: number; height: number };
  camera: { scrollX: number; scrollY: number; zoom: number; offsetLeft: number; offsetTop: number };
  elements: Array<{
    semanticKey: string;
    role: string;
    left: number;
    top: number;
    right: number;
    bottom: number;
    fullyVisible: boolean;
  }>;
}> {
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  return frame.locator(".excalidraw").evaluate((viewport) => {
    const board = window.__TWEAKLOOP_WHITEBOARDS__?.get("whiteboard.canvas");
    const scene = board?.getScene();
    if (!scene || !board) throw new Error("standalone whiteboard scene is unavailable");
    const camera = board.getViewportState();
    const zoom = Number(camera.zoom ?? 1);
    const scrollX = Number(camera.scrollX ?? 0);
    const scrollY = Number(camera.scrollY ?? 0);
    const offsetLeft = Number(camera.offsetLeft ?? 0);
    const offsetTop = Number(camera.offsetTop ?? 0);
    const viewportRect = viewport.getBoundingClientRect();
    const relevant = scene.elements.filter((element) => {
      if (element.isDeleted) return false;
      const role = (element.customData as { tweakloop?: { role?: unknown } } | undefined)?.tweakloop
        ?.role;
      return role === "primary" || role === "group-boundary";
    });
    return {
      viewport: { width: viewportRect.width, height: viewportRect.height },
      camera: { scrollX, scrollY, zoom, offsetLeft, offsetTop },
      elements: relevant.map((element) => {
        const tweakloop = (
          element.customData as
            | { tweakloop?: { semanticKey?: unknown; role?: unknown } }
            | undefined
        )?.tweakloop;
        const left = (element.x + scrollX) * zoom + offsetLeft - viewportRect.left;
        const top = (element.y + scrollY) * zoom + offsetTop - viewportRect.top;
        const right = left + element.width * zoom;
        const bottom = top + element.height * zoom;
        return {
          semanticKey: String(tweakloop?.semanticKey ?? element.id),
          role: String(tweakloop?.role ?? "unknown"),
          left,
          top,
          right,
          bottom,
          fullyVisible:
            left >= 0 && top >= 0 && right <= viewportRect.width && bottom <= viewportRect.height,
        };
      }),
    };
  });
}

test.beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-whiteboard-e2e-state-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "tweakloop-whiteboard-e2e-ws-"));
  env = { ...process.env, TWEAKLOOP_STATE_DIR: stateDir };
  writeFileSync(join(workspaceDir, "architecture.excalidraw"), EMPTY_BOARD);
});

test.afterAll(() => {
  try {
    tweak(["daemon", "stop"]);
  } catch {
    // already stopped
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

test("standalone whiteboard collaborates live with its originating agent and embeds in Markdown", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(page);

  const externalRequests: string[] = [];
  const browserDraftPuts: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol.startsWith("http")) {
      externalRequests.push(request.url());
    }
    if (request.method() === "PUT" && /\/api\/v1\/whiteboards\/[^/]+\/draft$/.test(url.pathname)) {
      browserDraftPuts.push(request.url());
    }
  });

  // The originating agent is part of the review-session contract, not inferred later.
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      join(workspaceDir, "architecture.excalidraw"),
      "--agent",
      "agent:whiteboard-e2e",
      "--no-browser",
    ]),
  ) as OpenReceipt;
  expect(opened.seq).toBe(1);

  await page.goto(opened.url);
  await expect(page).toHaveURL(new RegExp(`/app\\?artifact=${opened.artifactId}$`));
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(page.locator("#agent-name")).toContainText("whiteboard-e2e");

  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  const boardHost = frame.locator(
    '[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]',
  );
  await expect(boardHost).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", {
    timeout: 30_000,
  });
  await expect(frame.locator(".excalidraw")).toBeVisible();
  const rectangleTool = frame.getByTestId("toolbar-rectangle");
  await expect(rectangleTool).toBeEnabled();
  await expect(rectangleTool.locator("..")).toBeVisible();
  expect(externalRequests).toEqual([]);

  // A human edits through Excalidraw's native visible rectangle control and canvas.
  const canvas = frame.locator("canvas.excalidraw__canvas.interactive");
  await rectangleTool.locator("..").click();
  await expect(rectangleTool).toBeChecked();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("interactive Excalidraw canvas has no browser box");
  await page.mouse.move(canvasBox.x + 400, canvasBox.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 560, canvasBox.y + 400, { steps: 8 });
  await page.mouse.up();

  await expect
    .poll(async () => (await boardScene(page)).elements.filter((element) => !element.isDeleted), {
      timeout: 15_000,
    })
    .toHaveLength(1);
  const humanScene = await boardScene(page);
  const humanElement = humanScene.elements.find((element) => !element.isDeleted);
  expect(humanElement).toBeTruthy();
  if (!humanElement) throw new Error("native rectangle did not create an Excalidraw element");

  // The durable CAS draft independently sees that same native element.
  const humanDraftPath = join(workspaceDir, "human-draft.excalidraw");
  let humanDraft: DraftReceipt | null = null;
  await expect
    .poll(
      () => {
        try {
          humanDraft = JSON.parse(
            tweak([
              "--json",
              "whiteboard",
              "draft",
              "get",
              opened.artifactId,
              "--output",
              humanDraftPath,
            ]),
          ) as DraftReceipt;
          return readScene(humanDraftPath).elements.some(
            (element) => element.id === humanElement.id && !element.isDeleted,
          );
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  expect(humanDraft).not.toBeNull();
  if (!humanDraft) throw new Error("human draft receipt was not available");
  expect(humanDraft.updatedBy).toEqual({ kind: "human", id: "browser" });
  expect(readScene(humanDraftPath).elements.some((element) => element.id === humanElement.id)).toBe(
    true,
  );
  expect(browserDraftPuts.length).toBeGreaterThan(0);
  const browserPutCountBeforeRemote = browserDraftPuts.length;

  // The agent uses the supported capability-bound semantic lane. The browser is the live
  // projection, not an ambient human-cookie authority for the agent. This must preserve the
  // preceding native edit as human while attributing the new managed element to the registered
  // session agent.
  const cameraBefore = await boardViewportState(page);
  const semanticUpdate = JSON.parse(
    tweak([
      "--json",
      "whiteboard",
      "scene",
      "add-node",
      join(workspaceDir, "architecture.excalidraw"),
      "agent-service",
      "--session",
      opened.sessionId,
      "--idempotency-key",
      "e2e.whiteboard.agent-service",
      "--label",
      "Agent service",
    ]),
  ) as { status: string; draftVersion: number };
  expect(semanticUpdate.status).toBe("accepted");
  expect(semanticUpdate.draftVersion).toBe(humanDraft.draftVersion + 1);

  const agentRoundTripPath = join(workspaceDir, "agent-round-trip.excalidraw");
  const agentRoundTrip = JSON.parse(
    tweak([
      "--json",
      "whiteboard",
      "draft",
      "get",
      opened.artifactId,
      "--output",
      agentRoundTripPath,
    ]),
  ) as DraftReceipt;
  expect(agentRoundTrip).toMatchObject({
    draftVersion: semanticUpdate.draftVersion,
    updatedBy: { kind: "agent", id: "whiteboard-e2e" },
  });
  const semanticMetadata = (element: ExcalidrawElement) =>
    (element.customData as { tweakloop?: Record<string, unknown> } | undefined)?.tweakloop;
  const roundTripAgentElement = readScene(agentRoundTripPath).elements.find(
    (element) =>
      !element.isDeleted &&
      semanticMetadata(element)?.semanticKey === "agent-service" &&
      semanticMetadata(element)?.role === "primary",
  );
  expect(roundTripAgentElement).toBeTruthy();
  const expectedPublishedElementCount = readScene(agentRoundTripPath).elements.filter(
    (element) => !element.isDeleted,
  ).length;

  await expect(page.locator("#viewer-flash")).toContainText("updated by the agent", {
    timeout: 10_000,
  });
  await expect
    .poll(async () => {
      const scene = await boardScene(page);
      return scene.elements.find(
        (element) =>
          !element.isDeleted &&
          semanticMetadata(element)?.semanticKey === "agent-service" &&
          semanticMetadata(element)?.role === "primary",
      );
    })
    .toBeTruthy();
  const remoteAppliedScene = await boardScene(page);
  const remoteAppliedElement = remoteAppliedScene.elements.find(
    (element) =>
      !element.isDeleted &&
      semanticMetadata(element)?.semanticKey === "agent-service" &&
      semanticMetadata(element)?.role === "primary",
  );
  if (!remoteAppliedElement) {
    throw new Error(
      `remote scene lost agent-service; elements: ${JSON.stringify(remoteAppliedScene.elements.map(({ id, x, version, customData }) => ({ id, x, version, customData })))}`,
    );
  }
  expect(remoteAppliedElement.id).toBe(roundTripAgentElement?.id);
  await page.waitForTimeout(900);
  const cameraAfter = await boardViewportState(page);
  for (const key of ["scrollX", "scrollY", "zoom"]) {
    expect(cameraAfter[key]).toEqual(cameraBefore[key]);
  }
  expect(browserDraftPuts).toHaveLength(browserPutCountBeforeRemote);

  // A visible comment selection on the exact moved board element becomes work for the originating agent.
  await page.getByTestId("mode-toggle").click();
  await expect(page.getByTestId("mode-toggle")).toHaveClass(/active/);
  await expect(boardHost).toHaveAttribute("data-tweakloop-whiteboard-comment-mode", "true");
  const viewportState = await boardViewportState(page);
  const zoom = Number(viewportState.zoom ?? 1);
  const scrollX = Number(viewportState.scrollX ?? 0);
  const scrollY = Number(viewportState.scrollY ?? 0);
  const offsetLeft = Number(viewportState.offsetLeft ?? 0);
  const offsetTop = Number(viewportState.offsetTop ?? 0);
  const elementCenterX = remoteAppliedElement.x + remoteAppliedElement.width / 2;
  const elementCenterY = remoteAppliedElement.y + remoteAppliedElement.height / 2;
  await page.mouse.click(
    canvasBox.x + (elementCenterX + scrollX) * zoom + offsetLeft,
    canvasBox.y + (elementCenterY + scrollY) * zoom + offsetTop,
  );
  await expect(page.getByTestId("draft-form")).toBeVisible();
  await expect(page.locator("#draft-target")).toContainText("Agent service");
  await page
    .getByTestId("draft-text")
    .fill("Make this service boundary explicit and label the owning agent.");
  const commentCursor = durableEvents().at(-1)?.seq ?? 0;
  await page.locator("#draft-send").click();
  await expect(page.getByTestId("intent-item")).toHaveCount(1, { timeout: 10_000 });
  const commentEvents = durableEvents(commentCursor);
  const intentCreated = commentEvents.filter((event) => event.eventType === "intent.created");
  expect(intentCreated).toHaveLength(1);
  expect(intentCreated[0]?.payload).toMatchObject({ intentType: "comment" });
  expect(commentEvents.filter((event) => event.eventType === "work.created")).toHaveLength(0);
  await expect(page.getByTestId("work-item")).toHaveCount(0);

  const intentId = String(intentCreated[0]?.payload.intentId);
  const track = page.getByTestId("intent-item").getByTestId("comment-track");
  await expect(track).toHaveText("Track as task");
  await track.click();
  await expect
    .poll(() => durableEvents(commentCursor).filter((event) => event.eventType === "work.created"))
    .toHaveLength(1);
  const workCreated = durableEvents(commentCursor).find(
    (event) => event.eventType === "work.created",
  );
  expect(workCreated?.payload).toMatchObject({ intentIds: [intentId] });
  const trackedWorkId = String(workCreated?.payload.workId);
  const relatedWork = JSON.parse(
    tweak(["--json", "work", "list", "--status", "all", "--full"]),
  ).work.filter((work: { workId: string }) => work.workId === trackedWorkId);
  expect(relatedWork).toEqual([
    expect.objectContaining({ workId: trackedWorkId, intentIds: [intentId] }),
  ]);
  await expect(page.getByTestId("work-item")).toHaveCount(1);

  const claim = JSON.parse(
    tweak([
      "--json",
      "work",
      "claim",
      "--agent",
      "agent:whiteboard-e2e",
      "--process",
      "process-whiteboard-e2e",
    ]),
  ) as {
    status: string;
    workId: string;
    claimId: string;
    assigneeAgentId: string;
    intents: Array<{
      intentId: string;
      target: {
        boardAnchor?: {
          whiteboardArtifactId?: string;
          elementAnchor?: { elementId?: string };
        };
      };
    }>;
  };
  expect(claim.status).toBe("claimed");
  expect(claim.assigneeAgentId).toBe("whiteboard-e2e");
  expect(claim.intents).toHaveLength(1);
  expect(claim.intents[0]?.target.boardAnchor).toMatchObject({
    whiteboardArtifactId: opened.artifactId,
    elementAnchor: { elementId: remoteAppliedElement.id },
  });

  // Agent publishes the observed live draft and completes; addressed is not accepted.
  const published = JSON.parse(
    tweak([
      "--json",
      "whiteboard",
      "scene",
      "publish",
      join(workspaceDir, "architecture.excalidraw"),
      "--idempotency-key",
      "e2e.whiteboard.publish",
      "--agent",
      "agent:whiteboard-e2e",
    ]),
  ) as { revisionId: string; seq: number; sceneHash: string };
  expect(published.seq).toBe(2);

  const completed = JSON.parse(
    tweak([
      "--json",
      "work",
      "complete",
      claim.workId,
      "--claim",
      claim.claimId,
      "--agent",
      "agent:whiteboard-e2e",
      "--revision-id",
      published.revisionId,
      "--summary",
      "Moved the exact service-boundary element and published the reviewed whiteboard revision.",
    ]),
  ) as { status: string };
  expect(completed.status).toBe("addressed");
  await page.getByTestId("rail-tab-work").click();
  await expect(page.getByTestId("work-item")).toHaveAttribute("data-work-status", "addressed", {
    timeout: 10_000,
  });
  await expect(page.getByTestId("work-item")).toHaveAttribute("data-decision-status", "pending");
  const pendingWork = JSON.parse(
    tweak(["--json", "work", "list", "--status", "all", "--full"]),
  ) as {
    work: Array<{ workId: string; decision: string }>;
  };
  expect(pendingWork.work.find((item) => item.workId === claim.workId)?.decision).toBe("pending");

  // Acceptance is an explicit human action in the browser, with a durable decision event.
  await page.getByTestId("decision-accept").click();
  await expect(page.getByTestId("work-item")).toContainText(/accepted/i, { timeout: 10_000 });
  const acceptedWork = JSON.parse(
    tweak(["--json", "work", "list", "--status", "all", "--full"]),
  ) as {
    work: Array<{ workId: string; decision: string }>;
  };
  expect(acceptedWork.work.find((item) => item.workId === claim.workId)?.decision).toBe("accepted");

  // Markdown pins the immutable published revision and consumes the same local editor bundle.
  const markdownPath = join(workspaceDir, "architecture.md");
  writeFileSync(
    markdownPath,
    `# Architecture review {#architecture}\n\nThe accepted boundary is pinned below.\n\n\`\`\`tweakloop-whiteboard {#architecture.board artifact=${opened.artifactId} revision=${published.revisionId}}\n\`\`\`\n`,
  );
  const markdownOpened = JSON.parse(
    tweak(["--json", "open", markdownPath, "--agent", "agent:whiteboard-e2e", "--no-browser"]),
  ) as OpenReceipt;
  const markdownPage = await page.context().newPage();
  await allowOnlyLoopback(markdownPage);
  await markdownPage.goto(markdownOpened.url);
  await expect(markdownPage).toHaveURL(new RegExp(`/app\\?artifact=${markdownOpened.artifactId}$`));
  const markdownFrame = markdownPage.frameLocator('[data-testid="viewer-frame"]');
  await expect(markdownFrame.locator('[data-tweak-id="architecture"]')).toBeVisible();
  const embeddedBoard = markdownFrame.locator(
    `[data-tweak-id="architecture.board"][data-tweak-whiteboard-artifact="${opened.artifactId}"][data-tweak-whiteboard-revision="${published.revisionId}"]`,
  );
  await expect(embeddedBoard).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", {
    timeout: 30_000,
  });
  await expect(markdownFrame.locator(".excalidraw")).toBeVisible();
  await expect
    .poll(() =>
      embeddedBoard.evaluate(() => {
        const board = window.__TWEAKLOOP_WHITEBOARDS__?.get("architecture.board");
        return board?.getScene().elements.filter((element) => !element.isDeleted).length ?? 0;
      }),
    )
    .toBe(expectedPublishedElementCount);
  await markdownPage.close();

  const events = JSON.parse(tweak(["--json", "events", "list"])) as {
    events: Array<{ eventType: string }>;
  };
  const eventTypes = events.events.map((event) => event.eventType);
  for (const expected of [
    "artifact.revision-published",
    "intent.created",
    "work.claimed",
    "work.addressed",
    "decision.accepted",
  ]) {
    expect(eventTypes).toContain(expected);
  }
  expect(externalRequests).toEqual([]);
});

test("browser whiteboard retries the exact lost-response operation after reload and reports remote humans truthfully", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(page);

  const retryPath = join(workspaceDir, "browser-retry.excalidraw");
  writeFileSync(retryPath, EMPTY_BOARD);
  const opened = JSON.parse(
    tweak(["--json", "open", retryPath, "--agent", "agent:whiteboard-retry-e2e", "--no-browser"]),
  ) as OpenReceipt;

  const attempts: Array<{ clientId: string; clientSequence: string; body: string }> = [];
  let firstCommittedResponseDropped = false;
  let reloadRequested = false;
  let reloadNavigationSeen = false;
  page.on("framenavigated", (frame) => {
    if (reloadRequested && frame === page.mainFrame()) reloadNavigationSeen = true;
  });
  await page.route(new RegExp(`/api/v1/whiteboards/${opened.artifactId}/draft$`), async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.continue();
      return;
    }
    const headers = request.headers();
    attempts.push({
      clientId: headers["x-tweakloop-client-id"] ?? "",
      clientSequence: headers["x-tweakloop-client-sequence"] ?? "",
      body: request.postData() ?? "",
    });
    if (!firstCommittedResponseDropped) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      firstCommittedResponseDropped = true;
      await route.abort("connectionfailed");
      return;
    }
    if (!reloadNavigationSeen) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });

  await page.goto(opened.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  const boardHost = frame.locator(
    '[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]',
  );
  await expect(boardHost).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", {
    timeout: 30_000,
  });
  const rectangleTool = frame.getByTestId("toolbar-rectangle");
  const canvas = frame.locator("canvas.excalidraw__canvas.interactive");
  await rectangleTool.locator("..").click();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("interactive Excalidraw canvas has no browser box");
  await page.mouse.move(canvasBox.x + 420, canvasBox.y + 320);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 570, canvasBox.y + 410, { steps: 8 });
  await page.mouse.up();

  await expect.poll(() => firstCommittedResponseDropped).toBe(true);
  const firstDraftPath = join(workspaceDir, "browser-retry-first.excalidraw");
  let firstDraft: DraftReceipt | null = null;
  await expect
    .poll(() => {
      try {
        firstDraft = JSON.parse(
          tweak([
            "--json",
            "whiteboard",
            "draft",
            "get",
            opened.artifactId,
            "--output",
            firstDraftPath,
          ]),
        ) as DraftReceipt;
        return firstDraft.draftVersion;
      } catch {
        return 0;
      }
    })
    .toBe(1);
  const pendingBeforeReload = await page.evaluate(
    (artifactId) => sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
    opened.artifactId,
  );
  expect(pendingBeforeReload).not.toBeNull();
  expect(attempts[0]?.clientId).toMatch(/^browser_/);
  expect(attempts[0]?.clientSequence).toBe("1");

  reloadRequested = true;
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(boardHost).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", {
    timeout: 30_000,
  });
  await expect
    .poll(() =>
      page.evaluate(
        (artifactId) =>
          sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
        opened.artifactId,
      ),
    )
    .toBeNull();
  expect(attempts.length).toBeGreaterThanOrEqual(2);
  for (const replay of attempts.slice(1)) expect(replay).toEqual(attempts[0]);

  const replayedDraft = JSON.parse(
    tweak(["--json", "whiteboard", "draft", "get", opened.artifactId, "--output", firstDraftPath]),
  ) as DraftReceipt;
  expect(replayedDraft).toMatchObject({
    draftVersion: 1,
    updatedBy: { kind: "human", id: "browser" },
  });
  expect(readScene(firstDraftPath).elements.filter((element) => !element.isDeleted)).toHaveLength(
    1,
  );
  await page.waitForTimeout(700);
  const quiescentAttemptCount = attempts.length;
  await page.waitForTimeout(500);
  expect(attempts).toHaveLength(quiescentAttemptCount);
  await expect
    .poll(() =>
      page.evaluate(
        (artifactId) =>
          sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
        opened.artifactId,
      ),
    )
    .toBeNull();
  const quiescentDraftPath = join(workspaceDir, "browser-retry-quiescent.excalidraw");
  const quiescentDraft = JSON.parse(
    tweak([
      "--json",
      "whiteboard",
      "draft",
      "get",
      opened.artifactId,
      "--output",
      quiescentDraftPath,
    ]),
  ) as DraftReceipt;
  const attemptLedger = attempts.map((attempt) => ({
    clientId: attempt.clientId,
    clientSequence: attempt.clientSequence,
    elementCount: (JSON.parse(attempt.body) as ExcalidrawScene).elements.filter(
      (element) => !element.isDeleted,
    ).length,
  }));
  expect(
    readScene(quiescentDraftPath).elements.filter((element) => !element.isDeleted),
    JSON.stringify(attemptLedger),
  ).toHaveLength(1);

  // A second real browser tab is a human collaborator. Its SSE update must not be mislabeled as
  // an agent action in the first tab.
  const secondReview = JSON.parse(
    tweak(["--json", "session", "url", opened.sessionId, "--document", retryPath]),
  ) as { url: string };
  const collaborator = await page.context().newPage();
  await collaborator.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(collaborator);
  await collaborator.goto(secondReview.url);
  await expect(collaborator).toHaveURL(new RegExp(`/app\\?artifact=${opened.artifactId}$`));
  await expect(collaborator.getByTestId("connection")).toHaveText("synced");
  const remoteHumanScene = readScene(quiescentDraftPath);
  remoteHumanScene.appState.viewBackgroundColor = "#f8fafc";
  const remoteResult = await collaborator.evaluate(
    async ({ artifactId, draftId, baseRevisionId, expectedVersion, body }) => {
      const response = await fetch(`/api/v1/whiteboards/${encodeURIComponent(artifactId)}/draft`, {
        method: "PUT",
        headers: {
          "content-type": "application/vnd.excalidraw+json",
          "x-tweakloop-draft-id": draftId,
          "x-tweakloop-base-revision": baseRevisionId,
          "x-tweakloop-expected-version": String(expectedVersion),
          "x-tweakloop-client-id": "browser_remote_human_e2e",
          "x-tweakloop-client-sequence": "1",
        },
        body,
      });
      return { status: response.status, body: await response.json() };
    },
    {
      artifactId: opened.artifactId,
      draftId: quiescentDraft.draftId,
      baseRevisionId: quiescentDraft.baseRevisionId,
      expectedVersion: quiescentDraft.draftVersion,
      body: JSON.stringify(remoteHumanScene),
    },
  );
  expect(remoteResult).toMatchObject({
    status: 200,
    body: { status: "accepted", draftVersion: quiescentDraft.draftVersion + 1 },
  });

  await expect(page.locator("#viewer-flash")).toContainText("updated in another browser", {
    timeout: 15_000,
  });
  await expect(page.locator("#viewer-flash")).not.toContainText("updated by the agent");
  const remoteHumanPath = join(workspaceDir, "browser-retry-remote-human.excalidraw");
  const remoteHuman = JSON.parse(
    tweak(["--json", "whiteboard", "draft", "get", opened.artifactId, "--output", remoteHumanPath]),
  ) as DraftReceipt;
  expect(remoteHuman.updatedBy).toEqual({ kind: "human", id: "browser" });
  expect(remoteHuman.draftVersion).toBe(quiescentDraft.draftVersion + 1);
  expect(readScene(remoteHumanPath).elements.filter((element) => !element.isDeleted)).toHaveLength(
    1,
  );
  await collaborator.close();
});

test("opener-created whiteboard tabs use distinct operation identities", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(page);

  const openerPath = join(workspaceDir, "browser-opener-isolation.excalidraw");
  writeFileSync(openerPath, EMPTY_BOARD);
  const opened = JSON.parse(
    tweak(["--json", "open", openerPath, "--agent", "agent:whiteboard-opener-e2e", "--no-browser"]),
  ) as OpenReceipt;
  await page.goto(opened.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");

  const secondReview = JSON.parse(
    tweak(["--json", "session", "url", opened.sessionId, "--document", openerPath]),
  ) as { url: string };
  const openedChild = context.waitForEvent("page");
  await page.evaluate((url) => window.open(url, "_blank"), secondReview.url);
  const collaborator = await openedChild;
  await collaborator.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(collaborator);
  await expect(collaborator.getByTestId("connection")).toHaveText("synced");

  const primaryIdentity = await page.evaluate(() => ({
    contextId: history.state?.tweakloopWhiteboardContextId,
    stored: JSON.parse(sessionStorage.getItem("tweakloop-whiteboard-client-id") ?? "null"),
  }));
  const collaboratorIdentity = await collaborator.evaluate(() => ({
    contextId: history.state?.tweakloopWhiteboardContextId,
    stored: JSON.parse(sessionStorage.getItem("tweakloop-whiteboard-client-id") ?? "null"),
  }));
  expect(primaryIdentity.contextId).toMatch(/^tab_/);
  expect(collaboratorIdentity.contextId).toMatch(/^tab_/);
  expect(collaboratorIdentity.contextId).not.toBe(primaryIdentity.contextId);
  expect(primaryIdentity.stored).toMatchObject({
    protocol: "tweakloop.whiteboard-browser-client/v1",
    contextId: primaryIdentity.contextId,
  });
  expect(collaboratorIdentity.stored).toMatchObject({
    protocol: "tweakloop.whiteboard-browser-client/v1",
    contextId: collaboratorIdentity.contextId,
  });
  expect(collaboratorIdentity.stored.clientId).not.toBe(primaryIdentity.stored.clientId);

  const seedScene = JSON.parse(EMPTY_BOARD) as ExcalidrawScene;
  seedScene.appState.viewBackgroundColor = "#f8fafc";
  const seed = await page.evaluate(
    async ({ artifactId, baseRevisionId, body }) => {
      const response = await fetch(`/api/v1/whiteboards/${encodeURIComponent(artifactId)}/draft`, {
        method: "PUT",
        headers: {
          "content-type": "application/vnd.excalidraw+json",
          "x-tweakloop-draft-id": "draft_browser_opener_isolation",
          "x-tweakloop-base-revision": baseRevisionId,
          "x-tweakloop-expected-version": "0",
          "x-tweakloop-client-id": "browser_opener_seed",
          "x-tweakloop-client-sequence": "1",
        },
        body,
      });
      return { status: response.status, body: await response.json() };
    },
    {
      artifactId: opened.artifactId,
      baseRevisionId: opened.revisionId,
      body: JSON.stringify(seedScene),
    },
  );
  expect(seed).toMatchObject({ status: 200, body: { status: "accepted", draftVersion: 1 } });

  const primaryScene = structuredClone(seedScene);
  primaryScene.appState.viewBackgroundColor = "#e2e8f0";
  const collaboratorScene = structuredClone(seedScene);
  collaboratorScene.appState.viewBackgroundColor = "#fef3c7";
  const request = async (target: Page, clientId: string, scene: ExcalidrawScene) =>
    target.evaluate(
      async ({ artifactId, baseRevisionId, clientId, body }) => {
        const response = await fetch(
          `/api/v1/whiteboards/${encodeURIComponent(artifactId)}/draft`,
          {
            method: "PUT",
            headers: {
              "content-type": "application/vnd.excalidraw+json",
              "x-tweakloop-draft-id": "draft_browser_opener_isolation",
              "x-tweakloop-base-revision": baseRevisionId,
              "x-tweakloop-expected-version": "1",
              "x-tweakloop-client-id": clientId,
              "x-tweakloop-client-sequence": "100",
            },
            body,
          },
        );
        return { status: response.status, body: await response.json() };
      },
      {
        artifactId: opened.artifactId,
        baseRevisionId: opened.revisionId,
        clientId,
        body: JSON.stringify(scene),
      },
    );
  const first = await request(page, primaryIdentity.stored.clientId, primaryScene);
  const second = await request(
    collaborator,
    collaboratorIdentity.stored.clientId,
    collaboratorScene,
  );
  expect(first).toMatchObject({ status: 200, body: { status: "accepted", draftVersion: 2 } });
  expect(second).toMatchObject({ status: 409, body: { status: "conflict" } });
  expect(JSON.stringify(second.body)).not.toContain("draft-idempotency-conflict");
  await collaborator.close();
});

test("opener child ignores copied parent custody and can save its own edit", async ({
  context,
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(page);

  const pendingPath = join(workspaceDir, "browser-opener-pending.excalidraw");
  writeFileSync(pendingPath, EMPTY_BOARD);
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      pendingPath,
      "--agent",
      "agent:whiteboard-opener-pending-e2e",
      "--no-browser",
    ]),
  ) as OpenReceipt;
  let parentCommittedResponseDropped = false;
  await page.route(new RegExp(`/api/v1/whiteboards/${opened.artifactId}/draft$`), async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.continue();
      return;
    }
    if (!parentCommittedResponseDropped) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      parentCommittedResponseDropped = true;
    }
    await route.abort("connectionfailed");
  });

  await page.goto(opened.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  const parentFrame = page.frameLocator('[data-testid="viewer-frame"]');
  await expect(
    parentFrame.locator('[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]'),
  ).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", { timeout: 30_000 });
  await parentFrame.getByTestId("toolbar-rectangle").locator("..").click();
  const parentCanvasBox = await parentFrame
    .locator("canvas.excalidraw__canvas.interactive")
    .boundingBox();
  if (!parentCanvasBox) throw new Error("parent pending test canvas has no browser box");
  await page.mouse.move(parentCanvasBox.x + 420, parentCanvasBox.y + 320);
  await page.mouse.down();
  await page.mouse.move(parentCanvasBox.x + 570, parentCanvasBox.y + 410, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => parentCommittedResponseDropped).toBe(true);

  const parentPending = await page.evaluate(
    (artifactId) => sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
    opened.artifactId,
  );
  expect(parentPending).not.toBeNull();
  const firstDraftPath = join(workspaceDir, "browser-opener-pending-first.excalidraw");
  await expect
    .poll(() => {
      try {
        return (
          JSON.parse(
            tweak([
              "--json",
              "whiteboard",
              "draft",
              "get",
              opened.artifactId,
              "--output",
              firstDraftPath,
            ]),
          ) as DraftReceipt
        ).draftVersion;
      } catch {
        return 0;
      }
    })
    .toBe(1);

  const secondReview = JSON.parse(
    tweak(["--json", "session", "url", opened.sessionId, "--document", pendingPath]),
  ) as { url: string };
  const openedChild = context.waitForEvent("page");
  await page.evaluate((url) => window.open(url, "_blank"), secondReview.url);
  const collaborator = await openedChild;
  await collaborator.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(collaborator);
  let childDraftPuts = 0;
  collaborator.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PUT" && url.pathname.endsWith(`/${opened.artifactId}/draft`)) {
      childDraftPuts += 1;
    }
  });
  await expect(collaborator.getByTestId("connection")).toHaveText("synced");
  const childFrame = collaborator.frameLocator('[data-testid="viewer-frame"]');
  await expect(
    childFrame.locator('[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]'),
  ).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", { timeout: 30_000 });
  await collaborator.waitForTimeout(700);
  expect(childDraftPuts).toBe(0);
  expect(
    await collaborator.evaluate(
      (artifactId) =>
        sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
      opened.artifactId,
    ),
  ).toBe(parentPending);

  const parentIdentity = await page.evaluate(() => ({
    contextId: history.state?.tweakloopWhiteboardContextId,
    clientId: JSON.parse(sessionStorage.getItem("tweakloop-whiteboard-client-id") ?? "null")
      ?.clientId,
  }));
  const childIdentity = await collaborator.evaluate(() => ({
    contextId: history.state?.tweakloopWhiteboardContextId,
    clientId: JSON.parse(sessionStorage.getItem("tweakloop-whiteboard-client-id") ?? "null")
      ?.clientId,
  }));
  expect(childIdentity.contextId).not.toBe(parentIdentity.contextId);
  expect(childIdentity.clientId).not.toBe(parentIdentity.clientId);

  await childFrame.getByTestId("toolbar-rectangle").locator("..").click();
  const childCanvasBox = await childFrame
    .locator("canvas.excalidraw__canvas.interactive")
    .boundingBox();
  if (!childCanvasBox) throw new Error("child pending test canvas has no browser box");
  await collaborator.mouse.move(childCanvasBox.x + 650, childCanvasBox.y + 470);
  await collaborator.mouse.down();
  await collaborator.mouse.move(childCanvasBox.x + 790, childCanvasBox.y + 550, { steps: 8 });
  await collaborator.mouse.up();

  await expect.poll(() => childDraftPuts).toBeGreaterThanOrEqual(1);
  await expect
    .poll(() =>
      collaborator.evaluate(
        (artifactId) =>
          sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
        opened.artifactId,
      ),
    )
    .toBeNull();
  await expect
    .poll(async () =>
      (await boardScene(collaborator)).elements.filter((element) => !element.isDeleted),
    )
    .toHaveLength(2);

  const finalPath = join(workspaceDir, "browser-opener-pending-final.excalidraw");
  const finalDraft = JSON.parse(
    tweak(["--json", "whiteboard", "draft", "get", opened.artifactId, "--output", finalPath]),
  ) as DraftReceipt;
  expect(finalDraft.draftVersion).toBe(2);
  expect(readScene(finalPath).elements.filter((element) => !element.isDeleted)).toHaveLength(2);
  expect(
    await page.evaluate(
      (artifactId) =>
        sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
      opened.artifactId,
    ),
  ).toBe(parentPending);
  await collaborator.close();
});

test("remote whiteboard updates catch up after an exact lost-response replay without reload", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(page);

  const catchupPath = join(workspaceDir, "browser-pending-remote-catchup.excalidraw");
  writeFileSync(catchupPath, EMPTY_BOARD);
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      catchupPath,
      "--agent",
      "agent:whiteboard-catchup-e2e",
      "--no-browser",
    ]),
  ) as OpenReceipt;

  let committedResponseDropped = false;
  let allowExactReplay = false;
  let mainFrameNavigations = 0;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) mainFrameNavigations += 1;
  });
  await page.route(new RegExp(`/api/v1/whiteboards/${opened.artifactId}/draft$`), async (route) => {
    const request = route.request();
    if (request.method() !== "PUT") {
      await route.continue();
      return;
    }
    if (!committedResponseDropped) {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committedResponseDropped = true;
      await route.abort("connectionfailed");
      return;
    }
    if (!allowExactReplay) {
      await route.abort("connectionfailed");
      return;
    }
    await route.continue();
  });

  await page.goto(opened.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  const navigationCountAfterLoad = mainFrameNavigations;
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  const boardHost = frame.locator(
    '[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]',
  );
  await expect(boardHost).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", {
    timeout: 30_000,
  });
  const rectangleTool = frame.getByTestId("toolbar-rectangle");
  const canvas = frame.locator("canvas.excalidraw__canvas.interactive");
  await rectangleTool.locator("..").click();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("catch-up test canvas has no browser box");
  await page.mouse.move(canvasBox.x + 420, canvasBox.y + 320);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 570, canvasBox.y + 410, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => committedResponseDropped).toBe(true);

  const localDraftPath = join(workspaceDir, "browser-pending-remote-local.excalidraw");
  let localDraft: DraftReceipt | null = null;
  await expect
    .poll(() => {
      try {
        localDraft = JSON.parse(
          tweak([
            "--json",
            "whiteboard",
            "draft",
            "get",
            opened.artifactId,
            "--output",
            localDraftPath,
          ]),
        ) as DraftReceipt;
        return localDraft.draftVersion;
      } catch {
        return 0;
      }
    })
    .toBe(1);
  expect(
    await page.evaluate(
      (artifactId) =>
        sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
      opened.artifactId,
    ),
  ).not.toBeNull();

  const secondReview = JSON.parse(
    tweak(["--json", "session", "url", opened.sessionId, "--document", catchupPath]),
  ) as { url: string };
  const collaborator = await page.context().newPage();
  await collaborator.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(collaborator);
  await collaborator.goto(secondReview.url);
  await expect(collaborator.getByTestId("connection")).toHaveText("synced");

  const remoteScene = readScene(localDraftPath);
  remoteScene.appState.viewBackgroundColor = "#dbeafe";
  const remoteResult = await collaborator.evaluate(
    async ({ artifactId, draftId, baseRevisionId, expectedVersion, body }) => {
      const response = await fetch(`/api/v1/whiteboards/${encodeURIComponent(artifactId)}/draft`, {
        method: "PUT",
        headers: {
          "content-type": "application/vnd.excalidraw+json",
          "x-tweakloop-draft-id": draftId,
          "x-tweakloop-base-revision": baseRevisionId,
          "x-tweakloop-expected-version": String(expectedVersion),
          "x-tweakloop-client-id": "browser_remote_during_pending_e2e",
          "x-tweakloop-client-sequence": "1",
        },
        body,
      });
      return { status: response.status, body: await response.json() };
    },
    {
      artifactId: opened.artifactId,
      draftId: localDraft?.draftId,
      baseRevisionId: localDraft?.baseRevisionId,
      expectedVersion: localDraft?.draftVersion,
      body: JSON.stringify(remoteScene),
    },
  );
  expect(remoteResult).toMatchObject({
    status: 200,
    body: { status: "accepted", draftVersion: 2 },
  });
  await expect(page.locator("#viewer-flash")).toContainText("reconciling", { timeout: 15_000 });

  allowExactReplay = true;
  await expect
    .poll(() =>
      page.evaluate(
        (artifactId) =>
          sessionStorage.getItem(`tweakloop-whiteboard-pending-operation:${artifactId}`),
        opened.artifactId,
      ),
    )
    .toBeNull();
  await expect
    .poll(async () => (await boardScene(page)).appState.viewBackgroundColor)
    .toBe("#dbeafe");
  await expect(page.locator("#viewer-flash")).toContainText("updated in another browser", {
    timeout: 15_000,
  });
  expect(mainFrameNavigations).toBe(navigationCountAfterLoad);

  const finalPath = join(workspaceDir, "browser-pending-remote-final.excalidraw");
  const finalDraft = JSON.parse(
    tweak(["--json", "whiteboard", "draft", "get", opened.artifactId, "--output", finalPath]),
  ) as DraftReceipt;
  expect(finalDraft.draftVersion).toBe(2);
  expect(finalDraft.updatedBy).toEqual({ kind: "human", id: "browser" });
  expect(readScene(finalPath).appState.viewBackgroundColor).toBe("#dbeafe");
  await collaborator.close();
});

test("toolbar-only whiteboard input does not create an empty durable draft", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(page);

  const toolbarPath = join(workspaceDir, "browser-toolbar-noop.excalidraw");
  writeFileSync(toolbarPath, EMPTY_BOARD);
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      toolbarPath,
      "--agent",
      "agent:whiteboard-toolbar-e2e",
      "--no-browser",
    ]),
  ) as OpenReceipt;
  let draftPuts = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PUT" && url.pathname.endsWith(`/${opened.artifactId}/draft`)) {
      draftPuts += 1;
    }
  });

  await page.goto(opened.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  const boardHost = frame.locator(
    '[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]',
  );
  await expect(boardHost).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", {
    timeout: 30_000,
  });
  await frame.getByTestId("toolbar-rectangle").locator("..").click();
  await page.waitForTimeout(1_300);

  expect(draftPuts).toBe(0);
  expect((await boardScene(page)).elements.filter((element) => !element.isDeleted)).toHaveLength(0);
  expect(() => tweak(["--json", "whiteboard", "draft", "get", opened.artifactId])).toThrow();
});

test("browser whiteboard fails before transport when exact retry custody is unavailable", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1680, height: 1050 });
  await allowOnlyLoopback(page);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (
        this === window.sessionStorage &&
        key.startsWith("tweakloop-whiteboard-pending-operation:")
      ) {
        throw new DOMException("injected exact-retry custody failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  });

  const custodyPath = join(workspaceDir, "browser-custody-failure.excalidraw");
  writeFileSync(custodyPath, EMPTY_BOARD);
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      custodyPath,
      "--agent",
      "agent:whiteboard-custody-e2e",
      "--no-browser",
    ]),
  ) as OpenReceipt;
  let browserDraftPuts = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PUT" && url.pathname.endsWith(`/${opened.artifactId}/draft`)) {
      browserDraftPuts += 1;
    }
  });

  await page.goto(opened.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  const boardHost = frame.locator(
    '[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]',
  );
  await expect(boardHost).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", {
    timeout: 30_000,
  });
  const rectangleTool = frame.getByTestId("toolbar-rectangle");
  const canvas = frame.locator("canvas.excalidraw__canvas.interactive");
  await rectangleTool.locator("..").click();
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("custody test canvas has no browser box");
  await page.mouse.move(canvasBox.x + 420, canvasBox.y + 320);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 570, canvasBox.y + 410, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator("#viewer-flash")).toContainText("save paused", { timeout: 10_000 });
  await expect(page.locator("#viewer-flash")).toContainText("remains on this canvas");
  await expect
    .poll(async () => (await boardScene(page)).elements.filter((element) => !element.isDeleted))
    .toHaveLength(1);
  await page.waitForTimeout(700);
  expect(browserDraftPuts).toBe(0);
  const draftProbePath = join(workspaceDir, "browser-custody-failure-probe.excalidraw");
  expect(() =>
    tweak(["--json", "whiteboard", "draft", "get", opened.artifactId, "--output", draftProbePath]),
  ).toThrow();
});

test("semantic group membership renders one locked human-visible enclosure", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1400, height: 1050 });
  await allowOnlyLoopback(page);

  const boundaryPath = join(workspaceDir, "semantic-boundary.excalidraw");
  writeFileSync(boundaryPath, EMPTY_BOARD);
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      boundaryPath,
      "--agent",
      "agent:whiteboard-boundary-e2e",
      "--no-browser",
    ]),
  ) as OpenReceipt;
  const scene = (...args: string[]): string =>
    tweak(["--json", "whiteboard", "scene", ...args, "--session", opened.sessionId]);

  scene(
    "add-node",
    boundaryPath,
    "api",
    "--idempotency-key",
    "e2e.boundary.api",
    "--label",
    "Order API",
  );
  scene(
    "add-node",
    boundaryPath,
    "browser",
    "--idempotency-key",
    "e2e.boundary.browser",
    "--label",
    "Review browser",
  );
  scene(
    "add-node",
    boundaryPath,
    "worker",
    "--idempotency-key",
    "e2e.boundary.worker",
    "--label",
    "Order worker",
  );
  scene(
    "add-edge",
    boundaryPath,
    "api-to-worker",
    "--idempotency-key",
    "e2e.boundary.edge",
    "--from",
    "api",
    "--to",
    "worker",
  );
  scene(
    "group",
    boundaryPath,
    "service-boundary",
    "--idempotency-key",
    "e2e.boundary.group",
    "--members",
    "api",
    "worker",
  );
  scene(
    "layout",
    boundaryPath,
    "--idempotency-key",
    "e2e.boundary.layout",
    "--direction",
    "lr",
    "--gap",
    "120",
  );
  const inspected = JSON.parse(
    tweak(["--json", "whiteboard", "scene", "inspect", boundaryPath]),
  ) as {
    scene: { groups: Array<Record<string, unknown>> };
  };
  expect(inspected.scene.groups).toEqual([
    { semanticKey: "service-boundary", members: ["api", "worker"] },
  ]);
  expect(JSON.stringify(inspected)).not.toMatch(
    /group-boundary|elementId|versionNonce|seed|sceneHash/,
  );

  const published = JSON.parse(
    tweak([
      "--json",
      "whiteboard",
      "scene",
      "publish",
      boundaryPath,
      "--idempotency-key",
      "e2e.boundary.publish",
    ]),
  ) as { revisionId: string };
  expect(published.revisionId).toMatch(/^whiteboard-scene-revision_/);
  const review = JSON.parse(
    tweak(["--json", "session", "url", opened.sessionId, "--document", boundaryPath]),
  ) as { url: string };

  await page.goto(review.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  await expect(
    frame.locator('[data-tweakloop-whiteboard][data-tweakloop-whiteboard-mode="standalone"]'),
  ).toHaveAttribute("data-tweakloop-whiteboard-status", "ready", { timeout: 30_000 });
  await expect(frame.locator(".excalidraw")).toBeVisible();

  await expect
    .poll(async () => {
      const visibility = await semanticViewportVisibility(page);
      return {
        count: visibility.elements.length,
        clipped: visibility.elements.filter((row) => !row.fullyVisible),
      };
    })
    .toEqual({
      count: 5,
      clipped: [],
    });
  const visibility = await semanticViewportVisibility(page);
  expect(
    visibility.elements.map(({ semanticKey, role }) => `${role}:${semanticKey}`).sort(),
  ).toEqual([
    "group-boundary:service-boundary",
    "primary:api",
    "primary:api-to-worker",
    "primary:browser",
    "primary:worker",
  ]);
  expect(
    visibility.elements.filter((row) => !row.fullyVisible),
    JSON.stringify(visibility, null, 2),
  ).toEqual([]);

  const rendered = await boardScene(page);
  const metadata = (element: ExcalidrawElement) =>
    (element.customData as { tweakloop?: Record<string, unknown> } | undefined)?.tweakloop;
  const boundary = rendered.elements.find(
    (element) => metadata(element)?.role === "group-boundary",
  );
  const members = rendered.elements.filter(
    (element) =>
      metadata(element)?.role === "primary" &&
      ["api", "worker"].includes(String(metadata(element)?.semanticKey)),
  );
  const outsider = rendered.elements.find(
    (element) =>
      metadata(element)?.role === "primary" && metadata(element)?.semanticKey === "browser",
  );
  expect(boundary).toMatchObject({
    type: "rectangle",
    locked: true,
    strokeStyle: "dashed",
    boundElements: [],
  });
  if (!boundary) throw new Error("semantic group boundary is absent from the rendered board");
  if (!outsider) throw new Error("semantic group outsider is absent from the rendered board");
  expect(Object.hasOwn(boundary, "text")).toBe(false);
  expect(members).toHaveLength(2);
  for (const member of members) {
    expect(boundary.x).toBeLessThan(member.x);
    expect(boundary.y).toBeLessThan(member.y);
    expect(boundary.x + boundary.width).toBeGreaterThan(member.x + member.width);
    expect(boundary.y + boundary.height).toBeGreaterThan(member.y + member.height);
    expect(rendered.elements.indexOf(boundary)).toBeLessThan(rendered.elements.indexOf(member));
  }
  expect(
    outsider.x + outsider.width <= boundary.x ||
      outsider.x >= boundary.x + boundary.width ||
      outsider.y + outsider.height <= boundary.y ||
      outsider.y >= boundary.y + boundary.height,
  ).toBe(true);
  expect(
    rendered.elements.some(
      (element) =>
        metadata(element)?.semanticKey === "service-boundary" &&
        metadata(element)?.role === "label",
    ),
  ).toBe(false);
});
