import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import Database from "better-sqlite3";

const OPERATION_ID = /^operation_[a-f0-9]{64}$/;
const HASH = /^[a-f0-9]{64}$/;
const BUNDLE_ID = /^bundle_[a-f0-9]{64}$/;

export type WorkspaceExportOperationIntent = Readonly<{
  protocol: "tweakloop.workspace-export-operation/v1";
  operationId: string;
  requestFingerprint: string;
  sourceWorkspaceId: string;
  sourceCheckpoint: number;
  destination: string;
  filesPolicyHash: string;
}>;

export type WorkspaceExportStableResult = Readonly<{
  protocol: "tweakloop.workspace-export-result/v1";
  operationId: string;
  requestFingerprint: string;
  sourceWorkspaceId: string;
  sourceCheckpoint: number;
  destination: string;
  filesPolicyHash: string;
  bundleId: string;
  collaborationManifestHash: string;
  workspaceFilesManifestHash: string | null;
  recordedAt: string;
}>;

export class WorkspaceExportOperationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "WorkspaceExportOperationError";
  }
}

export function deriveWorkspaceExportOperationId(
  input: Readonly<{
    sourceWorkspaceId: string;
    destination: string;
    filesPolicyHash: string;
  }>,
): string {
  requireText(input.sourceWorkspaceId, "source workspace id");
  requireHash(input.filesPolicyHash, "files policy hash");
  return `operation_${hashCanonical({
    domain: "tweakloop.workspace-export-operation/v1",
    sourceWorkspaceId: input.sourceWorkspaceId,
    destination: resolve(input.destination),
    filesPolicyHash: input.filesPolicyHash,
  })}`;
}

export function workspaceExportFilesPolicyHash(value: unknown): string {
  return hashCanonical({
    domain: "tweakloop.workspace-export-files-policy/v1",
    value,
  });
}

export function createWorkspaceExportOperationStore(
  baseDir: string,
  options: Readonly<{ now?: () => string }> = {},
) {
  const root = resolve(baseDir);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const db = new Database(resolve(root, "workspace-export-operations.sqlite"));
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("busy_timeout = 5000");
  db.exec(
    "CREATE TABLE IF NOT EXISTS workspace_export_meta (" +
      "singleton INTEGER PRIMARY KEY CHECK (singleton = 1), protocol_version INTEGER NOT NULL" +
      ") STRICT;" +
      "CREATE TABLE IF NOT EXISTS workspace_export_operations (" +
      "operation_id TEXT PRIMARY KEY, request_fingerprint TEXT NOT NULL, intent_json TEXT NOT NULL, " +
      "status TEXT NOT NULL, result_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL" +
      ") STRICT;",
  );
  const meta = db
    .prepare("SELECT protocol_version FROM workspace_export_meta WHERE singleton = 1")
    .get() as { protocol_version: number } | undefined;
  if (!meta) {
    db.prepare("INSERT INTO workspace_export_meta VALUES (1, 1)").run();
  } else if (meta.protocol_version !== 1) {
    db.close();
    throw exportError(
      "workspace-export.migration-required",
      "workspace export operation store requires migration",
    );
  }
  const now = options.now ?? (() => new Date().toISOString());

  function begin(
    input: Readonly<{
      operationId: string;
      sourceWorkspaceId: string;
      sourceCheckpoint: number;
      destination: string;
      filesPolicyHash: string;
    }>,
  ):
    | Readonly<{ status: "capture"; intent: WorkspaceExportOperationIntent }>
    | Readonly<{
        status: "completed";
        intent: WorkspaceExportOperationIntent;
        result: WorkspaceExportStableResult;
      }> {
    requireOperationId(input.operationId);
    requireText(input.sourceWorkspaceId, "source workspace id");
    requireCheckpoint(input.sourceCheckpoint);
    requireHash(input.filesPolicyHash, "files policy hash");
    const intent: WorkspaceExportOperationIntent = {
      protocol: "tweakloop.workspace-export-operation/v1",
      operationId: input.operationId,
      requestFingerprint: hashCanonical({
        protocol: "tweakloop.workspace-export-request-fingerprint/v1",
        sourceWorkspaceId: input.sourceWorkspaceId,
        sourceCheckpoint: input.sourceCheckpoint,
        destination: resolve(input.destination),
        filesPolicyHash: input.filesPolicyHash,
      }),
      sourceWorkspaceId: input.sourceWorkspaceId,
      sourceCheckpoint: input.sourceCheckpoint,
      destination: resolve(input.destination),
      filesPolicyHash: input.filesPolicyHash,
    };
    const transaction = db.transaction(() => {
      const row = db
        .prepare(
          "SELECT request_fingerprint, intent_json, status, result_json " +
            "FROM workspace_export_operations WHERE operation_id = ?",
        )
        .get(input.operationId) as
        | {
            request_fingerprint: string;
            intent_json: string;
            status: string;
            result_json: string | null;
          }
        | undefined;
      if (row) {
        if (row.request_fingerprint !== intent.requestFingerprint) {
          throw exportError(
            "workspace-export.operation-conflict",
            "export operation id is already bound to another source checkpoint, destination, or files policy",
          );
        }
        const persistedIntent = parseIntent(JSON.parse(row.intent_json));
        if (canonicalJson(persistedIntent) !== canonicalJson(intent)) {
          throw exportError(
            "workspace-export.operation-corrupt",
            "export operation intent differs from its request fingerprint",
          );
        }
        if (row.status === "completed" && row.result_json !== null) {
          return {
            status: "completed" as const,
            intent,
            result: parseResult(JSON.parse(row.result_json)),
          };
        }
        throw exportError(
          "workspace-export.operation-in-progress",
          "export operation has no committed stable result",
        );
      }
      const timestamp = now();
      db.prepare(
        "INSERT INTO workspace_export_operations " +
          "(operation_id, request_fingerprint, intent_json, status, result_json, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'active', NULL, ?, ?)",
      ).run(
        intent.operationId,
        intent.requestFingerprint,
        canonicalJson(intent),
        timestamp,
        timestamp,
      );
      return { status: "capture" as const, intent };
    });
    return transaction.immediate();
  }

  function complete(
    intent: WorkspaceExportOperationIntent,
    result: Readonly<{
      bundleId: string;
      collaborationManifestHash: string;
      workspaceFilesManifestHash: string | null;
    }>,
  ): WorkspaceExportStableResult {
    requireBundleId(result.bundleId);
    requireHash(result.collaborationManifestHash, "collaboration manifest hash");
    if (result.workspaceFilesManifestHash !== null) {
      requireHash(result.workspaceFilesManifestHash, "workspace files manifest hash");
    }
    const transaction = db.transaction(() => {
      const row = db
        .prepare(
          "SELECT request_fingerprint, status, result_json " +
            "FROM workspace_export_operations WHERE operation_id = ?",
        )
        .get(intent.operationId) as
        | { request_fingerprint: string; status: string; result_json: string | null }
        | undefined;
      if (!row || row.request_fingerprint !== intent.requestFingerprint) {
        throw exportError(
          "workspace-export.operation-conflict",
          "export operation changed before result commit",
        );
      }
      if (row.status === "completed" && row.result_json !== null) {
        const existing = parseResult(JSON.parse(row.result_json));
        if (
          existing.bundleId !== result.bundleId ||
          existing.collaborationManifestHash !== result.collaborationManifestHash ||
          existing.workspaceFilesManifestHash !== result.workspaceFilesManifestHash
        ) {
          throw exportError(
            "workspace-export.result-conflict",
            "export operation is already committed with another bundle",
          );
        }
        return existing;
      }
      if (row.status !== "active") {
        throw exportError(
          "workspace-export.operation-conflict",
          "export operation cannot commit from its current state",
        );
      }
      const stable: WorkspaceExportStableResult = {
        protocol: "tweakloop.workspace-export-result/v1",
        operationId: intent.operationId,
        requestFingerprint: intent.requestFingerprint,
        sourceWorkspaceId: intent.sourceWorkspaceId,
        sourceCheckpoint: intent.sourceCheckpoint,
        destination: intent.destination,
        filesPolicyHash: intent.filesPolicyHash,
        ...result,
        recordedAt: now(),
      };
      db.prepare(
        "UPDATE workspace_export_operations SET status = 'completed', result_json = ?, updated_at = ? " +
          "WHERE operation_id = ? AND request_fingerprint = ? AND status = 'active'",
      ).run(
        canonicalJson(stable),
        stable.recordedAt,
        intent.operationId,
        intent.requestFingerprint,
      );
      return stable;
    });
    return transaction.immediate();
  }

  function abandon(intent: WorkspaceExportOperationIntent): void {
    db.prepare(
      "DELETE FROM workspace_export_operations " +
        "WHERE operation_id = ? AND request_fingerprint = ? AND status = 'active'",
    ).run(intent.operationId, intent.requestFingerprint);
  }

  function close(): void {
    db.close();
  }

  return { begin, complete, abandon, close } as const;
}

