import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

declare global {
  interface Window {
    __startWasVisible: boolean;
  }
}

const cli = process.env.TWEAKLOOP_E2E_CLI
  ? realpathSync(process.env.TWEAKLOOP_E2E_CLI)
  : fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const consumer = fileURLToPath(
  new URL("./fixtures/path-blind-agent-consumer.mjs", import.meta.url),
);
const AGENT_ID = "onboarding-e2e";
const PROCESS_NONCE = "process-onboarding-e2e";
const HTML_NONCE = `human-only-${randomUUID()}`;
const MARKDOWN_NONCE = `markdown-only-${randomUUID()}`;
const HUMAN_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Human-selected design</title></head>
<body><main><h1>Human-selected design</h1><p>${HTML_NONCE}</p></main></body>
</html>\n`;
const HUMAN_MARKDOWN = `# Human-selected notes\n\n${MARKDOWN_NONCE}\n`;

type RuntimeDescriptor = {
  shellPort: number;
  artifactPort: number;
  workspaceId: string;
  cliToken: string;
};

type ConsumerConnection = {
  shellOrigin: string;
  artifactOrigin: string;
  cliToken: string;
  sessionId: string;
  agentId: string;
  processNonce: string;
  afterSeq: number;
};

type CommandReceipt = { status: string };
type BootstrapReceipt = { url: string };
type SessionArtifactRow = { sessionId: string; artifactId: string };
type WorkspaceSnapshot = {
  workspace?: { workspaceId: string };
  artifacts: unknown[];
  revisions: unknown[];
  sessionArtifacts?: SessionArtifactRow[];
  lastSeq: number;
};
type OnboardingReceipt = {
  artifactId: string;
  revisionId: string;
  sessionId: string;
};

let stateDir: string;
let workspaceDir: string;
let htmlPath: string;
let markdownPath: string;
let env: NodeJS.ProcessEnv;
let launcherStateDir: string | null = null;
let launcherWorkspaceDir: string | null = null;
let exportParentDir: string | null = null;

function tweakAt(root: string, processEnv: NodeJS.ProcessEnv, args: string[]): string {
  return execFileSync(process.execPath, [cli, "--workspace", root, ...args], {
    env: processEnv,
    encoding: "utf8",
  });
}

function tweak(args: string[]): string {
  return tweakAt(workspaceDir, env, args);
}

function workspaceId(root = workspaceDir): string {
  return `ws_${createHash("sha256").update(realpathSync(root)).digest("hex").slice(0, 16)}`;
}

function runtime(root = workspaceDir, runtimeStateDir = stateDir): RuntimeDescriptor {
  return JSON.parse(
    readFileSync(
      join(runtimeStateDir, "tweakloop", "workspaces", workspaceId(root), "runtime.json"),
      "utf8",
    ),
  ) as RuntimeDescriptor;
}

