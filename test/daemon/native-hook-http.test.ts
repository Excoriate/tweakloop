import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type DaemonHandle, startDaemon } from "../../src/daemon/index.js";

let stateDir: string;
let workspaceRoot: string;
let daemon: DaemonHandle;

const sessionId = "session_native_hook_http";
const agentId = "codex";
const processNonce = "process_native_hook_http";
const runtimeCapability = "runtime-capability-native-hook-http";
const bindingSecret = "binding-secret-native-hook-http-32-bytes";

beforeEach(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-native-hook-http-state-"));
  workspaceRoot = mkdtempSync(join(tmpdir(), "tweakloop-native-hook-http-ws-"));
  process.env.TWEAKLOOP_STATE_DIR = stateDir;
  daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });

  const started = await cliPost("/api/v1/commands", {
    protocol: "tweakloop.command/v1",
    commandId: "command_native_hook_session_start",
    idempotencyKey: "native-hook:session-start",
    workspaceId: daemon.workspaceId,
    actor: { kind: "agent", id: agentId },
    type: "session.start",
    payload: {
      sessionId,
      artifactId: null,
      agentId,
      processNonce,
      runtimeCapabilityHash: createHash("sha256").update(runtimeCapability).digest("hex"),
      baseRevisionId: null,
      title: "Native hook observation",
      goal: "Observe one exact inbound message without mutation",
    },
  });
  expect(started.response.status).toBe(200);
});

afterEach(() => {
  daemon.close();
  delete process.env.TWEAKLOOP_STATE_DIR;
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("native hook HTTP boundary", () => {
  it("binds exact runtime authority and observes inbound chat without delivery or event mutation", async () => {
    const bound = await cliPost("/api/v1/native-hooks/bind", {
      protocol: "tweakloop.native-hook-bind/v1",
      sessionId,
      runtimeCapability,
      client: "codex",
      profileId: "profile-native-hook-http",
      nativeConversationId: "conversation-native-hook-http",
      bindingSecret,
    });
    expect(bound.response.status).toBe(200);
    expect(bound.body).toEqual({
      protocol: "tweakloop.native-hook-binding/v1",
      kind: "bound",
      sessionId,
      client: "codex",
      unchanged: false,
    });
    expect(JSON.stringify(bound.body)).not.toContain(runtimeCapability);
    expect(JSON.stringify(bound.body)).not.toContain(bindingSecret);

    const rebound = await cliPost("/api/v1/native-hooks/bind", {
      protocol: "tweakloop.native-hook-bind/v1",
      sessionId,
      runtimeCapability,
      client: "codex",
      profileId: "profile-native-hook-http",
      nativeConversationId: "conversation-native-hook-http",
      bindingSecret,
    });
    expect(rebound.body).toMatchObject({ kind: "bound", unchanged: true });

    const browserHeaders = await authenticatedBrowserHeaders();
    const sent = await fetch(shellUrl("/api/v1/commands"), {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        protocol: "tweakloop.command/v1",
        commandId: "command_native_hook_human_chat",
        idempotencyKey: "native-hook:human-chat",
        workspaceId: daemon.workspaceId,
        actor: { kind: "agent", id: "forged-browser-body" },
        type: "chat.send",
        payload: {
          messageId: "message_native_hook_http",
          sessionId,
          recipientAgentId: agentId,
          text: "Please continue this exact native conversation.",
          context: {},
        },
      }),
    });
    expect(sent.status).toBe(200);

    const before = await durableState();
    const request = {
      protocol: "tweakloop.native-hook-observe/v1",
      client: "codex",
      profileId: "profile-native-hook-http",
      nativeConversationId: "conversation-native-hook-http",
      bindingSecret,
    };
    const first = await cliPost("/api/v1/native-hooks/observe", request);
    const second = await cliPost("/api/v1/native-hooks/observe", request);
    expect(first.body).toEqual({
      protocol: "tweakloop.native-hook-observation/v1",
      kind: "continue",
      sessionId,
      messageId: "message_native_hook_http",
    });
    expect(second.body).toEqual(first.body);
    expect(await durableState()).toEqual(before);
  });

  it("keeps the routes CLI-only and rejects wrong custody before returning any observation", async () => {
    const bindBody = {
      protocol: "tweakloop.native-hook-bind/v1",
      sessionId,
      runtimeCapability,
      client: "cursor",
      profileId: "profile-neighbor",
      nativeConversationId: "conversation-neighbor",
      bindingSecret,
    };
    const unauthenticated = await fetch(shellUrl("/api/v1/native-hooks/bind"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bindBody),
    });
    expect(unauthenticated.status).toBe(401);

    const bound = await cliPost("/api/v1/native-hooks/bind", bindBody);
    expect(bound.response.status).toBe(200);
    const before = await durableState();
    const wrong = await cliPost("/api/v1/native-hooks/observe", {
      protocol: "tweakloop.native-hook-observe/v1",
      client: "cursor",
      profileId: "profile-neighbor",
      nativeConversationId: "conversation-neighbor",
      bindingSecret: `${bindingSecret}-wrong`,
    });
    expect(wrong.response.status).toBe(403);
    expect(wrong.body).toEqual({
      protocol: "tweakloop.native-hook-error/v1",
      error: "native hook binding is invalid",
      code: "native-hook.binding-invalid",
    });
    expect(JSON.stringify(wrong.body)).not.toContain(bindingSecret);
    expect(await durableState()).toEqual(before);
  });
});

async function authenticatedBrowserHeaders(): Promise<Record<string, string>> {
  const minted = await cliPost("/api/v1/bootstrap-tokens", {});
  expect(minted.response.status).toBe(201);
  const bootstrap = await fetch(String(minted.body.url), { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).not.toBe("");
  return {
    cookie,
    origin: `http://127.0.0.1:${daemon.shellPort}`,
    "content-type": "application/json",
  };
}

async function durableState(): Promise<unknown> {
  const [events, snapshot] = await Promise.all([
    fetch(shellUrl("/api/v1/events"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }).then((response) => response.json()),
    fetch(shellUrl("/api/v1/snapshot"), {
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }).then((response) => response.json()),
  ]);
  return { events, snapshot };
}

async function cliPost(
  path: string,
  body: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(shellUrl(path), {
    method: "POST",
    headers: {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return { response, body: (await response.json()) as Record<string, unknown> };
}

function shellUrl(path: string): string {
  return `http://127.0.0.1:${daemon.shellPort}${path}`;
}
