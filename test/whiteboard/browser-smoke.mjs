import { chromium } from "@playwright/test";

const origin = process.env.TWEAKLOOP_SMOKE_ORIGIN || "http://127.0.0.1:56321";
const hash = "a".repeat(64);
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript((shellOrigin) => {
    window.__TWEAKLOOP__ = {
      artifactId: "artifact-board",
      revisionId: "revision-1",
      shellOrigin,
    };
  }, origin);
  await page.goto(`${origin}/examples/whiteboard-demo.html`);
  await page.evaluate(() => {
    document.body.replaceChildren();
    document.body.style.margin = "0";
    const host = document.createElement("section");
    host.dataset.tweakId = "whiteboard.canvas";
    host.dataset.tweakKind = "whiteboard";
    host.dataset.tweakloopWhiteboard = "";
    host.dataset.tweakloopWhiteboardMode = "standalone";
    host.style.height = "760px";
    const scene = document.createElement("script");
    scene.type = "application/vnd.excalidraw+json";
    scene.textContent = JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://tweakloop.local",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    });
    host.appendChild(scene);
    document.body.appendChild(host);
  });
  await page.addScriptTag({ url: `${origin}/web/bridge/bridge.js` });
  await page.addScriptTag({ url: `${origin}/web/artifact/whiteboard.js`, type: "module" });
  await page.waitForTimeout(5_000);
  const startup = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    body: document.body?.textContent?.slice(0, 120),
    section: document.querySelector('[data-tweak-id="whiteboard.canvas"]')?.outerHTML.slice(0, 250),
    status: document.querySelector("[data-tweakloop-whiteboard]")?.dataset
      .tweakloopWhiteboardStatus,
    state: document.querySelector(".tweakloop-whiteboard__state")?.textContent,
  }));
  if (startup.status !== "ready") {
    throw new Error(`whiteboard startup failed: ${JSON.stringify({ startup, consoleErrors })}`);
  }

  const rectangleTool = page.getByTestId("toolbar-rectangle");
  await rectangleTool.locator("..").click();
  const canvas = page.locator("canvas.excalidraw__canvas.interactive");
  const canvasBox = await canvas.boundingBox();
  if (!canvasBox) throw new Error("interactive Excalidraw canvas has no browser box");
  await page.mouse.move(canvasBox.x + 320, canvasBox.y + 240);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + 480, canvasBox.y + 340, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    () =>
      window.__TWEAKLOOP_WHITEBOARDS__
        ?.get("whiteboard.canvas")
        ?.getScene()
        .elements.filter((element) => !element.isDeleted).length === 1,
  );
  await page.waitForFunction(() => {
    const element = window.__TWEAKLOOP_WHITEBOARDS__
      ?.get("whiteboard.canvas")
      ?.getScene()
      .elements.find((candidate) => !candidate.isDeleted);
    return Boolean(element && element.width > 0 && element.height > 0);
  });
  await page.waitForTimeout(450);

  const before = await page.evaluate(() => {
    const board = window.__TWEAKLOOP_WHITEBOARDS__.get("whiteboard.canvas");
    const scene = board.getScene();
    const node = board.getNodes()[0];
    return {
      scene,
      node,
      camera: {
        scrollX: scene.appState.scrollX,
        scrollY: scene.appState.scrollY,
        zoom: scene.appState.zoom,
      },
    };
  });
  if (before.node.boardAnchor.whiteboardArtifactId !== "artifact-board") {
    throw new Error("selection target omitted canonical whiteboardArtifactId");
  }
  if (before.node.boardAnchor.baseRevisionId !== "revision-1") {
    throw new Error("selection target omitted canonical baseRevisionId");
  }
  for (const field of ["type", "version", "versionNonce", "label"]) {
    if (before.node.boardAnchor.elementAnchor[field] == null) {
      throw new Error(`selection target omitted elementAnchor.${field}`);
    }
  }

  const remoteScene = structuredClone(before.scene);
  remoteScene.elements[0].x += 37;
  remoteScene.elements[0].version += 1;
  remoteScene.elements[0].versionNonce += 1;
  await page.route(`${origin}/objects/sha256/${hash}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/vnd.excalidraw+json",
      body: JSON.stringify(remoteScene),
    }),
  );

  await page.evaluate(() => {
    const channel = new MessageChannel();
    window.__whiteboardReceipts = [];
    channel.port1.onmessage = (event) => window.__whiteboardReceipts.push(event.data);
    channel.port1.start();
    window.__whiteboardShellPort = channel.port1;
    window.postMessage(
      { protocol: "tweakloop.bridge/v1", type: "connect" },
      window.location.origin,
      [channel.port2],
    );
  });
  await page.waitForFunction(() =>
    window.__whiteboardReceipts?.some((item) => item.type === "ready"),
  );
  await page.evaluate(
    ({ objectHash }) => {
      window.__whiteboardReceipts = [];
      window.__sceneTimeline = [];
      window.__sceneTimelineTimer = window.setInterval(() => {
        const elements = window.__TWEAKLOOP_WHITEBOARDS__
          ?.get("whiteboard.canvas")
          ?.getScene().elements;
        window.__sceneTimeline.push(
          elements?.map(({ id, x, version, versionNonce }) => ({ id, x, version, versionNonce })),
        );
      }, 5);
      window.__whiteboardShellPort.postMessage({
        protocol: "tweakloop.bridge/v1",
        type: "apply-whiteboard-object",
        payload: {
          requestId: "remote-1",
          whiteboardArtifactId: "artifact-board",
          baseRevisionId: "revision-2",
          sceneHash: objectHash,
          sceneUrl: `/objects/sha256/${objectHash}`,
          draftId: "draft-agent",
          draftVersion: 4,
        },
      });
    },
    { objectHash: hash },
  );
  await page.waitForFunction(() =>
    window.__whiteboardReceipts?.some((item) => item.type === "whiteboard-object-applied"),
  );
  await page.waitForTimeout(450);

  const after = await page.evaluate(() => {
    window.clearInterval(window.__sceneTimelineTimer);
    const board = window.__TWEAKLOOP_WHITEBOARDS__.get("whiteboard.canvas");
    const scene = board.getScene();
    return {
      scene,
      node: board.getNodes()[0],
      receipts: window.__whiteboardReceipts,
      timeline: window.__sceneTimeline,
      camera: {
        scrollX: scene.appState.scrollX,
        scrollY: scene.appState.scrollY,
        zoom: scene.appState.zoom,
      },
    };
  });
  if (!after.scene.elements[0]) {
    throw new Error(
      `remote scene disappeared: ${JSON.stringify({
        before: before.scene.elements,
        remote: remoteScene.elements,
        receipts: after.receipts,
        timeline: after.timeline,
        consoleErrors,
      })}`,
    );
  }
  if (after.scene.elements[0].x !== remoteScene.elements[0].x) {
    throw new Error("remote immutable object was not applied");
  }
  if (JSON.stringify(after.camera) !== JSON.stringify(before.camera)) {
    throw new Error("remote scene application reset the local camera");
  }
  if (after.node.boardAnchor.baseRevisionId !== "revision-2") {
    throw new Error("remote scene metadata did not update the durable target");
  }
  if (
    after.node.boardAnchor.draftId !== "draft-agent" ||
    after.node.boardAnchor.draftVersion !== 4
  ) {
    throw new Error("remote draft metadata did not update the durable target");
  }
  const applied = after.receipts.find((item) => item.type === "whiteboard-object-applied")?.payload;
  if (
    applied?.requestId !== "remote-1" ||
    applied.whiteboardArtifactId !== "artifact-board" ||
    applied.baseRevisionId !== "revision-2" ||
    applied.sceneHash !== hash ||
    applied.draftId !== "draft-agent" ||
    applied.draftVersion !== 4 ||
    applied.elementCount !== 1
  ) {
    throw new Error(`remote apply receipt identity mismatch: ${JSON.stringify(applied)}`);
  }
  if (after.receipts.some((item) => item.type === "whiteboard-change")) {
    throw new Error("remote scene application echoed as a human-authored change");
  }
  if (consoleErrors.length > 0)
    throw new Error(`browser console errors: ${consoleErrors.join(" | ")}`);

  process.stdout.write(
    `${JSON.stringify({
      status: "passed",
      elements: after.scene.elements.filter((element) => !element.isDeleted).length,
      target: after.node.boardAnchor,
      receipt: after.receipts.find((item) => item.type === "whiteboard-object-applied")?.type,
      cameraStable: true,
      echoed: false,
    })}\n`,
  );
} finally {
  await browser.close();
}
