#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Command } from "commander";
import { extractSemanticIndex } from "../artifacts/semantic.js";
import { startDaemon } from "../daemon/index.js";
import { rebuildProjections } from "../daemon/projections.js";
import { ensureProjectConfig, stateDirFor, workspaceIdFor } from "../daemon/runtime.js";
import type { ChatAttachment, ChatReference } from "../protocol/chat.js";
import type { ActorRef, CommandEnvelope, EventEnvelope } from "../protocol/envelopes.js";
import {
  AGENT_SESSION_PROTOCOL,
  CLI_PROTOCOL,
  COMMAND_PROTOCOL,
  SESSION_QUERY_PROTOCOL,
} from "../protocol/versions.js";
import { openDatabase } from "../storage/sqlite/db.js";
import { canonicalizeWhiteboardScene } from "../whiteboard/scene.js";
import {
  emptySemanticSceneMap,
  readSemanticSceneMap,
} from "../whiteboard/semantic-representation.js";
import {
  SEMANTIC_SCENE_REQUEST_PROTOCOL,
  type SemanticSceneOperation,
  type SemanticSceneRequest,
} from "../whiteboard/semantic-scene.js";
import {
  WorkspaceExportOperationError,
  workspaceExportFilesPolicyHash,
} from "../workspace/export-journal.js";
import {
  captureWorkspaceFiles,
  validateWorkspaceBundleEnvelope,
  validateWorkspaceFilesConfig,
  WORKSPACE_FILES_MANIFEST_PATH,
  WorkspaceFilesError,
} from "../workspace/files.js";
import {
  agentSnapshotScope,
  deriveWorkChatContext,
  resolveClaimAgent,
  resolveSessionAgentContext,
  sessionTrafficMatches,
} from "./agent-context.js";
import { checkArtifact } from "./artifact-check.js";
import type { ArtifactDiffReceipt } from "./authoring-analysis.js";
import {
  AuthoringAnalysisError,
  diffArtifactBytes,
  diffNewArtifactBytes,
  lintArtifactFile,
  semanticFormatForPath,
} from "./authoring-analysis.js";
import {
  type ProtectionContext,
  summarizeArtifactDiff,
  summarizeArtifactLint,
} from "./authoring-summary.js";
import {
  attachArtifactToSession,
  claimWorkWithLease,
  type DaemonConnection,
  discoverDaemon,
  ensureDaemon,
  fetchChatAttachment,
  fetchRevisionSource,
  fetchWhiteboardObject,
  getAgentSessionSnapshot,
  getSession,
  getSnapshot,
  getWhiteboardDraft,
  heartbeatWorkLease,
  listEvents,
  listSessions,
  listWhiteboardConflicts,
  mintBootstrap,
  mintSessionUrl,
  openArtifactInSession,
  postCommand,
  publishArtifact,
  publishWhiteboardDraft,
  putWhiteboardDraft,
  recoverWorkLease,
  releaseStartupLock,
  requestShutdown,
  restoreRevision,
  tryAcquireStartupLock,
  uploadChatAttachment,
} from "./daemon-client.js";
import { type DocumentResolution, resolveDocumentReference } from "./document-resolution.js";
import { registerInboundCommands } from "./inbound-commands.js";
import { currentInvocation, renderInvocation, resolveInvocation } from "./invocation.js";
import { registerNativeHookCommands } from "./native-hook-commands.js";
import {
  CliFailure,
  emitJson,
  exitWithFailure,
  fail,
  info,
  jsonRequested,
  normalizeCliFailure,
  successfulParserExit,
} from "./output.js";
import { createPlanScaffold, PlanScaffoldError } from "./plan-scaffold.js";
import { publishAndComplete } from "./publish-complete.js";
import { registerQuestionCommands } from "./question-commands.js";
import { contentSha256, stableCliIdentity } from "./request-identity.js";
import {
  abandonRuntimeCapabilityPreparation,
  completeRuntimeCapabilityPreparation,
  loadRuntimeCapability,
  preflightRuntimeCapabilityCustody,
  prepareRuntimeCapability,
  RuntimeCapabilityError,
  removeRuntimeCapability,
} from "./runtime-capability.js";
import { refreshClaimSnapshot, workListenerState } from "./session-listener.js";
import { withStartupDiagnostics } from "./startup-diagnostics.js";
import { projectWhiteboardSceneInspect } from "./whiteboard-scene-inspect.js";
import { applyWhiteboardSemanticScene } from "./whiteboard-semantic-client.js";
import {
  ManagedWhiteboardWorkspace,
  nativeEditorRoute,
  WhiteboardWorkspaceError,
} from "./whiteboard-workspace.js";
import { parseWorkListStatus, workListReceipt } from "./work-list.js";
import { exportWorkspaceBundleOperation } from "./workspace-bundle-export.js";
import { exportWorkspace, WorkspaceExportError } from "./workspace-export.js";
import { createForkedWorkspaceBundle } from "./workspace-fork.js";
import { restoreWorkspaceExport } from "./workspace-restore.js";
import { compactWorkspaceRestore, getWorkspaceRestoreInventory } from "./workspace-retention.js";

const program = new Command("tweak");
program.exitOverride();
program.configureOutput({ writeErr: () => {} });
const cwdCapture = captureCurrentWorkingDirectory();
let invocationFailure: unknown = cwdCapture.failure;
const invocation = (() => {
  if (invocationFailure !== null) {
    return resolveInvocation({
      execPath: process.execPath,
      ...(process.argv[1] ? { scriptPath: process.argv[1] } : {}),
      cwd: cwdCapture.path,
      argv: process.argv.slice(2),
    });
  }
  try {
    return currentInvocation();
  } catch (error) {
    invocationFailure = error;
    return resolveInvocation({
      execPath: process.execPath,
      ...(process.argv[1] ? { scriptPath: process.argv[1] } : {}),
      cwd: cwdCapture.path,
      argv: process.argv.slice(2),
    });
  }
})();
program
  .description("Tweakloop — durable human–agent artifact iteration")
  .version("0.1.0")
  .option("--workspace <path>", "workspace root", cwdCapture.path)
  .option("--json", "machine-readable output", false);

type GlobalOpts = { workspace: string; json: boolean };

function globals(): GlobalOpts {
  return program.opts<GlobalOpts>();
}

function rootPath(): string {
  return resolve(globals().workspace);
}

function captureCurrentWorkingDirectory(): Readonly<{ path: string; failure: CliFailure | null }> {
  try {
    return { path: process.cwd(), failure: null };
  } catch (error) {
    const fallback = process.env.PWD?.startsWith("/") ? process.env.PWD : "/";
    const cause = error instanceof Error ? error.message : String(error);
    return {
      path: fallback,
      failure: new CliFailure("current working directory is unavailable", {
        code: "cli.cwd-unavailable",
        details: { cause: cause.length <= 1_024 ? cause : `${cause.slice(0, 1_021)}...` },
      }),
    };
  }
}

function envelope(
  workspaceId: string,
  type: string,
  idempotencyKey: string,
  payload: unknown,
  actor: ActorRef,
  commandId: string = randomUUID(),
): CommandEnvelope {
  const canonicalActor =
    actor.kind === "agent" ? { ...actor, id: canonicalAgentId(actor.id) } : actor;
  const canonicalPayload = canonicalizeAgentPayload(payload);
  return {
    protocol: COMMAND_PROTOCOL,
    commandId,
    idempotencyKey,
    workspaceId,
    actor: canonicalActor,
    type,
    payload: canonicalPayload,
  };
}

function defaultAgentId(): string {
  return process.env.TWEAKLOOP_AGENT_ID ?? process.env.USER ?? "cli";
}

function canonicalAgentId(agentId: string): string {
  return agentId.startsWith("agent:") ? agentId.slice("agent:".length) : agentId;
}

function canonicalizeAgentPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
  const result = { ...(payload as Record<string, unknown>) };
  for (const key of ["agentId", "assigneeAgentId", "recipientAgentId", "toAgentId"] as const) {
    if (typeof result[key] === "string") result[key] = canonicalAgentId(result[key]);
  }
  return result;
}

function agentActor(agentId: string): ActorRef {
  return { kind: "agent", id: canonicalAgentId(agentId) };
}

type HumanBrowserHandoff = Readonly<{
  action: string;
  artifactId?: string | null;
  sessionId?: string | null;
  workId?: string;
  messageId?: string;
}>;

