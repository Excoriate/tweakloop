import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatForPath,
  IngestBytesError,
  ingestBytes,
  SESSION_ARTIFACT_MAX_BYTES,
} from "../artifacts/ingest.js";
import { renderMarkdown } from "../artifacts/markdown.js";
import { extractSemanticIndex } from "../artifacts/semantic.js";
import { type GuardIntent, guardSemanticPublish } from "../artifacts/semantic-guard.js";
import { CHAT_ATTACHMENT_MAX_BYTES, type ChatAttachment } from "../protocol/chat.js";
import type { ActorRef, CommandResult, EventEnvelope } from "../protocol/envelopes.js";
import {
  NativeHookProtocolError,
  parseNativeHookBindRequest,
  parseNativeHookObserveRequest,
} from "../protocol/native-hook-observation.js";
import { validateCommand } from "../protocol/validation.js";
import { AGENT_SESSION_PROTOCOL, COMMAND_PROTOCOL } from "../protocol/versions.js";
import {
  repairAtomicObjectBatches,
  stageAtomicObjectBatch,
} from "../storage/object-store/atomic-batch.js";
import { putObject, readObject } from "../storage/object-store/index.js";
import type { Db } from "../storage/sqlite/db.js";
import { getReceipt, readEvents } from "../storage/sqlite/event-store.js";
import {
  NativeHookObservationError,
  NativeHookObservationStore,
} from "../storage/sqlite/native-hook-observation.js";
import {
  RuntimeAuthorityError,
  WHITEBOARD_AUTOMATION_METHOD,
  WHITEBOARD_AUTOMATION_OPERATION_ID,
  WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
} from "../storage/sqlite/runtime-authority.js";
import type { DraftInvalidation } from "../whiteboard/draft-hub.js";
import { WhiteboardError } from "../whiteboard/errors.js";
import {
  canonicalizeWhiteboardScene,
  WHITEBOARD_INDEX_MEDIA_TYPE,
  WHITEBOARD_SCENE_MAX_BYTES,
  WHITEBOARD_SCENE_MEDIA_TYPE,
} from "../whiteboard/scene.js";
import type { SemanticSceneRequest } from "../whiteboard/semantic-scene.js";
import { createWhiteboardService } from "../whiteboard/service.js";
import { WorkspaceFilesError } from "../workspace/files.js";
import {
  type CompletedWorkspaceRestore,
  createWorkspaceRestoreStore,
  WorkspaceRestoreError,
} from "../workspace/restore.js";
import {
  WorkspaceRestoreJournalError,
  type WorkspaceRestoreOperationKind,
} from "../workspace/restore-journal.js";
import { type EventHub, writeSse } from "./event-stream.js";
import { createInboundService, InboundError } from "./inbound-next.js";
import {
  artifactIdForSource,
  listSessions,
  questionSnapshot,
  revisionById,
  sessionArtifactsFor,
  sessionById,
  sessionExists,
  sessionHasArtifact,
  snapshot,
} from "./projections.js";
import { type RestoreGenerationIdentity, stateDirFor } from "./runtime.js";
import {
  type CommandTransportPrincipal,
  resolveCommandReceipt,
  type Transactor,
  validateCommandTransportPrincipal,
} from "./transactor.js";

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
  restoreGeneration?: RestoreGenerationIdentity | null;
}>;

export type HttpDeps = Readonly<{
  db: Db;
  objectsDir: string;
  workspace: WorkspaceInfo;
  transactor: Transactor;
  hub: EventHub;
  auth: AuthState;
  onShutdown: () => void;
  log: (line: string) => void;
  commitWorkspaceRestore: (
    completed: CompletedWorkspaceRestore,
    agentId: string,
    options: Readonly<{
      destinationRoot?: string;
      sessionId?: string;
      bundleRoot: string;
      operationKind?: WorkspaceRestoreOperationKind;
      operationId?: string;
    }>,
  ) => Promise<Readonly<Record<string, unknown>>>;
  workspaceRestoreInventory: () => Readonly<Record<string, unknown>>;
  compactWorkspaceRestore: (
    input: Readonly<{
      operationKind: WorkspaceRestoreOperationKind;
      operationId: string;
      bundleRoot?: string;
    }>,
  ) => Readonly<Record<string, unknown>>;
}>;

export type HttpLayer = Readonly<{
  listen: () => Promise<{ shellPort: number; artifactPort: number }>;
  close: () => void;
}>;

const SESSION_COOKIE = "tweakloop_shell";
const BODY_LIMIT = 1_000_000;
const REPLAY_PAGE = 1000;
const DEFAULT_LEASE_TTL_MS = 30_000;

type BootstrapContext = Readonly<{
  artifactId: string | null;
  agentId: string | null;
  sessionId: string | null;
}>;

const shellRoot = fileURLToPath(new URL("../../web/shell/", import.meta.url));
const bridgeRoot = fileURLToPath(new URL("../../web/bridge/", import.meta.url));
const artifactRuntimeRoot = fileURLToPath(new URL("../../web/artifact/", import.meta.url));
const whiteboardAssetsRoot = join(artifactRuntimeRoot, "assets");

const staticFiles: Readonly<Record<string, { file: string; type: string }>> = {
  "/app": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app/shell.js": { file: "shell.js", type: "text/javascript; charset=utf-8" },
  "/app/shell.css": { file: "shell.css", type: "text/css; charset=utf-8" },
  "/app/fonts/Assistant-Regular.woff2": {
    file: "../artifact/assets/fonts/Assistant/Assistant-Regular.woff2",
    type: "font/woff2",
  },
  "/app/fonts/Assistant-Medium.woff2": {
    file: "../artifact/assets/fonts/Assistant/Assistant-Medium.woff2",
    type: "font/woff2",
  },
  "/app/fonts/Assistant-SemiBold.woff2": {
    file: "../artifact/assets/fonts/Assistant/Assistant-SemiBold.woff2",
    type: "font/woff2",
  },
  "/app/fonts/CascadiaCode-Regular.woff2": {
    file: "../artifact/assets/fonts/Cascadia/CascadiaCode-Regular.woff2",
    type: "font/woff2",
  },
};

/**
 * Two loopback listeners in one process: the trusted shell origin
 * (UI, API, event stream) and the isolated artifact origin (immutable
 * revisions and the bridge only — no mutation routes, no shell
 * credentials).
 */
