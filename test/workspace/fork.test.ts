import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { rebuildProjections, snapshot } from "../../src/daemon/projections.js";
import { createTransactor } from "../../src/daemon/transactor.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import { forkWorkspaceHistory } from "../../src/workspace/fork.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function event(
  seq: number,
  eventType: string,
  streamType: string,
  streamId: string,
  streamVersion: number,
  payload: Record<string, unknown>,
  causationId: string,
): EventEnvelope {
  return {
    seq,
    eventId: `source_event_${seq}`,
    workspaceId: "workspace_source",
    streamType,
    streamId,
    streamVersion,
    eventType,
    schemaVersion: 1,
    recordedAt: `2026-08-07T12:00:0${seq}.000Z`,
    actor: { kind: "agent", id: "codex" },
    causationId,
    correlationId: "source_correlation",
    payload: { type: eventType, ...payload },
  };
}

function sourceHistory(): EventEnvelope[] {
  return [
    event(
      1,
      "workspace.opened",
      "workspace",
      "workspace_source",
      1,
      { workspaceId: "workspace_source", projectId: "project_1", rootPath: "/source" },
      "source_command_open",
    ),
    event(
      2,
      "artifact.registered",
      "artifact",
      "artifact_1",
      1,
      {
        artifactId: "artifact_1",
        name: "plan.md",
        format: "markdown",
        sourcePath: "/source/plan.md",
      },
      "source_event_1",
    ),
    event(
      3,
      "artifact.revision-published",
      "artifact",
      "artifact_1",
      2,
      {
        artifactId: "artifact_1",
        revisionId: "revision_pinned",
        parentId: null,
        seq: 1,
        format: "markdown",
        entryPath: "plan.md",
        entryHash: "a".repeat(64),
        files: [{ path: "plan.md", hash: "a".repeat(64), mediaType: "text/markdown" }],
        producer: { kind: "agent", id: "codex" },
        sourcePath: "/source/plan.md",
        sessionId: null,
      },
      "source_command_publish",
    ),
    event(
      4,
      "session.started",
      "session",
      "session_source",
      1,
      {
        sessionId: "session_source",
        artifactId: "artifact_1",
        originatingAgentId: "codex",
        agentId: "codex",
        processNonce: "source_process",
        baseRevisionId: "revision_pinned",
        title: "Pinned work",
        goal: "Continue independently",
        predecessorSessionId: null,
        handoffSummary: null,
      },
      "source_command_session",
    ),
    event(
      5,
      "session.artifact-attached",
      "session",
      "session_source",
      2,
      {
        sessionId: "session_source",
        artifactId: "artifact_1",
        revisionId: "revision_pinned",
        role: "primary",
      },
      "source_event_4",
    ),
  ];
}

function fork(prefix: string, events: readonly EventEnvelope[]) {
  return forkWorkspaceHistory({
    events,
    sourceWorkspaceId: "workspace_source",
    destinationWorkspaceId: `workspace_${prefix}`,
    sourceSessionId: "session_source",
    destinationSessionId: `session_${prefix}`,
    destinationRootPath: `/${prefix}`,
    destinationAgentId: "codex",
    destinationProcessNonce: `process_${prefix}`,
    recordedAt: "2026-08-07T13:00:00.000Z",
    forkCommandId: `command_fork_${prefix}`,
    forkCorrelationId: `correlation_fork_${prefix}`,
    mint: (kind, sourceId) => `${kind}_${prefix}_${sourceId}`,
  });
}

describe("workspace session forks", () => {
  it("pins exact artifact membership while minting destination identity and causal namespaces", () => {
    const source = sourceHistory();
    const frozenSource = JSON.stringify(source);
    const result = fork("a", source);

    expect(result.checkpoint).toEqual({
      sourceSessionId: "session_source",
      destinationSessionId: "session_a",
      capturedSeq: 5,
      baseRevisionId: "revision_pinned",
      agentId: "codex",
      status: "active",
      artifacts: [
        {
          artifactId: "artifact_1",
          revisionId: "revision_pinned",
          role: "primary",
          attachedSeq: 5,
        },
      ],
    });
    expect(result.events.map((item) => item.eventId)).not.toEqual(
      source.map((item) => item.eventId),
    );
    expect(result.events[1]?.causationId).toBe(result.events[0]?.eventId);
    expect(result.events[2]?.causationId).toBe("command_fork_a");
    expect(new Set(result.events.map((item) => item.correlationId))).toEqual(
      new Set(["correlation_fork_a"]),
    );
    expect(result.events[3]).toMatchObject({
      workspaceId: "workspace_a",
      streamId: "session_a_session_source",
      payload: {
        sessionId: "session_a_session_source",
        artifactId: "artifact_1",
        baseRevisionId: "revision_pinned",
        sourceProvenance: { eventId: "source_event_4", sessionId: "session_source" },
      },
    });
    expect(result.events[5]).toMatchObject({
      eventType: "session.started",
      streamId: "session_a",
      causationId: "command_fork_a",
      correlationId: "correlation_fork_a",
      payload: {
        sessionId: "session_a",
        predecessorSessionId: "session_a_session_source",
        processNonce: "process_a",
      },
    });
    expect(JSON.stringify(source)).toBe(frozenSource);
  });

  it("creates two replayable, independent destinations without consulting a moving artifact head", () => {
    const source = sourceHistory();
    const first = fork("one", source);
    const second = fork("two", source);
    expect(first.destinationWorkspaceId).not.toBe(second.destinationWorkspaceId);
    expect(first.checkpoint.destinationSessionId).not.toBe(second.checkpoint.destinationSessionId);
    expect(first.events.map((item) => item.eventId)).not.toEqual(
      second.events.map((item) => item.eventId),
    );
    expect(first.checkpoint.artifacts).toEqual(second.checkpoint.artifacts);

    for (const candidate of [first, second]) {
      const root = mkdtempSync(join(tmpdir(), "tweakloop-fork-"));
      roots.push(root);
      const db = openDatabase(join(root, "workspace.db"));
      const transactor = createTransactor({
        db,
        workspaceId: candidate.destinationWorkspaceId,
        newEventId: () => "unused",
        now: () => "2026-08-07T13:00:00.000Z",
        onCommitted: () => {},
      });
      transactor.restoreHistory({ events: candidate.events, blobs: [] });
      const before = snapshot(db, candidate.destinationWorkspaceId);
      rebuildProjections(db, candidate.destinationWorkspaceId);
      const after = snapshot(db, candidate.destinationWorkspaceId);
      expect(after).toEqual(before);
      expect(after.artifacts[0]).toMatchObject({ artifactId: "artifact_1" });
      expect(after.revisions[0]).toMatchObject({
        artifactId: "artifact_1",
        revisionId: "revision_pinned",
      });
      expect(
        after.sessionArtifacts.find(
          (artifact) => artifact.sessionId === candidate.checkpoint.destinationSessionId,
        ),
      ).toMatchObject({
        sessionId: candidate.checkpoint.destinationSessionId,
        artifactId: "artifact_1",
        attachedRevisionId: "revision_pinned",
        role: "primary",
      });
      db.close();
    }
  });
});
