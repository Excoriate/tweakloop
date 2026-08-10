import { describe, expect, it } from "vitest";
import {
  agentSnapshotScope,
  deriveWorkChatContext,
  resolveClaimAgent,
  sessionTrafficMatches,
} from "../../src/cli/agent-context.js";
import { nativeEditorRoute } from "../../src/cli/whiteboard-workspace.js";
import type { Snapshot } from "../../src/protocol/snapshot.js";

describe("session-scoped agent operation", () => {
  it("delivers a same-session related-document event and excludes unrelated-session traffic", () => {
    const scope = { sessionId: "session_live", artifactId: "artifact_primary" };

    expect(
      sessionTrafficMatches(scope, {
        sessionId: "session_live",
        artifactId: "artifact_related",
      }),
    ).toBe(true);
    expect(
      sessionTrafficMatches(scope, {
        sessionId: "session_other",
        artifactId: "artifact_primary",
      }),
    ).toBe(false);
    expect(agentSnapshotScope(scope)).toEqual({ sessionId: "session_live" });
  });

  it("keeps artifact filtering for listeners that do not select a session", () => {
    const scope = { artifactId: "artifact_primary" };
    expect(
      sessionTrafficMatches(scope, { sessionId: "session_any", artifactId: "artifact_primary" }),
    ).toBe(true);
    expect(
      sessionTrafficMatches(scope, { sessionId: "session_any", artifactId: "artifact_related" }),
    ).toBe(false);
    expect(agentSnapshotScope(scope)).toEqual({ artifactId: "artifact_primary" });
  });
});

describe("receipt-derived agent context", () => {
  it("derives every task, comment, and selection identity from one work item", () => {
    const snapshot = fixtureSnapshot();

    const derived = deriveWorkChatContext(snapshot, "work_1");

    expect(derived).toMatchObject({
      workId: "work_1",
      sessionId: "session_1",
      artifactId: "artifact_doc",
      agentId: "codex",
    });
    expect(derived.references.map((reference) => reference.kind)).toEqual([
      "task",
      "comment",
      "selection",
      "comment",
      "selection",
    ]);
    expect(derived.references.filter((reference) => reference.kind === "selection")).toEqual([
      expect.objectContaining({
        artifactId: "artifact_doc",
        revisionId: "revision_1",
        textQuote: { exact: "first selected passage" },
        semanticId: "section.first",
      }),
      expect.objectContaining({
        artifactId: "artifact_doc",
        revisionId: "revision_1",
        semanticId: "section.second",
      }),
    ]);
  });

  it("derives completion identity from the exact active claim and rejects a stale claim", () => {
    const work = fixtureSnapshot().work[0];
    expect(resolveClaimAgent(work, "claim_1")).toBe("codex");
    expect(() => resolveClaimAgent(work, "claim_stale")).toThrow(/reclaim or recover/);
  });
});

describe("managed whiteboard editor guidance", () => {
  it("routes non-trivial authoring through a native editor and fails closed without one", () => {
    const route = nativeEditorRoute("/tmp/working.excalidraw");
    expect(route).toEqual({
      kind: "native-excalidraw-editor",
      scenePath: "/tmp/working.excalidraw",
      requirement: expect.stringContaining("owns element schema, versions, nonces, and bindings"),
      blocked: expect.stringContaining("do not synthesize non-trivial element JSON"),
      syncCommand: [
        "tweak",
        "whiteboard",
        "workspace",
        "sync",
        "/tmp/working.excalidraw",
        "--json",
      ],
    });
  });
});

function fixtureSnapshot(): Snapshot {
  return {
    protocol: "tweakloop.snapshot/v1",
    workspace: {
      workspaceId: "workspace_1",
      projectId: "project_1",
      rootPath: "/workspace",
      protocolVersion: 1,
      artifactOrigin: "http://127.0.0.1:2",
    },
    artifacts: [],
    revisions: [],
    intents: [
      {
        intentId: "intent_1",
        batchId: "batch_1",
        artifactId: "artifact_doc",
        revisionId: "revision_1",
        intentType: "replace-text",
        target: {
          semanticId: "section.first",
          textQuote: { exact: "first selected passage" },
        },
        body: { value: "replacement" },
        status: "submitted",
        createdSeq: 1,
      },
      {
        intentId: "intent_2",
        batchId: "batch_1",
        artifactId: "artifact_doc",
        revisionId: "revision_1",
        intentType: "comment",
        target: { semanticId: "section.second" },
        body: { text: "second comment" },
        status: "submitted",
        createdSeq: 2,
      },
    ],
    work: [
      {
        workId: "work_1",
        artifactId: "artifact_doc",
        baseRevisionId: "revision_1",
        intentIds: ["intent_1", "intent_2"],
        status: "claimed",
        assigneeAgentId: "codex",
        sessionId: "session_1",
        claim: { claimId: "claim_1", agentId: "codex" },
        result: null,
        progress: [],
        decision: "pending",
        createdSeq: 3,
      },
    ],
    chat: [],
    timeline: [],
    lastSeq: 3,
  };
}
