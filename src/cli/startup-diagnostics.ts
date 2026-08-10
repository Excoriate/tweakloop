import { CliFailure } from "./output.js";

const STARTUP_TIMEOUT_PREFIX = "daemon did not become healthy within";

export function withStartupDiagnostics(error: unknown, foregroundCommand: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(STARTUP_TIMEOUT_PREFIX)) return error;
  return new CliFailure(message, {
    code: "daemon.startup-failed",
    exitCode: 1,
    retryable: true,
    details: {
      diagnosticSource: "foreground-command",
      backgroundDiagnostic: bounded(message),
    },
    nextAction: {
      command: foregroundCommand,
      reason: "run the same workspace daemon in the foreground to expose pre-logger failure",
    },
  });
}

function bounded(value: string): string {
  return value.length <= 1_024 ? value : `${value.slice(0, 1_021)}...`;
}
