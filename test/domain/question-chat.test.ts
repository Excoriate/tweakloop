import { describe, expect, it } from "vitest";
import type { DomainCommand } from "../../src/domain/commands.js";
import { decide } from "../../src/domain/decide.js";
import type { DomainEvent } from "../../src/domain/events.js";
import { evolve, replay } from "../../src/domain/evolve.js";
import type { DomainState } from "../../src/domain/state.js";
import type { ChatChoiceOption, ChatContent } from "../../src/protocol/chat.js";
import type { ActorRef } from "../../src/protocol/envelopes.js";

const options: readonly ChatChoiceOption[] = [
  { key: "keep", label: "Keep the current approach" },
  { key: "change", label: "Change the approach" },
];

const sessions: DomainEvent[] = [session("session_a", "codex"), session("session_b", "claude")];

describe("typed choice questions as chat content", () => {
  it("records one tagged question fact without mutating work, intent, or decision dimensions", () => {
    const before = replay(sessions);
    const result = decide(before, question("question_1"));

    expect(result).toMatchObject({
      ok: true,
      events: [
        {
          type: "chat.message",
          messageId: "question_1",
          content: { type: "choice-question", options },
        },
      ],
      response: { messageId: "question_1" },
    });
    if (!result.ok) throw new Error("unreachable");
    const after = result.events.reduce(evolve, before);
    expect(after.chat.size).toBe(before.chat.size + 1);
    expect(after.work).toEqual(before.work);
    expect(after.intents).toEqual(before.intents);
  });

  it("rejects option counts outside 2-8 and duplicate keys or labels", () => {
    expect(
      decide(replay(sessions), question("too_few", [{ key: "one", label: "One" }])),
    ).toMatchObject({ ok: false, code: "chat.question-option-count" });
    expect(
      decide(
        replay(sessions),
        question(
          "too_many",
          Array.from({ length: 9 }, (_, index) => ({
            key: `key-${index}`,
            label: `Label ${index}`,
          })),
        ),
      ),
    ).toMatchObject({ ok: false, code: "chat.question-option-count" });
    expect(
      decide(
        replay(sessions),
        question("duplicate_key", [
          { key: "same", label: "First" },
          { key: "same", label: "Second" },
        ]),
      ),
    ).toMatchObject({ ok: false, code: "chat.question-option-key-duplicate" });
    expect(
      decide(
        replay(sessions),
        question("duplicate_label", [
          { key: "first", label: "Same" },
          { key: "second", label: "Same" },
        ]),
      ),
    ).toMatchObject({ ok: false, code: "chat.question-option-label-duplicate" });
  });

  it("requires the exact session agent to ask", () => {
    expect(
      decide(replay(sessions), question("human_question", options, { kind: "human", id: "alex" })),
    ).toMatchObject({ ok: false, code: "chat.question-agent-required" });
    expect(
      decide(replay(sessions), { ...question("spoofed_author"), author: "agent:claude" }),
    ).toMatchObject({ ok: false, code: "chat.actor-author-mismatch" });
    expect(
      decide(replay(sessions), {
        ...question("wrong_owner"),
        actor: { kind: "agent", id: "claude" },
        author: "agent:claude",
      }),
    ).toMatchObject({ ok: false, code: "chat.question-session-owner-mismatch" });
  });

  it("binds an answer to the named question rather than ambient latest chat", () => {
    let state = accept(replay(sessions), question("question_first"));
    state = accept(state, question("question_latest"));

    const exact = decide(state, answer("answer_first", "question_first", "keep"));
    expect(exact).toMatchObject({
      ok: true,
      events: [
        {
          type: "chat.message",
          messageId: "answer_first",
          text: "Keep the current approach",
          content: { questionMessageId: "question_first", optionKey: "keep" },
        },
      ],
    });
    expect(
      decide(state, answer("cross_session", "question_first", "keep", null, "session_b")),
    ).toMatchObject({ ok: false, code: "chat.answer-session-mismatch" });
    expect(
      decide(
        state,
        answer("self_answer", "question_first", "keep", null, "session_a", {
          kind: "agent",
          id: "codex",
        }),
      ),
    ).toMatchObject({ ok: false, code: "chat.answer-human-required" });
    expect(decide(state, answer("unknown_option", "question_first", "other"))).toMatchObject({
      ok: false,
      code: "chat.answer-option-unknown",
    });
  });

  it("supersedes answers immutably and accepts only the exact current answer link", () => {
    let state = accept(replay(sessions), question("question_1"));
    state = accept(state, answer("answer_1", "question_1", "keep"));

    expect(decide(state, answer("answer_without_link", "question_1", "change"))).toMatchObject({
      ok: false,
      code: "chat.answer-supersession-required",
    });
    state = accept(state, answer("answer_2", "question_1", "change", "answer_1"));
    expect(decide(state, answer("answer_stale", "question_1", "keep", "answer_1"))).toMatchObject({
      ok: false,
      code: "chat.answer-supersession-stale",
    });

    expect(state.chat.get("answer_1")?.content).toEqual({
      type: "choice-answer",
      questionMessageId: "question_1",
      optionKey: "keep",
      supersedesAnswerMessageId: null,
    });
    expect(state.chat.get("answer_2")?.content).toEqual({
      type: "choice-answer",
      questionMessageId: "question_1",
      optionKey: "change",
      supersedesAnswerMessageId: "answer_1",
    });
  });

  it("does not put typed answers on the ordinary inbound delivery lifecycle", () => {
    let state = accept(replay(sessions), question("question_1"));
    state = accept(state, answer("answer_1", "question_1", "keep"));
    expect(
      decide(state, {
        type: "chat.delivery-offer",
        messageId: "answer_1",
        sessionId: "session_a",
        agentId: "codex",
        processNonce: "process_codex",
        attemptId: "attempt_answer",
        attemptNumber: 1,
        offeredAt: "2026-08-07T00:00:00.000Z",
      }),
    ).toMatchObject({ ok: false, code: "chat.delivery-non-text" });
  });
});