export function createHttpLayer(deps: HttpDeps): HttpLayer {
  repairAtomicObjectBatches(deps.objectsDir, deps.db);
  const ports = { shellPort: 0, artifactPort: 0 };
  /**
   * Ephemeral agent presence (docs/architecture/03: working state, not
   * historical truth). "listening" is derived from live SSE
   * subscriptions; "thinking"/"working" are explicit agent signals with
   * a TTL. Never persisted, never an event.
   */
  const activityPresence = new Map<string, { state: string; until: number }>();
  type ListenerPresenceState = "listening" | "thinking" | "working";
  const listenerCounts = new Map<string, Map<ListenerPresenceState, number>>();
  const bootstrapContexts = new Map<string, BootstrapContext>();
  const sessionContexts = new Map<string, BootstrapContext>();
  const workspaceRestores = createWorkspaceRestoreStore(
    join(stateDirFor(deps.workspace.workspaceId), "restore-staging"),
  );
  const whiteboards = createWhiteboardService({
    db: deps.db,
    objectsDir: deps.objectsDir,
    workspaceId: deps.workspace.workspaceId,
    transactor: deps.transactor,
    daemonStartNonce: deps.workspace.startNonce,
  });
  const inbound = createInboundService({
    db: deps.db,
    workspaceId: deps.workspace.workspaceId,
    transactor: deps.transactor,
    now: () => Date.now(),
    newId: () => randomUUID(),
    newCapability: () => randomBytes(32).toString("hex"),
  });
  const nativeHooks = new NativeHookObservationStore(deps.db, {
    workspaceId: deps.workspace.workspaceId,
    daemonStartNonce: deps.workspace.startNonce,
    now: () => Date.now(),
  });

  function activePresence(): { agentId: string; state: string }[] {
    const now = Date.now();
    const active: { agentId: string; state: string }[] = [];
    const activityAgents = new Set<string>();
    for (const [agentId, entry] of activityPresence) {
      if (entry.until <= now) {
        activityPresence.delete(agentId);
      } else {
        active.push({ agentId, state: entry.state });
        activityAgents.add(agentId);
      }
    }
    for (const [agentId, stateCounts] of listenerCounts) {
      if (activityAgents.has(agentId)) continue;
      const state = (["working", "thinking", "listening"] as const).find(
        (candidate) => (stateCounts.get(candidate) ?? 0) > 0,
      );
      if (state) active.push({ agentId, state });
    }
    return active;
  }

  function addListener(agentId: string, state: ListenerPresenceState): void {
    const stateCounts = listenerCounts.get(agentId) ?? new Map<ListenerPresenceState, number>();
    stateCounts.set(state, (stateCounts.get(state) ?? 0) + 1);
    listenerCounts.set(agentId, stateCounts);
  }

  function removeListener(agentId: string, state: ListenerPresenceState): void {
    const stateCounts = listenerCounts.get(agentId);
    if (!stateCounts) return;
    const remaining = (stateCounts.get(state) ?? 0) - 1;
    if (remaining > 0) {
      stateCounts.set(state, remaining);
    } else {
      stateCounts.delete(state);
    }
    if (stateCounts.size === 0) listenerCounts.delete(agentId);
  }

  function executeGuarded(
    input: unknown,
    transportPrincipal: CommandTransportPrincipal | null = null,
  ): CommandResult {
    if (transportPrincipal !== null) {
      const validated = validateCommand(input);
      if (validated.ok) {
        const principalMismatch = validateCommandTransportPrincipal(
          deps.db,
          validated.envelope,
          transportPrincipal,
        );
        if (principalMismatch !== null) return principalMismatch;
      }
    }
    const guardedResult = semanticCommandResult(input);
    if (guardedResult !== null) return guardedResult;
    return transportPrincipal === null
      ? deps.transactor.execute(input)
      : deps.transactor.executeWithTransportPrincipal(input, transportPrincipal);
  }

  function semanticCommandResult(input: unknown): CommandResult | null {
    const validated = validateCommand(input);
    if (!validated.ok || validated.envelope.workspaceId !== deps.workspace.workspaceId) return null;
    const envelope = validated.envelope;
    if (envelope.type !== "artifact.publish" && envelope.type !== "artifact.create") return null;
    const existing = resolveCommandReceipt(deps.db, deps.workspace.workspaceId, envelope);
    if (existing.kind === "resolved") return existing.result;
    if (envelope.payload === null || typeof envelope.payload !== "object") return null;
    const payload = envelope.payload as Record<string, unknown>;
    const format = payload.format;
    const entryHash = payload.entryHash;
    const artifactId = payload.artifactId;
    if (
      (format !== "html" && format !== "markdown") ||
      typeof entryHash !== "string" ||
      typeof artifactId !== "string"
    ) {
      return null;
    }
    let candidate: Buffer;
    try {
      candidate = readObject(deps.objectsDir, entryHash);
    } catch {
      // The transactor owns the canonical missing/mismatched-object rejection.
      return null;
    }
    const guard = semanticCandidateGuard(
      envelope.type === "artifact.create" ? null : artifactId,
      format,
      candidate,
    );
    if (guard.ok) return null;
    return {
      status: "rejected",
      commandId: envelope.commandId,
      code: guard.code,
      message: guard.message,
      details: guard.details,
    };
  }

  function semanticCandidateGuard(
    artifactId: string | null,
    format: "html" | "markdown" | "whiteboard",
    candidateBytes: Buffer,
  ) {
    if (format === "whiteboard") return { ok: true } as const;
    const candidate = extractSemanticIndex(format, candidateBytes);
    if (artifactId === null) return guardSemanticPublish(null, candidate, []);
    const head = deps.db
      .prepare(
        "SELECT entry_hash, format FROM p_revisions WHERE artifact_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(artifactId) as
      | { entry_hash: string; format: "html" | "markdown" | "whiteboard" }
      | undefined;
    const headIndex =
      head && head.format !== "whiteboard"
        ? extractSemanticIndex(head.format, readObject(deps.objectsDir, head.entry_hash))
        : null;
    return guardSemanticPublish(headIndex, candidate, guardIntents(artifactId));
  }

  function guardIntents(artifactId: string): GuardIntent[] {
    const actorKinds = new Map<string, GuardIntent["actorKind"]>();
    for (const event of readEvents(
      deps.db,
      deps.workspace.workspaceId,
      0,
      Number.MAX_SAFE_INTEGER,
    )) {
      if (event.eventType !== "intent.created") continue;
      const payload = event.payload as { intentId?: unknown };
      if (typeof payload.intentId === "string") actorKinds.set(payload.intentId, event.actor.kind);
    }
    return (
      deps.db
        .prepare(
          "SELECT intent_id, intent_type, target_json, status FROM p_intents WHERE artifact_id = ? AND status = 'submitted'",
        )
        .all(artifactId) as Array<{
        intent_id: string;
        intent_type: string;
        target_json: string;
        status: "submitted";
      }>
    ).map((row) => {
      const target = JSON.parse(row.target_json) as { semanticId?: unknown };
      return {
        intentId: row.intent_id,
        intentType: row.intent_type,
        semanticId: typeof target.semanticId === "string" ? target.semanticId : null,
        status: row.status,
        actorKind: actorKinds.get(row.intent_id) ?? "unknown",
      };
    });
  }

  function sendSemanticGuardRejection(
    res: ServerResponse,
    result: Exclude<ReturnType<typeof semanticCandidateGuard>, { ok: true }>,
  ): void {
    sendJson(res, 409, {
      error: `${result.code}: ${result.message}`,
      code: result.code,
      details: result.details,
    });
  }

  const shellServer = createServer((req, res) => {
    try {
      handleShell(req, res);
    } catch (err) {
      deps.log(JSON.stringify({ level: "error", message: (err as Error).message }));
      sendJson(res, 500, { error: "internal error" });
    }
  });

  const artifactServer = createServer((req, res) => {
    try {
      handleArtifact(req, res);
    } catch (err) {
      deps.log(JSON.stringify({ level: "error", message: (err as Error).message }));
      sendJson(res, 500, { error: "internal error" });
    }
  });

  // -- artifact origin ------------------------------------------------------

  function handleArtifact(req: IncomingMessage, res: ServerResponse): void {
    if (!validHost(req, ports.artifactPort)) {
      sendJson(res, 403, { error: "forbidden host" });
      return;
    }
    const url = requestUrl(req);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, role: "artifact", startNonce: deps.workspace.startNonce });
      return;
    }
    if (req.method === "GET" && url.pathname === "/bridge/v1.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(join(bridgeRoot, "bridge.js")));
      return;
    }
    if (req.method === "GET" && url.pathname === "/whiteboard/v1.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(join(artifactRuntimeRoot, "whiteboard.js")));
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/whiteboard/assets/")) {
      serveWhiteboardAsset(url.pathname.slice("/whiteboard/assets/".length), res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/objects/sha256/")) {
      serveWhiteboardObject(url.pathname.slice("/objects/sha256/".length), res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/r/")) {
      serveRevision(url.pathname.slice("/r/".length), res);
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }

  /** Immutable revision files; the entry document gets the bridge injected. */
  function serveRevision(rest: string, res: ServerResponse): void {
    const slash = rest.indexOf("/");
    const revisionId = slash === -1 ? rest : rest.slice(0, slash);
    const subPath = slash === -1 ? "" : decodeURIComponent(rest.slice(slash + 1));
    const revision = revisionById(deps.db, revisionId);
    if (!revision) {
      sendJson(res, 404, { error: "unknown revision" });
      return;
    }
    const filePath = subPath === "" ? revision.entryPath : subPath;
    const file = revision.files.find((f) => f.path === filePath);
    if (!file) {
      sendJson(res, 404, { error: "file not part of this revision" });
      return;
    }
    const bytes = readObject(deps.objectsDir, file.hash);
    if (filePath !== revision.entryPath) {
      res.writeHead(200, {
        "content-type": file.mediaType,
        "cache-control": "public, max-age=31536000, immutable",
      });
      res.end(bytes);
      return;
    }
    let html: string;
    if (revision.format === "whiteboard") {
      try {
        const canonical = canonicalizeWhiteboardScene(bytes);
        html = whiteboardHostHtml(
          canonical.bytes,
          revision.artifactId,
          revision.revisionId,
          revision.entryPath,
        );
      } catch (error) {
        const detail =
          error instanceof WhiteboardError
            ? error.message
            : "whiteboard scene could not be validated";
        res.writeHead(422, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(
          injectBridge(whiteboardErrorHtml(detail), revision.revisionId, revision.artifactId),
        );
        return;
      }
    } else {
      html =
        revision.format === "markdown"
          ? renderMarkdown(bytes.toString("utf8"), revision.entryPath)
          : bytes.toString("utf8");
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(injectBridge(html, revision.revisionId, revision.artifactId));
  }

  function serveWhiteboardAsset(rest: string, res: ServerResponse): void {
    let relative: string;
    try {
      relative = decodeURIComponent(rest);
    } catch {
      sendJson(res, 400, { error: "invalid asset path" });
      return;
    }
    if (relative === "" || relative.includes("\0") || relative.split("/").includes("..")) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const file = resolve(whiteboardAssetsRoot, relative);
    const rootPrefix = `${resolve(whiteboardAssetsRoot)}${sep}`;
    if (!file.startsWith(rootPrefix) || !existsSync(file) || !statSync(file).isFile()) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    res.writeHead(200, {
      "content-type": whiteboardAssetMediaType(file),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    });
    res.end(readFileSync(file));
  }

  function serveWhiteboardObject(hash: string, res: ServerResponse): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    const row = deps.db.prepare("SELECT media_type FROM blobs WHERE hash = ?").get(hash) as
      | { media_type: string }
      | undefined;
    const allowed = new Set([WHITEBOARD_SCENE_MEDIA_TYPE, WHITEBOARD_INDEX_MEDIA_TYPE]);
    if (!row || !allowed.has(row.media_type)) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    try {
      const bytes = readObject(deps.objectsDir, hash);
      res.writeHead(200, {
        "content-type": row.media_type,
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(bytes);
    } catch {
      sendJson(res, 404, { error: "not found" });
    }
  }

  function injectBridge(html: string, revisionId: string, artifactId: string): string {
    const config = {
      shellOrigin: `http://127.0.0.1:${ports.shellPort}`,
      revisionId,
      artifactId,
    };
    let snippet = `<script>window.__TWEAKLOOP__=${JSON.stringify(config)}</script>\n<script src="/bridge/v1.js"></script>`;
    if (html.includes("data-tweakloop-whiteboard")) {
      snippet += `\n<script type="module" src="/whiteboard/v1.js"></script>`;
    }
    return html.includes("</body>")
      ? html.replace("</body>", `${snippet}\n</body>`)
      : `${html}\n${snippet}`;
  }

  // -- shell origin ---------------------------------------------------------

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
        restoreGeneration: deps.workspace.restoreGeneration ?? null,
        protocolVersion: deps.workspace.protocolVersion,
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/bootstrap/")) {
      handleBootstrap(url.pathname.slice("/bootstrap/".length), res);
      return;
    }

    const authKind = authenticate(req, deps.auth);
    const automationSceneMatch = url.pathname.match(
      /^\/api\/v1\/whiteboards\/([^/]+)\/scene-commands$/,
    );
    const untrustedAutomationToken = bearerToken(req);
    if (
      authKind === null &&
      req.method === WHITEBOARD_AUTOMATION_METHOD &&
      automationSceneMatch?.[1] &&
      untrustedAutomationToken !== null
    ) {
      void handleWhiteboardSceneCommands(
        req,
        res,
        decodeURIComponent(automationSceneMatch[1]),
        untrustedAutomationToken,
      );
      return;
    }

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
        res.end(readFileSync(join(shellRoot, entry.file)));
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
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "") &&
      authKind === "browser" &&
      !validBrowserOrigin(req)
    ) {
      sendJson(res, 403, { error: "origin rejected" });
      return;
    }

    if (handleWhiteboardApi(req, res, url, authKind)) return;

    if (route === "GET /api/v1/workspace-restores/inventory") {
      if (authKind !== "cli") {
        sendJson(res, 403, { error: "cli token required" });
        return;
      }
      try {
        sendJson(res, 200, deps.workspaceRestoreInventory());
      } catch (error) {
        sendWorkspaceRestoreError(res, error);
      }
      return;
    }

    if (route === "POST /api/v1/workspace-restores/compact") {
      if (authKind !== "cli") {
        sendJson(res, 403, { error: "cli token required" });
        return;
      }
      void readBody(req)
        .then((body) => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          const operationId = optionalString(parsed.operationId);
          const bundleRoot = optionalString(parsed.bundleRoot);
          const operationKind = parsed.operationKind;
          if (!operationId || (operationKind !== "restore" && operationKind !== "fork")) {
            throw new WorkspaceRestoreJournalError(
              "workspace-restore.compaction-request-invalid",
              "operationKind and operationId are required",
              400,
            );
          }
          sendJson(
            res,
            200,
            deps.compactWorkspaceRestore({
              operationKind,
              operationId,
              ...(bundleRoot ? { bundleRoot } : {}),
            }),
          );
        })
        .catch((error: unknown) => sendWorkspaceRestoreError(res, error));
      return;
    }

    if (route === "POST /api/v1/chat/attachments") {
      void handleChatAttachmentUpload(req, res);
      return;
    }

    if (route === "POST /api/v1/session-artifacts") {
      void handleSessionArtifactImport(req, res, authKind);
      return;
    }

    if (route === "POST /api/v1/session-whiteboards") {
      void readBody(req)
        .then((body) => handleSessionWhiteboardCreate(req, body, res, authKind))
        .catch((error: Error) => sendOnboardingError(res, error));
      return;
    }

    if (route === "POST /api/v1/sessions/open-artifact") {
      if (authKind !== "cli") {
        sendJson(res, 403, { error: "cli token required" });
        return;
      }
      void readBody(req)
        .then((body) => handleExistingSessionOpen(body, res))
        .catch((error: Error) => sendJson(res, 400, { error: error.message }));
      return;
    }

    if (route === "POST /api/v1/sessions/attach-artifact") {
      if (authKind !== "cli") {
        sendJson(res, 403, { error: "cli token required" });
        return;
      }
      void readBody(req)
        .then((body) => handleExplicitSessionAttach(body, res))
        .catch((error: Error) => sendJson(res, 400, { error: error.message }));
      return;
    }

    if (route === "POST /api/v1/workspace-restores") {
      void readAttachmentBody(req, 64 * 1024 * 1024)
        .then((bytes) => {
          const plan = workspaceRestores.begin(JSON.parse(bytes.toString("utf8")));
          sendJson(res, 201, {
            protocol: "tweakloop.workspace-restore/v1",
            bundleId: plan.bundleId,
            restoreId: plan.restoreId,
            bundleMode: plan.bundleMode,
            manifestHash: plan.manifestHash,
            requiredPaths: workspaceRestores.requiredPaths(plan.bundleId),
          });
        })
        .catch((error: unknown) => sendWorkspaceRestoreError(res, error));
      return;
    }

    const restoreFileMatch = url.pathname.match(/^\/api\/v1\/workspace-restores\/([^/]+)\/files$/);
    if (req.method === "PUT" && restoreFileMatch?.[1]) {
      const portablePath = url.searchParams.get("path");
      if (!portablePath) {
        sendWorkspaceRestoreError(
          res,
          new WorkspaceRestoreError(
            "workspace-restore.path-missing",
            "restore upload requires ?path=",
          ),
        );
        return;
      }
      void readAttachmentBody(req, 256 * 1024 * 1024)
        .then((bytes) => {
          workspaceRestores.put(
            decodeURIComponent(restoreFileMatch[1] as string),
            portablePath,
            bytes,
          );
          sendJson(res, 204, null);
        })
        .catch((error: unknown) => sendWorkspaceRestoreError(res, error));
      return;
    }

    const restoreCommitMatch = url.pathname.match(
      /^\/api\/v1\/workspace-restores\/([^/]+)\/commit$/,
    );
    if (req.method === "POST" && restoreCommitMatch?.[1]) {
      void readBody(req)
        .then(async (body) => {
          const parsed = body === "" ? {} : (JSON.parse(body) as Record<string, unknown>);
          const browserContext =
            authKind === "browser"
              ? sessionContexts.get(browserSessionToken(req) ?? "")
              : undefined;
          const agentId = optionalString(parsed.agentId) ?? browserContext?.agentId ?? "codex";
          const destinationRoot = optionalString(parsed.destinationRoot);
          const sessionId = optionalString(parsed.sessionId);
          const requestedBundleRoot = optionalString(parsed.bundleRoot);
          if (authKind !== "browser" && !requestedBundleRoot) {
            throw new WorkspaceRestoreJournalError(
              "workspace-restore.bundle-root-required",
              "bound restore commit requires the locally validated bundle root",
              400,
            );
          }
          const operationKind = parsed.operationKind;
          if (
            operationKind !== undefined &&
            operationKind !== "restore" &&
            operationKind !== "fork"
          ) {
            throw new WorkspaceRestoreJournalError(
              "workspace-restore.operation-kind-invalid",
              "operationKind must be restore or fork",
              400,
            );
          }
          const operationId = optionalString(parsed.operationId);
          const restoreKey = decodeURIComponent(restoreCommitMatch[1] as string);
          const completed = workspaceRestores.complete(restoreKey);
          const bundleRoot =
            authKind === "browser"
              ? workspaceRestores.boundBundleRoot(restoreKey)
              : (requestedBundleRoot as string);
          const result = await deps.commitWorkspaceRestore(completed, agentId, {
            bundleRoot,
            ...(destinationRoot ? { destinationRoot } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(operationKind ? { operationKind } : {}),
            ...(operationId ? { operationId } : {}),
          });
          sendJson(res, 201, { protocol: "tweakloop.workspace-restore/v1", ...result });
        })
        .catch((error: unknown) => sendWorkspaceRestoreError(res, error));
      return;
    }

    const attachmentMatch = url.pathname.match(/^\/api\/v1\/chat\/attachments\/([^/]+)$/);
    if (req.method === "GET" && attachmentMatch?.[1]) {
      handleChatAttachmentDownload(attachmentMatch[1], url, res);
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
            const principal = commandTransportPrincipal(authKind);
            const authoritative =
              authKind === "browser" ? withBrowserHumanActor(parsed, principal) : parsed;
            if (
              authoritative !== null &&
              typeof authoritative === "object" &&
              (authoritative as { type?: unknown }).type === "whiteboard.publish-draft"
            ) {
              handleWhiteboardPublish(authoritative as Record<string, unknown>, principal, res);
              return;
            }
            const context =
              authKind === "browser"
                ? sessionContexts.get(browserSessionToken(req) ?? "")
                : undefined;
            const contextual = withSessionContext(authoritative, context);
            const result = executeGuarded(contextual, principal);
            sendJson(res, statusFor(result), result);
          })
          .catch((err: Error) => {
            sendJson(res, err.message === "body too large" ? 413 : 400, { error: err.message });
          });
        return;
      }
      case "POST /api/v1/publish": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => handlePublish(body, res))
          .catch((err: Error) => {
            sendJson(res, err.message === "body too large" ? 413 : 400, { error: err.message });
          });
        return;
      }
      case "POST /api/v1/restore": {
        void readBody(req)
          .then((body) => handleRestore(body, authKind, res))
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
        void readBody(req)
          .then((body) => mintSessionUrl(body, res))
          .catch((err: Error) => sendJson(res, 400, { error: err.message }));
        return;
      }
      case "POST /api/v1/automation/whiteboard-tokens": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        if ((req.headers["content-type"] ?? "").split(";")[0] !== "application/json") {
          sendJson(res, 415, { error: "Content-Type application/json required" });
          return;
        }
        void readBody(req)
          .then((body) => handleWhiteboardAutomationMint(body, res))
          .catch((error: unknown) => sendWhiteboardError(res, error));
        return;
      }
      case "POST /api/v1/native-hooks/bind": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        if ((req.headers["content-type"] ?? "").split(";")[0] !== "application/json") {
          sendJson(res, 415, { error: "Content-Type application/json required" });
          return;
        }
        void readBody(req)
          .then((body) => {
            const request = parseNativeHookBindRequest(JSON.parse(body));
            sendJson(res, 200, nativeHooks.bind(request));
          })
          .catch((error: unknown) => sendNativeHookError(res, error));
        return;
      }
      case "POST /api/v1/native-hooks/observe": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        if ((req.headers["content-type"] ?? "").split(";")[0] !== "application/json") {
          sendJson(res, 415, { error: "Content-Type application/json required" });
          return;
        }
        void readBody(req)
          .then((body) => {
            const request = parseNativeHookObserveRequest(JSON.parse(body));
            sendJson(res, 200, nativeHooks.observe(request));
          })
          .catch((error: unknown) => sendNativeHookError(res, error));
        return;
      }
      case "POST /api/v1/sessions/url": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => mintSessionUrl(body, res))
          .catch((err: Error) => sendJson(res, 400, { error: err.message }));
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
      case "GET /api/v1/presence": {
        sendJson(res, 200, { agents: activePresence() });
        return;
      }
      case "GET /api/v1/session-context": {
        const context =
          authKind === "browser" ? sessionContexts.get(browserSessionToken(req) ?? "") : undefined;
        sendJson(res, 200, context ?? { artifactId: null, agentId: null, sessionId: null });
        return;
      }
      case "GET /api/v1/agent-session/snapshot": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        const agentId = url.searchParams.get("agent");
        const processNonce = url.searchParams.get("process");
        if (!agentId || !processNonce) {
          sendJson(res, 400, { error: "agent and process are required" });
          return;
        }
        const sessionId = url.searchParams.get("session");
        const artifactId = url.searchParams.get("artifact");
        if (sessionId !== null && !sessionExists(deps.db, sessionId)) {
          sendJson(res, 404, { error: "unknown session" });
          return;
        }
        const current = snapshot(deps.db, deps.workspace, `http://127.0.0.1:${ports.artifactPort}`);
        sendJson(res, 200, {
          protocol: AGENT_SESSION_PROTOCOL,
          kind: "snapshot",
          appliedSeq: current.lastSeq,
          agentId,
          processNonce,
          sessionId,
          artifactId,
          artifacts: sessionId === null ? [] : sessionArtifactsFor(deps.db, sessionId),
          work: current.work.filter(
            (item) =>
              (artifactId === null || item.artifactId === artifactId) &&
              (sessionId === null || item.sessionId === sessionId) &&
              (item.assigneeAgentId === null ||
                item.assigneeAgentId === agentId ||
                item.claim?.agentId === agentId),
          ),
          chat: current.chat.filter(
            (message) =>
              (artifactId === null || message.artifactId === artifactId) &&
              (sessionId === null || message.sessionId === sessionId) &&
              (message.recipientAgentId === null || message.recipientAgentId === agentId),
          ),
        });
        return;
      }
      case "GET /api/v1/sessions": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        const status = url.searchParams.get("status");
        if (status !== null && !["active", "handed-off", "ended"].includes(status)) {
          sendJson(res, 400, { error: "status must be active, handed-off, or ended" });
          return;
        }
        sendJson(
          res,
          200,
          listSessions(deps.db, {
            ...(url.searchParams.get("artifact")
              ? { artifactId: url.searchParams.get("artifact") as string }
              : {}),
            ...(url.searchParams.get("agent")
              ? { agentId: url.searchParams.get("agent") as string }
              : {}),
            ...(status ? { status: status as "active" | "handed-off" | "ended" } : {}),
          }),
        );
        return;
      }
      case "POST /api/v1/work/claim": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => handleLeaseClaim(body, res))
          .catch((err: Error) => sendJson(res, 400, { error: err.message }));
        return;
      }
      case "POST /api/v1/inbound/next": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;
              const requestId = optionalString(parsed.requestId);
              const requestCapability = optionalString(parsed.requestCapability);
              const kind = optionalString(parsed.kind);
              const result = inbound.next({
                sessionId: requiredString(parsed.sessionId, "sessionId"),
                agentId: requiredString(parsed.agentId, "agentId"),
                processNonce: requiredString(parsed.processNonce, "processNonce"),
                ...(typeof parsed.workLeaseTtlMs === "number"
                  ? { workLeaseTtlMs: parsed.workLeaseTtlMs }
                  : {}),
                ...(requestId === null ? {} : { requestId }),
                ...(requestCapability === null ? {} : { requestCapability }),
                ...(kind === null ? {} : { kind: kind as "chat" | "work" }),
              });
              sendJson(res, 200, result);
            } catch (error) {
              sendInboundError(res, error);
            }
          })
          .catch((error: Error) => sendJson(res, 400, { error: error.message }));
        return;
      }
      case "POST /api/v1/chat/acknowledge": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => {
            try {
              const parsed = JSON.parse(body) as Record<string, unknown>;
              const result = inbound.acknowledge({
                sessionId: requiredString(parsed.sessionId, "sessionId"),
                agentId: requiredString(parsed.agentId, "agentId"),
                processNonce: requiredString(parsed.processNonce, "processNonce"),
                messageId: requiredString(parsed.messageId, "messageId"),
                attemptId: requiredString(parsed.attemptId, "attemptId"),
                capability: requiredString(parsed.capability, "capability"),
              });
              sendJson(res, 200, result);
            } catch (error) {
              sendInboundError(res, error);
            }
          })
          .catch((error: Error) => sendJson(res, 400, { error: error.message }));
        return;
      }
      case "POST /api/v1/work/heartbeat": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => handleLeaseHeartbeat(body, res))
          .catch((err: Error) => sendJson(res, 400, { error: err.message }));
        return;
      }
      case "POST /api/v1/work/recover": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => handleLeaseRecovery(body, res))
          .catch((err: Error) => sendJson(res, 400, { error: err.message }));
        return;
      }
      case "POST /api/v1/presence": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        void readBody(req)
          .then((body) => {
            const parsed = JSON.parse(body) as {
              agentId?: unknown;
              state?: unknown;
              ttlMs?: unknown;
            };
            if (typeof parsed.agentId !== "string" || typeof parsed.state !== "string") {
              sendJson(res, 400, { error: "body requires string `agentId` and `state`" });
              return;
            }
            if (
              parsed.state !== "thinking" &&
              parsed.state !== "working" &&
              parsed.state !== "idle"
            ) {
              sendJson(res, 400, {
                error: "state must be one of: thinking, working, idle",
              });
              return;
            }
            const ttl = presenceTtl(parsed.ttlMs);
            if (parsed.state === "idle") {
              activityPresence.delete(parsed.agentId);
            } else {
              activityPresence.set(parsed.agentId, {
                state: parsed.state,
                until: Date.now() + ttl,
              });
            }
            sendJson(res, 200, { ok: true });
          })
          .catch((err: Error) => sendJson(res, 400, { error: err.message }));
        return;
      }
      case "GET /api/v1/snapshot": {
        sendJson(
          res,
          200,
          snapshot(deps.db, deps.workspace, `http://127.0.0.1:${ports.artifactPort}`),
        );
        return;
      }
      case "GET /api/v1/whiteboard-semantic-receipts": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        sendJson(res, 200, whiteboards.listSemanticReceiptSnapshots());
        return;
      }
      case "GET /api/v1/question": {
        if (authKind !== "cli") {
          sendJson(res, 403, { error: "cli token required" });
          return;
        }
        const messageId = url.searchParams.get("message");
        if (!messageId) {
          sendJson(res, 400, { error: "message is required", code: "chat.question-id-required" });
          return;
        }
        const question = questionSnapshot(deps.db, messageId);
        if (!question) {
          sendJson(res, 404, {
            error: `unknown question message: ${messageId}`,
            code: "chat.question-unknown",
          });
          return;
        }
        if (question.content.type !== "choice-question") {
          sendJson(res, 400, {
            error: `message ${messageId} is not a choice question`,
            code: "chat.question-required",
          });
          return;
        }
        sendJson(res, 200, question);
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
        const listenerAgent = authKind === "cli" ? url.searchParams.get("agent") : null;
        const requestedListenerState = url.searchParams.get("presence");
        if (requestedListenerState !== null && listenerAgent === null) {
          sendJson(res, 403, { error: "listener presence requires CLI agent authority" });
          return;
        }
        const listenerState = requestedListenerState ?? "listening";
        if (
          listenerState !== "listening" &&
          listenerState !== "thinking" &&
          listenerState !== "working"
        ) {
          sendJson(res, 400, {
            error: "listener presence must be listening, thinking, or working",
          });
          return;
        }
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        // Flush headers immediately so EventSource fires `open` even
        // when there is nothing to replay.
        res.write(": connected\n\n");
        // A bearer-authenticated subscriber that identifies itself is a
        // live listener — presence derives from the open socket.
        if (listenerAgent) {
          addListener(listenerAgent, listenerState);
        }
        replayEvents(deps.db, deps.workspace.workspaceId, after, (e) => writeSse(res, e));
        const unsubscribe = deps.hub.subscribe(res);
        const heartbeat = setInterval(() => {
          if (!res.destroyed) res.write(": ping\n\n");
        }, 30_000);
        let listenerClosed = false;
        req.on("close", () => {
          if (listenerClosed) return;
          listenerClosed = true;
          clearInterval(heartbeat);
          unsubscribe();
          if (listenerAgent) removeListener(listenerAgent, listenerState);
        });
        return;
      }
      default: {
        const objectMatch = url.pathname.match(/^\/api\/v1\/objects\/([a-f0-9]{64})$/);
        if (req.method === "GET" && objectMatch?.[1]) {
          const blob = deps.db
            .prepare("SELECT media_type FROM blobs WHERE hash = ?")
            .get(objectMatch[1]) as { media_type: string } | undefined;
          if (!blob) {
            sendJson(res, 404, { error: "unknown object" });
            return;
          }
          res.writeHead(200, {
            "content-type": blob.media_type,
            "x-content-type-options": "nosniff",
          });
          res.end(readObject(deps.objectsDir, objectMatch[1]));
          return;
        }
        const sessionMatch = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)$/);
        if (req.method === "GET" && sessionMatch?.[1]) {
          if (authKind !== "cli") {
            sendJson(res, 403, { error: "cli token required" });
            return;
          }
          const session = sessionById(deps.db, decodeURIComponent(sessionMatch[1]));
          if (!session) {
            sendJson(res, 404, { error: "unknown session" });
            return;
          }
          sendJson(res, 200, { protocol: "tweakloop.sessions/v1", session });
          return;
        }
        const sourceMatch = url.pathname.match(/^\/api\/v1\/revisions\/([^/]+)\/source$/);
        if (req.method === "GET" && sourceMatch?.[1]) {
          const revision = revisionById(deps.db, sourceMatch[1]);
          if (!revision) {
            sendJson(res, 404, { error: "unknown revision" });
            return;
          }
          const entry = revision.files.find((f) => f.path === revision.entryPath);
          if (!entry) {
            sendJson(res, 404, { error: "revision has no entry file" });
            return;
          }
          res.writeHead(200, { "content-type": entry.mediaType });
          res.end(readObject(deps.objectsDir, entry.hash));
          return;
        }
        sendJson(res, 404, { error: "not found" });
      }
    }
  }

  function handleExistingSessionOpen(rawBody: string, res: ServerResponse): void {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const requestedSourcePath = requiredString(parsed.path, "path");
    const sessionId = requiredString(parsed.sessionId, "sessionId");
    const requestId = requiredString(parsed.requestId, "requestId");
    const expectedContentSha256 = parsed.expectedContentSha256;
    if (
      typeof expectedContentSha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedContentSha256)
    ) {
      sendJson(res, 400, {
        protocol: "tweakloop.session-open-error/v1",
        code: "session.open-content-hash-invalid",
        error: "expectedContentSha256 must be 64 lowercase hexadecimal characters",
      });
      return;
    }
    if (!isAbsolute(requestedSourcePath)) {
      sendJson(res, 400, { error: "path must be absolute" });
      return;
    }
    const sourcePath = resolve(requestedSourcePath);
    if (!sessionExists(deps.db, sessionId)) {
      sendJson(res, 404, { error: `unknown session: ${sessionId}` });
      return;
    }
    if (!existsSync(sourcePath)) {
      sendJson(res, 404, { error: `source file not found: ${sourcePath}` });
      return;
    }
    const roleValue = optionalString(parsed.role) ?? "opened";
    if (!["primary", "opened", "whiteboard"].includes(roleValue)) {
      sendJson(res, 400, { error: "role must be primary, opened, or whiteboard" });
      return;
    }
    const role = roleValue as "primary" | "opened" | "whiteboard";
    const actor = asActor(parsed.actor) ?? { kind: "human", id: "cli" };
    const bytes = readFileSync(sourcePath);
    const actualContentSha256 = createHash("sha256").update(bytes).digest("hex");
    if (actualContentSha256 !== expectedContentSha256) {
      sendJson(res, 409, {
        protocol: "tweakloop.session-open-error/v1",
        code: "session.open-content-mismatch",
        error: "source content changed after the client selected it",
        expectedContentSha256,
        actualContentSha256,
      });
      return;
    }
    const format = formatForPath(sourcePath);
    const semanticGuard = semanticCandidateGuard(
      artifactIdForSource(deps.db, sourcePath),
      format,
      bytes,
    );
    if (!semanticGuard.ok) {
      sendSemanticGuardRejection(res, semanticGuard);
      return;
    }
    const prepared = ingestBytes(basename(sourcePath), bytes);
    const artifactId =
      optionalString(parsed.artifactId) ??
      artifactIdForSource(deps.db, sourcePath) ??
      stableRequestIdentity("artifact", deps.workspace.workspaceId, sessionId, requestId);
    const revisionId = stableRequestIdentity(
      "rev",
      deps.workspace.workspaceId,
      sessionId,
      requestId,
    );
    const idempotencyKey = `session.open-artifact:${sessionId}:${requestId}`;
    const command = {
      protocol: COMMAND_PROTOCOL,
      commandId: stableRequestIdentity("cmd", deps.workspace.workspaceId, sessionId, requestId),
      idempotencyKey,
      workspaceId: deps.workspace.workspaceId,
      actor,
      type: "session.open-artifact",
      payload: {
        sessionId,
        artifactId,
        name: basename(sourcePath),
        format: prepared.revision.format,
        sourcePath,
        provenance: { kind: "workspace-source" },
        revisionId,
        entryPath: prepared.revision.entryPath,
        entryHash: prepared.revision.entryHash,
        files: prepared.revision.files,
        producer: actor,
        role,
      },
    };
    const batch = stageAtomicObjectBatch(
      deps.objectsDir,
      deps.db,
      deps.workspace.workspaceId,
      idempotencyKey,
      prepared.objects,
    );
    try {
      batch.install(new Date().toISOString());
      const result = executeGuarded(command);
      if (result.status === "rejected") {
        batch.rollback();
        sendJson(res, 409, result);
        return;
      }
      batch.commit();
      sendJson(res, 200, {
        protocol: "tweakloop.session-open/v1",
        ...(result.response as object),
      });
    } catch (error) {
      batch.rollback();
      throw error;
    }
  }

  function handleExplicitSessionAttach(rawBody: string, res: ServerResponse): void {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const sessionId = requiredString(parsed.sessionId, "sessionId");
    const artifactId = requiredString(parsed.artifactId, "artifactId");
    const revisionId = requiredString(parsed.revisionId, "revisionId");
    const requestId = requiredString(parsed.requestId, "requestId");
    const roleValue = optionalString(parsed.role) ?? "opened";
    if (!["primary", "opened", "whiteboard"].includes(roleValue)) {
      sendJson(res, 400, { error: "role must be primary, opened, or whiteboard" });
      return;
    }
    const actor = asActor(parsed.actor) ?? { kind: "human", id: "cli" };
    const result = executeGuarded({
      protocol: COMMAND_PROTOCOL,
      commandId: stableRequestIdentity("cmd", deps.workspace.workspaceId, requestId),
      idempotencyKey: `session.attach-artifact:${sessionId}:${requestId}`,
      workspaceId: deps.workspace.workspaceId,
      actor,
      type: "session.attach-artifact",
      payload: { sessionId, artifactId, revisionId, role: roleValue },
    });
    sendJson(res, statusFor(result), result);
  }

  function mintSessionUrl(rawBody: string, res: ServerResponse): void {
    const parsed = rawBody === "" ? {} : (JSON.parse(rawBody) as Record<string, unknown>);
    const artifactId = optionalString(parsed.artifactId);
    const agentId = optionalString(parsed.agentId);
    const sessionId = optionalString(parsed.sessionId);
    if (artifactId !== null && !artifactExists(deps.db, artifactId)) {
      sendJson(res, 404, { error: `unknown requested artifact: ${artifactId}` });
      return;
    }
    if (sessionId === null && agentId !== null) {
      sendJson(res, 400, { error: "agent bootstrap requires a durable sessionId" });
      return;
    }
    if (sessionId !== null && !sessionExists(deps.db, sessionId)) {
      sendJson(res, 404, { error: `unknown requested session: ${sessionId}` });
      return;
    }
    if (artifactId !== null && sessionId === null) {
      sendJson(res, 400, { error: "artifact bootstrap requires a durable sessionId" });
      return;
    }
    if (
      artifactId !== null &&
      sessionId !== null &&
      !sessionHasArtifact(deps.db, sessionId, artifactId)
    ) {
      sendJson(res, 409, { error: "artifact is not attached to the requested session" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    deps.auth.bootstrapTokens.add(token);
    bootstrapContexts.set(token, { artifactId, agentId, sessionId });
    sendJson(res, 201, {
      protocol: "tweakloop.session-url/v1",
      url: `http://127.0.0.1:${ports.shellPort}/bootstrap/${token}`,
      artifactId,
      agentId,
      sessionId,
    });
  }

  async function handleSessionArtifactImport(
    req: IncomingMessage,
    res: ServerResponse,
    authKind: "cli" | "browser",
  ): Promise<void> {
    try {
      const sessionId = requiredHeader(req, "x-tweakloop-session");
      const requestId = requiredHeader(req, "x-tweakloop-request-id");
      const originalName = decodeAttachmentFileName(req.headers["x-tweakloop-filename"]);
      assertSessionAuthority(req, authKind, sessionId);
      const bytes = await readAttachmentBody(req, SESSION_ARTIFACT_MAX_BYTES);
      const prepared = ingestBytes(originalName, bytes);
      const semanticGuard = semanticCandidateGuard(null, prepared.revision.format, bytes);
      if (!semanticGuard.ok) {
        throw new OnboardingHttpError(semanticGuard.code, semanticGuard.message, 409);
      }
      const artifactId = stableRequestIdentity(
        "artifact",
        deps.workspace.workspaceId,
        sessionId,
        requestId,
      );
      const revisionId = stableRequestIdentity(
        "rev",
        deps.workspace.workspaceId,
        sessionId,
        requestId,
      );
      assertRequestIdentityAvailable(
        artifactId,
        prepared.revision.entryHash,
        prepared.revision.entryPath,
        prepared.revision.format,
      );
      const recordedAt = new Date().toISOString();
      for (const object of prepared.objects) {
        putObject(deps.objectsDir, deps.db, object.bytes, object.mediaType, recordedAt);
      }
      const actor: ActorRef = { kind: "human", id: "browser" };
      const result = executeGuarded({
        protocol: COMMAND_PROTOCOL,
        commandId: stableRequestIdentity("cmd", deps.workspace.workspaceId, sessionId, requestId),
        idempotencyKey: `artifact.create:${sessionId}:${requestId}`,
        workspaceId: deps.workspace.workspaceId,
        actor,
        type: "artifact.create",
        payload: {
          artifactId,
          name: prepared.revision.entryPath,
          format: prepared.revision.format,
          sourcePath: null,
          provenance: { kind: "imported-snapshot", originalName },
          revisionId,
          entryPath: prepared.revision.entryPath,
          entryHash: prepared.revision.entryHash,
          files: prepared.revision.files,
          producer: actor,
          attachment: { sessionId, role: "opened" },
        },
      });
      if (result.status === "rejected") {
        throw new OnboardingHttpError(result.code, result.message, 409);
      }
      sendJson(res, 201, onboardingReceipt(sessionId, artifactId, revisionId, result));
    } catch (error) {
      sendOnboardingError(res, error);
    }
  }

  function handleSessionWhiteboardCreate(
    req: IncomingMessage,
    body: string,
    res: ServerResponse,
    authKind: "cli" | "browser",
  ): void {
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const sessionId = requiredText(parsed.sessionId, "sessionId");
      const requestId = requiredText(parsed.requestId, "requestId");
      const requestedName =
        parsed.name === undefined
          ? "Untitled whiteboard.excalidraw"
          : requiredText(parsed.name, "name");
      const displayName = requestedName.toLowerCase().endsWith(".excalidraw")
        ? requestedName
        : `${requestedName}.excalidraw`;
      assertSessionAuthority(req, authKind, sessionId);
      const prepared = ingestBytes(
        displayName,
        Buffer.from(
          JSON.stringify({
            type: "excalidraw",
            version: 2,
            source: "tweakloop",
            elements: [],
            appState: { viewBackgroundColor: "#ffffff" },
            files: {},
          }),
          "utf8",
        ),
      );
      const artifactId = stableRequestIdentity(
        "artifact",
        deps.workspace.workspaceId,
        sessionId,
        requestId,
      );
      const revisionId = stableRequestIdentity(
        "rev",
        deps.workspace.workspaceId,
        sessionId,
        requestId,
      );
      assertRequestIdentityAvailable(
        artifactId,
        prepared.revision.entryHash,
        prepared.revision.entryPath,
        prepared.revision.format,
      );
      const recordedAt = new Date().toISOString();
      for (const object of prepared.objects) {
        putObject(deps.objectsDir, deps.db, object.bytes, object.mediaType, recordedAt);
      }
      const actor: ActorRef = { kind: "human", id: "browser" };
      const result = executeGuarded({
        protocol: COMMAND_PROTOCOL,
        commandId: stableRequestIdentity("cmd", deps.workspace.workspaceId, sessionId, requestId),
        idempotencyKey: `artifact.create:${sessionId}:${requestId}`,
        workspaceId: deps.workspace.workspaceId,
        actor,
        type: "artifact.create",
        payload: {
          artifactId,
          name: prepared.revision.entryPath,
          format: "whiteboard",
          sourcePath: null,
          provenance: { kind: "generated" },
          revisionId,
          entryPath: prepared.revision.entryPath,
          entryHash: prepared.revision.entryHash,
          files: prepared.revision.files,
          producer: actor,
          attachment: { sessionId, role: "whiteboard" },
        },
      });
      if (result.status === "rejected") {
        throw new OnboardingHttpError(result.code, result.message, 409);
      }
      sendJson(res, 201, onboardingReceipt(sessionId, artifactId, revisionId, result));
    } catch (error) {
      sendOnboardingError(res, error);
    }
  }

  function assertSessionAuthority(
    req: IncomingMessage,
    authKind: "cli" | "browser",
    sessionId: string,
  ): void {
    if (!sessionExists(deps.db, sessionId)) {
      throw new OnboardingHttpError("session.unknown", `unknown session: ${sessionId}`, 404);
    }
    if (authKind === "browser") {
      const context = sessionContexts.get(browserSessionToken(req) ?? "");
      if (!context || context.sessionId !== sessionId) {
        throw new OnboardingHttpError(
          "session.binding-mismatch",
          "browser is not authenticated for the requested session",
          403,
        );
      }
    }
  }

  function assertRequestIdentityAvailable(
    artifactId: string,
    entryHash: string,
    name: string,
    format: string,
  ): void {
    const existing = deps.db
      .prepare(
        `SELECT a.name, a.format, r.entry_hash
         FROM p_artifacts a
         LEFT JOIN p_revisions r ON r.artifact_id = a.artifact_id
         WHERE a.artifact_id = ?
         ORDER BY r.created_seq DESC
         LIMIT 1`,
      )
      .get(artifactId) as { name: string; format: string; entry_hash: string | null } | undefined;
    if (
      existing &&
      (existing.entry_hash !== entryHash || existing.name !== name || existing.format !== format)
    ) {
      throw new OnboardingHttpError(
        "artifact.idempotency-conflict",
        "request id was already used for different artifact bytes or metadata",
        409,
      );
    }
  }

  function onboardingReceipt(
    sessionId: string,
    artifactId: string,
    revisionId: string,
    result: CommandResult,
  ): object {
    const membership = sessionById(deps.db, sessionId)?.artifacts.find(
      (item) => item.artifactId === artifactId,
    );
    return {
      protocol: "tweakloop.session-artifact/v1",
      sessionId,
      artifactId,
      revisionId,
      currentRevisionId: membership?.currentRevisionId ?? revisionId,
      attachedSeq:
        membership?.attachedSeq ?? (result.status === "accepted" ? result.lastEventSeq : null),
      name: membership?.name ?? null,
      format: membership?.format ?? null,
      delivery: "durable-available",
    };
  }

  async function handleChatAttachmentUpload(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const fileName = decodeAttachmentFileName(req.headers["x-tweakloop-filename"]);
      const mediaType = attachmentMediaType(req.headers["content-type"]);
      const declaredLength = req.headers["content-length"];
      if (declaredLength !== undefined) {
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length) || length < 0) {
          throw new AttachmentHttpError(
            "attachment.length-invalid",
            "content-length must be a non-negative integer",
            400,
          );
        }
        if (length > CHAT_ATTACHMENT_MAX_BYTES) {
          throw attachmentTooLarge();
        }
      }
      const bytes = await readAttachmentBody(req, CHAT_ATTACHMENT_MAX_BYTES);
      const hash = putObject(deps.objectsDir, deps.db, bytes, mediaType, new Date().toISOString());
      const stored = deps.db
        .prepare("SELECT byte_length, media_type FROM blobs WHERE hash = ?")
        .get(hash) as { byte_length: number; media_type: string } | undefined;
      if (!stored) throw new Error(`uploaded blob metadata missing for ${hash}`);
      const attachment: ChatAttachment = {
        hash,
        fileName,
        mediaType: stored.media_type,
        byteLength: stored.byte_length,
      };
      sendJson(res, 201, attachment);
    } catch (error) {
      sendAttachmentError(res, error);
    }
  }

  function handleChatAttachmentDownload(hash: string, url: URL, res: ServerResponse): void {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      sendAttachmentError(
        res,
        new AttachmentHttpError("attachment.hash-invalid", "invalid attachment hash", 400),
      );
      return;
    }
    const stored = deps.db
      .prepare("SELECT byte_length, media_type FROM blobs WHERE hash = ?")
      .get(hash) as { byte_length: number; media_type: string } | undefined;
    if (!stored) {
      sendAttachmentError(
        res,
        new AttachmentHttpError("attachment.not-found", "attachment not found", 404),
      );
      return;
    }
    let fileName: string;
    try {
      fileName = validateAttachmentFileName(url.searchParams.get("filename") ?? hash);
    } catch (error) {
      sendAttachmentError(res, error);
      return;
    }
    try {
      const bytes = readObject(deps.objectsDir, hash);
      if (bytes.byteLength !== stored.byte_length) {
        throw new Error(`attachment length mismatch for ${hash}`);
      }
      res.writeHead(200, {
        "content-type": stored.media_type,
        "content-length": stored.byte_length,
        "content-disposition": attachmentContentDisposition(fileName),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
      });
      res.end(bytes);
    } catch {
      sendAttachmentError(
        res,
        new AttachmentHttpError("attachment.not-found", "attachment bytes are unavailable", 404),
      );
    }
  }

  function handleWhiteboardApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    authKind: "cli" | "browser",
  ): boolean {
    const sceneCommandsMatch = url.pathname.match(
      /^\/api\/v1\/whiteboards\/([^/]+)\/scene-commands$/,
    );
    if (req.method === "POST" && sceneCommandsMatch?.[1]) {
      void handleWhiteboardSceneCommands(req, res, decodeURIComponent(sceneCommandsMatch[1]), null);
      return true;
    }

    const draftMatch = url.pathname.match(/^\/api\/v1\/whiteboards\/([^/]+)\/draft$/);
    if (draftMatch?.[1]) {
      const artifactId = decodeURIComponent(draftMatch[1]);
      if (req.method === "GET") {
        try {
          const draft = whiteboards.getDraft(artifactId);
          if (!draft) {
            sendWhiteboardError(
              res,
              new WhiteboardError(
                "whiteboard.draft-missing",
                "whiteboard draft does not exist",
                404,
              ),
            );
            return true;
          }
          sendJson(res, 200, withDraftUrls(draft));
        } catch (error) {
          sendWhiteboardError(res, error);
        }
        return true;
      }
      if (req.method === "PUT") {
        void handleWhiteboardPut(req, res, artifactId, authKind);
        return true;
      }
      return false;
    }

    const eventMatch = url.pathname.match(/^\/api\/v1\/whiteboards\/([^/]+)\/draft-events$/);
    if (req.method === "GET" && eventMatch?.[1]) {
      const artifactId = decodeURIComponent(eventMatch[1]);
      const after = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isInteger(after) || after < 0) {
        sendJson(res, 400, { error: "after must be a non-negative integer" });
        return true;
      }
      if (!(req.headers.accept ?? "").includes("text/event-stream")) {
        sendJson(res, 406, { error: "draft-events requires Accept: text/event-stream" });
        return true;
      }
      try {
        whiteboards.getDraft(artifactId);
      } catch (error) {
        sendWhiteboardError(res, error);
        return true;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const unsubscribe = whiteboards.hub.subscribe(artifactId, (value) => {
        if (value.draftVersion > after) writeDraftSse(res, value);
      });
      const current = whiteboards.getDraft(artifactId);
      if (current && current.draftVersion > after) {
        writeDraftSse(res, {
          protocol: "tweakloop.whiteboard-draft/v1",
          kind: "whiteboard-draft",
          artifactId: current.artifactId,
          draftId: current.draftId,
          draftVersion: current.draftVersion,
          baseRevisionId: current.baseRevisionId,
          sceneHash: current.sceneHash,
          updatedBy: current.updatedBy,
        });
      }
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(": ping\n\n");
      }, 30_000);
      req.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return true;
    }

    const conflictsMatch = url.pathname.match(/^\/api\/v1\/whiteboards\/([^/]+)\/conflicts$/);
    if (req.method === "GET" && conflictsMatch?.[1]) {
      try {
        const artifactId = decodeURIComponent(conflictsMatch[1]);
        sendJson(res, 200, {
          protocol: "tweakloop.whiteboard-conflicts/v1",
          artifactId,
          conflicts: whiteboards.listConflicts(artifactId),
        });
      } catch (error) {
        sendWhiteboardError(res, error);
      }
      return true;
    }

    const resolveMatch = url.pathname.match(
      /^\/api\/v1\/whiteboards\/([^/]+)\/conflicts\/([^/]+)\/resolve$/,
    );
    if (req.method === "POST" && resolveMatch?.[1] && resolveMatch[2]) {
      void handleWhiteboardPut(
        req,
        res,
        decodeURIComponent(resolveMatch[1]),
        authKind,
        decodeURIComponent(resolveMatch[2]),
      );
      return true;
    }
    return false;
  }

  async function handleWhiteboardSceneCommands(
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    automationToken: string | null,
  ): Promise<void> {
    try {
      if (automationToken === null) {
        throw new WhiteboardError(
          "whiteboard.agent-auth-required",
          "semantic whiteboard commands require a one-use agent automation token",
          403,
        );
      }
      if (req.headers["x-tweakloop-agent-id"] !== undefined) {
        throw new WhiteboardError(
          "whiteboard.request-invalid",
          "semantic whiteboard attribution cannot be supplied by request headers",
          400,
        );
      }
      if ((req.headers["content-type"] ?? "").split(";")[0] !== "application/json") {
        throw new WhiteboardError(
          "whiteboard.request-invalid",
          "semantic whiteboard commands require Content-Type application/json",
          415,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch {
        throw new WhiteboardError(
          "whiteboard.request-invalid",
          "semantic whiteboard command body must be valid JSON",
          400,
        );
      }
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        (parsed as { artifactId?: unknown }).artifactId !== artifactId
      ) {
        throw new WhiteboardError(
          "whiteboard.request-invalid",
          "semantic whiteboard command artifactId must match the route artifact",
          400,
        );
      }
      const result = whiteboards.applySceneCommands({
        request: parsed as SemanticSceneRequest,
        automationToken,
      });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(result.responseJson);
    } catch (error) {
      sendWhiteboardError(res, error);
    }
  }

  function handleWhiteboardAutomationMint(body: string, res: ServerResponse): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new WhiteboardError(
        "whiteboard.automation-request-invalid",
        "automation mint body must be valid JSON",
        400,
      );
    }
    const input = strictAutomationMintRequest(parsed);
    const minted = whiteboards.mintSceneCommandToken(input);
    sendJson(res, 201, {
      protocol: "tweakloop.whiteboard-automation-token/v1",
      automationToken: minted.automationToken,
      expiresAt: minted.expiresAt,
      operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
      routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
    });
  }

  async function handleWhiteboardPut(
    req: IncomingMessage,
    res: ServerResponse,
    artifactId: string,
    authKind: "cli" | "browser",
    resolutionConflictId?: string,
  ): Promise<void> {
    try {
      if ((req.headers["content-type"] ?? "").split(";")[0] !== WHITEBOARD_SCENE_MEDIA_TYPE) {
        throw new WhiteboardError(
          "whiteboard.scene-invalid",
          `Content-Type must be ${WHITEBOARD_SCENE_MEDIA_TYPE}`,
          415,
        );
      }
      const bytes = await readBinaryBody(req, WHITEBOARD_SCENE_MAX_BYTES);
      const result = whiteboards.putDraft({
        artifactId,
        draftId: requiredHeader(req, "x-tweakloop-draft-id"),
        baseRevisionId: requiredHeader(req, "x-tweakloop-base-revision"),
        expectedDraftVersion: nonNegativeHeader(req, "x-tweakloop-expected-version"),
        clientId: requiredHeader(req, "x-tweakloop-client-id"),
        clientSequence: positiveHeader(req, "x-tweakloop-client-sequence"),
        actor: whiteboardActor(req, authKind),
        bytes,
        ...(resolutionConflictId ? { resolutionConflictId } : {}),
      });
      sendJson(res, result.status === "conflict" ? 409 : 200, withDraftUrls(result));
    } catch (error) {
      sendWhiteboardError(res, error);
    }
  }

  function handleWhiteboardPublish(
    envelope: Record<string, unknown>,
    principal: CommandTransportPrincipal,
    res: ServerResponse,
  ): void {
    try {
      if (
        envelope.protocol !== COMMAND_PROTOCOL ||
        typeof envelope.commandId !== "string" ||
        typeof envelope.idempotencyKey !== "string" ||
        envelope.workspaceId !== deps.workspace.workspaceId
      ) {
        throw new WhiteboardError(
          "protocol.invalid-envelope",
          "whiteboard publication requires a valid command envelope for this workspace",
          400,
        );
      }
      const payload = envelope.payload;
      if (!payload || typeof payload !== "object") {
        throw new WhiteboardError(
          "protocol.invalid-payload",
          "publish payload must be an object",
          400,
        );
      }
      const values = payload as Record<string, unknown>;
      const result = whiteboards.publishDraft({
        commandId: envelope.commandId,
        idempotencyKey: envelope.idempotencyKey,
        artifactId: requiredValue(values.artifactId, "artifactId"),
        draftId: requiredValue(values.draftId, "draftId"),
        expectedDraftVersion: nonNegativeValue(values.expectedDraftVersion, "expectedDraftVersion"),
        expectedHeadRevisionId: requiredValue(
          values.expectedHeadRevisionId,
          "expectedHeadRevisionId",
        ),
        revisionId: requiredValue(values.revisionId, "revisionId"),
        actor: whiteboardPublicationActor(envelope, principal),
      });
      sendJson(res, statusFor(result), result);
    } catch (error) {
      sendWhiteboardError(res, error);
    }
  }

  function withDraftUrls(value: object): object {
    const record = value as Record<string, unknown>;
    if (typeof record.sceneHash !== "string") return value;
    return {
      ...value,
      sceneUrl: `http://127.0.0.1:${ports.artifactPort}/objects/sha256/${record.sceneHash}`,
      draftEventsUrl:
        typeof record.artifactId === "string"
          ? `http://127.0.0.1:${ports.shellPort}/api/v1/whiteboards/${encodeURIComponent(record.artifactId)}/draft-events`
          : null,
    };
  }

  /**
   * Rollback as a value: republish a prior revision's content as a NEW
   * head revision. History is never rewritten; the daemon never touches
   * the source file (syncing it is `tweak restore`'s job, at the edge).
   */
  function handleRestore(rawBody: string, authKind: "cli" | "browser", res: ServerResponse): void {
    let parsed: { revisionId?: unknown; actor?: unknown };
    try {
      parsed = JSON.parse(rawBody) as { revisionId?: unknown; actor?: unknown };
    } catch {
      sendJson(res, 400, { error: "body must be JSON" });
      return;
    }
    if (typeof parsed.revisionId !== "string") {
      sendJson(res, 400, { error: "body requires a string `revisionId`" });
      return;
    }
    const revision = revisionById(deps.db, parsed.revisionId);
    if (!revision) {
      sendJson(res, 404, { error: `unknown revision: ${parsed.revisionId}` });
      return;
    }
    const actor: ActorRef =
      authKind === "cli"
        ? (asActor(parsed.actor) ?? { kind: "human", id: "cli" })
        : { kind: "human", id: "browser" };
    const published = executeGuarded({
      protocol: COMMAND_PROTOCOL,
      commandId: randomUUID(),
      idempotencyKey: `artifact.restore:${randomUUID()}`,
      workspaceId: deps.workspace.workspaceId,
      actor,
      type: "artifact.publish",
      payload: {
        artifactId: revision.artifactId,
        revisionId: `rev_${randomUUID()}`,
        format: revision.format,
        entryPath: revision.entryPath,
        entryHash: revision.entryHash,
        files: revision.files,
        producer: actor,
        sourcePath: revision.sourcePath,
      },
    });
    if (published.status === "rejected") {
      sendJson(res, 409, { error: `${published.code}: ${published.message}` });
      return;
    }
    sendJson(res, 200, {
      artifactId: revision.artifactId,
      restoredFrom: revision.revisionId,
      ...(published.response as object),
    });
  }
  function handlePublish(rawBody: string, res: ServerResponse): void {
    let parsed: {
      path?: unknown;
      actor?: unknown;
      sessionId?: unknown;
      artifactId?: unknown;
    };
    try {
      parsed = JSON.parse(rawBody) as typeof parsed;
    } catch {
      sendJson(res, 400, { error: "body must be JSON" });
      return;
    }
    if (typeof parsed.path !== "string" || !isAbsolute(parsed.path)) {
      sendJson(res, 400, { error: "body requires an absolute string `path`" });
      return;
    }
    const sourcePath = parsed.path;
    if (!existsSync(sourcePath)) {
      sendJson(res, 404, { error: `source file not found: ${sourcePath}` });
      return;
    }
    const sourceBytes = readFileSync(sourcePath);
    const sourceFormat = formatForPath(sourcePath);
    const actor = asActor(parsed.actor) ?? { kind: "human", id: "cli" };
    const sessionId = optionalString(parsed.sessionId);
    const requestedArtifactId = optionalString(parsed.artifactId);

    if (requestedArtifactId !== null && sessionId === null) {
      sendJson(res, 400, { error: "artifactId requires sessionId" });
      return;
    }

    let artifactId: string | null = requestedArtifactId;
    let revisionSourcePath: string | null = sourcePath;
    if (requestedArtifactId !== null) {
      if (!sessionExists(deps.db, sessionId as string)) {
        sendJson(res, 404, { error: `unknown session: ${sessionId}` });
        return;
      }
      if (!sessionHasArtifact(deps.db, sessionId as string, requestedArtifactId)) {
        sendJson(res, 409, {
          error: `artifact ${requestedArtifactId} is not attached to session ${sessionId}`,
        });
        return;
      }
      const existing = deps.db
        .prepare("SELECT format, source_path FROM p_artifacts WHERE artifact_id = ?")
        .get(requestedArtifactId) as
        | { format: "html" | "markdown" | "whiteboard"; source_path: string | null }
        | undefined;
      if (!existing) {
        sendJson(res, 404, { error: `unknown artifact: ${requestedArtifactId}` });
        return;
      }
      if (existing.format !== sourceFormat) {
        sendJson(res, 409, {
          error: `artifact format mismatch: expected ${existing.format}, received ${sourceFormat}`,
        });
        return;
      }
      revisionSourcePath = existing.source_path;
    } else {
      artifactId = artifactIdForSource(deps.db, sourcePath);
    }

    const semanticGuard = semanticCandidateGuard(artifactId, sourceFormat, sourceBytes);
    if (!semanticGuard.ok) {
      sendSemanticGuardRejection(res, semanticGuard);
      return;
    }

    if (artifactId === null) {
      const registered = executeGuarded({
        protocol: COMMAND_PROTOCOL,
        commandId: randomUUID(),
        idempotencyKey: `artifact.register:${sourcePath}`,
        workspaceId: deps.workspace.workspaceId,
        actor,
        type: "artifact.register",
        payload: {
          artifactId: `artifact_${randomUUID()}`,
          name: basename(sourcePath),
          format: sourceFormat,
          sourcePath,
        },
      });
      if (registered.status === "accepted") {
        artifactId = (registered.response as { artifactId: string }).artifactId;
      } else if (registered.code === "artifact.source-already-registered") {
        artifactId = (registered.details as { artifactId: string }).artifactId;
      } else {
        sendJson(res, 409, { error: `${registered.code}: ${registered.message}` });
        return;
      }
    }

    const prepared = ingestBytes(basename(sourcePath), sourceBytes);
    const recordedAt = new Date().toISOString();
    for (const object of prepared.objects) {
      putObject(deps.objectsDir, deps.db, object.bytes, object.mediaType, recordedAt);
    }
    const ingested = prepared.revision;
    const published = executeGuarded({
      protocol: COMMAND_PROTOCOL,
      commandId: randomUUID(),
      idempotencyKey: `artifact.publish:${randomUUID()}`,
      workspaceId: deps.workspace.workspaceId,
      actor,
      type: "artifact.publish",
      payload: {
        artifactId,
        revisionId: `rev_${randomUUID()}`,
        format: ingested.format,
        entryPath: ingested.entryPath,
        entryHash: ingested.entryHash,
        files: ingested.files,
        producer: actor,
        sourcePath: revisionSourcePath,
        sessionId,
      },
    });
    if (published.status === "rejected") {
      sendJson(res, 409, { error: `${published.code}: ${published.message}` });
      return;
    }
    sendJson(res, 200, { artifactId, ...(published.response as object) });
  }

  function handleBootstrap(token: string, res: ServerResponse): void {
    if (!deps.auth.bootstrapTokens.delete(token)) {
      sendJson(res, 403, { error: "invalid or expired bootstrap token" });
      return;
    }
    const session = randomBytes(32).toString("hex");
    deps.auth.sessions.add(session);
    const context = bootstrapContexts.get(token) ?? {
      artifactId: null,
      agentId: null,
      sessionId: null,
    };
    bootstrapContexts.delete(token);
    sessionContexts.set(session, context);
    const location =
      context.artifactId === null
        ? "/app"
        : `/app?artifact=${encodeURIComponent(context.artifactId)}`;
    res.writeHead(303, {
      "set-cookie": `${SESSION_COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`,
      location,
    });
    res.end();
  }

  function handleLeaseClaim(rawBody: string, res: ServerResponse): void {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const agentId = requiredString(parsed.agentId, "agentId");
    const claimId = requiredString(parsed.claimId, "claimId");
    const processNonce = requiredString(parsed.processNonce, "processNonce");
    const requestedWorkId = optionalString(parsed.workId);
    const ttlMs = leaseTtl(parsed.ttlMs);
    const idempotencyKey = optionalString(parsed.idempotencyKey) ?? `work.claim:${claimId}`;
    const storedReceipt = getReceipt(deps.db, deps.workspace.workspaceId, idempotencyKey);
    const storedClaim = claimReceiptIdentity(storedReceipt);
    const commandFor = (workId: string | null) =>
      ({
        protocol: COMMAND_PROTOCOL,
        commandId: `cmd_${randomUUID()}`,
        idempotencyKey,
        workspaceId: deps.workspace.workspaceId,
        actor: { kind: "agent", id: agentId },
        type: "work.claim",
        payload: { claimId, agentId, workId },
      }) as const;
    if (storedReceipt !== null) {
      const receipt = resolveCommandReceipt(
        deps.db,
        deps.workspace.workspaceId,
        commandFor(requestedWorkId ?? storedClaim?.workId ?? null),
      );
      if (receipt.kind !== "resolved") {
        sendJson(res, 409, { error: "stored command receipt disappeared during replay" });
        return;
      }
      const existingReceipt = receipt.result;
      if (existingReceipt.status === "rejected") {
        sendJson(res, statusFor(existingReceipt), existingReceipt);
        return;
      }
      const existingClaim = claimReceiptIdentity(existingReceipt);
      if (claimReceiptIsNone(existingReceipt)) {
        sendJson(res, statusFor(existingReceipt), existingReceipt);
        return;
      }
      if (
        existingClaim === null ||
        existingClaim.claimId !== claimId ||
        existingClaim.agentId !== agentId ||
        (requestedWorkId !== null && existingClaim.workId !== requestedWorkId)
      ) {
        sendJson(res, 409, {
          code: "idempotency-key-conflict",
          error: "the idempotency key is already bound to a different normalized work claim",
        });
        return;
      }
      const now = Date.now();
      if (
        !deps.transactor.leaseMatches(
          existingClaim.workId,
          existingClaim.claimId,
          existingClaim.agentId,
          processNonce,
          now,
        )
      ) {
        sendJson(res, 409, {
          code: "work.claim-recovery-required",
          error:
            "the durable claim receipt exists but this process has no live authority; recover with a new claim id",
        });
        return;
      }
      sendJson(res, statusFor(existingReceipt), existingReceipt);
      return;
    }
    const workId = requestedWorkId ?? firstClaimableWorkId(agentId);
    const command = commandFor(workId);
    const now = Date.now();
    const liveLeaseMatches =
      workId !== null && deps.transactor.leaseMatches(workId, claimId, agentId, processNonce, now);
    if (
      workId !== null &&
      !liveLeaseMatches &&
      !deps.transactor.leaseIsRecoverable(workId, claimId, now)
    ) {
      sendJson(res, 409, { error: "claim lease belongs to another live process" });
      return;
    }
    const result =
      workId === null
        ? executeGuarded(command)
        : deps.transactor.executeWithWorkLease(command, {
            workId,
            claimId,
            agentId,
            processNonce,
            requestCapabilityHash: null,
            lastHeartbeat: now,
            expiresAt: now + ttlMs,
          });
    sendJson(res, statusFor(result), result);
  }

  function firstClaimableWorkId(agentId: string): string | null {
    const row = deps.db
      .prepare(
        `SELECT work_id
         FROM p_work
         WHERE status = 'open' AND claim_json IS NULL
           AND (assignee_agent_id IS NULL OR assignee_agent_id = ?)
         ORDER BY created_seq
         LIMIT 1`,
      )
      .get(agentId) as { work_id: string } | undefined;
    return row?.work_id ?? null;
  }

  function sendInboundError(res: ServerResponse, error: unknown): void {
    if (error instanceof InboundError) {
      sendJson(res, error.status, { error: error.message, code: error.code });
      return;
    }
    sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }

  function sendNativeHookError(res: ServerResponse, error: unknown): void {
    if (error instanceof NativeHookObservationError) {
      sendJson(res, error.status, {
        protocol: "tweakloop.native-hook-error/v1",
        error: error.message,
        code: error.code,
      });
      return;
    }
    if (error instanceof NativeHookProtocolError || error instanceof SyntaxError) {
      sendJson(res, 400, {
        protocol: "tweakloop.native-hook-error/v1",
        error: error.message,
        code: error instanceof NativeHookProtocolError ? error.code : "native-hook.request-invalid",
      });
      return;
    }
    sendJson(res, 500, {
      protocol: "tweakloop.native-hook-error/v1",
      error: "internal native hook error",
      code: "native-hook.internal",
    });
  }

  function handleLeaseHeartbeat(rawBody: string, res: ServerResponse): void {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const ttlMs = leaseTtl(parsed.ttlMs);
    const now = Date.now();
    const ok = deps.transactor.heartbeatLease({
      workId: requiredString(parsed.workId, "workId"),
      claimId: requiredString(parsed.claimId, "claimId"),
      agentId: requiredString(parsed.agentId, "agentId"),
      processNonce: requiredString(parsed.processNonce, "processNonce"),
      nowMs: now,
      expiresAt: now + ttlMs,
    });
    sendJson(
      res,
      ok ? 200 : 409,
      ok
        ? { ok: true, expiresAt: now + ttlMs }
        : { error: "lease is stale or not owned by this process" },
    );
  }

  function handleLeaseRecovery(rawBody: string, res: ServerResponse): void {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    const workId = requiredString(parsed.workId, "workId");
    const staleClaimId = requiredString(parsed.staleClaimId, "staleClaimId");
    const claimId = requiredString(parsed.claimId, "claimId");
    const agentId = requiredString(parsed.agentId, "agentId");
    const processNonce = requiredString(parsed.processNonce, "processNonce");
    const ttlMs = leaseTtl(parsed.ttlMs);
    const now = Date.now();
    if (deps.transactor.leaseMatches(workId, claimId, agentId, processNonce, now)) {
      sendJson(res, 200, {
        status: "accepted",
        response: { status: "claimed", recovered: true, workId, claimId, agentId },
      });
      return;
    }
    if (!deps.transactor.leaseIsRecoverable(workId, staleClaimId, now)) {
      sendJson(res, 409, { error: "claim lease is still active" });
      return;
    }
    const result = deps.transactor.executeWithWorkLease(
      {
        protocol: COMMAND_PROTOCOL,
        commandId: `cmd_${randomUUID()}`,
        idempotencyKey:
          optionalString(parsed.idempotencyKey) ?? `work.reclaim:${staleClaimId}:${claimId}`,
        workspaceId: deps.workspace.workspaceId,
        actor: { kind: "agent", id: agentId },
        type: "work.reclaim",
        payload: { workId, staleClaimId, claimId, agentId },
      },
      {
        workId,
        claimId,
        agentId,
        processNonce,
        requestCapabilityHash: null,
        lastHeartbeat: now,
        expiresAt: now + ttlMs,
      },
    );
    sendJson(res, statusFor(result), result);
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

function claimReceiptIdentity(
  result: CommandResult | null,
): Readonly<{ workId: string; claimId: string; agentId: string }> | null {
  if (
    result?.status !== "accepted" ||
    result.response === null ||
    typeof result.response !== "object"
  ) {
    return null;
  }
  const response = result.response as Record<string, unknown>;
  return response.status === "claimed" &&
    typeof response.workId === "string" &&
    typeof response.claimId === "string" &&
    typeof response.agentId === "string"
    ? { workId: response.workId, claimId: response.claimId, agentId: response.agentId }
    : null;
}

function claimReceiptIsNone(result: CommandResult): boolean {
  return (
    result.status === "accepted" &&
    result.response !== null &&
    typeof result.response === "object" &&
    (result.response as Record<string, unknown>).status === "none"
  );
}

function whiteboardHostHtml(
  sceneBytes: Buffer,
  artifactId: string,
  revisionId: string,
  title: string,
): string {
  const scene = sceneBytes
    .toString("utf8")
    .replaceAll("&", "\\u0026")
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    html,body { margin:0; min-height:100%; background:#f7f7f5; color:#171717; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
    main { min-height:100vh; padding:18px; box-sizing:border-box; }
    [data-tweakloop-whiteboard] { height:calc(100vh - 36px); min-height:32rem; overflow:hidden; border:1px solid #deddd8; border-radius:18px; background:white; box-shadow:0 18px 48px rgba(26,24,20,.08); }
  </style>
</head>
<body>
  <main>
    <div data-tweakloop-whiteboard data-tweakloop-whiteboard-mode="standalone"
      data-tweak-id="whiteboard.canvas" data-tweak-kind="whiteboard"
      data-tweak-whiteboard-artifact="${escapeHtml(artifactId)}"
      data-tweak-whiteboard-revision="${escapeHtml(revisionId)}">
      <script type="${WHITEBOARD_SCENE_MEDIA_TYPE}">${scene}</script>
    </div>
  </main>
</body>
</html>`;
}

function whiteboardErrorHtml(detail: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Whiteboard unavailable</title>
  <style>body{margin:0;background:#f7f7f5;font:16px/1.5 system-ui;color:#26231f}.error{max-width:44rem;margin:12vh auto;padding:2rem;border:1px solid #e6b8ad;border-radius:18px;background:#fff8f5;box-shadow:0 18px 48px #35251a14}h1{font-size:1.35rem;margin-top:0}code{display:block;white-space:pre-wrap;color:#8f2d19}</style></head>
  <body><section class="error" role="alert"><h1>Whiteboard data needs attention</h1><p>The scene was rejected before the editor loaded. Comments, tasks, and chat remain available.</p><code>${escapeHtml(detail)}</code></section></body></html>`;
}

function whiteboardAssetMediaType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".ttf":
      return "font/ttf";
    case ".png":
      return "image/png";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function writeDraftSse(res: ServerResponse, value: DraftInvalidation): void {
  if (res.destroyed || res.writableEnded) return;
  res.write(
    `id: ${value.draftVersion}\nevent: whiteboard-draft\ndata: ${JSON.stringify(value)}\n\n`,
  );
}

function requiredHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  if (typeof value !== "string" || value.length === 0 || value.length > 256) {
    throw new WhiteboardError("whiteboard.request-invalid", `missing or invalid ${name}`, 400);
  }
  return value;
}

function nonNegativeHeader(req: IncomingMessage, name: string): number {
  return integerValue(requiredHeader(req, name), name, 0);
}

function positiveHeader(req: IncomingMessage, name: string): number {
  return integerValue(requiredHeader(req, name), name, 1);
}

function requiredValue(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new WhiteboardError("whiteboard.request-invalid", `${name} must be a string`, 400);
  }
  return value;
}

function nonNegativeValue(value: unknown, name: string): number {
  return integerValue(value, name, 0);
}

function integerValue(value: unknown, name: string, minimum: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > Number.MAX_SAFE_INTEGER) {
    throw new WhiteboardError(
      "whiteboard.request-invalid",
      `${name} must be an integer greater than or equal to ${minimum}`,
      400,
    );
  }
  return number;
}

