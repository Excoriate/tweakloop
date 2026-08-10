import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonConnection } from "../../src/cli/daemon-client.js";
import { createForkedWorkspaceBundle } from "../../src/cli/workspace-fork.js";
import { restoreWorkspaceExport } from "../../src/cli/workspace-restore.js";
import {
  compactWorkspaceRestore,
  getWorkspaceRestoreInventory,
} from "../../src/cli/workspace-retention.js";
import { startDaemon } from "../../src/daemon/index.js";
import { readRuntime, removeRuntime, stateDirFor } from "../../src/daemon/runtime.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import { WORKSPACE_EXPORT_PROTOCOL } from "../../src/protocol/versions.js";
import {
  WORKSPACE_EXPORT_MANIFEST_PATH,
  WORKSPACE_EXPORT_OBJECT_PREFIX,
  type WorkspaceExportManifest,
} from "../../src/protocol/workspace-export.js";
import { objectPath as storedObjectPath } from "../../src/storage/object-store/index.js";
import {
  validateWorkspaceBundleEnvelope,
  WORKSPACE_BUNDLE_ENVELOPE_PATH,
  writeWorkspaceBundleEnvelope,
} from "../../src/workspace/files.js";
import { validateWorkspaceRestoreManifest } from "../../src/workspace/restore.js";
import { createWorkspaceForkPlanStore } from "../../src/workspace/restore-journal.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(
  seq: number,
  eventType: string,
  streamType: string,
  streamId: string,
  streamVersion: number,
  payload: Record<string, unknown>,
): EventEnvelope {
  return {
    seq,
    eventId: `event_${seq}`,
    workspaceId: "workspace_source",
    streamType,
    streamId,
    streamVersion,
    eventType,
    schemaVersion: 1,
    recordedAt: `2026-08-07T12:00:0${seq}.000Z`,
    actor: { kind: "agent", id: "codex" },
    causationId: `command_${seq}`,
    correlationId: "correlation_source",
    payload: { type: eventType, ...payload },
  };
}

function sourceBundle(): { root: string; bundle: string; manifest: WorkspaceExportManifest } {
  const root = mkdtempSync(join(tmpdir(), "tweakloop-fork-bundle-"));
  roots.push(root);
  const bundle = join(root, "source");
  mkdirSync(bundle);
  const bytes = Buffer.from("# pinned\n");
  const hash = createHash("sha256").update(bytes).digest("hex");
  const objectPath = `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${hash}`;
  const events = [
    event(1, "workspace.opened", "workspace", "workspace_source", 1, {
      workspaceId: "workspace_source",
      projectId: "project_1",
      rootPath: "/source",
    }),
    event(2, "artifact.registered", "artifact", "artifact_1", 1, {
      artifactId: "artifact_1",
      name: "plan.md",
      format: "markdown",
      sourcePath: "/source/plan.md",
    }),
    event(3, "artifact.revision-published", "artifact", "artifact_1", 2, {
      artifactId: "artifact_1",
      revisionId: "revision_pinned",
      parentId: null,
      seq: 1,
      format: "markdown",
      entryPath: "plan.md",
      entryHash: hash,
      files: [{ path: "plan.md", hash, mediaType: "text/markdown" }],
      producer: { kind: "agent", id: "codex" },
      sourcePath: "/source/plan.md",
      sessionId: null,
    }),
    event(4, "session.started", "session", "session_source", 1, {
      sessionId: "session_source",
      artifactId: "artifact_1",
      originatingAgentId: "codex",
      agentId: "codex",
      processNonce: "process_source",
      baseRevisionId: "revision_pinned",
      title: "Source",
      goal: "Source goal",
      predecessorSessionId: null,
      handoffSummary: null,
    }),
    event(5, "session.artifact-attached", "session", "session_source", 2, {
      sessionId: "session_source",
      artifactId: "artifact_1",
      revisionId: "revision_pinned",
      role: "primary",
    }),
  ];
  const manifest: WorkspaceExportManifest = {
    protocol: WORKSPACE_EXPORT_PROTOCOL,
    source: { workspaceId: "workspace_source", projectId: "project_1", rootPath: "/source" },
    capturedSeq: events.length,
    artifacts: [
      {
        artifactId: "artifact_1",
        format: "markdown",
        headRevisionId: "revision_pinned",
        headSeq: 3,
        entryHash: hash,
        exportedPath: "plan.md",
      },
    ],
    revisions: [
      {
        revisionId: "revision_pinned",
        artifactId: "artifact_1",
        parentId: null,
        seq: 1,
        format: "markdown",
        entryPath: "plan.md",
        entryHash: hash,
        objectPath,
        files: [
          {
            path: "plan.md",
            hash,
            mediaType: "text/markdown",
            byteLength: bytes.length,
            objectPath,
          },
        ],
      },
    ],
    attachments: [],
    events,
  };
  const object = join(bundle, ...objectPath.split("/"));
  mkdirSync(join(object, ".."), { recursive: true });
  writeFileSync(object, bytes);
  writeFileSync(join(bundle, "plan.md"), bytes);
  const manifestPath = join(bundle, WORKSPACE_EXPORT_MANIFEST_PATH);
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  writeWorkspaceBundleEnvelope({
    bundleRoot: bundle,
    includeWorkspaceFiles: false,
    observedEndSeq: manifest.capturedSeq,
  });
  return { root, bundle, manifest };
}

