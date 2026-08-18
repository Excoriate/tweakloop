import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workspaceIdFor } from "../../src/daemon/runtime.js";
import { mkdtempInRepo } from "../support/repo-temp-dir.js";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = mkdtempInRepo("c2-c3-cli-test-");
const cli = join(fixtureRoot, "dist", "cli", "index.js");
const workspace = join(fixtureRoot, "workspace");
const stateRoot = join(fixtureRoot, "state");
const documentPath = join(workspace, "plan.html");
const startNonce = "fake-daemon-start";
const cliToken = "fake-cli-token";

type CapturedRequest = Readonly<{ path: string; body: unknown }>;

const fake = {
  artifacts: [] as unknown[],
  revisions: [] as unknown[],
  work: [] as unknown[],
  chat: [] as unknown[],
  requests: [] as CapturedRequest[],
  urlSerial: 0,
  publishCount: 0,
  dropNextOpen: false,
  rejectNextSessionStart: false,
  rejectNextWorkTracking: false,
};

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

let shellPort = 0;

beforeAll(async () => {
  await build({
    entryPoints: [join(root, "src/cli/index.ts")],
    outfile: cli,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node24",
    packages: "external",
    logLevel: "silent",
  });
  mkdirSync(join(workspace, ".tweakloop"), { recursive: true });
  writeFileSync(
    join(workspace, ".tweakloop", "project.json"),
    '{"projectId":"project_test","schemaVersion":1}\n',
  );
  writeFileSync(documentPath, "<main>first</main>\n");
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake daemon has no port");
  shellPort = address.port;
  const workspaceId = workspaceIdFor(workspace);
  const runtimeDir = join(stateRoot, "tweakloop", "workspaces", workspaceId);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "runtime.json"),
    `${JSON.stringify({
      pid: process.pid,
      startNonce,
      shellPort,
      artifactPort: shellPort,
      protocolVersion: 1,
      workspaceId,
      cliToken,
    })}\n`,
  );
});