function requireHumanBrowser(input: HumanBrowserHandoff): never {
  const artifactId = input.artifactId ? boundedIdentifier(input.artifactId) : null;
  const sessionId = input.sessionId ? boundedIdentifier(input.sessionId) : null;
  const reviewShellArgs = [
    "session",
    "url",
    sessionId ?? "<sessionId>",
    ...(artifactId ? ["--document", artifactId] : []),
  ];
  const nextArgs = sessionId
    ? reviewShellArgs
    : [
        "session",
        "list",
        ...(artifactId ? ["--document", artifactId] : []),
        "--status",
        "active",
        "--json",
      ];
  fail("human authority is available only in the review shell", {
    code: "human.browser-required",
    exitCode: 2,
    retryable: false,
    details: {
      action: boundedIdentifier(input.action),
      mutated: false,
      ...(artifactId ? { artifactId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(input.workId ? { workId: boundedIdentifier(input.workId) } : {}),
      ...(input.messageId ? { messageId: boundedIdentifier(input.messageId) } : {}),
      reviewShellCommand: renderInvocation(invocation, reviewShellArgs),
    },
    nextAction: {
      command: renderInvocation(invocation, nextArgs),
      purpose: sessionId
        ? "mint a fresh one-use review-shell URL and complete the human action there"
        : "find the exact active session, then mint its fresh one-use review-shell URL",
    },
  });
}

function boundedIdentifier(value: string): string {
  return value.length <= 256 ? value : `${value.slice(0, 253)}...`;
}

function presentReviewUrl(url: string, browser: boolean): void {
  if (browser) {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "linux" ? "xdg-open" : null;
    if (opener) spawn(opener, [url], { detached: true, stdio: "ignore" }).unref();
    info(`review shell: ${url}`);
    return;
  }
  info(`open this URL to review: ${url}`);
}

type SessionArtifactRole = "primary" | "opened" | "whiteboard";

function sessionArtifactRole(value: string | undefined): SessionArtifactRole {
  const role = value ?? "opened";
  if (role !== "primary" && role !== "opened" && role !== "whiteboard") {
    fail("role must be primary, opened, or whiteboard", {
      code: "session.role-invalid",
      exitCode: 2,
      details: { role },
    });
  }
  return role;
}

type CliCommentInput = Readonly<{
  intentId?: string;
  target: Readonly<Record<string, unknown>>;
  body: Readonly<Record<string, unknown>>;
}>;

function parseCommentInputs(value: string): readonly CliCommentInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("--comments-json must be valid JSON", {
      code: "review.comments-invalid",
      exitCode: 2,
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    fail("--comments-json must be a non-empty array", {
      code: "review.comments-invalid",
      exitCode: 2,
    });
  }
  return parsed.map((comment, index) => {
    if (!isPlainRecord(comment) || !isPlainRecord(comment.target) || !isPlainRecord(comment.body)) {
      fail(`comment ${index + 1} must contain object target and body values`, {
        code: "review.comments-invalid",
        exitCode: 2,
        details: { index },
      });
    }
    if (
      comment.intentId !== undefined &&
      (typeof comment.intentId !== "string" || comment.intentId.length === 0)
    ) {
      fail(`comment ${index + 1} has an invalid intentId`, {
        code: "review.comments-invalid",
        exitCode: 2,
        details: { index },
      });
    }
    return {
      ...(typeof comment.intentId === "string" ? { intentId: comment.intentId } : {}),
      target: comment.target,
      body: comment.body,
    };
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function resolveDocument(
  connection: DaemonConnection,
  document: string,
): Promise<DocumentResolution> {
  const current = await getSnapshot(connection);
  return resolveDocumentReference(current.artifacts, document, rootPath());
}

async function resolveArtifactId(connection: DaemonConnection, document: string): Promise<string> {
  return requireRegisteredDocument(await resolveDocument(connection, document), document);
}

async function resolveRegisteredHead(
  connection: DaemonConnection,
  document: string,
): Promise<Readonly<{ artifactId: string; revisionId: string }>> {
  const current = await getSnapshot(connection);
  const artifactId = requireRegisteredDocument(
    resolveDocumentReference(current.artifacts, document, rootPath()),
    document,
  );
  const head = current.revisions
    .filter((revision) => revision.artifactId === artifactId)
    .sort((left, right) => left.seq - right.seq)
    .at(-1);
  if (!head) {
    fail(`document has no published revision: ${document}`, {
      code: "document.revision-missing",
      details: { artifactId },
    });
  }
  return { artifactId, revisionId: head.revisionId };
}

function requireRegisteredDocument(resolution: DocumentResolution, selector: string): string {
  switch (resolution.status) {
    case "registered":
      return resolution.artifactId;
    case "unregistered":
      return fail(`unknown document: ${selector}`, {
        code: "document.unregistered",
        details: { path: resolution.absolutePath },
      });
    case "ambiguous":
      return fail(`document is ambiguous: ${selector}`, {
        code: "document.ambiguous",
        exitCode: 2,
        details: { matchCount: resolution.matchCount },
      });
    case "corrupt":
      return fail(`document identity is corrupt: ${resolution.reason}`, {
        code: "document.identity-corrupt",
        exitCode: 2,
      });
    case "path-invalid":
      return fail(`document path is invalid: ${resolution.reason}`, {
        code: "document.path-invalid",
        exitCode: 2,
      });
  }
}

function mediaTypeFor(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".json") || lower.endsWith(".excalidraw")) return "application/json";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".txt") || lower.endsWith(".log")) return "text/plain";
  return "application/octet-stream";
}

function collaborationLabel(body: Readonly<Record<string, unknown>>, fallback: string): string {
  for (const key of ["comment", "text", "message", "instruction", "summary", "reason"]) {
    const value = body[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return fallback;
}

async function requireManagedWhiteboardDaemon(): Promise<DaemonConnection> {
  const connection = await discoverDaemon(rootPath());
  if (connection) return connection;
  throw new WhiteboardWorkspaceError(
    "whiteboard.workspace-daemon-unavailable",
    "daemon is not running",
  );
}

function reportManagedWhiteboardError(error: unknown): void {
  const workspaceError =
    error instanceof WhiteboardWorkspaceError
      ? error
      : new WhiteboardWorkspaceError(
          "whiteboard.workspace-request-failed",
          error instanceof Error ? error.message : String(error),
        );
  const recovery = managedWhiteboardRecovery(workspaceError.code);
  if (globals().json) {
    emitJson({
      protocol: CLI_PROTOCOL,
      status: "error",
      code: workspaceError.code,
      message: workspaceError.message,
      details: workspaceError.details,
      recovery,
    });
  } else {
    info(`error: ${workspaceError.code}: ${workspaceError.message}`);
    info(`recovery: ${recovery}`);
  }
  process.exitCode = managedWhiteboardConflictCode(workspaceError.code) ? 2 : 1;
}

function reportAuthoringCommandError(error: unknown, fallbackCode: string): void {
  if (error instanceof CliFailure) throw error;
  const known = error instanceof AuthoringAnalysisError;
  const code = known ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  const details = known ? error.details : {};
  if (globals().json) {
    emitJson({
      protocol: CLI_PROTOCOL,
      status: "error",
      code,
      message,
      details,
    });
    process.exitCode = 1;
    return;
  }
  fail(`${code}: ${message}`);
}

async function runSemanticSceneMutation(
  input: Readonly<{
    document: string;
    sessionId: string;
    idempotencyKey: string;
    operation: SemanticSceneOperation;
  }>,
): Promise<void> {
  const connection = await discoverDaemon(rootPath());
  if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
  const artifactId = await resolveArtifactId(connection, input.document);
  const sessionRecord = (await getSession(connection, input.sessionId)).session;
  if (sessionRecord.status !== "active") {
    fail(`session ${input.sessionId} is not active`, {
      code: "whiteboard.session-inactive",
      details: { sessionId: input.sessionId, status: sessionRecord.status },
    });
  }
  const attached = sessionRecord.artifacts.find((item) => item.artifactId === artifactId);
  if (!attached) {
    fail(`artifact ${artifactId} is not attached to session ${input.sessionId}`, {
      code: "whiteboard.session-artifact-missing",
      details: { sessionId: input.sessionId, artifactId },
    });
  }
  if (attached.format !== "whiteboard") {
    fail(`artifact ${artifactId} is not a whiteboard`, {
      code: "whiteboard.artifact-format-invalid",
      details: { artifactId, format: attached.format },
    });
  }
  const custody = (() => {
    try {
      return loadRuntimeCapability({
        workspaceId: connection.descriptor.workspaceId,
        workspaceRoot: rootPath(),
        daemonStartNonce: connection.descriptor.startNonce,
        sessionId: input.sessionId,
        agentId: sessionRecord.agentId,
        processNonce: sessionRecord.processNonce,
      });
    } catch (error) {
      if (
        error instanceof RuntimeCapabilityError &&
        error.code === "runtime-capability.scope-mismatch" &&
        error.details.reason === "daemon-generation-changed"
      ) {
        const recoveryArgs = [
          "session",
          "resume",
          input.sessionId,
          "--agent",
          sessionRecord.agentId,
          "--process",
          sessionRecord.processNonce,
          "--json",
        ];
        fail("daemon generation changed; resume the session before mutating the semantic scene", {
          code: "runtime-capability.daemon-generation-changed",
          retryable: false,
          details: {
            mutated: false,
            sessionId: input.sessionId,
            artifactId,
            agentId: sessionRecord.agentId,
          },
          nextAction: {
            kind: "resume-session",
            command: renderInvocation(invocation, recoveryArgs),
            purpose:
              "create a generation-bound successor, then retry the scene command with its sessionId",
            predecessorSessionId: input.sessionId,
            artifactId,
          },
        });
      }
      throw error;
    }
  })();
  const request: SemanticSceneRequest = {
    protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
    artifactId,
    idempotencyKey: input.idempotencyKey,
    operations: [input.operation],
  };
  const result = await applyWhiteboardSemanticScene(connection, {
    sessionId: input.sessionId,
    runtimeCapability: custody.capability,
    request,
  });
  if (globals().json) emitJson(result);
  else {
    info(
      result.unchanged
        ? `semantic scene unchanged at draft v${result.draftVersion}`
        : `semantic scene updated to draft v${result.draftVersion}`,
    );
  }
}

function finiteOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    fail(`${name} must be a finite number`, {
      code: "whiteboard.scene-option-invalid",
      exitCode: 2,
      details: { option: name },
    });
  }
  return parsed;
}

async function protectionContext(
  connection: DaemonConnection,
  snapshot: Awaited<ReturnType<typeof getSnapshot>>,
  artifactId: string | null,
): Promise<ProtectionContext> {
  return {
    artifactId,
    intents: snapshot.intents,
    events: artifactId === null ? [] : await listEvents(connection, 0),
  };
}

function candidateAnchorIds(path: string, format: "html" | "markdown"): string[] {
  return extractSemanticIndex(format, readFileSync(path)).nodes.map((node) => node.id);
}

function managedWhiteboardConflictCode(code: string): boolean {
  return (
    code.includes("conflict") ||
    code.includes("ambiguous") ||
    code.includes("pending") ||
    code.includes("stale")
  );
}

function managedWhiteboardRecovery(code: string): string {
  switch (code) {
    case "whiteboard.workspace-daemon-unavailable":
      return `start the daemon with ${renderInvocation(invocation, ["daemon", "start"])}, then retry the same command`;
    case "whiteboard.workspace-exists":
      return "choose an empty .excalidraw path; existing working files and sidecars are never replaced";
    case "whiteboard.workspace-ambiguous-sync":
      return "restore the bytes from the pending sync and retry; otherwise check out a fresh path and reconcile explicitly";
    case "whiteboard.workspace-conflicted":
    case "whiteboard.draft-conflict":
      return `inspect ${renderInvocation(invocation, ["whiteboard", "conflicts", "<artifactId>"])} and resolve deliberately, or check out a fresh path; never overwrite silently`;
    case "whiteboard.workspace-unsynced":
    case "whiteboard.workspace-needs-sync":
      return `run ${renderInvocation(invocation, ["whiteboard", "workspace", "sync", "<path>"])} before publishing`;
    case "whiteboard.workspace-pending-sync":
      return `retry ${renderInvocation(invocation, ["whiteboard", "workspace", "sync", "<path>"])} with the unchanged working bytes`;
    case "whiteboard.workspace-published":
      return "check out the current head to a new working path before editing again";
    case "whiteboard.workspace-target-missing":
    case "whiteboard.workspace-target-replaced":
    case "whiteboard.workspace-target-anchor-replaced":
      return "restore each selected element's original ID, type, and collaboration anchor; use explicit conflict resolution for intentional deletion";
    case "whiteboard.workspace-binding-mismatch":
      return "use the sidecar generated beside this exact working file in this daemon workspace";
    default:
      return "no local CAS state was advanced without an accepted response; inspect daemon status and retry only when the failure is understood";
  }
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

const newArtifact = program
  .command("new")
  .description("create a local artifact from a packaged starter without starting the daemon");

newArtifact
  .command("plan <path>")
  .description("create a new HTML plan from the packaged starter without overwriting")
  .action((path: string) => {
    try {
      const receipt = createPlanScaffold(path);
      const result = {
        protocol: CLI_PROTOCOL,
        ...receipt,
        next: {
          edit: "replace every [[PLACEHOLDER]] with domain content",
          lintCommand: renderInvocation(invocation, ["lint", receipt.path, "--json"]),
          checkCommand: renderInvocation(invocation, ["check", receipt.path, "--json"]),
        },
      };
      if (globals().json) emitJson(result);
      else {
        info(`created plan: ${receipt.path}`);
        info(`next: ${result.next.edit}`);
        info(`lint: ${result.next.lintCommand}`);
        info(`check: ${result.next.checkCommand}`);
      }
    } catch (error) {
      if (!(error instanceof PlanScaffoldError)) throw error;
      if (globals().json) {
        emitJson({
          protocol: CLI_PROTOCOL,
          status: "error",
          code: error.code,
          message: error.message,
          details: error.details,
        });
        process.exitCode = 1;
        return;
      }
      fail(`${error.code}: ${error.message}`);
    }
  });

program
  .command("lint <path>")
  .description("analyze HTML or Markdown semantic identity without starting the daemon")
  .option("--summary", "emit fixed semantic and protection counts without per-node findings")
  .action(async (path: string, opts: { summary?: boolean }) => {
    try {
      const result = lintArtifactFile(path);
      const output = opts.summary
        ? await (async () => {
            const connection = await discoverDaemon(rootPath());
            if (!connection) {
              throw new AuthoringAnalysisError(
                "lint.daemon-unavailable",
                "daemon is not running; lint summary requires exact protected-anchor state",
              );
            }
            const snapshot = await getSnapshot(connection);
            const resolution = resolveDocumentReference(
              snapshot.artifacts,
              result.path,
              rootPath(),
            );
            const artifactId =
              resolution.status === "unregistered"
                ? null
                : requireRegisteredDocument(resolution, result.path);
            return summarizeArtifactLint(
              result,
              candidateAnchorIds(result.path, result.format),
              await protectionContext(connection, snapshot, artifactId),
            );
          })()
        : result;
      if (globals().json) emitJson({ protocol: CLI_PROTOCOL, ...output });
      else if (opts.summary) {
        const counts = (output as ReturnType<typeof summarizeArtifactLint>).counts;
        info(
          `${output.status}: ${counts.nodes} nodes, ${counts.protectedAnchors} protected, ${counts.errors} errors, ${counts.warnings} warnings`,
        );
      } else {
        info(
          `${result.status}: ${result.nodeCount} semantic nodes, ${result.errorCount} errors, ${result.warningCount} warnings`,
        );
        for (const finding of result.findings) {
          info(`${finding.severity}: ${finding.code}: ${finding.message}`);
        }
      }
      if (output.status === "fail") process.exitCode = 1;
    } catch (error) {
      reportAuthoringCommandError(error, "lint.failed");
    }
  });

program
  .command("diff <path>")
  .description("compare a candidate semantic index with its immutable head or an empty baseline")
  .option("--artifact <id-or-path>", "artifact identity when source-path resolution is unavailable")
  .option("--summary", "emit fixed semantic and protection counts without per-node changes")
  .action(async (path: string, opts: { artifact?: string; summary?: boolean }) => {
    try {
      const candidatePath = resolve(path);
      const candidateFormat = semanticFormatForPath(candidatePath);
      const connection = await discoverDaemon(rootPath());
      if (!connection) {
        throw new AuthoringAnalysisError(
          "diff.daemon-unavailable",
          "daemon is not running; diff requires the immutable artifact head",
        );
      }
      const snapshot = await getSnapshot(connection);
      const artifactSelector = opts.artifact ?? candidatePath;
      const resolution = resolveDocumentReference(snapshot.artifacts, artifactSelector, rootPath());
      let result: ArtifactDiffReceipt;
      if (resolution.status === "unregistered" && opts.artifact === undefined) {
        result = diffNewArtifactBytes(candidatePath);
      } else {
        const artifactId = requireRegisteredDocument(resolution, artifactSelector);
        const head = snapshot.revisions
          .filter((revision) => revision.artifactId === artifactId)
          .sort((left, right) => left.seq - right.seq)
          .at(-1);
        if (!head) {
          throw new AuthoringAnalysisError(
            "diff.head-unavailable",
            `artifact has no immutable revision: ${artifactId}`,
            { artifactId },
          );
        }
        if (head.format !== candidateFormat) {
          throw new AuthoringAnalysisError(
            "diff.format-mismatch",
            `candidate ${candidateFormat} cannot be compared with ${head.format} head`,
            { artifactId, revisionId: head.revisionId },
          );
        }
        const before = await fetchRevisionSource(connection, head.revisionId);
        result = diffArtifactBytes({
          path: candidatePath,
          artifactId,
          beforeRevisionId: head.revisionId,
          before,
        });
      }
      const output = opts.summary
        ? summarizeArtifactDiff(
            result,
            await protectionContext(connection, snapshot, result.artifactId),
          )
        : result;
      if (globals().json) emitJson({ protocol: CLI_PROTOCOL, ...output });
      else if (opts.summary) {
        const counts = (output as ReturnType<typeof summarizeArtifactDiff>).counts;
        info(
          `${output.status}: +${counts.added} -${counts.removed} ~${counts.changed} moved:${counts.moved} kind:${counts.kindChanged} protected-loss:${counts.protectedLosses} protected-change:${counts.protectedChanges}`,
        );
      } else {
        info(
          `${result.status}: +${result.added.length} -${result.removed.length} ~${result.changed.length} moved:${result.moved.length} kind:${result.kindChanged.length}`,
        );
        for (const rename of result.possibleRenames) {
          info(`possible rename only: ${rename.removedId} -> ${rename.addedId}`);
        }
      }
      if (output.status === "fail") process.exitCode = 1;
    } catch (error) {
      reportAuthoringCommandError(error, "diff.failed");
    }
  });

program
  .command("check <path>")
  .description("render HTML or Markdown in Chromium and enforce the browser quality contract")
  .action(async (path: string) => {
    try {
      const lint = lintArtifactFile(path);
      const result = await checkArtifact(lint.path, lint.findings);
      const sourcePlaceholderCount = lint.findings.filter(
        (finding) => finding.code === "template.placeholder",
      ).length;
      const browserIndependentErrors = lint.findings.filter(
        (finding) => finding.severity === "error" && finding.code !== "template.placeholder",
      ).length;
      if (globals().json) {
        emitJson({
          protocol: CLI_PROTOCOL,
          ...result,
          lint: {
            nodeCount: lint.nodeCount,
            browserIndependentErrorCount: browserIndependentErrors,
            warningCount: lint.warningCount,
            sourcePlaceholderCount,
          },
        });
      } else {
        info(
          `${result.status}: ${result.testedViewports.length} viewports, ${result.findingCount} findings (axe-core contrast)`,
        );
        for (const finding of result.findings) {
          const at = finding.viewport
            ? ` @ ${finding.viewport.width}x${finding.viewport.height}`
            : "";
          info(`${finding.severity}: ${finding.code}${at}: ${finding.message}`);
        }
      }
      if (result.status === "fail") process.exitCode = 1;
    } catch (error) {
      reportAuthoringCommandError(error, "check.failed");
    }
  });

const whiteboard = program
  .command("whiteboard")
  .description("live Excalidraw drafts shared by the human and agent");

const whiteboardScene = whiteboard
  .command("scene")
  .description("semantic whiteboard edits without renderer-specific JSON");

whiteboardScene
  .command("add-node <document> <semanticKey>")
  .description("add or update one semantic node")
  .requiredOption("--session <id>", "active session that owns the runtime capability")
  .requiredOption("--idempotency-key <key>", "visible stable business retry key")
  .option("--shape <shape>", "rectangle, ellipse, or diamond")
  .option("--label <text>", "semantic node label")
  .option("--x <number>", "semantic placement x coordinate")
  .option("--y <number>", "semantic placement y coordinate")
  .action(
    async (
      document: string,
      semanticKey: string,
      opts: {
        session: string;
        idempotencyKey: string;
        shape?: string;
        label?: string;
        x?: string;
        y?: string;
      },
    ) => {
      if (opts.shape && !["rectangle", "ellipse", "diamond"].includes(opts.shape)) {
        fail("--shape must be rectangle, ellipse, or diamond", {
          code: "whiteboard.scene-option-invalid",
          exitCode: 2,
          details: { option: "--shape" },
        });
      }
      if ((opts.x === undefined) !== (opts.y === undefined)) {
        fail("--x and --y must be supplied together", {
          code: "whiteboard.scene-option-invalid",
          exitCode: 2,
          details: { options: ["--x", "--y"] },
        });
      }
      const x = finiteOption(opts.x, "--x");
      const y = finiteOption(opts.y, "--y");
      await runSemanticSceneMutation({
        document,
        sessionId: opts.session,
        idempotencyKey: opts.idempotencyKey,
        operation: {
          type: "node.upsert",
          semanticKey,
          ...(opts.shape ? { shape: opts.shape as "rectangle" | "ellipse" | "diamond" } : {}),
          ...(opts.label !== undefined ? { label: opts.label } : {}),
          ...(x !== undefined && y !== undefined ? { placement: { x, y } } : {}),
        },
      });
    },
  );

whiteboardScene
  .command("add-edge <document> <semanticKey>")
  .description("add or update one semantic edge")
  .requiredOption("--session <id>", "active session that owns the runtime capability")
  .requiredOption("--idempotency-key <key>", "visible stable business retry key")
  .requiredOption("--from <semanticKey>", "source semantic node")
  .requiredOption("--to <semanticKey>", "target semantic node")
  .option("--label <text>", "semantic edge label")
  .action(
    async (
      document: string,
      semanticKey: string,
      opts: {
        session: string;
        idempotencyKey: string;
        from: string;
        to: string;
        label?: string;
      },
    ) => {
      await runSemanticSceneMutation({
        document,
        sessionId: opts.session,
        idempotencyKey: opts.idempotencyKey,
        operation: {
          type: "edge.upsert",
          semanticKey,
          from: opts.from,
          to: opts.to,
          ...(opts.label !== undefined ? { label: opts.label } : {}),
        },
      });
    },
  );

whiteboardScene
  .command("set-label <document> <target>")
  .description("set or clear one semantic node or edge label")
  .requiredOption("--session <id>", "active session that owns the runtime capability")
  .requiredOption("--idempotency-key <key>", "visible stable business retry key")
  .option("--text <text>", "new label text")
  .option("--clear", "remove the label", false)
  .action(
    async (
      document: string,
      target: string,
      opts: { session: string; idempotencyKey: string; text?: string; clear: boolean },
    ) => {
      if ((opts.text === undefined) === !opts.clear) {
        fail("provide exactly one of --text or --clear", {
          code: "whiteboard.scene-option-invalid",
          exitCode: 2,
          details: { options: ["--text", "--clear"] },
        });
      }
      await runSemanticSceneMutation({
        document,
        sessionId: opts.session,
        idempotencyKey: opts.idempotencyKey,
        operation: { type: "label.set", target, text: opts.clear ? null : (opts.text ?? "") },
      });
    },
  );

whiteboardScene
  .command("group <document> <semanticKey>")
  .description("set semantic group membership and render its enclosure")
  .requiredOption("--session <id>", "active session that owns the runtime capability")
  .requiredOption("--idempotency-key <key>", "visible stable business retry key")
  .requiredOption("--members <semanticKey...>", "semantic members")
  .action(
    async (
      document: string,
      semanticKey: string,
      opts: { session: string; idempotencyKey: string; members: string[] },
    ) => {
      await runSemanticSceneMutation({
        document,
        sessionId: opts.session,
        idempotencyKey: opts.idempotencyKey,
        operation: { type: "group.set", semanticKey, members: opts.members },
      });
    },
  );

whiteboardScene
  .command("layout <document>")
  .description("apply deterministic semantic layout")
  .requiredOption("--session <id>", "active session that owns the runtime capability")
  .requiredOption("--idempotency-key <key>", "visible stable business retry key")
  .option("--direction <direction>", "left-to-right (lr) or top-to-bottom (tb)")
  .option("--gap <number>", "semantic node gap")
  .option("--scope <semanticKey...>", "semantic entities to lay out")
  .action(
    async (
      document: string,
      opts: {
        session: string;
        idempotencyKey: string;
        direction?: string;
        gap?: string;
        scope?: string[];
      },
    ) => {
      if (opts.direction && opts.direction !== "lr" && opts.direction !== "tb") {
        fail("--direction must be lr or tb", {
          code: "whiteboard.scene-option-invalid",
          exitCode: 2,
          details: { option: "--direction" },
        });
      }
      const gap = finiteOption(opts.gap, "--gap");
      await runSemanticSceneMutation({
        document,
        sessionId: opts.session,
        idempotencyKey: opts.idempotencyKey,
        operation: {
          type: "layout.apply",
          ...(opts.direction ? { direction: opts.direction as "lr" | "tb" } : {}),
          ...(gap !== undefined ? { gap } : {}),
          ...(opts.scope ? { scope: opts.scope } : {}),
        },
      });
    },
  );

whiteboardScene
  .command("inspect <document>")
  .description("inspect the current semantic map without exposing renderer JSON")
  .action(async (document: string) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const artifactId = await resolveArtifactId(connection, document);
    const draft = await getWhiteboardDraft(connection, artifactId);
    const canonical = canonicalizeWhiteboardScene(
      await fetchWhiteboardObject(connection, draft.sceneHash),
    );
    if (canonical.hash !== draft.sceneHash) {
      fail("whiteboard draft bytes do not match the advertised scene hash", {
        code: "whiteboard.scene-hash-mismatch",
        details: { artifactId },
      });
    }
    const semanticMap = readSemanticSceneMap(canonical.scene) ?? emptySemanticSceneMap();
    const output = projectWhiteboardSceneInspect(artifactId, semanticMap);
    if (globals().json) emitJson(output);
    else {
      info(
        `${output.scene.nodes.length} semantic nodes, ${output.scene.edges.length} semantic edges, ${output.scene.groups.length} groups`,
      );
    }
  });

whiteboardScene
  .command("publish <document>")
  .description("publish the exact currently observed semantic draft")
  .requiredOption("--idempotency-key <key>", "visible stable business retry key")
  .option("--agent <id>", "publishing agent identity", defaultAgentId())
  .action(async (document: string, opts: { idempotencyKey: string; agent: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const artifactId = await resolveArtifactId(connection, document);
    const draft = await getWhiteboardDraft(connection, artifactId);
    const agentId = canonicalAgentId(opts.agent);
    const identity = {
      artifactId,
      draftId: draft.draftId,
      expectedDraftVersion: draft.draftVersion,
      expectedHeadRevisionId: draft.baseRevisionId,
      idempotencyKey: opts.idempotencyKey,
      agentId,
    };
    const result = await publishWhiteboardDraft(connection, {
      ...identity,
      commandId: stableCliIdentity("whiteboard-scene-publish-command", identity),
      revisionId: stableCliIdentity("whiteboard-scene-revision", identity),
    });
    if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
    const response = result.response as Record<string, unknown>;
    if (globals().json) {
      emitJson({ protocol: "tweakloop.whiteboard-scene-publish/v1", ...response });
    } else {
      info(`published semantic whiteboard revision ${String(response.revisionId ?? "")}`);
    }
  });

const whiteboardDraft = whiteboard
  .command("draft")
  .description("get or compare-and-swap a live whiteboard draft");

const whiteboardWorkspace = whiteboard
  .command("workspace")
  .description("managed checkout, sync, and publish workflow for agents");

whiteboardWorkspace
  .command("checkout <artifactId> <path>")
  .description("check out the current draft with an opaque local sync-state sidecar")
  .option("--agent <id>", "agent identity", defaultAgentId())
  .option(
    "--target-element <id...>",
    "existing element IDs whose collaboration identity must be preserved",
  )
  .action(
    async (artifactId: string, path: string, opts: { agent: string; targetElement?: string[] }) => {
      try {
        const connection = await requireManagedWhiteboardDaemon();
        const result = await new ManagedWhiteboardWorkspace(connection).checkout({
          artifactId,
          scenePath: resolve(path),
          agentId: canonicalAgentId(opts.agent),
          targetElementIds: opts.targetElement ?? [],
        });
        const editRoute = nativeEditorRoute(result.scenePath);
        if (globals().json) emitJson({ protocol: CLI_PROTOCOL, ...result, editRoute });
        else {
          info(
            `checked out ${result.artifactId} draft v${result.draftVersion} to ${result.scenePath}`,
          );
          info(`sync state: ${result.statePath}`);
          info(`edit: ${editRoute.requirement}`);
          info(`blocked: ${editRoute.blocked}`);
          info(
            `then: ${renderInvocation(invocation, ["whiteboard", "workspace", "sync", result.scenePath, "--json"])}`,
          );
        }
      } catch (error) {
        reportManagedWhiteboardError(error);
      }
    },
  );

whiteboardWorkspace
  .command("sync <path>")
  .description("CAS-sync a checked-out .excalidraw file using its local state")
  .action(async (path: string) => {
    try {
      const connection = await requireManagedWhiteboardDaemon();
      const result = await new ManagedWhiteboardWorkspace(connection).sync(resolve(path));
      if (globals().json) emitJson({ protocol: CLI_PROTOCOL, ...result });
      else if (result.status === "conflict") {
        info(
          `draft conflict ${result.conflict.conflictId}: current v${result.conflict.currentDraftVersion}; submitted scene retained as ${result.conflict.submittedSceneHash}`,
        );
        info(`recovery: ${result.recovery}`);
      } else {
        info(`synced draft v${result.draftVersion} (${result.sceneHash})`);
      }
      if (result.status === "conflict") process.exitCode = 2;
    } catch (error) {
      reportManagedWhiteboardError(error);
    }
  });

whiteboardWorkspace
  .command("publish <path>")
  .description("publish the exact draft observed by a managed working file")
  .action(async (path: string) => {
    try {
      const connection = await requireManagedWhiteboardDaemon();
      const result = await new ManagedWhiteboardWorkspace(connection).publish(resolve(path));
      if (globals().json) emitJson({ protocol: CLI_PROTOCOL, ...result });
      else {
        info(
          result.unchanged
            ? `already published as ${result.revisionId}`
            : `published whiteboard revision ${result.revisionId}`,
        );
      }
    } catch (error) {
      reportManagedWhiteboardError(error);
    }
  });

whiteboardDraft
  .command("get <artifactId>")
  .description("inspect current draft metadata and optionally write the canonical scene")
  .option("--output <path>", "destination .excalidraw file")
  .action(async (artifactId: string, opts: { output?: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const draft = await getWhiteboardDraft(connection, artifactId);
    if (!opts.output) {
      if (globals().json) emitJson({ ...draft, protocol: CLI_PROTOCOL });
      else {
        info(
          `draft v${draft.draftVersion} (${draft.sceneHash}), base ${draft.baseRevisionId}, id ${draft.draftId}`,
        );
      }
      return;
    }
    const bytes = await fetchWhiteboardObject(connection, draft.sceneHash);
    const output = resolve(opts.output);
    writeFileSync(output, bytes);
    if (globals().json) {
      emitJson({ ...draft, protocol: CLI_PROTOCOL, output, byteLength: bytes.length });
    } else {
      info(`wrote draft v${draft.draftVersion} (${draft.sceneHash}) to ${output}`);
    }
  });

whiteboardDraft
  .command("put <artifactId> <path>")
  .description("CAS-update a live draft from a canonicalized .excalidraw file")
  .requiredOption("--draft-id <id>", "stable draft id")
  .requiredOption("--base-revision <id>", "published revision the draft started from")
  .requiredOption("--expected-version <n>", "current draft version (0 initializes)")
  .requiredOption("--client-id <id>", "stable writer process id")
  .requiredOption("--client-sequence <n>", "monotonic request sequence")
  .option("--agent <id>", "agent identity", defaultAgentId())
  .action(
    async (
      artifactId: string,
      path: string,
      opts: {
        draftId: string;
        baseRevision: string;
        expectedVersion: string;
        clientId: string;
        clientSequence: string;
        agent: string;
      },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const source = resolve(path);
      if (!existsSync(source)) fail(`whiteboard file not found: ${source}`);
      const result = await putWhiteboardDraft(connection, {
        artifactId,
        draftId: opts.draftId,
        baseRevisionId: opts.baseRevision,
        expectedDraftVersion: Number(opts.expectedVersion),
        clientId: opts.clientId,
        clientSequence: Number(opts.clientSequence),
        agentId: opts.agent,
        bytes: readFileSync(source),
      });
      if (globals().json) emitJson({ ...result, protocol: CLI_PROTOCOL });
      if (result.status === "conflict") {
        if (!globals().json) {
          info(
            `draft conflict ${result.conflictId}: current v${result.currentDraftVersion}; submitted scene retained as ${result.submittedSceneHash}`,
          );
        }
        process.exitCode = 2;
        return;
      }
      if (!globals().json) {
        info(`draft ${result.draftId} is now v${result.draftVersion} (${result.sceneHash})`);
      }
    },
  );

whiteboard
  .command("publish <artifactId>")
  .description("publish one observed draft version as an ordinary immutable revision")
  .requiredOption("--draft-id <id>", "draft id")
  .requiredOption("--expected-draft-version <n>", "observed draft version")
  .requiredOption("--expected-head <revisionId>", "observed artifact head")
  .option("--agent <id>", "agent identity", defaultAgentId())
  .option("--idempotency-key <key>", "stable retry key")
  .action(
    async (
      artifactId: string,
      opts: {
        draftId: string;
        expectedDraftVersion: string;
        expectedHead: string;
        agent: string;
        idempotencyKey?: string;
      },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const commandId = `cmd_${randomUUID()}`;
      const result = await publishWhiteboardDraft(connection, {
        artifactId,
        draftId: opts.draftId,
        expectedDraftVersion: Number(opts.expectedDraftVersion),
        expectedHeadRevisionId: opts.expectedHead,
        revisionId: `rev_${randomUUID()}`,
        agentId: opts.agent,
        commandId,
        idempotencyKey: opts.idempotencyKey ?? `whiteboard.publish:${commandId}`,
      });
      if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
      const response = result.response as {
        revisionId: string;
        seq: number;
        unchanged: boolean;
        sceneHash: string;
      };
      if (globals().json) {
        emitJson({ protocol: CLI_PROTOCOL, ...response });
      } else {
        info(
          response.unchanged
            ? `draft already published as revision ${response.seq} (${response.revisionId})`
            : `published whiteboard revision ${response.seq} (${response.revisionId})`,
        );
      }
    },
  );

whiteboard
  .command("conflicts <artifactId>")
  .description("list retained whiteboard draft conflicts")
  .action(async (artifactId: string) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const result = await listWhiteboardConflicts(connection, artifactId);
    if (globals().json) {
      emitJson({ ...result, protocol: CLI_PROTOCOL });
    } else {
      for (const conflict of result.conflicts as {
        conflictId: string;
        currentVersion: number;
        resolvedAt: string | null;
      }[]) {
        info(
          `${conflict.conflictId}  v${conflict.currentVersion}  ${conflict.resolvedAt ? "resolved" : "open"}`,
        );
      }
      if (result.conflicts.length === 0) info("no whiteboard conflicts");
    }
  });

whiteboard
  .command("resolve <artifactId> <conflictId> <path>")
  .description("resolve a conflict with a new explicit CAS scene")
  .requiredOption("--draft-id <id>", "current draft id")
  .requiredOption("--base-revision <id>", "current draft base")
  .requiredOption("--expected-version <n>", "current draft version")
  .requiredOption("--client-id <id>", "stable writer process id")
  .requiredOption("--client-sequence <n>", "new monotonic request sequence")
  .option("--agent <id>", "agent identity", defaultAgentId())
  .action(
    async (
      artifactId: string,
      conflictId: string,
      path: string,
      opts: {
        draftId: string;
        baseRevision: string;
        expectedVersion: string;
        clientId: string;
        clientSequence: string;
        agent: string;
      },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const source = resolve(path);
      if (!existsSync(source)) fail(`whiteboard file not found: ${source}`);
      const result = await putWhiteboardDraft(connection, {
        artifactId,
        draftId: opts.draftId,
        baseRevisionId: opts.baseRevision,
        expectedDraftVersion: Number(opts.expectedVersion),
        clientId: opts.clientId,
        clientSequence: Number(opts.clientSequence),
        agentId: opts.agent,
        bytes: readFileSync(source),
        conflictId,
      });
      if (result.status === "conflict") {
        if (globals().json) emitJson({ ...result, protocol: CLI_PROTOCOL });
        else info(`resolution raced with draft v${result.currentDraftVersion}`);
        process.exitCode = 2;
        return;
      }
      if (globals().json) emitJson({ ...result, protocol: CLI_PROTOCOL });
      else info(`resolved ${conflictId} as draft v${result.draftVersion}`);
    },
  );

program
  .command("open <path>")
  .description("register an artifact and open the review shell")
  .option("--no-browser", "print the bootstrap URL instead of launching a browser")
  .option("--agent <id>", "agent that owns this live review session", defaultAgentId())
  .option("--session <id>", "stable session id (generated when omitted)")
  .option("--role <role>", "existing-session attachment role: primary, opened, or whiteboard")
  .option("--process <nonce>", "agent process correlation nonce")
  .option("--title <text>", "session title")
  .option("--goal <text>", "session goal")
  .action(
    async (
      path: string,
      opts: {
        browser: boolean;
        agent: string;
        session?: string;
        role?: string;
        process?: string;
        title?: string;
        goal?: string;
      },
    ) => {
      const root = rootPath();
      ensureProjectConfig(root);
      const connection = await ensureDaemon(root);
      const agentId = canonicalAgentId(opts.agent);

      if (opts.session) {
        if (opts.title !== undefined || opts.goal !== undefined) {
          fail("--title and --goal only apply when creating a new session", {
            code: "session.open-option-conflict",
            exitCode: 2,
          });
        }
        const existing = (await getSession(connection, opts.session)).session;
        if (opts.process !== undefined && opts.process !== existing.processNonce) {
          fail(
            `--process ${opts.process} conflicts with session process ${existing.processNonce}`,
            {
              code: "session.process-conflict",
              exitCode: 2,
            },
          );
        }
        const sourcePath = resolve(path);
        const role = sessionArtifactRole(opts.role);
        const actor = agentActor(agentId);
        const expectedContentSha256 = contentSha256(readFileSync(sourcePath));
        const requestId = stableCliIdentity("request", {
          operation: "session.open-artifact",
          sessionId: opts.session,
          path: sourcePath,
          contentSha256: expectedContentSha256,
          role,
          actor,
        });
        const opened = await openArtifactInSession(connection, {
          sessionId: opts.session,
          path: sourcePath,
          requestId,
          expectedContentSha256,
          role,
          actor,
        });
        const minted = await mintSessionUrl(connection, {
          sessionId: opts.session,
          artifactId: opened.artifactId,
          agentId: existing.agentId,
        });
        presentReviewUrl(minted.url, opts.browser);
        const nextCommand = renderInvocation(invocation, [
          "next",
          "--session",
          opts.session,
          "--wait",
          "--timeout",
          "300000",
          "--json",
        ]);
        const listenCommand = renderInvocation(invocation, [
          "session",
          "listen",
          "--session",
          opts.session,
        ]);
        if (globals().json) {
          emitJson({
            ...opened,
            protocol: CLI_PROTOCOL,
            workspaceId: connection.descriptor.workspaceId,
            requestId,
            agentId: minted.agentId,
            processNonce: existing.processNonce,
            url: minted.url,
            nextCommand,
            listenCommand,
          });
        } else {
          info(
            opened.unchanged
              ? `revision ${opened.seq} unchanged`
              : `published revision ${opened.seq}`,
          );
          info(`receive one item: ${nextCommand}`);
          info(`persistent stream only: ${listenCommand}`);
        }
        return;
      }

      if (opts.role !== undefined) {
        fail("--role requires --session", {
          code: "session.open-option-conflict",
          exitCode: 2,
        });
      }
      const sourcePath = resolve(path);
      const title = opts.title ?? basename(sourcePath);
      const goal = opts.goal ?? `Review and iterate ${basename(sourcePath)}`;
      const retryCommand = renderInvocation(invocation, [
        "open",
        sourcePath,
        "--agent",
        agentId,
        ...(opts.process ? ["--process", opts.process] : []),
        "--title",
        title,
        "--goal",
        goal,
        ...(opts.browser ? [] : ["--no-browser"]),
        "--json",
      ]);
      preflightRuntimeCapabilityCustody({
        workspaceId: connection.descriptor.workspaceId,
        workspaceRoot: root,
      });
      const published = await publishArtifact(connection, sourcePath);

      try {
        const capability = prepareRuntimeCapability({
          workspaceId: connection.descriptor.workspaceId,
          workspaceRoot: root,
          daemonStartNonce: connection.descriptor.startNonce,
          operationIdentity: stableCliIdentity("runtime-session-start", {
            sourcePath,
            artifactId: published.artifactId,
            revisionId: published.revisionId,
            agentId,
            requestedSessionId: opts.session ?? null,
            requestedProcessNonce: opts.process ?? null,
            title,
            goal,
          }),
          agentId,
          ...(opts.session ? { sessionId: opts.session } : {}),
          ...(opts.process ? { processNonce: opts.process } : {}),
        });
        const { sessionId, processNonce } = capability;
        const start = await postCommand(
          connection,
          envelope(
            connection.descriptor.workspaceId,
            "session.start",
            `session.start:${sessionId}`,
            {
              sessionId,
              artifactId: published.artifactId,
              agentId,
              processNonce,
              runtimeCapabilityHash: capability.capabilityHash,
              baseRevisionId: published.revisionId,
              title,
              goal,
            },
            agentActor(agentId),
          ),
        );
        if (start.status === "rejected") {
          if (start.code !== "session.duplicate-id") {
            abandonRuntimeCapabilityPreparation(capability);
            fail(`${start.code}: ${start.message}`);
          }
          const existing = (await getSession(connection, sessionId)).session;
          if (
            existing.artifactId !== published.artifactId ||
            existing.agentId !== agentId ||
            existing.processNonce !== processNonce ||
            existing.status !== "active"
          ) {
            abandonRuntimeCapabilityPreparation(capability);
            fail(
              `session ${sessionId} already identifies different or ended work; use ${renderInvocation(invocation, ["session", "show", sessionId])} or ${renderInvocation(invocation, ["session", "resume", sessionId])}`,
            );
          }
        }
        const minted = await mintBootstrap(connection, {
          artifactId: published.artifactId,
          agentId,
          sessionId,
        });
        completeRuntimeCapabilityPreparation(capability);
        const { url } = minted;
        if (!globals().json) {
          info(
            published.unchanged
              ? `revision ${published.seq} unchanged`
              : `published revision ${published.seq}`,
          );
          presentReviewUrl(url, opts.browser);
        }
        if (globals().json) {
          emitJson({
            protocol: CLI_PROTOCOL,
            workspaceId: connection.descriptor.workspaceId,
            ...published,
            agentId: minted.agentId,
            sessionId: minted.sessionId,
            processNonce,
            url,
            nextCommand: renderInvocation(invocation, [
              "next",
              "--session",
              sessionId,
              "--wait",
              "--timeout",
              "300000",
              "--json",
            ]),
            listenCommand: renderInvocation(invocation, [
              "session",
              "listen",
              "--session",
              sessionId,
            ]),
          });
        } else {
          info(
            `receive one item: ${renderInvocation(invocation, ["next", "--session", sessionId, "--wait", "--timeout", "300000", "--json"])}`,
          );
          info(
            `persistent stream only: ${renderInvocation(invocation, ["session", "listen", "--session", sessionId])}`,
          );
        }
      } catch (error) {
        const cause = normalizeCliFailure(error);
        throw new CliFailure(
          `artifact revision ${published.revisionId} committed, but review session setup did not complete: ${cause.message}`,
          {
            code: "open.committed-partial",
            retryable: false,
            details: {
              outcome: "committed-partial",
              mutated: true,
              committed: {
                artifactId: published.artifactId,
                revisionId: published.revisionId,
                seq: published.seq,
                unchanged: published.unchanged,
              },
              cause: {
                code: cause.code,
                message: cause.message,
                retryable: cause.retryable,
              },
            },
            nextAction: {
              kind: "retry-open",
              command: retryCommand,
              artifactId: published.artifactId,
              revisionId: published.revisionId,
            },
          },
        );
      }
    },
  );

program
  .command("publish <path>")
  .description("snapshot the source file as a new immutable revision")
  .option("--agent <id>", "publish as this agent identity")
  .option("--session <id>", "correlate this revision with a durable session")
  .option("--artifact <id>", "publish to this existing session artifact")
  .option("--complete <workId>", "complete claimed work with the exact published revision")
  .option("--summary <text>", "completion summary (required with --complete)")
  .option("--intent-ids <csv>", "comma-separated intent ids addressed by this completion")
  .action(
    async (
      path: string,
      opts: {
        agent?: string;
        session?: string;
        artifact?: string;
        complete?: string;
        summary?: string;
        intentIds?: string;
      },
    ) => {
      if (opts.complete) {
        if (opts.agent || opts.session || opts.artifact) {
          fail(
            "publish-complete.identity-override: --agent, --session, and --artifact are derived from work",
          );
        }
        if (!opts.summary)
          fail("publish-complete.summary-required: --summary is required with --complete");
        const root = rootPath();
        ensureProjectConfig(root);
        const connection = await ensureDaemon(root);
        const source = resolve(path);
        if (!existsSync(source)) fail(`source file not found: ${source}`);
        const snapshot = await getSnapshot(connection);
        const intentIds = opts.intentIds?.split(",").filter(Boolean);
        const outcome = await publishAndComplete(
          {
            snapshot,
            path: source,
            rootPath: root,
            workId: opts.complete,
            summary: opts.summary,
            ...(intentIds ? { intentIds } : {}),
            invocation,
          },
          {
            publish: (context) =>
              publishArtifact(
                connection,
                source,
                agentActor(context.agentId),
                context.sessionId ?? undefined,
                context.sessionId ? context.artifactId : undefined,
              ),
            complete: (context, published) =>
              postCommand(
                connection,
                envelope(
                  connection.descriptor.workspaceId,
                  "work.complete",
                  `work.complete:${context.claimId}`,
                  {
                    workId: context.workId,
                    claimId: context.claimId,
                    agentId: context.agentId,
                    summary: opts.summary,
                    revisionId: published.revisionId,
                    ...(intentIds ? { addressedIntentIds: intentIds } : {}),
                  },
                  agentActor(context.agentId),
                ),
              ),
          },
        );
        if (outcome.kind === "completed") {
          if (globals().json) emitJson({ protocol: CLI_PROTOCOL, ...outcome.receipt });
          else
            info(
              `published ${outcome.receipt.revisionId}; work ${outcome.receipt.workId} ${outcome.receipt.status}`,
            );
          return;
        }
        const failure = {
          protocol: CLI_PROTOCOL,
          status: "error",
          code: outcome.code,
          message: outcome.message,
          published: outcome.receipt,
          recoveryKind: outcome.recoveryKind,
          recoveryCommand: outcome.recoveryCommand,
        };
        if (globals().json) emitJson(failure);
        else {
          info(`error: ${outcome.code}: ${outcome.message}`);
          info(`published revision: ${outcome.receipt.revisionId}`);
          info(`recovery (${outcome.recoveryKind}): ${outcome.recoveryCommand}`);
        }
        process.exitCode = 2;
        return;
      }
      if (opts.summary || opts.intentIds) {
        fail("publish-complete.option-without-work: --summary and --intent-ids require --complete");
      }
      if (opts.artifact && !opts.session) {
        fail("--artifact requires --session so imported document identity stays session-scoped");
      }
      const root = rootPath();
      ensureProjectConfig(root);
      const connection = await ensureDaemon(root);
      const sessionContext = opts.session
        ? resolveSessionAgentContext((await getSession(connection, opts.session)).session, {
            ...(opts.agent ? { agentId: canonicalAgentId(opts.agent) } : {}),
          })
        : null;
      const actor = sessionContext
        ? agentActor(sessionContext.agentId)
        : opts.agent
          ? agentActor(opts.agent)
          : undefined;
      const published = await publishArtifact(
        connection,
        resolve(path),
        actor,
        opts.session,
        opts.artifact,
      );
      if (globals().json) {
        emitJson({ protocol: CLI_PROTOCOL, ...published });
      } else {
        info(
          published.unchanged
            ? `unchanged — still revision ${published.seq} (${published.revisionId})`
            : `published revision ${published.seq} (${published.revisionId})`,
        );
      }
    },
  );

program
  .command("status")
  .description("report daemon health and workspace projections")
  .option("--summary", "emit compact health and identity fields instead of the full snapshot")
  .action(async (opts: { summary?: boolean }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) {
      if (globals().json) {
        emitJson({ protocol: CLI_PROTOCOL, daemon: "stopped" });
      } else {
        info(
          `daemon: stopped (start one with ${renderInvocation(invocation, ["open", "<path>"])} or ${renderInvocation(invocation, ["daemon", "start"])})`,
        );
      }
      return;
    }
    const snapshot = await getSnapshot(connection);
    if (globals().json && opts.summary) {
      emitJson({
        protocol: CLI_PROTOCOL,
        daemon: "running",
        workspaceId: snapshot.workspace.workspaceId,
        projectId: snapshot.workspace.projectId,
        artifactCount: snapshot.artifacts.length,
        lastSeq: snapshot.lastSeq,
      });
    } else if (globals().json) {
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
      if (globals().json) {
        emitJson({ protocol: CLI_PROTOCOL, daemon: "stopped", alreadyStopped: true });
      } else {
        info("daemon is not running");
      }
      return;
    }
    await requestShutdown(connection);
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, daemon: "stopped", alreadyStopped: false });
    } else {
      info("daemon stopped");
    }
  });

