import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "../protocol/envelopes.js";
import type { Db } from "../storage/sqlite/db.js";
import { readEvents } from "../storage/sqlite/event-store.js";
import { type EventHub, writeSse } from "./event-stream.js";
import { snapshot } from "./projections.js";
import type { Transactor } from "./transactor.js";

export type AuthState = Readonly<{
  cliToken: string;
  sessions: Set<string>;
  bootstrapTokens: Set<string>;
}>;

export type WorkspaceInfo = Readonly<{
  workspaceId: string;
  projectId: string;
  rootPath: string;
  protocolVersion: number;
  startNonce: string;
}>;

export type HttpDeps = Readonly<{
  db: Db;
  workspace: WorkspaceInfo;
  transactor: Transactor;
  hub: EventHub;
  auth: AuthState;
  onShutdown: () => void;
  log: (line: string) => void;
}>;

export type HttpLayer = Readonly<{
  listen: () => Promise<{ shellPort: number; artifactPort: number }>;
  close: () => void;
}>;

const SESSION_COOKIE = "tweakloop_shell";
const BODY_LIMIT = 1_000_000;
const REPLAY_PAGE = 1000;

const webRoot = fileURLToPath(new URL("../../web/shell/", import.meta.url));

const staticFiles: Readonly<Record<string, { file: string; type: string }>> = {
  "/app": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app/shell.js": { file: "shell.js", type: "text/javascript; charset=utf-8" },
  "/app/shell.css": { file: "shell.css", type: "text/css; charset=utf-8" },
};

/**
 * Two loopback listeners in one process: the trusted shell origin
 * (UI, API, event stream) and the isolated artifact origin (immutable
 * revisions only — no mutation routes, no shell credentials).
 */
