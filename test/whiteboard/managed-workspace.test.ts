import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  DaemonConnection,
  WhiteboardDraftConflict,
  WhiteboardDraftMetadata,
} from "../../src/cli/daemon-client.js";
import {
  ManagedWhiteboardWorkspace,
  type WhiteboardWorkspaceClient,
  whiteboardSyncStatePath,
} from "../../src/cli/whiteboard-workspace.js";
import { canonicalizeWhiteboardScene } from "../../src/whiteboard/scene.js";

let tempRoot: string;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "tweakloop-managed-whiteboard-"));
});

afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

const connection: DaemonConnection = {
  baseUrl: "http://127.0.0.1:10001",
  token: "test-token",
  descriptor: {
    pid: 1,
    startNonce: "start",
    shellPort: 10001,
    artifactPort: 10002,
    protocolVersion: 1,
    workspaceId: "ws_managed_test",
    cliToken: "test-token",
  },
};

function scene(
  label: string,
  overrides: Readonly<{
    targetId?: string;
    targetType?: string;
    includeOther?: boolean;
    anchorId?: string | null;
  }> = {},
): Buffer {
  const targetId = overrides.targetId ?? "target-1";
  const targetType = overrides.targetType ?? "text";
  const anchorId = overrides.anchorId === undefined ? "anchor-target-1" : overrides.anchorId;
  return Buffer.from(
    JSON.stringify({
      type: "excalidraw",
      version: 2,
      source: "https://tweakloop.local",
      elements: [
        {
          id: targetId,
          type: targetType,
          version: label.length,
          versionNonce: label.length * 10,
          ...(targetType === "text" ? { text: label } : {}),
          ...(anchorId === null ? {} : { customData: { tweakloop: { schema: 1, anchorId } } }),
        },
        ...(overrides.includeOther === false
          ? []
          : [{ id: "other-1", type: "rectangle", version: 1, versionNonce: 2 }]),
      ],
      appState: { viewBackgroundColor: "#fff", scrollX: 42 },
      files: {},
    }),
  );
}

function metadata(
  bytes: Buffer,
  overrides: Partial<WhiteboardDraftMetadata> = {},
): WhiteboardDraftMetadata {
  const canonical = canonicalizeWhiteboardScene(bytes);
  return {
    protocol: "tweakloop.whiteboard-draft/v1",
    status: "accepted",
    artifactId: "artifact-board",
    draftId: "draft-board",
    baseRevisionId: "rev-base",
    draftVersion: 3,
    sceneHash: canonical.hash,
    elementIndexHash: canonical.elementIndexHash,
    sceneUrl: `http://127.0.0.1:10002/objects/sha256/${canonical.hash}`,
    publishedRevisionId: null,
    ...overrides,
  };
}

function clientFor(
  initialBytes: Buffer,
  overrides: Partial<WhiteboardWorkspaceClient> = {},
): WhiteboardWorkspaceClient {
  const initial = metadata(initialBytes);
  return {
    getDraft: vi.fn(async () => initial),
    fetchScene: vi.fn(async () => canonicalizeWhiteboardScene(initialBytes).bytes),
    putDraft: vi.fn(async (_connection, input) => {
      const accepted = canonicalizeWhiteboardScene(input.bytes);
      return metadata(accepted.bytes, {
        draftVersion: input.expectedDraftVersion + 1,
        sceneHash: accepted.hash,
        elementIndexHash: accepted.elementIndexHash,
      });
    }),
    publishDraft: vi.fn(async (_connection, input) => ({
      status: "accepted" as const,
      commandId: input.commandId,
      firstEventSeq: 20,
      lastEventSeq: 20,
      response: {
        protocol: "tweakloop.whiteboard-publish/v1",
        artifactId: input.artifactId,
        draftId: input.draftId,
        draftVersion: input.expectedDraftVersion,
        revisionId: input.revisionId,
        seq: 20,
        unchanged: false,
        sceneHash: initial.sceneHash,
        elementIndexHash: initial.elementIndexHash,
      },
    })),
    ...overrides,
  };
}

