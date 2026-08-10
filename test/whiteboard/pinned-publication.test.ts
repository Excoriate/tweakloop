import { describe, expect, it } from "vitest";
import {
  committedWhiteboardPublicationReceipt,
  createWhiteboardPublicationPin,
  decidePinnedWhiteboardPublication,
  type WhiteboardPublicationTransactionSnapshot,
} from "../../src/whiteboard/pinned-publication.js";

const sceneHash = "a".repeat(64);
const elementIndexHash = "b".repeat(64);

function pin() {
  return createWhiteboardPublicationPin({
    artifactId: "artifact-board",
    draftId: "draft-board",
    baseRevisionId: "revision-head",
    draftVersion: 7,
    sceneHash,
    elementIndexHash,
    expectedHeadRevisionId: "revision-head",
  });
}

function current(
  overrides: Partial<WhiteboardPublicationTransactionSnapshot> = {},
): WhiteboardPublicationTransactionSnapshot {
  return {
    artifactId: "artifact-board",
    draftId: "draft-board",
    baseRevisionId: "revision-head",
    draftVersion: 7,
    sceneHash,
    elementIndexHash,
    currentHeadRevisionId: "revision-head",
    ...overrides,
  };
}

describe("transaction-local pinned whiteboard publication", () => {
  it("accepts only the exact draft/version/scene/index/head tuple and receipts the committed revision", () => {
    const decision = decidePinnedWhiteboardPublication(pin(), current());
    expect(decision).toMatchObject({ status: "accepted", pin: { draftVersion: 7, sceneHash } });
    if (decision.status !== "accepted") throw new Error("expected accepted publication fixture");
    expect(committedWhiteboardPublicationReceipt(decision, "revision-new")).toEqual({
      protocol: "tweakloop.whiteboard-publication-receipt/v1",
      artifactId: "artifact-board",
      revisionId: "revision-new",
      draftId: "draft-board",
      baseRevisionId: "revision-head",
      draftVersion: 7,
      sceneHash,
      elementIndexHash,
      expectedHeadRevisionId: "revision-head",
    });
  });

  it.each([
    ["draft version", { draftVersion: 8 }, "whiteboard.publish-stale-draft"],
    ["scene hash", { sceneHash: "c".repeat(64) }, "whiteboard.publish-stale-scene"],
    ["element index", { elementIndexHash: "d".repeat(64) }, "whiteboard.publish-stale-scene"],
    ["head", { currentHeadRevisionId: "revision-other" }, "whiteboard.publish-stale-head"],
  ])("rejects a stale %s with no revision candidate", (_label, overrides, code) => {
    const decision = decidePinnedWhiteboardPublication(pin(), current(overrides));
    expect(decision).toEqual(expect.objectContaining({ status: "rejected", code, revision: null }));
    expect("pin" in decision).toBe(false);
  });
});