export function createHttpLayer(deps: HttpDeps): HttpLayer {
  const ports = { shellPort: 0, artifactPort: 0 };

  const shellServer = createServer((req, res) => {
    try {
      handleShell(req, res);
    } catch (err) {
      deps.log(JSON.stringify({ level: "error", message: (err as Error).message }));
      sendJson(res, 500, { error: "internal error" });
    }
  });

  const artifactServer = createServer((req, res) => {
    const url = requestUrl(req);
    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true, role: "artifact", startNonce: deps.workspace.startNonce });
      return;
    }
    // /r/:revisionId/* arrives with immutable revision serving (Phase 1).
    sendJson(res, 404, { error: "not found" });
  });

  function handleShell(req: IncomingMessage, res: ServerResponse): void {
    if (!validHost(req, ports.shellPort)) {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }
    const url = requestUrl(req);
    const route = `${req.method} ${url.pathname}`;

    if (route === "GET /health") {
      sendJson(res, 200, {
        ok: true,
        role: "shell",
        workspaceId: deps.workspace.workspaceId,
        pid: process.pid,
        startNonce: deps.workspace.startNonce,
        protocolVersion: deps.workspace.protocolVersion,
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/bootstrap/")) {
      handleBootstrap(url.pathname.slice("/bootstrap/".length), res);
      return;
    }

    const authKind = authenticate(req, deps.auth);

    if (req.method === "GET") {
      const entry = staticFiles[url.pathname];
      if (entry) {
        if (authKind === null) {
          res.writeHead(401, { "content-type": "text/html; charset=utf-8" });
          res.end(
            '<!doctype html><body style="font-family:system-ui;margin:4rem"><h1>tweakloop</h1><p>This shell requires a bootstrap link. Run <code>tweak open &lt;artifact&gt;</code> to open it.</p></body>',
          );
          return;
        }
        res.writeHead(200, { "content-type": entry.type });
        res.end(readFileSync(join(webRoot, entry.file)));
        return;
      }
    }

    if (!url.pathname.startsWith("/api/")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (authKind === null) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (req.method === "POST" && authKind === "browser" && !validBrowserOrigin(req)) {
      sendJson(res, 403, { error: "origin rejected" });
      return;
    }

    switch (route) {
      case "POST /api/v1/commands": {
        void readBody(req)
          .then((body) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(body);
            } catch {
              sendJson(res, 400, { error: "body must be JSON" });
              return;
            }
            const result = deps.transactor.execute(parsed);
            const status =
              result.status === "accepted" ? 200 : result.code.startsWith("protocol.") ? 400 : 409;
            sendJson(res, status, result);
          })
          .catch((err: Error) => {
            sendJson(res, err.message === "body too large" ? 413 : 400, { error: err.message });
          });
        return;
      }
      case "POST /api/v1/bootstrap-tokens": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        const token = randomBytes(32).toString("hex");
        deps.auth.bootstrapTokens.add(token);
        sendJson(res, 201, { url: `http://127.0.0.1:${ports.shellPort}/bootstrap/${token}` });
        return;
      }
      case "POST /api/v1/shutdown": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        sendJson(res, 200, { stopping: true });
        setImmediate(() => deps.onShutdown());
        return;
      }
      case "GET /api/v1/snapshot": {
        sendJson(res, 200, snapshot(deps.db, deps.workspace));
        return;
      }
      case "GET /api/v1/events": {
        const after = Number(url.searchParams.get("after") ?? 0);
        if (!Number.isInteger(after) || after < 0) {
          sendJson(res, 400, { error: "after must be a non-negative integer" });
          return;
        }
        const accept = req.headers.accept ?? "";
        if (!accept.includes("text/event-stream")) {
          const all: EventEnvelope[] = [];
          replayEvents(deps.db, deps.workspace.workspaceId, after, (e) => all.push(e));
          sendJson(res, 200, all);
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        replayEvents(deps.db, deps.workspace.workspaceId, after, (e) => writeSse(res, e));
        const unsubscribe = deps.hub.subscribe(res);
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": ping\n\n");
        }, 30_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
        return;
      }
      default:
        sendJson(res, 404, { error: "not found" });
    }
  }

  function handleBootstrap(token: string, res: ServerResponse): void {
    if (!deps.auth.bootstrapTokens.delete(token)) {
      sendJson(res, 403, { error: "invalid or expired bootstrap token" });
      return;
    }
    const session = randomBytes(32).toString("hex");
    deps.auth.sessions.add(session);
    res.writeHead(303, {
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      location: "/app",
    });
    res.end();
  }

  return {
    listen: async () => {
      ports.shellPort = await listenOn(shellServer);
      ports.artifactPort = await listenOn(artifactServer);
      return { ...ports };
    },
    close: () => {
      shellServer.closeAllConnections();
      artifactServer.closeAllConnections();
      shellServer.close();
      artifactServer.close();
    },
  };
}

/** Page through the log so a long history is never silently truncated. */
function replayEvents(
  db: Db,
  workspaceId: string,
  after: number,
  emit: (envelope: EventEnvelope) => void,
): void {
  let cursor = after;
  for (;;) {
    const page = readEvents(db, workspaceId, cursor, REPLAY_PAGE);
    for (const envelope of page) emit(envelope);
    const last = page[page.length - 1];
    if (page.length < REPLAY_PAGE || last === undefined) return;
    cursor = last.seq;
  }
}

function listenOn(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("unexpected server address"));
        return;
      }
      resolve(address.port);
    });
  });
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

function validHost(req: IncomingMessage, shellPort: number): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const allowed = new Set([
    `127.0.0.1:${shellPort}`,
    `localhost:${shellPort}`,
    `[::1]:${shellPort}`,
  ]);
  return allowed.has(host);
}

/** Same-origin request check for cookie-authenticated mutations. */
function validBrowserOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  return origin !== undefined && origin === `http://${req.headers.host}`;
}

function tokenEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function authenticate(req: IncomingMessage, auth: AuthState): "cli" | "browser" | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ") && tokenEqual(header.slice(7), auth.cliToken)) return "cli";
  const cookies = req.headers.cookie ?? "";
  for (const part of cookies.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SESSION_COOKIE && value && auth.sessions.has(value)) return "browser";
  }
  return null;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}
