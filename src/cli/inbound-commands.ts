import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { type Command, Option } from "commander";
import type { NextDelivery } from "../protocol/chat-delivery.js";
import { CLI_PROTOCOL } from "../protocol/versions.js";
import { resolveSessionAgentContext } from "./agent-context.js";
import { type DaemonConnection, discoverDaemon, getSession } from "./daemon-client.js";
import type { Invocation } from "./invocation.js";
import { currentInvocation, renderInvocation } from "./invocation.js";
import { emitJson, fail } from "./output.js";

type InboundCommandDeps = Readonly<{
  rootPath: () => string;
  json: () => boolean;
  canonicalAgentId: (agentId: string) => string;
  invocation: Invocation;
}>;

type SessionIdentity = Readonly<{
  sessionId: string;
  agentId: string;
  processNonce: string;
}>;

type InboundKind = "chat" | "work";

type NextOptions = Readonly<{
  session: string;
  agent?: string;
  process?: string;
  wait: boolean;
  timeout: string;
  ttl: string;
  request?: string;
  requestCapability?: string;
}>;

// The wait timeout bounds future eligibility, not the transport needed to
// return the final side-effecting reservation receipt. Aborting that request
// after 1 ms can commit an offer while losing its one-time capability.
const INBOUND_PROBE_TRANSPORT_BUDGET_MS = 100;

export function registerInboundCommands(
  program: Command,
  work: Command,
  chat: Command,
  deps: InboundCommandDeps,
): void {
  configureNextCommand(
    program
      .command("next")
      .description("return the next routed chat delivery or existing work claim"),
    ["next"],
    undefined,
    deps,
  );
  configureNextCommand(
    chat.command("next").description("return the next routed chat delivery"),
    ["chat", "next"],
    "chat",
    deps,
  );
  configureNextCommand(
    work.command("next").description("return the next existing work claim"),
    ["work", "next"],
    "work",
    deps,
  );

  chat
    .command("acknowledge <messageId>")
    .description("explicitly acknowledge one capability-bound chat delivery attempt")
    .requiredOption("--delivery <attemptId>", "delivery attempt id returned by `tweak next`")
    .requiredOption(
      "--capability <secret>",
      "one-time delivery capability returned by `tweak next`",
    )
    .requiredOption("--session <id>", "exact delivery session")
    .option("--agent <id>", "optional exact session-owner assertion")
    .option("--process <nonce>", "optional exact session-process assertion")
    .action(
      async (
        messageId: string,
        opts: {
          delivery: string;
          capability: string;
          session: string;
          agent?: string;
          process?: string;
        },
      ) => {
        requireJson(deps);
        const connection = await requireDaemon(deps.rootPath());
        const identity = await sessionIdentity(connection, opts, deps.canonicalAgentId);
        const result = await postJson<Readonly<Record<string, unknown>>>(
          connection,
          "/api/v1/chat/acknowledge",
          {
            ...identity,
            messageId,
            attemptId: opts.delivery,
            capability: opts.capability,
          },
        );
        emitJson({ protocol: CLI_PROTOCOL, ...result });
      },
    );
}

