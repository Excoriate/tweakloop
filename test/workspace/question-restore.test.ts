import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { questionSnapshot, rebuildProjections, snapshot } from "../../src/daemon/projections.js";
import { createTransactor } from "../../src/daemon/transactor.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import { WORKSPACE_EXPORT_PROTOCOL } from "../../src/protocol/versions.js";
import {
  planWorkspaceExport,
  type WorkspaceExportManifest,
} from "../../src/protocol/workspace-export.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import {
  createWorkspaceRestoreStore,
  installWorkspaceRestore,
  validateWorkspaceRestoreManifest,
} from "../../src/workspace/restore.js";

const workspace = {
  workspaceId: "ws_source",
  projectId: "project_source",
  rootPath: "/source",
  protocolVersion: 1,
} as const;

describe("typed question workspace reconstruction", () => {
  it("preserves pending/answered/superseded facts through export, restore, and rebuild", () => {
    const sourceEvents = events();
    const sourceDb = openDatabase(":memory:");
    transactor(sourceDb).restoreHistory({ events: sourceEvents, blobs: [] });
    const sourceChat = snapshot(sourceDb, workspace, "http://artifact").chat;

    const exportPlan = planWorkspaceExport({
      expectedWorkspaceId: workspace.workspaceId,
      workspaceRoot: workspace.rootPath,
      snapshot: snapshot(sourceDb, workspace, "http://artifact"),
      listedEvents: sourceEvents,
    });
    const restorePlan = validateWorkspaceRestoreManifest(exportPlan.manifest);
    expect(restorePlan.manifest.events[2]?.payload).toMatchObject({
      content: { type: "choice-question" },
    });
    expect(restorePlan.manifest.events[4]?.payload).toMatchObject({
      content: { type: "choice-answer", supersedesAnswerMessageId: "answer_1" },
    });

    const restoredDb = openDatabase(":memory:");
    transactor(restoredDb).restoreHistory({ events: restorePlan.manifest.events, blobs: [] });
    const restored = snapshot(restoredDb, workspace, "http://artifact").chat;
    expect(restored).toEqual(sourceChat);
    expect(restored.find((message) => message.messageId === "question_1")).toMatchObject({
      questionState: { status: "answered", answerMessageId: "answer_2", optionKey: "change" },
    });
    expect(restored.find((message) => message.messageId === "answer_1")).toMatchObject({
      answerState: { status: "superseded", supersededByMessageId: "answer_2" },
    });

    rebuildProjections(restoredDb, workspace.workspaceId);
    expect(snapshot(restoredDb, workspace, "http://artifact").chat).toEqual(sourceChat);

    const third = transactor(restoredDb).execute({
      protocol: "tweakloop.command/v1",
      commandId: "command_answer_3",
      idempotencyKey: "answer:3",
      workspaceId: workspace.workspaceId,
      actor: { kind: "human", id: "alex" },
      type: "chat.send",
      payload: {
        messageId: "answer_3",
        artifactId: null,
        text: "Keep the current approach",
        content: {
          type: "choice-answer",
          questionMessageId: "question_1",
          optionKey: "keep",
          supersedesAnswerMessageId: "answer_2",
        },
        sessionId: "session_a",
        recipientAgentId: null,
      },
    });
    expect(third).toMatchObject({ status: "accepted" });
    const advanced = snapshot(restoredDb, workspace, "http://artifact").chat;
    expect(advanced.find((message) => message.messageId === "question_1")).toMatchObject({
      questionState: { status: "answered", answerMessageId: "answer_3", optionKey: "keep" },
    });
    expect(advanced.find((message) => message.messageId === "answer_2")).toMatchObject({
      answerState: { status: "superseded", supersededByMessageId: "answer_3" },
    });
    const advancedQuestion = advanced.find((message) => message.messageId === "question_1");
    expect(questionSnapshot(restoredDb, "question_1")).toEqual(advancedQuestion);
    rebuildProjections(restoredDb, workspace.workspaceId);
    expect(snapshot(restoredDb, workspace, "http://artifact").chat).toEqual(advanced);
    expect(questionSnapshot(restoredDb, "question_1")).toEqual(advancedQuestion);
    sourceDb.close();
    restoredDb.close();
  });

  it("rejects two first-answer roots before install creates either destination", () => {
    const valid = validateWorkspaceRestoreManifest(manifest(events()));
    const invalidManifest = manifest(twoRootEvents());
    expectRestoreCode(invalidManifest, "workspace-restore.answer-chain-multiple-roots");

    const parent = mkdtempSync(join(tmpdir(), "tweakloop-invalid-question-restore-"));
    const destinationRoot = join(parent, "destination");
    const destinationObjects = join(parent, "objects");
    try {
      expect(() =>
        installWorkspaceRestore(
          {
            plan: { ...valid, manifest: invalidManifest },
            objectBytes: new Map(),
          },
          destinationRoot,
          destinationObjects,
          "ws_destination",
        ),
      ).toThrow();
      expect(existsSync(destinationRoot)).toBe(false);
      expect(existsSync(destinationObjects)).toBe(false);
    } finally {
      rmSync(parent, { force: true, recursive: true });
    }
  });

  it.each([
    {
      defect: "a branch",
      history: branchEvents(),
      code: "workspace-restore.answer-chain-branch",
    },
    {
      defect: "a cycle",
      history: replacePredecessor(events(), "answer_1", "answer_2"),
      code: "workspace-restore.answer-chain-cycle",
    },
    {
      defect: "a missing predecessor",
      history: replacePredecessor(events(), "answer_2", "answer_missing"),
      code: "workspace-restore.answer-chain-predecessor-missing",
    },
    {
      defect: "a cross-question predecessor",
      history: crossQuestionEvents(),
      code: "workspace-restore.answer-chain-cross-question",
    },
    {
      defect: "an acyclic predecessor that occurs later in event order",
      history: outOfOrderEvents(),
      code: "workspace-restore.answer-chain-order-invalid",
    },
  ])("rejects $defect before restore", ({ history, code }) => {
    expectRestoreCode(manifest(history), code);
  });
});

