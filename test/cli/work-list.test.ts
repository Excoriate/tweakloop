import { describe, expect, it } from "vitest";
import type { Invocation } from "../../src/cli/invocation.js";
import {
  parseWorkListStatus,
  WORK_LIST_COMPACT_MAX_BYTES,
  workListJsonBytes,
  workListReceipt,
} from "../../src/cli/work-list.js";
import type { SnapshotWork } from "../../src/protocol/snapshot.js";

const invocation: Invocation = {
  prefix: ["/opt/tweak bin/tweak"],
  globalArgs: ["--workspace", "/workspace with spaces"],
  source: "installed",
};
const page = { invocation } as const;
const compactFilters = { status: "all", full: false } as const;
const largeMarker = "ADDRESSED_SUMMARY_MUST_NOT_LEAK_".repeat(300);
const work: SnapshotWork[] = [
  item("work_open", "open", "session_a", "artifact_a", 1),
  {
    ...item("work_claimed", "claimed", "session_b", "artifact_b", 2),
    claim: { claimId: "claim_b", agentId: "agent_b" },
  },
  {
    ...item("work_addressed", "addressed", "session_a", "artifact_a", 3),
    result: { summary: largeMarker, revisionId: "rev_2", agentId: "agent_a" },
    progress: [
      {
        summary: largeMarker,
        revisionId: "rev_2",
        agentId: "agent_a",
        addressedIntentIds: ["intent_1"],
        seq: 4,
        recordedAt: "2026-08-08T12:00:00.000Z",
      },
    ],
  },
];

