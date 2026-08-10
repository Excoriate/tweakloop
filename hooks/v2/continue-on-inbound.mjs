#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const OBSERVATION_PROTOCOL = "tweakloop.native-hook-observation/v1";
const SUPPORTED_CLIENTS = new Set(["claude-code", "codex", "cursor"]);

function writeNoOp() {
  process.stdout.write("{}\n");
}

function parseOptions(argv) {
  const clientIndex = argv.indexOf("--client");
  if (clientIndex < 0 || clientIndex + 1 >= argv.length) return null;
  const client = argv[clientIndex + 1];
  if (!SUPPORTED_CLIENTS.has(client)) return null;
  const profileIndex = argv.indexOf("--profile");
  if (profileIndex < 0) {
    return argv.length === 2 && clientIndex === 0 ? { client, profile: null } : null;
  }
  if (
    argv.length !== 4 ||
    clientIndex !== 0 ||
    profileIndex !== 2 ||
    profileIndex + 1 >= argv.length ||
    !nonEmptyLocator(argv[profileIndex + 1])
  ) {
    return null;
  }
  return { client, profile: argv[profileIndex + 1] };
}

function nonEmptyLocator(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\0\r\n]/u.test(value)
  );
}

function normalizeNativeStop(client, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) return null;

  if (client === "cursor") {
    const eventMatches = input.hook_event_name === undefined || input.hook_event_name === "stop";
    const loopCount = input.loop_count === undefined ? 0 : input.loop_count;
    if (
      !eventMatches ||
      input.status !== "completed" ||
      !Number.isInteger(loopCount) ||
      loopCount < 0 ||
      !nonEmptyLocator(input.conversation_id)
    ) {
      return null;
    }
    return { conversation: input.conversation_id, looped: loopCount > 0 };
  }

  if (
    input.hook_event_name !== "Stop" ||
    typeof input.stop_hook_active !== "boolean" ||
    !nonEmptyLocator(input.session_id)
  ) {
    return null;
  }
  return { conversation: input.session_id, looped: input.stop_hook_active };
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseObservation(stdout) {
  let value;
  try {
    value = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.protocol !== OBSERVATION_PROTOCOL) return null;
  if (value.kind === "none") {
    return exactKeys(value, ["protocol", "kind"]) ? value : null;
  }
  if (
    value.kind === "continue" &&
    exactKeys(value, ["protocol", "kind", "sessionId", "messageId"]) &&
    nonEmptyLocator(value.sessionId) &&
    nonEmptyLocator(value.messageId)
  ) {
    return value;
  }
  return null;
}

function continuationOutput(client, observation) {
  const reason =
    `A human Tweakloop message is ready for session ${observation.sessionId} ` +
    `(message ${observation.messageId}). Continue this conversation and consume it through ` +
    "the ordinary Tweakloop workflow.";
  return client === "cursor" ? { followup_message: reason } : { decision: "block", reason };
}

const options = parseOptions(process.argv.slice(2));
if (!options) {
  writeNoOp();
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  writeNoOp();
  process.exit(0);
}

const nativeStop = normalizeNativeStop(options.client, input);
const profile = options.profile ?? process.env.TWEAKLOOP_NATIVE_PROFILE_ID;
const configuredCli = process.env.TWEAKLOOP_HOOK_CLI;
const cli = configuredCli ?? "tweak";

if (
  !nativeStop ||
  nativeStop.looped ||
  !nonEmptyLocator(profile) ||
  (configuredCli !== undefined && (!isAbsolute(configuredCli) || !existsSync(configuredCli)))
) {
  writeNoOp();
  process.exit(0);
}

const observed = spawnSync(
  cli,
  [
    "--workspace",
    input.cwd,
    "--json",
    "native-hook",
    "observe",
    "--client",
    options.client,
    "--profile",
    profile,
    "--conversation",
    nativeStop.conversation,
  ],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
);

if (observed.status !== 0) {
  writeNoOp();
  process.exit(0);
}

const observation = parseObservation(observed.stdout);
if (!observation || observation.kind === "none") {
  writeNoOp();
  process.exit(0);
}

process.stdout.write(`${JSON.stringify(continuationOutput(options.client, observation))}\n`);
