import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonConnection } from "../../src/cli/daemon-client.js";
import { exportWorkspace } from "../../src/cli/workspace-export.js";
import { createForkedWorkspaceBundle } from "../../src/cli/workspace-fork.js";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import type { WorkspaceExportManifest } from "../../src/protocol/workspace-export.js";
import { writeWorkspaceBundleEnvelope } from "../../src/workspace/files.js";
import { createWorkspaceRestoreStore } from "../../src/workspace/restore.js";

let stateRoot: string;
let sourceRoot: string;
let daemon: DaemonHandle;
const additionalDaemons: DaemonHandle[] = [];

beforeEach(async () => {
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-semantic-portability-state-"));
  sourceRoot = mkdtempSync(join(tmpdir(), "tweakloop-semantic-portability-source-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: sourceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  for (const handle of additionalDaemons.splice(0)) handle.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(sourceRoot, { recursive: true, force: true });
});

function connection(handle: DaemonHandle): DaemonConnection {
  return {
    baseUrl: `http://127.0.0.1:${handle.shellPort}`,
    token: handle.cliToken,
    descriptor: {
      pid: process.pid,
      startNonce: "focused-portability-test",
      shellPort: handle.shellPort,
      artifactPort: handle.artifactPort,
      protocolVersion: 1,
      workspaceId: handle.workspaceId,
      cliToken: handle.cliToken,
    },
  };
}

function board(label: string): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://tweakloop.local",
    elements: [
      {
        id: "unmanaged-title",
        type: "text",
        x: 20,
        y: 20,
        width: 100,
        height: 30,
        version: 1,
        versionNonce: 1,
        seed: 1,
        text: label,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });
}

async function publishSource(path: string): Promise<{ artifactId: string; revisionId: string }> {
  const response = await fetch(`${connection(daemon).baseUrl}/api/v1/publish`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path, actor: { kind: "agent", id: "portability" } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { artifactId: string; revisionId: string };
}

async function command(handle: DaemonHandle, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${handle.shellPort}/api/v1/commands`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${handle.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function mintAutomationToken(
  handle: DaemonHandle,
  sessionId: string,
  runtimeCapability: string,
  request: Record<string, unknown>,
): Promise<string> {
  const response = await fetch(
    `http://127.0.0.1:${handle.shellPort}/api/v1/automation/whiteboard-tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${handle.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "tweakloop.whiteboard-automation-mint/v1",
        sessionId,
        runtimeCapability,
        artifactId: request.artifactId,
        method: "POST",
        operationId: "whiteboard.semantic-scene.apply.v1",
        routeSetVersion: 1,
        request,
      }),
    },
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { automationToken: string }).automationToken;
}

