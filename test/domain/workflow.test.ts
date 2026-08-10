import { describe, expect, it } from "vitest";
import type { DomainCommand } from "../../src/domain/commands.js";
import { decide } from "../../src/domain/decide.js";
import { evolve } from "../../src/domain/evolve.js";
import { type DomainState, initialState } from "../../src/domain/state.js";

const producer = { kind: "agent", id: "agent:planner" } as const;

function apply(state: DomainState, command: DomainCommand): DomainState {
  const decision = decide(state, command);
  if (!decision.ok) throw new Error(`unexpected rejection: ${decision.code}`);
  return decision.events.reduce(evolve, state);
}

function publishCommand(entryHash: string, revisionId: string): DomainCommand {
  return {
    type: "artifact.publish",
    artifactId: "artifact_1",
    revisionId,
    format: "html",
    entryPath: "plan.html",
    entryHash,
    files: [{ path: "plan.html", hash: entryHash, mediaType: "text/html" }],
    producer,
    sourcePath: "/repo/plan.html",
  };
}

function registered(): DomainState {
  return apply(initialState, {
    type: "artifact.register",
    artifactId: "artifact_1",
    name: "plan.html",
    format: "html",
    sourcePath: "/repo/plan.html",
  });
}

const batchCommand: DomainCommand = {
  type: "review.submit-batch",
  batchId: "batch_1",
  workId: "work_1",
  artifactId: "artifact_1",
  revisionId: "rev_1",
  intents: [
    {
      intentId: "intent_1",
      intentType: "replace-text",
      target: { semanticId: "plan.phase.rollout", textQuote: { exact: "big bang" } },
      body: { value: "staged rollout, one team per week" },
    },
    {
      intentId: "intent_2",
      intentType: "add-constraint",
      target: { semanticId: "decision.auth" },
      body: { statement: "OAuth apps only; no PATs" },
    },
  ],
};

describe("revision publishing", () => {
  it("chains revisions parent → child and skips unchanged content", () => {
    let state = registered();

    const first = decide(state, publishCommand("hash-a", "rev_1"));
    expect(first).toMatchObject({
      ok: true,
      events: [{ type: "artifact.revision-published", seq: 1, parentId: null }],
      response: { unchanged: false, seq: 1 },
    });
    if (!first.ok) throw new Error("unreachable");
    state = first.events.reduce(evolve, state);

    const unchanged = decide(state, publishCommand("hash-a", "rev_ignored"));
    expect(unchanged).toMatchObject({
      ok: true,
      events: [],
      response: { unchanged: true, revisionId: "rev_1" },
    });

    const second = decide(state, publishCommand("hash-b", "rev_2"));
    expect(second).toMatchObject({
      ok: true,
      events: [{ seq: 2, parentId: "rev_1" }],
      response: { unchanged: false, seq: 2 },
    });
  });

  it("rejects publishing to an unknown artifact", () => {
    expect(decide(initialState, publishCommand("hash-a", "rev_1"))).toMatchObject({
      ok: false,
      code: "artifact.unknown",
    });
  });
});