const work = program.command("work").description("agent work protocol: claim and complete");

work
  .command("create-from-intents <intentIds...>")
  .description("explicitly track existing review intents as one work relation")
  .requiredOption("--reason <text>", "why these intents should become tracked work")
  .requiredOption("--idempotency-key <key>", "caller-stable retry identity")
  .option("--session <id>", "correlate the work with one exact session")
  .option("--assignee-agent <id>", "route the work to one agent")
  .option("--agent <id>", "agent recording the tracking decision", defaultAgentId())
  .action(
    async (
      intentIds: string[],
      opts: {
        reason: string;
        idempotencyKey: string;
        session?: string;
        assigneeAgent?: string;
        agent: string;
      },
    ) => {
      if (opts.idempotencyKey.length === 0) fail("--idempotency-key must not be empty");
      const reason = opts.reason.trim();
      if (reason.length === 0) fail("--reason must not be empty");
      if (intentIds.some((intentId) => intentId.length === 0)) fail("intent ids must not be empty");
      const normalizedIntentIds = [...new Set(intentIds)].sort();
      if (normalizedIntentIds.length !== intentIds.length) {
        fail("intent ids must be unique", {
          code: "work.intent-duplicate",
          exitCode: 2,
        });
      }
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      if (opts.session) await getSession(connection, opts.session);
      const actor = agentActor(opts.agent);
      const assigneeAgentId = opts.assigneeAgent ? canonicalAgentId(opts.assigneeAgent) : undefined;
      const logicalRequest = {
        operation: "work.create-from-intents",
        workspaceId: connection.descriptor.workspaceId,
        idempotencyKey: opts.idempotencyKey,
        intentIds: normalizedIntentIds,
        reason,
        assigneeAgentId: assigneeAgentId ?? null,
        sessionId: opts.session ?? null,
        actor,
      };
      const workId = stableCliIdentity("work", logicalRequest);
      const decisionId = stableCliIdentity("decision", logicalRequest);
      const commandId = stableCliIdentity("cmd", logicalRequest);
      const result = await postCommand(
        connection,
        envelope(
          connection.descriptor.workspaceId,
          "work.create-from-intents",
          opts.idempotencyKey,
          {
            workId,
            intentIds: normalizedIntentIds,
            decisionId,
            reason,
            ...(assigneeAgentId ? { assigneeAgentId } : {}),
            ...(opts.session ? { sessionId: opts.session } : {}),
          },
          actor,
          commandId,
        ),
      );
      if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
      const output = {
        protocol: CLI_PROTOCOL,
        idempotencyKey: opts.idempotencyKey,
        commandId,
        workId,
        decisionId,
        ...(result.response as object),
      };
      if (globals().json) emitJson(output);
      else info(`tracking ${normalizedIntentIds.length} intent(s) as ${String(output.workId)}`);
    },
  );

