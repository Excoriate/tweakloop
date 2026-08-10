import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { workspaceIdFor } from "../../src/daemon/runtime.js";
import { canonicalizeWhiteboardScene } from "../../src/whiteboard/scene.js";
import { emptySemanticSceneMap } from "../../src/whiteboard/semantic-representation.js";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = mkdtempSync(join(root, ".ai", "r42-cli-test-"));
const cli = join(fixtureRoot, "dist", "cli", "index.js");
const workspace = join(fixtureRoot, "workspace");
const stateRoot = join(fixtureRoot, "state");
const documentPath = join(workspace, "board.excalidraw");
const originalStartNonce = "r42-fake-daemon-start";
const cliToken = "r42-fake-cli-token";
const scene = canonicalizeWhiteboardScene(
  JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "tweakloop",
    elements: [],
    appState: { tweakloopSemanticScene: emptySemanticSceneMap() },
    files: {},
  }),
);

type CapturedRequest = Readonly<{
  path: string;
  body: unknown;
  authorization: string | undefined;
}>;

const fake = {
  requests: [] as CapturedRequest[],
  tokenSerial: 0,
  dropNextCommand: false,
  dropNextApply: false,
  rejectNextTokenAsUsed: false,
  draftMissing: false,
  objectFetches: 0,
  sessionId: "session_1",
  agentId: "codex",
  processNonce: "process_1",
};

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    send(response, 500, { error: error instanceof Error ? error.message : String(error) });
  });
});

let shellPort = 0;
let activeStartNonce = originalStartNonce;

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
    '{"projectId":"project_r42","schemaVersion":1}\n',
  );
  writeFileSync(documentPath, scene.bytes);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake daemon has no port");
  shellPort = address.port;
  writeRuntime();
});