function configureNextCommand(
  command: Command,
  commandPath: readonly string[],
  kind: InboundKind | undefined,
  deps: InboundCommandDeps,
): void {
  command
    .requiredOption("--session <id>", "consume only from this exact active session")
    .option("--agent <id>", "optional exact session-owner assertion")
    .option("--process <nonce>", "optional exact session-process assertion")
    .option("--wait", "wait until one result is available", false)
    .option("--timeout <ms>", "wait deadline in milliseconds", "30000")
    .option("--ttl <ms>", "work claim lease lifetime", "30000")
    .addOption(new Option("--request <id>", "resume an indeterminate next request").hideHelp())
    .addOption(
      new Option("--request-capability <secret>", "resume exact request authority").hideHelp(),
    )
    .action(async (opts: NextOptions) => {
      requireJson(deps);
      const connection = await requireDaemon(deps.rootPath());
      const identity = await sessionIdentity(connection, opts, deps.canonicalAgentId);
      const timeoutMs = nonNegativeInteger(opts.timeout, "timeout");
      const workLeaseTtlMs = positiveInteger(opts.ttl, "ttl");
      if ((opts.request === undefined) !== (opts.requestCapability === undefined)) {
        fail("--request and --request-capability must be supplied together");
      }
      const requestId = opts.request ?? `next_${randomUUID()}`;
      const requestCapability = opts.requestCapability ?? randomBytes(32).toString("hex");
      const selected = await waitForNext(
        (signal) =>
          postNext(
            connection,
            {
              ...identity,
              workLeaseTtlMs,
              requestId,
              requestCapability,
              ...(kind ? { kind } : {}),
            },
            signal,
          ),
        opts.wait,
        timeoutMs,
      );
      const output =
        selected.kind === "chat"
          ? {
              ...selected,
              delivery: {
                ...selected.delivery,
                acknowledgeCommand: acknowledgeCommand(
                  deps.rootPath(),
                  selected.delivery,
                  deps.invocation,
                ),
              },
            }
          : selected.kind === "indeterminate"
            ? {
                ...selected,
                recoveryCommand: nextRecoveryCommand(
                  deps.rootPath(),
                  identity,
                  workLeaseTtlMs,
                  requestId,
                  requestCapability,
                  commandPath,
                  deps.invocation,
                ),
              }
            : selected;
      emitJson({ protocol: CLI_PROTOCOL, ...output });
      const exitCode = inboundNextExitCode(output);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

async function sessionIdentity(
  connection: DaemonConnection,
  opts: Readonly<{ session: string; agent?: string; process?: string }>,
  canonicalAgentId: (agentId: string) => string,
): Promise<SessionIdentity> {
  const context = resolveSessionAgentContext((await getSession(connection, opts.session)).session, {
    ...(opts.agent ? { agentId: canonicalAgentId(opts.agent) } : {}),
    ...(opts.process ? { processNonce: opts.process } : {}),
  });
  return {
    sessionId: opts.session,
    agentId: context.agentId,
    processNonce: context.processNonce,
  };
}

async function requireDaemon(rootPath: string): Promise<DaemonConnection> {
  const connection = await discoverDaemon(rootPath);
  if (!connection) {
    fail(
      `daemon is not running — start it with ${renderInvocation(currentInvocation(), ["daemon", "start"])}`,
    );
  }
  return connection;
}

function requireJson(deps: InboundCommandDeps): void {
  if (!deps.json()) fail("this one-result command requires --json");
}

async function postNext(
  connection: DaemonConnection,
  input: SessionIdentity &
    Readonly<{
      workLeaseTtlMs: number;
      requestId: string;
      requestCapability: string;
      kind?: InboundKind;
    }>,
  signal: AbortSignal,
): Promise<NextDelivery> {
  return postJson<NextDelivery>(connection, "/api/v1/inbound/next", input, signal);
}

async function postJson<T>(
  connection: DaemonConnection,
  path: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(new URL(path, connection.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${connection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = (await response.json()) as T | { error?: unknown; code?: unknown };
  if (!response.ok) {
    const error = data as { error?: unknown; code?: unknown };
    const prefix = typeof error.code === "string" ? `${error.code}: ` : "";
    throw new Error(`${prefix}${String(error.error ?? response.statusText)}`);
  }
  return data as T;
}

export async function waitForNext(
  probe: (signal: AbortSignal) => Promise<NextDelivery>,
  wait: boolean,
  timeoutMs: number,
): Promise<NextDelivery> {
  const deadline = Date.now() + timeoutMs;
  let sawUnknownTransportOutcome = false;
  // Every reservation attempt gets its own loopback transport budget. The
  // logical wait deadline controls future eligibility only; using it as the
  // first POST deadline makes `--timeout 0` abort after 1 ms even when the
  // daemon has already committed the offer and is returning its capability.
  let outcome = await probeBefore(probe, Date.now() + INBOUND_PROBE_TRANSPORT_BUDGET_MS);
  let selected = outcome.kind === "result" ? outcome.value : null;
  sawUnknownTransportOutcome ||= outcome.kind === "transport-timeout";
  if (selected && selected.kind !== "none") return selected;
  if (!wait) return selected ?? indeterminateNext();
  while (Date.now() < deadline) {
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    outcome = await probeBefore(probe, Date.now() + INBOUND_PROBE_TRANSPORT_BUDGET_MS);
    selected = outcome.kind === "result" ? outcome.value : null;
    sawUnknownTransportOutcome ||= outcome.kind === "transport-timeout";
    if (selected && selected.kind !== "none") return selected;
  }
  // One final, independently bounded transport probe preserves arrivals at the
  // deadline and gives a committed reservation enough time to return its
  // response-only capability. It remains finite for a server that never replies.
  outcome = await probeBefore(probe, Date.now() + INBOUND_PROBE_TRANSPORT_BUDGET_MS);
  selected = outcome.kind === "result" ? outcome.value : null;
  sawUnknownTransportOutcome ||= outcome.kind === "transport-timeout";
  if (selected && selected.kind !== "none") return selected;
  return sawUnknownTransportOutcome ? indeterminateNext() : { kind: "none", timedOut: true };
}

async function probeBefore(
  probe: (signal: AbortSignal) => Promise<NextDelivery>,
  absoluteDeadline: number,
): Promise<
  Readonly<{ kind: "result"; value: NextDelivery }> | Readonly<{ kind: "transport-timeout" }>
> {
  const controller = new AbortController();
  const remainingMs = Math.max(1, absoluteDeadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<Readonly<{ kind: "transport-timeout" }>>((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout({ kind: "transport-timeout" });
      controller.abort(new Error("inbound next probe deadline exceeded"));
    }, remainingMs);
  });
  try {
    return await Promise.race([
      probe(controller.signal).then((value) => ({ kind: "result" as const, value })),
      timedOut,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function inboundNextExitCode(output: NextDelivery): 0 | 3 {
  return output.kind === "indeterminate" ? 3 : 0;
}

function indeterminateNext(): NextDelivery {
  return {
    kind: "indeterminate",
    timedOut: true,
    reason: "transport-outcome-unknown",
    retryAfterMs: 0,
  };
}

function nextRecoveryCommand(
  rootPath: string,
  identity: SessionIdentity,
  workLeaseTtlMs: number,
  requestId: string,
  requestCapability: string,
  commandPath: readonly string[],
  invocation: Invocation,
): string {
  return renderInvocation(invocation, [
    "--workspace",
    rootPath,
    ...commandPath,
    "--session",
    identity.sessionId,
    "--agent",
    identity.agentId,
    "--process",
    identity.processNonce,
    "--wait",
    "--timeout",
    "30000",
    "--ttl",
    String(workLeaseTtlMs),
    "--request",
    requestId,
    "--request-capability",
    requestCapability,
    "--json",
  ]);
}

export function acknowledgeCommand(
  rootPath: string,
  delivery: Readonly<{
    message: Readonly<{ messageId: string }>;
    attemptId: string;
    capability: string;
    sessionId: string;
    agentId: string;
    processNonce: string;
  }>,
  invocation: Invocation = currentInvocation(),
): string {
  return renderInvocation(invocation, [
    "--workspace",
    rootPath,
    "chat",
    "acknowledge",
    delivery.message.messageId,
    "--delivery",
    delivery.attemptId,
    "--capability",
    delivery.capability,
    "--session",
    delivery.sessionId,
    "--agent",
    delivery.agentId,
    "--process",
    delivery.processNonce,
    "--json",
  ]);
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`--${name} must be a non-negative integer`);
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) fail(`--${name} must be a positive integer`);
  return parsed;
}