work
  .command("claim")
  .description("claim the next open work item (typed intents + revision context)")
  .option("--agent <id>", "agent identity (derived when --session is supplied)")
  .option("--work <id>", "claim one specific work item")
  .option("--session <id>", "consume work only from this exact session")
  .option("--document <id-or-path>", "consume work only from this exact document")
  .option("--all", "claim all currently open matching work (bounded by the snapshot)", false)
  .option("--process <nonce>", "agent process nonce", process.env.TWEAKLOOP_SESSION_NONCE)
  .option("--ttl <ms>", "lease lifetime", "30000")
  .option("--wait", "wait until one matching work claim is available", false)
  .option("--timeout <ms>", "wait deadline in milliseconds", "30000")
  .action(
    async (opts: {
      agent?: string;
      work?: string;
      session?: string;
      document?: string;
      all: boolean;
      process?: string;
      ttl: string;
      wait: boolean;
      timeout: string;
    }) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      if (opts.work && (opts.session || opts.document || opts.all)) {
        fail("--work is exact and cannot be combined with --session, --document, or --all");
      }
      if (opts.all && opts.wait) fail("--all cannot be combined with --wait");
      if (opts.wait && !globals().json) fail("work claim --wait requires --json");
      const sessionContext = opts.session
        ? resolveSessionAgentContext((await getSession(connection, opts.session)).session, {
            ...(opts.agent ? { agentId: canonicalAgentId(opts.agent) } : {}),
            ...(opts.process ? { processNonce: opts.process } : {}),
          })
        : null;
      const processNonce =
        sessionContext?.processNonce ?? opts.process ?? `process_${randomUUID()}`;
      const agentId = sessionContext?.agentId ?? canonicalAgentId(opts.agent ?? defaultAgentId());
      const artifactId = opts.document
        ? await resolveArtifactId(connection, opts.document)
        : undefined;
      const claimPass = async (): Promise<unknown[]> => {
        let candidateIds: readonly string[] | null = null;
        if (opts.session || artifactId || opts.all) {
          const view = await getAgentSessionSnapshot(connection, {
            agentId,
            processNonce,
            ...(opts.session ? { sessionId: opts.session } : {}),
            ...(artifactId ? { artifactId } : {}),
          });
          candidateIds = view.work
            .filter((item) => item.status === "open" && item.claim === null)
            .map((item) => item.workId);
        }
        const targets = opts.work
          ? [opts.work]
          : opts.all
            ? (candidateIds ?? [])
            : candidateIds === null
              ? [undefined]
              : [candidateIds[0]];
        const claimed: unknown[] = [];
        for (const workId of targets) {
          if (workId === undefined && candidateIds !== null) continue;
          const result = await claimWorkWithLease(connection, {
            claimId: `claim_${randomUUID()}`,
            agentId,
            processNonce,
            ...(workId ? { workId } : {}),
            ttlMs: Number(opts.ttl),
          });
          if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
          const item = result.response as { status: string };
          if (item.status === "claimed") claimed.push(item);
        }
        return claimed;
      };
      let claimed = await claimPass();
      let timedOut = false;
      if (!opts.all && opts.wait && claimed.length === 0) {
        const timeoutMs = Number(opts.timeout);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
          fail("--timeout must be a non-negative integer");
        }
        const deadline = Date.now() + timeoutMs;
        while (claimed.length === 0 && Date.now() < deadline) {
          await delay(Math.min(50, Math.max(1, deadline - Date.now())));
          claimed = await claimPass();
        }
        if (claimed.length === 0) claimed = await claimPass();
        timedOut = claimed.length === 0;
      }
      if (opts.all) {
        emitJson({ protocol: CLI_PROTOCOL, processNonce, policy: "all-open-matching", claimed });
        return;
      }
      const response = (claimed[0] ?? { status: "none" }) as { status: string };
      if (response.status === "none" && !globals().json) {
        info("no claimable work");
        return;
      }
      emitJson({
        protocol: CLI_PROTOCOL,
        processNonce,
        ...response,
        ...(timedOut ? { timedOut } : {}),
      });
      if (timedOut) process.exitCode = 2;
    },
  );

