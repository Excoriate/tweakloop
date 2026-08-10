import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import { DEFAULT_WHITEBOARD_RETENTION_POLICY } from "../../src/whiteboard/retention.js";
import { WHITEBOARD_SCENE_MAX_BYTES } from "../../src/whiteboard/scene.js";

let stateDir: string;
let workspaceRoot: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-whiteboard-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-whiteboard-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateDir;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
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

function artifact(path: string): string {
  return `http://127.0.0.1:${daemon.artifactPort}${path}`;
}

function scene(label: string): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://tweakloop.local",
    elements: [
      {
        id: "text-1",
        type: "text",
        version: 1,
        versionNonce: label.length,
        text: label,
      },
    ],
    appState: { viewBackgroundColor: "#ffffff", scrollX: 50 },
    files: {},
  });
}

async function publishSource(path: string) {
  const response = await fetch(shell("/api/v1/publish"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path, actor: { kind: "agent", id: "fixture" } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    artifactId: string;
    revisionId: string;
    seq: number;
  };
}

async function automationTokenFor(
  artifactId: string,
  revisionId: string,
  request: Record<string, unknown>,
): Promise<string> {
  const sessionId = `session-automation-${String(request.idempotencyKey)}`;
  const runtimeCapability = `runtime-capability-${sessionId}`;
  const started = await fetch(shell("/api/v1/commands"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command-${sessionId}`,
      idempotencyKey: `session.start:${sessionId}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "publication-replay-later" },
      type: "session.start",
      payload: {
        sessionId,
        artifactId,
        agentId: "publication-replay-later",
        processNonce: `process-${sessionId}`,
        runtimeCapabilityHash: createHash("sha256").update(runtimeCapability).digest("hex"),
        baseRevisionId: revisionId,
        title: "Publication replay advancement",
        goal: "Advance the draft after publication",
      },
    }),
  });
  expect(started.status).toBe(200);
  const mint = await fetch(shell("/api/v1/automation/whiteboard-tokens"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.whiteboard-automation-mint/v1",
      sessionId,
      runtimeCapability,
      artifactId,
      method: "POST",
      operationId: "whiteboard.semantic-scene.apply.v1",
      routeSetVersion: 1,
      request,
    }),
  });
  expect(mint.status).toBe(201);
  return ((await mint.json()) as { automationToken: string }).automationToken;
}

function draftHeaders(input: {
  draftId?: string;
  baseRevisionId: string;
  expectedVersion: number;
  clientId: string;
  clientSequence: number;
}): Record<string, string> {
  return {
    authorization: `Bearer ${daemon.cliToken}`,
    "content-type": "application/vnd.excalidraw+json",
    "x-tweakloop-draft-id": input.draftId ?? "draft_1",
    "x-tweakloop-base-revision": input.baseRevisionId,
    "x-tweakloop-expected-version": String(input.expectedVersion),
    "x-tweakloop-client-id": input.clientId,
    "x-tweakloop-client-sequence": String(input.clientSequence),
    "x-tweakloop-agent-id": input.clientId,
  };
}