describe("compact filtered work list", () => {
  it("defaults to open and omits result/progress bodies under the compact byte ceiling", () => {
    const receipt = workListReceipt(
      work,
      { status: parseWorkListStatus(undefined), full: false },
      page,
    );
    expect(receipt.count).toBe(1);
    expect(receipt.pageCount).toBe(1);
    expect(receipt.continuation).toBeNull();
    expect(receipt.work).toEqual([
      {
        workId: "work_open",
        status: "open",
        artifactId: "artifact_a",
        sessionId: "session_a",
        intentCount: 1,
        assigneeAgentId: null,
      },
    ]);
    const encoded = JSON.stringify(receipt);
    expect(encoded).not.toContain("ADDRESSED_SUMMARY_MUST_NOT_LEAK");
    expect(workListJsonBytes(receipt)).toBeLessThanOrEqual(WORK_LIST_COMPACT_MAX_BYTES);
  });

  it("composes exact work, status, session, and artifact filters before full projection", () => {
    const receipt = workListReceipt(
      work,
      {
        status: "addressed",
        workId: "work_addressed",
        sessionId: "session_a",
        artifactId: "artifact_a",
        full: true,
      },
      page,
    );
    expect(receipt.count).toBe(1);
    expect(receipt.continuation).toBeNull();
    expect(receipt.work[0]).toMatchObject({
      workId: "work_addressed",
      result: { summary: largeMarker },
    });
  });

  it("keeps all statuses compact unless full is explicit", () => {
    const receipt = workListReceipt(work, compactFilters, page);
    expect(receipt.count).toBe(3);
    expect(JSON.stringify(receipt)).not.toContain("ADDRESSED_SUMMARY_MUST_NOT_LEAK");
    expect(receipt.work[1]).toMatchObject({ claimId: "claim_b", claimedBy: "agent_b" });
  });

  it("returns an explicit effective-filter receipt for an empty result", () => {
    expect(
      workListReceipt(work, { status: "open", sessionId: "session_missing", full: false }, page),
    ).toMatchObject({
      filters: {
        status: "open",
        workId: null,
        sessionId: "session_missing",
        artifactId: null,
        full: false,
      },
      count: 0,
      pageCount: 0,
      work: [],
      continuation: null,
    });
  });

  it("rejects an empty compact result when its effective filters alone exceed 16 KiB", () => {
    expect(() =>
      workListReceipt(
        work,
        { status: "all", workId: `missing_${"x".repeat(17 * 1024)}`, full: false },
        page,
      ),
    ).toThrow(/^work-list\.filters-too-large:/);
  });

  it("admits compact JSON immediately below and at 16 KiB, then paginates above it", () => {
    const atBound = exactBoundFixture();
    const last = atBound.at(-1);
    if (!last) throw new Error("expected exact-bound fixture");
    const belowBound = [
      ...atBound.slice(0, -1),
      { ...last, artifactId: last.artifactId.slice(0, -1) },
    ];
    const belowReceipt = workListReceipt(belowBound, compactFilters, page);
    const atReceipt = workListReceipt(atBound, compactFilters, page);
    expect(workListJsonBytes(belowReceipt)).toBe(WORK_LIST_COMPACT_MAX_BYTES - 1);
    expect(belowReceipt.continuation).toBeNull();
    expect(workListJsonBytes(atReceipt)).toBe(WORK_LIST_COMPACT_MAX_BYTES);
    expect(atReceipt.continuation).toBeNull();

    const aboveBound = [
      ...atBound,
      item("work_above", "open", "session_a", "artifact_a", atBound.length + 1),
    ];
    const aboveReceipt = workListReceipt(aboveBound, compactFilters, page);
    expect(workListJsonBytes(aboveReceipt)).toBeLessThanOrEqual(WORK_LIST_COMPACT_MAX_BYTES);
    expect(aboveReceipt.continuation).not.toBeNull();
    expect(aboveReceipt.pageCount).toBeLessThan(aboveReceipt.count);
  });

  it("walks a 400-item compact fixture in DB order without gaps, duplicates, or oversized values", () => {
    const large = Array.from({ length: 400 }, (_, index) =>
      item(
        `work_${String(index + 1).padStart(4, "0")}`,
        index % 2 === 0 ? "open" : "addressed",
        "session_large",
        "artifact_large",
        index + 1,
      ),
    );
    const filters = {
      status: "all",
      sessionId: "session_large",
      artifactId: "artifact_large",
      full: false,
    } as const;
    const observed: string[] = [];
    let cursor: string | undefined;
    let pageCount = 0;
    do {
      const receipt = workListReceipt(
        large,
        filters,
        cursor === undefined ? page : { invocation, cursor },
      );
      pageCount += 1;
      expect(pageCount).toBeLessThan(400);
      expect(workListJsonBytes(receipt)).toBeLessThanOrEqual(WORK_LIST_COMPACT_MAX_BYTES);
      observed.push(...receipt.work.map((entry) => entry.workId));
      if (receipt.continuation !== null) {
        expect(receipt.continuation.command).toContain("'/opt/tweak bin/tweak'");
        expect(receipt.continuation.command).toContain("'--workspace' '/workspace with spaces'");
        expect(receipt.continuation.command).toContain("'--status' 'all'");
        expect(receipt.continuation.command).toContain("'--session' 'session_large'");
        expect(receipt.continuation.command).toContain("'--artifact' 'artifact_large'");
        expect(receipt.continuation.command).toContain(
          `'--cursor' '${receipt.continuation.cursor}'`,
        );
      }
      cursor = receipt.continuation?.cursor;
    } while (cursor !== undefined);

    expect(pageCount).toBeGreaterThan(1);
    expect(observed).toEqual(large.map((entry) => entry.workId));
    expect(new Set(observed).size).toBe(400);
  });

  it("rejects a continuation cursor when any effective filter changes", () => {
    const large = Array.from({ length: 400 }, (_, index) =>
      item(`work_${index}`, "open", "session_a", "artifact_a", index + 1),
    );
    const first = workListReceipt(
      large,
      { status: "open", sessionId: "session_a", artifactId: "artifact_a", full: false },
      page,
    );
    const cursor = first.continuation?.cursor;
    if (!cursor) throw new Error("expected continuation cursor");
    expect(() =>
      workListReceipt(
        large,
        { status: "all", sessionId: "session_a", artifactId: "artifact_a", full: false },
        { invocation, cursor },
      ),
    ).toThrow(/^work-list\.cursor-filter-mismatch:/);
  });

  it("keeps the unbounded aggregate behind explicit full mode", () => {
    const large = Array.from({ length: 400 }, (_, index) => ({
      ...item(`work_${index}`, "addressed", "session_a", "artifact_a", index + 1),
      result: { summary: largeMarker, revisionId: `rev_${index}`, agentId: "agent_a" },
    }));
    const compact = workListReceipt(large, compactFilters, page);
    const full = workListReceipt(large, { status: "all", full: true }, page);
    expect(workListJsonBytes(compact)).toBeLessThanOrEqual(WORK_LIST_COMPACT_MAX_BYTES);
    expect(compact.continuation).not.toBeNull();
    expect(workListJsonBytes(full)).toBeGreaterThan(WORK_LIST_COMPACT_MAX_BYTES);
    expect(full.pageCount).toBe(400);
    expect(full.continuation).toBeNull();
  });

  it("fails invalid status with the stable code", () => {
    expect(() => parseWorkListStatus("pending")).toThrow(/^work-list\.invalid-status:/);
  });
});

function exactBoundFixture(): SnapshotWork[] {
  let fitting: SnapshotWork[] = [];
  for (let index = 1; index <= 400; index += 1) {
    const candidate = [
      ...fitting,
      item(
        `work_boundary_${String(index).padStart(4, "0")}`,
        "open",
        "session_boundary",
        "artifact_boundary",
        index,
      ),
    ];
    const receipt = workListReceipt(candidate, compactFilters, page);
    if (receipt.continuation !== null) break;
    fitting = candidate;
  }
  const receipt = workListReceipt(fitting, compactFilters, page);
  const padding = WORK_LIST_COMPACT_MAX_BYTES - workListJsonBytes(receipt);
  const last = fitting.at(-1);
  if (!last || padding < 1) throw new Error("could not construct exact-bound fixture");
  return [
    ...fitting.slice(0, -1),
    { ...last, artifactId: `${last.artifactId}${"x".repeat(padding)}` },
  ];
}

function item(
  workId: string,
  status: SnapshotWork["status"],
  sessionId: string,
  artifactId: string,
  createdSeq: number,
): SnapshotWork {
  return {
    workId,
    artifactId,
    baseRevisionId: "rev_1",
    intentIds: ["intent_1"],
    status,
    assigneeAgentId: null,
    sessionId,
    claim: null,
    result: null,
    progress: [],
    decision: "pending",
    createdSeq,
  };
}
