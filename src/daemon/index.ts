import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMAND_PROTOCOL, PROTOCOL_VERSION } from "../protocol/versions.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { createEventHub } from "./event-stream.js";
import { type AuthState, createHttpLayer } from "./http.js";
import {
  discoverHealthyRuntime,
  ensureProjectConfig,
  removeRuntime,
  stateDirFor,
  workspaceIdFor,
  writeRuntime,
} from "./runtime.js";
import { createTransactor } from "./transactor.js";

export type DaemonOptions = Readonly<{
  rootPath: string;
  /** Called after a shutdown request has been fully processed. */
  onExit?: () => void;
  log?: (line: string) => void;
}>;

export type DaemonHandle = Readonly<{
  workspaceId: string;
  projectId: string;
  rootPath: string;
  shellPort: number;
  artifactPort: number;
  cliToken: string;
  close: () => void;
}>;

export async function startDaemon(options: DaemonOptions): Promise<DaemonHandle> {
  const rootPath = resolve(options.rootPath);
  const workspaceId = workspaceIdFor(rootPath);

  const running = await discoverHealthyRuntime(workspaceId);
  if (running) {
    throw new Error(
      `a daemon for this workspace is already running (pid ${running.pid}, shell port ${running.shellPort})`,
    );
  }

  const stateDir = stateDirFor(workspaceId);
  mkdirSync(stateDir, { recursive: true });

  const logPath = join(stateDir, "daemon.log");
  const log =
    options.log ??
    ((line: string) => {
      appendFileSync(logPath, `${line}\n`);
    });

  const project = ensureProjectConfig(rootPath);
  const db = openDatabase(join(stateDir, "events.sqlite"));
  const hub = createEventHub();
  const transactor = createTransactor({
    db,
    workspaceId,
    newEventId: () => `evt_${randomUUID()}`,
    now: () => new Date().toISOString(),
    onCommitted: (envelopes) => hub.publish(envelopes),
  });

  const opened = transactor.execute({
    protocol: COMMAND_PROTOCOL,
    commandId: randomUUID(),
    idempotencyKey: `workspace.open:${workspaceId}`,
    workspaceId,
    actor: { kind: "system", id: "daemon" },
    type: "workspace.open",
    payload: { projectId: project.projectId, rootPath },
  });
  if (opened.status === "rejected") {
    db.close();
    throw new Error(`workspace.open rejected: ${opened.code} ${opened.message}`);
  }

  const startNonce = randomBytes(16).toString("hex");
  const cliToken = randomBytes(32).toString("hex");
  const auth: AuthState = { cliToken, sessions: new Set(), bootstrapTokens: new Set() };

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    removeRuntime(workspaceId);
    httpLayer.close();
    db.close();
    log(JSON.stringify({ ts: new Date().toISOString(), message: "daemon stopped" }));
  };

  const httpLayer = createHttpLayer({
    db,
    workspace: {
      workspaceId,
      projectId: project.projectId,
      rootPath,
      protocolVersion: PROTOCOL_VERSION,
      startNonce,
    },
    transactor,
    hub,
    auth,
    onShutdown: () => {
      close();
      options.onExit?.();
    },
    log,
  });

  const ports = await httpLayer.listen();
  writeRuntime({
    pid: process.pid,
    startNonce,
    shellPort: ports.shellPort,
    artifactPort: ports.artifactPort,
    protocolVersion: PROTOCOL_VERSION,
    workspaceId,
    cliToken,
  });
  log(
    JSON.stringify({
      ts: new Date().toISOString(),
      message: "daemon started",
      workspaceId,
      ...ports,
    }),
  );

  return {
    workspaceId,
    projectId: project.projectId,
    rootPath,
    shellPort: ports.shellPort,
    artifactPort: ports.artifactPort,
    cliToken,
    close,
  };
}