work
  .command("complete <workId>")
  .description("record claimed work as addressed, with a summary and the revision produced")
  .requiredOption("--claim <claimId>", "claim id returned by `work claim`")
  .requiredOption("--summary <summary>", "what was changed and why")
  .option("--agent <id>", "optional assertion; otherwise derive the agent from --claim")
  .option("--revision-id <revisionId>", "revision produced by this work")
  .option("--intent-ids <ids>", "comma-separated intent ids actually addressed (default: all)")
  .action(
    async (
      workId: string,
      opts: {
        claim: string;
        summary: string;
        agent?: string;
        revisionId?: string;
        intentIds?: string;
      },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const snapshot = await getSnapshot(connection);
      const agentId = resolveClaimAgent(
        snapshot.work.find((candidate) => candidate.workId === workId),
        opts.claim,
        opts.agent ? canonicalAgentId(opts.agent) : undefined,
      );
      const result = await postCommand(
        connection,
        envelope(
          connection.descriptor.workspaceId,
          "work.complete",
          `work.complete:${opts.claim}`,
          {
            workId,
            claimId: opts.claim,
            agentId,
            summary: opts.summary,
            revisionId: opts.revisionId ?? null,
            ...(opts.intentIds === undefined
              ? {}
              : { addressedIntentIds: opts.intentIds.split(",") }),
          },
          agentActor(agentId),
        ),
      );
      if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
      if (globals().json) {
        emitJson({ protocol: CLI_PROTOCOL, ...(result.response as object) });
      } else {
        info(`work ${workId} addressed`);
      }
    },
  );

work
  .command("progress <workId>")
  .description("record immutable progress without implying human acceptance")
  .requiredOption("--claim <claimId>", "active claim id")
  .requiredOption("--summary <summary>", "what was completed or learned")
  .requiredOption("--intent-ids <ids>", "comma-separated intent ids addressed so far")
  .option("--agent <id>", "agent identity holding the claim", defaultAgentId())
  .option("--revision-id <revisionId>", "revision produced by this progress")
  .option("--release", "release the claim so remaining work can be claimed", false)
  .action(
    async (
      workId: string,
      opts: {
        claim: string;
        summary: string;
        intentIds: string;
        agent: string;
        revisionId?: string;
        release: boolean;
      },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const result = await postCommand(
        connection,
        envelope(
          connection.descriptor.workspaceId,
          "work.progress",
          `work.progress:${opts.claim}:${randomUUID()}`,
          {
            workId,
            claimId: opts.claim,
            agentId: opts.agent,
            summary: opts.summary,
            revisionId: opts.revisionId ?? null,
            addressedIntentIds: opts.intentIds.split(",").filter(Boolean),
            releaseClaim: opts.release,
          },
          { kind: "agent", id: opts.agent },
        ),
      );
      if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
      emitJson({ protocol: CLI_PROTOCOL, ...(result.response as object) });
    },
  );

work
  .command("heartbeat <workId>")
  .description("renew the ephemeral lease for a durable claim")
  .requiredOption("--claim <claimId>", "active claim id")
  .requiredOption("--process <nonce>", "agent process nonce")
  .option("--agent <id>", "agent identity holding the claim", defaultAgentId())
  .option("--ttl <ms>", "lease lifetime", "30000")
  .action(
    async (
      workId: string,
      opts: { claim: string; process: string; agent: string; ttl: string },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const response = await heartbeatWorkLease(connection, {
        workId,
        claimId: opts.claim,
        agentId: canonicalAgentId(opts.agent),
        processNonce: opts.process,
        ttlMs: Number(opts.ttl),
      });
      emitJson({ protocol: CLI_PROTOCOL, workId, claimId: opts.claim, ...response });
    },
  );

work
  .command("recover <workId>")
  .description("replace an expired claim with a new durable claim")
  .requiredOption("--stale-claim <claimId>", "expired claim id")
  .requiredOption("--process <nonce>", "new agent process nonce")
  .option("--agent <id>", "assigned agent identity", defaultAgentId())
  .option("--ttl <ms>", "lease lifetime", "30000")
  .action(
    async (
      workId: string,
      opts: { staleClaim: string; process: string; agent: string; ttl: string },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const result = await recoverWorkLease(connection, {
        workId,
        staleClaimId: opts.staleClaim,
        claimId: `claim_${randomUUID()}`,
        agentId: canonicalAgentId(opts.agent),
        processNonce: opts.process,
        ttlMs: Number(opts.ttl),
      });
      if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
      emitJson({ protocol: CLI_PROTOCOL, ...(result.response as object) });
    },
  );

work
  .command("list")
  .description("list work items and their status")
  .option("--status <status>", "open, claimed, addressed, or all", "open")
  .option("--work <workId>", "filter to one exact work item")
  .option("--session <sessionId>", "filter to one exact session")
  .option("--artifact <artifactId-or-source-path>", "filter to one exact artifact")
  .option("--cursor <cursor>", "continue a prior compact result using its exact filters")
  .option("--full", "include complete work values after filtering", false)
  .action(
    async (opts: {
      status: string;
      work?: string;
      session?: string;
      artifact?: string;
      cursor?: string;
      full: boolean;
    }) => {
      const status = parseWorkListStatus(opts.status);
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      if (opts.session) await getSession(connection, opts.session);
      const artifactId = opts.artifact
        ? await resolveArtifactId(connection, opts.artifact)
        : undefined;
      const snapshot = await getSnapshot(connection);
      const receipt = workListReceipt(
        snapshot.work,
        {
          status,
          ...(opts.work ? { workId: opts.work } : {}),
          ...(opts.session ? { sessionId: opts.session } : {}),
          ...(artifactId ? { artifactId } : {}),
          full: opts.full,
        },
        { invocation, ...(opts.cursor ? { cursor: opts.cursor } : {}) },
      );
      if (globals().json) {
        emitJson(receipt);
      } else {
        for (const item of receipt.work) {
          const suffix =
            item.status === "claimed"
              ? ` by ${"claim" in item ? item.claim?.agentId : item.claimedBy}`
              : item.status === "addressed" && "result" in item
                ? ` — ${item.result?.summary}`
                : "";
          const intentCount = "intentIds" in item ? item.intentIds.length : item.intentCount;
          info(`${item.workId}  ${item.status}${suffix}  (${intentCount} intent(s))`);
        }
        if (receipt.work.length === 0) info("no work items");
        if (receipt.continuation !== null) {
          info(`next page: ${receipt.continuation.command}`);
        }
      }
    },
  );

const review = program.command("review").description("submit typed review without implicit work");

review
  .command("submit-comments <document>")
  .description("hand off comment submission to the human-authenticated review shell")
  .requiredOption(
    "--comments-json <json>",
    'non-empty JSON array of {target:{...},body:{...},intentId?:"..."}',
  )
  .requiredOption("--idempotency-key <key>", "caller-stable retry identity")
  .option("--session <id>", "correlate comments with one exact session")
  .option(
    "--assignee-agent <id>",
    "compatibility hint only; choose human-authenticated routing in the review shell",
  )
  .option(
    "--agent <id>",
    "compatibility hint only; agent identity does not confer human authority",
    defaultAgentId(),
  )
  .action(
    async (
      document: string,
      opts: {
        commentsJson: string;
        idempotencyKey: string;
        session?: string;
        assigneeAgent?: string;
        agent: string;
      },
    ) => {
      if (opts.idempotencyKey.length === 0) fail("--idempotency-key must not be empty");
      parseCommentInputs(opts.commentsJson);
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      if (opts.session) await getSession(connection, opts.session);
      const { artifactId } = await resolveRegisteredHead(connection, document);
      requireHumanBrowser({
        action: "review.submit-comments",
        artifactId,
        sessionId: opts.session ?? null,
      });
    },
  );

const decision = program
  .command("decision")
  .description("continue human decisions in the authenticated review shell");

decision
  .command("accept <workId>")
  .description("hand off acceptance to the human-authenticated review shell")
  .option("--reason <text>", "optional acceptance note")
  .action(async (workId: string) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const item = (await getSnapshot(connection)).work.find(
      (candidate) => candidate.workId === workId,
    );
    if (!item) {
      fail("unknown work item", {
        code: "work.unknown",
        exitCode: 2,
        details: { workId: boundedIdentifier(workId) },
      });
    }
    requireHumanBrowser({
      action: "decision.accept",
      artifactId: item.artifactId,
      sessionId: item.sessionId,
      workId,
    });
  });

decision
  .command("reopen <workId>")
  .description("hand off reopening to the human-authenticated review shell")
  .requiredOption("--reason <text>", "what remains to be changed")
  .action(async (workId: string) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const item = (await getSnapshot(connection)).work.find(
      (candidate) => candidate.workId === workId,
    );
    if (!item) {
      fail("unknown work item", {
        code: "work.unknown",
        exitCode: 2,
        details: { workId: boundedIdentifier(workId) },
      });
    }
    requireHumanBrowser({
      action: "decision.reopen",
      artifactId: item.artifactId,
      sessionId: item.sessionId,
      workId,
    });
  });

decision
  .command("wait <workId>")
  .description("wait for the human accept/reopen decision on one work item")
  .option("--timeout <ms>", "bounded wait duration", "60000")
  .action(async (workId: string, opts: { timeout: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const timeoutMs = Number(opts.timeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0)
      fail("timeout must be a non-negative integer");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const current = await getSnapshot(connection);
      const item = current.work.find((candidate) => candidate.workId === workId);
      if (!item) fail(`unknown work item: ${workId}`);
      if (item.decision !== "pending") {
        emitJson({ protocol: CLI_PROTOCOL, workId, decision: item.decision, work: item });
        return;
      }
      if (Date.now() >= deadline) {
        emitJson({ protocol: CLI_PROTOCOL, workId, decision: "pending", timedOut: true });
        process.exitCode = 2;
        return;
      }
      await delay(Math.min(500, Math.max(0, deadline - Date.now())));
    }
  });

registerQuestionCommands(program, {
  rootPath,
  json: () => globals().json,
});

const chat = program.command("chat").description("live channel between the human and agents");

registerInboundCommands(program, work, chat, {
  rootPath,
  json: () => globals().json,
  canonicalAgentId,
  invocation,
});

registerNativeHookCommands(program, {
  rootPath,
  json: () => globals().json,
});

