#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_ADAPTERS } from "./agent-harness-render.mjs";

const GUIDE_MARKER = "TWEAKLOOP_HARNESS_GUIDE_7F32";
const SKILL_MARKER = "TWEAKLOOP_HARNESS_SKILL_91C4";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArguments(argv) {
  const clientIndex = argv.indexOf("--client");
  const modeIndex = argv.indexOf("--mode");
  const client = clientIndex >= 0 ? argv[clientIndex + 1] : undefined;
  const mode = modeIndex >= 0 ? argv[modeIndex + 1] : "discovery";
  if (!new Set(["codex", "claude-code", "cursor"]).has(client)) {
    throw new Error("--client must be codex, claude-code, or cursor");
  }
  if (!new Set(["discovery", "execute"]).has(mode)) {
    throw new Error("--mode must be discovery or execute");
  }
  return { client, mode };
}

function command(binary, args, options = {}) {
  const result = spawnSync(binary, args, { encoding: "utf8", ...options });
  return {
    exitCode: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? null,
  };
}

function createFixture(client) {
  const fixture = mkdtempSync(join(tmpdir(), `tweakloop-${client}-consumer-`));
  mkdirSync(join(fixture, ".agents", "skills", "harness-probe"), { recursive: true });
  mkdirSync(join(fixture, ".ai", "harness", "native-hooks", "v1"), { recursive: true });
  mkdirSync(join(fixture, ".claude", "skills", "harness-probe"), { recursive: true });
  mkdirSync(join(fixture, ".codex"), { recursive: true });
  mkdirSync(join(fixture, ".cursor"), { recursive: true });
  writeFileSync(
    join(fixture, ".agents", "AGENTS.md"),
    `# Isolated harness probe\n\nWhen asked for the two harness markers, include ${GUIDE_MARKER}.\n`,
  );
  writeFileSync(join(fixture, "AGENTS.md"), readFileSync(join(fixture, ".agents", "AGENTS.md")));
  writeFileSync(join(fixture, "CLAUDE.md"), "@.agents/AGENTS.md\n");
  const skill = `---
name: harness-probe
description: Isolated native skill invocation probe. Use only when explicitly asked for the harness probe.
---

# Harness probe

When invoked, include ${SKILL_MARKER} in the response.
`;
  writeFileSync(join(fixture, ".agents", "skills", "harness-probe", "SKILL.md"), skill);
  writeFileSync(join(fixture, ".claude", "skills", "harness-probe", "SKILL.md"), skill);
  writeFileSync(
    join(fixture, ".ai", "harness", "native-hooks", "v1", "continue-on-durable.mjs"),
    readFileSync(
      join(repositoryRoot, ".ai", "harness", "native-hooks", "v1", "continue-on-durable.mjs"),
    ),
  );
  for (const [id, consumer] of [
    ["claude-hook-adapter", join(fixture, ".claude", "settings.json")],
    ["codex-hook-adapter", join(fixture, ".codex", "hooks.json")],
    ["cursor-hook-adapter", join(fixture, ".cursor", "hooks.json")],
  ]) {
    writeFileSync(consumer, `${JSON.stringify(SCHEMA_ADAPTERS.get(id), null, 2)}\n`);
  }
  const git = command("git", ["init", "--quiet"], { cwd: fixture });
  if (git.exitCode !== 0) throw new Error(`isolated git init failed: ${git.stderr}`);
  return fixture;
}

function hookRecord(path) {
  if (!existsSync(path)) return null;
  const records = readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return records.at(-1) ?? null;
}

