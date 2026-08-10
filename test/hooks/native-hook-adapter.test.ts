import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const adapter = join(root, ".agents", "hooks", "v2", "continue-on-inbound.mjs");
const projectedAdapter = join(root, "hooks", "v2", "continue-on-inbound.mjs");
const fixtures: string[] = [];

function createFakeCli() {
  const fixture = mkdtempSync(join(tmpdir(), "tweakloop-native-hook-adapter-"));
  fixtures.push(fixture);
  const cli = join(fixture, "tweak-fixture.mjs");
  const argvRecord = join(fixture, "argv.json");
  writeFileSync(
    cli,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(process.env.ARGV_RECORD, JSON.stringify(process.argv.slice(2)));
if (process.env.OBSERVATION_EXIT !== "0") process.exit(Number(process.env.OBSERVATION_EXIT));
process.stdout.write(process.env.OBSERVATION_RESPONSE);
`,
  );
  chmodSync(cli, 0o755);
  return { cli, argvRecord };
}

function runAdapter(
  input: unknown,
  options: {
    adapterPath?: string;
    client?: string;
    response?: unknown;
    exit?: number;
    profile?: string | null;
  } = {},
) {
  const fake = createFakeCli();
  const response =
    options.response ??
    ({
      protocol: "tweakloop.native-hook-observation/v1",
      kind: "continue",
      sessionId: "session-tweakloop",
      messageId: "message-human-1",
    } as const);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ARGV_RECORD: fake.argvRecord,
    OBSERVATION_EXIT: String(options.exit ?? 0),
    OBSERVATION_RESPONSE: JSON.stringify(response),
    TWEAKLOOP_HOOK_CLI: fake.cli,
  };
  if (options.profile !== null) {
    environment.TWEAKLOOP_NATIVE_PROFILE_ID = options.profile ?? "profile-local";
  } else {
    delete environment.TWEAKLOOP_NATIVE_PROFILE_ID;
  }
  const result = spawnSync(
    process.execPath,
    [options.adapterPath ?? adapter, "--client", options.client ?? "claude-code"],
    {
      encoding: "utf8",
      input: JSON.stringify(input),
      env: environment,
    },
  );
  return {
    ...result,
    argv: existsSync(fake.argvRecord)
      ? (JSON.parse(readFileSync(fake.argvRecord, "utf8")) as string[])
      : null,
  };
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("native hook v2 adapter", () => {
  test.each([
    {
      client: "claude-code",
      input: {
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: "claude-session",
        cwd: root,
      },
      conversation: "claude-session",
      outputKey: "decision",
    },
    {
      client: "codex",
      input: {
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: "codex-session",
        turn_id: "turn-9",
        cwd: root,
      },
      conversation: "codex-session",
      outputKey: "decision",
    },
    {
      client: "cursor",
      input: {
        hook_event_name: "stop",
        status: "completed",
        loop_count: 0,
        conversation_id: "cursor-conversation",
        cwd: root,
      },
      conversation: "cursor-conversation",
      outputKey: "followup_message",
    },
  ])(
    "observes the exact native identity for $client",
    ({ client, input, conversation, outputKey }) => {
      const result = runAdapter(input, { client });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.argv).toEqual([
        "--workspace",
        root,
        "--json",
        "native-hook",
        "observe",
        "--client",
        client,
        "--profile",
        "profile-local",
        "--conversation",
        conversation,
      ]);
      const output = JSON.parse(result.stdout) as Record<string, string>;
      expect(output[outputKey]).toBeTruthy();
      expect(JSON.stringify(output)).toContain("session-tweakloop");
      expect(JSON.stringify(output)).toContain("message-human-1");
    },
  );

  test("executes the checked-in public projection with the exact observation argv", () => {
    const result = runAdapter(
      {
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: "projected-session",
        cwd: root,
      },
      { adapterPath: projectedAdapter, client: "codex" },
    );

    expect(result.status).toBe(0);
    expect(result.argv).toEqual([
      "--workspace",
      root,
      "--json",
      "native-hook",
      "observe",
      "--client",
      "codex",
      "--profile",
      "profile-local",
      "--conversation",
      "projected-session",
    ]);
  });

  test("makes the exact-argv contract reject an indirectly assembled mutating command", () => {
    const fixture = mkdtempSync(join(tmpdir(), "tweakloop-native-hook-mutant-"));
    fixtures.push(fixture);
    const mutant = join(fixture, "continue-on-inbound.mjs");
    const source = readFileSync(adapter, "utf8");
    expect(source).toContain('"native-hook",\n    "observe",');
    writeFileSync(
      mutant,
      source.replace('"native-hook",\n    "observe",', '...["ne" + "xt", "--session"],'),
    );

    const result = runAdapter(
      {
        hook_event_name: "Stop",
        stop_hook_active: false,
        session_id: "mutant-session",
        cwd: root,
      },
      { adapterPath: mutant, client: "codex" },
    );

    expect(result.status).toBe(0);
    expect(result.argv).toEqual([
      "--workspace",
      root,
      "--json",
      "next",
      "--session",
      "--client",
      "codex",
      "--profile",
      "profile-local",
      "--conversation",
      "mutant-session",
    ]);
    expect(result.argv).not.toEqual([
      "--workspace",
      root,
      "--json",
      "native-hook",
      "observe",
      "--client",
      "codex",
      "--profile",
      "profile-local",
      "--conversation",
      "mutant-session",
    ]);
  });

  test.each([
    [
      "wrong event",
      { hook_event_name: "PostToolUse", stop_hook_active: false, session_id: "s", cwd: root },
    ],
    ["missing conversation", { hook_event_name: "Stop", stop_hook_active: false, cwd: root }],
    ["loop guard", { hook_event_name: "Stop", stop_hook_active: true, session_id: "s", cwd: root }],
    [
      "relative workspace",
      { hook_event_name: "Stop", stop_hook_active: false, session_id: "s", cwd: "." },
    ],
  ])("returns a no-op without invoking Tweakloop for %s", (_label, input) => {
    const result = runAdapter(input);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("{}\n");
    expect(result.stderr).toBe("");
    expect(result.argv).toBeNull();
  });

  test("returns a no-op without invoking Tweakloop when the profile locator is absent", () => {
    const result = runAdapter(
      { hook_event_name: "Stop", stop_hook_active: false, session_id: "s", cwd: root },
      { profile: null },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("{}\n");
    expect(result.stderr).toBe("");
    expect(result.argv).toBeNull();
  });

  test.each([
    ["none", { protocol: "tweakloop.native-hook-observation/v1", kind: "none" }, 0],
    [
      "extra response key",
      {
        protocol: "tweakloop.native-hook-observation/v1",
        kind: "continue",
        sessionId: "s",
        messageId: "m",
        extra: true,
      },
      0,
    ],
    ["wrong protocol", { protocol: "tweakloop.events/v1", kind: "continue" }, 0],
    ["no binding exit", {}, 12],
  ])("fails closed for %s", (_label, response, exit) => {
    const result = runAdapter(
      { hook_event_name: "Stop", stop_hook_active: false, session_id: "s", cwd: root },
      { response, exit },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("{}\n");
    expect(result.stderr).toBe("");
  });

  test("does not expose a binding bearer through input, environment, arguments, or output", () => {
    const result = runAdapter({
      hook_event_name: "Stop",
      stop_hook_active: false,
      session_id: "native-session",
      bindingSecret: "must-not-cross-adapter",
      cwd: root,
    });
    const observed = JSON.stringify({
      argv: result.argv,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    expect(observed).not.toContain("must-not-cross-adapter");
    expect(observed).not.toContain("bindingSecret");
  });
});
