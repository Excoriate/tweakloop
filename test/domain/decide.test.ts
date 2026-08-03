import { describe, expect, it } from "vitest";
import { decide } from "../../src/domain/decide.js";
import type { DomainEvent } from "../../src/domain/events.js";
import { evolve, replay } from "../../src/domain/evolve.js";
import { initialState } from "../../src/domain/state.js";

const openCommand = {
  type: "workspace.open",
  workspaceId: "ws_test",
  projectId: "proj-1",
  rootPath: "/repo",
} as const;

const registerCommand = {
  type: "artifact.register",
  artifactId: "artifact_1",
  name: "plan.html",
  format: "html",
  sourcePath: "/repo/plan.html",
} as const;

describe("decide", () => {
  it("opens a workspace exactly once", () => {
    const first = decide(initialState, openCommand);
    expect(first).toMatchObject({ ok: true, events: [{ type: "workspace.opened" }] });
    if (!first.ok) throw new Error("unreachable");

    const opened = replay(first.events);
    const second = decide(opened, openCommand);
    expect(second).toMatchObject({ ok: true, events: [], response: { alreadyOpen: true } });
  });

  it("registers an artifact", () => {
    const decision = decide(initialState, registerCommand);
    expect(decision).toMatchObject({
      ok: true,
      events: [{ type: "artifact.registered", artifactId: "artifact_1" }],
      response: { artifactId: "artifact_1" },
    });
  });

  it("rejects a duplicate artifact id", () => {
    const first = decide(initialState, registerCommand);
    if (!first.ok) throw new Error("unreachable");
    const state = replay(first.events);
    const second = decide(state, registerCommand);
    expect(second).toMatchObject({ ok: false, code: "artifact.already-registered" });
  });

  it("rejects a duplicate source path and names the existing artifact", () => {
    const first = decide(initialState, registerCommand);
    if (!first.ok) throw new Error("unreachable");
    const state = replay(first.events);
    const second = decide(state, { ...registerCommand, artifactId: "artifact_2" });
    expect(second).toMatchObject({
      ok: false,
      code: "artifact.source-already-registered",
      details: { artifactId: "artifact_1" },
    });
  });
});

describe("evolve", () => {
  it("is a deterministic fold", () => {
    const events: DomainEvent[] = [
      { type: "workspace.opened", workspaceId: "ws_test", projectId: "proj-1", rootPath: "/repo" },
      {
        type: "artifact.registered",
        artifactId: "artifact_1",
        name: "plan.html",
        format: "html",
        sourcePath: "/repo/plan.html",
      },
    ];
    const folded = events.reduce(evolve, initialState);
    expect(folded).toEqual(replay(events));
    expect(folded.workspaceOpened).toBe(true);
    expect(folded.artifacts.get("artifact_1")?.name).toBe("plan.html");
  });
});
