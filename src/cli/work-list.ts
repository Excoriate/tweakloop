import type { SnapshotWork } from "../protocol/snapshot.js";
import { CLI_PROTOCOL } from "../protocol/versions.js";
import type { Invocation } from "./invocation.js";
import { renderInvocation } from "./invocation.js";

export const WORK_LIST_COMPACT_MAX_BYTES = 16 * 1024;
export const WORK_LIST_STATUSES = ["open", "claimed", "addressed", "all"] as const;
export type WorkListStatus = (typeof WORK_LIST_STATUSES)[number];

export type WorkListFilters = Readonly<{
  status: WorkListStatus;
  workId?: string;
  sessionId?: string;
  artifactId?: string;
  full: boolean;
}>;

export type WorkListPageOptions = Readonly<{
  invocation: Invocation;
  cursor?: string;
}>;

type CompactWork = ReturnType<typeof compactWork>;

export type WorkListReceipt = Readonly<{
  protocol: typeof CLI_PROTOCOL;
  filters: Readonly<{
    status: WorkListStatus;
    workId: string | null;
    sessionId: string | null;
    artifactId: string | null;
    full: boolean;
  }>;
  count: number;
  pageCount: number;
  work: readonly (SnapshotWork | CompactWork)[];
  continuation: Readonly<{ cursor: string; command: string }> | null;
}>;

type WorkListCursor = Readonly<{
  version: 1;
  after: Readonly<{ createdSeq: number; workId: string }>;
  filters: WorkListReceipt["filters"];
}>;

export function parseWorkListStatus(value: string | undefined): WorkListStatus {
  const status = value ?? "open";
  if (!WORK_LIST_STATUSES.includes(status as WorkListStatus)) {
    throw new Error(
      `work-list.invalid-status: --status must be one of ${WORK_LIST_STATUSES.join(", ")}`,
    );
  }
  return status as WorkListStatus;
}

export function workListReceipt(
  work: readonly SnapshotWork[],
  filters: WorkListFilters,
  page: WorkListPageOptions,
): WorkListReceipt {
  const effectiveFilters = {
    status: filters.status,
    workId: filters.workId ?? null,
    sessionId: filters.sessionId ?? null,
    artifactId: filters.artifactId ?? null,
    full: filters.full,
  } as const;
  const selected = work.filter(
    (item) =>
      (filters.status === "all" || item.status === filters.status) &&
      (filters.workId === undefined || item.workId === filters.workId) &&
      (filters.sessionId === undefined || item.sessionId === filters.sessionId) &&
      (filters.artifactId === undefined || item.artifactId === filters.artifactId),
  );
  if (filters.full) {
    if (page.cursor !== undefined) {
      throw new Error("work-list.cursor-with-full: --cursor cannot be combined with --full");
    }
    return {
      protocol: CLI_PROTOCOL,
      filters: effectiveFilters,
      count: selected.length,
      pageCount: selected.length,
      work: selected,
      continuation: null,
    };
  }

  const after =
    page.cursor === undefined ? null : decodeCursor(page.cursor, effectiveFilters).after;
  const remaining = after === null ? selected : afterCursor(selected, after);
  let receipt = compactReceipt(effectiveFilters, selected.length, [], null);
  if (workListJsonBytes(receipt) > WORK_LIST_COMPACT_MAX_BYTES) {
    throw new Error(
      "work-list.filters-too-large: effective compact filters exceed 16 KiB before any work item",
    );
  }
  for (const [index, item] of remaining.entries()) {
    const candidateWork = [...receipt.work, compactWork(item)] as readonly CompactWork[];
    const hasMore = index + 1 < remaining.length;
    const continuation = hasMore ? continuationFor(item, effectiveFilters, page.invocation) : null;
    const candidate = compactReceipt(
      effectiveFilters,
      selected.length,
      candidateWork,
      continuation,
    );
    if (workListJsonBytes(candidate) > WORK_LIST_COMPACT_MAX_BYTES) break;
    receipt = candidate;
  }
  if (remaining.length > 0 && receipt.work.length === 0) {
    throw new Error(
      "work-list.item-too-large: one compact work item plus its continuation exceeds 16 KiB",
    );
  }
  return receipt;
}

export function workListJsonBytes(receipt: WorkListReceipt): number {
  return Buffer.byteLength(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
}

function compactReceipt(
  filters: WorkListReceipt["filters"],
  count: number,
  work: readonly CompactWork[],
  continuation: WorkListReceipt["continuation"],
): WorkListReceipt {
  return {
    protocol: CLI_PROTOCOL,
    filters,
    count,
    pageCount: work.length,
    work,
    continuation,
  };
}

function continuationFor(
  item: SnapshotWork,
  filters: WorkListReceipt["filters"],
  invocation: Invocation,
): NonNullable<WorkListReceipt["continuation"]> {
  const cursor = encodeCursor({
    version: 1,
    after: { createdSeq: item.createdSeq, workId: item.workId },
    filters,
  });
  return {
    cursor,
    command: renderInvocation(invocation, [
      "work",
      "list",
      "--status",
      filters.status,
      ...(filters.workId === null ? [] : ["--work", filters.workId]),
      ...(filters.sessionId === null ? [] : ["--session", filters.sessionId]),
      ...(filters.artifactId === null ? [] : ["--artifact", filters.artifactId]),
      "--cursor",
      cursor,
      "--json",
    ]),
  };
}

function encodeCursor(cursor: WorkListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(encoded: string, filters: WorkListReceipt["filters"]): WorkListCursor {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new Error("work-list.cursor-invalid: --cursor is not a valid work-list cursor");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    (value as { version?: unknown }).version !== 1
  ) {
    throw new Error("work-list.cursor-invalid: --cursor is not a valid work-list cursor");
  }
  const cursor = value as Partial<WorkListCursor>;
  if (
    cursor.after === undefined ||
    !Number.isSafeInteger(cursor.after.createdSeq) ||
    cursor.after.createdSeq < 0 ||
    typeof cursor.after.workId !== "string" ||
    cursor.filters === undefined
  ) {
    throw new Error("work-list.cursor-invalid: --cursor is not a valid work-list cursor");
  }
  if (JSON.stringify(cursor.filters) !== JSON.stringify(filters)) {
    throw new Error(
      "work-list.cursor-filter-mismatch: --cursor belongs to different effective filters",
    );
  }
  return cursor as WorkListCursor;
}

function afterCursor(
  selected: readonly SnapshotWork[],
  after: WorkListCursor["after"],
): readonly SnapshotWork[] {
  const exact = selected.findIndex(
    (item) => item.createdSeq === after.createdSeq && item.workId === after.workId,
  );
  if (exact >= 0) return selected.slice(exact + 1);
  return selected.filter(
    (item) =>
      item.createdSeq > after.createdSeq ||
      (item.createdSeq === after.createdSeq && item.workId > after.workId),
  );
}

function compactWork(item: SnapshotWork) {
  return {
    workId: item.workId,
    status: item.status,
    artifactId: item.artifactId,
    sessionId: item.sessionId,
    intentCount: item.intentIds.length,
    assigneeAgentId: item.assigneeAgentId,
    ...(item.claim ? { claimId: item.claim.claimId, claimedBy: item.claim.agentId } : {}),
  };
}
