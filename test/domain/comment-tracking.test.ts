import { describe, expect, it } from "vitest";
import { decide } from "../../src/domain/decide.js";
import type { DomainEvent } from "../../src/domain/events.js";
import { evolve } from "../../src/domain/evolve.js";
import { initialState } from "../../src/domain/state.js";
import { validateCommand } from "../../src/protocol/validation.js";

const actor = { kind: "human", id: "browser" } as const;

function stateWithRevision() {
  return [
    {
      type: "workspace.opened",
      workspaceId: "ws",
      projectId: "project",
      rootPath: "/repo",
    },
    {
      type: "artifact.registered",
      artifactId: "artifact",
      name: "plan.html",
      format: "html",
      sourcePath: "/repo/plan.html",
    },
    {
      type: "artifact.revision-published",
      artifactId: "artifact",
      revisionId: "rev_1",
      parentId: null,
      seq: 1,
      format: "html",
      entryPath: "plan.html",
      entryHash: "hash_1",
      files: [{ path: "plan.html", hash: "hash_1", mediaType: "text/html" }],
      producer: actor,
      sourcePath: "/repo/plan.html",
      sessionId: null,
    },
  ].reduce((state, event) => evolve(state, event as DomainEvent), initialState);
}

const comment = {
  intentId: "intent_comment",
  intentType: "comment" as const,
  target: { semanticId: "architecture.storage" },
  body: { text: "Please make this explicit" },
};

describe("comment-only review and explicit tracking", () => {
  it("submits immutable comments without creating work", () => {
    const state = stateWithRevision();
    const result = decide(state, {
      type: "review.submit-comments",
      batchId: "batch_comment",
      artifactId: "artifact",
      revisionId: "rev_1",
      intents: [comment],
      sessionId: "session_1",
    });
    expect(result).toMatchObject({ ok: true, response: { tracked: false } });
    if (!result.ok) throw new Error(result.code);
    expect(result.events.map((event) => event.type)).toEqual([
      "review.batch-submitted",
      "intent.created",
    ]);
    expect(result.events).not.toContainEqual(expect.objectContaining({ type: "work.created" }));
  });

  it("tracks existing intents once and only reopens addressed accepted work", () => {
    let state = stateWithRevision();
    const submitted = decide(state, {
      type: "review.submit-comments",
      batchId: "batch_comment",
      artifactId: "artifact",
      revisionId: "rev_1",
      intents: [comment],
    });
    if (!submitted.ok) throw new Error(submitted.code);
    state = submitted.events.reduce(evolve, state);
    const track = (workId: string, decisionId: string) =>
      decide(state, {
        type: "work.create-from-intents",
        workId,
        intentIds: [comment.intentId],
        decisionId,
        reason: "track this comment",
      });

    const created = track("work_comment", "decision_unused");
    if (!created.ok) throw new Error(created.code);
    expect(created.events).toEqual([
      expect.objectContaining({ type: "work.created", intentIds: [comment.intentId] }),
    ]);
    state = created.events.reduce(evolve, state);
    expect(track("work_competing", "decision_open")).toMatchObject({
      ok: true,
      events: [],
      response: { workId: "work_comment", created: false, reopened: false },
    });

    state = evolve(state, {
      type: "work.claimed",
      workId: "work_comment",
      claimId: "claim_comment",
      agentId: "codex",
    });
    expect(track("work_competing", "decision_claimed")).toMatchObject({ ok: true, events: [] });
    state = evolve(state, {
      type: "work.addressed",
      workId: "work_comment",
      claimId: "claim_comment",
      agentId: "codex",
      summary: "addressed",
      revisionId: null,
      addressedIntentIds: [comment.intentId],
    });
    expect(track("work_competing", "decision_pending")).toMatchObject({ ok: true, events: [] });
    state = evolve(state, {
      type: "decision.accepted",
      decisionId: "accepted_once",
      workId: "work_comment",
      reason: null,
    });
    const reopened = track("work_competing", "decision_reopen_once");
    if (!reopened.ok) throw new Error(reopened.code);
    expect(reopened.events).toEqual([
      {
        type: "decision.reopened",
        decisionId: "decision_reopen_once",
        workId: "work_comment",
        reason: "track this comment",
      },
    ]);
    state = reopened.events.reduce(evolve, state);
    expect(track("work_third", "decision_reopen_race_loser")).toMatchObject({
      ok: true,
      events: [],
      response: { workId: "work_comment", reopened: false },
    });
  });

  it("validates comment-only and tracking payloads at the protocol boundary", () => {
    const base = {
      protocol: "tweakloop.command/v1",
      commandId: "cmd",
      idempotencyKey: "key",
      workspaceId: "ws",
      actor,
    } as const;
    expect(
      validateCommand({
        ...base,
        type: "review.submit-comments",
        payload: {
          batchId: "batch",
          artifactId: "artifact",
          revisionId: "revision",
          intents: [comment],
        },
      }).ok,
    ).toBe(true);
    expect(
      validateCommand({
        ...base,
        type: "review.submit-comments",
        payload: {
          batchId: "batch",
          artifactId: "artifact",
          revisionId: "revision",
          intents: [{ ...comment, intentType: "question" }],
        },
      }).ok,
    ).toBe(false);
    expect(
      validateCommand({
        ...base,
        type: "work.create-from-intents",
        payload: {
          workId: "work",
          intentIds: ["intent"],
          decisionId: "decision",
          reason: "track",
        },
      }).ok,
    ).toBe(true);
  });
});