beforeEach(() => {
  fake.requests = [];
  fake.tokenSerial = 0;
  fake.dropNextCommand = false;
  fake.dropNextApply = false;
  fake.rejectNextTokenAsUsed = false;
  fake.draftMissing = false;
  fake.objectFetches = 0;
  fake.sessionId = "session_1";
  fake.agentId = "codex";
  fake.processNonce = "process_1";
  activeStartNonce = originalStartNonce;
  rmSync(runtimeCapabilityDir(), { recursive: true, force: true });
  writeRuntime();
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe.sequential("R42 current-source CLI", () => {
  it("recovers an exact session start after response loss with hash-only authority", async () => {
    fake.dropNextCommand = true;
    const args = sessionStartArgs();
    const lost = await run(args);
    expect(lost.status).toBe(1);
    expect(oneJson(lost.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: expect.any(String) },
    });
    expect(lost.stderr).toBe("");

    const retry = await run(args);
    expect(retry.status).toBe(0);
    const starts = captured("/api/v1/commands").map((item) => item.body as CommandBody);
    expect(starts).toHaveLength(2);
    expect(starts[0]?.payload.runtimeCapabilityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(starts[1]?.payload.runtimeCapabilityHash).toBe(starts[0]?.payload.runtimeCapabilityHash);
    expect(starts[1]?.payload.sessionId).toBe(starts[0]?.payload.sessionId);
    expect(starts[1]?.payload.processNonce).toBe(starts[0]?.payload.processNonce);
    expect(JSON.stringify(starts)).not.toContain('runtimeCapability"');
  }, 15_000);

  it("binds a successor after daemon restart with a fresh hash for the same agent process", async () => {
    await establishCustody();
    const originalStart = captured("/api/v1/commands")[0]?.body as CommandBody | undefined;
    const hashA = originalStart?.payload.runtimeCapabilityHash;
    expect(hashA).toMatch(/^[a-f0-9]{64}$/);

    activeStartNonce = "r42-fake-daemon-restarted";
    writeRuntime();
    fake.requests = [];
    const resumed = await run([
      "--workspace",
      workspace,
      "session",
      "resume",
      "session_1",
      "--session-id",
      "session_2",
      "--process",
      "process_1",
      "--agent",
      "codex",
      "--json",
    ]);

    expect(resumed.status).toBe(0);
    expect(resumed.stderr).toBe("");
    expect(oneJson(resumed.stdout)).toMatchObject({
      session: { sessionId: "session_2" },
      processNonce: "process_1",
    });
    const resume = captured("/api/v1/commands")[0]?.body as CommandBody | undefined;
    expect(resume).toMatchObject({
      type: "session.resume",
      payload: {
        sessionId: "session_2",
        predecessorSessionId: "session_1",
        agentId: "codex",
        processNonce: "process_1",
        runtimeCapabilityHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(resume?.payload.runtimeCapabilityHash).not.toBe(hashA);
    expect(resumed.stdout).not.toContain(String(resume?.payload.runtimeCapabilityHash));
    expect(readdirSync(join(runtimeCapabilityDir(), "active"))).toHaveLength(1);
  });

  it("returns and executes an exact successor recovery after daemon generation change", async () => {
    await establishCustody();
    activeStartNonce = "r42-fake-daemon-restarted";
    writeRuntime();
    fake.requests = [];

    const failed = await run(sceneArgs("generation-recovery-key", "node-a"));
    expect(failed.status).toBe(1);
    expect(failed.stderr).toBe("");
    const envelope = oneJson(failed.stdout) as {
      error: {
        code: string;
        message: string;
        retryable: boolean;
        details: {
          mutated: boolean;
          sessionId: string;
          artifactId: string;
          agentId: string;
        };
        nextAction: {
          kind: string;
          command: string;
          predecessorSessionId: string;
        };
      };
    };
    expect(envelope).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "runtime-capability.daemon-generation-changed",
        message: "daemon generation changed; resume the session before mutating the semantic scene",
        retryable: false,
        details: {
          mutated: false,
          sessionId: "session_1",
          artifactId: "artifact_whiteboard",
          agentId: "codex",
        },
        nextAction: {
          kind: "resume-session",
          command: expect.stringContaining("'session' 'resume' 'session_1'"),
          predecessorSessionId: "session_1",
        },
      },
    });
    expect(Buffer.byteLength(failed.stdout)).toBeLessThan(8_192);
    expect(failed.stdout).not.toMatch(/runtimeCapability|capabilityHash|cliToken|bootstrap/i);
    expect(captured("/api/v1/automation/whiteboard-tokens")).toHaveLength(0);
    expect(captured("/api/v1/whiteboards/artifact_whiteboard/scene-commands")).toHaveLength(0);

    const resumed = await runShell(envelope.error.nextAction.command);
    expect(resumed.status).toBe(0);
    expect(resumed.stderr).toBe("");
    const successor = oneJson(resumed.stdout) as {
      session: { sessionId: string; agentId: string; processNonce: string };
    };
    expect(successor.session).toMatchObject({
      sessionId: expect.stringMatching(/^session_/),
      agentId: "codex",
      processNonce: "process_1",
    });
    expect(successor.session.sessionId).not.toBe("session_1");
    expect(readdirSync(join(runtimeCapabilityDir(), "active"))).toHaveLength(1);

    fake.requests = [];
    const retried = await run(
      sceneArgs("generation-recovery-key", "node-a", documentPath, successor.session.sessionId),
    );
    expect(retried.status).toBe(0);
    expect(retried.stderr).toBe("");
    expect(oneJson(retried.stdout)).toMatchObject({
      protocol: "tweakloop.whiteboard-scene-response/v1",
      status: "accepted",
      idempotencyKey: "generation-recovery-key",
    });
    expect(captured("/api/v1/automation/whiteboard-tokens")).toHaveLength(1);
    expect(captured("/api/v1/whiteboards/artifact_whiteboard/scene-commands")).toHaveLength(1);
  });

  it("dispatches every public semantic leaf without raw renderer or authority fields", async () => {
    await establishCustody();
    fake.requests = [];
    const commands: readonly (readonly string[])[] = [
      [
        "add-node",
        documentPath,
        "node-a",
        "--shape",
        "diamond",
        "--label",
        "A",
        "--x",
        "10",
        "--y",
        "20",
      ],
      [
        "add-edge",
        documentPath,
        "edge-a-b",
        "--from",
        "node-a",
        "--to",
        "node-b",
        "--label",
        "A to B",
      ],
      ["set-label", documentPath, "node-a", "--text", "Renamed"],
      ["group", documentPath, "group-main", "--members", "node-a", "node-b"],
      ["layout", documentPath, "--direction", "lr", "--gap", "80", "--scope", "node-a", "node-b"],
    ];
    for (const [index, command] of commands.entries()) {
      const result = await run([
        "--workspace",
        workspace,
        "whiteboard",
        "scene",
        ...command,
        "--session",
        "session_1",
        "--idempotency-key",
        `key-${index}`,
        "--json",
      ]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(oneJson(result.stdout)).toMatchObject({
        protocol: "tweakloop.whiteboard-scene-response/v1",
        status: "accepted",
        idempotencyKey: `key-${index}`,
      });
    }

    const inspect = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "scene",
      "inspect",
      documentPath,
      "--json",
    ]);
    expect(inspect.status).toBe(0);
    const inspected = oneJson(inspect.stdout);
    expect(inspected).toEqual({
      protocol: "tweakloop.whiteboard-scene-inspect/v1",
      artifactId: "artifact_whiteboard",
      scene: { nodes: [], edges: [], groups: [] },
    });
    const inspectKeys = recursiveKeys(inspected);
    for (const forbidden of [
      "draftId",
      "baseRevisionId",
      "draftVersion",
      "sceneHash",
      "semanticMap",
      "elementId",
      "elementSeed",
      "elementVersion",
      "elementVersionNonce",
      "labelElementId",
      "labelSeed",
      "labelVersion",
      "labelVersionNonce",
      "anchorId",
      "retiredElements",
      "groupId",
    ]) {
      expect(inspectKeys).not.toContain(forbidden);
    }
    expect(
      inspectKeys.filter((key) => /(seed|nonce|version|authority|path|url)/i.test(key)),
    ).toEqual([]);

    const humanInspect = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "scene",
      "inspect",
      documentPath,
    ]);
    expect(humanInspect.status).toBe(0);
    expect(humanInspect.stdout).toBe("");
    expect(humanInspect.stderr).toBe("0 semantic nodes, 0 semantic edges, 0 groups\n");
    expect(humanInspect.stderr).not.toMatch(/draft|version|hash/i);

    const publish = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "scene",
      "publish",
      documentPath,
      "--idempotency-key",
      "publish-key",
      "--agent",
      "codex",
      "--json",
    ]);
    expect(publish.status).toBe(0);
    expect(oneJson(publish.stdout)).toMatchObject({
      protocol: "tweakloop.whiteboard-scene-publish/v1",
      revisionId: expect.any(String),
    });

    const applies = captured("/api/v1/whiteboards/artifact_whiteboard/scene-commands");
    expect(applies.map((item) => (item.body as SceneRequest).operations[0]?.type)).toEqual([
      "node.upsert",
      "edge.upsert",
      "label.set",
      "group.set",
      "layout.apply",
    ]);
    for (const apply of applies) {
      expect(apply.authorization).toMatch(/^Bearer token-/);
      expect(apply.body).not.toHaveProperty("sessionId");
      expect(apply.body).not.toHaveProperty("actor");
      expect(apply.body).not.toHaveProperty("runtimeCapability");
      expect(JSON.stringify(apply.body)).not.toContain("excalidraw");
    }
  }, 15_000);

  it("preserves the stable missing-draft code for a cold-start inspect", async () => {
    fake.draftMissing = true;
    const inspect = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "scene",
      "inspect",
      documentPath,
      "--json",
    ]);

    expect(inspect.status).toBe(1);
    expect(inspect.stderr).toBe("");
    expect(oneJson(inspect.stdout)).toEqual({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "whiteboard.draft-missing",
        message: "whiteboard draft does not exist",
        retryable: false,
      },
    });
  });

  it("reads draft metadata without fetching or writing scene bytes unless output is requested", async () => {
    const output = join(fixtureRoot, "explicit-draft.excalidraw");
    rmSync(output, { force: true });

    const metadata = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "draft",
      "get",
      "artifact_whiteboard",
      "--json",
    ]);
    expect(metadata.status).toBe(0);
    expect(metadata.stderr).toBe("");
    expect(oneJson(metadata.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      artifactId: "artifact_whiteboard",
      draftId: "draft_1",
      baseRevisionId: "revision_1",
      draftVersion: 1,
      sceneHash: scene.hash,
      elementIndexHash: scene.elementIndexHash,
    });
    expect(fake.objectFetches).toBe(0);
    expect(existsSync(output)).toBe(false);

    const exported = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "draft",
      "get",
      "artifact_whiteboard",
      "--output",
      output,
      "--json",
    ]);
    expect(exported.status).toBe(0);
    expect(oneJson(exported.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      artifactId: "artifact_whiteboard",
      output,
      byteLength: scene.bytes.length,
    });
    expect(fake.objectFetches).toBe(1);
    expect(readFileSync(output)).toEqual(scene.bytes);
  });

  it("re-mints after response loss with the exact business request and no secret output", async () => {
    await establishCustody();
    fake.requests = [];
    fake.dropNextApply = true;
    const result = await run(sceneArgs("retry-key", "node-a"));

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const mints = captured("/api/v1/automation/whiteboard-tokens");
    const applies = captured("/api/v1/whiteboards/artifact_whiteboard/scene-commands");
    expect(mints).toHaveLength(2);
    expect(applies).toHaveLength(2);
    expect(applies[1]?.body).toEqual(applies[0]?.body);
    expect(applies[1]?.authorization).not.toBe(applies[0]?.authorization);
    const mintBody = mints[0]?.body;
    if (!mintBody || typeof mintBody !== "object" || !("runtimeCapability" in mintBody)) {
      throw new Error("captured mint body is missing runtime capability");
    }
    const capability = String(mintBody.runtimeCapability);
    expect(result.stdout).not.toContain(capability);
    expect(result.stderr).not.toContain(capability);
    expect(result.stdout).not.toContain("token-");
  });

  it("returns one bounded JSON failure for missing custody and parser rejection", async () => {
    const missing = await run(sceneArgs("missing-key", "node-a"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe("");
    expect(Buffer.byteLength(missing.stdout)).toBeLessThan(8_192);
    expect(oneJson(missing.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "runtime-capability.missing", retryable: false },
    });
    expect(captured("/api/v1/automation/whiteboard-tokens")).toHaveLength(0);

    const parser = await run([
      "--workspace",
      workspace,
      "whiteboard",
      "scene",
      "add-node",
      documentPath,
      "node-a",
      "--session",
      "session_1",
      "--json",
    ]);
    expect(parser.status).toBe(1);
    expect(parser.stderr).toBe("");
    expect(oneJson(parser.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: expect.any(String), retryable: false },
    });
  });

  it("never offers daemon-generation recovery for identity-mismatched or corrupt custody", async () => {
    await establishCustody();
    const custodyPath = activeCustodyPath();
    const original = JSON.parse(readFileSync(custodyPath, "utf8")) as Record<string, unknown>;

    writeFileSync(
      custodyPath,
      `${JSON.stringify({ ...original, processNonce: "forged-process" })}\n`,
      { mode: 0o600 },
    );
    fake.requests = [];
    const identityMismatch = await run(sceneArgs("identity-mismatch-key", "node-a"));
    expect(identityMismatch.status).toBe(1);
    expect(identityMismatch.stderr).toBe("");
    expect(Buffer.byteLength(identityMismatch.stdout)).toBeLessThan(8_192);
    const identityEnvelope = oneJson(identityMismatch.stdout) as {
      error: Record<string, unknown>;
    };
    expect(identityEnvelope).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "runtime-capability.scope-mismatch",
        details: { reason: "identity-mismatch", dimension: "processNonce" },
      },
    });
    expect(identityEnvelope.error).not.toHaveProperty("nextAction");
    expect(captured("/api/v1/automation/whiteboard-tokens")).toHaveLength(0);
    expect(captured("/api/v1/whiteboards/artifact_whiteboard/scene-commands")).toHaveLength(0);

    writeFileSync(
      custodyPath,
      `${JSON.stringify({ ...original, capabilityHash: "0".repeat(64) })}\n`,
      { mode: 0o600 },
    );
    fake.requests = [];
    const corrupt = await run(sceneArgs("corrupt-custody-key", "node-a"));
    expect(corrupt.status).toBe(1);
    expect(corrupt.stderr).toBe("");
    expect(Buffer.byteLength(corrupt.stdout)).toBeLessThan(8_192);
    const corruptEnvelope = oneJson(corrupt.stdout) as { error: Record<string, unknown> };
    expect(corruptEnvelope).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "runtime-capability.corrupt" },
    });
    expect(corruptEnvelope.error).not.toHaveProperty("nextAction");
    expect(captured("/api/v1/automation/whiteboard-tokens")).toHaveLength(0);
    expect(captured("/api/v1/whiteboards/artifact_whiteboard/scene-commands")).toHaveLength(0);
  });

  it("rejects an unregistered document before custody or token mint", async () => {
    await establishCustody();
    fake.requests = [];
    const result = await run(
      sceneArgs("unknown-key", "node-a", join(workspace, "unknown.excalidraw")),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "document.unregistered" },
    });
    expect(captured("/api/v1/automation/whiteboard-tokens")).toHaveLength(0);
  });

  it("publishes help for every semantic leaf and no internal repair operation", async () => {
    const result = await run(["whiteboard", "scene", "--help"]);
    expect(result.status).toBe(0);
    for (const leaf of [
      "add-node",
      "add-edge",
      "set-label",
      "group",
      "layout",
      "inspect",
      "publish",
    ]) {
      expect(result.stdout).toContain(leaf);
    }
    for (const internal of ["delete", "repair", "rename", "raw", "actor", "authority"]) {
      expect(result.stdout).not.toContain(internal);
    }
  });

  it("binds and observes one native conversation through private custody without exposing secrets", async () => {
    await establishCustody();
    fake.requests = [];
    const bindArgs = [
      "--workspace",
      workspace,
      "--json",
      "native-hook",
      "bind",
      "--session",
      "session_1",
      "--client",
      "codex",
      "--profile",
      "profile-r42",
      "--conversation",
      "conversation-r42",
    ];
    const first = await run(bindArgs);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(oneJson(first.stdout)).toEqual({
      protocol: "tweakloop.native-hook-binding/v1",
      kind: "bound",
      sessionId: "session_1",
      client: "codex",
      unchanged: false,
    });
    const firstRequest = captured("/api/v1/native-hooks/bind")[0]?.body as Record<string, unknown>;
    expect(firstRequest.runtimeCapability).toEqual(expect.any(String));
    expect(firstRequest.bindingSecret).toEqual(expect.any(String));
    expect(first.stdout).not.toContain(String(firstRequest.runtimeCapability));
    expect(first.stdout).not.toContain(String(firstRequest.bindingSecret));

    const second = await run(bindArgs);
    expect(second.status).toBe(0);
    const secondRequest = captured("/api/v1/native-hooks/bind")[1]?.body as Record<string, unknown>;
    expect(secondRequest.bindingSecret).toBe(firstRequest.bindingSecret);
    expect(oneJson(second.stdout)).toMatchObject({ kind: "bound", unchanged: true });

    const custodyEntries = readdirSync(nativeHookCustodyDir());
    expect(custodyEntries).toHaveLength(1);
    const custodyPath = join(nativeHookCustodyDir(), custodyEntries[0] as string);
    expect(statSync(custodyPath).mode & 0o777).toBe(0o600);

    const observed = await run([
      "--workspace",
      workspace,
      "--json",
      "native-hook",
      "observe",
      "--client",
      "codex",
      "--profile",
      "profile-r42",
      "--conversation",
      "conversation-r42",
    ]);
    expect(observed.status).toBe(0);
    expect(observed.stderr).toBe("");
    expect(oneJson(observed.stdout)).toEqual({
      protocol: "tweakloop.native-hook-observation/v1",
      kind: "none",
    });
    expect(observed.stdout).not.toContain(String(firstRequest.bindingSecret));
    const observeRequest = captured("/api/v1/native-hooks/observe")[0]?.body;
    expect(observeRequest).toBeDefined();
    expect((observeRequest as Record<string, unknown>).bindingSecret).toBe(
      firstRequest.bindingSecret,
    );

    const requestsBeforeNeighbor = fake.requests.length;
    const wrongConversation = await run([
      "--workspace",
      workspace,
      "--json",
      "native-hook",
      "observe",
      "--client",
      "codex",
      "--profile",
      "profile-r42",
      "--conversation",
      "conversation-neighbor",
    ]);
    expect(wrongConversation.status).toBe(1);
    expect(wrongConversation.stderr).toBe("");
    expect(oneJson(wrongConversation.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "native-hook.binding-missing", retryable: false },
    });
    expect(fake.requests).toHaveLength(requestsBeforeNeighbor);
  });
});

