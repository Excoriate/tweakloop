import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const canonical = join(root, ".agents", "hooks", "v2", "configure-client.mjs");
const projected = join(root, "hooks", "v2", "configure-client.mjs");
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "tweakloop-native-hook-config-"));
  fixtures.push(path);
  return path;
}

function configure(
  script: string,
  client: "claude-code" | "codex" | "cursor",
  output: string,
  profile = "profile-local",
) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [script, "--client", client, "--profile", profile, "--output", output],
      { encoding: "utf8" },
    ),
  ) as Record<string, unknown>;
}

function commandFrom(config: Record<string, unknown>, client: string) {
  const hooks = config.hooks as Record<string, unknown>;
  if (client === "cursor") {
    return ((hooks.stop as Array<Record<string, unknown>>)[0]?.command ?? "") as string;
  }
  const group = (hooks.Stop as Array<Record<string, unknown>>)[0];
  return ((group.hooks as Array<Record<string, unknown>>)[0]?.command ?? "") as string;
}

test.each([
  ["claude-code", ".claude/settings.json", "reason"],
  ["codex", ".codex/hooks.json", "reason"],
  ["cursor", ".cursor/hooks.json", "followup_message"],
] as const)("generates and executes the exact %s activation", (client, relative, outputKey) => {
  const workspace = fixture();
  const output = join(workspace, relative);
  const receipt = configure(canonical, client, output);
  const config = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
  const command = commandFrom(config, client);
  const bin = join(workspace, "bin");
  const captured = join(workspace, "argv.json");
  mkdirSync(bin);
  const fake = join(bin, "tweak");
  writeFileSync(
    fake,
    `#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\nwriteFileSync(process.env.ARG_LOG, JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(JSON.stringify({protocol:"tweakloop.native-hook-observation/v1",kind:"continue",sessionId:"session-test",messageId:"message-test"}));\n`,
  );
  chmodSync(fake, 0o755);

  const input =
    client === "cursor"
      ? { cwd: workspace, status: "completed", loop_count: 0, conversation_id: "conversation-test" }
      : {
          cwd: workspace,
          hook_event_name: "Stop",
          stop_hook_active: false,
          session_id: "conversation-test",
        };
  const invoked = spawnSync(command, {
    shell: true,
    encoding: "utf8",
    input: JSON.stringify(input),
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, ARG_LOG: captured },
  });

  expect(invoked.status).toBe(0);
  expect(invoked.stderr).toBe("");
  expect(JSON.parse(invoked.stdout)[outputKey]).toContain("message-test");
  expect(JSON.parse(readFileSync(captured, "utf8"))).toEqual([
    "--workspace",
    workspace,
    "--json",
    "native-hook",
    "observe",
    "--client",
    client,
    "--profile",
    "profile-local",
    "--conversation",
    "conversation-test",
  ]);
  expect(receipt).toMatchObject({
    protocol: "tweakloop.native-hook-config/v1",
    status: "configured",
    client,
    profileId: "profile-local",
    outputPath: output,
  });
  expect(receipt.adapterPath).toContain("/.agents/hooks/v2/continue-on-inbound.mjs");
});

test("the public generator points at the public packaged adapter", () => {
  const workspace = fixture();
  const packageRoot = join(workspace, "package");
  cpSync(join(root, "hooks"), join(packageRoot, "hooks"), { recursive: true });
  const cleanGenerator = join(packageRoot, "hooks", "v2", "configure-client.mjs");
  const output = join(workspace, "consumer", ".codex", "hooks.json");
  mkdirSync(join(workspace, "consumer"));
  const receipt = configure(cleanGenerator, "codex", output);
  expect(receipt.adapterPath).toContain("/package/hooks/v2/continue-on-inbound.mjs");
  expect(receipt.adapterPath).not.toContain("/.agents/");
  expect(existsSync(projected)).toBe(true);
});

describe("activation failure atomicity", () => {
  test("preserves an existing config byte-for-byte", () => {
    const workspace = fixture();
    const output = join(workspace, ".codex", "hooks.json");
    mkdirSync(dirname(output));
    writeFileSync(output, "owned-by-user\n");
    const result = spawnSync(
      process.execPath,
      [canonical, "--client", "codex", "--profile", "profile-local", "--output", output],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "native-hook-config.output-exists",
      mutated: false,
    });
    expect(readFileSync(output, "utf8")).toBe("owned-by-user\n");
  });

  test.each([
    [
      "wrong suffix",
      "codex",
      ".claude/settings.json",
      "profile-local",
      "native-hook-config.output-invalid",
    ],
    [
      "invalid profile",
      "codex",
      ".codex/hooks.json",
      "profile;unsafe",
      "native-hook-config.profile-invalid",
    ],
  ] as const)(
    "rejects %s without creating a client directory",
    (_label, client, relative, profile, code) => {
      const workspace = fixture();
      const output = join(workspace, relative);
      const result = spawnSync(
        process.execPath,
        [canonical, "--client", client, "--profile", profile, "--output", output],
        { encoding: "utf8" },
      );
      expect(result.status).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({ code, mutated: false });
      expect(existsSync(dirname(output))).toBe(false);
    },
  );

  test("rejects a symlinked client directory without touching its target", () => {
    const workspace = fixture();
    const neighbor = join(workspace, "neighbor");
    mkdirSync(neighbor);
    symlinkSync(neighbor, join(workspace, ".codex"));
    const output = join(workspace, ".codex", "hooks.json");
    const result = spawnSync(
      process.execPath,
      [canonical, "--client", "codex", "--profile", "profile-local", "--output", output],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "native-hook-config.output-symlink",
      mutated: false,
    });
    expect(readdirSync(neighbor)).toEqual([]);
    expect(lstatSync(join(workspace, ".codex")).isSymbolicLink()).toBe(true);
  });

  test("publishes exactly one winner under a two-process race", async () => {
    const workspace = fixture();
    const output = join(workspace, ".codex", "hooks.json");
    const first = runConfigureChild(output, "profile-one");
    const second = runConfigureChild(output, "profile-two");
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.status).sort()).toEqual([0, 2]);
    const winner = results.find((result) => result.status === 0);
    const loser = results.find((result) => result.status === 2);
    expect(JSON.parse(loser?.stdout ?? "{}")).toMatchObject({
      code: "native-hook-config.output-exists",
      mutated: false,
    });
    const receipt = JSON.parse(winner?.stdout ?? "{}") as Record<string, unknown>;
    const config = JSON.parse(readFileSync(output, "utf8")) as Record<string, unknown>;
    expect(commandFrom(config, "codex")).toContain(String(receipt.profileId));
    expect(readdirSync(dirname(output)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });
});

function runConfigureChild(output: string, profile: string) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolveChild) => {
    const child = spawn(
      process.execPath,
      [canonical, "--client", "codex", "--profile", profile, "--output", output],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolveChild({ status, stdout, stderr }));
  });
}