function bindProbeEvidence(fixture, client, evidencePath) {
  const configPath =
    client === "codex"
      ? join(fixture, ".codex", "hooks.json")
      : client === "claude-code"
        ? join(fixture, ".claude", "settings.json")
        : join(fixture, ".cursor", "hooks.json");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const hook = client === "cursor" ? config.hooks.stop[0] : config.hooks.Stop[0].hooks[0];
  hook.command = `TWEAKLOOP_HOOK_EVIDENCE_PATH=${JSON.stringify(evidencePath)} ${hook.command}`;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function codexDiscovery(fixture) {
  const result = command(
    "codex",
    ["debug", "prompt-input", "Use $harness-probe and return the two harness markers."],
    { cwd: fixture },
  );
  const guideNativeLoad = result.stdout.includes(GUIDE_MARKER);
  const skillNativeDiscovery = result.stdout.includes("harness-probe");
  return {
    status: result.exitCode === 0 && guideNativeLoad && skillNativeDiscovery ? "PASS" : "PARTIAL",
    guideNativeLoad,
    guideMarkerCount: result.stdout.split(GUIDE_MARKER).length - 1,
    skillNativeDiscovery,
    skillBodyLoaded: result.stdout.includes(SKILL_MARKER),
    exitCode: result.exitCode,
    diagnostic: result.exitCode === 0 ? null : result.stderr.trim(),
  };
}

function executeCodex(fixture, evidencePath) {
  const result = command(
    "codex",
    [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--enable",
      "hooks",
      "--dangerously-bypass-hook-trust",
      "--sandbox",
      "read-only",
      "-C",
      fixture,
      "Use $harness-probe. Follow the repository guide. Return only the two harness markers.",
    ],
    { env: { ...process.env, TWEAKLOOP_HOOK_EVIDENCE_PATH: evidencePath } },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const guideNativeLoad = output.includes(GUIDE_MARKER);
  const skillInvocation = output.includes(SKILL_MARKER);
  const hookInvocation = hookRecord(evidencePath);
  return {
    status:
      result.exitCode === 0 && guideNativeLoad && skillInvocation && hookInvocation
        ? "PASS"
        : "PARTIAL",
    guideNativeLoad,
    guideMarkerCount: output.split(GUIDE_MARKER).length - 1,
    skillInvocation,
    hookInvocation,
    sessionPersistence: "disabled-by---ephemeral",
    exitCode: result.exitCode,
    diagnostic: result.stderr.trim().slice(-1000) || null,
  };
}

function executeClaude(fixture, evidencePath) {
  const result = command(
    "claude",
    [
      "-p",
      "--no-session-persistence",
      "--setting-sources",
      "project",
      "--permission-mode",
      "plan",
      "--tools",
      "",
      "--output-format",
      "json",
      "--max-budget-usd",
      "0.05",
      "Follow the repository guide and invoke /harness-probe. Return only the two marker tokens they define.",
    ],
    {
      cwd: fixture,
      env: { ...process.env, TWEAKLOOP_HOOK_EVIDENCE_PATH: evidencePath },
    },
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const guideNativeLoad = output.includes(GUIDE_MARKER);
  const skillInvocation = output.includes(SKILL_MARKER);
  const hookInvocation = hookRecord(evidencePath);
  return {
    status:
      result.exitCode === 0 && guideNativeLoad && skillInvocation && hookInvocation
        ? "PASS"
        : "PARTIAL",
    guideNativeLoad,
    skillInvocation,
    hookInvocation,
    sessionPersistence: "disabled-by---no-session-persistence",
    exitCode: result.exitCode,
    diagnostic: result.exitCode === 0 ? null : output.trim().slice(-1500),
  };
}

function probe(options) {
  const version = command(options.client === "claude-code" ? "claude" : options.client, [
    "--version",
  ]);
  if (version.exitCode !== 0) {
    return { client: options.client, status: "PARTIAL", reason: "installed CLI unavailable" };
  }
  const fixture = createFixture(options.client);
  const evidencePath = join(fixture, "hook-evidence.jsonl");
  try {
    if (options.mode === "execute") bindProbeEvidence(fixture, options.client, evidencePath);
    if (options.client === "codex" && options.mode === "discovery") {
      return {
        client: options.client,
        installedVersion: version.stdout.trim(),
        mode: options.mode,
        isolatedTemporaryProject: true,
        ...codexDiscovery(fixture),
      };
    }
    if (options.client === "codex") {
      return {
        client: options.client,
        installedVersion: version.stdout.trim(),
        mode: options.mode,
        isolatedTemporaryProject: true,
        ...executeCodex(fixture, evidencePath),
      };
    }
    if (options.client === "claude-code" && options.mode === "execute") {
      return {
        client: options.client,
        installedVersion: version.stdout.trim(),
        mode: options.mode,
        isolatedTemporaryProject: true,
        ...executeClaude(fixture, evidencePath),
      };
    }
    return {
      client: options.client,
      installedVersion: version.stdout.trim(),
      mode: options.mode,
      isolatedTemporaryProject: true,
      status: "PARTIAL",
      reason:
        options.client === "cursor"
          ? "installed Cursor CLI exposes no no-session-persistence mode; execution skipped to avoid global chat or trust mutation"
          : "installed Claude CLI exposes no local prompt-input renderer; use --mode execute for a no-session-persistence probe",
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

try {
  process.stdout.write(
    `${JSON.stringify(probe(parseArguments(process.argv.slice(2))), null, 2)}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
