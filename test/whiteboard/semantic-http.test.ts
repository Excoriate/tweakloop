import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import { SEMANTIC_SCENE_REQUEST_PROTOCOL } from "../../src/whiteboard/semantic-scene.js";

let stateDir: string;
let workspaceRoot: string;
let daemon: DaemonHandle;
let activeSessionId: string;
let runtimeCapability: string;
let daemonLogs: string[];

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-semantic-http-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-semantic-http-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateDir;
  daemonLogs = [];
  daemon = await startDaemon({ rootPath: workspaceRoot, log: (line) => daemonLogs.push(line) });
  activeSessionId = "session-semantic-http";
  runtimeCapability = "semantic-http-runtime-capability-0001";
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function shell(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

async function publishEmptyBoard(): Promise<{ artifactId: string; revisionId: string }> {
  const source = join(workspaceRoot, "semantic.excalidraw");
  writeFileSync(
    source,
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://tweakloop.local",
      elements: [],
      appState: { viewBackgroundColor: "#ffffff" },
      files: {},
    }),
  );
  const response = await fetch(shell("/api/v1/publish"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path: source, actor: { kind: "agent", id: "fixture" } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { artifactId: string; revisionId: string };
}

function semanticRequest(artifactId: string, label = "API") {
  return {
    protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
    artifactId,
    idempotencyKey: "semantic-http-1",
    operations: [{ type: "node.upsert", semanticKey: "api", label }],
  };
}

async function startAutomationSession(
  artifactId: string,
  revisionId: string,
  options: Readonly<{ resumeFrom?: string }> = {},
): Promise<void> {
  const type = options.resumeFrom ? "session.resume" : "session.start";
  const payload = options.resumeFrom
    ? {
        sessionId: activeSessionId,
        predecessorSessionId: options.resumeFrom,
        agentId: "codex",
        processNonce: `process-${activeSessionId}`,
        runtimeCapabilityHash: createHash("sha256").update(runtimeCapability).digest("hex"),
        baseRevisionId: revisionId,
        title: null,
        goal: null,
      }
    : {
        sessionId: activeSessionId,
        artifactId,
        agentId: "codex",
        processNonce: `process-${activeSessionId}`,
        runtimeCapabilityHash: createHash("sha256").update(runtimeCapability).digest("hex"),
        baseRevisionId: revisionId,
        title: "Semantic HTTP",
        goal: "Exercise capability-holder automation",
      };
  const response = await fetch(shell("/api/v1/commands"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command-${activeSessionId}`,
      idempotencyKey: `${type}:${activeSessionId}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "codex" },
      type,
      payload,
    }),
  });
  expect(response.status).toBe(200);
}

