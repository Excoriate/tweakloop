import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DaemonConnection } from "../../src/cli/daemon-client.js";
import {
  ManagedWhiteboardWorkspace,
  type WhiteboardWorkspaceError,
} from "../../src/cli/whiteboard-workspace.js";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";

let stateRoot: string;
let workspaceRoot: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-managed-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-managed-workspace-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function scene(label: string): string {
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "https://tweakloop.local",
    elements: [
      {
        id: "target-1",
        type: "text",
        version: label.length,
        versionNonce: label.length * 10,
        text: label,
      },
    ],
    appState: { viewBackgroundColor: "#fff", scrollX: 60 },
    files: {},
  });
}

function shell(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

function artifact(path: string): string {
  return `http://127.0.0.1:${daemon.artifactPort}${path}`;
}

function connection(): DaemonConnection {
  return {
    baseUrl: shell("/"),
    token: daemon.cliToken,
    descriptor: {
      pid: process.pid,
      startNonce: "managed-test",
      shellPort: daemon.shellPort,
      artifactPort: daemon.artifactPort,
      protocolVersion: 1,
      workspaceId: daemon.workspaceId,
      cliToken: daemon.cliToken,
    },
  };
}

describe("managed whiteboard workspace over the live daemon", () => {
  it("checks out, syncs, and publishes without caller-managed draft or revision identifiers", async () => {
    const sourcePath = join(workspaceRoot, "source.excalidraw");
    writeFileSync(sourcePath, scene("published base"));
    const publishedResponse = await fetch(shell("/api/v1/publish"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: sourcePath, actor: { kind: "agent", id: "fixture" } }),
    });
    expect(publishedResponse.status).toBe(200);
    const base = (await publishedResponse.json()) as { artifactId: string; revisionId: string };

    const initialized = await fetch(shell(`/api/v1/whiteboards/${base.artifactId}/draft`), {
      method: "PUT",
      headers: {
        authorization: `Bearer ${daemon.cliToken}`,
        "content-type": "application/vnd.excalidraw+json",
        "x-tweakloop-draft-id": "draft-human",
        "x-tweakloop-base-revision": base.revisionId,
        "x-tweakloop-expected-version": "0",
        "x-tweakloop-client-id": "human",
        "x-tweakloop-client-sequence": "1",
        "x-tweakloop-agent-id": "human",
      },
      body: scene("human draft"),
    });
    expect(initialized.status).toBe(200);

    let generated = 0;
    const managed = new ManagedWhiteboardWorkspace(connection(), {
      newId: (prefix) => `${prefix}_managed_${++generated}`,
    });
    const workingPath = join(workspaceRoot, "agent", "working.excalidraw");
    const checkout = await managed.checkout({
      artifactId: base.artifactId,
      scenePath: workingPath,
      agentId: "agent-codex",
      targetElementIds: ["target-1"],
    });
    expect(checkout).toMatchObject({ status: "checked-out", draftVersion: 1 });

    writeFileSync(workingPath, scene("agent managed edit"));
    const synced = await managed.sync(workingPath);
    expect(synced).toMatchObject({ status: "accepted", draftVersion: 2 });

    const immutable = await managed.publish(workingPath);
    expect(immutable).toMatchObject({
      status: "accepted",
      artifactId: base.artifactId,
      draftVersion: 2,
      unchanged: false,
    });
    const rendered = await fetch(artifact(`/r/${immutable.revisionId}/`));
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain("agent managed edit");

    await expect(managed.sync(workingPath)).rejects.toMatchObject<
      Partial<WhiteboardWorkspaceError>
    >({ code: "whiteboard.workspace-published" });
  });
});