describe("forked workspace bundles", () => {
  it("rejects a legacy collaboration-only directory before contacting a restore daemon", async () => {
    const source = sourceBundle();
    rmSync(join(source.bundle, WORKSPACE_BUNDLE_ENVELOPE_PATH));
    const unreachable: DaemonConnection = {
      baseUrl: "http://127.0.0.1:1",
      token: "unused",
      descriptor: {
        pid: 1,
        startNonce: "unused",
        shellPort: 1,
        artifactPort: 1,
        protocolVersion: 1,
        workspaceId: "workspace_unreachable",
        cliToken: "unused",
      },
    };
    await expect(restoreWorkspaceExport(unreachable, source.bundle, "codex")).rejects.toMatchObject(
      { code: "workspace-bundle.envelope-missing" },
    );
  });

  it("writes a new valid manifest last while preserving pinned content identities", () => {
    const source = sourceBundle();
    const destination = join(source.root, "fork");
    const working = join(source.root, "working");
    const planStoreDir = join(source.root, "fork-plans");
    const result = createForkedWorkspaceBundle({
      sourceBundle: source.bundle,
      destinationBundle: destination,
      destinationWorkspaceRoot: working,
      sourceSessionId: "session_source",
      destinationAgentId: "codex",
      now: () => "2026-08-07T13:00:00.000Z",
      planStoreDir,
    });
    const persisted = JSON.parse(
      readFileSync(join(destination, WORKSPACE_EXPORT_MANIFEST_PATH), "utf8"),
    ) as WorkspaceExportManifest;
    expect(() => validateWorkspaceRestoreManifest(persisted)).not.toThrow();
    expect(persisted.source.workspaceId).not.toBe(source.manifest.source.workspaceId);
    expect(persisted.revisions[0]?.revisionId).toBe("revision_pinned");
    expect(persisted.artifacts[0]?.artifactId).toBe("artifact_1");
    expect(result.checkpoint.artifacts[0]).toMatchObject({
      artifactId: "artifact_1",
      revisionId: "revision_pinned",
      role: "primary",
    });
    expect(persisted.events.at(-2)).toMatchObject({
      eventType: "session.started",
      streamId: result.checkpoint.destinationSessionId,
    });
    expect(existsSync(join(destination, persisted.revisions[0]?.objectPath ?? "missing"))).toBe(
      true,
    );
    expect(result.operationId).toMatch(/^operation_[a-f0-9]{64}$/);
    expect(result.bundleId).toMatch(/^bundle_[a-f0-9]{64}$/);
  });

  it("reuses frozen fork identities after a lost response and keeps sibling destinations distinct", () => {
    const source = sourceBundle();
    const planStoreDir = join(source.root, "fork-plans");
    const workingA = join(source.root, "working-a");
    const first = createForkedWorkspaceBundle({
      sourceBundle: source.bundle,
      destinationBundle: join(source.root, "fork-a-1"),
      destinationWorkspaceRoot: workingA,
      sourceSessionId: "session_source",
      destinationAgentId: "codex",
      now: () => "2026-08-07T13:00:00.000Z",
      planStoreDir,
    });
    const repeated = createForkedWorkspaceBundle({
      sourceBundle: source.bundle,
      destinationBundle: join(source.root, "fork-a-2"),
      destinationWorkspaceRoot: workingA,
      sourceSessionId: "session_source",
      destinationAgentId: "codex",
      now: () => "2030-01-01T00:00:00.000Z",
      planStoreDir,
    });
    expect(repeated.operationId).toBe(first.operationId);
    expect(repeated.manifest.source.workspaceId).toBe(first.manifest.source.workspaceId);
    expect(repeated.checkpoint.destinationSessionId).toBe(first.checkpoint.destinationSessionId);
    expect(repeated.processNonce).toBe(first.processNonce);
    expect(repeated.manifest.events).toEqual(first.manifest.events);
    expect(repeated.bundleId).toBe(first.bundleId);
    const rebound = createWorkspaceForkPlanStore(planStoreDir).begin({
      operationId: first.operationId,
      sourceBundleId: validateBundleId(source.bundle),
      sourceSessionId: "session_source",
      destinationRoot: workingA,
    });
    expect(rebound.resultBundleId).toBe(first.bundleId);
    expect(readdirSync(planStoreDir)).toHaveLength(1);

    const sibling = createForkedWorkspaceBundle({
      sourceBundle: source.bundle,
      destinationBundle: join(source.root, "fork-b"),
      destinationWorkspaceRoot: join(source.root, "working-b"),
      sourceSessionId: "session_source",
      destinationAgentId: "codex",
      now: () => "2026-08-07T13:01:00.000Z",
      planStoreDir,
    });
    expect(sibling.operationId).not.toBe(first.operationId);
    expect(sibling.manifest.source.workspaceId).not.toBe(first.manifest.source.workspaceId);
    expect(sibling.checkpoint.destinationSessionId).not.toBe(first.checkpoint.destinationSessionId);
  });

  it("replays a lost public CLI fork response before inspecting the existing destination", async () => {
    const source = sourceBundle();
    const stateDir = join(source.root, "cli-state");
    const controllerRoot = join(source.root, "cli-controller");
    const destinationRoot = join(source.root, "cli-fork");
    const cliRoot = mkdtempSync(join(process.cwd(), ".ai", "workspace-fork-cli-"));
    roots.push(cliRoot);
    const cli = join(cliRoot, "tweak-cli.mjs");
    mkdirSync(stateDir);
    mkdirSync(controllerRoot);
    await build({
      entryPoints: [join(import.meta.dirname, "../../src/cli/index.ts")],
      outfile: cli,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      packages: "external",
      logLevel: "silent",
    });
    process.env.TWEAKLOOP_STATE_DIR = stateDir;
    const controller = await startDaemon({ rootPath: controllerRoot, log: () => {} });
    const invokeArgs = (args: readonly string[]) =>
      new Promise<Readonly<{ status: number | null; stdout: string; stderr: string }>>(
        (resolve) => {
          const child = spawn(
            process.execPath,
            [cli, "--workspace", controllerRoot, "--json", ...args],
            {
              cwd: source.root,
              env: { ...process.env, TWEAKLOOP_STATE_DIR: stateDir },
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
          });
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
          });
          const deadline = setTimeout(() => child.kill(), 30_000);
          child.once("close", (status) => {
            clearTimeout(deadline);
            resolve({ status, stdout, stderr });
          });
        },
      );
    const invoke = (destination: string) =>
      invokeArgs([
        "workspace",
        "fork",
        source.bundle,
        "--session",
        "session_source",
        "--into",
        destination,
        "--agent",
        "codex",
      ]);
    try {
      const exportDestination = join(source.root, "cli-export");
      const exportOperation = `operation_${"f".repeat(64)}`;
      const firstExportProcess = await invokeArgs([
        "workspace",
        "export",
        exportDestination,
        "--operation",
        exportOperation,
      ]);
      expect(
        firstExportProcess.status,
        firstExportProcess.stderr || firstExportProcess.stdout,
      ).toBe(0);
      const firstExport = JSON.parse(firstExportProcess.stdout) as Record<string, unknown>;
      const retryExportProcess = await invokeArgs([
        "workspace",
        "export",
        exportDestination,
        "--operation",
        exportOperation,
      ]);
      expect(
        retryExportProcess.status,
        retryExportProcess.stderr || retryExportProcess.stdout,
      ).toBe(0);
      expect(JSON.parse(retryExportProcess.stdout)).toMatchObject({
        alreadyExported: true,
        operation: firstExport.operation,
        bundle: firstExport.bundle,
      });

      const advance = await fetch(`http://127.0.0.1:${controller.shellPort}/api/v1/commands`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${controller.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "tweakloop.command/v1",
          commandId: "command_export_advance",
          idempotencyKey: "session.start:session_export_advance",
          workspaceId: controller.workspaceId,
          actor: { kind: "agent", id: "codex" },
          type: "session.start",
          payload: {
            sessionId: "session_export_advance",
            artifactId: null,
            agentId: "codex",
            processNonce: "process_export_advance",
            baseRevisionId: null,
            title: "advance export checkpoint",
            goal: "advance export checkpoint",
          },
        }),
      });
      expect(advance.status, await advance.text()).toBe(200);
      const changedExport = await invokeArgs([
        "workspace",
        "export",
        exportDestination,
        "--operation",
        exportOperation,
      ]);
      expect(changedExport.status).not.toBe(0);
      expect(JSON.parse(changedExport.stdout)).toMatchObject({
        protocol: "tweakloop.cli/v1",
        error: { code: "workspace-export.operation-conflict" },
      });
      const wrongExport = await invokeArgs([
        "workspace",
        "export",
        exportDestination,
        "--operation",
        `operation_${"e".repeat(64)}`,
      ]);
      expect(wrongExport.status).not.toBe(0);
      expect(JSON.parse(wrongExport.stdout)).toMatchObject({
        protocol: "tweakloop.cli/v1",
        error: { code: "workspace-export.destination-exists-without-stable-result" },
      });

      const firstProcess = await invoke(destinationRoot);
      expect(firstProcess.status, firstProcess.stderr || firstProcess.stdout).toBe(0);
      const first = JSON.parse(firstProcess.stdout) as Record<string, unknown>;

      // The caller loses the first response and starts a fresh CLI process with the same request.
      const retryProcess = await invoke(destinationRoot);
      expect(retryProcess.status, retryProcess.stderr || retryProcess.stdout).toBe(0);
      const retry = JSON.parse(retryProcess.stdout) as Record<string, unknown>;
      expect(retry).toMatchObject({
        alreadyRestored: true,
        operationId: first.operationId,
        receipt: first.receipt,
      });

      const wrongNeighbor = join(source.root, "wrong-neighbor");
      mkdirSync(wrongNeighbor);
      writeFileSync(join(wrongNeighbor, "keep.txt"), "preexisting\n");
      const rejected = await invoke(wrongNeighbor);
      expect(rejected.status).not.toBe(0);
      expect(JSON.parse(rejected.stdout)).toMatchObject({
        error: { code: "workspace-restore.destination-claim-conflict" },
      });
      expect(readFileSync(join(wrongNeighbor, "keep.txt"), "utf8")).toBe("preexisting\n");

      const inventoryProcess = await invokeArgs(["workspace", "restore-inventory"]);
      expect(inventoryProcess.status, inventoryProcess.stderr || inventoryProcess.stdout).toBe(0);
      expect(JSON.parse(inventoryProcess.stdout)).toMatchObject({
        protocol: "tweakloop.workspace-restore-inventory/v1",
        operations: expect.arrayContaining([
          expect.objectContaining({ operationId: first.operationId, status: "completed" }),
          expect.objectContaining({ status: "conflict" }),
        ]),
      });

      const workspaceId = String(first.workspaceId);
      const runtime = readRuntime(workspaceId);
      if (runtime) {
        await fetch(`http://127.0.0.1:${runtime.shellPort}/api/v1/shutdown`, {
          method: "POST",
          headers: { authorization: `Bearer ${runtime.cliToken}` },
        });
      }
      renameSync(destinationRoot, join(source.root, "cli-fork-released"));
      const compactProcess = await invokeArgs([
        "workspace",
        "restore-compact",
        "--kind",
        "fork",
        "--operation",
        String(first.operationId),
      ]);
      expect(compactProcess.status, compactProcess.stderr || compactProcess.stdout).toBe(0);
      expect(JSON.parse(compactProcess.stdout)).toMatchObject({
        protocol: "tweakloop.workspace-restore-compaction/v1",
        operationId: first.operationId,
      });
    } finally {
      controller.close();
      delete process.env.TWEAKLOOP_STATE_DIR;
    }
  }, 30_000);

  it("commits source/result bundle lineage through the journal and returns the same receipt on retry", async () => {
    const source = sourceBundle();
    const stateDir = join(source.root, "state");
    const controllerRoot = join(source.root, "controller");
    const destinationRoot = join(source.root, "working-fork");
    mkdirSync(stateDir);
    mkdirSync(controllerRoot);
    process.env.TWEAKLOOP_STATE_DIR = stateDir;
    const controller = await startDaemon({ rootPath: controllerRoot, log: () => {} });
    try {
      const descriptor = readRuntime(controller.workspaceId);
      if (!descriptor) throw new Error("controller runtime descriptor is missing");
      const connection: DaemonConnection = {
        baseUrl: `http://127.0.0.1:${controller.shellPort}`,
        token: controller.cliToken,
        descriptor,
      };
      const forked = createForkedWorkspaceBundle({
        sourceBundle: source.bundle,
        destinationBundle: join(source.root, "fork-result"),
        destinationWorkspaceRoot: destinationRoot,
        sourceSessionId: "session_source",
        destinationAgentId: "codex",
        now: () => "2026-08-07T13:00:00.000Z",
      });
      const sourceBundleId = validateBundleId(source.bundle);
      const first = await restoreWorkspaceExport(connection, forked.bundleRoot, "codex", {
        destinationRoot,
        sessionId: forked.checkpoint.destinationSessionId,
      });
      expect(first).toMatchObject({
        operationId: forked.operationId,
        bundleId: forked.bundleId,
        sourceBundleId,
        resultBundleId: forked.bundleId,
        sessionId: forked.checkpoint.destinationSessionId,
        alreadyRestored: false,
        receipt: {
          protocol: "tweakloop.workspace-fork-result/v1",
          operationId: forked.operationId,
          sourceBundleId,
          resultBundleId: forked.bundleId,
        },
      });
      expect(first.overlay).toEqual([
        expect.objectContaining({ path: "plan.md", state: "durable-only" }),
      ]);

      const restoredRuntime = readRuntime(first.workspaceId);
      if (!restoredRuntime) throw new Error("restored runtime descriptor is missing");
      const restoredBaseUrl = `http://127.0.0.1:${restoredRuntime.shellPort}`;
      const end = await fetch(`${restoredBaseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${restoredRuntime.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "tweakloop.command/v1",
          commandId: "command_fork_end",
          idempotencyKey: `session.end:${first.operationSessionId}`,
          workspaceId: first.workspaceId,
          actor: { kind: "agent", id: "codex" },
          type: "session.end",
          payload: {
            sessionId: first.operationSessionId,
            agentId: "codex",
            summary: "continue in a linked successor",
          },
        }),
      });
      expect(end.status, await end.text()).toBe(200);
      const successorSessionId = "session_fork_successor";
      const resume = await fetch(`${restoredBaseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${restoredRuntime.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "tweakloop.command/v1",
          commandId: "command_fork_resume",
          idempotencyKey: `session.resume:${successorSessionId}`,
          workspaceId: first.workspaceId,
          actor: { kind: "agent", id: "codex" },
          type: "session.resume",
          payload: {
            sessionId: successorSessionId,
            predecessorSessionId: first.operationSessionId,
            agentId: "codex",
            processNonce: "process_fork_successor",
            baseRevisionId: "revision_pinned",
            title: null,
            goal: null,
          },
        }),
      });
      expect(resume.status, await resume.text()).toBe(200);

      const repeated = await restoreWorkspaceExport(connection, forked.bundleRoot, "codex", {
        destinationRoot,
        sessionId: forked.checkpoint.destinationSessionId,
      });
      expect(repeated.alreadyRestored).toBe(true);
      expect(repeated.receipt).toEqual(first.receipt);
      expect(repeated.operationId).toBe(first.operationId);
      expect(repeated.workspaceId).toBe(first.workspaceId);
      expect(repeated.operationSessionId).toBe(first.operationSessionId);
      expect(repeated.sessionId).toBe(successorSessionId);
      expect(repeated.activation).toBe("successor-active");

      const endSuccessor = await fetch(`${restoredBaseUrl}/api/v1/commands`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${restoredRuntime.cliToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          protocol: "tweakloop.command/v1",
          commandId: "command_fork_successor_end",
          idempotencyKey: `session.end:${successorSessionId}`,
          workspaceId: first.workspaceId,
          actor: { kind: "agent", id: "codex" },
          type: "session.end",
          payload: {
            sessionId: successorSessionId,
            agentId: "codex",
            summary: "successor complete",
          },
        }),
      });
      expect(endSuccessor.status, await endSuccessor.text()).toBe(200);
      const terminal = await restoreWorkspaceExport(connection, forked.bundleRoot, "codex", {
        destinationRoot,
        sessionId: forked.checkpoint.destinationSessionId,
      });
      expect(terminal).toMatchObject({
        alreadyRestored: true,
        activation: "session-ended",
        locator: null,
        sessionId: null,
        url: null,
        receipt: first.receipt,
      });

      expect(restoredRuntime?.restoreGeneration).toMatchObject({
        rootGenerationHash: first.receipt.rootGenerationHash,
        stateGenerationHash: first.receipt.stateGenerationHash,
      });
      if (restoredRuntime) {
        const parkedRoot = join(source.root, "parked-fork-root");
        renameSync(destinationRoot, parkedRoot);
        expect(removeRuntime(first.workspaceId, restoredRuntime.startNonce)).toBe(true);
        await expect(
          compactWorkspaceRestore(connection, {
            operationKind: "fork",
            operationId: forked.operationId,
          }),
        ).rejects.toMatchObject({ code: "workspace-restore.compaction-runtime-present" });

        await fetch(`http://127.0.0.1:${restoredRuntime.shellPort}/api/v1/shutdown`, {
          method: "POST",
          headers: { authorization: `Bearer ${restoredRuntime.cliToken}` },
        });
        const objectHash = source.manifest.revisions[0]?.entryHash;
        if (!objectHash) throw new Error("source object hash is missing");
        const stateObject = storedObjectPath(
          join(stateDirFor(first.workspaceId), "objects"),
          objectHash,
        );
        const originalObject = readFileSync(stateObject);
        writeFileSync(stateObject, Buffer.alloc(originalObject.byteLength, 0x78));
        await expect(
          compactWorkspaceRestore(connection, {
            operationKind: "fork",
            operationId: forked.operationId,
          }),
        ).rejects.toMatchObject({ code: "workspace-restore.object-generation-mismatch" });
        writeFileSync(stateObject, originalObject);
        const compacted = await compactWorkspaceRestore(connection, {
          operationKind: "fork",
          operationId: forked.operationId,
        });
        expect(compacted).toMatchObject({
          protocol: "tweakloop.workspace-restore-compaction/v1",
          operationId: forked.operationId,
        });
        const inventory = await getWorkspaceRestoreInventory(connection);
        expect(inventory.operations).toContainEqual(
          expect.objectContaining({
            operationId: forked.operationId,
            status: "compacted",
            transition: null,
          }),
        );
      }
    } finally {
      controller.close();
      delete process.env.TWEAKLOOP_STATE_DIR;
    }
  });
});

function validateBundleId(bundleRoot: string): string {
  return validateWorkspaceBundleEnvelope(bundleRoot).envelope.bundleId;
}
