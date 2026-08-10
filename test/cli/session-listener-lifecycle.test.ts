import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Database from "better-sqlite3";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";
import { stateDirFor } from "../../src/daemon/runtime.js";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = mkdtempSync(join(root, ".ai", "listener-lifecycle-"));
const cli = join(fixtureRoot, "dist", "cli", "index.js");

let stateRoot: string;
let workspaceRoot: string;
let daemon: DaemonHandle;
let commandNumber = 0;

type CliResult = Readonly<{ status: number; stdout: string; stderr: string }>;
type RunningCli = Readonly<{
  child: ChildProcessWithoutNullStreams;
  completed: Promise<CliResult>;
  output: () => Readonly<{ stdout: string; stderr: string }>;
}>;

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
});

beforeEach(async () => {
  stateRoot = mkdtempSync(join(tmpdir(), "tweakloop-listener-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-listener-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateRoot;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
  commandNumber = 0;
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateRoot, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe.sequential("claimed-work session listener lifecycle", () => {
  it("sustains Working and the claim lease without progress, then settles and disappears", async () => {
    const sessionId = "session_listener";
    const workId = "work_listener";
    const processNonce = "process_listener";
    await createClaimableWork({ sessionId, workId, processNonce });

    const claimed = await runCli([
      "--workspace",
      workspaceRoot,
      "--json",
      "work",
      "claim",
      "--session",
      sessionId,
      "--ttl",
      "60000",
    ]);
    expect(claimed.status).toBe(0);
    expect(claimed.stderr).toBe("");
    const claim = oneJson(claimed.stdout) as {
      status: string;
      workId: string;
      claimId: string;
      processNonce: string;
    };
    expect(claim).toMatchObject({
      status: "claimed",
      workId,
      processNonce,
    });

    const beforeRejected = await events();
    const wrongAgent = await runCli([
      "--workspace",
      workspaceRoot,
      "--json",
      "session",
      "listen",
      "--session",
      sessionId,
      "--agent",
      "intruder",
      "--presence",
      "working",
      "--until-work-settled",
      workId,
    ]);
    expect(wrongAgent.status).toBe(1);
    expect(wrongAgent.stderr).toBe("");
    expect(oneJson(wrongAgent.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "agent-context.agent-mismatch", retryable: false },
    });
    expect(await presence()).toEqual([]);
    expect(await events()).toEqual(beforeRejected);

    const listener = startCli([
      "--workspace",
      workspaceRoot,
      "--json",
      "session",
      "listen",
      "--session",
      sessionId,
      "--presence",
      "working",
      "--until-work-settled",
      workId,
    ]);
    try {
      await waitFor(async () =>
        (await presence()).some((item) => item.agentId === "codex" && item.state === "working"),
      );
      const firstLeaseExpiry = leaseExpiry(workId);
      expect(firstLeaseExpiry).toBeGreaterThan(Date.now() + 20_000);

      await delay(20_250);
      expect(await presence()).toEqual([{ agentId: "codex", state: "working" }]);
      expect(leaseExpiry(workId)).toBeGreaterThan(firstLeaseExpiry + 10_000);
      expect((await events()).filter((event) => event.eventType === "work.progressed")).toEqual([]);

      const completed = await runCli([
        "--workspace",
        workspaceRoot,
        "--json",
        "work",
        "complete",
        workId,
        "--claim",
        claim.claimId,
        "--summary",
        "Addressed the requested change",
      ]);
      expect(completed.status).toBe(0);
      expect(completed.stderr).toBe("");
      expect(oneJson(completed.stdout)).toMatchObject({ status: "addressed", workId });

      const listenerResult = await completeWithin(listener, 5_000);
      expect(listenerResult.status).toBe(0);
      expect(listenerResult.stderr).toContain(`session ${sessionId} listening as codex`);
      expect(jsonLines(listenerResult.stdout)).toContainEqual({
        protocol: "tweakloop.agent-session/v1",
        kind: "settled",
        workId,
      });
      await waitFor(async () => (await presence()).length === 0);

      const finalEvents = await events();
      expect(
        finalEvents.filter(
          (event) => event.eventType === "work.addressed" && event.streamId === workId,
        ),
      ).toHaveLength(1);
      expect(finalEvents.filter((event) => event.eventType === "work.progressed")).toEqual([]);
    } finally {
      if (listener.child.exitCode === null) {
        listener.child.kill("SIGTERM");
        await listener.completed;
      }
    }
  }, 35_000);

  it("closes Working when the exact runtime lease is lost", async () => {
    const sessionId = "session_listener_lease_loss";
    const workId = "work_listener_lease_loss";
    const processNonce = "process_listener_lease_loss";
    await createClaimableWork({ sessionId, workId, processNonce });

    const claimed = await runCli([
      "--workspace",
      workspaceRoot,
      "--json",
      "work",
      "claim",
      "--session",
      sessionId,
      "--ttl",
      "60000",
    ]);
    expect(claimed.status).toBe(0);

    const listener = startCli([
      "--workspace",
      workspaceRoot,
      "--json",
      "session",
      "listen",
      "--session",
      sessionId,
      "--presence",
      "working",
      "--until-work-settled",
      workId,
    ]);
    try {
      await waitFor(async () =>
        (await presence()).some((item) => item.agentId === "codex" && item.state === "working"),
      );
      const beforeLeaseLoss = await events();
      expireLease(workId);

      const result = await completeWithin(listener, 20_000);
      expect(result.status).toBe(1);
      expect(jsonLines(result.stdout)).toContainEqual({
        protocol: "tweakloop.agent-session/v1",
        kind: "error",
        code: "work.listener-claim-lost",
        message: "work listener lost exact claim authority",
        workId,
      });
      await waitFor(async () => (await presence()).length === 0);
      expect(await events()).toEqual(beforeLeaseLoss);
      expect((await currentWork(workId)).status).toBe("claimed");
    } finally {
      if (listener.child.exitCode === null) {
        listener.child.kill("SIGTERM");
        await listener.completed;
      }
    }
  }, 30_000);
});

async function createClaimableWork(input: {
  sessionId: string;
  workId: string;
  processNonce: string;
}): Promise<void> {
  const artifactId = "artifact_listener";
  const revisionId = "revision_listener";
  const documentPath = join(workspaceRoot, "plan.html");
  writeFileSync(documentPath, '<main data-tweak-id="plan.scope">Plan</main>\n');

  expect(
    await command("artifact.register", {
      artifactId,
      name: "plan.html",
      format: "html",
      sourcePath: documentPath,
    }),
  ).toMatchObject({ status: "accepted" });
  expect(
    await command("artifact.publish", {
      artifactId,
      revisionId,
      format: "html",
      entryPath: "plan.html",
      entryHash: "hash_listener",
      files: [{ path: "plan.html", hash: "hash_listener", mediaType: "text/html" }],
      producer: { kind: "agent", id: "codex" },
      sourcePath: documentPath,
    }),
  ).toMatchObject({ status: "accepted" });
  expect(
    await command("session.start", {
      sessionId: input.sessionId,
      artifactId,
      agentId: "codex",
      processNonce: input.processNonce,
      baseRevisionId: revisionId,
      title: "Listener lifecycle",
      goal: "Address one exact review intent",
    }),
  ).toMatchObject({ status: "accepted" });

  const browserHeaders = await authenticatedBrowserHeaders({
    artifactId,
    agentId: "codex",
    sessionId: input.sessionId,
  });
  commandNumber += 1;
  const submitted = await fetch(shellUrl("/api/v1/commands"), {
    method: "POST",
    headers: browserHeaders,
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command_${commandNumber}`,
      idempotencyKey: `key_${commandNumber}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "forged-browser-body" },
      type: "review.submit-batch",
      payload: {
        batchId: "batch_listener",
        workId: input.workId,
        artifactId,
        revisionId,
        assigneeAgentId: "codex",
        sessionId: input.sessionId,
        intents: [
          {
            intentId: "intent_listener",
            intentType: "comment",
            target: { semanticId: "plan.scope" },
            body: { text: "Tighten the scope" },
          },
        ],
      },
    }),
  });
  expect(submitted.status).toBe(200);
  expect(await submitted.json()).toMatchObject({ status: "accepted" });
}

