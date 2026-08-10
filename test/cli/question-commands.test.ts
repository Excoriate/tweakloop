import { describe, expect, it, vi } from "vitest";
import {
  parseQuestionOptions,
  questionAskOutput,
  waitForQuestion,
} from "../../src/cli/question-commands.js";
import type { SnapshotChatMessage } from "../../src/protocol/snapshot.js";

describe("question CLI one-result behavior", () => {
  it("returns only the compact message identity from ask", () => {
    expect(questionAskOutput("question_1")).toEqual({
      protocol: "tweakloop.cli/v1",
      messageId: "question_1",
    });
    expect(Object.keys(questionAskOutput("question_1"))).toEqual(["protocol", "messageId"]);
  });

  it("parses 2-8 unique key=label options and rejects duplicates or malformed values", () => {
    expect(parseQuestionOptions(["keep=Keep it", "change=Change it"])).toEqual([
      { key: "keep", label: "Keep it" },
      { key: "change", label: "Change it" },
    ]);
    expect(() => parseQuestionOptions(["one=One"])).toThrow(/between 2 and 8/);
    expect(() => parseQuestionOptions(["same=First", "same=Second"])).toThrow(/keys.*unique/);
    expect(() => parseQuestionOptions(["first=Same", "second=Same"])).toThrow(/labels.*unique/);
    expect(() => parseQuestionOptions(["missing-separator", "second=Second"])).toThrow(/key=label/);
  });

  it("returns one already-current answer after one exact probe", async () => {
    const probe = vi.fn(async () => question("answered"));
    await expect(waitForQuestion(probe, 20)).resolves.toEqual({
      status: "answered",
      answerMessageId: "answer_1",
      optionKey: "keep",
      optionLabel: "Keep it",
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("performs a final deadline probe and accepts a boundary answer", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(question("pending"))
      .mockResolvedValueOnce(question("answered"));
    await expect(waitForQuestion(probe, 0)).resolves.toMatchObject({
      answerMessageId: "answer_1",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("gives the final boundary probe enough transport time for an answer already durable", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(question("pending"))
      .mockImplementationOnce(
        () =>
          new Promise<SnapshotChatMessage>((resolve) =>
            setTimeout(() => resolve(question("answered")), 20),
          ),
      );

    await expect(waitForQuestion(probe, 0)).resolves.toMatchObject({
      answerMessageId: "answer_1",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("returns timeout only after the final exact probe is still pending", async () => {
    const probe = vi.fn(async () => question("pending"));
    await expect(waitForQuestion(probe, 0)).resolves.toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("bounds and aborts every never-resolving probe", async () => {
    const signals: AbortSignal[] = [];
    const probe = vi.fn(
      (signal: AbortSignal) =>
        new Promise<SnapshotChatMessage>(() => {
          signals.push(signal);
        }),
    );
    const started = Date.now();

    await expect(waitForQuestion(probe, 5)).resolves.toBeNull();

    expect(Date.now() - started).toBeLessThan(250);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

function question(state: "pending" | "answered"): SnapshotChatMessage {
  return {
    messageId: "question_1",
    artifactId: null,
    author: "agent:codex",
    text: "Which?",
    content: {
      type: "choice-question",
      prompt: "Which?",
      options: [
        { key: "keep", label: "Keep it" },
        { key: "change", label: "Change it" },
      ],
    },
    context: null,
    mentions: [],
    references: [],
    attachments: [],
    sessionId: "session_a",
    recipientAgentId: null,
    threadId: "session_a",
    workId: null,
    intentId: null,
    delivery: null,
    questionState:
      state === "pending"
        ? { status: "pending" }
        : {
            status: "answered",
            answerMessageId: "answer_1",
            optionKey: "keep",
            optionLabel: "Keep it",
          },
    answerState: null,
    recordedAt: "2026-08-07T00:00:00.000Z",
    createdSeq: 1,
  };
}
