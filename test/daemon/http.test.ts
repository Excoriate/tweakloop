import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import {
  inspectRuntimeIdentity,
  readRuntime,
  removeRuntime,
  writeRuntime,
} from "../../src/daemon/runtime.js";
import { CHAT_ATTACHMENT_MAX_BYTES } from "../../src/protocol/chat.js";
import { WORKSPACE_EXPORT_PROTOCOL } from "../../src/protocol/versions.js";
import {
  WORKSPACE_EXPORT_MANIFEST_PATH,
  WORKSPACE_EXPORT_OBJECT_PREFIX,
} from "../../src/protocol/workspace-export.js";
import {
  validateWorkspaceBundleEnvelope,
  writeWorkspaceBundleEnvelope,
} from "../../src/workspace/files.js";

let stateDir: string;
let workspaceRoot: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateDir;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function shellUrl(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

async function startEmptySession(sessionId = "session_http_empty"): Promise<void> {
  const response = await fetch(shellUrl("/api/v1/commands"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `cmd_${sessionId}`,
      idempotencyKey: `session.start:${sessionId}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "codex" },
      type: "session.start",
      payload: {
        sessionId,
        artifactId: null,
        agentId: "codex",
        processNonce: `process_${sessionId}`,
        baseRevisionId: null,
        title: "Empty session",
        goal: "Add artifacts later",
      },
    }),
  });
  expect(response.status).toBe(200);
}

describe("daemon http", () => {
  it("distinguishes a live process without a ready HTTP receipt from a dead runtime", async () => {
    const workspaceId = "workspace_live_without_ready";
    const startNonce = "live-without-ready";
    writeRuntime({
      pid: process.pid,
      startNonce,
      shellPort: 1,
      artifactPort: 1,
      protocolVersion: 1,
      workspaceId,
      cliToken: "not-a-secret-test-token",
      restoreGeneration: null,
    });
    try {
      await expect(inspectRuntimeIdentity(workspaceId)).resolves.toMatchObject({
        status: "live-no-ready",
      });
    } finally {
      removeRuntime(workspaceId, startNonce);
    }
  });

  it("reports health with a start nonce on both origins", async () => {
    const shell = await (await fetch(shellUrl("/health"))).json();
    expect(shell).toMatchObject({ ok: true, role: "shell", workspaceId: daemon.workspaceId });

    const artifact = await (await fetch(`http://127.0.0.1:${daemon.artifactPort}/health`)).json();
    expect(artifact).toMatchObject({ ok: true, role: "artifact" });
    expect(artifact.startNonce).toBe(shell.startNonce);
  });

  it("refuses API access without credentials", async () => {
    expect((await fetch(shellUrl("/api/v1/snapshot"))).status).toBe(401);
    expect((await fetch(shellUrl("/app"))).status).toBe(401);
  });

  it("accepts commands with the CLI bearer token and serves the snapshot", async () => {
    const command = {
      protocol: "tweakloop.command/v1",
      commandId: "cmd-http-1",
      idempotencyKey: "http-key-1",
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "test-agent" },
      type: "artifact.register",
      payload: {
        artifactId: "artifact_http",
        name: "plan.html",
        format: "html",
        sourcePath: join(workspaceRoot, "plan.html"),
      },
    };
    const res = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(command),
    });
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result).toMatchObject({ status: "accepted" });

    const snapshot = await (
      await fetch(shellUrl("/api/v1/snapshot"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(snapshot.artifacts).toHaveLength(1);
    expect(snapshot.workspace.workspaceId).toBe(daemon.workspaceId);
    // workspace.opened + artifact.registered
    expect(snapshot.lastSeq).toBe(2);
  });

  it("authenticates a browser through a single-use bootstrap token", async () => {
    const minted = await (
      await fetch(shellUrl("/api/v1/bootstrap-tokens"), {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();

    const bootstrap = await fetch(minted.url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get("location")).toBe("/app");
    const cookie = bootstrap.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    const session = cookie?.split(";")[0] ?? "";

    const app = await fetch(shellUrl("/app"), { headers: { cookie: session } });
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("tweakloop");

    // the bootstrap token is consumed
    expect((await fetch(minted.url, { redirect: "manual" })).status).toBe(403);
  });

  it("imports immutable session bytes and creates one board through stable idempotent requests", async () => {
    await startEmptySession();
    const headers = {
      authorization: `Bearer ${daemon.cliToken}`,
      "x-tweakloop-session": "session_http_empty",
      "x-tweakloop-request-id": "request_import_1",
      "x-tweakloop-filename": encodeURIComponent("design.html"),
    };
    const html = Buffer.from("<!doctype html><h1>Imported</h1>");
    const imported = await fetch(shellUrl("/api/v1/session-artifacts"), {
      method: "POST",
      headers,
      body: html,
    });
    expect(imported.status).toBe(201);
    const receipt = await imported.json();
    expect(receipt).toMatchObject({
      sessionId: "session_http_empty",
      format: "html",
      delivery: "durable-available",
    });

    const retry = await fetch(shellUrl("/api/v1/session-artifacts"), {
      method: "POST",
      headers,
      body: html,
    });
    expect(await retry.json()).toMatchObject({
      artifactId: receipt.artifactId,
      revisionId: receipt.revisionId,
    });
    const conflict = await fetch(shellUrl("/api/v1/session-artifacts"), {
      method: "POST",
      headers,
      body: Buffer.from("<!doctype html><h1>Different</h1>"),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "artifact.idempotency-conflict" });

    const fetchedPath = join(workspaceRoot, "fetched-design.html");
    writeFileSync(fetchedPath, "<!doctype html><h1>Agent revision</h1>");
    const republished = await fetch(shellUrl("/api/v1/publish"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: fetchedPath,
        artifactId: receipt.artifactId,
        sessionId: "session_http_empty",
        actor: { kind: "agent", id: "codex" },
      }),
    });
    expect(republished.status).toBe(200);
    expect(await republished.json()).toMatchObject({
      artifactId: receipt.artifactId,
      seq: 2,
      unchanged: false,
    });

    await startEmptySession("session_http_other");
    const wrongSession = await fetch(shellUrl("/api/v1/publish"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: fetchedPath,
        artifactId: receipt.artifactId,
        sessionId: "session_http_other",
      }),
    });
    expect(wrongSession.status).toBe(409);
    expect(await wrongSession.json()).toMatchObject({
      error: expect.stringContaining("is not attached"),
    });

    const wrongFormatPath = join(workspaceRoot, "fetched-design.md");
    writeFileSync(wrongFormatPath, "# Wrong format\n");
    const wrongFormat = await fetch(shellUrl("/api/v1/publish"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        path: wrongFormatPath,
        artifactId: receipt.artifactId,
        sessionId: "session_http_empty",
      }),
    });
    expect(wrongFormat.status).toBe(409);
    expect(await wrongFormat.json()).toMatchObject({
      error: "artifact format mismatch: expected html, received markdown",
    });

    const board = await fetch(shellUrl("/api/v1/session-whiteboards"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sessionId: "session_http_empty", requestId: "request_board_1" }),
    });
    expect(board.status).toBe(201);
    expect(await board.json()).toMatchObject({
      sessionId: "session_http_empty",
      format: "whiteboard",
    });

    const session = await (
      await fetch(shellUrl("/api/v1/sessions/session_http_empty"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(session.session.artifacts).toHaveLength(2);
    expect(session.session.artifacts[0]).toMatchObject({
      artifactId: receipt.artifactId,
      sourcePath: null,
      currentRevisionId: expect.not.stringMatching(receipt.revisionId),
    });
  });

  it("refuses fabricated agent bootstrap and validates artifact membership", async () => {
    const fabricated = await fetch(shellUrl("/api/v1/bootstrap-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: "codex" }),
    });
    expect(fabricated.status).toBe(400);
    await startEmptySession("session_bootstrap");
    const valid = await fetch(shellUrl("/api/v1/bootstrap-tokens"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: "codex", sessionId: "session_bootstrap" }),
    });
    expect(valid.status).toBe(201);
  });

  it("restores a complete saved workspace into an isolated daemon without mutating the source", async () => {
    const bytes = Buffer.from("# Saved design\n");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const objectPath = `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${hash}`;
    const sourceWorkspaceId = "ws_saved_source";
    const sourceProjectId = "project_saved_source";
    const envelope = (
      seq: number,
      eventType: string,
      streamType: string,
      streamId: string,
      streamVersion: number,
      payload: Record<string, unknown>,
    ) => ({
      seq,
      eventId: `evt_saved_${seq}`,
      workspaceId: sourceWorkspaceId,
      streamType,
      streamId,
      streamVersion,
      eventType,
      schemaVersion: 1,
      recordedAt: `2026-08-04T00:00:0${seq}.000Z`,
      actor: { kind: "system", id: "saved-fixture" },
      causationId: `cmd_saved_${seq}`,
      correlationId: "corr_saved",
      payload: { type: eventType, ...payload },
    });
    const events = [
      envelope(1, "workspace.opened", "workspace", sourceWorkspaceId, 1, {
        workspaceId: sourceWorkspaceId,
        projectId: sourceProjectId,
        rootPath: "/saved/source",
      }),
      envelope(2, "artifact.registered", "artifact", "artifact_saved", 1, {
        artifactId: "artifact_saved",
        name: "design.md",
        format: "markdown",
        sourcePath: "/saved/source/design.md",
      }),
      envelope(3, "artifact.revision-published", "artifact", "artifact_saved", 2, {
        artifactId: "artifact_saved",
        revisionId: "revision_saved",
        parentId: null,
        seq: 1,
        format: "markdown",
        entryPath: "design.md",
        entryHash: hash,
        files: [{ path: "design.md", hash, mediaType: "text/markdown" }],
        producer: { kind: "agent", id: "saved-agent" },
        sourcePath: "/saved/source/design.md",
        sessionId: null,
      }),
    ];
    const manifest = {
      protocol: WORKSPACE_EXPORT_PROTOCOL,
      source: {
        workspaceId: sourceWorkspaceId,
        projectId: sourceProjectId,
        rootPath: "/saved/source",
      },
      capturedSeq: 3,
      artifacts: [
        {
          artifactId: "artifact_saved",
          format: "markdown",
          headRevisionId: "revision_saved",
          headSeq: 1,
          entryHash: hash,
          exportedPath: "design.md",
        },
      ],
      revisions: [
        {
          revisionId: "revision_saved",
          artifactId: "artifact_saved",
          parentId: null,
          seq: 1,
          format: "markdown",
          entryPath: "design.md",
          entryHash: hash,
          objectPath,
          files: [
            {
              path: "design.md",
              hash,
              mediaType: "text/markdown",
              byteLength: bytes.byteLength,
              objectPath,
            },
          ],
        },
      ],
      attachments: [],
      events,
    };
    const bundleRoot = join(stateDir, "saved-workspace-bundle");
    mkdirSync(bundleRoot);
    const manifestPath = join(bundleRoot, WORKSPACE_EXPORT_MANIFEST_PATH);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const bundleObjectPath = join(bundleRoot, ...objectPath.split("/"));
    mkdirSync(dirname(bundleObjectPath), { recursive: true });
    writeFileSync(bundleObjectPath, bytes);
    writeFileSync(join(bundleRoot, "design.md"), bytes);
    writeWorkspaceBundleEnvelope({
      bundleRoot,
      includeWorkspaceFiles: false,
      observedEndSeq: manifest.capturedSeq,
    });
    const validatedBundle = validateWorkspaceBundleEnvelope(bundleRoot);
    const sourceBefore = await (
      await fetch(shellUrl("/api/v1/snapshot"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    const crossedManifestBytes = Buffer.from(
      `${JSON.stringify(
        {
          ...manifest,
          events: manifest.events.map((entry, index) =>
            index === 0 ? { ...entry, actor: { ...entry.actor, id: "crossed-snapshot-b" } } : entry,
          ),
        },
        null,
        2,
      )}\n`,
    );
    const crossedStage = await fetch(shellUrl("/api/v1/workspace-restores"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "tweakloop.workspace-restore-request/v2",
        bundleId: validatedBundle.envelope.bundleId,
        collaborationManifestHash: validatedBundle.envelope.collaboration.manifestHash,
        collaborationManifestBase64: crossedManifestBytes.toString("base64"),
      }),
    });
    expect(crossedStage.status).toBe(409);
    expect(await crossedStage.json()).toMatchObject({ code: "workspace-restore.binding-mismatch" });
    const stage = await fetch(shellUrl("/api/v1/workspace-restores"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        protocol: "tweakloop.workspace-restore-request/v2",
        bundleId: validatedBundle.envelope.bundleId,
        collaborationManifestHash: validatedBundle.envelope.collaboration.manifestHash,
        collaborationManifestBase64: readFileSync(manifestPath).toString("base64"),
      }),
    });
    expect(stage.status).toBe(201);
    const staged = await stage.json();
    expect(staged.bundleId).toBe(validatedBundle.envelope.bundleId);
    const upload = await fetch(
      shellUrl(
        `/api/v1/workspace-restores/${staged.bundleId}/files?path=${encodeURIComponent(objectPath)}`,
      ),
      {
        method: "PUT",
        headers: { authorization: `Bearer ${daemon.cliToken}` },
        body: bytes,
      },
    );
    expect(upload.status).toBe(204);
    const originalManifestBytes = readFileSync(manifestPath);
    writeFileSync(manifestPath, crossedManifestBytes);
    const crossedCommit = await fetch(
      shellUrl(`/api/v1/workspace-restores/${staged.bundleId}/commit`),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "codex", bundleRoot }),
      },
    );
    expect(crossedCommit.status).toBe(409);
    expect(await crossedCommit.json()).toMatchObject({
      code: "workspace-restore.bundle-binding-mismatch",
    });
    writeFileSync(manifestPath, originalManifestBytes);
    const commitRequest = () =>
      fetch(shellUrl(`/api/v1/workspace-restores/${staged.bundleId}/commit`), {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "codex", bundleRoot }),
      });
    const concurrentCommits = await Promise.all([commitRequest(), commitRequest()]);
    const concurrentResults = await Promise.all(
      concurrentCommits.map((response) => response.json()),
    );
    expect(concurrentCommits.map((response) => response.status)).toEqual([201, 201]);
    const restored = concurrentResults.find((result) => result.alreadyRestored === false);
    const concurrentRetry = concurrentResults.find((result) => result.alreadyRestored === true);
    expect(restored).toBeDefined();
    if (!restored) throw new Error("concurrent restore did not produce the first committed result");
    expect(concurrentRetry?.receipt).toEqual(restored?.receipt);
    expect(concurrentRetry?.url).not.toBe(restored?.url);
    expect(restored).toMatchObject({
      projectId: sourceProjectId,
      sessionId: expect.stringMatching(/^session_restore_/),
      bundleId: validatedBundle.envelope.bundleId,
      alreadyRestored: false,
    });
    expect(restored.workspaceId).not.toBe(daemon.workspaceId);
    const bootstrap = await fetch(restored.url, { redirect: "manual" });
    expect(bootstrap.status).toBe(303);
    const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
    const restoredOrigin = new URL(restored.url).origin;
    const restoredSnapshot = await (
      await fetch(`${restoredOrigin}/api/v1/snapshot`, { headers: { cookie } })
    ).json();
    expect(restoredSnapshot).toMatchObject({
      workspace: { workspaceId: restored.workspaceId, projectId: sourceProjectId },
      artifacts: [{ artifactId: "artifact_saved" }],
      revisions: [{ revisionId: "revision_saved" }],
    });
    expect(
      restoredSnapshot.timeline.find(
        (item: { eventType: string }) => item.eventType === "workspace.restored",
      ),
    ).toBeDefined();
    const runtime = readRuntime(restored.workspaceId);
    expect(runtime).not.toBeNull();
    expect(runtime?.restoreGeneration).toMatchObject({
      journalId: expect.stringMatching(/^restore_journal_[a-f0-9]{48}$/),
      rootGenerationHash: restored.receipt.rootGenerationHash,
      stateGenerationHash: restored.receipt.stateGenerationHash,
    });
    if (!runtime?.restoreGeneration) throw new Error("restore runtime generation is missing");
    expect(
      await inspectRuntimeIdentity(restored.workspaceId, {
        startNonce: runtime.startNonce,
        restoreGeneration: {
          ...runtime.restoreGeneration,
          rootGenerationHash: "0".repeat(64),
        },
      }),
    ).toMatchObject({ status: "alien" });
    const restoredEvents = await (
      await fetch(`${restoredOrigin}/api/v1/events?after=0`, {
        headers: { authorization: `Bearer ${runtime?.cliToken ?? ""}` },
      })
    ).json();
    expect(restoredEvents.slice(0, 3)).toMatchObject([
      {
        seq: 1,
        eventId: "evt_saved_1",
        eventType: "workspace.restored",
        workspaceId: restored.workspaceId,
        recordedAt: "2026-08-04T00:00:01.000Z",
        causationId: "cmd_saved_1",
        correlationId: "corr_saved",
      },
      {
        seq: 2,
        eventId: "evt_saved_2",
        eventType: "artifact.registered",
        actor: { kind: "system", id: "saved-fixture" },
      },
      { seq: 3, eventId: "evt_saved_3", eventType: "artifact.revision-published" },
    ]);
    const sourceAfter = await (
      await fetch(shellUrl("/api/v1/snapshot"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(sourceAfter.lastSeq).toBe(sourceBefore.lastSeq);

    const repeated = await commitRequest();
    expect(repeated.status).toBe(201);
    const repeatedResult = await repeated.json();
    expect(repeatedResult).toMatchObject({
      workspaceId: restored.workspaceId,
      sessionId: restored.sessionId,
      alreadyRestored: true,
    });
    expect(repeatedResult.receipt).toEqual(restored.receipt);

    const legacyStage = await fetch(shellUrl("/api/v1/workspace-restores"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(manifest),
    });
    expect(legacyStage.status).toBe(201);
    const legacyStaged = await legacyStage.json();
    expect(legacyStaged.bundleMode).toBe("collaboration-only");
    expect(
      (
        await fetch(
          shellUrl(
            `/api/v1/workspace-restores/${legacyStaged.bundleId}/files?path=${encodeURIComponent(objectPath)}`,
          ),
          {
            method: "PUT",
            headers: { authorization: `Bearer ${daemon.cliToken}` },
            body: bytes,
          },
        )
      ).status,
    ).toBe(204);
    const legacyCommit = await fetch(
      shellUrl(`/api/v1/workspace-restores/${legacyStaged.bundleId}/commit`),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "codex", bundleRoot }),
      },
    );
    expect(legacyCommit.status).toBe(426);
    expect(await legacyCommit.json()).toMatchObject({
      status: "error",
      code: "workspace-restore.bundle-envelope-required",
    });
    const stopped = await fetch(`${restoredOrigin}/api/v1/shutdown`, {
      method: "POST",
      headers: { authorization: `Bearer ${runtime?.cliToken ?? ""}` },
    });
    expect(stopped.status).toBe(200);
    const restartedCommit = await fetch(
      shellUrl(`/api/v1/workspace-restores/${staged.bundleId}/commit`),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${daemon.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "codex", bundleRoot }),
      },
    );
    const restarted = await restartedCommit.json();
    expect(restartedCommit.status, JSON.stringify(restarted)).toBe(201);
    expect(restarted).toMatchObject({
      workspaceId: restored.workspaceId,
      operationSessionId: restored.operationSessionId,
      alreadyRestored: true,
      activation: "restart-runtime-only",
    });
    expect(restarted.receipt).toEqual(restored.receipt);
    const restartedRuntime = readRuntime(restored.workspaceId);
    expect(restartedRuntime?.startNonce).not.toBe(runtime?.startNonce);
    expect(restartedRuntime?.restoreGeneration).toEqual(runtime?.restoreGeneration);
    if (restartedRuntime) {
      await fetch(`http://127.0.0.1:${restartedRuntime.shellPort}/api/v1/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${restartedRuntime.cliToken}` },
      });
    }
  });

  it("survives an oversized command body and stays available", async () => {
    const res = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: "x".repeat(1_100_000),
    });
    expect(res.status).toBe(413);
    expect((await fetch(shellUrl("/health"))).status).toBe(200);
  });

  it("uploads deduplicated raw attachments and downloads them with safe headers", async () => {
    const bytes = Buffer.from("binary\u0000attachment", "utf8");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const unauthenticated = await fetch(shellUrl("/api/v1/chat/attachments"), {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-tweakloop-filename": encodeURIComponent("diagram.png"),
      },
      body: bytes,
    });
    expect(unauthenticated.status).toBe(401);

    const upload = await fetch(shellUrl("/api/v1/chat/attachments"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "image/png",
        "x-tweakloop-filename": encodeURIComponent("diagram one.png"),
      },
      body: bytes,
    });
    expect(upload.status).toBe(201);
    expect(await upload.json()).toEqual({
      hash,
      fileName: "diagram one.png",
      mediaType: "image/png",
      byteLength: bytes.byteLength,
    });

    const duplicate = await fetch(shellUrl("/api/v1/chat/attachments"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/octet-stream",
        "x-tweakloop-filename": encodeURIComponent("same-bytes.bin"),
      },
      body: bytes,
    });
    expect(await duplicate.json()).toEqual({
      hash,
      fileName: "same-bytes.bin",
      // Blob metadata is canonical on dedupe; a retry cannot relabel stored bytes.
      mediaType: "image/png",
      byteLength: bytes.byteLength,
    });

    expect((await fetch(shellUrl(`/api/v1/chat/attachments/${hash}`))).status).toBe(401);
    const download = await fetch(
      shellUrl(
        `/api/v1/chat/attachments/${hash}?filename=${encodeURIComponent("diagram one.png")}`,
      ),
      { headers: { authorization: `Bearer ${daemon.cliToken}` } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(download.headers.get("x-content-type-options")).toBe("nosniff");
    expect(download.headers.get("content-disposition")).toContain("attachment;");
    expect(download.headers.get("content-disposition")).toContain(
      "filename*=UTF-8''diagram%20one.png",
    );
    expect(Buffer.from(await download.arrayBuffer())).toEqual(bytes);
  });

  it("rejects invalid filenames and attachments over 25 MiB without killing the daemon", async () => {
    const headers = {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/octet-stream",
    };
    const invalidName = await fetch(shellUrl("/api/v1/chat/attachments"), {
      method: "POST",
      headers: { ...headers, "x-tweakloop-filename": "%E0%A4%A" },
      body: Buffer.from("x"),
    });
    expect(invalidName.status).toBe(400);
    expect(await invalidName.json()).toMatchObject({ code: "attachment.filename-invalid" });

    const oversized = await fetch(shellUrl("/api/v1/chat/attachments"), {
      method: "POST",
      headers: { ...headers, "x-tweakloop-filename": encodeURIComponent("too-large.bin") },
      body: Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "attachment.too-large" });
    expect((await fetch(shellUrl("/health"))).status).toBe(200);
  });

  it("rejects cookie-authenticated mutations from a foreign origin", async () => {
    const minted = await (
      await fetch(shellUrl("/api/v1/bootstrap-tokens"), {
        method: "POST",
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    const bootstrap = await fetch(minted.url, { redirect: "manual" });
    const session = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";

    const foreign = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        cookie: session,
        origin: "http://evil.example",
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(foreign.status).toBe(403);

    const sameOrigin = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: {
        cookie: session,
        origin: `http://127.0.0.1:${daemon.shellPort}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    // past the origin gate: the empty envelope fails protocol validation
    expect(sameOrigin.status).toBe(400);
    expect((await sameOrigin.json()).code).toBe("protocol.invalid-envelope");
  });

  it("refuses a second daemon for the same workspace", async () => {
    await expect(startDaemon({ rootPath: workspaceRoot, log: () => {} })).rejects.toThrow(
      /already running/,
    );
  });

  it("tracks ephemeral agent presence with TTL and idle clearing", async () => {
    const headers = {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    };
    const set = await fetch(shellUrl("/api/v1/presence"), {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: "agent:t", state: "thinking", ttlMs: 5000 }),
    });
    expect(set.status).toBe(200);

    const active = await (
      await fetch(shellUrl("/api/v1/presence"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(active.agents).toEqual([{ agentId: "agent:t", state: "thinking" }]);

    await fetch(shellUrl("/api/v1/presence"), {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: "agent:t", state: "idle" }),
    });
    const cleared = await (
      await fetch(shellUrl("/api/v1/presence"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(cleared.agents).toEqual([]);
  });

  it("rejects unknown presence states and invalid TTLs without publishing presence", async () => {
    const headers = {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    };
    const invalidBodies = [
      { agentId: "agent:invalid", state: "workng", ttlMs: 20_000 },
      { agentId: "agent:invalid", state: "working", ttlMs: -1 },
      { agentId: "agent:invalid", state: "working", ttlMs: 0 },
      { agentId: "agent:invalid", state: "working", ttlMs: 1.5 },
      { agentId: "agent:invalid", state: "working", ttlMs: 300_001 },
      { agentId: "agent:invalid", state: "working", ttlMs: "20000" },
    ];

    for (const body of invalidBodies) {
      const response = await fetch(shellUrl("/api/v1/presence"), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: expect.any(String) });
    }

    const current = await (
      await fetch(shellUrl("/api/v1/presence"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(current.agents).toEqual([]);
  });

  it("keeps listener connectivity independent from expiring activity and other listeners", async () => {
    const auth = { authorization: `Bearer ${daemon.cliToken}` };
    const firstController = new AbortController();
    const secondController = new AbortController();
    const listenerUrl = shellUrl("/api/v1/events?after=0&agent=agent:connected");
    const workingListenerUrl = shellUrl(
      "/api/v1/events?after=0&agent=agent:connected&presence=working",
    );

    const first = await fetch(listenerUrl, {
      headers: { ...auth, accept: "text/event-stream" },
      signal: firstController.signal,
    });
    const second = await fetch(workingListenerUrl, {
      headers: { ...auth, accept: "text/event-stream" },
      signal: secondController.signal,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const readPresence = async () =>
      await (
        await fetch(shellUrl("/api/v1/presence"), {
          headers: auth,
        })
      ).json();

    expect((await readPresence()).agents).toEqual([
      { agentId: "agent:connected", state: "working" },
    ]);

    await fetch(shellUrl("/api/v1/presence"), {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ agentId: "agent:connected", state: "thinking", ttlMs: 20 }),
    });
    expect((await readPresence()).agents).toEqual([
      { agentId: "agent:connected", state: "thinking" },
    ]);

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect((await readPresence()).agents).toEqual([
      { agentId: "agent:connected", state: "working" },
    ]);

    secondController.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await readPresence()).agents).toEqual([
      { agentId: "agent:connected", state: "listening" },
    ]);

    firstController.abort();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await readPresence()).agents).toEqual([]);
  });

  it("rejects invalid socket-backed listener presence before publication", async () => {
    const response = await fetch(
      shellUrl("/api/v1/events?after=0&agent=agent:invalid&presence=workng"),
      {
        headers: {
          authorization: `Bearer ${daemon.cliToken}`,
          accept: "text/event-stream",
        },
      },
    );
    expect(response.status).toBe(400);
    const current = await (
      await fetch(shellUrl("/api/v1/presence"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(current.agents).toEqual([]);
  });

  it("lists committed events as JSON", async () => {
    const events = await (
      await fetch(shellUrl("/api/v1/events?after=0"), {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      })
    ).json();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 1, eventType: "workspace.opened" });
  });
});
