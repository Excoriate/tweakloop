/**
 * Machine output discipline: exactly one JSON value on stdout with
 * --json; human diagnostics go to stderr; exit codes are stable.
 */

export function emitJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

export function info(message: string): void {
  console.error(message);
}

export function fail(message: string, code = 1): never {
  console.error(`error: ${message}`);
  process.exit(code);
}