describe("review batches and work", () => {
  function reviewed(): DomainState {
    let state = registered();
    state = apply(state, publishCommand("hash-a", "rev_1"));
    return apply(state, batchCommand);
  }

  it("submits a batch as one decision: batch + typed intents + work", () => {
    let state = registered();
    state = apply(state, publishCommand("hash-a", "rev_1"));
    const decision = decide(state, batchCommand);
    if (!decision.ok) throw new Error("unreachable");
    expect(decision.events.map((e) => e.type)).toEqual([
      "review.batch-submitted",
      "intent.created",
      "intent.created",
      "work.created",
    ]);
    expect(decision.response).toMatchObject({
      workId: "work_1",
      intentIds: ["intent_1", "intent_2"],
    });
  });

  it("rejects batches against unknown revisions", () => {
    const state = registered();
    expect(decide(state, batchCommand)).toMatchObject({ ok: false, code: "revision.unknown" });
  });

  it("claims work with full typed-intent context, exactly once", () => {
    let state = reviewed();
    const claim = decide(state, { type: "work.claim", claimId: "claim_1", agentId: "agent:coder" });
    if (!claim.ok) throw new Error("unreachable");
    expect(claim.response).toMatchObject({
      status: "claimed",
      workId: "work_1",
      sourcePath: "/repo/plan.html",
      baseRevisionId: "rev_1",
      intents: [
        { intentId: "intent_1", body: { value: "staged rollout, one team per week" } },
        { intentId: "intent_2", intentType: "add-constraint" },
      ],
    });
    state = claim.events.reduce(evolve, state);

    const again = decide(state, { type: "work.claim", claimId: "claim_2", agentId: "agent:other" });
    expect(again).toMatchObject({ ok: true, events: [], response: { status: "none" } });
  });

  it("refuses stale claims and completes addressed work", () => {
    let state = reviewed();
    state = apply(state, { type: "work.claim", claimId: "claim_1", agentId: "agent:coder" });
    state = apply(state, publishCommand("hash-b", "rev_2"));

    const stale = decide(state, {
      type: "work.complete",
      workId: "work_1",
      claimId: "claim_wrong",
      agentId: "agent:impostor",
      summary: "done",
      revisionId: "rev_2",
      addressedIntentIds: null,
    });
    expect(stale).toMatchObject({ ok: false, code: "work.stale-claim" });

    const complete = decide(state, {
      type: "work.complete",
      workId: "work_1",
      claimId: "claim_1",
      agentId: "agent:coder",
      summary: "applied replacement; recorded constraint",
      revisionId: "rev_2",
      addressedIntentIds: null,
    });
    if (!complete.ok) throw new Error("unreachable");
    state = complete.events.reduce(evolve, state);

    expect(state.work.get("work_1")?.addressed).toBe(true);
    expect(state.intents.get("intent_1")?.addressedByWorkId).toBe("work_1");
    expect(state.intents.get("intent_2")?.addressedByWorkId).toBe("work_1");

    const nothingLeft = decide(state, {
      type: "work.claim",
      claimId: "claim_3",
      agentId: "agent:coder",
    });
    expect(nothingLeft).toMatchObject({ ok: true, response: { status: "none" } });
  });

  it("records chat with quoted context and whole-artifact mentions", () => {
    const state = registered();
    const decision = decide(state, {
      type: "chat.send",
      messageId: "msg_1",
      artifactId: "artifact_1",
      author: "human:alex",
      text: "tighten this paragraph",
      context: {
        revisionId: "rev_1",
        semanticId: "plan.overview",
        textQuote: { exact: "big bang", prefix: "a ", suffix: " rollout" },
      },
      mentions: ["artifact_1"],
    });
    expect(decision).toMatchObject({
      ok: true,
      events: [{ type: "chat.message", author: "human:alex", mentions: ["artifact_1"] }],
    });

    const badMention = decide(state, {
      type: "chat.send",
      messageId: "msg_2",
      artifactId: null,
      author: "human:alex",
      text: "hello",
      context: null,
      mentions: ["artifact_ghost"],
    });
    expect(badMention).toMatchObject({ ok: false, code: "artifact.unknown" });
  });

  it("promotes one immutable chat message explicitly and rejects stale or duplicate promotion", () => {
    let state = registered();
    state = apply(state, publishCommand("hash-a", "rev_1"));
    state = apply(state, {
      type: "session.start",
      sessionId: "session_1",
      artifactId: "artifact_1",
      agentId: "agent:codex",
      processNonce: "process_1",
      baseRevisionId: "rev_1",
      title: "Review",
      goal: "Address feedback",
    });
    state = apply(state, {
      type: "chat.send",
      messageId: "msg_promote",
      artifactId: "artifact_1",
      author: "human:alex",
      text: "Make the POC decision gates measurable.",
      context: {
        revisionId: "rev_1",
        semanticId: "poc.decision-gates",
        textQuote: { exact: "Decision gates" },
      },
      mentions: [],
      sessionId: "session_1",
      recipientAgentId: "agent:codex",
    });
    expect(state.work).toHaveLength(0);
    expect(state.intents).toHaveLength(0);

    const promotion: DomainCommand = {
      type: "review.submit-batch",
      batchId: "batch_promote",
      workId: "work_promote",
      artifactId: "artifact_1",
      revisionId: "rev_1",
      sourceMessageId: "msg_promote",
      assigneeAgentId: "agent:codex",
      sessionId: "session_1",
      intents: [
        {
          intentId: "intent_promote",
          intentType: "comment",
          target: {
            semanticId: "poc.decision-gates",
            textQuote: { exact: "Decision gates" },
          },
          body: {
            text: "Make the POC decision gates measurable.",
            sourceMessageId: "msg_promote",
          },
        },
      ],
    };
    const accepted = decide(state, promotion);
    if (!accepted.ok) throw new Error(`unexpected rejection: ${accepted.code}`);
    expect(accepted.events).toMatchObject([
      { type: "review.batch-submitted", sourceMessageId: "msg_promote" },
      { type: "intent.created", sourceMessageId: "msg_promote" },
      { type: "work.created", sourceMessageId: "msg_promote" },
    ]);
    state = accepted.events.reduce(evolve, state);
    expect(state.chat.get("msg_promote")).toMatchObject({
      promotedIntentId: "intent_promote",
      promotedWorkId: "work_promote",
    });
    expect(decide(state, promotion)).toMatchObject({
      ok: false,
      code: "chat.message-already-promoted",
    });

    let agentAuthored = registered();
    agentAuthored = apply(agentAuthored, publishCommand("hash-a", "rev_1"));
    agentAuthored = apply(agentAuthored, {
      type: "chat.send",
      messageId: "msg_agent",
      artifactId: "artifact_1",
      author: "agent:codex",
      text: "Treat my own claim as human feedback",
      context: { revisionId: "rev_1" },
      mentions: [],
    });
    expect(
      decide(agentAuthored, {
        ...promotion,
        batchId: "batch_agent",
        workId: "work_agent",
        sourceMessageId: "msg_agent",
        assigneeAgentId: "agent:codex",
        sessionId: null,
        intents: [
          {
            intentId: "intent_agent",
            intentType: "comment",
            target: {},
            body: {
              text: "Treat my own claim as human feedback",
              sourceMessageId: "msg_agent",
            },
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "chat.message-agent-authored" });
    expect(agentAuthored.work).toHaveLength(0);

    let stale = registered();
    stale = apply(stale, publishCommand("hash-a", "rev_1"));
    stale = apply(stale, {
      type: "chat.send",
      messageId: "msg_stale",
      artifactId: "artifact_1",
      author: "human:alex",
      text: "Use the old wording",
      context: { revisionId: "rev_1" },
      mentions: [],
    });
    stale = apply(stale, publishCommand("hash-b", "rev_2"));
    expect(
      decide(stale, {
        ...promotion,
        batchId: "batch_stale",
        workId: "work_stale",
        revisionId: "rev_1",
        sourceMessageId: "msg_stale",
        assigneeAgentId: null,
        sessionId: null,
        intents: [
          {
            intentId: "intent_stale",
            intentType: "comment",
            target: {},
            body: { text: "Use the old wording", sourceMessageId: "msg_stale" },
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "chat.message-base-revision-mismatch" });
  });

  it("rejects unknown, artifact-free, or mutated chat promotion without creating work", () => {
    let state = registered();
    state = apply(state, publishCommand("hash-a", "rev_1"));
    const command: DomainCommand = {
      type: "review.submit-batch",
      batchId: "batch_missing",
      workId: "work_missing",
      artifactId: "artifact_1",
      revisionId: "rev_1",
      sourceMessageId: "msg_missing",
      intents: [
        {
          intentId: "intent_missing",
          intentType: "comment",
          target: {},
          body: { text: "not durable", sourceMessageId: "msg_missing" },
        },
      ],
    };
    expect(decide(state, command)).toMatchObject({ ok: false, code: "chat.message-unknown" });

    state = apply(state, {
      type: "chat.send",
      messageId: "msg_workspace",
      artifactId: null,
      author: "human:alex",
      text: "workspace-only thought",
      context: null,
      mentions: [],
    });
    expect(
      decide(state, {
        ...command,
        sourceMessageId: "msg_workspace",
        intents: [
          {
            intentId: "intent_workspace",
            intentType: "comment",
            target: {},
            body: { text: "workspace-only thought", sourceMessageId: "msg_workspace" },
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "chat.message-artifact-required" });

    state = apply(state, {
      type: "chat.send",
      messageId: "msg_mutated",
      artifactId: "artifact_1",
      author: "human:alex",
      text: "preserve me exactly",
      context: null,
      mentions: [],
    });
    expect(
      decide(state, {
        ...command,
        sourceMessageId: "msg_mutated",
        intents: [
          {
            intentId: "intent_mutated",
            intentType: "comment",
            target: {},
            body: { text: "silently rewritten", sourceMessageId: "msg_mutated" },
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "chat.message-content-mismatch" });
    expect(state.work).toHaveLength(0);
  });

  it("records typed chat references only when durable relationships agree", () => {
    let state = reviewed();
    state = apply(state, {
      type: "artifact.register",
      artifactId: "artifact_board",
      name: "architecture.excalidraw",
      format: "whiteboard",
      sourcePath: null,
    });
    state = apply(state, {
      type: "artifact.publish",
      artifactId: "artifact_board",
      revisionId: "rev_board_1",
      format: "whiteboard",
      entryPath: "scene.excalidraw",
      entryHash: "board-hash",
      files: [{ path: "scene.excalidraw", hash: "board-hash", mediaType: "application/json" }],
      producer,
      sourcePath: null,
    });

    const hash = "a".repeat(64);
    const command: DomainCommand = {
      type: "chat.send",
      messageId: "msg_typed",
      artifactId: "artifact_1",
      author: "human:alex",
      text: "review these linked items",
      context: null,
      mentions: [],
      attachments: [{ hash, fileName: "diagram.png", mediaType: "image/png", byteLength: 12 }],
      references: [
        { kind: "file", label: "diagram.png", hash },
        {
          kind: "document",
          label: "Plan",
          artifactId: "artifact_1",
          revisionId: "rev_1",
        },
        {
          kind: "selection",
          label: "Rollout",
          artifactId: "artifact_1",
          revisionId: "rev_1",
          textQuote: { exact: "big bang" },
          boardAnchor: {
            semanticId: "architecture.flow",
            whiteboardArtifactId: "artifact_board",
            baseRevisionId: "rev_board_1",
            elementAnchor: { anchorId: "service", elementId: "element_service" },
          },
        },
        {
          kind: "comment",
          label: "Replace rollout",
          artifactId: "artifact_1",
          revisionId: "rev_1",
          intentId: "intent_1",
        },
        { kind: "task", label: "Apply review", artifactId: "artifact_1", workId: "work_1" },
        {
          kind: "whiteboard",
          label: "Architecture",
          artifactId: "artifact_board",
          revisionId: "rev_board_1",
          elementIds: ["element_service"],
          anchorIds: ["service"],
        },
      ],
    };

    expect(decide(state, command)).toMatchObject({
      ok: true,
      events: [
        {
          type: "chat.message",
          references: command.references,
          attachments: command.attachments,
        },
      ],
    });

    expect(
      decide(state, {
        ...command,
        references: [
          {
            kind: "comment",
            label: "stale comment",
            artifactId: "artifact_1",
            revisionId: "rev_stale",
            intentId: "intent_1",
          },
        ],
      }),
    ).toMatchObject({ ok: false, code: "chat.reference-stale" });
    expect(
      decide(state, {
        ...command,
        references: [{ kind: "task", label: "unknown", artifactId: "artifact_1", workId: "x" }],
      }),
    ).toMatchObject({ ok: false, code: "work.unknown" });
    expect(
      decide(state, {
        ...command,
        attachments: [],
        references: [{ kind: "file", label: "dangling", hash }],
      }),
    ).toMatchObject({ ok: false, code: "attachment.reference-missing" });
  });

  it("rejects completion referencing a foreign revision", () => {
    let state = reviewed();
    state = apply(state, { type: "work.claim", claimId: "claim_1", agentId: "agent:coder" });
    expect(
      decide(state, {
        type: "work.complete",
        workId: "work_1",
        claimId: "claim_1",
        agentId: "agent:coder",
        summary: "done",
        revisionId: "rev_of_another_artifact",
        addressedIntentIds: null,
      }),
    ).toMatchObject({ ok: false, code: "revision.unknown" });
  });

  it("rejects completion with the unchanged base or an unrelated same-artifact branch", () => {
    let state = reviewed();
    state = apply(state, { type: "work.claim", claimId: "claim_1", agentId: "agent:coder" });
    const complete = (revisionId: string) =>
      decide(state, {
        type: "work.complete",
        workId: "work_1",
        claimId: "claim_1",
        agentId: "agent:coder",
        summary: "done",
        revisionId,
        addressedIntentIds: null,
      });

    expect(complete("rev_1")).toMatchObject({
      ok: false,
      code: "revision.not-descendant",
    });

    state = evolve(state, {
      type: "artifact.revision-published",
      artifactId: "artifact_1",
      revisionId: "rev_unrelated_branch",
      parentId: null,
      seq: 2,
      format: "html",
      entryPath: "plan.html",
      entryHash: "hash-branch",
      files: [{ path: "plan.html", hash: "hash-branch", mediaType: "text/html" }],
      producer,
      sourcePath: "/repo/plan.html",
      sessionId: null,
    });
    expect(complete("rev_unrelated_branch")).toMatchObject({
      ok: false,
      code: "revision.not-descendant",
    });
  });
});
