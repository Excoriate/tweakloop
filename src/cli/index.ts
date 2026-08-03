#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { Command } from "commander";
import { startDaemon } from "../daemon/index.js";
import { rebuildProjections } from "../daemon/projections.js";
import { ensureProjectConfig, stateDirFor, workspaceIdFor } from "../daemon/runtime.js";
import type { ActorRef, CommandEnvelope } from "../protocol/envelopes.js";
import { CLI_PROTOCOL, COMMAND_PROTOCOL } from "../protocol/versions.js";
import { openDatabase } from "../storage/sqlite/db.js";
import {
  discoverDaemon,
  ensureDaemon,
  getSnapshot,
  listEvents,
  mintBootstrapUrl,
  postCommand,
  releaseStartupLock,
  requestShutdown,
  tryAcquireStartupLock,
} from "./daemon-client.js";
import { emitJson, fail, info } from "./output.js";

const program = new Command("tweak");
program
  .description("Tweakloop — durable human–agent artifact iteration")
  .version("0.1.0")
  .option("--workspace <path>", "workspace root", process.cwd())
  .option("--json", "machine-readable output", false);

type GlobalOpts = { workspace: string; json: boolean };

function globals(): GlobalOpts {
  return program.opts<GlobalOpts>();
}

function rootPath(): string {
  return resolve(globals().workspace);
}

function humanActor(): ActorRef {
  return { kind: "human", id: process.env.USER ?? "human" };
}

function envelope(
  workspaceId: string,
  type: string,
  idempotencyKey: string,
  payload: unknown,
): CommandEnvelope {
  return {
    protocol: COMMAND_PROTOCOL,
    commandId: randomUUID(),
    idempotencyKey,
    workspaceId,
    actor: humanActor(),
    type,
    payload,
  };
}

program
  .command("init")
  .description("initialize project identity (.tweakloop/project.json)")
  .action(() => {
    const project = ensureProjectConfig(rootPath());
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, projectId: project.projectId });
    } else {
      info(`project initialized: ${project.projectId}`);
    }
  });

program
  .command("open <path>")
  .description("register an artifact and open the review shell")
  .option("--no-browser", "print the bootstrap URL instead of launching a browser")
  .action(async (path: string, opts: { browser: boolean }) => {
    const root = rootPath();
    ensureProjectConfig(root);
    const connection = await ensureDaemon(root);
    const sourcePath = resolve(path);
    const format = extname(sourcePath).toLowerCase() === ".md" ? "markdown" : "html";
    const result = await postCommand(
      connection,
      envelope(
        connection.descriptor.workspaceId,
        "artifact.register",
        `artifact.register:${sourcePath}`,
        {
          artifactId: `artifact_${randomUUID()}`,
          name: basename(sourcePath),
          format,
          sourcePath,
        },
      ),
    );

    let artifactId: string;
    if (result.status === "accepted") {
      artifactId = (result.response as { artifactId: string }).artifactId;
    } else if (result.code === "artifact.source-already-registered") {
      artifactId = (result.details as { artifactId: string }).artifactId;
      info(`already registered as ${artifactId}`);
    } else {
      fail(`${result.code}: ${result.message}`);
    }

    const url = await mintBootstrapUrl(connection);
    if (opts.browser) {
      const opener =
        process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
      if (opener) {
        spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
      }
      info(`review shell: ${url}`);
    } else {
      info(`open this URL to review: ${url}`);
    }
    if (globals().json) {
      emitJson({
        protocol: CLI_PROTOCOL,
        workspaceId: connection.descriptor.workspaceId,
        artifactId,
        url,
      });
    }
  });

program
  .command("status")
  .description("report daemon health and workspace projections")
  .action(async () => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) {
      if (globals().json) {
        emitJson({ protocol: CLI_PROTOCOL, daemon: "stopped" });
      } else {
        info("daemon: stopped (start one with `tweak open <path>` or `tweak daemon start`)");
      }
      return;
    }
    const snapshot = await getSnapshot(connection);
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, daemon: "running", snapshot });
    } else {
      info(`daemon: running (pid ${connection.descriptor.pid})`);
      info(`workspace: ${snapshot.workspace.workspaceId}`);
      info(`project: ${snapshot.workspace.projectId}`);
      info(`artifacts: ${snapshot.artifacts.length}`);
      info(`events: ${snapshot.lastSeq}`);
    }
  });