async function daemonJson<T extends object>(
  descriptor: RuntimeDescriptor,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`http://127.0.0.1:${descriptor.shellPort}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${descriptor.cliToken}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const data = (await response.json()) as T & { message?: string; error?: string };
  if (!response.ok) throw new Error(`${path}: ${data.message ?? data.error ?? response.status}`);
  return data;
}

async function startEmptySession(
  descriptor: RuntimeDescriptor,
  sessionId = `session_${randomUUID()}`,
  assertWorkspaceEmpty = true,
): Promise<{ sessionId: string; url: string; baselineSeq: number }> {
  const command = await daemonJson<CommandReceipt>(descriptor, "/api/v1/commands", {
    method: "POST",
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: randomUUID(),
      idempotencyKey: `session.start:${sessionId}`,
      workspaceId: descriptor.workspaceId,
      actor: { kind: "agent", id: AGENT_ID },
      type: "session.start",
      payload: {
        sessionId,
        artifactId: null,
        agentId: AGENT_ID,
        processNonce: PROCESS_NONCE,
        baseRevisionId: null,
        title: "Fresh onboarding collaboration",
        goal: "Create a whiteboard, then add a human-selected design",
      },
    }),
  });
  expect(command.status).toBe("accepted");
  const snapshot = await daemonJson<WorkspaceSnapshot>(descriptor, "/api/v1/snapshot");
  if (assertWorkspaceEmpty) {
    expect(snapshot.artifacts).toHaveLength(0);
    expect(snapshot.revisions).toHaveLength(0);
    expect(snapshot.sessionArtifacts ?? []).toHaveLength(0);
  } else {
    expect(
      snapshot.sessionArtifacts?.filter((artifact) => artifact.sessionId === sessionId),
    ).toHaveLength(0);
  }
  const minted = await daemonJson<BootstrapReceipt>(descriptor, "/api/v1/bootstrap-tokens", {
    method: "POST",
    body: JSON.stringify({ artifactId: null, agentId: AGENT_ID, sessionId }),
  });
  return { sessionId, url: minted.url, baselineSeq: snapshot.lastSeq };
}

function consumerConnection(
  descriptor: RuntimeDescriptor,
  sessionId: string,
  afterSeq: number,
): ConsumerConnection {
  return {
    shellOrigin: `http://127.0.0.1:${descriptor.shellPort}`,
    artifactOrigin: `http://127.0.0.1:${descriptor.artifactPort}`,
    cliToken: descriptor.cliToken,
    sessionId,
    agentId: AGENT_ID,
    processNonce: PROCESS_NONCE,
    afterSeq,
  };
}

function runConsumer(connection: ConsumerConnection, suppress = false) {
  return spawnSync(process.execPath, [consumer, ...(suppress ? ["--suppress-attachments"] : [])], {
    env: {
      ...process.env,
      TWEAKLOOP_CONSUMER_CONNECTION: JSON.stringify(connection),
    },
    encoding: "utf8",
  });
}

async function allowOnlyLoopback(page: Page): Promise<void> {
  await page.route(/https?:\/\/.*/, async (route) => {
    const host = new URL(route.request().url()).hostname;
    if (host === "127.0.0.1" || host === "localhost") await route.continue();
    else await route.abort("blockedbyclient");
  });
}

test.beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-onboarding-e2e-state-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "tweakloop-onboarding-e2e-ws-"));
  htmlPath = join(workspaceDir, "human-selected-design.html");
  markdownPath = join(workspaceDir, "human-selected-notes.md");
  writeFileSync(htmlPath, HUMAN_HTML);
  writeFileSync(markdownPath, HUMAN_MARKDOWN);
  env = { ...process.env, TWEAKLOOP_STATE_DIR: stateDir };
  tweak(["daemon", "start"]);
});