function expectRestoreCode(manifestValue: WorkspaceExportManifest, code: string): void {
  const root = mkdtempSync(join(tmpdir(), "tweakloop-question-restore-reject-"));
  const store = createWorkspaceRestoreStore(root);
  try {
    expect(readdirSync(root)).toEqual([]);
    store.begin(manifestValue);
  } catch (error) {
    expect(error).toMatchObject({ code });
    expect(readdirSync(root)).toEqual([]);
    rmSync(root, { force: true, recursive: true });
    return;
  }
  rmSync(root, { force: true, recursive: true });
  throw new Error(`expected restore validation to reject with ${code}`);
}

function manifest(history: readonly EventEnvelope[]): WorkspaceExportManifest {
  return {
    protocol: WORKSPACE_EXPORT_PROTOCOL,
    source: {
      workspaceId: workspace.workspaceId,
      projectId: workspace.projectId,
      rootPath: workspace.rootPath,
    },
    capturedSeq: history.length,
    artifacts: [],
    revisions: [],
    attachments: [],
    events: history,
  };
}

function twoRootEvents(): EventEnvelope[] {
  return replacePredecessor(events(), "answer_2", null);
}

function branchEvents(): EventEnvelope[] {
  return [
    ...events(),
    chatEvent(
      6,
      "answer_3",
      { kind: "human", id: "alex" },
      {
        type: "choice-answer",
        questionMessageId: "question_1",
        optionKey: "keep",
        supersedesAnswerMessageId: "answer_1",
      },
    ),
  ];
}

function crossQuestionEvents(): EventEnvelope[] {
  return [
    ...events().slice(0, 4),
    chatEvent(
      5,
      "question_2",
      { kind: "agent", id: "codex" },
      {
        type: "choice-question",
        prompt: "Which second route?",
        options: [
          { key: "left", label: "Take the left route" },
          { key: "right", label: "Take the right route" },
        ],
      },
    ),
    chatEvent(
      6,
      "answer_other",
      { kind: "human", id: "alex" },
      {
        type: "choice-answer",
        questionMessageId: "question_2",
        optionKey: "left",
        supersedesAnswerMessageId: null,
      },
    ),
    chatEvent(
      7,
      "answer_2",
      { kind: "human", id: "alex" },
      {
        type: "choice-answer",
        questionMessageId: "question_1",
        optionKey: "change",
        supersedesAnswerMessageId: "answer_other",
      },
    ),
  ];
}

