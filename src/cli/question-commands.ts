import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Command } from "commander";
import type { ChatChoiceOption } from "../protocol/chat.js";
import type { CommandEnvelope } from "../protocol/envelopes.js";
import type { SnapshotChatMessage } from "../protocol/snapshot.js";
import { CLI_PROTOCOL, COMMAND_PROTOCOL } from "../protocol/versions.js";
import { resolveSessionAgentContext } from "./agent-context.js";
import {
  type DaemonConnection,
  discoverDaemon,
  getQuestion,
  getSession,
  postCommand,
} from "./daemon-client.js";
import { emitJson, fail } from "./output.js";

type QuestionCommandDeps = Readonly<{
  rootPath: () => string;
  json: () => boolean;
}>;

export function registerQuestionCommands(program: Command, deps: QuestionCommandDeps): void {
  const question = program
    .command("question")
    .description("ask and await a typed choice question in chat");

  question
    .command("ask <prompt>")
    .description("ask one bounded choice question as the exact session agent")
    .requiredOption("--session <id>", "exact active session")
    .requiredOption("--option <key=label...>", "2-8 unique choice options")
    .action(async (prompt: string, opts: { session: string; option: string[] }) => {
      requireJson(deps);
      const connection = await requireDaemon(deps.rootPath());
      const session = (await getSession(connection, opts.session)).session;
      const identity = resolveSessionAgentContext(session);
      const options = parseQuestionOptions(opts.option);
      const messageId = `message_${randomUUID()}`;
      const result = await postCommand(
        connection,
        envelope(connection, identity.agentId, messageId, {
          messageId,
          text: prompt,
          content: { type: "choice-question", prompt, options },
          artifactId: session.primaryArtifactId,
          sessionId: opts.session,
          recipientAgentId: null,
          threadId: opts.session,
        }),
      );
      if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
      emitJson(questionAskOutput(messageId));
    });

  question
    .command("wait <questionMessageId>")
    .description("block until one final answer or timeout, then emit exactly one result")
    .option("--timeout <ms>", "bounded wait duration", "60000")
    .action(async (questionMessageId: string, opts: { timeout: string }) => {
      requireJson(deps);
      const connection = await requireDaemon(deps.rootPath());
      const timeoutMs = nonNegativeInteger(opts.timeout, "timeout");
      const answer = await waitForQuestion(
        (signal) => getQuestion(connection, questionMessageId, signal),
        timeoutMs,
      );
      if (answer === null) {
        emitJson({
          protocol: CLI_PROTOCOL,
          questionMessageId,
          status: "pending",
          timedOut: true,
        });
        process.exitCode = 2;
        return;
      }
      emitJson({
        protocol: CLI_PROTOCOL,
        questionMessageId,
        status: "answered",
        answerMessageId: answer.answerMessageId,
        optionKey: answer.optionKey,
        optionLabel: answer.optionLabel,
      });
    });
}

export function questionAskOutput(messageId: string): Readonly<{
  protocol: typeof CLI_PROTOCOL;
  messageId: string;
}> {
  return { protocol: CLI_PROTOCOL, messageId };
}

function envelope(
  connection: DaemonConnection,
  agentId: string,
  messageId: string,
  payload: Readonly<Record<string, unknown>>,
): CommandEnvelope {
  return {
    protocol: COMMAND_PROTOCOL,
    commandId: `cmd_${randomUUID()}`,
    idempotencyKey: `chat.question:${messageId}`,
    workspaceId: connection.descriptor.workspaceId,
    actor: { kind: "agent", id: agentId },
    type: "chat.send",
    payload,
  };
}

async function requireDaemon(rootPath: string): Promise<DaemonConnection> {
  const connection = await discoverDaemon(rootPath);
  if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
  return connection;
}

function requireJson(deps: QuestionCommandDeps): void {
  if (!deps.json()) fail("this one-result command requires --json");
}

export function parseQuestionOptions(values: readonly string[]): ChatChoiceOption[] {
  const options = values.map((value) => {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`invalid --option ${JSON.stringify(value)}; expected non-empty key=label`);
    }
    return {
      key: value.slice(0, separator).trim(),
      label: value.slice(separator + 1).trim(),
    };
  });
  if (options.length < 2 || options.length > 8) {
    throw new Error("--option requires between 2 and 8 values");
  }
  if (options.some((option) => option.key.length === 0 || option.label.length === 0)) {
    throw new Error("every --option requires a non-empty key and label");
  }
  if (new Set(options.map((option) => option.key)).size !== options.length) {
    throw new Error("--option keys must be unique");
  }
  if (new Set(options.map((option) => option.label)).size !== options.length) {
    throw new Error("--option labels must be unique");
  }
  return options;
}

type FinalAnswer = Readonly<{
  answerMessageId: string;
  optionKey: string;
  optionLabel: string;
}>;

// `--timeout` bounds how long the agent waits for a future answer. The final
// boundary check is still a real HTTP request, so it needs its own small
// transport budget: a 1 ms race can abort an answer that was already durable
// before the command started.
const FINAL_QUESTION_PROBE_BUDGET_MS = 100;

export async function waitForQuestion(
  probe: (signal: AbortSignal) => Promise<SnapshotChatMessage>,
  timeoutMs: number,
): Promise<FinalAnswer | null> {
  const deadline = Date.now() + timeoutMs;
  let question = await probeBefore(probe, deadline);
  if (question?.questionState?.status === "answered") return question.questionState;
  while (Date.now() < deadline) {
    await delay(Math.min(50, Math.max(1, deadline - Date.now())));
    question = await probeBefore(probe, deadline);
    if (question?.questionState?.status === "answered") return question.questionState;
  }
  question = await probeBefore(probe, Date.now() + FINAL_QUESTION_PROBE_BUDGET_MS);
  return question?.questionState?.status === "answered" ? question.questionState : null;
}

async function probeBefore(
  probe: (signal: AbortSignal) => Promise<SnapshotChatMessage>,
  absoluteDeadline: number,
): Promise<SnapshotChatMessage | null> {
  const controller = new AbortController();
  const remainingMs = Math.max(1, absoluteDeadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout(null);
      controller.abort(new Error("question wait probe deadline exceeded"));
    }, remainingMs);
  });
  try {
    return await Promise.race([probe(controller.signal), timedOut]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`--${name} must be a non-negative integer`);
  return parsed;
}