chat
  .command("send <text>")
  .description("send as an agent; human messages continue in the authenticated review shell")
  .option("--artifact <id>", "scope the message to an artifact")
  .option("--agent <id>", "send as this agent identity")
  .option("--attach <paths...>", "upload and attach one or more files")
  .option("--mention <ids...>", "legacy alias for --document")
  .option("--document <ids...>", "reference one or more documents by stable artifact id or path")
  .option("--comment <ids...>", "reference one or more comments by stable intent id")
  .option("--task <ids...>", "reference one or more tasks by stable work id")
  .option("--whiteboard <ids...>", "reference one or more boards by stable artifact id or path")
  .option("--selection <document>", "reference selected text in this document")
  .option("--quote <text>", "exact selected text used with --selection")
  .option("--semantic-id <id>", "semantic anchor used with --selection")
  .option("--revision <id>", "pin --selection to this immutable revision")
  .option("--session <id>", "correlate to one live review session")
  .option("--to-agent <id>", "route to one assigned agent")
  .option("--thread <id>", "durable conversation thread id")
  .option("--work <id>", "correlate to a work item")
  .option("--intent <id>", "correlate to an intent")
  .option(
    "--from-work <id>",
    "derive agent, session, task, comment, and all selection references from one work item",
  )
  .action(
    async (
      text: string,
      opts: {
        artifact?: string;
        agent?: string;
        attach?: string[];
        mention?: string[];
        document?: string[];
        comment?: string[];
        task?: string[];
        whiteboard?: string[];
        selection?: string;
        quote?: string;
        semanticId?: string;
        revision?: string;
        session?: string;
        toAgent?: string;
        thread?: string;
        work?: string;
        intent?: string;
        fromWork?: string;
      },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      if ((opts.quote || opts.semanticId || opts.revision) && !opts.selection) {
        fail(
          "--quote, --semantic-id, and --revision require --selection <document>; use --from-work <workId> to derive typed selections from claimed intents",
        );
      }
      if (opts.selection && !opts.quote && !opts.semanticId) {
        fail("--selection requires --quote or --semantic-id so the selected portion is durable");
      }

      const snapshot = await getSnapshot(connection);
      const findArtifact = (value: string) => {
        const artifactId = requireRegisteredDocument(
          resolveDocumentReference(snapshot.artifacts, value, rootPath()),
          value,
        );
        const artifact = snapshot.artifacts.find((item) => item.artifactId === artifactId);
        if (!artifact) fail(`document identity disappeared: ${artifactId}`);
        return artifact;
      };
      const headFor = (artifactId: string) =>
        snapshot.revisions
          .filter((revision) => revision.artifactId === artifactId)
          .sort((left, right) => left.seq - right.seq)
          .at(-1);

      const derived = opts.fromWork ? deriveWorkChatContext(snapshot, opts.fromWork) : null;
      if (derived && opts.agent && canonicalAgentId(opts.agent) !== derived.agentId) {
        fail(
          `work ${derived.workId} belongs to agent ${derived.agentId}; omit --agent to derive it, or use a work item assigned to ${canonicalAgentId(opts.agent)}`,
        );
      }
      if (derived && opts.session && opts.session !== derived.sessionId) {
        fail(
          `--session ${opts.session} conflicts with work ${derived.workId} session ${derived.sessionId}`,
        );
      }
      if (derived && opts.work && opts.work !== derived.workId) {
        fail(`--work ${opts.work} conflicts with --from-work ${derived.workId}`);
      }
      const sessionContext =
        !derived && opts.session
          ? resolveSessionAgentContext((await getSession(connection, opts.session)).session, {
              ...(opts.agent ? { agentId: canonicalAgentId(opts.agent) } : {}),
            })
          : null;
      const actor: ActorRef | null = derived
        ? agentActor(derived.agentId)
        : sessionContext
          ? agentActor(sessionContext.agentId)
          : opts.agent
            ? agentActor(opts.agent)
            : null;

      const references: ChatReference[] = [...(derived?.references ?? [])];
      const documentInputs = [...new Set([...(opts.mention ?? []), ...(opts.document ?? [])])];
      for (const value of documentInputs) {
        const artifact = findArtifact(value);
        if (!artifact) fail(`unknown document: ${value}`);
        if (artifact.format === "whiteboard") {
          fail(`${value} is a whiteboard — use --whiteboard so its type remains explicit`);
        }
        const head = headFor(artifact.artifactId);
        references.push({
          kind: "document",
          label: artifact.name,
          artifactId: artifact.artifactId,
          ...(head ? { revisionId: head.revisionId } : {}),
        });
      }
      for (const intentId of [...new Set(opts.comment ?? [])]) {
        const intent = snapshot.intents.find((item) => item.intentId === intentId);
        if (!intent) fail(`unknown comment: ${intentId}`);
        references.push({
          kind: "comment",
          label: `@comment: ${collaborationLabel(intent.body, intentId)}`,
          artifactId: intent.artifactId,
          revisionId: intent.revisionId,
          intentId,
        });
      }
      for (const workId of [...new Set(opts.task ?? [])]) {
        const work = snapshot.work.find((item) => item.workId === workId);
        if (!work) fail(`unknown task: ${workId}`);
        const sourceIntent = snapshot.intents.find((item) =>
          work.intentIds.includes(item.intentId),
        );
        const taskLabel =
          work.result?.summary ??
          (sourceIntent ? collaborationLabel(sourceIntent.body, workId) : workId);
        references.push({
          kind: "task",
          label: `@task: ${taskLabel}`,
          artifactId: work.artifactId,
          workId,
        });
      }
      for (const value of [...new Set(opts.whiteboard ?? [])]) {
        const artifact = findArtifact(value);
        if (!artifact) fail(`unknown whiteboard: ${value}`);
        if (artifact.format !== "whiteboard") fail(`${value} is not a whiteboard`);
        const head = headFor(artifact.artifactId);
        references.push({
          kind: "whiteboard",
          label: artifact.name,
          artifactId: artifact.artifactId,
          ...(head ? { revisionId: head.revisionId } : {}),
        });
      }
      if (opts.selection) {
        const artifact = findArtifact(opts.selection);
        if (!artifact) fail(`unknown selection document: ${opts.selection}`);
        const head = headFor(artifact.artifactId);
        const revisionId = opts.revision ?? head?.revisionId;
        if (!revisionId) fail(`selection document has no revision: ${opts.selection}`);
        references.push({
          kind: "selection",
          label: opts.quote ?? opts.semanticId ?? "Selected content",
          artifactId: artifact.artifactId,
          revisionId,
          ...(opts.quote ? { textQuote: { exact: opts.quote } } : {}),
          ...(opts.semanticId ? { semanticId: opts.semanticId } : {}),
        });
      }

      const explicitArtifactId = opts.artifact
        ? await resolveArtifactId(connection, opts.artifact)
        : null;
      if (actor === null) {
        const referencedArtifactId = references.find(
          (reference) => "artifactId" in reference && typeof reference.artifactId === "string",
        )?.artifactId;
        requireHumanBrowser({
          action: "chat.send",
          artifactId: explicitArtifactId ?? referencedArtifactId ?? null,
        });
      }

      const attachments: ChatAttachment[] = [];
      for (const inputPath of opts.attach ?? []) {
        const absolute = resolve(inputPath);
        if (!existsSync(absolute)) {
          fail(
            `attachment file not found: ${inputPath}; pass an intentional existing file path or omit --attach — Tweakloop never guesses attachment bytes`,
          );
        }
        const fileName = basename(absolute);
        const attachment = await uploadChatAttachment(connection, {
          bytes: readFileSync(absolute),
          fileName,
          mediaType: mediaTypeFor(fileName),
        });
        attachments.push(attachment);
        references.push({ kind: "file", label: fileName, hash: attachment.hash });
      }
      const legacyMentions = [
        ...new Set(
          references.flatMap((reference) =>
            reference.kind === "document" || reference.kind === "whiteboard"
              ? [reference.artifactId]
              : [],
          ),
        ),
      ];

      const messageId = randomUUID();
      const result = await postCommand(
        connection,
        envelope(
          connection.descriptor.workspaceId,
          "chat.send",
          `chat.send:${messageId}`,
          {
            messageId,
            artifactId: explicitArtifactId ?? derived?.artifactId ?? null,
            text,
            mentions: legacyMentions,
            references,
            attachments,
            sessionId: opts.session ?? derived?.sessionId ?? null,
            recipientAgentId: opts.toAgent ?? null,
            threadId:
              opts.thread ??
              opts.work ??
              derived?.workId ??
              opts.intent ??
              opts.session ??
              derived?.sessionId ??
              null,
            workId: opts.work ?? derived?.workId ?? null,
            intentId: opts.intent ?? null,
          },
          actor,
        ),
      );
      if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
      if (globals().json) {
        emitJson({ protocol: CLI_PROTOCOL, ...(result.response as object) });
      } else {
        info("sent");
      }
    },
  );

chat
  .command("promote <messageId>")
  .description("track as an agent; otherwise continue the human action in the review shell")
  .option("--session <id>", "assert the message belongs to this live session")
  .option("--agent <id>", "assert the task is routed to this agent")
  .action(async (messageId: string, opts: { session?: string; agent?: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const snapshot = await getSnapshot(connection);
    const message = snapshot.chat.find((item) => item.messageId === messageId);
    if (!message) {
      fail("unknown chat message", {
        code: "chat.message-unknown",
        exitCode: 2,
        details: { messageId: boundedIdentifier(messageId) },
      });
    }
    if (!message.author.startsWith("human:")) {
      fail(`chat message ${messageId} is agent-authored and cannot become human review work`);
    }
    if (message.artifactId === null) {
      fail(`chat message ${messageId} is not attached to an artifact and cannot become a task`);
    }
    if (message.workId || message.intentId) {
      fail(`chat message ${messageId} is already tracked as task ${message.workId ?? "pending"}`);
    }
    if (opts.session && opts.session !== message.sessionId) {
      fail(`--session ${opts.session} conflicts with chat message session ${message.sessionId}`);
    }
    const recipientAgentId = message.recipientAgentId;
    if (opts.agent && canonicalAgentId(opts.agent) !== recipientAgentId) {
      fail(
        `--agent ${canonicalAgentId(opts.agent)} conflicts with chat message recipient ${recipientAgentId}`,
      );
    }
    const head = snapshot.revisions
      .filter((revision) => revision.artifactId === message.artifactId)
      .sort((left, right) => left.seq - right.seq)
      .at(-1);
    if (!head) fail(`artifact ${message.artifactId} has no revision to use as task context`);
    const contextualRevisionId =
      message.context?.revisionId ?? message.context?.boardAnchor?.baseRevisionId ?? null;
    if (contextualRevisionId && contextualRevisionId !== head.revisionId) {
      fail(
        `chat message ${messageId} references stale revision ${contextualRevisionId}; send a new message against ${head.revisionId}`,
      );
    }
    if (!opts.agent) {
      requireHumanBrowser({
        action: "chat.promote",
        artifactId: message.artifactId,
        sessionId: message.sessionId,
        messageId,
      });
    }
    const target = {
      ...(message.context?.semanticId === undefined
        ? {}
        : { semanticId: message.context.semanticId }),
      ...(message.context?.domHint === undefined ? {} : { domHint: message.context.domHint }),
      ...(message.context?.textQuote === undefined ? {} : { textQuote: message.context.textQuote }),
      ...(message.context?.boardAnchor === undefined
        ? {}
        : { boardAnchor: message.context.boardAnchor }),
    };
    const batchId = `batch_${randomUUID()}`;
    const intentId = `intent_${randomUUID()}`;
    const workId = `work_${randomUUID()}`;
    const actor = agentActor(opts.agent);
    const result = await postCommand(
      connection,
      envelope(
        connection.descriptor.workspaceId,
        "review.submit-batch",
        `chat.promote:${messageId}`,
        {
          batchId,
          workId,
          artifactId: message.artifactId,
          revisionId: head.revisionId,
          sourceMessageId: messageId,
          assigneeAgentId: recipientAgentId,
          sessionId: message.sessionId,
          intents: [
            {
              intentId,
              intentType: "comment",
              target,
              body: { text: message.text, sourceMessageId: messageId },
            },
          ],
        },
        actor,
      ),
    );
    if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, messageId, ...(result.response as object) });
    } else {
      info(`tracking as task ${String((result.response as { workId?: string }).workId)}`);
    }
  });

const chatAttachment = chat
  .command("attachment")
  .description("retrieve immutable content-addressed files received in Chat");