beforeEach(() => {
  fake.artifacts = [];
  fake.revisions = [];
  fake.work = [];
  fake.chat = [];
  fake.requests = [];
  fake.urlSerial = 0;
  fake.publishCount = 0;
  fake.dropNextOpen = false;
  fake.rejectNextSessionStart = false;
  fake.rejectNextWorkTracking = false;
  writeFileSync(documentPath, "<main>first</main>\n");
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe.sequential("C2/C3 current-source CLI integration", () => {
  it.each([
    ["unknown state", ["workng", "--ttl", "20000"]],
    ["negative TTL", ["working", "--ttl", "-1"]],
    ["zero TTL", ["working", "--ttl", "0"]],
    ["fractional TTL", ["working", "--ttl", "1.5"]],
    ["non-numeric TTL", ["working", "--ttl", "soon"]],
    ["excessive TTL", ["working", "--ttl", "300001"]],
  ])("rejects %s as one JSON error before contacting the daemon", async (_label, args) => {
    const requestCount = fake.requests.length;
    const result = await run(["--workspace", workspace, "--json", "presence", ...args]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "cli.failure", retryable: false },
    });
    expect(fake.requests).toHaveLength(requestCount);
  });

  it.each([
    ["unknown listener presence", ["--presence", "workng"]],
    ["working without exact work", ["--session", "session_1", "--presence", "working"]],
    ["work settlement without session", ["--until-work-settled", "work_1"]],
  ])("rejects %s before contacting the daemon", async (_label, options) => {
    const requestCount = fake.requests.length;
    const result = await run(["--workspace", workspace, "--json", "session", "listen", ...options]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "cli.failure", retryable: false },
    });
    expect(fake.requests).toHaveLength(requestCount);
  });

  it("makes the browser handoff purpose explicit in public help", async () => {
    const checks = [
      [["review", "submit-comments", "--help"], "human-authenticated review shell"],
      [["decision", "accept", "--help"], "human-authenticated review shell"],
      [["decision", "reopen", "--help"], "human-authenticated review shell"],
      [["chat", "send", "--help"], "human messages continue"],
      [["chat", "promote", "--help"], "otherwise continue the human action"],
    ] as const;
    for (const [args, expected] of checks) {
      const result = await run(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(expected);
    }
  }, 15_000);

  it("returns an empty JSON session query for an exact unregistered document path", async () => {
    const result = await run([
      "--workspace",
      workspace,
      "session",
      "list",
      "--document",
      join(workspace, "not-authored-yet.html"),
      "--json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toEqual({
      protocol: "tweakloop.sessions/v1",
      sessions: [],
    });
    expect(captured("/api/v1/sessions")).toHaveLength(0);
    expect(captured("/api/v1/commands")).toHaveLength(0);
  });

  it("emits bounded lint and diff summaries through the real command parser", async () => {
    writeFileSync(
      documentPath,
      '<main><section data-tweak-id="decision.auth" data-tweak-kind="decision">OAuth</section></main>\n',
    );

    for (const command of ["lint", "diff"] as const) {
      const result = await run([
        "--workspace",
        workspace,
        command,
        documentPath,
        "--summary",
        "--json",
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(8 * 1024);
      const value = oneJson(result.stdout);
      expect(value).toMatchObject({
        protocol: "tweakloop.cli/v1",
        summary: true,
        status: "pass",
        counts: expect.any(Object),
      });
      expect(result.stdout).not.toMatch(/contentFingerprint|"findings"\s*:\s*\[|"added"\s*:\s*\[/u);
    }
  });

  it("keeps the former whiteboard draft failure path machine-readable", async () => {
    const result = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "draft",
      "get",
      "artifact_missing",
      "--json",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "cli.failure",
        retryable: false,
      },
    });
  });

  it("rejects cosmetic existing-session options before any daemon request", async () => {
    for (const option of ["--title", "--goal"] as const) {
      fake.requests = [];
      const result = await run([
        "--workspace",
        workspace,
        "open",
        documentPath,
        "--session",
        "session_1",
        option,
        "cosmetic text",
        "--json",
      ]);
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(oneJson(result.stdout)).toMatchObject({
        protocol: "tweakloop.cli/v1",
        error: {
          code: "session.open-option-conflict",
          retryable: false,
        },
      });
      expect(fake.requests).toEqual([]);
    }
  });

  it("preserves new-session open while routing existing-session open atomically", async () => {
    const created = await run([
      "--workspace",
      workspace,
      "open",
      documentPath,
      "--no-browser",
      "--agent",
      "codex",
      "--json",
    ]);
    expect(created.status).toBe(0);
    expect(created.stderr).toBe("");
    expect(oneJson(created.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      artifactId: "artifact_1",
      revisionId: "rev_1",
    });
    expect(fake.requests.map((item) => item.path)).toEqual([
      "/api/v1/publish",
      "/api/v1/commands",
      "/api/v1/bootstrap-tokens",
    ]);

    fake.requests = [];
    fake.dropNextOpen = true;
    const args = [
      "--workspace",
      workspace,
      "open",
      documentPath,
      "--session",
      "session_1",
      "--role",
      "opened",
      "--agent",
      "codex",
      "--no-browser",
      "--json",
    ];
    const lost = await run(args);
    expect(lost.status).not.toBe(0);
    expect(lost.stderr).toBe("");
    expect(oneJson(lost.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: expect.any(String), message: expect.any(String) },
    });

    const retryStart = fake.requests.length;
    const retry = await run(args);
    expect(retry.status).toBe(0);
    const retryRequests = fake.requests.slice(retryStart);
    expect(
      retryRequests.filter((item) => item.path === "/api/v1/sessions/open-artifact"),
    ).toHaveLength(1);
    expect(
      retryRequests.filter((item) => ["/api/v1/publish", "/api/v1/commands"].includes(item.path)),
    ).toHaveLength(0);
    const opened = captured("/api/v1/sessions/open-artifact");
    expect(opened).toHaveLength(2);
    const firstOpenBody = capturedBodyAt(opened, 0);
    const retryOpenBody = capturedBodyAt(opened, 1);
    expect(firstOpenBody.requestId).toBe(retryOpenBody.requestId);
    expect(firstOpenBody.expectedContentSha256).toBe(sha256("<main>first</main>\n"));
    expect(retryOpenBody.expectedContentSha256).toBe(firstOpenBody.expectedContentSha256);
    expect(oneJson(retry.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      requestId: retryOpenBody.requestId,
      sessionId: "session_1",
      artifactId: "artifact_1",
    });
    expect(fake.requests.some((item) => item.path === "/api/v1/publish")).toBe(false);
    expect(fake.requests.some((item) => item.path === "/api/v1/commands")).toBe(false);

    writeFileSync(documentPath, "<main>changed</main>\n");
    const changed = await run(args);
    expect(changed.status).toBe(0);
    const changedRequests = captured("/api/v1/sessions/open-artifact");
    const changedBody = capturedBodyAt(changedRequests, changedRequests.length - 1);
    expect(changedBody.requestId).not.toBe(retryOpenBody.requestId);
    expect(changedBody.expectedContentSha256).toBe(sha256("<main>changed</main>\n"));
    expect(changedBody.expectedContentSha256).not.toBe(retryOpenBody.expectedContentSha256);
  }, 15_000);

  it("returns exact committed IDs and an executable non-blind recovery after post-publish failure", async () => {
    fake.rejectNextSessionStart = true;
    const args = [
      "--workspace",
      workspace,
      "open",
      documentPath,
      "--no-browser",
      "--agent",
      "codex",
      "--json",
    ];
    const failed = await run(args);

    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe("");
    const envelope = oneJson(failed.stdout) as {
      error: {
        details: {
          committed: { artifactId: string; revisionId: string; seq: number; unchanged: boolean };
        };
        nextAction: { kind: string; command: string; artifactId: string; revisionId: string };
      };
    };
    expect(envelope).toEqual({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "open.committed-partial",
        message:
          "artifact revision rev_1 committed, but review session setup did not complete: injected session start rejection",
        retryable: false,
        details: {
          outcome: "committed-partial",
          mutated: true,
          committed: {
            artifactId: "artifact_1",
            revisionId: "rev_1",
            seq: 1,
            unchanged: false,
          },
          cause: {
            code: "session.injected-rejection",
            message: "injected session start rejection",
            retryable: false,
          },
        },
        nextAction: {
          kind: "retry-open",
          command: expect.any(String),
          artifactId: "artifact_1",
          revisionId: "rev_1",
        },
      },
    });
    expect(failed.stdout).not.toMatch(/runtimeCapability|capabilityHash|cliToken|bootstrap/i);
    expect(captured("/api/v1/publish")).toHaveLength(1);
    expect(captured("/api/v1/commands")).toHaveLength(1);
    expect(captured("/api/v1/bootstrap-tokens")).toHaveLength(0);

    const recovered = await runShell(envelope.error.nextAction.command);
    expect(recovered.status).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(oneJson(recovered.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      artifactId: envelope.error.details.committed.artifactId,
      revisionId: envelope.error.details.committed.revisionId,
      unchanged: true,
    });
    expect(captured("/api/v1/publish")).toHaveLength(2);
    expect(captured("/api/v1/publish")[1]?.body).toEqual(captured("/api/v1/publish")[0]?.body);
    expect(captured("/api/v1/commands")).toHaveLength(2);
    expect(captured("/api/v1/bootstrap-tokens")).toHaveLength(1);
  }, 15_000);

  it("fails unregistered and ambiguous document attach before mutation", async () => {
    const missing = await run([
      "--workspace",
      workspace,
      "session",
      "attach",
      "session_1",
      join(workspace, "missing.html"),
      "--json",
    ]);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toBe("");
    expect(oneJson(missing.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "document.unregistered" },
    });
    expect(captured("/api/v1/sessions/attach-artifact")).toHaveLength(0);

    fake.requests = [];
    fake.artifacts = [
      { artifactId: "artifact_1", sourcePath: documentPath },
      { artifactId: "artifact_2", sourcePath: documentPath },
    ];
    const ambiguous = await run([
      "--workspace",
      workspace,
      "session",
      "attach",
      "session_1",
      documentPath,
      "--json",
    ]);
    expect(ambiguous.status).toBe(2);
    expect(ambiguous.stderr).toBe("");
    expect(oneJson(ambiguous.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "document.ambiguous", details: { matchCount: 2 } },
    });
    expect(captured("/api/v1/sessions/attach-artifact")).toHaveLength(0);
  });

  it("attaches the exact snapshot head with a stable duplicate request", async () => {
    fake.artifacts = [{ artifactId: "artifact_1", sourcePath: documentPath }];
    fake.revisions = [
      { artifactId: "artifact_1", revisionId: "rev_1", seq: 1 },
      { artifactId: "artifact_1", revisionId: "rev_2", seq: 2 },
    ];
    const args = [
      "--workspace",
      workspace,
      "session",
      "attach",
      "session_1",
      documentPath,
      "--role",
      "whiteboard",
      "--agent",
      "codex",
      "--json",
    ];
    const first = await run(args);
    const duplicate = await run(args);
    expect(first.status).toBe(0);
    expect(duplicate.status).toBe(0);
    const attached = captured("/api/v1/sessions/attach-artifact");
    expect(attached).toHaveLength(2);
    expect(attached[0]?.body).toMatchObject({
      sessionId: "session_1",
      artifactId: "artifact_1",
      revisionId: "rev_2",
      role: "whiteboard",
    });
    const firstAttachBody = capturedBodyAt(attached, 0);
    const duplicateAttachBody = capturedBodyAt(attached, 1);
    expect(firstAttachBody.requestId).toBe(duplicateAttachBody.requestId);
    expect(oneJson(duplicate.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      requestId: firstAttachBody.requestId,
      alreadyAttached: true,
    });
  });

  it("mints a fresh session URL without a durable command", async () => {
    fake.artifacts = [{ artifactId: "artifact_1", sourcePath: documentPath }];
    const args = [
      "--workspace",
      workspace,
      "session",
      "url",
      "session_1",
      "--document",
      documentPath,
      "--json",
    ];
    const first = await run(args);
    const second = await run(args);
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect((oneJson(first.stdout) as { url: string }).url).not.toBe(
      (oneJson(second.stdout) as { url: string }).url,
    );
    expect(captured("/api/v1/sessions/url")).toHaveLength(2);
    expect(captured("/api/v1/commands")).toHaveLength(0);
    expect(captured("/api/v1/bootstrap-tokens")).toHaveLength(0);

    fake.requests = [];
    const unregistered = await run([
      "--workspace",
      workspace,
      "session",
      "url",
      "session_1",
      "--document",
      join(workspace, "missing.html"),
      "--json",
    ]);
    expect(unregistered.status).not.toBe(0);
    expect(unregistered.stderr).toBe("");
    expect(oneJson(unregistered.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "document.unregistered" },
    });
    expect(captured("/api/v1/sessions/url")).toHaveLength(0);
  });

  it("hands human comments to the browser without mutating and preserves agent tracking", async () => {
    fake.artifacts = [{ artifactId: "artifact_1", sourcePath: documentPath }];
    fake.revisions = [{ artifactId: "artifact_1", revisionId: "rev_1", seq: 1 }];
    const commentsJson = JSON.stringify([
      { target: { semanticId: "decision.auth" }, body: { text: "Make this explicit" } },
    ]);
    const commentArgs = [
      "--workspace",
      workspace,
      "review",
      "submit-comments",
      documentPath,
      "--comments-json",
      commentsJson,
      "--idempotency-key",
      "comments_retry_1",
      "--agent",
      "codex",
      "--json",
    ];
    const submitted = await run(commentArgs);
    const retried = await run(commentArgs);
    expect(submitted.status).toBe(2);
    expect(retried.status).toBe(2);
    expect(submitted.stderr).toBe("");
    expect(retried.stderr).toBe("");
    const reviewCommands = captured("/api/v1/commands").filter(
      (item) => (item.body as { type?: string }).type === "review.submit-comments",
    );
    expect(reviewCommands).toHaveLength(0);
    expect(captured("/api/v1/sessions/url")).toHaveLength(0);
    expect(captured("/api/v1/bootstrap-tokens")).toHaveLength(0);
    expect(oneJson(retried.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "human.browser-required",
        retryable: false,
        details: {
          action: "review.submit-comments",
          artifactId: "artifact_1",
          mutated: false,
          reviewShellCommand: expect.stringContaining("sessionId"),
        },
        nextAction: { command: expect.stringContaining("'session' 'list'") },
      },
    });
    expect(retried.stdout).not.toContain("Make this explicit");
    expect(retried.stdout).not.toContain("comments_retry_1");

    const tracked = await run([
      "--workspace",
      workspace,
      "work",
      "create-from-intents",
      "intent_comment",
      "--reason",
      "Track this explicit comment",
      "--idempotency-key",
      "track_retry_1",
      "--agent",
      "codex",
      "--json",
    ]);
    expect(tracked.status).toBe(0);
    const workCommands = captured("/api/v1/commands").filter(
      (item) => (item.body as { type?: string }).type === "work.create-from-intents",
    );
    expect(workCommands).toHaveLength(1);
    expect(workCommands[0]?.body).toMatchObject({
      idempotencyKey: "track_retry_1",
      type: "work.create-from-intents",
      payload: { intentIds: ["intent_comment"] },
    });
    expect(oneJson(tracked.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      idempotencyKey: "track_retry_1",
      created: true,
    });
    expect(
      captured("/api/v1/commands").some(
        (item) => (item.body as { type?: string }).type === "review.submit-batch",
      ),
    ).toBe(false);

    const commandCount = captured("/api/v1/commands").length;
    const invalidComments = await run([
      "--workspace",
      workspace,
      "review",
      "submit-comments",
      documentPath,
      "--comments-json",
      "not-json",
      "--idempotency-key",
      "comments_invalid",
      "--json",
    ]);
    expect(invalidComments.status).toBe(2);
    expect(invalidComments.stderr).toBe("");
    expect(oneJson(invalidComments.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "review.comments-invalid" },
    });

    const duplicateIntents = await run([
      "--workspace",
      workspace,
      "work",
      "create-from-intents",
      "intent_comment",
      "intent_comment",
      "--reason",
      "Track duplicate",
      "--idempotency-key",
      "track_invalid",
      "--json",
    ]);
    expect(duplicateIntents.status).toBe(2);
    expect(duplicateIntents.stderr).toBe("");
    expect(oneJson(duplicateIntents.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "work.intent-duplicate" },
    });
    expect(captured("/api/v1/commands")).toHaveLength(commandCount);
  });

  it("hands human decisions and default-human chat to the browser with zero command mutation", async () => {
    fake.artifacts = [{ artifactId: "artifact_1", sourcePath: documentPath }];
    fake.revisions = [{ artifactId: "artifact_1", revisionId: "rev_1", seq: 1 }];
    fake.work = [
      {
        workId: "work_1",
        artifactId: "artifact_1",
        sessionId: "session_1",
        decision: "pending",
      },
    ];
    const secret = "never-echo-this-human-reason";
    const accept = await run([
      "--workspace",
      workspace,
      "decision",
      "accept",
      "work_1",
      "--reason",
      secret,
      "--json",
    ]);
    const reopen = await run([
      "--workspace",
      workspace,
      "decision",
      "reopen",
      "work_1",
      "--reason",
      secret,
      "--json",
    ]);
    const humanChat = await run([
      "--workspace",
      workspace,
      "chat",
      "send",
      secret,
      "--artifact",
      documentPath,
      "--attach",
      join(workspace, "not-uploaded-secret.txt"),
      "--json",
    ]);

    for (const [action, result] of [
      ["decision.accept", accept],
      ["decision.reopen", reopen],
      ["chat.send", humanChat],
    ] as const) {
      expect(result.status).toBe(2);
      expect(result.stderr).toBe("");
      expect(oneJson(result.stdout)).toMatchObject({
        protocol: "tweakloop.cli/v1",
        error: {
          code: "human.browser-required",
          retryable: false,
          details: { action, artifactId: "artifact_1", mutated: false },
        },
      });
      expect(`${result.stdout}${result.stderr}`).not.toContain(secret);
      expect(`${result.stdout}${result.stderr}`).not.toContain("not-uploaded-secret.txt");
      expect(Buffer.byteLength(result.stdout)).toBeLessThan(8 * 1024);
    }
    expect(captured("/api/v1/commands")).toHaveLength(0);
    expect(captured("/api/v1/sessions/url")).toHaveLength(0);
    expect(captured("/api/v1/bootstrap-tokens")).toHaveLength(0);
  });

  it("gates default-human chat promotion while explicit agent chat paths remain commands", async () => {
    fake.artifacts = [{ artifactId: "artifact_1", sourcePath: documentPath }];
    fake.revisions = [{ artifactId: "artifact_1", revisionId: "rev_1", seq: 1 }];
    fake.chat = [
      {
        messageId: "message_1",
        artifactId: "artifact_1",
        author: "human:browser",
        text: "browser-authored message",
        context: null,
        workId: null,
        intentId: null,
        sessionId: "session_1",
        recipientAgentId: "codex",
      },
    ];

    const humanPromote = await run([
      "--workspace",
      workspace,
      "chat",
      "promote",
      "message_1",
      "--json",
    ]);
    expect(humanPromote.status).toBe(2);
    expect(humanPromote.stderr).toBe("");
    expect(oneJson(humanPromote.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "human.browser-required",
        details: {
          action: "chat.promote",
          messageId: "message_1",
          sessionId: "session_1",
          mutated: false,
        },
      },
    });
    expect(captured("/api/v1/commands")).toHaveLength(0);
    expect(captured("/api/v1/sessions/url")).toHaveLength(0);
    expect(captured("/api/v1/bootstrap-tokens")).toHaveLength(0);

    const agentPromote = await run([
      "--workspace",
      workspace,
      "chat",
      "promote",
      "message_1",
      "--agent",
      "codex",
      "--json",
    ]);
    expect(agentPromote.status).toBe(0);
    const promoted = captured("/api/v1/commands");
    expect(promoted).toHaveLength(1);
    expect(promoted[0]?.body).toMatchObject({
      actor: { kind: "agent", id: "codex" },
      type: "review.submit-batch",
    });

    fake.requests = [];
    const agentChat = await run([
      "--workspace",
      workspace,
      "chat",
      "send",
      "agent update",
      "--artifact",
      documentPath,
      "--agent",
      "codex",
      "--json",
    ]);
    expect(agentChat.status).toBe(0);
    expect(captured("/api/v1/commands")).toHaveLength(1);
    expect(captured("/api/v1/commands")[0]?.body).toMatchObject({
      actor: { kind: "agent", id: "codex" },
      type: "chat.send",
    });
  });

  it("keeps accepted-work reopen rejection server-authored and machine-readable", async () => {
    fake.rejectNextWorkTracking = true;
    const result = await run([
      "--workspace",
      workspace,
      "work",
      "create-from-intents",
      "intent_accepted",
      "--reason",
      "Reopen accepted work",
      "--idempotency-key",
      "accepted_retry_1",
      "--agent",
      "codex",
      "--json",
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "work.accepted-browser-required", retryable: false },
    });
    expect(captured("/api/v1/commands")).toHaveLength(1);
    expect(captured("/api/v1/commands")[0]?.body).toMatchObject({
      actor: { kind: "agent", id: "codex" },
      type: "work.create-from-intents",
    });
  });
});

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${shellPort || 1}`);
  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { startNonce });
    return;
  }
  const body = await requestBody(request);
  fake.requests.push({ path: url.pathname, body });
  if (request.method === "GET" && url.pathname === "/api/v1/snapshot") {
    send(response, 200, snapshot());
    return;
  }
  if (request.method === "GET" && /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
    send(response, 200, {
      protocol: "tweakloop.session/v1",
      session: { sessionId: "session_1", agentId: "codex", processNonce: "process_1" },
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/publish") {
    fake.publishCount += 1;
    send(response, 200, {
      artifactId: "artifact_1",
      revisionId: "rev_1",
      seq: 1,
      unchanged: fake.publishCount > 1,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/sessions/open-artifact") {
    if (fake.dropNextOpen) {
      fake.dropNextOpen = false;
      request.socket.destroy();
      return;
    }
    const input = body as { sessionId: string };
    send(response, 200, {
      protocol: "tweakloop.session-open/v1",
      sessionId: input.sessionId,
      artifactId: "artifact_1",
      revisionId: "rev_1",
      seq: 1,
      created: false,
      unchanged: false,
      alreadyAttached: false,
      attachedRevisionId: "rev_1",
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/sessions/attach-artifact") {
    const input = body as { sessionId: string; artifactId: string; revisionId: string };
    send(response, 200, {
      status: "accepted",
      commandId: "cmd_server",
      firstSeq: 1,
      lastSeq: 1,
      response: { ...input, alreadyAttached: true },
    });
    return;
  }
  if (
    request.method === "POST" &&
    (url.pathname === "/api/v1/sessions/url" || url.pathname === "/api/v1/bootstrap-tokens")
  ) {
    fake.urlSerial += 1;
    const input = (body ?? {}) as { sessionId?: string; artifactId?: string; agentId?: string };
    send(response, 201, {
      protocol: "tweakloop.session-url/v1",
      url: `http://127.0.0.1:${shellPort}/bootstrap/token_${fake.urlSerial}`,
      artifactId: input.artifactId ?? null,
      agentId: input.agentId ?? null,
      sessionId: input.sessionId ?? null,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/commands") {
    const command = body as {
      commandId: string;
      type: string;
      payload: Record<string, unknown>;
    };
    if (command.type === "session.start" && fake.rejectNextSessionStart) {
      fake.rejectNextSessionStart = false;
      send(response, 409, {
        status: "rejected",
        code: "session.injected-rejection",
        message: "injected session start rejection",
      });
      return;
    }
    if (command.type === "work.create-from-intents" && fake.rejectNextWorkTracking) {
      fake.rejectNextWorkTracking = false;
      send(response, 409, {
        status: "rejected",
        code: "work.accepted-browser-required",
        message: "accepted work can be reopened only by a browser-authenticated human",
      });
      return;
    }
    const commandResponse =
      command.type === "review.submit-comments"
        ? {
            batchId: command.payload.batchId,
            intentIds: (command.payload.intents as { intentId: string }[]).map(
              (intent) => intent.intentId,
            ),
            tracked: false,
          }
        : command.type === "work.create-from-intents"
          ? { workId: command.payload.workId, created: true, reopened: false }
          : command.type === "session.start"
            ? { sessionId: command.payload.sessionId }
            : {};
    send(response, 200, {
      status: "accepted",
      commandId: command.commandId,
      firstSeq: 1,
      lastSeq: 1,
      response: commandResponse,
    });
    return;
  }
  send(response, 500, { error: `unexpected fake-daemon route: ${request.method} ${url.pathname}` });
}