const artifacts = program.command("artifacts").description("inspect registered artifacts");

artifacts
  .command("list")
  .description("list artifact identities")
  .action(async () => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const snapshot = await getSnapshot(connection);
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, artifacts: snapshot.artifacts });
    } else {
      for (const artifact of snapshot.artifacts) {
        info(`${artifact.artifactId}  ${artifact.format}  ${artifact.name}`);
      }
      if (snapshot.artifacts.length === 0) info("no artifacts registered");
    }
  });

const daemon = program.command("daemon").description("manage the workspace daemon");

daemon
  .command("start")
  .description("start the daemon for this workspace")
  .option("--foreground", "run in the foreground (logs to stderr)", false)
  .action(async (opts: { foreground: boolean }) => {
    const root = rootPath();
    if (opts.foreground) {
      const handle = await startDaemon({
        rootPath: root,
        onExit: () => process.exit(0),
        log: (line) => console.error(line),
      });
      info(`daemon running: shell http://127.0.0.1:${handle.shellPort} (ctrl-c to stop)`);
      process.on("SIGINT", () => {
        handle.close();
        process.exit(0);
      });
      await new Promise(() => {});
      return;
    }
    const connection = await ensureDaemon(root);
    if (globals().json) {
      emitJson({
        protocol: CLI_PROTOCOL,
        daemon: "running",
        workspaceId: connection.descriptor.workspaceId,
        shellPort: connection.descriptor.shellPort,
        artifactPort: connection.descriptor.artifactPort,
        pid: connection.descriptor.pid,
      });
    } else {
      info(`daemon running (pid ${connection.descriptor.pid})`);
    }
  });

daemon
  .command("stop")
  .description("stop this workspace's daemon")
  .action(async () => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) {
      info("daemon is not running");
      return;
    }
    await requestShutdown(connection);
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, daemon: "stopped" });
    } else {
      info("daemon stopped");
    }
  });

program
  .command("repair")
  .description("workspace maintenance (daemon must be stopped)")
  .option("--rebuild-projections", "rebuild all p_* projection tables from the event log", false)
  .action(async (opts: { rebuildProjections: boolean }) => {
    if (!opts.rebuildProjections) fail("nothing to do — pass --rebuild-projections");
    const root = rootPath();
    // Sanctioned single-writer exception: repair holds the startup lock so
    // no daemon can spawn while this process owns the write connection.
    const lock = tryAcquireStartupLock(root);
    if (!lock) fail("another process is starting the daemon — retry in a moment");
    try {
      if (await discoverDaemon(root)) {
        fail("the daemon owns the event log while running — stop it first (`tweak daemon stop`)");
      }
      const workspaceId = workspaceIdFor(root);
      const dbPath = join(stateDirFor(workspaceId), "events.sqlite");
      if (!existsSync(dbPath)) fail("this workspace has no event log yet");
      const db = openDatabase(dbPath);
      try {
        rebuildProjections(db, workspaceId);
      } finally {
        db.close();
      }
    } finally {
      releaseStartupLock(lock);
    }
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, repaired: ["projections"] });
    } else {
      info("projections rebuilt from the event log");
    }
  });

const events = program.command("events").description("inspect the durable event log");

events
  .command("list")
  .description("print committed events after a sequence number")
  .option("--after <seq>", "sequence number", "0")
  .action(async (opts: { after: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const list = await listEvents(connection, Number(opts.after));
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, events: list });
    } else {
      for (const event of list) {
        info(`${event.seq}  ${event.recordedAt}  ${event.eventType}  ${event.streamId}`);
      }
      if (list.length === 0) info("no events");
    }
  });

try {
  await program.parseAsync(process.argv);
} catch (err) {
  fail((err as Error).message);
}
