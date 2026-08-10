import { mkdtempSync, rmSync } from "node:fs";
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
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-receipt-authority-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-receipt-authority-workspace-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("generic command receipt authority ordering", () => {
  it("rejects CLI forged-human replay before HTML and Markdown create/publish receipts", async () => {
    const browserHeaders = await authenticatedBrowserHeaders();
    for (const candidate of [
      {
        format: "html" as const,
        extension: "html",
        mediaType: "text/html",
        initial: '<!doctype html><p data-tweak-id="scope" data-tweak-kind="paragraph">One</p>',
        updated: '<!doctype html><p data-tweak-id="scope" data-tweak-kind="paragraph">Two</p>',
      },
      {
        format: "markdown" as const,
        extension: "md",
        mediaType: "text/markdown",
        initial: "# Scope {#scope}\n\nOne.\n",
        updated: "# Scope {#scope}\n\nTwo.\n",
      },
    ]) {
      const artifactId = `artifact_receipt_${candidate.format}`;
      const entryPath = `receipt.${candidate.extension}`;
      const sourcePath = join(workspaceRoot, entryPath);
      const createHash = await stageObject(
        Buffer.from(candidate.initial),
        candidate.mediaType,
        entryPath,
      );
      const createEnvelope = {
        protocol: "tweakloop.command/v1",
        commandId: `command_create_${candidate.format}`,
        idempotencyKey: `receipt:create:${candidate.format}`,
        workspaceId: daemon.workspaceId,
        actor: { kind: "agent", id: "forged-browser-body" },
        type: "artifact.create",
        payload: {
          artifactId,
          name: entryPath,
          format: candidate.format,
          sourcePath,
          provenance: { kind: "generated" },
          revisionId: `revision_create_${candidate.format}`,
          entryPath,
          entryHash: createHash,
          files: [{ path: entryPath, hash: createHash, mediaType: candidate.mediaType }],
          producer: { kind: "human", id: "browser" },
          attachment: null,
        },
      };
      await expectBrowserAccepted(createEnvelope, browserHeaders);
      await expectCliForgedHumanReplayRejected(createEnvelope);

      const publishHash = await stageObject(
        Buffer.from(candidate.updated),
        candidate.mediaType,
        entryPath,
      );
      const publishEnvelope = {
        protocol: "tweakloop.command/v1",
        commandId: `command_publish_${candidate.format}`,
        idempotencyKey: `receipt:publish:${candidate.format}`,
        workspaceId: daemon.workspaceId,
        actor: { kind: "system", id: "forged-browser-body" },
        type: "artifact.publish",
        payload: {
          artifactId,
          revisionId: `revision_publish_${candidate.format}`,
          format: candidate.format,
          entryPath,
          entryHash: publishHash,
          files: [{ path: entryPath, hash: publishHash, mediaType: candidate.mediaType }],
          producer: { kind: "human", id: "browser" },
          sourcePath,
        },
      };
      await expectBrowserAccepted(publishEnvelope, browserHeaders);
      await expectCliForgedHumanReplayRejected(publishEnvelope);
    }
  });
});

async function expectBrowserAccepted(
  envelope: Readonly<Record<string, unknown>>,
  headers: Record<string, string>,
): Promise<void> {
  const response = await fetch(shell("/api/v1/commands"), {
    method: "POST",
    headers,
    body: JSON.stringify(envelope),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ status: "accepted" });
}

async function expectCliForgedHumanReplayRejected(
  browserEnvelope: Readonly<Record<string, unknown>>,
): Promise<void> {
  const before = await durableCommandState();
  const response = await fetch(shell("/api/v1/commands"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      ...browserEnvelope,
      actor: { kind: "human", id: "browser" },
    }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
    status: "rejected",
    code: "authority.browser-human-required",
  });
  expect(await durableCommandState()).toEqual(before);
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

async function stageObject(bytes: Buffer, mediaType: string, fileName: string): Promise<string> {
  const response = await fetch(shell("/api/v1/chat/attachments"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": mediaType,
      "x-tweakloop-filename": encodeURIComponent(fileName),
    },
    body: bytes,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { hash: string }).hash;
}

async function durableCommandState(): Promise<Readonly<Record<string, unknown>>> {
  const snapshot = await (
    await fetch(shell("/api/v1/snapshot"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    })
  ).json();
  const db = new Database(join(stateDirFor(daemon.workspaceId), "events.sqlite"), {
    readonly: true,
  });
  try {
    return {
      snapshot,
      events: db.prepare("SELECT * FROM events ORDER BY seq").all(),
      receipts: db
        .prepare("SELECT * FROM command_receipts ORDER BY workspace_id, idempotency_key")
        .all(),
      requestHashes: db
        .prepare("SELECT * FROM command_request_hashes ORDER BY workspace_id, idempotency_key")
        .all(),
      artifacts: db.prepare("SELECT * FROM p_artifacts ORDER BY artifact_id").all(),
      revisions: db.prepare("SELECT * FROM p_revisions ORDER BY revision_id").all(),
    };
  } finally {
    db.close();
  }
}

function shell(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}