function managed(client: WhiteboardWorkspaceClient): ManagedWhiteboardWorkspace {
  let sequence = 0;
  return new ManagedWhiteboardWorkspace(connection, {
    client,
    newId: (prefix) => `${prefix}_test_${++sequence}`,
  });
}

function state(scenePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(whiteboardSyncStatePath(scenePath), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("managed whiteboard agent workspace", () => {
  it("checks out canonical bytes with a bound opaque sidecar and selected identity contract", async () => {
    const initial = scene("initial");
    const client = clientFor(initial);
    const workspace = managed(client);
    const scenePath = join(tempRoot, "nested", "board.excalidraw");

    const result = await workspace.checkout({
      artifactId: "artifact-board",
      scenePath,
      agentId: "agent-codex",
      targetElementIds: ["target-1", "target-1"],
    });

    expect(result).toMatchObject({
      status: "checked-out",
      artifactId: "artifact-board",
      draftVersion: 3,
      scenePath,
      targetElementIds: ["target-1"],
    });
    expect(readFileSync(scenePath)).toEqual(canonicalizeWhiteboardScene(initial).bytes);
    expect(state(scenePath)).toMatchObject({
      protocol: "tweakloop.whiteboard-workspace/v1",
      workspaceId: "ws_managed_test",
      scenePath,
      artifactId: "artifact-board",
      draftId: "draft-board",
      baseRevisionId: "rev-base",
      draftVersion: 3,
      nextClientSequence: 1,
      agentId: "agent-codex",
      targetElements: [
        {
          elementId: "target-1",
          elementType: "text",
          anchorId: "anchor-target-1",
        },
      ],
    });
    expect(client.getDraft).toHaveBeenCalledWith(connection, "artifact-board");
    expect(client.fetchScene).toHaveBeenCalledWith(
      connection,
      canonicalizeWhiteboardScene(initial).hash,
    );

    await expect(
      workspace.checkout({
        artifactId: "artifact-board",
        scenePath,
        agentId: "agent-codex",
      }),
    ).rejects.toMatchObject({ code: "whiteboard.workspace-exists" });
  });

  it("rejects unknown or replaced target identities before any draft mutation", async () => {
    const initial = scene("initial");
    const putDraft = vi.fn<WhiteboardWorkspaceClient["putDraft"]>();
    const client = clientFor(initial, { putDraft });
    const workspace = managed(client);
    const unknownPath = join(tempRoot, "unknown.excalidraw");

    await expect(
      workspace.checkout({
        artifactId: "artifact-board",
        scenePath: unknownPath,
        agentId: "agent-codex",
        targetElementIds: ["missing"],
      }),
    ).rejects.toMatchObject({ code: "whiteboard.workspace-target-unknown" });
    expect(putDraft).not.toHaveBeenCalled();

    const scenePath = join(tempRoot, "targeted.excalidraw");
    await workspace.checkout({
      artifactId: "artifact-board",
      scenePath,
      agentId: "agent-codex",
      targetElementIds: ["target-1"],
    });
    writeFileSync(scenePath, scene("replacement", { targetId: "replacement-1" }));

    await expect(workspace.sync(scenePath)).rejects.toMatchObject({
      code: "whiteboard.workspace-target-missing",
    });
    expect(putDraft).not.toHaveBeenCalled();
    expect(state(scenePath)).toMatchObject({ nextClientSequence: 1, pendingSync: null });
  });

  it("rejects same-ID and same-type replacement of a targeted collaboration anchor", async () => {
    const initial = scene("initial");
    const putDraft = vi.fn<WhiteboardWorkspaceClient["putDraft"]>();
    const workspace = managed(clientFor(initial, { putDraft }));
    const scenePath = join(tempRoot, "anchor.excalidraw");
    await workspace.checkout({
      artifactId: "artifact-board",
      scenePath,
      agentId: "agent-codex",
      targetElementIds: ["target-1"],
    });

    writeFileSync(scenePath, scene("same element", { anchorId: "replacement-anchor" }));
    await expect(workspace.sync(scenePath)).rejects.toMatchObject({
      code: "whiteboard.workspace-target-anchor-replaced",
      details: {
        elementId: "target-1",
        expectedAnchorId: "anchor-target-1",
        actualAnchorId: "replacement-anchor",
      },
    });
    expect(putDraft).not.toHaveBeenCalled();
    expect(state(scenePath)).toMatchObject({ nextClientSequence: 1, pendingSync: null });
  });

  it("hides CAS metadata, advances it only after acceptance, and rejects a swapped sidecar", async () => {
    const initial = scene("initial");
    const putDraft = vi.fn<WhiteboardWorkspaceClient["putDraft"]>(async (_connection, input) => {
      const canonical = canonicalizeWhiteboardScene(input.bytes);
      return metadata(canonical.bytes, {
        draftVersion: 4,
        sceneHash: canonical.hash,
        elementIndexHash: canonical.elementIndexHash,
      });
    });
    const client = clientFor(initial, { putDraft });
    const workspace = managed(client);
    const firstPath = join(tempRoot, "first.excalidraw");
    const secondPath = join(tempRoot, "second.excalidraw");
    await workspace.checkout({
      artifactId: "artifact-board",
      scenePath: firstPath,
      agentId: "agent-codex",
      targetElementIds: ["target-1"],
    });
    await workspace.checkout({
      artifactId: "artifact-board",
      scenePath: secondPath,
      agentId: "agent-codex",
    });

    copyFileSync(whiteboardSyncStatePath(firstPath), whiteboardSyncStatePath(secondPath));
    await expect(workspace.sync(secondPath)).rejects.toMatchObject({
      code: "whiteboard.workspace-binding-mismatch",
    });
    expect(putDraft).not.toHaveBeenCalled();

    writeFileSync(firstPath, scene("agent edit"));
    const result = await workspace.sync(firstPath);
    expect(result).toMatchObject({ status: "accepted", draftVersion: 4 });
    expect(putDraft).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({
        artifactId: "artifact-board",
        draftId: "draft-board",
        baseRevisionId: "rev-base",
        expectedDraftVersion: 3,
        clientSequence: 1,
        agentId: "agent-codex",
      }),
    );
    expect(state(firstPath)).toMatchObject({
      draftVersion: 4,
      nextClientSequence: 2,
      pendingSync: null,
      blockedConflict: null,
    });
  });

  it("persists one retry identity across an unknown network outcome and fails closed if bytes change", async () => {
    const initial = scene("initial");
    const acceptedCalls: Parameters<WhiteboardWorkspaceClient["putDraft"]>[1][] = [];
    let failNetwork = true;
    const putDraft = vi.fn<WhiteboardWorkspaceClient["putDraft"]>(async (_connection, input) => {
      acceptedCalls.push(input);
      if (failNetwork) throw new Error("socket closed after upload");
      const canonical = canonicalizeWhiteboardScene(input.bytes);
      return metadata(canonical.bytes, {
        draftVersion: 4,
        sceneHash: canonical.hash,
        elementIndexHash: canonical.elementIndexHash,
      });
    });
    const workspace = managed(clientFor(initial, { putDraft }));
    const scenePath = join(tempRoot, "retry.excalidraw");
    await workspace.checkout({ artifactId: "artifact-board", scenePath, agentId: "agent-codex" });
    const firstEdit = scene("first edit");
    writeFileSync(scenePath, firstEdit);

    await expect(workspace.sync(scenePath)).rejects.toThrow("socket closed after upload");
    expect(state(scenePath)).toMatchObject({
      nextClientSequence: 1,
      pendingSync: {
        clientSequence: 1,
        sceneHash: canonicalizeWhiteboardScene(firstEdit).hash,
      },
    });

    writeFileSync(scenePath, scene("different edit"));
    await expect(workspace.sync(scenePath)).rejects.toMatchObject({
      code: "whiteboard.workspace-ambiguous-sync",
    });
    expect(putDraft).toHaveBeenCalledTimes(1);

    writeFileSync(scenePath, firstEdit);
    failNetwork = false;
    await workspace.sync(scenePath);
    expect(putDraft).toHaveBeenCalledTimes(2);
    expect(acceptedCalls[0]).toMatchObject({ clientSequence: 1 });
    expect(acceptedCalls[1]).toMatchObject({ clientSequence: 1 });
    expect(acceptedCalls[1]?.bytes).toEqual(acceptedCalls[0]?.bytes);
    expect(state(scenePath)).toMatchObject({ nextClientSequence: 2, pendingSync: null });
  });

  it("retains conflicts in the sidecar and never turns a second sync into a silent overwrite", async () => {
    const initial = scene("initial");
    const submitted = canonicalizeWhiteboardScene(scene("losing edit"));
    const conflict: WhiteboardDraftConflict = {
      protocol: "tweakloop.whiteboard-draft/v1",
      status: "conflict",
      code: "whiteboard.draft-conflict",
      conflictId: "conflict-retained",
      artifactId: "artifact-board",
      draftId: "draft-board",
      baseRevisionId: "rev-base",
      expectedDraftVersion: 3,
      currentDraftVersion: 4,
      submittedSceneHash: submitted.hash,
      currentSceneHash: "f".repeat(64),
    };
    const putDraft = vi.fn<WhiteboardWorkspaceClient["putDraft"]>(async () => conflict);
    const publishDraft = vi.fn<WhiteboardWorkspaceClient["publishDraft"]>();
    const workspace = managed(clientFor(initial, { putDraft, publishDraft }));
    const scenePath = join(tempRoot, "conflict.excalidraw");
    await workspace.checkout({ artifactId: "artifact-board", scenePath, agentId: "agent-codex" });
    writeFileSync(scenePath, submitted.bytes);

    const first = await workspace.sync(scenePath);
    const second = await workspace.sync(scenePath);
    expect(first).toMatchObject({ status: "conflict", retained: true, conflict });
    expect(second).toEqual(first);
    expect(putDraft).toHaveBeenCalledTimes(1);
    expect(state(scenePath)).toMatchObject({
      nextClientSequence: 2,
      pendingSync: null,
      blockedConflict: conflict,
    });
    await expect(workspace.publish(scenePath)).rejects.toMatchObject({
      code: "whiteboard.workspace-conflicted",
    });
    expect(publishDraft).not.toHaveBeenCalled();
  });

  it("publishes the observed draft with persisted retry IDs and no caller-supplied CAS metadata", async () => {
    const initial = scene("initial");
    const initialMetadata = metadata(initial);
    const publishInputs: Parameters<WhiteboardWorkspaceClient["publishDraft"]>[1][] = [];
    let failNetwork = true;
    const publishDraft = vi.fn<WhiteboardWorkspaceClient["publishDraft"]>(
      async (_connection, input) => {
        publishInputs.push(input);
        if (failNetwork) throw new Error("socket closed after publication");
        return {
          status: "accepted",
          commandId: input.commandId,
          firstEventSeq: 30,
          lastEventSeq: 30,
          response: {
            protocol: "tweakloop.whiteboard-publish/v1",
            artifactId: input.artifactId,
            draftId: input.draftId,
            draftVersion: input.expectedDraftVersion,
            revisionId: input.revisionId,
            unchanged: false,
            sceneHash: initialMetadata.sceneHash,
          },
        };
      },
    );
    const workspace = managed(clientFor(initial, { publishDraft }));
    const scenePath = join(tempRoot, "publish.excalidraw");
    await workspace.checkout({ artifactId: "artifact-board", scenePath, agentId: "agent-codex" });

    await expect(workspace.publish(scenePath)).rejects.toThrow("socket closed after publication");
    const pending = state(scenePath).pendingPublish;
    expect(pending).toMatchObject({ draftVersion: 3, sceneHash: initialMetadata.sceneHash });

    failNetwork = false;
    const published = await workspace.publish(scenePath);
    expect(published).toMatchObject({
      status: "accepted",
      artifactId: "artifact-board",
      draftVersion: 3,
      sceneHash: initialMetadata.sceneHash,
      unchanged: false,
    });
    expect(publishInputs).toHaveLength(2);
    expect(publishInputs[1]).toEqual(publishInputs[0]);
    expect(publishInputs[0]).toMatchObject({
      artifactId: "artifact-board",
      draftId: "draft-board",
      expectedDraftVersion: 3,
      expectedHeadRevisionId: "rev-base",
      agentId: "agent-codex",
    });
    expect(state(scenePath)).toMatchObject({
      pendingPublish: null,
      publishedRevisionId: published.revisionId,
    });

    const repeated = await workspace.publish(scenePath);
    expect(repeated).toMatchObject({ unchanged: true, revisionId: published.revisionId });
    expect(publishDraft).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh version-zero draft when checkout follows a published revision", async () => {
    const initial = scene("published head");
    const publishedMetadata = metadata(initial, { publishedRevisionId: "rev-published" });
    const putDraft = vi.fn<WhiteboardWorkspaceClient["putDraft"]>(async (_connection, input) => {
      const canonical = canonicalizeWhiteboardScene(input.bytes);
      return {
        ...publishedMetadata,
        draftId: input.draftId,
        baseRevisionId: input.baseRevisionId,
        draftVersion: 1,
        sceneHash: canonical.hash,
        elementIndexHash: canonical.elementIndexHash,
        publishedRevisionId: null,
      };
    });
    const publishDraft = vi.fn<WhiteboardWorkspaceClient["publishDraft"]>();
    const client = clientFor(initial, {
      getDraft: vi.fn(async () => publishedMetadata),
      putDraft,
      publishDraft,
    });
    const workspace = managed(client);
    const scenePath = join(tempRoot, "after-publish.excalidraw");

    const checkedOut = await workspace.checkout({
      artifactId: "artifact-board",
      scenePath,
      agentId: "agent-codex",
    });
    expect(checkedOut.draftVersion).toBe(0);
    expect(state(scenePath)).toMatchObject({
      baseRevisionId: "rev-published",
      draftVersion: 0,
      needsInitialSync: true,
      publishedRevisionId: null,
    });
    await expect(workspace.publish(scenePath)).rejects.toMatchObject({
      code: "whiteboard.workspace-needs-sync",
    });
    expect(publishDraft).not.toHaveBeenCalled();

    await workspace.sync(scenePath);
    expect(putDraft).toHaveBeenCalledWith(
      connection,
      expect.objectContaining({
        baseRevisionId: "rev-published",
        expectedDraftVersion: 0,
      }),
    );
    expect(state(scenePath)).toMatchObject({
      draftVersion: 1,
      needsInitialSync: false,
    });
  });

  it("refuses to publish unsynced working bytes", async () => {
    const initial = scene("initial");
    const publishDraft = vi.fn<WhiteboardWorkspaceClient["publishDraft"]>();
    const workspace = managed(clientFor(initial, { publishDraft }));
    const scenePath = join(tempRoot, "unsynced.excalidraw");
    await workspace.checkout({ artifactId: "artifact-board", scenePath, agentId: "agent-codex" });
    writeFileSync(scenePath, scene("not synced"));

    await expect(workspace.publish(scenePath)).rejects.toMatchObject({
      code: "whiteboard.workspace-unsynced",
    });
    expect(publishDraft).not.toHaveBeenCalled();
  });
});
