#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROTOCOL = "tweakloop.native-hook-config/v1";
const CLIENTS = new Map([
  ["claude-code", { suffix: [".claude", "settings.json"] }],
  ["codex", { suffix: [".codex", "hooks.json"] }],
  ["cursor", { suffix: [".cursor", "hooks.json"] }],
]);
const PROFILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parseOptions(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || value === undefined || values.has(option)) {
      throw new ConfigError(
        "native-hook-config.arguments-invalid",
        "expected unique option/value pairs",
      );
    }
    values.set(option, value);
  }
  const allowed = new Set(["--client", "--profile", "--output"]);
  if (values.size !== allowed.size || [...values.keys()].some((key) => !allowed.has(key))) {
    throw new ConfigError(
      "native-hook-config.arguments-invalid",
      "required options: --client, --profile, and --output",
    );
  }
  const client = values.get("--client");
  const profile = values.get("--profile");
  const output = values.get("--output");
  if (!CLIENTS.has(client)) {
    throw new ConfigError(
      "native-hook-config.client-invalid",
      "client must be claude-code, codex, or cursor",
    );
  }
  if (!PROFILE.test(profile)) {
    throw new ConfigError(
      "native-hook-config.profile-invalid",
      "profile must use 1-128 letters, digits, dots, underscores, or hyphens",
    );
  }
  return { client, profile, output: resolve(output) };
}

function requireExpectedOutput(client, output) {
  const expected = CLIENTS.get(client).suffix;
  const parent = dirname(output);
  if (!parent.endsWith(expected[0]) || output !== resolve(parent, expected[1])) {
    throw new ConfigError(
      "native-hook-config.output-invalid",
      `output for ${client} must end in ${expected.join("/")}`,
    );
  }
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new ConfigError(
      "native-hook-config.output-symlink",
      "client configuration directory cannot be a symlink",
    );
  }
  if (existsSync(output)) {
    throw new ConfigError(
      "native-hook-config.output-exists",
      "client configuration already exists; review and merge it manually",
    );
  }
  return parent;
}

function quoteArgument(value) {
  if (process.platform === "win32") {
    if (/[%!^&|<>\r\n]/u.test(value)) {
      throw new ConfigError(
        "native-hook-config.path-unsupported",
        "Windows hook arguments contain shell metacharacters",
      );
    }
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function configuration(client, command) {
  if (client === "cursor") {
    return { version: 1, hooks: { stop: [{ command, timeout: 30, loop_limit: 1 }] } };
  }
  const stop = [{ hooks: [{ type: "command", command, timeout: 30 }] }];
  return client === "codex"
    ? {
        description: "Optional Tweakloop inbound continuation for this workspace.",
        hooks: { Stop: stop },
      }
    : { hooks: { Stop: stop } };
}

function writeExclusiveAtomic(output, bytes) {
  const parent = dirname(output);
  let parentCreated = false;
  let descriptor = null;
  let published = false;
  const temporary = `${output}.tmp-${randomUUID()}`;
  try {
    if (!existsSync(parent)) {
      try {
        mkdirSync(parent, { mode: 0o755 });
        parentCreated = true;
      } catch (error) {
        if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
      }
    }
    if (lstatSync(parent).isSymbolicLink() || !lstatSync(parent).isDirectory()) {
      throw new ConfigError(
        "native-hook-config.output-symlink",
        "client configuration directory must be a real directory",
      );
    }
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    linkSync(temporary, output);
    published = true;
    rmSync(temporary, { force: true });
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    if (!published && parentCreated && existsSync(parent) && readdirSync(parent).length === 0) {
      rmdirSync(parent);
    }
    if (!published && error && typeof error === "object" && error.code === "EEXIST") {
      throw new ConfigError(
        "native-hook-config.output-exists",
        "client configuration already exists; review and merge it manually",
      );
    }
    throw error;
  }
}

function configure(argv) {
  const options = parseOptions(argv);
  requireExpectedOutput(options.client, options.output);
  const adapter = fileURLToPath(new URL("./continue-on-inbound.mjs", import.meta.url));
  const command = [
    process.execPath,
    adapter,
    "--client",
    options.client,
    "--profile",
    options.profile,
  ]
    .map(quoteArgument)
    .join(" ");
  const config = configuration(options.client, command);
  const bytes = `${JSON.stringify(config, null, 2)}\n`;
  writeExclusiveAtomic(options.output, bytes);
  return {
    protocol: PROTOCOL,
    status: "configured",
    client: options.client,
    profileId: options.profile,
    outputPath: options.output,
    adapterPath: adapter,
    configurationSha256: createHash("sha256").update(bytes).digest("hex"),
    nextAction: {
      kind: "bind-active-conversation",
      command:
        `tweak --json native-hook bind --session <session-id> --client ${options.client} ` +
        `--profile ${options.profile} --conversation <native-conversation-id>`,
    },
  };
}

try {
  process.stdout.write(`${JSON.stringify(configure(process.argv.slice(2)))}\n`);
} catch (error) {
  const known = error instanceof ConfigError;
  process.stdout.write(
    `${JSON.stringify({
      protocol: PROTOCOL,
      status: "error",
      code: known ? error.code : "native-hook-config.write-failed",
      message: error instanceof Error ? error.message : String(error),
      mutated: false,
    })}\n`,
  );
  process.exitCode = 2;
}
