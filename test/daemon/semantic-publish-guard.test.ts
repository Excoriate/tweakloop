import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import type { Snapshot } from "../../src/protocol/snapshot.js";

let stateDir: string;
let workspaceRoot: string;
let daemon: DaemonHandle;

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-semantic-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-semantic-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateDir;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("semantic publish guard HTTP boundary", () => {
  it("blocks normal and raw-command HTML bypasses atomically, then accepts exact human removal", async () => {
    const path = join(workspaceRoot, "plan.html");
    writeFileSync(path, html("decision.auth", "OAuth only"));
    const initial = await publish(path);
    expect(initial.response.status).toBe(200);
    const artifactId = String(initial.body.artifactId);
    const revision1 = String(initial.body.revisionId);

    writeFileSync(path, html("decision.authentication", "OAuth only"));
    const unprotected = await publish(path);
    expect(unprotected.response.status).toBe(200);
    const revision2 = String(unprotected.body.revisionId);
    const storedCandidate = (await snapshot()).revisions.find(
      (revision) => revision.revisionId === revision2,
    );
    expect(storedCandidate).toBeDefined();
    const directCandidatePayload = {
      artifactId,
      revisionId: "rev_direct_bypass",
      format: "html",
      entryPath: storedCandidate?.entryPath,
      entryHash: storedCandidate?.entryHash,
      files: [
        {
          path: storedCandidate?.entryPath,
          hash: storedCandidate?.entryHash,
          mediaType: "text/html",
        },
      ],
      producer: { kind: "agent", id: "codex" },
      sourcePath: path,
    };
    const originalIdempotent = await command(
      "artifact.publish",
      "cmd_idempotent_before_intent",
      "publish:idempotent-before-intent",
      directCandidatePayload,
    );
    expect(originalIdempotent.body).toMatchObject({ status: "accepted" });

    const restored = await request("/api/v1/restore", {
      revisionId: revision1,
      actor: { kind: "human", id: "reviewer" },
    });
    expect(restored.response.status).toBe(200);
    const reviewedRevision = String(restored.body.revisionId);
    expect(
      (
        await command("review.submit-batch", "cmd_comment", "review:comment", {
          batchId: "batch_comment",
          workId: "work_comment",
          artifactId,
          revisionId: reviewedRevision,
          intents: [
            {
              intentId: "intent_comment",
              intentType: "comment",
              target: { semanticId: "decision.auth" },
              body: { text: "keep this decision addressable" },
            },
          ],
        })
      ).body,
    ).toMatchObject({ status: "accepted" });

    const before = await snapshot();
    writeFileSync(path, html("decision.authentication", "OAuth only"));
    const blocked = await publish(path);
    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({
      code: "artifact.protected-anchor-loss",
      details: { semanticIds: ["decision.auth"], intentIds: ["intent_comment"] },
    });
    expect(await snapshot()).toEqual(before);

    const idempotentRetry = await command(
      "artifact.publish",
      "cmd_idempotent_retry",
      "publish:idempotent-before-intent",
      directCandidatePayload,
    );
    expect(idempotentRetry.body).toEqual(originalIdempotent.body);
    expect(await snapshot()).toEqual(before);

    const idempotentConflict = await command(
      "artifact.publish",
      "cmd_idempotent_conflict",
      "publish:idempotent-before-intent",
      { ...directCandidatePayload, revisionId: "rev_changed_under_same_key" },
    );
    expect(idempotentConflict.response.status).toBe(409);
    expect(idempotentConflict.body).toMatchObject({ code: "idempotency-key-conflict" });
    expect(await snapshot()).toEqual(before);

    const direct = await command("artifact.publish", "cmd_direct_bypass", "publish:direct", {
      ...directCandidatePayload,
      revisionId: "rev_direct_rejected",
    });
    expect(direct.response.status).toBe(409);
    expect(direct.body).toMatchObject({
      status: "rejected",
      code: "artifact.protected-anchor-loss",
    });
    expect(await snapshot()).toEqual(before);

    expect(
      (
        await command("review.submit-batch", "cmd_remove", "review:remove", {
          batchId: "batch_remove",
          workId: "work_remove",
          artifactId,
          revisionId: reviewedRevision,
          intents: [
            {
              intentId: "intent_remove",
              intentType: "remove",
              target: { semanticId: "decision.auth" },
              body: { reason: "replace the obsolete decision" },
            },
          ],
        })
      ).body,
    ).toMatchObject({ status: "accepted" });
    const authorized = await publish(path);
    expect(authorized.response.status).toBe(200);
    expect(authorized.body).toMatchObject({ artifactId, unchanged: false });
  });

  it("applies the same protected-loss rule to deterministic Markdown identities", async () => {
    const path = join(workspaceRoot, "plan.md");
    writeFileSync(path, "# Authentication {#decision.auth}\n\nOAuth only.\n");
    const initial = await publish(path);
    const artifactId = String(initial.body.artifactId);
    const revisionId = String(initial.body.revisionId);
    expect(initial.response.status).toBe(200);
    expect(
      (
        await command("review.submit-batch", "cmd_md_comment", "review:md-comment", {
          batchId: "batch_md",
          workId: "work_md",
          artifactId,
          revisionId,
          intents: [
            {
              intentId: "intent_md",
              intentType: "comment",
              target: { semanticId: "decision.auth" },
              body: { text: "retain the stable decision ID" },
            },
          ],
        })
      ).body,
    ).toMatchObject({ status: "accepted" });
    const before = await snapshot();
    writeFileSync(path, "# Authentication {#decision.authentication}\n\nOAuth only.\n");

    const blocked = await publish(path);

    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: "artifact.protected-anchor-loss" });
    expect(await snapshot()).toEqual(before);
  });

  it("rejects duplicate IDs before a new artifact or revision event exists", async () => {
    const path = join(workspaceRoot, "duplicates.html");
    writeFileSync(
      path,
      `<!doctype html><html><body>
        <p data-tweak-id="scope" data-tweak-kind="paragraph">One</p>
        <p data-tweak-id="scope" data-tweak-kind="paragraph">Two</p>
      </body></html>`,
    );
    const before = await snapshot();

    const blocked = await publish(path);

    expect(blocked.response.status).toBe(409);
    expect(blocked.body).toMatchObject({ code: "artifact.semantic-duplicate-id" });
    expect(await snapshot()).toEqual(before);
  });
});