type CommandBody = Readonly<{ type: string; payload: Record<string, unknown> }>;
type SceneRequest = Readonly<{
  idempotencyKey: string;
  operations: readonly Readonly<{ type: string }>[];
}>;

async function establishCustody(): Promise<void> {
  const result = await run(sessionStartArgs());
  expect(result.status).toBe(0);
}

function sessionStartArgs(): string[] {
  return [
    "--workspace",
    workspace,
    "session",
    "start",
    documentPath,
    "--session-id",
    "session_1",
    "--process",
    "process_1",
    "--agent",
    "codex",
    "--json",
  ];
}

function sceneArgs(
  idempotencyKey: string,
  semanticKey: string,
  document = documentPath,
  sessionId = "session_1",
): string[] {
  return [
    "--workspace",
    workspace,
    "whiteboard",
    "scene",
    "add-node",
    document,
    semanticKey,
    "--session",
    sessionId,
    "--idempotency-key",
    idempotencyKey,
    "--json",
  ];
}

function runtimeCapabilityDir(): string {
  return join(
    stateRoot,
    "tweakloop",
    "workspaces",
    workspaceIdFor(workspace),
    "runtime-capabilities",
  );
}

function activeCustodyPath(): string {
  const activeDir = join(runtimeCapabilityDir(), "active");
  const entries = readdirSync(activeDir);
  expect(entries).toHaveLength(1);
  return join(activeDir, entries[0] as string);
}

