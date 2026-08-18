import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceIdFor } from "../../src/daemon/runtime.js";
import { mkdtempInRepo } from "../support/repo-temp-dir.js";

const root = resolve(import.meta.dirname, "../..");
const fixtureRoot = mkdtempInRepo("c1-cli-test-");
const cli = join(fixtureRoot, "dist", "cli", "index.js");
const daemonMain = join(fixtureRoot, "dist", "daemon", "main.js");
const startupWorkspace = join(fixtureRoot, "startup-workspace");
const custodyWorkspace = join(fixtureRoot, "custody-workspace");
const custodyStateRoot = join(custodyWorkspace, ".state-root");
const custodyDocument = join(custodyWorkspace, "order-flow.excalidraw");
const stopWorkspace = join(fixtureRoot, "stop-workspace");
const stopStateRoot = join(fixtureRoot, "stop-state");
const stateRoot = join(fixtureRoot, "state");
const valid = join(fixtureRoot, "valid.html");
const invalid = join(fixtureRoot, "invalid.html");

beforeAll(async () => {
  await Promise.all([
    build({
      entryPoints: [join(root, "src/cli/index.ts")],
      outfile: cli,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      packages: "external",
      logLevel: "silent",
    }),
    build({
      entryPoints: [join(root, "src/daemon/main.ts")],
      outfile: daemonMain,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node24",
      packages: "external",
      logLevel: "silent",
    }),
  ]);
  mkdirSync(join(startupWorkspace, ".tweakloop"), { recursive: true });
  writeFileSync(
    join(startupWorkspace, ".tweakloop", "project.json"),
    '{"projectId":7,"schemaVersion":1}\n',
  );
  mkdirSync(join(custodyWorkspace, ".tweakloop"), { recursive: true });
  writeFileSync(
    join(custodyWorkspace, ".tweakloop", "project.json"),
    '{"projectId":"11111111-1111-4111-8111-111111111111","schemaVersion":1}\n',
  );
  writeFileSync(
    custodyDocument,
    '{"type":"excalidraw","version":2,"source":"https://tweakloop.local","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}\n',
  );
  mkdirSync(join(stopWorkspace, ".tweakloop"), { recursive: true });
  writeFileSync(
    join(stopWorkspace, ".tweakloop", "project.json"),
    '{"projectId":"22222222-2222-4222-8222-222222222222","schemaVersion":1}\n',
  );
  writeFileSync(
    valid,
    '<main><section data-tweak-id="decision.auth" data-tweak-kind="decision">OAuth</section></main>',
  );
  writeFileSync(
    invalid,
    '<main><section data-tweak-id="decision.auth">[[ANSWER]]</section></main>',
  );
});

afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe("C1 current-source CLI output lifecycle", () => {
  it.each([
    ["pre-command unknown command", ["--json", "not-a-command"]],
    ["post-command unknown command", ["not-a-command", "--json"]],
    ["missing required argument", ["lint", "--json"]],
    ["unknown option", ["lint", valid, "--not-real", "--json"]],
  ])("emits one stdout error envelope for %s", (_label, args) => {
    const result = run(args);
    const value = oneJson(result.stdout);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toBe("");
    expect(value).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: expect.any(String), message: expect.any(String), retryable: false },
    });
  });

  it("routes deleted-current-directory startup failure through the same stdout owner", () => {
    const deletedCwd = join(fixtureRoot, "deleted-cwd");
    mkdirSync(deletedCwd);
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        'cd "$1" && rmdir "$1" && exec "$2" "$3" --json not-a-command',
        "c1-deleted-cwd",
        deletedCwd,
        process.execPath,
        cli,
      ],
      { cwd: root, encoding: "utf8", env: { ...process.env } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "cli.cwd-unavailable", retryable: false },
    });
  });

  it.each([
    ["pre-command", ["--json", "not-a-command"]],
    ["post-command", ["not-a-command", "--json"]],
  ])("routes %s invocation failures through the same stdout owner", (_label, args) => {
    const result = run(args, { TWEAKLOOP_INVOCATION_JSON: "not-json" });

    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "invocation.invalid-override", retryable: false },
    });
  });

  it("routes a former leaf-local missing-file failure through the same envelope", () => {
    const result = run(["lint", join(fixtureRoot, "missing.html"), "--json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "lint.failed", retryable: false },
    });
  });

  it("routes a daemon transport failure through the same one-value stdout owner", () => {
    const result = run(["--workspace", fixtureRoot, "session", "list", "--json"], {
      TWEAKLOOP_STATE_DIR: stateRoot,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("");
    expect(oneJson(result.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      error: { code: "daemon.unavailable", retryable: true },
    });
  });

  it("rejects workspace-contained custody before open can commit an artifact or revision", () => {
    const env = { TWEAKLOOP_STATE_DIR: custodyStateRoot };
    const started = run(["--workspace", custodyWorkspace, "daemon", "start", "--json"], env);
    expect(started.status).toBe(0);

    try {
      const beforeStatus = oneJson(
        run(["--workspace", custodyWorkspace, "status", "--summary", "--json"], env).stdout,
      );
      const beforeEvents = oneJson(
        run(["--workspace", custodyWorkspace, "events", "list", "--json"], env).stdout,
      );
      expect(beforeStatus).toMatchObject({ artifactCount: 0, lastSeq: 1 });

      const failed = run(
        [
          "--workspace",
          custodyWorkspace,
          "open",
          custodyDocument,
          "--agent",
          "agent:codex",
          "--json",
        ],
        env,
      );
      expect(failed.status).toBe(1);
      expect(failed.stderr).toBe("");
      expect(oneJson(failed.stdout)).toEqual({
        protocol: "tweakloop.cli/v1",
        error: {
          code: "runtime-capability.workspace-custody-forbidden",
          message: "runtime capability custody must be outside the workspace",
          retryable: false,
        },
      });
      expect(failed.stdout).not.toMatch(/runtimeCapability|capabilityHash|cliToken|bootstrap/i);

      const afterStatus = oneJson(
        run(["--workspace", custodyWorkspace, "status", "--summary", "--json"], env).stdout,
      );
      const afterEvents = oneJson(
        run(["--workspace", custodyWorkspace, "events", "list", "--json"], env).stdout,
      );
      expect(afterStatus).toMatchObject({ artifactCount: 0, lastSeq: 1 });
      expect(afterEvents).toEqual(beforeEvents);
      expect(
        existsSync(
          join(
            custodyStateRoot,
            "tweakloop",
            "workspaces",
            workspaceIdFor(custodyWorkspace),
            "runtime-capabilities",
          ),
        ),
      ).toBe(false);
    } finally {
      run(["--workspace", custodyWorkspace, "daemon", "stop", "--json"], env);
    }
  }, 20_000);

  it("preserves successful payload bytes for supported JSON placement", () => {
    const before = run(["--json", "lint", valid]);
    const after = run(["lint", valid, "--json"]);
    expect(before.status).toBe(0);
    expect(after.status).toBe(0);
    expect(after.stdout).toBe(before.stdout);
    expect(oneJson(after.stdout)).toMatchObject({
      protocol: "tweakloop.cli/v1",
      status: "pass",
      findings: [],
    });
  });

  it("owns JSON output for both the first daemon stop and an already-stopped no-op", () => {
    const env = { TWEAKLOOP_STATE_DIR: stopStateRoot };
    const started = run(["--workspace", stopWorkspace, "daemon", "start", "--json"], env);
    expect(started.status).toBe(0);

    const first = run(["--workspace", stopWorkspace, "daemon", "stop", "--json"], env);
    expect(first.status).toBe(0);
    expect(first.stderr).toBe("");
    expect(oneJson(first.stdout)).toEqual({
      protocol: "tweakloop.cli/v1",
      daemon: "stopped",
      alreadyStopped: false,
    });

    const repeated = run(["--workspace", stopWorkspace, "daemon", "stop", "--json"], env);
    expect(repeated.status).toBe(0);
    expect(repeated.stderr).toBe("");
    expect(oneJson(repeated.stdout)).toEqual({
      protocol: "tweakloop.cli/v1",
      daemon: "stopped",
      alreadyStopped: true,
    });

    const human = run(["--workspace", stopWorkspace, "daemon", "stop"], env);
    expect(human.status).toBe(0);
    expect(human.stdout).toBe("");
    expect(human.stderr).toBe("daemon is not running\n");
  }, 20_000);

  it("keeps semantic validation negative as a result rather than an infrastructure error", () => {
    const result = run(["lint", invalid, "--json"]);
    const value = oneJson(result.stdout);
    expect(result.status).toBe(1);
    expect(value).toMatchObject({
      protocol: "tweakloop.cli/v1",
      status: "fail",
      errorCount: 2,
    });
    expect(value).not.toHaveProperty("error");
  });

  it("runs the exact workspace foreground command when a pre-logger daemon failure leaves no cause log", () => {
    const failedStart = run(["--workspace", startupWorkspace, "daemon", "start", "--json"], {
      TWEAKLOOP_STATE_DIR: stateRoot,
    });
    const envelope = oneJson(failedStart.stdout) as {
      error?: { nextAction?: { command?: string } };
    };
    const command = envelope.error?.nextAction?.command;

    expect(failedStart.status).toBe(1);
    expect(failedStart.stderr).toBe("");
    expect(command).toBe(
      `'${process.execPath}' '${cli}' '--workspace' '${startupWorkspace}' 'daemon' 'start' '--foreground'`,
    );

    const foreground = spawnSync("/bin/sh", ["-c", command ?? ""], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: "", TWEAKLOOP_STATE_DIR: stateRoot },
    });
    expect(foreground.status).not.toBe(0);
    expect(foreground.stdout).toBe("");
    expect(foreground.stderr).toContain("workspace.open rejected");
  }, 20_000);
});

function run(args: readonly string[], env: Readonly<Record<string, string>> = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function oneJson(stdout: string): Record<string, unknown> {
  expect(stdout.trim()).not.toBe("");
  return JSON.parse(stdout) as Record<string, unknown>;
}
