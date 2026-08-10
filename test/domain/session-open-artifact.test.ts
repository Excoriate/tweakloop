import { describe, expect, it } from "vitest";
import type { DomainCommand } from "../../src/domain/commands.js";
import { decide } from "../../src/domain/decide.js";
import type { DomainEvent } from "../../src/domain/events.js";
import { evolve } from "../../src/domain/evolve.js";
import { initialState } from "../../src/domain/state.js";

const actor = { kind: "agent", id: "codex" } as const;

function emptySessionState() {
  return [
    {
      type: "workspace.opened",
      workspaceId: "ws",
      projectId: "project",
      rootPath: "/repo",
    },
    {
      type: "session.started",
      sessionId: "session_existing",
      artifactId: null,
      originatingAgentId: "codex",
      agentId: "codex",
      processNonce: "process_existing",
      baseRevisionId: null,
      title: "Existing",
      goal: "Open artifacts atomically",
      predecessorSessionId: null,
      handoffSummary: null,
    },
  ].reduce((state, event) => evolve(state, event as DomainEvent), initialState);
}

function openCommand(overrides: Partial<DomainCommand> = {}): DomainCommand {
  return {
    type: "session.open-artifact",
    sessionId: "session_existing",
    artifactId: "artifact_plan",
    name: "plan.html",
    format: "html",
    sourcePath: "/repo/plan.html",
    provenance: { kind: "workspace-source" },
    revisionId: "rev_plan_1",
    entryPath: "plan.html",
    entryHash: "hash_plan_1",
    files: [{ path: "plan.html", hash: "hash_plan_1", mediaType: "text/html" }],
    producer: actor,
    role: "opened",
    ...overrides,
  } as DomainCommand;
}

describe("existing-session artifact open", () => {
  it("registers, publishes, and attaches in one decision", () => {
    let state = emptySessionState();
    const first = decide(state, openCommand());
    if (!first.ok) throw new Error(first.code);
    expect(first.events.map((event) => event.type)).toEqual([
      "artifact.registered",
      "artifact.revision-published",
      "session.artifact-attached",
    ]);
    state = first.events.reduce(evolve, state);
    expect(state.sessions.get("session_existing")?.artifacts).toEqual([
      {
        artifactId: "artifact_plan",
        attachedRevisionId: "rev_plan_1",
        role: "opened",
      },
    ]);

    const sameBytes = decide(state, openCommand({ revisionId: "unused_retry_revision" }));
    expect(sameBytes).toMatchObject({
      ok: true,
      events: [],
      response: {
        revisionId: "rev_plan_1",
        unchanged: true,
        alreadyAttached: true,
      },
    });

    const changed = decide(
      state,
      openCommand({
        revisionId: "rev_plan_2",
        entryHash: "hash_plan_2",
        files: [{ path: "plan.html", hash: "hash_plan_2", mediaType: "text/html" }],
      }),
    );
    if (!changed.ok) throw new Error(changed.code);
    expect(changed.events.map((event) => event.type)).toEqual(["artifact.revision-published"]);
  });

  it("rejects a second primary before producing any event", () => {
    let state = emptySessionState();
    const primary = decide(state, openCommand({ role: "primary" }));
    if (!primary.ok) throw new Error(primary.code);
    state = primary.events.reduce(evolve, state);
    expect(
      decide(
        state,
        openCommand({
          artifactId: "artifact_other",
          sourcePath: "/repo/other.html",
          revisionId: "rev_other",
          entryHash: "hash_other",
          files: [{ path: "other.html", hash: "hash_other", mediaType: "text/html" }],
          role: "primary",
        }),
      ),
    ).toMatchObject({ ok: false, code: "session.primary-conflict" });
  });
});
