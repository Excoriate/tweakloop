import { describe, expect, it } from "vitest";
import { decide } from "../../src/domain/decide.js";
import type { DomainEvent } from "../../src/domain/events.js";
import { replay } from "../../src/domain/evolve.js";

const baseEvents: DomainEvent[] = [
  {
    type: "session.started",
    sessionId: "session_1",
    artifactId: null,
    originatingAgentId: "codex",
    agentId: "codex",
    processNonce: "process_1",
    baseRevisionId: null,
    title: "M1",
    goal: "deliver",
    predecessorSessionId: null,
    handoffSummary: null,
  },
  {
    type: "chat.message",
    messageId: "message_1",
    artifactId: null,
    author: "human:alex",
    text: "hello",
    context: null,
    mentions: [],
    references: [],
    attachments: [],
    sessionId: "session_1",
    recipientAgentId: "codex",
    threadId: null,
    workId: null,
    intentId: null,
  },
];

describe("chat delivery domain", () => {
  it("requires the exact active session owner and advances immutable attempt generations", () => {
    const state = replay(baseEvents);
    const offer = {
      type: "chat.delivery-offer" as const,
      messageId: "message_1",
      sessionId: "session_1",
      agentId: "codex",
      processNonce: "process_1",
      attemptId: "attempt_1",
      attemptNumber: 1,
      offeredAt: "2026-08-07T00:00:00.000Z",
    };
    expect(decide(state, { ...offer, processNonce: "copied-process" })).toMatchObject({
      ok: false,
      code: "chat.delivery-session-owner-mismatch",
    });
    const offered = decide(state, offer);
    expect(offered).toMatchObject({
      ok: true,
      events: [{ type: "chat.delivery-offered", attemptId: "attempt_1", attemptNumber: 1 }],
    });
    if (!offered.ok) throw new Error("expected offer");
    const offeredState = replay([...baseEvents, ...offered.events]);
    expect(
      decide(offeredState, { ...offer, attemptId: "attempt_3", attemptNumber: 3 }),
    ).toMatchObject({
      ok: false,
      code: "chat.delivery-attempt-out-of-order",
    });
    expect(
      decide(offeredState, {
        type: "chat.delivery-acknowledge",
        messageId: "message_1",
        sessionId: "session_1",
        agentId: "codex",
        processNonce: "process_1",
        attemptId: "stale",
        acknowledgedAt: "2026-08-07T00:00:01.000Z",
      }),
    ).toMatchObject({ ok: false, code: "chat.delivery-stale-attempt" });
  });

  it("rejects agent-authored and work-correlated chat as independent wake items", () => {
    const agentState = replay([
      baseEvents[0] as DomainEvent,
      {
        ...(baseEvents[1] as Extract<DomainEvent, { type: "chat.message" }>),
        author: "agent:codex",
      },
    ]);
    const command = {
      type: "chat.delivery-offer" as const,
      messageId: "message_1",
      sessionId: "session_1",
      agentId: "codex",
      processNonce: "process_1",
      attemptId: "attempt_1",
      attemptNumber: 1,
      offeredAt: "2026-08-07T00:00:00.000Z",
    };
    expect(decide(agentState, command)).toMatchObject({
      ok: false,
      code: "chat.delivery-agent-authored",
    });
    const correlatedState = replay([
      baseEvents[0] as DomainEvent,
      {
        ...(baseEvents[1] as Extract<DomainEvent, { type: "chat.message" }>),
        workId: "work_1",
      },
    ]);
    expect(decide(correlatedState, command)).toMatchObject({
      ok: false,
      code: "chat.delivery-promoted",
    });
  });
});
