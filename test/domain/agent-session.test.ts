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

function reviewed(): DomainState {
  let state = apply(initialState, {
    type: "artifact.register",
    artifactId: "artifact_1",
    name: "plan.html",
    format: "html",
    sourcePath: "/repo/plan.html",
  });
  state = apply(state, {
    type: "artifact.publish",
    artifactId: "artifact_1",
    revisionId: "revision_1",
    format: "html",
    entryPath: "plan.html",
    entryHash: "hash_1",
    files: [{ path: "plan.html", hash: "hash_1", mediaType: "text/html" }],
    producer: { kind: "agent", id: "codex" },
    sourcePath: "/repo/plan.html",
  });
  return apply(state, {
    type: "review.submit-batch",
    batchId: "batch_1",
    workId: "work_1",
    artifactId: "artifact_1",
    revisionId: "revision_1",
    assigneeAgentId: "codex",
    sessionId: "session_1",
    intents: [
      {
        intentId: "intent_1",
        intentType: "comment",
        target: { semanticId: "plan.one" },
        body: { text: "first" },
      },
      {
        intentId: "intent_2",
        intentType: "comment",
        target: { semanticId: "plan.two" },
        body: { text: "second" },
      },
    ],
  });
}

describe("agent assignment and recoverable work", () => {
  it("does not let another agent consume explicitly assigned work", () => {
    const state = reviewed();
    expect(decide(state, { type: "work.claim", claimId: "wrong", agentId: "other" })).toMatchObject(
      { ok: true, response: { status: "none" } },
    );
    expect(decide(state, { type: "work.claim", claimId: "right", agentId: "codex" })).toMatchObject(
      {
        ok: true,
        response: {
          status: "claimed",
          assigneeAgentId: "codex",
          sessionId: "session_1",
        },
      },
    );
  });

  it("records partial progress without falsely addressing the whole work item", () => {
    let state = apply(reviewed(), {
      type: "work.claim",
      claimId: "claim_1",
      agentId: "codex",
    });
    const partial = decide(state, {
      type: "work.complete",
      workId: "work_1",
      claimId: "claim_1",
      agentId: "codex",
      summary: "first change applied",
      revisionId: null,
      addressedIntentIds: ["intent_1"],
    });
    expect(partial).toMatchObject({
      ok: true,
      events: [{ type: "work.progressed" }, { type: "work.claim-released" }],
      response: { status: "progressed", remainingIntentIds: ["intent_2"] },
    });
    if (!partial.ok) throw new Error("unreachable");
    state = partial.events.reduce(evolve, state);
    expect(state.work.get("work_1")).toMatchObject({ addressed: false, claim: null });
    expect(state.intents.get("intent_1")?.addressedByWorkId).toBe("work_1");
    expect(state.intents.get("intent_2")?.addressedByWorkId).toBeNull();

    state = apply(state, {
      type: "work.claim",
      claimId: "claim_2",
      agentId: "codex",
      workId: "work_1",
    });
    state = apply(state, {
      type: "work.complete",
      workId: "work_1",
      claimId: "claim_2",
      agentId: "codex",
      summary: "second change applied",
      revisionId: null,
      addressedIntentIds: ["intent_2"],
    });
    expect(state.work.get("work_1")?.addressed).toBe(true);
  });

  it("requires an explicit human decision after addressed and supports reopening", () => {
    let state = apply(reviewed(), {
      type: "work.claim",
      claimId: "claim_1",
      agentId: "codex",
    });
    state = apply(state, {
      type: "work.complete",
      workId: "work_1",
      claimId: "claim_1",
      agentId: "codex",
      summary: "done",
      revisionId: null,
      addressedIntentIds: null,
    });
    expect(state.work.get("work_1")).toMatchObject({
      addressed: true,
      decisionStatus: "pending",
    });
    state = apply(state, {
      type: "decision.accept",
      decisionId: "decision_1",
      workId: "work_1",
      reason: null,
      actor: { kind: "human", id: "alex" },
    });
    expect(state.work.get("work_1")?.decisionStatus).toBe("accepted");
    state = apply(state, {
      type: "decision.reopen",
      decisionId: "decision_2",
      workId: "work_1",
      reason: "still needs an edge case",
      actor: { kind: "human", id: "alex" },
    });
    expect(state.work.get("work_1")).toMatchObject({
      addressed: false,
      decisionStatus: "reopened",
      claim: null,
    });
    expect(state.intents.get("intent_1")?.addressedByWorkId).toBeNull();
    expect(state.intents.get("intent_2")?.addressedByWorkId).toBeNull();

    expect(
      decide(state, {
        type: "decision.accept",
        decisionId: "decision_agent",
        workId: "work_1",
        reason: null,
        actor: { kind: "agent", id: "codex" },
      }),
    ).toMatchObject({ ok: false, code: "decision.human-required" });
  });

  it("replaces only the explicitly identified stale claim", () => {
    const state = apply(reviewed(), {
      type: "work.claim",
      claimId: "claim_old",
      agentId: "codex",
    });
    expect(
      decide(state, {
        type: "work.reclaim",
        workId: "work_1",
        staleClaimId: "not_the_claim",
        claimId: "claim_new",
        agentId: "codex",
      }),
    ).toMatchObject({ ok: false, code: "work.stale-claim" });
    expect(
      decide(state, {
        type: "work.reclaim",
        workId: "work_1",
        staleClaimId: "claim_old",
        claimId: "claim_new",
        agentId: "codex",
      }),
    ).toMatchObject({
      ok: true,
      events: [{ type: "work.abandoned" }, { type: "work.claimed", claimId: "claim_new" }],
    });
  });
});
