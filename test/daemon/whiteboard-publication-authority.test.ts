import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import { stateDirFor } from "../../src/daemon/runtime.js";

let stateRoot: string;
let workspaceRoot: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-publication-authority-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-publication-authority-workspace-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("whiteboard publication transport authority", () => {
  it("derives special-route attribution before mutation and preserves exact retries", async () => {
    const source = join(workspaceRoot, "publication-authority.excalidraw");
    writeFileSync(source, scene("published base"));
    const base = await publishSource(source);
    const draftPath = `/api/v1/whiteboards/${base.artifactId}/draft`;
    const initialized = await fetch(shell(draftPath), {
      method: "PUT",
      headers: draftHeaders({
        baseRevisionId: base.revisionId,
        expectedVersion: 0,
        clientId: "publication-authority",
        clientSequence: 1,
      }),
      body: scene("agent publication"),
    });
    expect(initialized.status).toBe(200);

    const publication = (
      commandId: string,
      idempotencyKey: string,
      revisionId: string,
      actor: { kind: "human" | "agent" | "system"; id: string },
      expectedDraftVersion = 1,
      expectedHeadRevisionId = base.revisionId,
      draftId = "draft_1",
    ) => ({
      protocol: "tweakloop.command/v1",
      commandId,
      idempotencyKey,
      workspaceId: daemon.workspaceId,
      actor,
      type: "whiteboard.publish-draft",
      payload: {
        artifactId: base.artifactId,
        draftId,
        expectedDraftVersion,
        expectedHeadRevisionId,
        revisionId,
      },
    });
    const cliHeaders = {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    };

    for (const forbiddenActor of [
      { kind: "human", id: "forged-human" },
      { kind: "system", id: "forged-system" },
    ] as const) {
      const before = durablePublicationState(base.artifactId);
      const rejected = await fetch(shell("/api/v1/commands"), {
        method: "POST",
        headers: cliHeaders,
        body: JSON.stringify(
          publication(
            `command-${forbiddenActor.kind}`,
            `publication:${forbiddenActor.kind}`,
            `revision-${forbiddenActor.kind}`,
            forbiddenActor,
          ),
        ),
      });
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({
        protocol: "tweakloop.whiteboard-error/v1",
        code: "authority.publication-agent-required",
      });
      expect(durablePublicationState(base.artifactId)).toEqual(before);
    }

    const agentCommand = publication(
      "command-agent-publication",
      "publication:agent",
      "revision-agent-publication",
      { kind: "agent", id: "declared-publication-agent" },
    );
    const agentResponse = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: cliHeaders,
      body: JSON.stringify(agentCommand),
    });
    expect(agentResponse.status).toBe(200);
    const agentReceipt = await agentResponse.json();
    const agentRetry = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: cliHeaders,
      body: JSON.stringify(agentCommand),
    });
    expect(await agentRetry.json()).toEqual(agentReceipt);
    expect(
      (await events()).find((event) => event.payload.revisionId === "revision-agent-publication")
        ?.actor,
    ).toEqual({ kind: "agent", id: "declared-publication-agent" });

    const advanced = await fetch(shell(draftPath), {
      method: "PUT",
      headers: draftHeaders({
        draftId: "draft_2",
        baseRevisionId: "revision-agent-publication",
        expectedVersion: 0,
        clientId: "publication-authority",
        clientSequence: 2,
      }),
      body: scene("browser publication"),
    });
    expect(advanced.status).toBe(200);

    const browserHeaders = await authenticatedBrowserHeaders();
    const browserCommand = publication(
      "command-browser-publication",
      "publication:browser",
      "revision-browser-publication",
      { kind: "agent", id: "forged-browser-agent" },
      1,
      "revision-agent-publication",
      "draft_2",
    );
    const browserResponse = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify(browserCommand),
    });
    expect(browserResponse.status).toBe(200);
    const browserReceipt = await browserResponse.json();
    const browserRetry = await fetch(shell("/api/v1/commands"), {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        ...browserCommand,
        actor: { kind: "system", id: "forged-browser-system" },
      }),
    });
    expect(await browserRetry.json()).toEqual(browserReceipt);
    expect(
      (await events()).find((event) => event.payload.revisionId === "revision-browser-publication")
        ?.actor,
    ).toEqual({ kind: "human", id: "browser" });
  });
});

function shell(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
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
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  });
}

async function publishSource(path: string): Promise<{ artifactId: string; revisionId: string }> {
  const response = await fetch(shell("/api/v1/publish"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ path, actor: { kind: "agent", id: "fixture" } }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as { artifactId: string; revisionId: string };
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

async function authenticatedBrowserHeaders(): Promise<Record<string, string>> {
  const minted = await fetch(shell("/api/v1/bootstrap-tokens"), {
    method: "POST",
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  });
  expect(minted.status).toBe(201);
  const bootstrap = await fetch(((await minted.json()) as { url: string }).url, {
    redirect: "manual",
  });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return {
    cookie,
    origin: `http://127.0.0.1:${daemon.shellPort}`,
    "content-type": "application/json",
  };
}

function durablePublicationState(artifactId: string): Readonly<Record<string, unknown>> {
  const db = new Database(join(stateDirFor(daemon.workspaceId), "events.sqlite"), {
    readonly: true,
  });
  try {
    return {
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      commandReceipts: db
        .prepare("SELECT * FROM command_receipts ORDER BY workspace_id, idempotency_key")
        .all(),
      revisions: db
        .prepare("SELECT * FROM p_revisions WHERE artifact_id = ? ORDER BY seq")
        .all(artifactId),
      draft: db.prepare("SELECT * FROM whiteboard_drafts WHERE artifact_id = ?").get(artifactId),
      draftReceipts: db
        .prepare(
          "SELECT * FROM whiteboard_draft_receipts WHERE artifact_id = ? ORDER BY client_id, client_sequence",
        )
        .all(artifactId),
    };
  } finally {
    db.close();
  }
}

async function events(): Promise<
  Array<{ actor: { kind: string; id: string }; payload: { revisionId?: string } }>
> {
  return (await (
    await fetch(shell("/api/v1/events?after=0"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    })
  ).json()) as Array<{
    actor: { kind: string; id: string };
    payload: { revisionId?: string };
  }>;
}
