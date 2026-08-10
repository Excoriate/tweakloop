import type { Command } from "commander";
import {
  NATIVE_HOOK_BIND_REQUEST_PROTOCOL,
  NATIVE_HOOK_BINDING_PROTOCOL,
  NATIVE_HOOK_OBSERVATION_PROTOCOL,
  NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL,
  type NativeHookBindingResponse,
  type NativeHookClient,
  type NativeHookObservation,
} from "../protocol/native-hook-observation.js";
import { type DaemonConnection, discoverDaemon, getSession } from "./daemon-client.js";
import {
  loadNativeHookBindingCustody,
  type NativeHookBindingCustody,
  NativeHookCustodyError,
  prepareNativeHookBindingCustody,
  removeNativeHookBindingCustody,
} from "./native-hook-custody.js";
import { emitJson, fail } from "./output.js";
import {
  loadRuntimeCapability,
  type RuntimeCapability,
  RuntimeCapabilityError,
} from "./runtime-capability.js";

type NativeHookCommandDeps = Readonly<{
  rootPath: () => string;
  json: () => boolean;
}>;

type NativeHookOptions = Readonly<{
  client: string;
  profile: string;
  conversation: string;
}>;

export function registerNativeHookCommands(program: Command, deps: NativeHookCommandDeps): void {
  const nativeHook = program
    .command("native-hook")
    .description("bind and observe one already-running native agent conversation");

  nativeHook
    .command("bind")
    .description("bind one native conversation to an exact active Tweakloop session")
    .requiredOption("--session <id>", "exact active Tweakloop session")
    .requiredOption("--client <name>", "native client: codex, claude-code, or cursor")
    .requiredOption("--profile <id>", "stable non-secret native client profile identifier")
    .requiredOption("--conversation <id>", "opaque native conversation identifier")
    .action(async (opts: NativeHookOptions & { session: string }) => {
      requireJson(deps);
      const client = nativeClient(opts.client);
      const root = deps.rootPath();
      const connection = await requireDaemon(root);
      const session = (await getSession(connection, opts.session)).session;
      if (session.status !== "active") {
        fail(`session ${opts.session} is not active`, {
          code: "native-hook.session-inactive",
          details: { sessionId: opts.session, status: session.status },
        });
      }
      let runtimeCapability: RuntimeCapability;
      try {
        runtimeCapability = loadRuntimeCapability({
          workspaceId: connection.descriptor.workspaceId,
          workspaceRoot: root,
          daemonStartNonce: connection.descriptor.startNonce,
          sessionId: session.sessionId,
          agentId: session.agentId,
          processNonce: session.processNonce,
        });
      } catch (error) {
        nativeHookFailure(error);
      }
      const scope = {
        workspaceId: connection.descriptor.workspaceId,
        workspaceRoot: root,
        daemonStartNonce: connection.descriptor.startNonce,
        client,
        profileId: opts.profile,
        nativeConversationId: opts.conversation,
        sessionId: session.sessionId,
        agentId: session.agentId,
        processNonce: session.processNonce,
      } as const;
      let custody: NativeHookBindingCustody;
      try {
        custody = prepareNativeHookBindingCustody(scope);
      } catch (error) {
        nativeHookFailure(error);
      }
      try {
        const result = await postNativeHook<NativeHookBindingResponse>(
          connection,
          "/api/v1/native-hooks/bind",
          {
            protocol: NATIVE_HOOK_BIND_REQUEST_PROTOCOL,
            sessionId: session.sessionId,
            runtimeCapability: runtimeCapability.capability,
            client,
            profileId: opts.profile,
            nativeConversationId: opts.conversation,
            bindingSecret: custody.bindingSecret,
          },
        );
        requireBindingResponse(result, session.sessionId, client);
        emitJson(result);
      } catch (error) {
        if (!custody.unchanged && error instanceof NativeHookClientError && !error.outcomeUnknown) {
          removeNativeHookBindingCustody(scope);
        }
        nativeHookFailure(error);
      }
    });

  nativeHook
    .command("observe")
    .description("read whether the bound native conversation has exact undelivered inbound chat")
    .requiredOption("--client <name>", "native client: codex, claude-code, or cursor")
    .requiredOption("--profile <id>", "stable non-secret native client profile identifier")
    .requiredOption("--conversation <id>", "opaque native conversation identifier")
    .action(async (opts: NativeHookOptions) => {
      requireJson(deps);
      const client = nativeClient(opts.client);
      const root = deps.rootPath();
      const connection = await requireDaemon(root);
      let custody: NativeHookBindingCustody;
      try {
        custody = loadNativeHookBindingCustody({
          workspaceId: connection.descriptor.workspaceId,
          workspaceRoot: root,
          daemonStartNonce: connection.descriptor.startNonce,
          client,
          profileId: opts.profile,
          nativeConversationId: opts.conversation,
        });
      } catch (error) {
        nativeHookFailure(error);
      }
      try {
        const result = await postNativeHook<NativeHookObservation>(
          connection,
          "/api/v1/native-hooks/observe",
          {
            protocol: NATIVE_HOOK_OBSERVE_REQUEST_PROTOCOL,
            client,
            profileId: opts.profile,
            nativeConversationId: opts.conversation,
            bindingSecret: custody.bindingSecret,
          },
        );
        requireObservationResponse(result);
        emitJson(result);
      } catch (error) {
        nativeHookFailure(error);
      }
    });
}

class NativeHookClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number | null,
    readonly outcomeUnknown: boolean,
  ) {
    super(message);
    this.name = "NativeHookClientError";
  }
}

async function postNativeHook<T>(
  connection: DaemonConnection,
  path: string,
  body: unknown,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(new URL(path, connection.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new NativeHookClientError(
      "native-hook.transport-uncertain",
      "native hook response was not received; retry the identical command",
      null,
      true,
    );
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new NativeHookClientError(
      "native-hook.response-invalid",
      "daemon returned an invalid native hook response",
      response.status,
      false,
    );
  }
  if (!response.ok) {
    const record = isRecord(parsed) ? parsed : {};
    throw new NativeHookClientError(
      typeof record.code === "string" ? record.code : "native-hook.request-failed",
      String(record.error ?? response.statusText),
      response.status,
      false,
    );
  }
  return parsed as T;
}

function requireBindingResponse(
  value: unknown,
  sessionId: string,
  client: NativeHookClient,
): asserts value is NativeHookBindingResponse {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "client,kind,protocol,sessionId,unchanged" ||
    value.protocol !== NATIVE_HOOK_BINDING_PROTOCOL ||
    value.kind !== "bound" ||
    value.sessionId !== sessionId ||
    value.client !== client ||
    typeof value.unchanged !== "boolean"
  ) {
    throw new NativeHookClientError(
      "native-hook.response-invalid",
      "daemon returned an invalid native hook binding response",
      null,
      false,
    );
  }
}

function requireObservationResponse(value: unknown): asserts value is NativeHookObservation {
  if (!isRecord(value) || value.protocol !== NATIVE_HOOK_OBSERVATION_PROTOCOL) {
    return invalidObservation();
  }
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "none" && keys === "kind,protocol") return;
  if (
    value.kind === "continue" &&
    keys === "kind,messageId,protocol,sessionId" &&
    typeof value.sessionId === "string" &&
    typeof value.messageId === "string"
  ) {
    return;
  }
  return invalidObservation();
}

function invalidObservation(): never {
  throw new NativeHookClientError(
    "native-hook.response-invalid",
    "daemon returned an invalid native hook observation response",
    null,
    false,
  );
}

function nativeClient(value: string): NativeHookClient {
  if (value === "codex" || value === "claude-code" || value === "cursor") return value;
  fail("client must be codex, claude-code, or cursor", {
    code: "native-hook.client-invalid",
    exitCode: 2,
  });
}

async function requireDaemon(rootPath: string): Promise<DaemonConnection> {
  const connection = await discoverDaemon(rootPath);
  if (!connection) {
    fail("daemon is not running — start it with `tweak daemon start`", {
      code: "daemon.not-running",
    });
  }
  return connection;
}

function requireJson(deps: NativeHookCommandDeps): void {
  if (!deps.json()) {
    fail("native-hook commands require --json", {
      code: "native-hook.json-required",
      exitCode: 2,
    });
  }
}

function nativeHookFailure(error: unknown): never {
  if (
    error instanceof NativeHookCustodyError ||
    error instanceof RuntimeCapabilityError ||
    error instanceof NativeHookClientError
  ) {
    fail(error.message, {
      code: error.code,
      retryable: error instanceof NativeHookClientError ? error.outcomeUnknown : false,
      details: { mutated: false },
    });
  }
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