describe("semantic whiteboard workspace portability", () => {
  it("exports every receipt, restores exact replay with local draft identity, and keeps two forks independent", async () => {
    const sourcePath = join(sourceRoot, "portable.excalidraw");
    writeFileSync(sourcePath, board("portable base"));
    const published = await publishSource(sourcePath);
    const sessionId = "session_semantic_portability";
    const sourceRuntimeCapability = "semantic-portability-runtime-capability";
    const started = await command(daemon, {
      protocol: "tweakloop.command/v1",
      commandId: "command_semantic_portability_session",
      idempotencyKey: "semantic-portability-session",
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "portability" },
      type: "session.start",
      payload: {
        sessionId,
        artifactId: published.artifactId,
        agentId: "portability",
        processNonce: "process_semantic_portability",
        runtimeCapabilityHash: createHash("sha256").update(sourceRuntimeCapability).digest("hex"),
        baseRevisionId: published.revisionId,
        title: "Semantic portability",
        goal: "Prove semantic receipt portability",
      },
    });
    expect(started.status).toBe(200);

    const request = {
      protocol: "tweakloop.whiteboard-scene-command/v1",
      artifactId: published.artifactId,
      idempotencyKey: "semantic-portability-first",
      operations: [{ type: "node.upsert", semanticKey: "api", label: "API" }],
    };
    const firstToken = await mintAutomationToken(
      daemon,
      sessionId,
      sourceRuntimeCapability,
      request,
    );
    const first = await fetch(
      `${connection(daemon).baseUrl}/api/v1/whiteboards/${published.artifactId}/scene-commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${firstToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
    expect(first.status).toBe(200);
    const originalResponseJson = await first.text();
    const secondRequest = {
      ...request,
      idempotencyKey: "semantic-portability-second",
      operations: [{ type: "label.set", target: "api", text: "API v2" }],
    };
    const secondToken = await mintAutomationToken(
      daemon,
      sessionId,
      sourceRuntimeCapability,
      secondRequest,
    );
    const second = await fetch(
      `${connection(daemon).baseUrl}/api/v1/whiteboards/${published.artifactId}/scene-commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secondToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(secondRequest),
      },
    );
    expect(second.status).toBe(200);

    const bundleRoot = join(stateRoot, "source-bundle");
    const manifest = await exportWorkspace(connection(daemon), sourceRoot, bundleRoot);
    const envelope = writeWorkspaceBundleEnvelope({
      bundleRoot,
      includeWorkspaceFiles: false,
      observedEndSeq: manifest.capturedSeq,
    });
    expect(envelope).toMatchObject({
      protocol: "tweakloop.workspace-bundle/v2",
      workspaceFiles: null,
      capture: {
        collaboration: {
          capturedSeq: manifest.capturedSeq,
          observedEndSeq: manifest.capturedSeq,
          consistency: "event-seq-exact",
        },
        workspaceFiles: null,
      },
    });
    expect(JSON.stringify(manifest)).not.toContain(sourceRuntimeCapability);
    expect(manifest.whiteboardSemanticReceipts).toHaveLength(2);
    expect(
      manifest.whiteboardSemanticReceipts?.map(
        (entry) => (entry.receipt as { idempotencyKey: string }).idempotencyKey,
      ),
    ).toEqual(["semantic-portability-first", "semantic-portability-second"]);
    const sourceEntry = manifest.whiteboardSemanticReceipts?.find(
      (entry) =>
        (entry.receipt as { idempotencyKey: string }).idempotencyKey ===
        "semantic-portability-first",
    );
    expect(sourceEntry).toMatchObject({
      receipt: {
        workspaceId: daemon.workspaceId,
        artifactId: published.artifactId,
        idempotencyKey: "semantic-portability-first",
        responseJson: originalResponseJson,
      },
    });
    expect(sourceEntry?.draftId).toEqual(expect.any(String));
    expect(existsSync(join(bundleRoot, sourceEntry?.sceneObject.objectPath ?? "missing"))).toBe(
      true,
    );
    expect(
      existsSync(join(bundleRoot, sourceEntry?.elementIndexObject.objectPath ?? "missing")),
    ).toBe(true);

    const destinationRoot = join(stateRoot, "restored-workspace");
    const restoreStore = createWorkspaceRestoreStore(join(stateRoot, "restore-staging"));
    const plan = restoreStore.begin(manifest);
    for (const path of plan.requiredPaths) {
      restoreStore.put(plan.restoreId, path, readFileSync(join(bundleRoot, ...path.split("/"))));
    }
    mkdirSync(destinationRoot);
    const restored = await startDaemon({
      rootPath: destinationRoot,
      restore: restoreStore.complete(plan.restoreId),
      log: () => {},
    });
    additionalDaemons.push(restored);
    const sourceAuthorityDidNotTravel = await fetch(
      `http://127.0.0.1:${restored.shellPort}/api/v1/automation/whiteboard-tokens`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${restored.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "tweakloop.whiteboard-automation-mint/v1",
          sessionId,
          runtimeCapability: sourceRuntimeCapability,
          artifactId: request.artifactId,
          method: "POST",
          operationId: "whiteboard.semantic-scene.apply.v1",
          routeSetVersion: 1,
          request,
        }),
      },
    );
    expect(sourceAuthorityDidNotTravel.status).toBe(403);
    const restoredSessionId = "session_semantic_portability_restored";
    const restoredRuntimeCapability = "restored-semantic-portability-runtime-capability";
    const resumed = await command(restored, {
      protocol: "tweakloop.command/v1",
      commandId: "command_semantic_portability_restored",
      idempotencyKey: "semantic-portability-restored",
      workspaceId: restored.workspaceId,
      actor: { kind: "agent", id: "portability" },
      type: "session.resume",
      payload: {
        sessionId: restoredSessionId,
        predecessorSessionId: sessionId,
        agentId: "portability",
        processNonce: "process_semantic_portability_restored",
        runtimeCapabilityHash: createHash("sha256").update(restoredRuntimeCapability).digest("hex"),
        baseRevisionId: published.revisionId,
        title: null,
        goal: null,
      },
    });
    expect(resumed.status).toBe(200);
    const restoredToken = await mintAutomationToken(
      restored,
      restoredSessionId,
      restoredRuntimeCapability,
      request,
    );
    const restoredReplay = await fetch(
      `http://127.0.0.1:${restored.shellPort}/api/v1/whiteboards/${published.artifactId}/scene-commands`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${restoredToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
      },
    );
    expect(restoredReplay.status).toBe(200);
    expect(await restoredReplay.text()).toBe(originalResponseJson);
    const restoredReceipts = (await (
      await fetch(`http://127.0.0.1:${restored.shellPort}/api/v1/whiteboard-semantic-receipts`, {
        headers: { authorization: `Bearer ${restored.cliToken}` },
      })
    ).json()) as { draftId: string; receipt: { workspaceId: string; sourceProvenance: unknown } }[];
    const restoredFirst = restoredReceipts.find(
      (entry) =>
        (entry.receipt as { idempotencyKey?: string }).idempotencyKey ===
        "semantic-portability-first",
    );
    expect(restoredReceipts).toHaveLength(2);
    expect(restoredFirst).toMatchObject({
      receipt: {
        workspaceId: restored.workspaceId,
        sourceProvenance: { workspaceId: daemon.workspaceId },
      },
    });
    expect(restoredFirst?.draftId).not.toBe(sourceEntry?.draftId);

    const forkOne = createForkedWorkspaceBundle({
      sourceBundle: bundleRoot,
      destinationBundle: join(stateRoot, "fork-one-bundle"),
      destinationWorkspaceRoot: join(stateRoot, "fork-one-workspace"),
      sourceSessionId: sessionId,
      destinationAgentId: "portability",
      newId: (() => {
        let serial = 0;
        return () => `fork_one_${++serial}`;
      })(),
    });
    const forkTwo = createForkedWorkspaceBundle({
      sourceBundle: bundleRoot,
      destinationBundle: join(stateRoot, "fork-two-bundle"),
      destinationWorkspaceRoot: join(stateRoot, "fork-two-workspace"),
      sourceSessionId: sessionId,
      destinationAgentId: "portability",
      newId: (() => {
        let serial = 0;
        return () => `fork_two_${++serial}`;
      })(),
    });
    const forkOneEntry = forkOne.manifest.whiteboardSemanticReceipts?.[0];
    const forkTwoEntry = forkTwo.manifest.whiteboardSemanticReceipts?.[0];
    expect(forkOneEntry).toBeDefined();
    expect(forkTwoEntry).toBeDefined();
    if (!forkOneEntry || !forkTwoEntry) throw new Error("fork receipt disappeared");
    expect((forkOneEntry.receipt as { workspaceId: string }).workspaceId).toBe(
      forkOne.manifest.source.workspaceId,
    );
    expect((forkTwoEntry.receipt as { workspaceId: string }).workspaceId).toBe(
      forkTwo.manifest.source.workspaceId,
    );
    expect(forkOneEntry.draftId).not.toBe(forkTwoEntry.draftId);
    expect((forkOneEntry.receipt as { responseJson: string }).responseJson).toBe(
      originalResponseJson,
    );
    expect((forkTwoEntry.receipt as { responseJson: string }).responseJson).toBe(
      originalResponseJson,
    );

    const foreign = JSON.parse(JSON.stringify(manifest)) as WorkspaceExportManifest;
    (foreign.whiteboardSemanticReceipts?.[0]?.receipt as { workspaceId: string }).workspaceId =
      "workspace_foreign";
    const forbiddenDestination = join(stateRoot, "foreign-restore-must-not-exist");
    expect(() =>
      createWorkspaceRestoreStore(join(stateRoot, "foreign-restore-staging")).begin(foreign),
    ).toThrow(/does not belong to this source whiteboard workspace/);
    const corruptMapping = JSON.parse(JSON.stringify(manifest)) as WorkspaceExportManifest;
    if (corruptMapping.whiteboardSemanticReceipts?.[0]) {
      (corruptMapping.whiteboardSemanticReceipts[0] as { draftId: string | null }).draftId = null;
    }
    expect(() =>
      createWorkspaceRestoreStore(join(stateRoot, "mapping-restore-staging")).begin(corruptMapping),
    ).toThrow(/invalid draft mapping/);
    expect(existsSync(forbiddenDestination)).toBe(false);
  });
});