function shellUrl(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

async function snapshot(): Promise<Snapshot> {
  return (await (
    await fetch(shellUrl("/api/v1/snapshot"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    })
  ).json()) as Snapshot;
}

async function publish(path: string) {
  return request("/api/v1/publish", { path, actor: { kind: "agent", id: "codex" } });
}

async function command(type: string, commandId: string, idempotencyKey: string, payload: unknown) {
  const headers = type === "review.submit-batch" ? await authenticatedBrowserHeaders() : undefined;
  return request(
    "/api/v1/commands",
    {
      protocol: "tweakloop.command/v1",
      commandId,
      idempotencyKey,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "codex" },
      type,
      payload,
    },
    headers,
  );
}

async function authenticatedBrowserHeaders(): Promise<Record<string, string>> {
  const minted = await request("/api/v1/bootstrap-tokens", {});
  expect(minted.response.status).toBe(201);
  const bootstrap = await fetch(String(minted.body.url), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  return {
    cookie,
    origin: `http://127.0.0.1:${daemon.shellPort}`,
    "content-type": "application/json",
  };
}

async function request(path: string, body: unknown, headers?: Record<string, string>) {
  const response = await fetch(shellUrl(path), {
    method: "POST",
    headers: headers ?? {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function html(id: string, text: string): string {
  return `<!doctype html><html><body><section data-tweak-id="${id}" data-tweak-kind="decision">${text}</section></body></html>`;
}