function outOfOrderEvents(): EventEnvelope[] {
  return [
    ...events().slice(0, 3),
    chatEvent(
      4,
      "answer_2",
      { kind: "human", id: "alex" },
      {
        type: "choice-answer",
        questionMessageId: "question_1",
        optionKey: "change",
        supersedesAnswerMessageId: "answer_1",
      },
    ),
    chatEvent(
      5,
      "answer_1",
      { kind: "human", id: "alex" },
      {
        type: "choice-answer",
        questionMessageId: "question_1",
        optionKey: "keep",
        supersedesAnswerMessageId: null,
      },
    ),
  ];
}

function replacePredecessor(
  history: readonly EventEnvelope[],
  answerMessageId: string,
  predecessorMessageId: string | null,
): EventEnvelope[] {
  return history.map((item) => {
    const payload = item.payload as Record<string, unknown>;
    if (payload.messageId !== answerMessageId) return item;
    return {
      ...item,
      payload: {
        ...payload,
        content: {
          ...(payload.content as Record<string, unknown>),
          supersedesAnswerMessageId: predecessorMessageId,
        },
      },
    };
  });
}

function transactor(db: ReturnType<typeof openDatabase>) {
  return createTransactor({
    db,
    workspaceId: workspace.workspaceId,
    newEventId: () => "unused",
    now: () => "2026-08-07T00:00:06.000Z",
    onCommitted: () => {},
  });
}

function events(): EventEnvelope[] {
  return [
    event(1, "workspace.opened", "workspace", "ws_source", 1, {
      type: "workspace.opened",
      ...workspace,
    }),
    event(
      2,
      "session.started",
      "session",
      "session_a",
      1,
      {
        type: "session.started",
        sessionId: "session_a",
        artifactId: null,
        originatingAgentId: "codex",
        agentId: "codex",
        processNonce: "process_codex",
        baseRevisionId: null,
        title: "Question session",
        goal: "answer exactly",
        predecessorSessionId: null,
        handoffSummary: null,
      },
      { kind: "agent", id: "codex" },
    ),
    chatEvent(
      3,
      "question_1",
      { kind: "agent", id: "codex" },
      {
        type: "choice-question",
        prompt: "Which route?",
        options: [
          { key: "keep", label: "Keep the current approach" },
          { key: "change", label: "Change the approach" },
        ],
      },
    ),
    chatEvent(
      4,
      "answer_1",
      { kind: "human", id: "alex" },
      {
        type: "choice-answer",
        questionMessageId: "question_1",
        optionKey: "keep",
        supersedesAnswerMessageId: null,
      },
    ),
    chatEvent(
      5,
      "answer_2",
      { kind: "human", id: "alex" },
      {
        type: "choice-answer",
        questionMessageId: "question_1",
        optionKey: "change",
        supersedesAnswerMessageId: "answer_1",
      },
    ),
  ];
}

function chatEvent(
  seq: number,
  messageId: string,
  actor: Readonly<{ kind: "human" | "agent"; id: string }>,
  content: Readonly<Record<string, unknown>>,
): EventEnvelope {
  return event(
    seq,
    "chat.message",
    "chat",
    "workspace",
    seq - 2,
    {
      type: "chat.message",
      messageId,
      artifactId: null,
      author: `${actor.kind}:${actor.id}`,
      text:
        content.type === "choice-question"
          ? String(content.prompt)
          : content.optionKey === "keep"
            ? "Keep the current approach"
            : "Change the approach",
      content,
      context: null,
      mentions: [],
      references: [],
      attachments: [],
      sessionId: "session_a",
      recipientAgentId: null,
      threadId: "session_a",
      workId: null,
      intentId: null,
    },
    actor,
  );
}

function event(
  seq: number,
  eventType: string,
  streamType: string,
  streamId: string,
  streamVersion: number,
  payload: Record<string, unknown>,
  actor: Readonly<{ kind: "human" | "agent" | "system"; id: string }> = {
    kind: "system",
    id: "fixture",
  },
): EventEnvelope {
  return {
    seq,
    eventId: `evt_${seq}`,
    workspaceId: workspace.workspaceId,
    streamType,
    streamId,
    streamVersion,
    eventType,
    schemaVersion: 1,
    recordedAt: `2026-08-07T00:00:0${seq}.000Z`,
    actor,
    causationId: `cmd_${seq}`,
    correlationId: "corr_question",
    payload,
  };
}