chatAttachment
  .command("fetch <hash> <destination>")
  .description("download one received attachment by hash without overwriting a local file")
  .action(async (hash: string, destination: string) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const absoluteDestination = resolve(destination);
    if (existsSync(absoluteDestination)) {
      fail(`attachment destination already exists: ${absoluteDestination}`);
    }
    const bytes = await fetchChatAttachment(connection, hash);
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== hash) {
      fail(`attachment hash mismatch: expected ${hash}, received ${actualHash}`);
    }
    try {
      writeFileSync(absoluteDestination, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      fail(
        `could not write attachment to ${absoluteDestination}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (globals().json) {
      emitJson({
        protocol: "tweakloop.attachment-fetch/v1",
        hash,
        destination: absoluteDestination,
        byteLength: bytes.byteLength,
        verified: true,
      });
    } else {
      info(`saved verified attachment to ${absoluteDestination}`);
    }
  });

const session = program
  .command("session")
  .description("versioned live agent session (snapshot truth + streamed deltas)");

session
  .command("start [document]")
  .description("start a durable session with one document or no artifacts")
  .option("--empty", "start with zero artifacts", false)
  .option("--agent <id>", "agent identity", defaultAgentId())
  .option("--process <nonce>", "agent process correlation nonce")
  .option("--session-id <id>", "session identity")
  .option("--base-revision <id>", "revision this work starts from")
  .option("--title <text>", "high-signal session title")
  .option("--goal <text>", "goal for this session")
  .action(
    async (
      document: string | undefined,
      opts: {
        agent: string;
        empty: boolean;
        process?: string;
        sessionId?: string;
        baseRevision?: string;
        title?: string;
        goal?: string;
      },
    ) => {
      if ((document === undefined) === !opts.empty) {
        fail("provide exactly one document or use --empty");
      }
      const connection = await ensureDaemon(rootPath());
      const artifactId = document ? await resolveArtifactId(connection, document) : null;
      const current = await getSnapshot(connection);
      const artifact = artifactId
        ? current.artifacts.find((item) => item.artifactId === artifactId)
        : undefined;
      const head = artifactId
        ? current.revisions.filter((item) => item.artifactId === artifactId).at(-1)
        : undefined;
      const agentId = canonicalAgentId(opts.agent);
      const baseRevisionId = opts.baseRevision ?? head?.revisionId ?? null;
      const title = opts.title ?? artifact?.name ?? "New collaboration session";
      const goal =
        opts.goal ??
        (artifact ? `Iterate ${artifact.name}` : "Open or create artifacts with the user");
      const capability = prepareRuntimeCapability({
        workspaceId: connection.descriptor.workspaceId,
        workspaceRoot: rootPath(),
        daemonStartNonce: connection.descriptor.startNonce,
        operationIdentity: stableCliIdentity("runtime-session-start", {
          artifactId,
          baseRevisionId,
          agentId,
          requestedSessionId: opts.sessionId ?? null,
          requestedProcessNonce: opts.process ?? null,
          title,
          goal,
        }),
        agentId,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.process ? { processNonce: opts.process } : {}),
      });
      const { sessionId, processNonce } = capability;
      const result = await postCommand(
        connection,
        envelope(
          connection.descriptor.workspaceId,
          "session.start",
          `session.start:${sessionId}`,
          {
            sessionId,
            artifactId,
            agentId,
            processNonce,
            runtimeCapabilityHash: capability.capabilityHash,
            baseRevisionId,
            title,
            goal,
          },
          agentActor(agentId),
        ),
      );
      if (result.status === "rejected") {
        abandonRuntimeCapabilityPreparation(capability);
        fail(`${result.code}: ${result.message}`);
      }
      const detail = await getSession(connection, sessionId);
      const minted = await mintBootstrap(connection, {
        ...(artifactId ? { artifactId } : {}),
        agentId,
        sessionId,
      });
      completeRuntimeCapabilityPreparation(capability);
      const output = {
        ...detail,
        processNonce,
        url: minted.url,
        nextCommand: renderInvocation(invocation, [
          "next",
          "--session",
          sessionId,
          "--wait",
          "--timeout",
          "300000",
          "--json",
        ]),
        listenCommand: renderInvocation(invocation, ["session", "listen", "--session", sessionId]),
      };
      if (globals().json) emitJson(output);
      else {
        info(
          artifactId
            ? `started ${sessionId} on ${artifactId} (process ${processNonce})`
            : `started empty session ${sessionId} (process ${processNonce})`,
        );
        info(`review URL: ${minted.url}`);
        info(
          `receive one item: ${renderInvocation(invocation, ["next", "--session", sessionId, "--wait", "--timeout", "300000", "--json"])}`,
        );
        info(
          `persistent stream only: ${renderInvocation(invocation, ["session", "listen", "--session", sessionId])}`,
        );
      }
    },
  );

session
  .command("attach <sessionId> <document>")
  .description("attach the exact registered document head to an existing session")
  .option("--role <role>", "attachment role: primary, opened, or whiteboard", "opened")
  .option("--agent <id>", "agent performing the attachment", defaultAgentId())
  .action(async (sessionId: string, document: string, opts: { role: string; agent: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const role = sessionArtifactRole(opts.role);
    const actor = agentActor(opts.agent);
    const { artifactId, revisionId } = await resolveRegisteredHead(connection, document);
    const requestId = stableCliIdentity("request", {
      operation: "session.attach-artifact",
      sessionId,
      artifactId,
      revisionId,
      role,
      actor,
    });
    const result = await attachArtifactToSession(connection, {
      sessionId,
      artifactId,
      revisionId,
      requestId,
      role,
      actor,
    });
    if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
    const output = {
      protocol: CLI_PROTOCOL,
      requestId,
      ...(result.response as object),
    };
    if (globals().json) emitJson(output);
    else {
      const duplicate = (result.response as { alreadyAttached?: boolean }).alreadyAttached === true;
      info(
        duplicate
          ? `${artifactId}@${revisionId} is already attached to ${sessionId}`
          : `attached ${artifactId}@${revisionId} to ${sessionId}`,
      );
    }
  });

session
  .command("url <sessionId>")
  .description("mint a fresh one-use review URL without durable mutation")
  .option("--document <id-or-path>", "open one exact artifact already attached to the session")
  .action(async (sessionId: string, opts: { document?: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const detail = (await getSession(connection, sessionId)).session;
    const artifactId = opts.document
      ? await resolveArtifactId(connection, opts.document)
      : undefined;
    const minted = await mintSessionUrl(connection, {
      sessionId,
      agentId: detail.agentId,
      ...(artifactId ? { artifactId } : {}),
    });
    if (globals().json) emitJson(minted);
    else info(`one-use review URL: ${minted.url}`);
  });

session
  .command("list")
  .description("discover current and previous durable sessions")
  .option("--document <id-or-path>", "filter to exactly one document")
  .option("--agent <id>", "filter by current agent identity")
  .option("--status <status>", "active, handed-off, or ended")
  .action(async (opts: { document?: string; agent?: string; status?: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    if (opts.status && !["active", "handed-off", "ended"].includes(opts.status)) {
      fail("status must be active, handed-off, or ended");
    }
    const resolution = opts.document ? await resolveDocument(connection, opts.document) : null;
    const result =
      resolution?.status === "unregistered"
        ? { protocol: SESSION_QUERY_PROTOCOL, sessions: [] }
        : await listSessions(connection, {
            ...(resolution
              ? { artifactId: requireRegisteredDocument(resolution, opts.document ?? "") }
              : {}),
            ...(opts.agent ? { agentId: canonicalAgentId(opts.agent) } : {}),
            ...(opts.status ? { status: opts.status as "active" | "handed-off" | "ended" } : {}),
          });
    if (globals().json) emitJson(result);
    else if (result.sessions.length === 0) info("no sessions");
    else {
      for (const item of result.sessions) {
        info(
          `${item.sessionId}\t${item.status}\t${item.agentId}\t${item.artifactName}\t${item.lastActiveAt}`,
        );
      }
    }
  });

session
  .command("show <sessionId>")
  .description("show lineage plus complete derived work, comments, and chat context")
  .action(async (sessionId: string) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const result = await getSession(connection, sessionId);
    if (globals().json) emitJson(result);
    else {
      const item = result.session;
      info(`${item.title} — ${item.status}`);
      info(`session: ${item.sessionId}`);
      info(`document: ${item.artifactName} (${item.artifactId})`);
      info(`agent: ${item.agentId} (origin ${item.originatingAgentId})`);
      info(`goal: ${item.goal}`);
      info(
        `work: ${item.work.length}; open comments/tasks: ${item.openIntentIds.length}; chat: ${item.chat.length}`,
      );
      info(
        `presence: unknown from history; run ${renderInvocation(invocation, ["session", "listen", "--session", item.sessionId])} to attach with the recorded agent/process identity`,
      );
    }
  });

session
  .command("fetch <sessionId> <artifactId> <destination>")
  .description("fetch the exact current bytes of one artifact attached to a session")
  .action(async (sessionId: string, artifactId: string, destination: string) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const record = (await getSession(connection, sessionId)).session.artifacts.find(
      (item) => item.artifactId === artifactId,
    );
    if (!record) fail(`artifact ${artifactId} is not attached to session ${sessionId}`);
    const bytes = await fetchRevisionSource(connection, record.currentRevisionId);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== record.currentEntryHash) {
      fail(`revision hash mismatch: expected ${record.currentEntryHash}, received ${actual}`);
    }
    const output = resolve(destination);
    if (existsSync(output)) fail(`destination already exists: ${output}`);
    writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    if (globals().json) {
      emitJson({
        protocol: "tweakloop.session-artifact-fetch/v1",
        sessionId,
        artifactId,
        revisionId: record.currentRevisionId,
        hash: actual,
        destination: output,
        byteLength: bytes.byteLength,
      });
    } else info(`saved ${artifactId}@${record.currentRevisionId} to ${output}`);
  });

session
  .command("handoff <sessionId>")
  .description("offer a durable session takeover to another agent")
  .requiredOption("--to-agent <id>", "receiving agent identity")
  .requiredOption("--summary <text>", "what the receiving agent must know")
  .option("--agent <id>", "current owner", defaultAgentId())
  .action(async (sessionId: string, opts: { agent: string; toAgent: string; summary: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const currentSession = (await getSession(connection, sessionId)).session;
    const agentId = canonicalAgentId(opts.agent);
    const result = await postCommand(
      connection,
      envelope(
        connection.descriptor.workspaceId,
        "session.handoff",
        `session.handoff:${sessionId}:${randomUUID()}`,
        {
          sessionId,
          agentId,
          toAgentId: canonicalAgentId(opts.toAgent),
          summary: opts.summary,
        },
        agentActor(agentId),
      ),
    );
    if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
    removeRuntimeCapability({
      workspaceId: connection.descriptor.workspaceId,
      workspaceRoot: rootPath(),
      sessionId,
      agentId: currentSession.agentId,
      processNonce: currentSession.processNonce,
    });
    const detail = await getSession(connection, sessionId);
    if (globals().json) emitJson(detail);
    else info(`offered ${sessionId} to ${canonicalAgentId(opts.toAgent)}`);
  });

session
  .command("resume <predecessorSessionId>")
  .description("create a successor session with the predecessor's full document context")
  .option("--agent <id>", "receiving agent identity", defaultAgentId())
  .option("--process <nonce>", "agent process correlation nonce")
  .option("--session-id <id>", "new successor session identity")
  .option("--base-revision <id>", "revision to resume from (defaults to current head)")
  .option("--title <text>", "override inherited title")
  .option("--goal <text>", "override inherited goal")
  .action(
    async (
      predecessorSessionId: string,
      opts: {
        agent: string;
        process?: string;
        sessionId?: string;
        baseRevision?: string;
        title?: string;
        goal?: string;
      },
    ) => {
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const predecessor = (await getSession(connection, predecessorSessionId)).session;
      const agentId = canonicalAgentId(opts.agent);
      const baseRevisionId = opts.baseRevision ?? null;
      const title = opts.title ?? null;
      const goal = opts.goal ?? null;
      const capability = prepareRuntimeCapability({
        workspaceId: connection.descriptor.workspaceId,
        workspaceRoot: rootPath(),
        daemonStartNonce: connection.descriptor.startNonce,
        operationIdentity: stableCliIdentity("runtime-session-resume", {
          predecessorSessionId,
          agentId,
          requestedSessionId: opts.sessionId ?? null,
          requestedProcessNonce: opts.process ?? null,
          baseRevisionId,
          title,
          goal,
        }),
        agentId,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        ...(opts.process ? { processNonce: opts.process } : {}),
      });
      const { sessionId, processNonce } = capability;
      const result = await postCommand(
        connection,
        envelope(
          connection.descriptor.workspaceId,
          "session.resume",
          `session.resume:${sessionId}`,
          {
            sessionId,
            predecessorSessionId,
            agentId,
            processNonce,
            runtimeCapabilityHash: capability.capabilityHash,
            baseRevisionId,
            title,
            goal,
          },
          agentActor(agentId),
        ),
      );
      if (result.status === "rejected") {
        abandonRuntimeCapabilityPreparation(capability);
        fail(`${result.code}: ${result.message}`);
      }
      const detail = await getSession(connection, sessionId);
      const minted = await mintBootstrap(connection, {
        ...(detail.session.artifactId ? { artifactId: detail.session.artifactId } : {}),
        agentId,
        sessionId,
      });
      completeRuntimeCapabilityPreparation(capability);
      removeRuntimeCapability({
        workspaceId: connection.descriptor.workspaceId,
        workspaceRoot: rootPath(),
        sessionId: predecessorSessionId,
        agentId: predecessor.agentId,
        processNonce: predecessor.processNonce,
      });
      const output = {
        ...detail,
        processNonce,
        url: minted.url,
        nextCommand: renderInvocation(invocation, [
          "next",
          "--session",
          sessionId,
          "--wait",
          "--timeout",
          "300000",
          "--json",
        ]),
        listenCommand: renderInvocation(invocation, ["session", "listen", "--session", sessionId]),
      };
      if (globals().json) emitJson(output);
      else {
        info(`resumed ${predecessorSessionId} as ${sessionId}`);
        info(`review URL: ${minted.url}`);
        info(
          `receive one item: ${renderInvocation(invocation, ["next", "--session", sessionId, "--wait", "--timeout", "300000", "--json"])}`,
        );
        info(
          `persistent stream only: ${renderInvocation(invocation, ["session", "listen", "--session", sessionId])}`,
        );
      }
    },
  );

session
  .command("end <sessionId>")
  .description("end a durable session without erasing its lineage")
  .requiredOption("--summary <text>", "final state for the next agent")
  .option("--agent <id>", "current owner", defaultAgentId())
  .action(async (sessionId: string, opts: { agent: string; summary: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const currentSession = (await getSession(connection, sessionId)).session;
    const agentId = canonicalAgentId(opts.agent);
    const result = await postCommand(
      connection,
      envelope(
        connection.descriptor.workspaceId,
        "session.end",
        `session.end:${sessionId}:${randomUUID()}`,
        { sessionId, agentId, summary: opts.summary },
        agentActor(agentId),
      ),
    );
    if (result.status === "rejected") fail(`${result.code}: ${result.message}`);
    removeRuntimeCapability({
      workspaceId: connection.descriptor.workspaceId,
      workspaceRoot: rootPath(),
      sessionId,
      agentId: currentSession.agentId,
      processNonce: currentSession.processNonce,
    });
    const detail = await getSession(connection, sessionId);
    if (globals().json) emitJson(detail);
    else info(`ended ${sessionId}`);
  });

session
  .command("listen")
  .description("attach to a durable session and emit its chat, work, revisions, and decisions")
  .option("--agent <id>", "optional assertion; derived from --session when present")
  .option(
    "--process <nonce>",
    "optional assertion; derived from --session when present",
    process.env.TWEAKLOOP_SESSION_NONCE,
  )
  .option("--session <id>", "attach to this complete multi-document session")
  .option(
    "--artifact <id>",
    "stream this board's live drafts; filters durable traffic only without --session",
  )
  .option(
    "--presence <state>",
    "socket-backed live state: listening, thinking, or working",
    "listening",
  )
  .option("--until-work-settled <id>", "exit when this exact claimed work settles")
  .action(
    async (opts: {
      agent?: string;
      process?: string;
      session?: string;
      artifact?: string;
      presence: string;
      untilWorkSettled?: string;
    }) => {
      if (
        opts.presence !== "listening" &&
        opts.presence !== "thinking" &&
        opts.presence !== "working"
      ) {
        fail("--presence must be one of: listening, thinking, working");
      }
      if (opts.presence === "working" && !opts.untilWorkSettled) {
        fail("--presence working requires --until-work-settled <workId>");
      }
      if (opts.untilWorkSettled && !opts.session) {
        fail("--until-work-settled requires --session <sessionId>");
      }
      const connection = await discoverDaemon(rootPath());
      if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
      const sessionRecord = opts.session
        ? (await getSession(connection, opts.session)).session
        : null;
      const sessionContext = sessionRecord
        ? resolveSessionAgentContext(sessionRecord, {
            ...(opts.agent ? { agentId: canonicalAgentId(opts.agent) } : {}),
            ...(opts.process ? { processNonce: opts.process } : {}),
          })
        : null;
      const agentId = sessionContext?.agentId ?? canonicalAgentId(opts.agent ?? defaultAgentId());
      const processNonce =
        sessionContext?.processNonce ?? opts.process ?? `process_${randomUUID()}`;
      const trafficScope = {
        ...(opts.session ? { sessionId: opts.session } : {}),
        ...(opts.artifact ? { artifactId: opts.artifact } : {}),
      };
      let current = await getAgentSessionSnapshot(connection, {
        agentId,
        processNonce,
        ...agentSnapshotScope(trafficScope),
      });
      let listenerClaim: Readonly<{ workId: string; claimId: string }> | null = null;
      if (opts.untilWorkSettled) {
        const target = current.work.find((item) => item.workId === opts.untilWorkSettled);
        if (target?.status !== "claimed" || target.claim?.agentId !== agentId) {
          fail(`active claimed work not found for listener: ${opts.untilWorkSettled}`);
        }
        listenerClaim = { workId: target.workId, claimId: target.claim.claimId };
        await heartbeatWorkLease(connection, {
          workId: target.workId,
          claimId: target.claim.claimId,
          agentId,
          processNonce,
        });
      }
      console.log(JSON.stringify(current));
      let appliedSeq = current.appliedSeq;
      const relevantWorkIds = new Set(current.work.map((item) => item.workId));
      const draftAbort = new AbortController();
      const draftStreams: Promise<void>[] = [];
      const listeningWhiteboards = new Set<string>();
      const startDraftStream = (artifactId: string) => {
        if (listeningWhiteboards.has(artifactId)) return;
        listeningWhiteboards.add(artifactId);
        draftStreams.push(
          streamWhiteboardDrafts(connection, artifactId, draftAbort.signal).catch(
            (error: Error) => {
              if (!draftAbort.signal.aborted)
                info(`whiteboard draft stream ended: ${error.message}`);
            },
          ),
        );
      };
      if (opts.artifact) {
        const workspace = await getSnapshot(connection);
        if (
          workspace.artifacts.some(
            (artifact) => artifact.artifactId === opts.artifact && artifact.format === "whiteboard",
          )
        ) {
          startDraftStream(opts.artifact);
        }
      }
      for (const artifact of sessionRecord?.artifacts ?? []) {
        if (artifact.format === "whiteboard") startDraftStream(artifact.artifactId);
      }
      const url = new URL(
        `/api/v1/events?after=${appliedSeq}&agent=${encodeURIComponent(agentId)}&presence=${encodeURIComponent(opts.presence)}`,
        connection.baseUrl,
      );
      const listenerAbort = new AbortController();
      const res = await fetch(url, {
        headers: {
          accept: "text/event-stream",
          authorization: `Bearer ${connection.token}`,
        },
        signal: listenerAbort.signal,
      });
      if (!res.ok || !res.body) fail(`session stream failed: ${res.status}`);
      info(`session ${current.sessionId ?? "workspace"} listening as ${agentId}`);
      let heartbeatFailure: unknown;
      const reportClaimLoss = () => {
        console.log(
          JSON.stringify({
            protocol: AGENT_SESSION_PROTOCOL,
            kind: "error",
            code: "work.listener-claim-lost",
            message: "work listener lost exact claim authority",
            ...(listenerClaim ? { workId: listenerClaim.workId } : {}),
          }),
        );
        process.exitCode = 1;
      };
      const heartbeat = setInterval(() => {
        console.log(
          JSON.stringify({
            protocol: AGENT_SESSION_PROTOCOL,
            kind: "heartbeat",
            appliedSeq,
          }),
        );
        if (listenerClaim) {
          void heartbeatWorkLease(connection, {
            workId: listenerClaim.workId,
            claimId: listenerClaim.claimId,
            agentId,
            processNonce,
          }).catch((error: unknown) => {
            heartbeatFailure ??= error;
            listenerAbort.abort();
          });
        }
      }, 15_000);
      try {
        try {
          for await (const event of readSseEvents(res, () => appliedSeq)) {
            if (event.seq <= appliedSeq) continue;
            const payload = event.payload as Record<string, unknown>;
            if (event.eventType === "work.created") {
              const assigned = (payload.assigneeAgentId as string | null | undefined) ?? null;
              const eventSession = (payload.sessionId as string | null | undefined) ?? null;
              const eventArtifact = String(payload.artifactId ?? "");
              if (
                (assigned === null || assigned === agentId) &&
                sessionTrafficMatches(trafficScope, {
                  sessionId: eventSession,
                  artifactId: eventArtifact,
                })
              ) {
                current = await getAgentSessionSnapshot(connection, {
                  agentId,
                  processNonce,
                  ...agentSnapshotScope(trafficScope),
                });
                for (const item of current.work) relevantWorkIds.add(item.workId);
                appliedSeq = current.appliedSeq;
                console.log(JSON.stringify(current));
              }
              continue;
            }
            const relevant =
              (event.eventType === "session.artifact-attached" &&
                opts.session !== undefined &&
                payload.sessionId === opts.session) ||
              (event.eventType === "chat.message" &&
                (((payload.recipientAgentId as string | null | undefined) ?? null) === null ||
                  payload.recipientAgentId === agentId) &&
                sessionTrafficMatches(trafficScope, {
                  sessionId: (payload.sessionId as string | null | undefined) ?? null,
                  artifactId: (payload.artifactId as string | null | undefined) ?? null,
                }) &&
                payload.author !== `agent:${agentId}`) ||
              (event.streamType === "work" && relevantWorkIds.has(event.streamId)) ||
              (event.eventType === "artifact.revision-published" &&
                sessionTrafficMatches(trafficScope, {
                  sessionId: (payload.sessionId as string | null | undefined) ?? null,
                  artifactId: (payload.artifactId as string | null | undefined) ?? null,
                }));
            if (!relevant) continue;
            if (event.streamType === "work") {
              current = await refreshClaimSnapshot(current, event, () =>
                getAgentSessionSnapshot(connection, {
                  agentId,
                  processNonce,
                  ...agentSnapshotScope(trafficScope),
                }),
              );
              for (const item of current.work) relevantWorkIds.add(item.workId);
            }
            if (event.eventType === "session.artifact-attached") {
              current = await getAgentSessionSnapshot(connection, {
                agentId,
                processNonce,
                ...agentSnapshotScope(trafficScope),
              });
              const attached = current.artifacts.find(
                (artifact) => artifact.artifactId === payload.artifactId,
              );
              if (attached?.format === "whiteboard") startDraftStream(attached.artifactId);
            }
            console.log(
              JSON.stringify({
                protocol: AGENT_SESSION_PROTOCOL,
                kind: "delta",
                seq: event.seq,
                eventType: event.eventType,
                streamType: event.streamType,
                streamId: event.streamId,
                payload: event.payload,
              }),
            );
            appliedSeq = event.seq;
            if (
              listenerClaim &&
              event.streamType === "work" &&
              event.streamId === listenerClaim.workId
            ) {
              const state = workListenerState(current, listenerClaim.workId, listenerClaim.claimId);
              if (state === "claim-changed") {
                reportClaimLoss();
                return;
              }
              if (state === "settled") {
                console.log(
                  JSON.stringify({
                    protocol: AGENT_SESSION_PROTOCOL,
                    kind: "settled",
                    workId: listenerClaim.workId,
                  }),
                );
                break;
              }
            }
          }
        } catch (error) {
          if (heartbeatFailure !== undefined) {
            reportClaimLoss();
            return;
          }
          throw error;
        }
      } finally {
        clearInterval(heartbeat);
        listenerAbort.abort();
        draftAbort.abort();
        await Promise.allSettled(draftStreams);
      }
    },
  );

chat
  .command("listen")
  .description("stream chat messages live (one JSON per line); marks you as listening in the shell")
  .option("--agent <id>", "agent identity", defaultAgentId())
  .option("--after <seq>", "replay from this sequence", "0")
  .action(async (opts: { agent: string; after: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const url = new URL(
      `/api/v1/events?after=${Number(opts.after)}&agent=${encodeURIComponent(opts.agent)}`,
      connection.baseUrl,
    );
    const res = await fetch(url, {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${connection.token}`,
      },
    });
    if (!res.ok || !res.body) fail(`stream failed: ${res.status}`);
    info(`listening as ${opts.agent} — chat messages stream below (ctrl-c to stop)`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data:")) continue;
          try {
            const event = JSON.parse(line.slice(5).trim()) as {
              eventType: string;
              seq: number;
              payload: { author?: string };
            };
            if (event.eventType !== "chat.message") continue;
            if (event.payload.author === `agent:${opts.agent}`) continue;
            console.log(JSON.stringify({ seq: event.seq, ...event.payload }));
          } catch {
            // partial frame — ignore
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  });