function whiteboardActor(req: IncomingMessage, authKind: "cli" | "browser"): ActorRef {
  if (authKind === "browser") return { kind: "human", id: "browser" };
  const agentId = req.headers["x-tweakloop-agent-id"];
  if (agentId === undefined) return { kind: "agent", id: "cli" };
  if (typeof agentId !== "string" || agentId.length === 0 || agentId.length > 256) {
    throw new WhiteboardError(
      "whiteboard.request-invalid",
      "x-tweakloop-agent-id must be a non-empty string",
      400,
    );
  }
  return { kind: "agent", id: agentId };
}

/**
 * Temporary CLI-only adapter: the service accepts an injected principal and the request schema has
 * no authority fields. Replace this header derivation with a consumed session-capability holder;
 * never extend it to browser-cookie authority or trust an actor from the semantic request body.
 */
class OnboardingHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "OnboardingHttpError";
  }
}

function sendOnboardingError(res: ServerResponse, error: unknown): void {
  if (error instanceof OnboardingHttpError || error instanceof IngestBytesError) {
    sendJson(res, error instanceof OnboardingHttpError ? error.status : 400, {
      protocol: "tweakloop.onboarding-error/v1",
      code: error.code,
      message: error.message,
    });
    return;
  }
  if (error instanceof AttachmentHttpError) {
    sendJson(res, error.status, {
      protocol: "tweakloop.onboarding-error/v1",
      code: error.code.replace(/^attachment\./, "artifact."),
      message: error.message,
    });
    return;
  }
  sendJson(res, 400, {
    protocol: "tweakloop.onboarding-error/v1",
    code: "artifact.request-invalid",
    message: error instanceof Error ? error.message : "invalid onboarding request",
  });
}