describe("whiteboard HTTP collaboration", () => {
  it("serves the local renderer and standalone board without giving the artifact origin writes", async () => {
    const source = join(workspaceRoot, "architecture.excalidraw");
    writeFileSync(source, scene("request flow"));
    const published = await publishSource(source);

    const revision = await fetch(artifact(`/r/${published.revisionId}/`));
    expect(revision.status).toBe(200);
    const html = await revision.text();
    expect(html).toContain('data-tweakloop-whiteboard-mode="standalone"');
    expect(html).toContain("application/vnd.excalidraw+json");
    expect(html).toContain("request flow");
    expect(html).toContain('src="/whiteboard/v1.js"');

    const loader = await fetch(artifact("/whiteboard/v1.js"));
    expect(loader.status).toBe(200);
    expect(loader.headers.get("content-type")).toContain("javascript");
    expect(await loader.text()).not.toMatch(/https?:\/\/(?:esm\.sh|unpkg|cdn\.jsdelivr)/);

    const runtime = await fetch(artifact("/whiteboard/assets/runtime.js"));
    expect(runtime.status).toBe(200);
    expect(runtime.headers.get("cache-control")).toContain("immutable");
    expect(runtime.headers.get("content-type")).toContain("javascript");

    expect((await fetch(artifact("/whiteboard/assets/%2e%2e%2fwhiteboard.js"))).status).toBe(404);
    expect(
      (
        await fetch(artifact(`/api/v1/whiteboards/${published.artifactId}/draft`), {
          method: "PUT",
          body: scene("forbidden"),
        })
      ).status,
    ).toBe(404);
    expect((await fetch(artifact("/health"), { method: "POST" })).status).toBe(404);
  });

  it("provides authenticated CAS, idempotency, conflicts, draft SSE, and immutable publish", async () => {
    const source = join(workspaceRoot, "system.excalidraw");
    writeFileSync(source, scene("published base"));
    const base = await publishSource(source);
    const draftPath = `/api/v1/whiteboards/${base.artifactId}/draft`;

    expect(
      (
        await fetch(shell(draftPath), {
          method: "PUT",
          headers: {
            "content-type": "application/vnd.excalidraw+json",
            "x-tweakloop-draft-id": "draft_1",
            "x-tweakloop-base-revision": base.revisionId,
            "x-tweakloop-expected-version": "0",
            "x-tweakloop-client-id": "anonymous",
            "x-tweakloop-client-sequence": "1",
          },
          body: scene("anonymous"),
        })
      ).status,
    ).toBe(401);

    const minted = await (
      await fetch(shell("/api/v1/bootstrap-tokens"), {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    const bootstrap = await fetch(minted.url, { redirect: "manual" });
    const browserCookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    const foreignOrigin = await fetch(shell(draftPath), {
      method: "PUT",
      headers: {
        ...draftHeaders({
          baseRevisionId: base.revisionId,
          expectedVersion: 0,
          clientId: "browser",
          clientSequence: 1,
        }),
        authorization: "",
        cookie: browserCookie,
        origin: "http://attacker.invalid",
      },
      body: scene("forged browser draft"),
    });
    expect(foreignOrigin.status).toBe(403);

    const initializeOptions = {
      method: "PUT",
      headers: draftHeaders({
        baseRevisionId: base.revisionId,
        expectedVersion: 0,
        clientId: "browser",
        clientSequence: 1,
      }),
      body: scene("human draft"),
    };
    const initialized = await fetch(shell(draftPath), initializeOptions);
    expect(initialized.status).toBe(200);
    const draftV1 = (await initialized.json()) as {
      draftVersion: number;
      sceneHash: string;
      sceneUrl: string;
    };
    expect(draftV1).toMatchObject({ draftVersion: 1 });
    expect(draftV1.sceneUrl).toBe(artifact(`/objects/sha256/${draftV1.sceneHash}`));
    expect((await fetch(draftV1.sceneUrl)).status).toBe(200);
    expect((await fetch(draftV1.sceneUrl)).headers.get("content-type")).toBe(
      "application/vnd.excalidraw+json",
    );
    expect(
      (await fetch(artifact(`/objects/sha256/${draftV1.sceneHash.toUpperCase()}`))).status,
    ).toBe(404);

    const replay = await fetch(shell(draftPath), initializeOptions);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(draftV1);

    const sequenceReuse = await fetch(shell(draftPath), {
      ...initializeOptions,
      body: scene("different bytes"),
    });
    expect(sequenceReuse.status).toBe(409);
    expect((await sequenceReuse.json()).code).toBe("whiteboard.draft-idempotency-conflict");

    const abort = new AbortController();
    const events = await fetch(
      shell(`/api/v1/whiteboards/${base.artifactId}/draft-events?after=1`),
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
    expect(reader).toBeDefined();

    const agentWinner = await fetch(shell(draftPath), {
      method: "PUT",
      headers: draftHeaders({
        baseRevisionId: base.revisionId,
        expectedVersion: 1,
        clientId: "agent-a",
        clientSequence: 1,
      }),
      body: scene("agent result"),
    });
    expect(agentWinner.status).toBe(200);
    const draftV2 = (await agentWinner.json()) as { draftVersion: number; sceneHash: string };
    expect(draftV2.draftVersion).toBe(2);
    const eventText = await readUntil(
      reader as ReadableStreamDefaultReader<Uint8Array>,
      "agent result",
      8,
    );
    expect(eventText).toContain("whiteboard-draft");
    expect(eventText).toContain('"draftVersion":2');
    abort.abort();

    const stale = await fetch(shell(draftPath), {
      method: "PUT",
      headers: draftHeaders({
        baseRevisionId: base.revisionId,
        expectedVersion: 1,
        clientId: "agent-b",
        clientSequence: 1,
      }),
      body: scene("losing result"),
    });
    expect(stale.status).toBe(409);
    const conflict = await stale.json();
    expect(conflict).toMatchObject({
      status: "conflict",
      code: "whiteboard.draft-conflict",
      currentDraftVersion: 2,
      currentSceneHash: draftV2.sceneHash,
    });
    expect(conflict.submittedSceneHash).not.toBe(conflict.currentSceneHash);

    const conflicts = await (
      await fetch(shell(`/api/v1/whiteboards/${base.artifactId}/conflicts`), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(conflicts.conflicts).toHaveLength(1);
    expect(conflicts.conflicts[0]).toMatchObject({
      conflictId: conflict.conflictId,
      submittedSceneHash: conflict.submittedSceneHash,
    });

    const command = {
      protocol: "tweakloop.command/v1",
      commandId: "cmd-whiteboard-publish-1",
      idempotencyKey: "whiteboard-publish-1",
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "agent-a" },
      type: "whiteboard.publish-draft",
      payload: {
        artifactId: base.artifactId,
        draftId: "draft_1",
        expectedDraftVersion: 2,
        expectedHeadRevisionId: base.revisionId,
        revisionId: "rev_whiteboard_2",
      },
    };
    const publishedResponse = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(publishedResponse.status).toBe(200);
    const publication = await publishedResponse.json();
    expect(publication).toMatchObject({
      status: "accepted",
      response: {
        revisionId: "rev_whiteboard_2",
        unchanged: false,
        sceneHash: draftV2.sceneHash,
      },
    });

    const retry = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(await retry.json()).toEqual(publication);

    const rendered = await fetch(artifact("/r/rev_whiteboard_2/"));
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain("agent result");

    const snapshot = await (
      await fetch(shell("/api/v1/snapshot"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    const boardRevisions = snapshot.revisions.filter(
      (revision: { artifactId: string }) => revision.artifactId === base.artifactId,
    );
    expect(boardRevisions).toHaveLength(2);
    expect(
      snapshot.timeline.filter(
        (item: { eventType: string }) => item.eventType === "artifact.revision-published",
      ),
    ).toHaveLength(2);
    const durableEvents = await (
      await fetch(shell("/api/v1/events?after=0"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(
      durableEvents.some((event: { eventType: string }) =>
        event.eventType.startsWith("whiteboard.draft"),
      ),
    ).toBe(false);
    const publishedEvent = durableEvents.find(
      (event: { payload: { revisionId?: string } }) =>
        event.payload.revisionId === "rev_whiteboard_2",
    );
    expect(JSON.stringify(publishedEvent)).not.toContain("agent result");
    expect(Buffer.byteLength(JSON.stringify(publishedEvent))).toBeLessThan(32 * 1024);
  });

  it("returns the immutable original publication receipt after both draft and head advance", async () => {
    const source = join(workspaceRoot, "publication-replay.excalidraw");
    writeFileSync(source, scene("published base"));
    const base = await publishSource(source);
    const draftPath = `/api/v1/whiteboards/${base.artifactId}/draft`;
    const initialized = await fetch(shell(draftPath), {
      method: "PUT",
      headers: draftHeaders({
        baseRevisionId: base.revisionId,
        expectedVersion: 0,
        clientId: "publication-replay",
        clientSequence: 1,
      }),
      body: scene("original draft"),
    });
    expect(initialized.status).toBe(200);

    const command = {
      protocol: "tweakloop.command/v1",
      commandId: "cmd-whiteboard-publish-replay",
      idempotencyKey: "whiteboard-publish-replay",
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "publication-replay" },
      type: "whiteboard.publish-draft",
      payload: {
        artifactId: base.artifactId,
        draftId: "draft_1",
        expectedDraftVersion: 1,
        expectedHeadRevisionId: base.revisionId,
        revisionId: "rev_whiteboard_replay_original",
      },
    };
    const firstResponse = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(firstResponse.status).toBe(200);
    const originalReceipt = await firstResponse.json();
    expect(originalReceipt).toMatchObject({
      status: "accepted",
      response: {
        revisionId: "rev_whiteboard_replay_original",
        draftId: "draft_1",
        draftVersion: 1,
      },
    });

    writeFileSync(source, scene("later independently published head"));
    const laterHead = await publishSource(source);
    expect(laterHead.artifactId).toBe(base.artifactId);
    expect(laterHead.revisionId).not.toBe("rev_whiteboard_replay_original");
    daemon.close();
    daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
    const laterRequest = {
      protocol: "tweakloop.whiteboard-scene-command/v1",
      artifactId: base.artifactId,
      idempotencyKey: "publication-replay-later-draft",
      operations: [{ type: "node.upsert", semanticKey: "later", label: "later draft" }],
    };
    const laterAutomationToken = await automationTokenFor(
      base.artifactId,
      laterHead.revisionId,
      laterRequest,
    );
    const laterDraft = await fetch(shell(`/api/v1/whiteboards/${base.artifactId}/scene-commands`), {
      method: "POST",
      headers: {
        authorization: `Bearer ${laterAutomationToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(laterRequest),
    });
    expect(laterDraft.status).toBe(200);
    expect(
      await (
        await fetch(shell(draftPath), {
          headers: { authorization: `Bearer ${daemon.cliToken}` },
        })
      ).json(),
    ).not.toMatchObject({ draftId: "draft_1" });

    const replay = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(originalReceipt);

    const events = (await (
      await fetch(shell("/api/v1/events?after=0"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json()) as { payload: { revisionId?: string } }[];
    expect(
      events.filter((event) => event.payload.revisionId === "rev_whiteboard_replay_original"),
    ).toHaveLength(1);
  });

  it("rejects malformed and oversized draft bodies without changing the current pointer", async () => {
    const source = join(workspaceRoot, "bounded.excalidraw");
    writeFileSync(source, scene("base"));
    const base = await publishSource(source);
    const path = `/api/v1/whiteboards/${base.artifactId}/draft`;
    const headers = draftHeaders({
      baseRevisionId: base.revisionId,
      expectedVersion: 0,
      clientId: "agent",
      clientSequence: 1,
    });

    const malformed = await fetch(shell(path), { method: "PUT", headers, body: "{}" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).code).toBe("whiteboard.scene-invalid");
    expect(
      (
        await fetch(shell(path), {
          headers: { authorization: `Bearer ${daemon.cliToken}` },
        })
      ).status,
    ).toBe(404);

    const oversized = await fetch(shell(path), {
      method: "PUT",
      headers: { ...headers, "x-tweakloop-client-sequence": "2" },
      body: Buffer.alloc(WHITEBOARD_SCENE_MAX_BYTES + 1, 120),
    });
    expect(oversized.status).toBe(413);
    expect((await oversized.json()).code).toBe("whiteboard.scene-too-large");
    expect((await fetch(shell("/health"))).status).toBe(200);

    const nonFinite = scene("numeric").replace('"text":"numeric"', '"text":"numeric","x":1e999');
    const normalized = await fetch(shell(path), {
      method: "PUT",
      headers: { ...headers, "x-tweakloop-client-sequence": "3" },
      body: nonFinite,
    });
    expect(normalized.status).toBe(400);
    expect((await normalized.json()).code).toBe("whiteboard.scene-invalid");

    const unsafeVersion = await fetch(shell(path), {
      method: "PUT",
      headers: {
        ...headers,
        "x-tweakloop-expected-version": String(Number.MAX_SAFE_INTEGER + 1),
        "x-tweakloop-client-sequence": "4",
      },
      body: scene("unsafe version"),
    });
    expect(unsafeVersion.status).toBe(400);
    expect((await unsafeVersion.json()).code).toBe("whiteboard.request-invalid");
    expect(
      (
        await fetch(shell(path), {
          headers: { authorization: `Bearer ${daemon.cliToken}` },
        })
      ).status,
    ).toBe(404);
  });

  it("bounds draft churn, exposes retention diagnostics, and preserves immutable revisions across restart", async () => {
    const source = join(workspaceRoot, "retention.excalidraw");
    writeFileSync(source, scene("retention base"));
    const base = await publishSource(source);
    const path = `/api/v1/whiteboards/${base.artifactId}/draft`;
    const oldSceneUrls: string[] = [];
    let latest:
      | {
          draftVersion: number;
          sceneUrl: string;
        }
      | undefined;
    const updates =
      DEFAULT_WHITEBOARD_RETENTION_POLICY.maxReceiptsPerArtifact +
      DEFAULT_WHITEBOARD_RETENTION_POLICY.maxUnreferencedObjects +
      16;
    for (let sequence = 1; sequence <= updates; sequence++) {
      const response = await fetch(shell(path), {
        method: "PUT",
        headers: draftHeaders({
          baseRevisionId: base.revisionId,
          expectedVersion: sequence - 1,
          clientId: "retention-client",
          clientSequence: sequence,
        }),
        body: scene(`draft churn ${sequence}`),
      });
      expect(response.status).toBe(200);
      latest = (await response.json()) as typeof latest;
      if (sequence <= 32 && latest) oldSceneUrls.push(latest.sceneUrl);
    }

    expect(latest).toBeDefined();
    const diagnosticResponse = await fetch(shell(path), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    });
    expect(diagnosticResponse.status).toBe(200);
    const diagnostic = (await diagnosticResponse.json()) as {
      retention: {
        status: string;
        policy: typeof DEFAULT_WHITEBOARD_RETENTION_POLICY;
        after: { objects: number; receipts: number };
        reachableObjects: number;
        retainedUnreferencedObjects: number;
      };
    };
    expect(diagnostic.retention).toMatchObject({
      status: "ok",
      policy: DEFAULT_WHITEBOARD_RETENTION_POLICY,
      after: { receipts: DEFAULT_WHITEBOARD_RETENTION_POLICY.maxReceiptsPerArtifact },
    });
    expect(diagnostic.retention.retainedUnreferencedObjects).toBeLessThanOrEqual(
      DEFAULT_WHITEBOARD_RETENTION_POLICY.maxUnreferencedObjects,
    );
    expect(diagnostic.retention.after.objects).toBeLessThanOrEqual(
      2 +
        DEFAULT_WHITEBOARD_RETENTION_POLICY.maxReceiptsPerArtifact * 2 +
        DEFAULT_WHITEBOARD_RETENTION_POLICY.maxUnreferencedObjects,
    );
    const oldStatuses = await Promise.all(
      oldSceneUrls.map(async (url) => (await fetch(url)).status),
    );
    expect(oldStatuses).toContain(404);
    expect((await fetch(latest?.sceneUrl ?? "")).status).toBe(200);
    expect(await (await fetch(artifact(`/r/${base.revisionId}/`))).text()).toContain(
      "retention base",
    );

    daemon.close();
    daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
    const recovered = await fetch(shell(path), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    });
    expect(recovered.status).toBe(200);
    const recoveredDraft = (await recovered.json()) as {
      sceneUrl: string;
      retention: { status: string; after: { receipts: number } };
    };
    expect(recoveredDraft.retention).toMatchObject({
      status: "ok",
      after: { receipts: DEFAULT_WHITEBOARD_RETENTION_POLICY.maxReceiptsPerArtifact },
    });
    expect((await fetch(recoveredDraft.sceneUrl)).status).toBe(200);
    expect(await (await fetch(artifact(`/r/${base.revisionId}/`))).text()).toContain(
      "retention base",
    );
  });
});

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  needle: string,
  maxReads: number,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for (let index = 0; index < maxReads; index++) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.includes(needle) || text.includes('"draftVersion":2')) return text;
  }
  return text;
}