async function command(type: string, payload: unknown): Promise<Record<string, unknown>> {
  commandNumber += 1;
  const response = await fetch(shellUrl("/api/v1/commands"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      protocol: "tweakloop.command/v1",
      commandId: `command_${commandNumber}`,
      idempotencyKey: `key_${commandNumber}`,
      workspaceId: daemon.workspaceId,
      actor: { kind: "agent", id: "codex" },
      type,
      payload,
    }),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

async function authenticatedBrowserHeaders(
  context: Readonly<{ artifactId: string; agentId: string; sessionId: string }>,
): Promise<Record<string, string>> {
  const mintedResponse = await fetch(shellUrl("/api/v1/bootstrap-tokens"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(context),
  });
  expect(mintedResponse.status).toBe(201);
  const minted = (await mintedResponse.json()) as { url: string };
  const bootstrap = await fetch(minted.url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return {
    cookie,
    origin: `http://127.0.0.1:${daemon.shellPort}`,
    "content-type": "application/json",
  };
}

function shellUrl(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}

async function presence(): Promise<readonly { agentId: string; state: string }[]> {
  const response = await fetch(shellUrl("/api/v1/presence"), {
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { agents: { agentId: string; state: string }[] }).agents;
}

async function events(): Promise<readonly Record<string, unknown>[]> {
  const response = await fetch(shellUrl("/api/v1/events?after=0"), {
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as readonly Record<string, unknown>[];
}

function leaseExpiry(workId: string): number {
  const db = new Database(join(stateDirFor(daemon.workspaceId), "events.sqlite"), {
    readonly: true,
  });
  try {
    const row = db
      .prepare("SELECT expires_at AS expiresAt FROM runtime_leases WHERE work_id = ?")
      .get(workId) as { expiresAt: number } | undefined;
    if (!row) throw new Error(`missing runtime lease for ${workId}`);
    return row.expiresAt;
  } finally {
    db.close();
  }
}

function expireLease(workId: string): void {
  const db = new Database(join(stateDirFor(daemon.workspaceId), "events.sqlite"));
  try {
    db.prepare("UPDATE runtime_leases SET expires_at = ? WHERE work_id = ?").run(
      Date.now() - 1,
      workId,
    );
  } finally {
    db.close();
  }
}

async function currentWork(workId: string): Promise<{ status: string }> {
  const response = await fetch(shellUrl("/api/v1/snapshot"), {
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  });
  expect(response.status).toBe(200);
  const snapshot = (await response.json()) as { work: { workId: string; status: string }[] };
  const work = snapshot.work.find((item) => item.workId === workId);
  if (!work) throw new Error(`missing work ${workId}`);
  return work;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("timed out waiting for listener lifecycle condition");
}

async function completeWithin(listener: RunningCli, timeoutMs: number): Promise<CliResult> {
  return Promise.race([
    listener.completed,
    delay(timeoutMs).then(() => {
      throw new Error(`listener did not settle: ${JSON.stringify(listener.output())}`);
    }),
  ]);
}

function startCli(args: readonly string[]): RunningCli {
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
  const completed = new Promise<CliResult>((resolveCompleted, reject) => {
    child.once("error", reject);
    child.once("close", (status) => resolveCompleted({ status: status ?? -1, stdout, stderr }));
  });
  return { child, completed, output: () => ({ stdout, stderr }) };
}

async function runCli(args: readonly string[]): Promise<CliResult> {
  return startCli(args).completed;
}

function oneJson(stdout: string): Record<string, unknown> {
  expect(stdout.trim()).not.toBe("");
  return JSON.parse(stdout) as Record<string, unknown>;
}

function jsonLines(stdout: string): Record<string, unknown>[] {
  return stdout
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