function session(sessionId: string, agentId: string): DomainEvent {
  return {
    type: "session.started",
    sessionId,
    artifactId: null,
    originatingAgentId: agentId,
    agentId,
    processNonce: `process_${agentId}`,
    baseRevisionId: null,
    title: sessionId,
    goal: "answer exactly",
    predecessorSessionId: null,
    handoffSummary: null,
  };
}

function question(
  messageId: string,
  choices: readonly ChatChoiceOption[] = options,
  actor: ActorRef = { kind: "agent", id: "codex" },
): Extract<DomainCommand, { type: "chat.send" }> {
  return chat(messageId, "session_a", actor, {
    type: "choice-question",
    prompt: "Which route?",
    options: choices,
  });
}

function answer(
  messageId: string,
  questionMessageId: string,
  optionKey: string,
  supersedesAnswerMessageId: string | null = null,
  sessionId = "session_a",
  actor: ActorRef = { kind: "human", id: "alex" },
): Extract<DomainCommand, { type: "chat.send" }> {
  return chat(messageId, sessionId, actor, {
    type: "choice-answer",
    questionMessageId,
    optionKey,
    supersedesAnswerMessageId,
  });
}

function chat(
  messageId: string,
  sessionId: string,
  actor: ActorRef,
  content: ChatContent,
): Extract<DomainCommand, { type: "chat.send" }> {
  return {
    type: "chat.send",
    messageId,
    artifactId: null,
    author: `${actor.kind}:${actor.id}`,
    text: "",
    content,
    actor,
    context: null,
    mentions: [],
    sessionId,
    recipientAgentId: null,
  };
}

function accept(state: DomainState, command: DomainCommand): DomainState {
  const result = decide(state, command);
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.events.reduce(evolve, state);
}