function snapshot(): Record<string, unknown> {
  return {
    protocol: "tweakloop.snapshot/v1",
    workspace: {
      workspaceId: workspaceIdFor(workspace),
      projectId: "project_test",
      rootPath: workspace,
      protocolVersion: 1,
      artifactOrigin: `http://127.0.0.1:${shellPort}`,
    },
    artifacts: fake.artifacts,
    sessionArtifacts: [],
    revisions: fake.revisions,
    intents: [],
    work: fake.work,
    chat: fake.chat,
    timeline: [],
    lastSeq: 2,
  };
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed) return;
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

function captured(path: string): CapturedRequest[] {
  return fake.requests.filter((request) => request.path === path);
}

function capturedBodyAt(
  requests: readonly CapturedRequest[],
  index: number,
): Record<string, unknown> {
  const body = requests[index]?.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`captured request ${index} has no object body`);
  }
  return body as Record<string, unknown>;
}

async function run(
  args: readonly string[],
): Promise<Readonly<{ status: number; stdout: string; stderr: string }>> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      env: { ...process.env, TWEAKLOOP_STATE_DIR: stateRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => done({ status: status ?? -1, stdout, stderr }));
  });
}

async function runShell(
  command: string,
): Promise<Readonly<{ status: number; stdout: string; stderr: string }>> {
  return new Promise((done, reject) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: root,
      env: { ...process.env, TWEAKLOOP_STATE_DIR: stateRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => done({ status: status ?? -1, stdout, stderr }));
  });
}

function oneJson(stdout: string): Record<string, unknown> {
  expect(stdout.trim()).not.toBe("");
  return JSON.parse(stdout) as Record<string, unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
