import { describe, expect, it } from "vitest";
import type { DomainCommand } from "../../src/domain/commands.js";
import { decide } from "../../src/domain/decide.js";
import { evolve } from "../../src/domain/evolve.js";
import { type DomainState, initialState } from "../../src/domain/state.js";

function apply(state: DomainState, command: DomainCommand): DomainState {
  const result = decide(state, command);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.events.reduce(evolve, state);
}

function artifactState(): DomainState {
  const state = apply(initialState, {
    type: "artifact.register",
    artifactId: "document_1",
    name: "design.md",
    format: "markdown",
    sourcePath: "/repo/design.md",
  });
  return apply(state, {
    type: "artifact.publish",
    artifactId: "document_1",
    revisionId: "revision_1",
    format: "markdown",
    entryPath: "design.md",
    entryHash: "hash_1",
    files: [{ path: "design.md", hash: "hash_1", mediaType: "text/markdown" }],
    producer: { kind: "agent", id: "agent-a" },
    sourcePath: "/repo/design.md",
  });
}

describe("durable session lineage", () => {
  it("preserves origin and explicit A to B takeover lineage", () => {
    let state = apply(artifactState(), {
      type: "session.start",
      sessionId: "session_a",
      artifactId: "document_1",
      agentId: "agent-a",
      processNonce: "process-a",
      baseRevisionId: "revision_1",
      title: "Design pass",
      goal: "Make the design implementable",
    });
    state = apply(state, {
      type: "session.handoff",
      sessionId: "session_a",
      agentId: "agent-a",
      toAgentId: "agent-b",
      summary: "Continue with the unresolved API comment",
    });

    expect(
      decide(state, {
        type: "session.resume",
        sessionId: "session_c",
        predecessorSessionId: "session_a",
        agentId: "agent-c",
        processNonce: "process-c",
        baseRevisionId: null,
        title: null,
        goal: null,
      }),
    ).toMatchObject({ ok: false, code: "session.handoff-required" });

    state = apply(state, {
      type: "session.resume",
      sessionId: "session_b",
      predecessorSessionId: "session_a",
      agentId: "agent-b",
      processNonce: "process-b",
      baseRevisionId: null,
      title: null,
      goal: null,
    });
    expect(state.sessions.get("session_b")).toMatchObject({
      primaryArtifactId: "document_1",
      artifacts: [{ artifactId: "document_1", attachedRevisionId: "revision_1", role: "primary" }],
      originatingAgentId: "agent-a",
      agentId: "agent-b",
      predecessorSessionId: "session_a",
      title: "Design pass",
      goal: "Make the design implementable",
      handoffSummary: "Continue with the unresolved API comment",
      status: "active",
    });
  });

  it("creates a truly artifact-free durable session and restores a workspace as the first fact", () => {
    const restored = evolve(initialState, {
      type: "workspace.restored",
      workspaceId: "workspace_restored",
      projectId: "project_restored",
      rootPath: "/restored",
      sourceWorkspaceId: "workspace_source",
      sourceProjectId: "project_source",
      sourceRootPath: "/source",
      capturedSeq: 42,
    });
    const result = decide(restored, {
      type: "session.start",
      sessionId: "session_empty",
      artifactId: null,
      agentId: "agent-a",
      processNonce: "process-empty",
      baseRevisionId: null,
      title: "Empty room",
      goal: "Attach later",
    });
    expect(result).toMatchObject({
      ok: true,
      events: [{ type: "session.started", artifactId: null }],
    });
    if (!result.ok) throw new Error(result.message);
    const state = result.events.reduce(evolve, restored);
    expect(state.workspaceOpened).toBe(true);
    expect(state.sessions.get("session_empty")).toMatchObject({
      primaryArtifactId: null,
      artifacts: [],
    });
    expect(state.artifacts.size).toBe(0);
    expect(state.revisions.size).toBe(0);
  });

  it("attaches many artifacts later, rejects wrong neighbors, and treats an identical attachment as a no-op", () => {
    let state = apply(initialState, {
      type: "session.start",
      sessionId: "session_a",
      artifactId: null,
      agentId: "same-agent",
      processNonce: "process-a",
      baseRevisionId: null,
      title: "A",
      goal: "A only",
    });
    state = apply(state, {
      type: "session.start",
      sessionId: "session_b",
      artifactId: null,
      agentId: "same-agent",
      processNonce: "process-b",
      baseRevisionId: null,
      title: "B",
      goal: "B only",
    });
    state = apply(state, {
      type: "artifact.create",
      artifactId: "artifact_a",
      name: "a.md",
      format: "markdown",
      sourcePath: null,
      provenance: { kind: "imported-snapshot", originalName: "a.md" },
      revisionId: "revision_a1",
      entryPath: "a.md",
      entryHash: "hash_a1",
      files: [{ path: "a.md", hash: "hash_a1", mediaType: "text/markdown" }],
      producer: { kind: "human", id: "alex" },
      attachment: { sessionId: "session_a", role: "opened" },
    });
    state = apply(state, {
      type: "artifact.create",
      artifactId: "artifact_b",
      name: "b.md",
      format: "markdown",
      sourcePath: null,
      provenance: { kind: "imported-snapshot", originalName: "b.md" },
      revisionId: "revision_b1",
      entryPath: "b.md",
      entryHash: "hash_b1",
      files: [{ path: "b.md", hash: "hash_b1", mediaType: "text/markdown" }],
      producer: { kind: "human", id: "alex" },
      attachment: { sessionId: "session_b", role: "opened" },
    });
    expect(state.sessions.get("session_a")?.artifacts.map((item) => item.artifactId)).toEqual([
      "artifact_a",
    ]);
    expect(state.sessions.get("session_b")?.artifacts.map((item) => item.artifactId)).toEqual([
      "artifact_b",
    ]);

    expect(
      decide(state, {
        type: "session.attach-artifact",
        sessionId: "session_a",
        artifactId: "artifact_a",
        revisionId: "revision_a1",
        role: "opened",
      }),
    ).toMatchObject({ ok: true, events: [], response: { alreadyAttached: true } });
    expect(
      decide(state, {
        type: "session.attach-artifact",
        sessionId: "session_a",
        artifactId: "artifact_a",
        revisionId: "revision_b1",
        role: "opened",
      }),
    ).toMatchObject({ ok: false, code: "revision.unknown" });
    expect(
      decide(state, {
        type: "session.attach-artifact",
        sessionId: "session_missing",
        artifactId: "artifact_a",
        revisionId: "revision_a1",
        role: "opened",
      }),
    ).toMatchObject({ ok: false, code: "session.unknown" });
  });
});