function nativeHookCustodyDir(): string {
  return join(
    stateRoot,
    "tweakloop",
    "workspaces",
    workspaceIdFor(workspace),
    "native-hook-bindings",
  );
}

function writeRuntime(): void {
  const workspaceId = workspaceIdFor(workspace);
  const runtimeDir = join(stateRoot, "tweakloop", "workspaces", workspaceId);
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(runtimeDir, "runtime.json"),
    `${JSON.stringify({
      pid: process.pid,
      startNonce: activeStartNonce,
      shellPort,
      artifactPort: shellPort,
      protocolVersion: 1,
      workspaceId,
      cliToken,
    })}\n`,
  );
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${shellPort || 1}`);
  if (request.method === "GET" && url.pathname === "/health") {
    send(response, 200, { startNonce: activeStartNonce });
    return;
  }
  if (request.method === "GET" && url.pathname === `/objects/sha256/${scene.hash}`) {
    fake.objectFetches += 1;
    response.writeHead(200, { "content-type": "application/vnd.excalidraw+json" });
    response.end(scene.bytes);
    return;
  }
  const body = await requestBody(request);
  fake.requests.push({
    path: url.pathname,
    body,
    authorization:
      typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
  });
  if (request.method === "GET" && url.pathname === "/api/v1/snapshot") {
    send(response, 200, snapshot());
    return;
  }
  if (request.method === "GET" && /^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
    send(response, 200, { protocol: "tweakloop.session/v1", session: sessionRecord() });
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname === "/api/v1/whiteboards/artifact_whiteboard/draft"
  ) {
    if (fake.draftMissing) {
      send(response, 404, {
        protocol: "tweakloop.whiteboard-error/v1",
        code: "whiteboard.draft-missing",
        error: "whiteboard draft does not exist",
      });
      return;
    }
    send(response, 200, {
      protocol: "tweakloop.whiteboard-draft/v1",
      status: "accepted",
      artifactId: "artifact_whiteboard",
      draftId: "draft_1",
      baseRevisionId: "revision_1",
      draftVersion: 1,
      sceneHash: scene.hash,
      elementIndexHash: scene.elementIndexHash,
      sceneUrl: "/objects",
      publishedRevisionId: null,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/commands") {
    const command = body as {
      commandId: string;
      type: string;
      payload: Record<string, unknown>;
    };
    if (command.type === "session.start" || command.type === "session.resume") {
      fake.sessionId = String(command.payload.sessionId);
      fake.agentId = String(command.payload.agentId);
      fake.processNonce = String(command.payload.processNonce);
    }
    if (fake.dropNextCommand) {
      fake.dropNextCommand = false;
      request.socket.destroy();
      return;
    }
    send(response, 200, {
      status: "accepted",
      commandId: command.commandId,
      firstSeq: 1,
      lastSeq: 1,
      response:
        command.type === "whiteboard.publish-draft"
          ? { revisionId: command.payload.revisionId, seq: 2, unchanged: false }
          : { sessionId: fake.sessionId },
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/bootstrap-tokens") {
    send(response, 201, {
      url: `http://127.0.0.1:${shellPort}/bootstrap/one-use`,
      artifactId: "artifact_whiteboard",
      agentId: fake.agentId,
      sessionId: fake.sessionId,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/native-hooks/bind") {
    const requestBody = body as Record<string, unknown>;
    send(response, 200, {
      protocol: "tweakloop.native-hook-binding/v1",
      kind: "bound",
      sessionId: requestBody.sessionId,
      client: requestBody.client,
      unchanged: captured("/api/v1/native-hooks/bind").length > 1,
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/native-hooks/observe") {
    send(response, 200, {
      protocol: "tweakloop.native-hook-observation/v1",
      kind: "none",
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/v1/automation/whiteboard-tokens") {
    fake.tokenSerial += 1;
    send(response, 201, {
      protocol: "tweakloop.whiteboard-automation-token/v1",
      automationToken: `token-${fake.tokenSerial}-${"x".repeat(40)}`,
      expiresAt: Date.now() + 30_000,
      operationId: "whiteboard.semantic-scene.apply.v1",
      routeSetVersion: 1,
    });
    return;
  }
  if (
    request.method === "POST" &&
    url.pathname === "/api/v1/whiteboards/artifact_whiteboard/scene-commands"
  ) {
    if (fake.dropNextApply) {
      fake.dropNextApply = false;
      request.socket.destroy();
      return;
    }
    if (fake.rejectNextTokenAsUsed) {
      fake.rejectNextTokenAsUsed = false;
      send(response, 403, {
        protocol: "tweakloop.whiteboard-error/v1",
        code: "whiteboard.automation-token-used",
        error: "automation token has already been used",
      });
      return;
    }
    const semantic = body as SceneRequest;
    send(response, 200, {
      protocol: "tweakloop.whiteboard-scene-response/v1",
      status: "accepted",
      artifactId: "artifact_whiteboard",
      idempotencyKey: semantic.idempotencyKey,
      normalizationVersion: 1,
      baseRevisionId: "revision_1",
      draftVersion: 2,
      sceneHash: "a".repeat(64),
      elementIndexHash: "b".repeat(64),
      expectedHeadRevisionId: "revision_1",
      unchanged: false,
      changedTargets: [],
      changedBounds: null,
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
      projectId: "project_r42",
      rootPath: workspace,
      protocolVersion: 1,
      artifactOrigin: `http://127.0.0.1:${shellPort}`,
    },
    artifacts: [
      {
        artifactId: "artifact_whiteboard",
        name: "board.excalidraw",
        format: "whiteboard",
        sourcePath: documentPath,
      },
    ],
    sessionArtifacts: [],
    revisions: [{ artifactId: "artifact_whiteboard", revisionId: "revision_1", seq: 1 }],
    intents: [],
    work: [],
    chat: [],
    timeline: [],
    lastSeq: 1,
  };
}

function sessionRecord(): Record<string, unknown> {
  return {
    sessionId: fake.sessionId,
    artifactId: "artifact_whiteboard",
    agentId: fake.agentId,
    processNonce: fake.processNonce,
    status: "active",
    artifacts: [
      {
        artifactId: "artifact_whiteboard",
        format: "whiteboard",
        currentRevisionId: "revision_1",
      },
    ],
  };
}

function recursiveKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(recursiveKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...recursiveKeys(child)]);
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
