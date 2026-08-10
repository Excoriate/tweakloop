import { describe, expect, it } from "vitest";
import { validateCommand } from "../../src/protocol/validation.js";

const valid = {
  protocol: "tweakloop.command/v1",
  commandId: "cmd-1",
  idempotencyKey: "key-1",
  workspaceId: "ws_test",
  actor: { kind: "human", id: "alex" },
  type: "artifact.register",
  payload: {
    artifactId: "artifact_1",
    name: "plan.html",
    format: "html",
    sourcePath: "/repo/plan.html",
  },
};

describe("command validation", () => {
  it("accepts a well-formed envelope", () => {
    expect(validateCommand(valid)).toMatchObject({ ok: true });
  });

  it("accepts artifact-free sessions, explicit attachment, and hash-prepared composite creation", () => {
    expect(
      validateCommand({
        ...valid,
        type: "session.start",
        payload: {
          sessionId: "session_empty",
          artifactId: null,
          agentId: "alex",
          processNonce: "process_1",
          baseRevisionId: null,
          title: "Empty room",
          goal: "Open files later",
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCommand({
        ...valid,
        type: "session.attach-artifact",
        payload: {
          sessionId: "session_empty",
          artifactId: "artifact_1",
          revisionId: "revision_1",
          role: "opened",
        },
      }),
    ).toMatchObject({ ok: true });
    expect(
      validateCommand({
        ...valid,
        type: "artifact.create",
        payload: {
          artifactId: "artifact_board",
          name: "Untitled whiteboard",
          format: "whiteboard",
          sourcePath: null,
          provenance: { kind: "generated" },
          revisionId: "revision_board_1",
          entryPath: "scene.excalidraw",
          entryHash: "scene-hash",
          files: [
            {
              path: "scene.excalidraw",
              hash: "scene-hash",
              mediaType: "application/vnd.excalidraw+json",
            },
          ],
          producer: { kind: "human", id: "alex" },
          attachment: { sessionId: "session_empty", role: "whiteboard" },
        },
      }),
    ).toMatchObject({ ok: true });
  });

  it("rejects a malformed envelope", () => {
    expect(validateCommand({ hello: "world" })).toMatchObject({
      ok: false,
      code: "protocol.invalid-envelope",
    });
    expect(validateCommand(null)).toMatchObject({ ok: false });
  });

  it("rejects unknown command types", () => {
    expect(validateCommand({ ...valid, type: "artifact.destroy" })).toMatchObject({
      ok: false,
      code: "protocol.unknown-command",
    });
  });

  it("rejects payloads that fail the per-command schema", () => {
    expect(validateCommand({ ...valid, payload: { artifactId: "a" } })).toMatchObject({
      ok: false,
      code: "protocol.invalid-payload",
    });
    expect(
      validateCommand({ ...valid, payload: { ...valid.payload, format: "pptx" } }),
    ).toMatchObject({ ok: false, code: "protocol.invalid-payload" });
  });

  it("accepts first-class whiteboard artifacts and exact element targets", () => {
    expect(
      validateCommand({ ...valid, payload: { ...valid.payload, format: "whiteboard" } }),
    ).toMatchObject({ ok: true });

    const review = {
      ...valid,
      type: "review.submit-batch",
      payload: {
        batchId: "batch_1",
        workId: "work_1",
        artifactId: "artifact_board",
        revisionId: "rev_board_3",
        intents: [
          {
            intentId: "intent_1",
            intentType: "comment",
            target: {
              semanticId: "architecture.flow#service",
              boardAnchor: {
                semanticId: "architecture.flow",
                whiteboardArtifactId: "artifact_board",
                baseRevisionId: "rev_board_3",
                sceneHash: "sha256:scene",
                draftId: "draft_1",
                draftVersion: 4,
                elementAnchor: {
                  anchorId: "service",
                  elementId: "element_service",
                  version: 2,
                  versionNonce: 42,
                  type: "rectangle",
                  label: "API service",
                },
              },
            },
            body: { text: "Split the responsibilities." },
          },
        ],
      },
    };
    expect(validateCommand(review)).toMatchObject({ ok: true });
    expect(
      validateCommand({
        ...review,
        payload: {
          ...review.payload,
          intents: [
            {
              ...review.payload.intents[0],
              target: {
                ...review.payload.intents[0].target,
                boardAnchor: {
                  ...review.payload.intents[0].target.boardAnchor,
                  elementAnchor: {
                    ...review.payload.intents[0].target.boardAnchor.elementAnchor,
                    geometry: { x: 10, y: 20 },
                  },
                },
              },
            },
          ],
        },
      }),
    ).toMatchObject({ ok: false, code: "protocol.invalid-payload" });
  });

  it("accepts every typed chat reference and rejects malformed union members", () => {
    const hash = "a".repeat(64);
    const chat = {
      ...valid,
      type: "chat.send",
      payload: {
        messageId: "message_1",
        text: "",
        references: [
          { kind: "file", label: "diagram.png", hash },
          { kind: "document", label: "Plan", artifactId: "artifact_plan", revisionId: "rev_3" },
          {
            kind: "selection",
            label: "Rollout paragraph",
            artifactId: "artifact_plan",
            revisionId: "rev_3",
            semanticId: "plan.rollout",
            textQuote: { exact: "one team per week", prefix: "stage ", suffix: "." },
          },
          {
            kind: "comment",
            label: "Security constraint",
            artifactId: "artifact_plan",
            revisionId: "rev_3",
            intentId: "intent_7",
          },
          { kind: "task", label: "Apply review", artifactId: "artifact_plan", workId: "work_2" },
          {
            kind: "whiteboard",
            label: "Architecture",
            artifactId: "artifact_board",
            revisionId: "rev_board_4",
            elementIds: ["element_1"],
            anchorIds: ["service-boundary"],
          },
        ],
        attachments: [{ hash, fileName: "diagram.png", mediaType: "image/png", byteLength: 42 }],
      },
    };
    expect(validateCommand(chat)).toMatchObject({ ok: true });

    expect(
      validateCommand({
        ...chat,
        payload: {
          ...chat.payload,
          references: [{ kind: "selection", label: "missing identity", artifactId: "a" }],
        },
      }),
    ).toMatchObject({ ok: false, code: "protocol.invalid-payload" });
    expect(
      validateCommand({
        ...chat,
        payload: {
          ...chat.payload,
          references: [{ kind: "spreadsheet", label: "unknown", artifactId: "a" }],
        },
      }),
    ).toMatchObject({ ok: false, code: "protocol.invalid-payload" });
  });

  it("requires stable whiteboard identity in board anchors", () => {
    expect(
      validateCommand({
        ...valid,
        type: "chat.send",
        payload: {
          messageId: "message_board",
          text: "look here",
          context: {
            boardAnchor: {
              semanticId: "board.flow",
              elementAnchor: { anchorId: "api", elementId: "element_api" },
            },
          },
        },
      }),
    ).toMatchObject({ ok: false, code: "protocol.invalid-payload" });
  });
});
