/**
 * Machine output discipline: exactly one JSON value on stdout with
 * --json; human diagnostics go to stderr; exit codes are stable.
 */

import { CLI_PROTOCOL } from "../protocol/versions.js";

export type CliNextAction = string | Readonly<{ command: string; [key: string]: unknown }>;

export type CliFailureOptions = Readonly<{
  code?: string;
  exitCode?: number;
  retryable?: boolean;
  details?: Readonly<Record<string, unknown>>;
  nextAction?: CliNextAction;
}>;

export type CliErrorEnvelope = Readonly<{
  protocol: typeof CLI_PROTOCOL;
  error: Readonly<{
    code: string;
    message: string;
    retryable: boolean;
    details?: Readonly<Record<string, unknown>>;
    nextAction?: CliNextAction;
  }>;
}>;

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(normalizeJsonOutput(value), null, 2));
}

export function info(message: string): void {
  console.error(message);
}

export class CliFailure extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;
  readonly nextAction: CliNextAction | undefined;

  constructor(message: string, exitCodeOrOptions: number | CliFailureOptions = 1) {
    const parsed = parseCodePrefix(stripErrorPrefix(message));
    super(parsed.message);
    this.name = "CliFailure";
    const options =
      typeof exitCodeOrOptions === "number" ? { exitCode: exitCodeOrOptions } : exitCodeOrOptions;
    this.exitCode = options.exitCode ?? 1;
    this.code = options.code ?? parsed.code ?? inferredCode(parsed.message);
    this.retryable = options.retryable ?? this.code.startsWith("daemon.");
    this.details = options.details ?? {};
    this.nextAction = options.nextAction;
  }
}

export function fail(message: string, exitCodeOrOptions: number | CliFailureOptions = 1): never {
  throw new CliFailure(message, exitCodeOrOptions);
}

export function normalizeCliFailure(error: unknown): CliFailure {
  if (error instanceof CliFailure) return error;
  const record = objectRecord(error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  const explicitCode = typeof record?.code === "string" ? record.code : undefined;
  const parsed = parseCodePrefix(stripErrorPrefix(rawMessage));
  return new CliFailure(parsed.message, {
    code: explicitCode ?? parsed.code ?? "cli.failure",
    exitCode: typeof record?.exitCode === "number" && record.exitCode > 0 ? record.exitCode : 1,
    retryable: record?.retryable === true,
    ...(isRecord(record?.details) ? { details: record.details } : {}),
  });
}

export function failureEnvelope(error: unknown): CliErrorEnvelope {
  const failure = normalizeCliFailure(error);
  return {
    protocol: CLI_PROTOCOL,
    error: {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      ...(Object.keys(failure.details).length > 0 ? { details: failure.details } : {}),
      ...(failure.nextAction === undefined ? {} : { nextAction: failure.nextAction }),
    },
  };
}

export function reportFailure(error: unknown, json: boolean): CliFailure {
  const failure = normalizeCliFailure(error);
  if (json) emitJson(failureEnvelope(failure));
  else {
    console.error(`error: ${failure.message}`);
    if (failure.nextAction !== undefined) {
      const next =
        typeof failure.nextAction === "string" ? failure.nextAction : failure.nextAction.command;
      console.error(`next: ${next}`);
    }
  }
  process.exitCode = failure.exitCode;
  return failure;
}

export function exitWithFailure(error: unknown, json = false): never {
  const failure = reportFailure(error, json);
  process.exit(failure.exitCode);
}

export function jsonRequested(argv: readonly string[] = process.argv.slice(2)): boolean {
  return argv.includes("--json");
}

export function successfulParserExit(error: unknown): boolean {
  const record = objectRecord(error);
  return record?.exitCode === 0;
}

/**
 * Transitional leaf errors still enter through emitJson. Normalize only an
 * explicit legacy error value; successful payloads retain their exact shape.
 */
export function normalizeJsonOutput(value: unknown): unknown {
  if (
    !isRecord(value) ||
    (value.status !== "error" && value.status !== "conflict") ||
    "error" in value
  )
    return value;
  const details = isRecord(value.details) ? { ...value.details } : {};
  for (const [key, item] of Object.entries(value)) {
    if (
      [
        "protocol",
        "status",
        "code",
        "message",
        "retryable",
        "details",
        "recovery",
        "recoveryCommand",
      ].includes(key)
    ) {
      continue;
    }
    details[key] = item;
  }
  const nextAction =
    typeof value.recoveryCommand === "string"
      ? { command: value.recoveryCommand }
      : typeof value.recovery === "string"
        ? value.recovery
        : undefined;
  return {
    protocol: CLI_PROTOCOL,
    error: {
      code:
        typeof value.code === "string"
          ? value.code
          : value.status === "conflict"
            ? "cli.conflict"
            : "cli.failure",
      message:
        typeof value.message === "string"
          ? value.message
          : value.status === "conflict"
            ? "command conflicted with current state"
            : "command failed",
      retryable: value.status === "conflict" || value.retryable === true,
      ...(Object.keys(details).length > 0 ? { details } : {}),
      ...(nextAction === undefined ? {} : { nextAction }),
    },
  } satisfies CliErrorEnvelope;
}

function parseCodePrefix(message: string): Readonly<{ code?: string; message: string }> {
  const match = /^([a-z][a-z0-9.-]+):\s+(.+)$/s.exec(message);
  if (!match?.[1] || !match[2]) return { message };
  return { code: match[1], message: match[2] };
}

function stripErrorPrefix(message: string): string {
  return message.startsWith("error: ") ? message.slice("error: ".length) : message;
}

function inferredCode(message: string): string {
  if (message.startsWith("daemon is not running")) return "daemon.unavailable";
  if (message.includes("file not found") || message.includes("ENOENT")) {
    return "cli.file-not-found";
  }
  return "cli.failure";
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