function sendWorkspaceRestoreError(res: ServerResponse, error: unknown): void {
  if (error instanceof WorkspaceFilesError) {
    sendJson(res, error.code.endsWith(".migration-required") ? 426 : 409, {
      protocol: "tweakloop.workspace-restore/v1",
      status: "error",
      code: error.code,
      message: error.message,
      details: error.details,
    });
    return;
  }
  if (error instanceof WorkspaceRestoreError || error instanceof WorkspaceRestoreJournalError) {
    sendJson(res, error.status, {
      protocol: "tweakloop.workspace-restore/v1",
      status: "error",
      code: error.code,
      message: error.message,
      details: error.details,
    });
    return;
  }
  sendJson(res, 400, {
    protocol: "tweakloop.workspace-restore/v1",
    status: "error",
    code: "workspace-restore.request-invalid",
    message: error instanceof Error ? error.message : "invalid restore request",
  });
}

function requiredText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\0")
  ) {
    throw new OnboardingHttpError("artifact.request-invalid", `${field} must be non-empty text`);
  }
  return value;
}

function stableRequestIdentity(prefix: string, ...parts: readonly string[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

class AttachmentHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function attachmentTooLarge(): AttachmentHttpError {
  return new AttachmentHttpError(
    "attachment.too-large",
    `attachment exceeds ${CHAT_ATTACHMENT_MAX_BYTES} bytes`,
    413,
  );
}

function validateAttachmentFileName(value: string): string {
  if (
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 255 ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127 || character === "/" || character === "\\";
    })
  ) {
    throw new AttachmentHttpError(
      "attachment.filename-invalid",
      "attachment filename must be non-empty, at most 255 bytes, and contain no path separators or control characters",
      400,
    );
  }
  return value;
}

