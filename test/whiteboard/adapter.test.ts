import { describe, expect, it, vi } from "vitest";
import {
  convertLegacyScene,
  deterministicId,
  elementsFingerprint,
  legacyToSkeleton,
  normalizeElementAnchors,
  sceneElementNodes,
  validateNativeScene,
  WhiteboardDataError,
} from "../../web/artifact/src/whiteboard-adapter.js";

describe("whiteboard legacy adapter", () => {
  const legacy = {
    shapes: [
      {
        type: "geo",
        x: 20,
        y: 30,
        props: {
          geo: "rectangle",
          w: 180,
          h: 80,
          text: "Agent workspace",
          fill: "solid",
          color: "violet",
        },
      },
      {
        type: "arrow",
        x: 10,
        y: 5,
        props: {
          start: { x: 40, y: 50 },
          end: { x: 240, y: 150 },
          text: "live draft",
          color: "blue",
        },
      },
      {
        type: "text",
        x: 100,
        y: 220,
        props: { text: "Human + agent", size: "s" },
      },
    ],
  };

  it("is deterministic and preserves geometry, labels, colors, and arrow endpoints", () => {
    const first = legacyToSkeleton(legacy, { boardId: "board.alpha" });
    const second = legacyToSkeleton(legacy, { boardId: "board.alpha" });

    expect(second).toEqual(first);
    expect(first[0]).toMatchObject({
      type: "rectangle",
      x: 20,
      y: 30,
      width: 180,
      height: 80,
      strokeColor: "#7048e8",
      backgroundColor: "#d0bfff",
      label: { text: "Agent workspace" },
    });
    expect(first[1]).toMatchObject({
      type: "arrow",
      x: 50,
      y: 55,
      points: [
        [0, 0],
        [200, 100],
      ],
      label: { text: "live draft" },
    });
    expect(first[2]).toMatchObject({ type: "text", text: "Human + agent", fontSize: 16 });
  });

  it("pins Excalidraw identity regeneration off and detects dropped shapes", () => {
    const convert = vi.fn((skeleton, options) => {
      expect(options).toEqual({ regenerateIds: false });
      return skeleton;
    });
    const scene = convertLegacyScene(legacy, { boardId: "board.alpha", convert });
    expect(convert).toHaveBeenCalledOnce();
    expect(scene.type).toBe("excalidraw");
    expect(scene.elements).toHaveLength(3);

    expect(() =>
      convertLegacyScene(legacy, {
        boardId: "board.alpha",
        convert: (skeleton) => skeleton.slice(1),
      }),
    ).toThrow(/conversion lost 1 shape/i);
  });

  it("rejects unsupported shapes, bindings, snapshots, and duplicate ids instead of partial import", () => {
    expect(() => legacyToSkeleton({ shapes: [{ type: "video", props: {} }] })).toThrow(
      /unsupported legacy shape type/i,
    );
    expect(() => legacyToSkeleton({ document: { pages: [] } })).toThrow(
      /unsupported legacy whiteboard snapshot/i,
    );
    expect(() =>
      legacyToSkeleton({
        shapes: [
          {
            type: "arrow",
            props: {
              start: { type: "binding", boundShapeId: "a" },
              end: { x: 10, y: 10 },
            },
          },
        ],
      }),
    ).toThrow(/binding schema/i);
    expect(() =>
      legacyToSkeleton({
        shapes: [
          { id: "same", type: "text", props: { text: "A" } },
          { id: "same", type: "text", props: { text: "B" } },
        ],
      }),
    ).toThrow(/duplicate legacy shape id/i);
  });
});

describe("whiteboard native scene and anchors", () => {
  const native = {
    type: "excalidraw",
    version: 2,
    source: "https://tweakloop.local",
    elements: [{ id: "shape-a", type: "rectangle" }],
    appState: {},
    files: {},
  };

  it("accepts the pinned native envelope and rejects unknown or malformed data", () => {
    expect(validateNativeScene(native)).toBe(native);
    expect(() => validateNativeScene({ ...native, mystery: true })).toThrow(
      /unsupported excalidraw scene field/i,
    );
    expect(() => validateNativeScene({ ...native, type: "tldraw" })).toThrow(
      /must be "excalidraw"/i,
    );
    expect(() =>
      validateNativeScene({ ...native, elements: [{ id: "shape-a", type: "selection" }] }),
    ).toThrow(/unsupported excalidraw element type/i);
    expect(() =>
      validateNativeScene({
        ...native,
        elements: [
          { id: "shape-a", type: "rectangle" },
          { id: "shape-a", type: "text" },
        ],
      }),
    ).toThrow(/duplicate excalidraw element id/i);
  });

  it("repairs missing or duplicate semantic anchors without changing element ids", () => {
    const { elements, changed } = normalizeElementAnchors([
      { id: "shape-a", type: "rectangle", customData: { tweakloop: { anchorId: "shared" } } },
      { id: "shape-b", type: "ellipse", customData: { tweakloop: { anchorId: "shared" } } },
      { id: "shape-c", type: "text", text: "Label" },
    ]);
    expect(changed).toBe(true);
    expect(elements.map((element) => element.id)).toEqual(["shape-a", "shape-b", "shape-c"]);
    expect(elements.map((element) => element.customData.tweakloop.anchorId)).toEqual([
      "shared",
      "shape-b",
      "shape-c",
    ]);
  });

  it("projects bound labels as stable boardAnchor.elementAnchor nodes", () => {
    const nodes = sceneElementNodes(
      "board.alpha",
      [
        {
          id: "shape-a",
          type: "rectangle",
          version: 7,
          versionNonce: 41,
          customData: { tweakloop: { schema: 1, anchorId: "system-boundary" } },
          boundElements: [{ id: "label-a", type: "text" }],
        },
        {
          id: "label-a",
          type: "text",
          version: 2,
          versionNonce: 19,
          text: "System boundary",
          customData: { tweakloop: { schema: 1, anchorId: "label-a" } },
        },
      ],
      {
        whiteboardArtifactId: "artifact-1",
        baseRevisionId: "revision-2",
        sceneHash: "abc123",
        draftId: "draft-1",
        draftVersion: 3,
      },
    );
    expect(nodes[0]).toEqual({
      semanticId: "board.alpha#system-boundary",
      kind: "whiteboard-element",
      source: null,
      label: "System boundary",
      boardAnchor: {
        semanticId: "board.alpha",
        whiteboardArtifactId: "artifact-1",
        baseRevisionId: "revision-2",
        sceneHash: "abc123",
        draftId: "draft-1",
        draftVersion: 3,
        elementAnchor: {
          anchorId: "system-boundary",
          elementId: "shape-a",
          type: "rectangle",
          version: 7,
          versionNonce: 41,
          label: "System boundary",
        },
      },
    });
  });

  it("fingerprints content changes but not object identity", () => {
    const left = [{ id: "a", version: 1, x: 10, y: 20 }];
    const right = [{ ...left[0] }];
    expect(elementsFingerprint(left)).toBe(elementsFingerprint(right));
    expect(elementsFingerprint(left)).not.toBe(elementsFingerprint([{ ...left[0], x: 11 }]));
    expect(deterministicId({ b: 2, a: 1 })).toBe(deterministicId({ a: 1, b: 2 }));
  });

  it("uses a typed error for caller-visible failures", () => {
    expect(() => validateNativeScene(null)).toThrow(WhiteboardDataError);
  });
});