function parseIntent(value: unknown): WorkspaceExportOperationIntent {
  const record = requireRecord(value, "export operation intent");
  if (record.protocol !== "tweakloop.workspace-export-operation/v1") invalid("intent protocol");
  requireOperationId(record.operationId);
  requireHash(record.requestFingerprint, "request fingerprint");
  requireText(record.sourceWorkspaceId, "source workspace id");
  requireCheckpoint(record.sourceCheckpoint);
  requireText(record.destination, "destination");
  requireHash(record.filesPolicyHash, "files policy hash");
  return record as unknown as WorkspaceExportOperationIntent;
}

function parseResult(value: unknown): WorkspaceExportStableResult {
  const record = requireRecord(value, "export stable result");
  if (record.protocol !== "tweakloop.workspace-export-result/v1") invalid("result protocol");
  requireOperationId(record.operationId);
  requireHash(record.requestFingerprint, "request fingerprint");
  requireText(record.sourceWorkspaceId, "source workspace id");
  requireCheckpoint(record.sourceCheckpoint);
  requireText(record.destination, "destination");
  requireHash(record.filesPolicyHash, "files policy hash");
  requireBundleId(record.bundleId);
  requireHash(record.collaborationManifestHash, "collaboration manifest hash");
  if (record.workspaceFilesManifestHash !== null) {
    requireHash(record.workspaceFilesManifestHash, "workspace files manifest hash");
  }
  requireText(record.recordedAt, "recordedAt");
  return record as unknown as WorkspaceExportStableResult;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalValue(entry)]),
    );
  }
  return value;
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function requireOperationId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) invalid("operation id");
}

function requireHash(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) invalid(field);
}

function requireBundleId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !BUNDLE_ID.test(value)) invalid("bundle id");
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) invalid(field);
}

function requireCheckpoint(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) invalid("source checkpoint");
}

function invalid(field: string): never {
  throw exportError("workspace-export.receipt-invalid", `workspace export ${field} is invalid`);
}

function exportError(code: string, message: string): WorkspaceExportOperationError {
  return new WorkspaceExportOperationError(code, message);
}
