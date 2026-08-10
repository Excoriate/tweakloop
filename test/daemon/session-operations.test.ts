import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-session-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-session-workspace-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

function url(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

const headers = () => ({
  authorization: `Bearer ${daemon.cliToken}`,
  "content-type": "application/json",
});

async function startSession(sessionId: string): Promise<void> {
  const response = await fetch(url("/api/v1/commands"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `start_${sessionId}`,
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
        title: "Existing session",
        goal: "Reuse without partial publication",
      },
    }),
  });
  expect(response.status).toBe(200);
}

async function openArtifact(
  sessionId: string,
  path: string,
  requestId: string,
  role: "primary" | "opened" = "opened",
) {
  return await fetch(url("/api/v1/sessions/open-artifact"), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      sessionId,
      path,
      requestId,
      expectedContentSha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
      role,
      actor: { kind: "agent", id: "codex" },
    }),
  });
}

async function events(): Promise<unknown[]> {
  return (await (
    await fetch(url("/api/v1/events?after=0"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    })
  ).json()) as unknown[];
}

async function session(sessionId: string): Promise<Record<string, unknown>> {
  return (await (
    await fetch(url(`/api/v1/sessions/${sessionId}`), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    })
  ).json()) as Record<string, unknown>;
}

async function snapshot(): Promise<unknown> {
  return await (
    await fetch(url("/api/v1/snapshot"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    })
  ).json();
}

function commandReceiptCount(): number {
  const db = new Database(join(stateDirFor(daemon.workspaceId), "events.sqlite"), {
    readonly: true,
  });
  try {
    return (db.prepare("SELECT COUNT(*) AS count FROM command_receipts").get() as { count: number })
      .count;
  } finally {
    db.close();
  }
}

function casInventory(): string[] {
  const root = join(stateDirFor(daemon.workspaceId), "objects", "sha256");
  const files: string[] = [];
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  try {
    walk(root, "");
  } catch {
    return [];
  }
  return files.sort();
}

describe("atomic existing-session operations", () => {
  it("opens atomically, rolls physical CAS back on rejection, attaches explicitly, and mints zero-event URLs", async () => {
    await startSession("session_primary");
    const primaryPath = join(workspaceRoot, "primary.html");
    writeFileSync(primaryPath, "<!doctype html><h1>Primary</h1>");
    const beforeContentMismatch = {
      events: await events(),
      cas: casInventory(),
      session: await session("session_primary"),
      snapshot: await snapshot(),
      receipts: commandReceiptCount(),
    };
    for (const invalidExpectedHash of [undefined, "A".repeat(64)]) {
      const invalidHash = await fetch(url("/api/v1/sessions/open-artifact"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          sessionId: "session_primary",
          path: primaryPath,
          requestId: "open_primary",
          ...(invalidExpectedHash === undefined
            ? {}
            : { expectedContentSha256: invalidExpectedHash }),
          role: "primary",
          actor: { kind: "agent", id: "codex" },
        }),
      });
      expect(invalidHash.status).toBe(400);
      expect(await invalidHash.json()).toMatchObject({
        protocol: "tweakloop.session-open-error/v1",
        code: "session.open-content-hash-invalid",
      });
      expect(await events()).toEqual(beforeContentMismatch.events);
      expect(casInventory()).toEqual(beforeContentMismatch.cas);
      expect(await session("session_primary")).toEqual(beforeContentMismatch.session);
      expect(await snapshot()).toEqual(beforeContentMismatch.snapshot);
      expect(commandReceiptCount()).toBe(beforeContentMismatch.receipts);
    }
    const mismatch = await fetch(url("/api/v1/sessions/open-artifact"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        sessionId: "session_primary",
        path: primaryPath,
        requestId: "open_primary",
        expectedContentSha256: "0".repeat(64),
        role: "primary",
        actor: { kind: "agent", id: "codex" },
      }),
    });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({
      protocol: "tweakloop.session-open-error/v1",
      code: "session.open-content-mismatch",
    });
    expect(await events()).toEqual(beforeContentMismatch.events);
    expect(casInventory()).toEqual(beforeContentMismatch.cas);
    expect(await session("session_primary")).toEqual(beforeContentMismatch.session);
    expect(await snapshot()).toEqual(beforeContentMismatch.snapshot);
    expect(commandReceiptCount()).toBe(beforeContentMismatch.receipts);

    const opened = await openArtifact("session_primary", primaryPath, "open_primary", "primary");
    expect(opened.status).toBe(200);
    const primary = (await opened.json()) as {
      artifactId: string;
      revisionId: string;
      sessionId: string;
    };
    expect(primary).toMatchObject({
      protocol: "tweakloop.session-open/v1",
      sessionId: "session_primary",
      artifactId: expect.stringMatching(/^artifact_/),
      revisionId: expect.stringMatching(/^rev_/),
    });
    const afterOpen = {
      events: await events(),
      cas: casInventory(),
      receipts: commandReceiptCount(),
    };
    const exactRetry = await openArtifact(
      "session_primary",
      primaryPath,
      "open_primary",
      "primary",
    );
    expect(exactRetry.status).toBe(200);
    expect(await exactRetry.json()).toEqual(primary);
    expect(await events()).toEqual(afterOpen.events);
    expect(casInventory()).toEqual(afterOpen.cas);
    expect(commandReceiptCount()).toBe(afterOpen.receipts);

    const beforeRejected = {
      events: await events(),
      cas: casInventory(),
      session: await session("session_primary"),
    };
    const conflictingPath = join(workspaceRoot, "conflicting.html");
    writeFileSync(conflictingPath, "<!doctype html><h1>Must not leak</h1>");
    const rejected = await openArtifact(
      "session_primary",
      conflictingPath,
      "open_conflicting_primary",
      "primary",
    );
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({
      status: "rejected",
      code: "session.primary-conflict",
    });
    expect(await events()).toEqual(beforeRejected.events);
    expect(casInventory()).toEqual(beforeRejected.cas);
    expect(await session("session_primary")).toEqual(beforeRejected.session);

    await startSession("session_source");
    const secondaryPath = join(workspaceRoot, "secondary.html");
    writeFileSync(secondaryPath, "<!doctype html><h1>Secondary</h1>");
    const secondaryResponse = await openArtifact("session_source", secondaryPath, "open_secondary");
    const secondary = (await secondaryResponse.json()) as {
      artifactId: string;
      revisionId: string;
    };
    const attached = await fetch(url("/api/v1/sessions/attach-artifact"), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        sessionId: "session_primary",
        artifactId: secondary.artifactId,
        revisionId: secondary.revisionId,
        role: "opened",
        requestId: "attach_secondary",
        actor: { kind: "agent", id: "codex" },
      }),
    });
    expect(attached.status).toBe(200);
    expect(await attached.json()).toMatchObject({
      status: "accepted",
      response: {
        sessionId: "session_primary",
        artifactId: secondary.artifactId,
        revisionId: secondary.revisionId,
      },
    });

    const beforeMint = await events();
    const minted = await (
      await fetch(url("/api/v1/sessions/url"), {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          sessionId: "session_primary",
          artifactId: primary.artifactId,
          agentId: "codex",
        }),
      })
    ).json();
    expect(minted).toMatchObject({
      protocol: "tweakloop.session-url/v1",
      sessionId: "session_primary",
      artifactId: primary.artifactId,
    });
    expect(await events()).toEqual(beforeMint);
    expect((await fetch(minted.url, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(minted.url, { redirect: "manual" })).status).toBe(403);
    expect(await events()).toEqual(beforeMint);
  });
});