test.afterAll(() => {
  try {
    tweak(["daemon", "stop"]);
  } catch {
    // The test may intentionally restart the daemon.
  }
  if (launcherWorkspaceDir && launcherStateDir) {
    try {
      tweakAt(launcherWorkspaceDir, { ...process.env, TWEAKLOOP_STATE_DIR: launcherStateDir }, [
        "daemon",
        "stop",
      ]);
    } catch {
      // The restore launcher may already have stopped with its child daemon.
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
  if (launcherStateDir) rmSync(launcherStateDir, { recursive: true, force: true });
  if (launcherWorkspaceDir) rmSync(launcherWorkspaceDir, { recursive: true, force: true });
  if (exportParentDir) rmSync(exportParentDir, { recursive: true, force: true });
});

test("fresh START creates one board, imports exact bytes, and survives replay", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await allowOnlyLoopback(page);
  const initialRuntime = runtime();
  const started = await startEmptySession(initialRuntime);

  await page.goto(started.url);
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(page.getByTestId("start-surface")).toBeVisible();
  await expect(page.getByTestId("workspace-shell")).toBeVisible();
  await expect(page.locator("#outline-rail")).toBeVisible();
  await expect(page.locator("#agent-rail")).toBeVisible();
  await expect(page.locator("#artifact-toolbar")).toBeHidden();
  await expect(page.locator("#documents-empty")).toHaveText("No documents yet");
  await expect(page.locator("#start-agent-assurance")).toContainText(
    `${AGENT_ID} is assigned but offline`,
  );

  const newWhiteboard = page.getByTestId("start-new-whiteboard");
  await newWhiteboard.focus();
  await expect(newWhiteboard).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("document-item")).toHaveCount(1);
  await expect(page.getByTestId("start-surface")).toBeHidden();
  await expect(page.getByTestId("document-add")).toBeVisible();
  await expect(page.getByTestId("viewer-frame")).toBeFocused();

  const duplicateReceipts: OnboardingReceipt[] = [];
  await page.route("**/api/v1/session-artifacts", async (route) => {
    const first = await route.fetch();
    const second = await route.fetch();
    duplicateReceipts.push(
      (await first.json()) as OnboardingReceipt,
      (await second.json()) as OnboardingReceipt,
    );
    await route.fulfill({ response: first });
  });
  await page.getByTestId("document-add").click();
  await page.locator("#document-open-files").click();
  await page.getByTestId("artifact-file-input").setInputFiles([htmlPath, markdownPath]);
  await expect(page.getByTestId("document-item")).toHaveCount(3);
  await expect(page.locator("#onboarding-progress")).toContainText("2 documents added");
  expect(duplicateReceipts).toHaveLength(4);
  for (let index = 0; index < duplicateReceipts.length; index += 2) {
    expect(duplicateReceipts[index + 1]).toMatchObject({
      artifactId: duplicateReceipts[index].artifactId,
      revisionId: duplicateReceipts[index].revisionId,
      sessionId: started.sessionId,
    });
  }
  await page.unroute("**/api/v1/session-artifacts");

  const durable = await daemonJson<WorkspaceSnapshot>(initialRuntime, "/api/v1/snapshot");
  expect(durable.artifacts).toHaveLength(3);
  expect(durable.revisions).toHaveLength(3);
  expect(
    durable.sessionArtifacts?.filter((item) => item.sessionId === started.sessionId),
  ).toHaveLength(3);

  const connection = consumerConnection(initialRuntime, started.sessionId, started.baselineSeq);
  const received = runConsumer(connection);
  expect(received.status, received.stderr).toBe(0);
  const consumed = JSON.parse(received.stdout) as {
    attachments: number;
    artifacts: Array<{ text: string; hash: string }>;
  };
  expect(consumed.attachments).toBe(3);
  expect(consumed.artifacts.some((artifact) => artifact.text.includes(HTML_NONCE))).toBe(true);
  expect(consumed.artifacts.some((artifact) => artifact.text.includes(MARKDOWN_NONCE))).toBe(true);

  const suppressed = runConsumer(connection, true);
  expect(suppressed.status).toBe(3);
  expect(suppressed.stderr).toContain("no matching session.artifact-attached event");

  const wrongNeighbor = await startEmptySession(
    initialRuntime,
    `session_wrong_neighbor_${randomUUID()}`,
    false,
  );
  const misrouted = runConsumer(
    consumerConnection(initialRuntime, wrongNeighbor.sessionId, started.baselineSeq),
  );
  expect(misrouted.status).toBe(3);

  await page.addInitScript(() => {
    window.__startWasVisible = false;
    const inspect = () => {
      const surface = document.querySelector("#start-surface") as HTMLElement | null;
      if (surface && !surface.hidden) window.__startWasVisible = true;
    };
    new MutationObserver(inspect).observe(document, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    addEventListener("DOMContentLoaded", inspect);
  });
  await page.reload();
  await expect(page.getByTestId("document-item")).toHaveCount(3);
  expect(await page.evaluate(() => window.__startWasVisible)).toBe(false);

  tweak(["daemon", "stop"]);
  tweak(["daemon", "start"]);
  const restartedRuntime = runtime();
  const replayBootstrap = await daemonJson<BootstrapReceipt>(
    restartedRuntime,
    "/api/v1/bootstrap-tokens",
    {
      method: "POST",
      body: JSON.stringify({
        artifactId: duplicateReceipts[0].artifactId,
        agentId: AGENT_ID,
        sessionId: started.sessionId,
      }),
    },
  );
  await page.goto(replayBootstrap.url);
  await expect(page.getByTestId("document-item")).toHaveCount(3);
  const replayed = runConsumer(
    consumerConnection(restartedRuntime, started.sessionId, started.baselineSeq),
  );
  expect(replayed.status, replayed.stderr).toBe(0);
  expect(JSON.parse(replayed.stdout).artifacts).toHaveLength(3);

  exportParentDir = mkdtempSync(join(tmpdir(), "tweakloop-onboarding-export-"));
  const exportDir = join(exportParentDir, "saved-workspace");
  const exported = JSON.parse(tweak(["--json", "workspace", "export", exportDir])) as {
    protocol: string;
  };
  expect(exported.protocol).toBe("tweakloop.workspace-export/v1");
  const splicedExportDir = join(exportParentDir, "spliced-workspace");
  cpSync(exportDir, splicedExportDir, { recursive: true });
  const splicedManifestPath = join(splicedExportDir, ".tweakloop", "export-manifest.json");
  writeFileSync(splicedManifestPath, `${readFileSync(splicedManifestPath, "utf8")} `);

  launcherStateDir = mkdtempSync(join(tmpdir(), "tweakloop-restore-launcher-state-"));
  launcherWorkspaceDir = mkdtempSync(join(tmpdir(), "tweakloop-restore-launcher-ws-"));
  const launcherEnv = { ...process.env, TWEAKLOOP_STATE_DIR: launcherStateDir };
  tweakAt(launcherWorkspaceDir, launcherEnv, ["daemon", "start"]);
  const launcherRuntime = runtime(launcherWorkspaceDir, launcherStateDir);
  const launcherSession = await startEmptySession(launcherRuntime);
  await page.goto(launcherSession.url);
  await expect(page.getByTestId("start-surface")).toBeVisible();
  await page.getByTestId("start-open-workspace").click();
  let boundRestoreBeginRequests = 0;
  const countRestoreBegin = (request: { method(): string; url(): string }) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/v1/workspace-restores"
    ) {
      boundRestoreBeginRequests += 1;
    }
  };
  page.on("request", countRestoreBegin);
  await page.getByTestId("workspace-directory-input").setInputFiles(splicedExportDir);
  await expect(page.locator("#onboarding-recovery")).toContainText(
    "does not match its bound envelope",
  );
  expect(boundRestoreBeginRequests).toBe(0);
  const launcherBeforeRestore = await daemonJson<WorkspaceSnapshot>(
    launcherRuntime,
    "/api/v1/snapshot",
  );
  expect(launcherBeforeRestore.artifacts).toHaveLength(0);
  await page.getByTestId("workspace-directory-input").setInputFiles(exportDir);
  await expect(page.locator("#onboarding-recovery")).toBeHidden();
  const restoreOutcome = await Promise.race([
    page
      .waitForURL((url) => url.port !== String(launcherRuntime.shellPort), { timeout: 30_000 })
      .then(() => "navigated"),
    page
      .locator("#onboarding-recovery")
      .waitFor({ state: "visible", timeout: 30_000 })
      .then(() => "recovery"),
  ]);
  if (restoreOutcome === "recovery") {
    throw new Error(
      `restore UI rejected the saved workspace: ${await page.locator("#onboarding-recovery").textContent()}`,
    );
  }
  page.off("request", countRestoreBegin);
  expect(boundRestoreBeginRequests).toBe(1);
  const restoredPort = new URL(page.url()).port;
  expect(restoredPort).not.toBe(String(restartedRuntime.shellPort));
  await expect(page.getByTestId("document-item")).toHaveCount(3);
  const restoredSnapshot = (await page.evaluate(async () => {
    const response = await fetch("/api/v1/snapshot");
    return response.json();
  })) as WorkspaceSnapshot;
  expect(restoredSnapshot.artifacts).toHaveLength(3);
  expect(restoredSnapshot.workspace?.workspaceId).not.toBe(initialRuntime.workspaceId);
  expect(restoredSnapshot.workspace?.workspaceId).not.toBe(launcherRuntime.workspaceId);
});
