import { isAbsolute, resolve } from "node:path";

/**
 * The executable prefix that selected this CLI process. Generated commands
 * append arguments to this value instead of assuming a global `tweak` binary.
 *
 * A direct Node checkout and an installed bin are observable from argv. npm
 * does not expose the exact outer `npx` argv to the child, so callers that need
 * that spelling preserve it through the narrow TWEAKLOOP_INVOCATION_JSON
 * override, for example `["npx","-y","tweakloop"]`.
 */
export type Invocation = Readonly<{
  prefix: readonly string[];
  globalArgs?: readonly string[];
  source: "local-node" | "installed" | "override" | "fallback";
}>;

export type InvocationInput = Readonly<{
  execPath?: string;
  scriptPath?: string;
  overrideJson?: string;
  cwd?: string;
  argv?: readonly string[];
}>;

export class InvocationError extends Error {
  readonly code = "invocation.invalid-override";

  constructor(message: string) {
    super(message);
    this.name = "InvocationError";
  }
}

export function resolveInvocation(input: InvocationInput): Invocation {
  if (input.overrideJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.overrideJson);
    } catch {
      throw new InvocationError("TWEAKLOOP_INVOCATION_JSON must be a JSON string array");
    }
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some((part) => typeof part !== "string" || part.length === 0)
    ) {
      throw new InvocationError("TWEAKLOOP_INVOCATION_JSON must be a non-empty JSON string array");
    }
    return withWorkspaceArgs(parsed as string[], "override", input);
  }

  const scriptPath = input.scriptPath;
  if (!scriptPath) return withWorkspaceArgs(["tweak"], "fallback", input);
  const absoluteScript = isAbsolute(scriptPath)
    ? scriptPath
    : resolve(input.cwd ?? process.cwd(), scriptPath);
  if (/[/\\]dist[/\\]cli[/\\]index\.js$/.test(absoluteScript) && input.execPath) {
    const absoluteExec = isAbsolute(input.execPath)
      ? input.execPath
      : resolve(input.cwd ?? process.cwd(), input.execPath);
    return withWorkspaceArgs([absoluteExec, absoluteScript], "local-node", input);
  }
  return withWorkspaceArgs([absoluteScript], "installed", input);
}

export function currentInvocation(): Invocation {
  return resolveInvocation({
    execPath: process.execPath,
    ...(process.argv[1] ? { scriptPath: process.argv[1] } : {}),
    ...(process.env.TWEAKLOOP_INVOCATION_JSON
      ? { overrideJson: process.env.TWEAKLOOP_INVOCATION_JSON }
      : {}),
    cwd: process.cwd(),
    argv: process.argv.slice(2),
  });
}

export function renderInvocation(invocation: Invocation, args: readonly string[] = []): string {
  const globalArgs = hasWorkspaceOverride(args) ? [] : (invocation.globalArgs ?? []);
  return [...invocation.prefix, ...globalArgs, ...args].map(shellArg).join(" ");
}

export function shellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function withWorkspaceArgs(
  prefix: readonly string[],
  source: Invocation["source"],
  input: InvocationInput,
): Invocation {
  const globalArgs = workspaceGlobalArgs(input.argv, input.cwd);
  return globalArgs.length > 0 ? { prefix, globalArgs, source } : { prefix, source };
}

function workspaceGlobalArgs(
  argv: readonly string[] | undefined,
  cwd = process.cwd(),
): readonly string[] {
  if (!argv) return [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--workspace") {
      const workspace = argv[index + 1];
      return workspace ? ["--workspace", resolve(cwd, workspace)] : [];
    }
    if (value?.startsWith("--workspace=")) {
      const workspace = value.slice("--workspace=".length);
      return workspace ? ["--workspace", resolve(cwd, workspace)] : [];
    }
  }
  return [];
}

function hasWorkspaceOverride(args: readonly string[]): boolean {
  return args[0] === "--workspace" || args[0]?.startsWith("--workspace=") === true;
}
