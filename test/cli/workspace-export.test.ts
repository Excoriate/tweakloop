import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonConnection } from "../../src/cli/daemon-client.js";
import { exportWorkspaceBundleOperation } from "../../src/cli/workspace-bundle-export.js";
import { exportWorkspace, type WorkspaceExportClient } from "../../src/cli/workspace-export.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import type { Snapshot, SnapshotArtifact, SnapshotRevision } from "../../src/protocol/snapshot.js";
import {
  planWorkspaceExport,
  type WorkspaceExportManifest,
} from "../../src/protocol/workspace-export.js";
import { workspaceExportFilesPolicyHash } from "../../src/workspace/export-journal.js";
import {
  captureWorkspaceFiles,
  WORKSPACE_FILES_CONFIG_PROTOCOL,
} from "../../src/workspace/files.js";

let tempRoot: string;
let workspaceRoot: string;
let destination: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "tweakloop-workspace-export-"));
  workspaceRoot = join(tempRoot, "workspace");
  destination = join(tempRoot, "export");
  mkdirSync(workspaceRoot);
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const connection: DaemonConnection = {
  baseUrl: "http://127.0.0.1:10001",
  token: "test-token",
  descriptor: {
    pid: 1,
    startNonce: "workspace-export-test",
    shellPort: 10001,
    artifactPort: 10002,
    protocolVersion: 1,
    workspaceId: "ws_export_test",
    cliToken: "test-token",
  },
};