async function mintAutomationToken(request: ReturnType<typeof semanticRequest>): Promise<string> {
  const response = await fetch(shell("/api/v1/automation/whiteboard-tokens"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.whiteboard-automation-mint/v1",
      sessionId: activeSessionId,
      runtimeCapability,
      artifactId: request.artifactId,
      method: "POST",
      operationId: "whiteboard.semantic-scene.apply.v1",
      routeSetVersion: 1,
      request,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { automationToken: string }).automationToken;
}

async function postSceneCommand(artifactId: string, label = "API"): Promise<Response> {
  const request = semanticRequest(artifactId, label);
  const automationToken = await mintAutomationToken(request);
  return postSceneWithToken(request, automationToken);
}

async function postSceneWithToken(
  request: ReturnType<typeof semanticRequest>,
  automationToken: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(shell(`/api/v1/whiteboards/${request.artifactId}/scene-commands`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${automationToken}`,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(request),
  });
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
): Promise<string> {
  const decoder = new TextDecoder();
  let observed = "";
  for (let reads = 0; reads < 12 && !observed.includes(needle); reads += 1) {
    const chunk = await reader.read();
    if (chunk.done) break;
    observed += decoder.decode(chunk.value, { stream: true });
  }
  return observed;
}

describe("semantic whiteboard HTTP integration", () => {
  it("requires one-use automation authority, commits a reconnectable draft, re-emits replay, and survives authorized resume", async () => {
    const base = await publishEmptyBoard();
    await startAutomationSession(base.artifactId, base.revisionId);
    const route = `/api/v1/whiteboards/${base.artifactId}/scene-commands`;
    const originalRequest = semanticRequest(base.artifactId);
    const mintBody = {
      protocol: "tweakloop.whiteboard-automation-mint/v1",
      sessionId: activeSessionId,
      runtimeCapability,
      artifactId: base.artifactId,
      method: "POST",
      operationId: "whiteboard.semantic-scene.apply.v1",
      routeSetVersion: 1,
      request: originalRequest,
    };
    expect(
      (
        await fetch(shell(route), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(semanticRequest(base.artifactId)),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(shell(route), {
          method: "POST",
          headers: {
            authorization: `Bearer ${daemon.cliToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(semanticRequest(base.artifactId)),
        })
      ).status,
    ).toBe(403);

    const browserTokenResponse = await fetch(shell("/api/v1/bootstrap-tokens"), {
      method: "POST",
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    });
    expect(browserTokenResponse.status).toBe(201);
    const browserToken = (await browserTokenResponse.json()) as { url: string };
    const bootstrap = await fetch(browserToken.url, { redirect: "manual" });
    const browserCookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    expect(
      (
        await fetch(shell("/api/v1/automation/whiteboard-tokens"), {
          method: "POST",
          headers: {
            cookie: browserCookie,
            origin: `http://127.0.0.1:${daemon.shellPort}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(mintBody),
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(shell(route), {
          method: "POST",
          headers: {
            cookie: browserCookie,
            origin: `http://127.0.0.1:${daemon.shellPort}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(originalRequest),
        })
      ).status,
    ).toBe(403);

    const authorityBearingMint = await fetch(shell("/api/v1/automation/whiteboard-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...mintBody, actor: { kind: "agent", id: "forged" } }),
    });
    expect(authorityBearingMint.status).toBe(400);

    const wrongHolderMint = await fetch(shell("/api/v1/automation/whiteboard-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...mintBody,
        runtimeCapability: "wrong-runtime-capability-holder-0001",
      }),
    });
    expect(wrongHolderMint.status).toBe(403);

    const unattachedRequest = semanticRequest("artifact-not-attached");
    const unattachedMint = await fetch(shell("/api/v1/automation/whiteboard-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...mintBody,
        artifactId: unattachedRequest.artifactId,
        request: unattachedRequest,
      }),
    });
    expect(unattachedMint.status).toBe(403);

    const sharedToken = await mintAutomationToken(originalRequest);
    const callerAttributed = await postSceneWithToken(originalRequest, sharedToken, {
      "x-tweakloop-agent-id": "forged-agent",
    });
    expect(callerAttributed.status).toBe(400);
    const concurrent = await Promise.all(
      Array.from({ length: 32 }, () => postSceneWithToken(originalRequest, sharedToken)),
    );
    expect(concurrent.filter((response) => response.status === 200)).toHaveLength(1);
    expect(concurrent.filter((response) => response.status === 403)).toHaveLength(31);
    const first = concurrent.find((response) => response.status === 200);
    if (!first) throw new Error("one concurrent automation use must succeed");
    expect(first.status).toBe(200);
    const firstResponseJson = await first.text();
    const firstResponse = JSON.parse(firstResponseJson) as {
      draftVersion: number;
      sceneHash: string;
      changedTargets: readonly { semanticKey: string; anchorId: string; elementId: string }[];
    };
    expect(firstResponse).toMatchObject({
      draftVersion: 1,
      changedTargets: [{ semanticKey: "api" }],
    });
    expect((await postSceneWithToken(originalRequest, sharedToken)).status).toBe(403);

    const abort = new AbortController();
    const events = await fetch(
      shell(`/api/v1/whiteboards/${base.artifactId}/draft-events?after=0`),
      {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${daemon.cliToken}`,
        },
        signal: abort.signal,
      },
    );
    expect(events.status).toBe(200);
    const reader = events.body?.getReader();
    if (!reader) throw new Error("expected semantic draft SSE body");
    expect(await readUntil(reader, `"sceneHash":"${firstResponse.sceneHash}"`)).toContain(
      `"sceneHash":"${firstResponse.sceneHash}"`,
    );

    const replay = await postSceneCommand(base.artifactId);
    expect(replay.status).toBe(200);
    expect(await replay.text()).toBe(firstResponseJson);
    const replayEvent = await readUntil(
      reader,
      firstResponse.changedTargets[0]?.anchorId ?? "missing",
    );
    expect(replayEvent).toContain(firstResponse.changedTargets[0]?.anchorId);

    const wrongRequestToken = await mintAutomationToken(originalRequest);
    const wrongRequest = semanticRequest(base.artifactId, "wrong bound request");
    expect((await postSceneWithToken(wrongRequest, wrongRequestToken)).status).toBe(403);
    const recoveredTokenUse = await postSceneWithToken(originalRequest, wrongRequestToken);
    expect(recoveredTokenUse.status).toBe(200);
    expect(await recoveredTokenUse.text()).toBe(firstResponseJson);

    const authorityFieldToken = await mintAutomationToken(originalRequest);
    const authorityBearingCommand = await fetch(shell(route), {
      method: "POST",
      headers: {
        authorization: `Bearer ${authorityFieldToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...originalRequest,
        actor: { kind: "agent", id: "forged-agent" },
      }),
    });
    expect(authorityBearingCommand.status).toBe(400);
    const recoveredAuthorityFieldToken = await postSceneWithToken(
      originalRequest,
      authorityFieldToken,
    );
    expect(recoveredAuthorityFieldToken.status).toBe(200);
    expect(await recoveredAuthorityFieldToken.text()).toBe(firstResponseJson);

    const malformedToken = await mintAutomationToken(originalRequest);
    const malformed = await fetch(shell(route), {
      method: "POST",
      headers: {
        authorization: `Bearer ${malformedToken}`,
        "content-type": "application/json",
      },
      body: "{not-json",
    });
    expect(malformed.status).toBe(400);
    const afterMalformed = await postSceneWithToken(originalRequest, malformedToken);
    expect(afterMalformed.status).toBe(200);
    expect(await afterMalformed.text()).toBe(firstResponseJson);
    abort.abort();

    const conflict = await postSceneCommand(base.artifactId, "different payload");
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("scene.idempotency-conflict");

    const draft = await fetch(shell(`/api/v1/whiteboards/${base.artifactId}/draft`), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    });
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({
      draftVersion: 1,
      sceneHash: firstResponse.sceneHash,
      baseRevisionId: base.revisionId,
    });

    const preRestartToken = await mintAutomationToken(originalRequest);
    daemon.close();
    daemon = await startDaemon({
      rootPath: workspaceRoot,
      log: (line) => daemonLogs.push(line),
    });
    expect((await postSceneWithToken(originalRequest, preRestartToken)).status).toBe(403);
    const predecessorMintAfterRestart = await fetch(shell("/api/v1/automation/whiteboard-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(mintBody),
    });
    expect(predecessorMintAfterRestart.status).toBe(403);
    const predecessor = activeSessionId;
    activeSessionId = "session-semantic-http-resumed";
    runtimeCapability = "semantic-http-runtime-capability-0002";
    await startAutomationSession(base.artifactId, base.revisionId, { resumeFrom: predecessor });
    const afterRestart = await postSceneCommand(base.artifactId);
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.text()).toBe(firstResponseJson);
    expect(daemonLogs.join("\n")).not.toContain("semantic-http-runtime-capability");
    expect(process.argv.join("\0")).not.toContain("semantic-http-runtime-capability");
  });
});