function decodeAttachmentFileName(header: string | string[] | undefined): string {
  if (typeof header !== "string") {
    throw new AttachmentHttpError(
      "attachment.filename-missing",
      "x-tweakloop-filename is required",
      400,
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    throw new AttachmentHttpError(
      "attachment.filename-invalid",
      "x-tweakloop-filename must be encodeURIComponent encoded",
      400,
    );
  }
  return validateAttachmentFileName(decoded);
}

function attachmentMediaType(header: string | string[] | undefined): string {
  const value = typeof header === "string" ? header.trim() : "application/octet-stream";
  if (value.length === 0 || value.length > 255 || /[\r\n]/.test(value)) {
    throw new AttachmentHttpError(
      "attachment.media-type-invalid",
      "content-type must be a non-empty media type",
      400,
    );
  }
  return value;
}

function attachmentContentDisposition(fileName: string): string {
  const ascii = fileName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 255);
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii || "attachment"}"; filename*=UTF-8''${encoded}`;
}

function readAttachmentBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) {
        rejected = true;
        reject(attachmentTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!rejected) resolveBody(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendAttachmentError(res: ServerResponse, error: unknown): void {
  if (error instanceof AttachmentHttpError) {
    sendJson(res, error.status, {
      protocol: "tweakloop.attachment-error/v1",
      code: error.code,
      error: error.message,
    });
    return;
  }
  sendJson(res, 500, {
    protocol: "tweakloop.attachment-error/v1",
    code: "attachment.internal",
    error: "internal attachment error",
  });
}

function readBinaryBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        reject(
          new WhiteboardError(
            "whiteboard.scene-too-large",
            `whiteboard request exceeds ${limit} bytes`,
            413,
          ),
        );
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolveBody(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendWhiteboardError(res: ServerResponse, error: unknown): void {
  if (error instanceof WhiteboardError || error instanceof RuntimeAuthorityError) {
    sendJson(res, error.status, {
      protocol: "tweakloop.whiteboard-error/v1",
      error: error.message,
      code: error.code,
      ...(error instanceof WhiteboardError && error.details ? { details: error.details } : {}),
    });
    return;
  }
  sendJson(res, 500, {
    protocol: "tweakloop.whiteboard-error/v1",
    error: "internal whiteboard error",
    code: "whiteboard.internal",
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusFor(result: CommandResult): number {
  if (result.status === "accepted") return 200;
  return result.code.startsWith("protocol.") ? 400 : 409;
}

function asActor(value: unknown): ActorRef | null {
  if (
    value &&
    typeof value === "object" &&
    "kind" in value &&
    "id" in value &&
    typeof (value as { id: unknown }).id === "string" &&
    ["human", "agent", "system"].includes(String((value as { kind: unknown }).kind))
  ) {
    return { kind: (value as { kind: ActorRef["kind"] }).kind, id: (value as { id: string }).id };
  }
  return null;
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

function validHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
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

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  return token.length > 0 && token.length <= 1024 ? token : null;
}

function strictAutomationMintRequest(value: unknown): Readonly<{
  sessionId: string;
  runtimeCapability: string;
  artifactId: string;
  method: typeof WHITEBOARD_AUTOMATION_METHOD;
  operationId: typeof WHITEBOARD_AUTOMATION_OPERATION_ID;
  routeSetVersion: typeof WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION;
  request: SemanticSceneRequest;
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw automationMintInvalid("automation mint request must be an object");
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set([
    "protocol",
    "sessionId",
    "runtimeCapability",
    "artifactId",
    "method",
    "operationId",
    "routeSetVersion",
    "request",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw automationMintInvalid("automation mint request contains unsupported fields");
  }
  if (input.protocol !== "tweakloop.whiteboard-automation-mint/v1") {
    throw automationMintInvalid("automation mint protocol is unsupported");
  }
  const sessionId = strictMintString(input.sessionId, "sessionId");
  const runtimeCapability = strictMintString(input.runtimeCapability, "runtimeCapability", 1024);
  const artifactId = strictMintString(input.artifactId, "artifactId");
  if (
    input.method !== WHITEBOARD_AUTOMATION_METHOD ||
    input.operationId !== WHITEBOARD_AUTOMATION_OPERATION_ID ||
    input.routeSetVersion !== WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION
  ) {
    throw automationMintInvalid("automation mint route binding is unsupported");
  }
  if (!input.request || typeof input.request !== "object" || Array.isArray(input.request)) {
    throw automationMintInvalid("automation mint request must include a semantic request");
  }
  return {
    sessionId,
    runtimeCapability,
    artifactId,
    method: WHITEBOARD_AUTOMATION_METHOD,
    operationId: WHITEBOARD_AUTOMATION_OPERATION_ID,
    routeSetVersion: WHITEBOARD_AUTOMATION_ROUTE_SET_VERSION,
    request: input.request as SemanticSceneRequest,
  };
}

function strictMintString(value: unknown, name: string, maxLength = 256): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    hasAsciiControlCharacter(value)
  ) {
    throw automationMintInvalid(`${name} has an invalid format`);
  }
  return value;
}

function automationMintInvalid(message: string): WhiteboardError {
  return new WhiteboardError("whiteboard.automation-request-invalid", message, 400);
}

function hasAsciiControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function browserSessionToken(req: IncomingMessage): string | null {
  const cookies = req.headers.cookie ?? "";
  for (const part of cookies.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SESSION_COOKIE && value) return value;
  }
  return null;
}

function commandTransportPrincipal(authKind: "cli" | "browser"): CommandTransportPrincipal {
  return authKind === "browser"
    ? { kind: "human", id: "browser" }
    : { kind: "agent", id: "cli-bearer" };
}

function whiteboardPublicationActor(
  envelope: Readonly<Record<string, unknown>>,
  principal: CommandTransportPrincipal,
): ActorRef {
  if (principal.kind === "human") return { kind: "human", id: principal.id };
  const declared = asActor(envelope.actor);
  if (declared?.kind !== "agent" || declared.id.length === 0 || declared.id.length > 256) {
    throw new WhiteboardError(
      "authority.publication-agent-required",
      "CLI whiteboard publication requires declared agent attribution",
      409,
    );
  }
  return declared;
}

function withBrowserHumanActor(input: unknown, principal: CommandTransportPrincipal): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return {
    ...(input as Record<string, unknown>),
    actor: { kind: "human", id: principal.id },
  };
}

function withSessionContext(input: unknown, context: BootstrapContext | undefined): unknown {
  if (!context || !input || typeof input !== "object") return input;
  const envelope = input as Record<string, unknown>;
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") return input;
  if (envelope.type === "review.submit-batch") {
    return {
      ...envelope,
      payload: {
        ...(payload as Record<string, unknown>),
        assigneeAgentId:
          context.agentId ?? (payload as Record<string, unknown>).assigneeAgentId ?? null,
        sessionId: context.sessionId ?? (payload as Record<string, unknown>).sessionId ?? null,
      },
    };
  }
  if (envelope.type === "chat.send") {
    const values = payload as Record<string, unknown>;
    return {
      ...envelope,
      payload: {
        ...values,
        sessionId: context.sessionId ?? values.sessionId ?? null,
        recipientAgentId: context.agentId ?? values.recipientAgentId ?? null,
        threadId: values.threadId ?? values.workId ?? values.intentId ?? context.sessionId ?? null,
      },
    };
  }
  return input;
}

function artifactExists(db: Db, artifactId: string): boolean {
  return (
    db.prepare("SELECT 1 AS present FROM p_artifacts WHERE artifact_id = ?").get(artifactId) !==
    undefined
  );
}

function optionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("optional identifiers must be non-empty strings");
  }
  return value;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`body requires a non-empty string \`${field}\``);
  }
  return value;
}

function leaseTtl(value: unknown): number {
  if (value === undefined) return DEFAULT_LEASE_TTL_MS;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 300_000) {
    throw new Error("ttlMs must be an integer between 1 and 300000");
  }
  return value;
}

function presenceTtl(value: unknown): number {
  if (value === undefined) return 20_000;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 300_000) {
    throw new Error("ttlMs must be an integer between 1 and 300000");
  }
  return value;
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