program
  .command("presence <state>")
  .description("set ephemeral presence shown in the shell (thinking, working, idle)")
  .option("--agent <id>", "agent identity", defaultAgentId())
  .option("--ttl <ms>", "auto-expiry for the state", "20000")
  .action(async (state: string, opts: { agent: string; ttl: string }) => {
    if (state !== "thinking" && state !== "working" && state !== "idle") {
      fail("presence state must be one of: thinking, working, idle");
    }
    const ttlMs = Number(opts.ttl);
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 300_000) {
      fail("--ttl must be an integer between 1 and 300000");
    }
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const res = await fetch(new URL("/api/v1/presence", connection.baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ agentId: opts.agent, state, ttlMs }),
    });
    if (!res.ok) fail(`presence update failed: ${res.status}`);
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, agentId: opts.agent, state });
    } else {
      info(`presence: ${opts.agent} → ${state}`);
    }
  });

chat
  .command("list")
  .description("read the chat (agents: poll this between steps)")
  .option("--artifact <id>", "filter to one artifact (workspace-level messages included)")
  .option("--after <seq>", "only messages with createdSeq greater than this", "0")
  .action(async (opts: { artifact?: string; after: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const snapshot = await getSnapshot(connection);
    const after = Number(opts.after);
    const messages = snapshot.chat.filter(
      (m) =>
        m.createdSeq > after &&
        (!opts.artifact || m.artifactId === opts.artifact || m.artifactId === null),
    );
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, messages });
    } else {
      for (const m of messages) {
        const quote = m.context?.textQuote?.exact ? `  [re: "${m.context.textQuote.exact}"]` : "";
        info(`#${m.createdSeq} ${m.author}: ${m.text}${quote}`);
      }
      if (messages.length === 0) info("no messages");
    }
  });

const workspace = program
  .command("workspace")
  .description("capture or maintain the complete local-first workspace");

workspace
  .command("restore-inventory")
  .description("inspect durable restore evidence, capacity, and recovery states")
  .action(async () => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const inventory = await getWorkspaceRestoreInventory(connection);
    if (globals().json) {
      emitJson(inventory);
      return;
    }
    info(
      `restore evidence: ${inventory.capacity.usedBytes}/${inventory.capacity.quotaBytes} bytes; ${inventory.capacity.reservedBytes} reserved`,
    );
    for (const operation of inventory.operations) {
      info(
        `${operation.operationKind} ${operation.operationId}  ${operation.status}/${operation.transition ?? "released"}  ${operation.accountedBytes} bytes`,
      );
    }
    if (inventory.operations.length === 0) info("no restore operations");
  });

workspace
  .command("restore-compact")
  .description("release one completed restore evidence chain after proof-gated validation")
  .requiredOption("--kind <kind>", "restore or fork")
  .requiredOption("--operation <id>", "exact durable operation id")
  .option("--bundle <directory>", "override the retained bound bundle used for state validation")
  .action(async (opts: { kind: string; operation: string; bundle?: string }) => {
    if (opts.kind !== "restore" && opts.kind !== "fork") {
      fail("--kind must be restore or fork");
    }
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const compacted = await compactWorkspaceRestore(connection, {
      operationKind: opts.kind,
      operationId: opts.operation,
      ...(opts.bundle ? { bundleRoot: opts.bundle } : {}),
    });
    if (globals().json) emitJson(compacted);
    else info(`compacted ${opts.kind} ${opts.operation}`);
  });

workspace
  .command("export <directory>")
  .description("save bound collaboration state and a quiescent-verified workspace file set")
  .option("--files-config <path>", "also capture an explicit, versioned workspace file skeleton")
  .option("--operation <id>", "stable operation id for exact retry")
  .action(async (directory: string, opts: { filesConfig?: string; operation?: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    try {
      const filesConfig = opts.filesConfig
        ? validateWorkspaceFilesConfig(JSON.parse(readFileSync(resolve(opts.filesConfig), "utf8")))
        : null;
      const sourceCheckpoint = (await getSnapshot(connection)).lastSeq;
      const exported = await exportWorkspaceBundleOperation({
        destination: resolve(directory),
        sourceWorkspaceId: connection.descriptor.workspaceId,
        sourceCheckpoint,
        filesPolicyHash: workspaceExportFilesPolicyHash(filesConfig),
        ...(opts.operation ? { operationId: opts.operation } : {}),
        capture: async (bundleRoot) => {
          const manifest = await exportWorkspace(connection, rootPath(), bundleRoot);
          if (manifest.capturedSeq !== sourceCheckpoint) {
            throw new WorkspaceExportError(
              "workspace-export.source-checkpoint-changed",
              "workspace advanced after the export operation was registered",
              { expected: sourceCheckpoint, actual: manifest.capturedSeq },
            );
          }
          if (filesConfig) {
            const workspaceFilesCapture = captureWorkspaceFiles({
              workspaceRoot: rootPath(),
              destination: resolve(bundleRoot, "workspace-files"),
              config: filesConfig,
            });
            const observedEnd = await getSnapshot(connection);
            return {
              includeWorkspaceFiles: true,
              observedEndSeq: observedEnd.lastSeq,
              workspaceFilesVerification: workspaceFilesCapture.verification,
            };
          }
          const observedEnd = await getSnapshot(connection);
          return {
            includeWorkspaceFiles: false,
            observedEndSeq: observedEnd.lastSeq,
          };
        },
      });
      const published = exported.published;
      const validated = validateWorkspaceBundleEnvelope(published.destination);
      const manifest = validated.collaborationManifest;
      const fileManifest = validated.workspaceFilesManifest;
      if (globals().json) {
        emitJson({
          ...manifest,
          bundle: published.envelope,
          operation: exported.receipt,
          alreadyExported: exported.alreadyExported,
          ...(fileManifest ? { workspaceFiles: fileManifest } : {}),
        });
      } else {
        info(
          `exported ${manifest.artifacts.length} documents, ${manifest.revisions.length} revisions, and ${manifest.attachments.length} attachments through event #${manifest.capturedSeq}`,
        );
        info(`manifest: ${resolve(published.destination, ".tweakloop/export-manifest.json")}`);
        if (fileManifest) {
          info(
            `workspace files: ${fileManifest.files.length} included, ${fileManifest.excluded.length} exclusion receipts`,
          );
          info(
            `file manifest: ${resolve(published.destination, "workspace-files", WORKSPACE_FILES_MANIFEST_PATH)}`,
          );
        }
        info(`bundle: ${published.envelope.bundleId}`);
      }
    } catch (error) {
      if (
        !(error instanceof WorkspaceExportError) &&
        !(error instanceof WorkspaceFilesError) &&
        !(error instanceof WorkspaceExportOperationError)
      ) {
        throw error;
      }
      if (globals().json) {
        emitJson({
          protocol: "tweakloop.workspace-export/v1",
          status: "error",
          code: error.code,
          message: error.message,
          details: error.details,
        });
        process.exitCode = 1;
        return;
      }
      fail(`${error.code}: ${error.message}`);
    }
  });

workspace
  .command("fork <bundle-directory>")
  .description("reconstruct one saved session into a new independent workspace")
  .requiredOption("--session <id>", "exact saved session checkpoint to fork")
  .requiredOption("--into <directory>", "new destination workspace path")
  .option("--agent <id>", "agent identity for the forked session", defaultAgentId())
  .action(
    async (bundleDirectory: string, opts: { session: string; into: string; agent: string }) => {
      const destinationRoot = resolve(opts.into);
      assertForkDestination(destinationRoot);
      const sourceBundle = resolve(bundleDirectory);
      const stagingParent = mkdtempSync(join(tmpdir(), "tweakloop-fork-"));
      const forkBundleRoot = join(stagingParent, "bundle");
      try {
        const agentId = canonicalAgentId(opts.agent);
        const forked = createForkedWorkspaceBundle({
          sourceBundle,
          destinationBundle: forkBundleRoot,
          destinationWorkspaceRoot: destinationRoot,
          sourceSessionId: opts.session,
          destinationAgentId: agentId,
        });
        const rebound = validateWorkspaceBundleEnvelope(forkBundleRoot);
        const connection = await ensureDaemon(rootPath());
        const result = await restoreWorkspaceExport(connection, forkBundleRoot, agentId, {
          destinationRoot,
          sessionId: forked.checkpoint.destinationSessionId,
        });
        const nextCommand = result.locator
          ? renderInvocation(invocation, [
              "--workspace",
              result.rootPath,
              "next",
              "--session",
              result.locator.sessionId,
              "--wait",
              "--timeout",
              "300000",
              "--json",
            ])
          : null;
        const receipt = {
          ...result,
          protocol: "tweakloop.workspace-fork/v1",
          checkpoint: forked.checkpoint,
          processNonce: forked.processNonce,
          files: {
            restored: result.overlay.filter((entry) => entry.workingHash !== null).length,
            excluded: rebound.workspaceFilesManifest?.excluded ?? [],
            entries: result.overlay,
            counts: Object.fromEntries(
              ["clean", "modified", "untracked", "durable-only"].map((state) => [
                state,
                result.overlay.filter((entry) => entry.state === state).length,
              ]),
            ),
          },
          nextCommand,
        };
        if (globals().json) emitJson(receipt);
        else {
          info(`forked session: ${forked.checkpoint.sourceSessionId} → ${result.sessionId}`);
          info(`workspace: ${result.rootPath}`);
          info(
            `checkpoint: ${forked.checkpoint.artifacts.length} pinned artifact revisions; ${receipt.files.restored} workspace files`,
          );
          if (result.locator) {
            info(`review URL: ${result.locator.url}`);
            info(`receive one item: ${nextCommand}`);
          } else {
            info(`session locator: unavailable (${result.activation})`);
          }
        }
      } finally {
        rmSync(stagingParent, { force: true, recursive: true });
      }
    },
  );

workspace
  .command("restore <directory>")
  .description("verify a saved workspace and open an isolated restored copy")
  .option("--agent <id>", "agent identity for the new restored session", defaultAgentId())
  .action(async (directory: string, opts: { agent: string }) => {
    const connection = await ensureDaemon(rootPath());
    const result = await restoreWorkspaceExport(
      connection,
      directory,
      canonicalAgentId(opts.agent),
    );
    const nextCommand = result.locator
      ? renderInvocation(invocation, [
          "--workspace",
          result.rootPath,
          "next",
          "--session",
          result.locator.sessionId,
          "--wait",
          "--timeout",
          "300000",
          "--json",
        ])
      : null;
    if (globals().json) emitJson({ ...result, nextCommand });
    else {
      info(`restored workspace: ${result.rootPath}`);
      if (result.locator) {
        info(`review URL: ${result.locator.url}`);
        info(`receive one item: ${nextCommand}`);
        info(
          `persistent stream only: ${renderInvocation(invocation, ["--workspace", result.rootPath, "session", "listen", "--session", result.locator.sessionId])}`,
        );
      } else {
        info(`session locator: unavailable (${result.activation})`);
      }
    }
  });

program
  .command("restore <revisionId>")
  .description("republish a prior revision as the new head (rollback), and sync the source file")
  .option("--no-write-source", "do not overwrite the artifact's source file")
  .option("--agent <id>", "restore as this agent identity")
  .action(async (revisionId: string, opts: { writeSource: boolean; agent?: string }) => {
    const connection = await discoverDaemon(rootPath());
    if (!connection) fail("daemon is not running — start it with `tweak daemon start`");
    const actor = opts.agent ? { kind: "agent", id: opts.agent } : undefined;
    const restored = await restoreRevision(connection, revisionId, actor);
    let wroteSource = false;
    if (opts.writeSource && !restored.unchanged) {
      const snapshot = await getSnapshot(connection);
      const artifact = snapshot.artifacts.find((a) => a.artifactId === restored.artifactId);
      if (artifact?.sourcePath) {
        const bytes = await fetchRevisionSource(connection, revisionId);
        writeFileSync(artifact.sourcePath, bytes);
        wroteSource = true;
      } else {
        info("artifact has no source path — file not written");
      }
    }
    if (globals().json) {
      emitJson({ protocol: CLI_PROTOCOL, ...restored, wroteSource });
    } else {
      info(
        restored.unchanged
          ? `head already has this content (r${restored.seq})`
          : `restored as r${restored.seq} (${restored.revisionId})${wroteSource ? " — source file synced" : ""}`,
      );
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
        fail(
          `the daemon owns the event log while running — stop it first (${renderInvocation(invocation, ["daemon", "stop"])})`,
        );
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

function assertForkDestination(destination: string): void {
  const source = rootPath();
  if (destination === source || destination.startsWith(`${source}${sep}`)) {
    fail("workspace-fork.destination-inside-source: --into must be outside the current workspace");
  }
}

async function* readSseEvents(
  response: Response,
  appliedCursor: () => number,
): AsyncGenerator<EventEnvelope> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = chunk
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (data !== "") {
          try {
            yield JSON.parse(data) as EventEnvelope;
          } catch {
            console.log(
              JSON.stringify({
                protocol: AGENT_SESSION_PROTOCOL,
                kind: "resync",
                afterSeq: appliedCursor(),
                reason: "invalid event frame",
              }),
            );
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function streamWhiteboardDrafts(
  connection: DaemonConnection,
  artifactId: string,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(
    new URL(
      `/api/v1/whiteboards/${encodeURIComponent(artifactId)}/draft-events?after=0`,
      connection.baseUrl,
    ),
    {
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${connection.token}`,
      },
      signal,
    },
  );
  if (!res.ok || !res.body) throw new Error(`draft event stream failed: ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data !== "") {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        console.log(
          JSON.stringify({
            ...parsed,
            protocol: AGENT_SESSION_PROTOCOL,
            kind: "whiteboard-draft",
          }),
        );
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

try {
  if (invocationFailure !== null) throw invocationFailure;
  await program.parseAsync(process.argv);
} catch (err) {
  if (successfulParserExit(err)) process.exit(0);
  exitWithFailure(
    withStartupDiagnostics(err, renderInvocation(invocation, ["daemon", "start", "--foreground"])),
    jsonRequested(),
  );
}