function hash(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifact(
  artifactId: string,
  sourcePath: string | null,
  format = "markdown",
): SnapshotArtifact {
  return { artifactId, name: artifactId, format, sourcePath, registeredSeq: 1 };
}

function revision(
  revisionId: string,
  artifactId: string,
  seq: number,
  entryHash: string,
  parentId: string | null = null,
): SnapshotRevision {
  return {
    revisionId,
    artifactId,
    parentId,
    seq,
    format: "markdown",
    entryPath: `${artifactId}.md`,
    entryHash,
    producer: { kind: "agent", id: "fixture" },
    createdSeq: seq,
  };
}

function snapshot(
  artifacts: readonly SnapshotArtifact[],
  revisions: readonly SnapshotRevision[],
  lastSeq: number,
): Snapshot {
  return {
    protocol: "tweakloop.snapshot/v1",
    workspace: {
      workspaceId: connection.descriptor.workspaceId,
      projectId: "project_export_test",
      rootPath: workspaceRoot,
      protocolVersion: 1,
      artifactOrigin: "http://127.0.0.1:10002",
    },
    artifacts,
    revisions,
    intents: [],
    work: [],
    chat: [],
    timeline: [],
    lastSeq,
  };
}

function event(seq: number, eventType = "fixture.event", payload: unknown = {}): EventEnvelope {
  return {
    seq,
    eventId: `event_${seq}`,
    workspaceId: connection.descriptor.workspaceId,
    streamType: "workspace",
    streamId: connection.descriptor.workspaceId,
    streamVersion: seq,
    eventType,
    schemaVersion: 1,
    recordedAt: `2026-08-04T00:00:0${seq}.000Z`,
    actor: { kind: "system", id: "fixture" },
    causationId: null,
    correlationId: null,
    payload,
  };
}

function client(
  current: Snapshot,
  events: readonly EventEnvelope[],
  revisionBytes: ReadonlyMap<string, Buffer>,
  attachmentBytes: ReadonlyMap<string, Buffer> = new Map(),
): WorkspaceExportClient {
  return {
    getSnapshot: vi.fn(async () => current),
    listEvents: vi.fn(async () => [...events]),
    listWhiteboardSemanticReceipts: vi.fn(async () => []),
    fetchRevisionSource: vi.fn(async (_connection, revisionId) => {
      const bytes = revisionBytes.get(revisionId);
      if (!bytes) throw new Error(`missing revision fixture: ${revisionId}`);
      return bytes;
    }),
    fetchChatAttachment: vi.fn(async (_connection, attachmentHash) => {
      const bytes = attachmentBytes.get(attachmentHash);
      if (!bytes) throw new Error(`missing attachment fixture: ${attachmentHash}`);
      return bytes;
    }),
  };
}

describe("workspace export", () => {
  it("replays the stable public bundle receipt after response loss and rejects wrong neighbors", async () => {
    const bytes = Buffer.from("stable export\n");
    const current = snapshot(
      [artifact("artifact-a", join(workspaceRoot, "artifact.md"))],
      [revision("rev-a", "artifact-a", 1, hash(bytes))],
      1,
    );
    const exportClient = client(current, [event(1)], new Map([["rev-a", bytes]]));
    const capture = vi.fn(async (bundleRoot: string) => {
      const manifest = await exportWorkspace(connection, workspaceRoot, bundleRoot, exportClient);
      return { includeWorkspaceFiles: false, observedEndSeq: manifest.capturedSeq };
    });
    const storeDir = join(tempRoot, "export-operation-store");
    const filesPolicyHash = workspaceExportFilesPolicyHash(null);
    const first = await exportWorkspaceBundleOperation({
      destination,
      sourceWorkspaceId: connection.descriptor.workspaceId,
      sourceCheckpoint: 1,
      filesPolicyHash,
      storeDir,
      ownershipNonce: "a".repeat(48),
      capture,
    });
    const repeated = await exportWorkspaceBundleOperation({
      destination,
      sourceWorkspaceId: connection.descriptor.workspaceId,
      sourceCheckpoint: 1,
      filesPolicyHash,
      storeDir,
      capture,
    });

    expect(repeated.alreadyExported).toBe(true);
    expect(repeated.receipt).toEqual(first.receipt);
    expect(repeated.published.envelope.bundleId).toBe(first.published.envelope.bundleId);
    expect(capture).toHaveBeenCalledTimes(1);

    await expect(
      exportWorkspaceBundleOperation({
        destination,
        sourceWorkspaceId: connection.descriptor.workspaceId,
        sourceCheckpoint: 2,
        filesPolicyHash,
        operationId: first.receipt.operationId,
        storeDir,
        capture,
      }),
    ).rejects.toMatchObject({ code: "workspace-export.operation-conflict" });

    await expect(
      exportWorkspaceBundleOperation({
        destination,
        sourceWorkspaceId: connection.descriptor.workspaceId,
        sourceCheckpoint: 1,
        filesPolicyHash,
        storeDir: join(tempRoot, "wrong-neighbor-store"),
        capture,
      }),
    ).rejects.toMatchObject({
      code: "workspace-export.destination-exists-without-stable-result",
    });
  });

  it("records no reusable success receipt when the file closed set changes before publication", async () => {
    const bytes = Buffer.from("stable export\n");
    const current = snapshot(
      [artifact("artifact-a", join(workspaceRoot, "artifact.md"))],
      [revision("rev-a", "artifact-a", 1, hash(bytes))],
      1,
    );
    const exportClient = client(current, [event(1)], new Map([["rev-a", bytes]]));
    const filesConfig = {
      protocol: WORKSPACE_FILES_CONFIG_PROTOCOL,
      includes: ["**"],
      excludes: [],
    } as const;
    writeFileSync(join(workspaceRoot, "selected.txt"), "stable\n");
    const storeDir = join(tempRoot, "capture-changed-operation-store");
    let injectChange = true;
    const capture = vi.fn(async (bundleRoot: string) => {
      const manifest = await exportWorkspace(connection, workspaceRoot, bundleRoot, exportClient);
      const workspaceFiles = captureWorkspaceFiles({
        workspaceRoot,
        destination: join(bundleRoot, "workspace-files"),
        config: filesConfig,
      });
      if (injectChange) writeFileSync(join(workspaceRoot, "added-after-capture.txt"), "added\n");
      return {
        includeWorkspaceFiles: true as const,
        observedEndSeq: manifest.capturedSeq,
        workspaceFilesVerification: workspaceFiles.verification,
      };
    });
    const operation = {
      destination,
      sourceWorkspaceId: connection.descriptor.workspaceId,
      sourceCheckpoint: 1,
      filesPolicyHash: workspaceExportFilesPolicyHash(filesConfig),
      storeDir,
      capture,
    } as const;

    await expect(
      exportWorkspaceBundleOperation({
        ...operation,
        ownershipNonce: "e".repeat(48),
      }),
    ).rejects.toMatchObject({ code: "workspace-files.capture-changed" });
    expect(existsSync(destination)).toBe(false);

    injectChange = false;
    const recovered = await exportWorkspaceBundleOperation({
      ...operation,
      ownershipNonce: "f".repeat(48),
    });
    const repeated = await exportWorkspaceBundleOperation(operation);
    expect(recovered.alreadyExported).toBe(false);
    expect(repeated.alreadyExported).toBe(true);
    expect(repeated.receipt).toEqual(recovered.receipt);
    expect(capture).toHaveBeenCalledTimes(2);
  });

  it("exports stable heads, full revision history, captured attachments, and events without reading live sources", async () => {
    const historical = Buffer.from("historical revision\n");
    const head = Buffer.from("current head\n");
    const attachment = Buffer.from("review screenshot bytes");
    const afterSnapshotAttachment = Buffer.from("too late");
    const historicalHash = hash(historical);
    const headHash = hash(head);
    const attachmentHash = hash(attachment);
    const afterSnapshotHash = hash(afterSnapshotAttachment);
    const inRootSource = join(workspaceRoot, "docs", "z-plan.md");
    const externalSource = join(tempRoot, "external", "reference.md");

    const projectIdentity = join(workspaceRoot, ".tweakloop", "project.json");
    mkdirSync(join(workspaceRoot, ".tweakloop"));
    writeFileSync(projectIdentity, "identity-before\n");
    expect(existsSync(inRootSource)).toBe(false);
    expect(existsSync(externalSource)).toBe(false);

    const current = snapshot(
      [artifact("artifact-b", externalSource), artifact("artifact-a", inRootSource)],
      [
        revision("rev-head-a", "artifact-a", 4, headHash, "rev-old-a"),
        revision("rev-old-a", "artifact-a", 2, historicalHash),
        revision("rev-b", "artifact-b", 3, historicalHash),
      ],
      5,
    );
    const descriptor = {
      hash: attachmentHash,
      fileName: "review.png",
      mediaType: "image/png",
      byteLength: attachment.byteLength,
    };
    const postSnapshotDescriptor = {
      hash: afterSnapshotHash,
      fileName: "late.txt",
      mediaType: "text/plain",
      byteLength: afterSnapshotAttachment.byteLength,
    };
    const fetchRevisionSource = vi.fn(async (_connection: DaemonConnection, revisionId: string) => {
      const bytes = new Map([
        ["rev-head-a", head],
        ["rev-old-a", historical],
        ["rev-b", historical],
      ]).get(revisionId);
      if (!bytes) throw new Error(`unknown revision: ${revisionId}`);
      return bytes;
    });
    const fetchChatAttachment = vi.fn(
      async (_connection: DaemonConnection, attachmentObjectHash: string) => {
        if (attachmentObjectHash !== attachmentHash) throw new Error("post-S attachment fetched");
        return attachment;
      },
    );
    const listedEvents = [
      event(6, "chat.message", { attachments: [postSnapshotDescriptor] }),
      event(3),
      event(1),
      event(5, "chat.message", { attachments: [descriptor, { ...descriptor }] }),
      event(4),
      event(2),
    ];
    const exportClient: WorkspaceExportClient = {
      getSnapshot: vi.fn(async () => current),
      listEvents: vi.fn(async () => listedEvents),
      listWhiteboardSemanticReceipts: vi.fn(async () => []),
      fetchRevisionSource,
      fetchChatAttachment,
    };

    const manifest = await exportWorkspace(connection, workspaceRoot, destination, exportClient);
    const purePlan = planWorkspaceExport({
      expectedWorkspaceId: connection.descriptor.workspaceId,
      workspaceRoot,
      snapshot: current,
      listedEvents,
    });

    expect(manifest).toMatchObject(purePlan.manifest);
    expect(
      manifest.revisions.every((item) => item.files.every((file) => file.byteLength !== undefined)),
    ).toBe(true);
    expect(manifest.capturedSeq).toBe(5);
    expect(manifest.events.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(manifest.artifacts.map((entry) => entry.artifactId)).toEqual([
      "artifact-a",
      "artifact-b",
    ]);
    expect(manifest.revisions.map((entry) => entry.revisionId)).toEqual([
      "rev-old-a",
      "rev-b",
      "rev-head-a",
    ]);
    expect(manifest.revisions[0]?.objectPath).toBe(`.tweakloop/objects/sha256/${historicalHash}`);
    expect(manifest.revisions[1]?.objectPath).toBe(`.tweakloop/objects/sha256/${historicalHash}`);
    expect(manifest.attachments).toEqual([
      { descriptor, objectPath: `.tweakloop/objects/sha256/${attachmentHash}` },
    ]);
    expect(readFileSync(join(destination, "docs", "z-plan.md"))).toEqual(head);

    const exportedExternal = join(destination, "external", "artifact-b", "reference.md");
    expect(readFileSync(exportedExternal)).toEqual(historical);
    expect(
      readFileSync(join(destination, ".tweakloop", "objects", "sha256", historicalHash)),
    ).toEqual(historical);
    expect(readFileSync(join(destination, ".tweakloop", "objects", "sha256", headHash))).toEqual(
      head,
    );
    expect(
      readFileSync(join(destination, ".tweakloop", "objects", "sha256", attachmentHash)),
    ).toEqual(attachment);
    expect(readdirSync(join(destination, ".tweakloop", "objects", "sha256")).sort()).toEqual(
      [attachmentHash, headHash, historicalHash].sort(),
    );
    expect(fetchRevisionSource).toHaveBeenCalledTimes(2);
    expect(fetchChatAttachment).toHaveBeenCalledTimes(1);
    expect(fetchChatAttachment).toHaveBeenCalledWith(connection, attachmentHash);
    expect(existsSync(inRootSource)).toBe(false);
    expect(existsSync(externalSource)).toBe(false);
    expect(readFileSync(projectIdentity, "utf8")).toBe("identity-before\n");

    const persisted = JSON.parse(
      readFileSync(join(destination, ".tweakloop", "export-manifest.json"), "utf8"),
    ) as WorkspaceExportManifest;
    expect(persisted).toEqual(manifest);
  });

  it("refuses an existing destination before contacting the daemon", async () => {
    mkdirSync(destination);
    const getSnapshot = vi.fn(async () => snapshot([], [], 0));
    const exportClient: WorkspaceExportClient = {
      getSnapshot,
      listEvents: vi.fn(async () => []),
      listWhiteboardSemanticReceipts: vi.fn(async () => []),
      fetchRevisionSource: vi.fn(async () => Buffer.alloc(0)),
    };

    await expect(
      exportWorkspace(connection, workspaceRoot, destination, exportClient),
    ).rejects.toMatchObject({ code: "workspace-export.destination-exists" });
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a relative traversal-shaped source path without creating the destination", async () => {
    const bytes = Buffer.from("safe bytes");
    const current = snapshot(
      [artifact("artifact-a", "../../escape.md")],
      [revision("rev-a", "artifact-a", 1, hash(bytes))],
      1,
    );

    await expect(
      exportWorkspace(
        connection,
        workspaceRoot,
        destination,
        client(current, [event(1)], new Map([["rev-a", bytes]])),
      ),
    ).rejects.toMatchObject({ code: "workspace-export.source-path-invalid" });
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(tempRoot, "escape.md"))).toBe(false);
  });

  it("rejects portable path collisions before creating the destination", async () => {
    const upper = Buffer.from("upper");
    const lower = Buffer.from("lower");
    const current = snapshot(
      [
        artifact("artifact-a", join(workspaceRoot, "docs", "Plan.md")),
        artifact("artifact-b", join(workspaceRoot, "docs", "plan.md")),
      ],
      [
        revision("rev-a", "artifact-a", 1, hash(upper)),
        revision("rev-b", "artifact-b", 2, hash(lower)),
      ],
      2,
    );

    await expect(
      exportWorkspace(
        connection,
        workspaceRoot,
        destination,
        client(
          current,
          [event(1), event(2)],
          new Map([
            ["rev-a", upper],
            ["rev-b", lower],
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "workspace-export.path-collision" });
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects corrupted immutable revision bytes before creating the destination", async () => {
    const expected = Buffer.from("expected");
    const corrupted = Buffer.from("corrupted");
    const current = snapshot(
      [artifact("artifact-a", join(workspaceRoot, "artifact.md"))],
      [revision("rev-a", "artifact-a", 1, hash(expected))],
      1,
    );

    await expect(
      exportWorkspace(
        connection,
        workspaceRoot,
        destination,
        client(current, [event(1)], new Map([["rev-a", corrupted]])),
      ),
    ).rejects.toMatchObject({ code: "workspace-export.hash-mismatch" });
    expect(existsSync(destination)).toBe(false);
  });

  it("rejects an incomplete event read even when the snapshot and head look valid", async () => {
    const bytes = Buffer.from("head");
    const current = snapshot(
      [artifact("artifact-a", join(workspaceRoot, "artifact.md"))],
      [revision("rev-a", "artifact-a", 2, hash(bytes))],
      2,
    );

    await expect(
      exportWorkspace(
        connection,
        workspaceRoot,
        destination,
        client(current, [event(2)], new Map([["rev-a", bytes]])),
      ),
    ).rejects.toMatchObject({ code: "workspace-export.events-incomplete" });
    expect(existsSync(destination)).toBe(false);
  });
});
