import { describe, expect, it } from "vitest";
import type { WhiteboardError } from "../../src/whiteboard/errors.js";
import {
  canonicalizeWhiteboardScene,
  WHITEBOARD_SCENE_MAX_BYTES,
} from "../../src/whiteboard/scene.js";

function scene(elements: unknown[] = []): Record<string, unknown> {
  return {
    type: "excalidraw",
    version: 2,
    source: "https://tweakloop.local",
    elements,
    appState: { viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

describe("whiteboard scene canonicalization", () => {
  it("removes view state, sorts object keys, preserves z-order, and derives stable element anchors", () => {
    const elements = [
      {
        versionNonce: 20,
        version: 3,
        type: "text",
        text: "  A durable   label  ",
        id: "text-1",
      },
      { id: "rect-1", type: "rectangle", version: 1, versionNonce: 10 },
    ];
    const first = canonicalizeWhiteboardScene(
      JSON.stringify({
        files: {},
        appState: { scrollX: 200, zoom: { value: 2 }, viewBackgroundColor: "#fff" },
        elements,
        version: 2,
        type: "excalidraw",
        source: "https://tweakloop.local",
      }),
    );
    const second = canonicalizeWhiteboardScene(
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "https://tweakloop.local",
        elements,
        appState: { viewBackgroundColor: "#fff", scrollY: -50 },
        files: {},
      }),
    );

    expect(first.hash).toBe(second.hash);
    expect(first.bytes.toString()).not.toContain("scrollX");
    expect(first.bytes.toString()).not.toContain("zoom");
    expect((first.scene.elements as { id: string }[]).map((element) => element.id)).toEqual([
      "text-1",
      "rect-1",
    ]);
    expect(first.elementIndex.elements[0]).toMatchObject({
      elementId: "text-1",
      elementVersion: 3,
      elementVersionNonce: 20,
      label: "A durable label",
    });
    expect(first.elementIndex.elements[1]?.label).toBeNull();
  });

  it("rejects duplicate element ids, including deleted records, instead of creating ambiguous anchors", () => {
    const duplicate = scene([
      { id: "same", type: "rectangle", version: 1, versionNonce: 1, isDeleted: true },
      { id: "same", type: "text", version: 2, versionNonce: 2, text: "other" },
    ]);
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(duplicate))).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({ code: "whiteboard.scene-invalid" }),
    );
  });

  it("rejects values that JSON parsing would otherwise normalize into different scene bytes", () => {
    const nonFinite = JSON.stringify(scene()).replace(
      '"elements":[]',
      '"elements":[{"id":"rect","type":"rectangle","version":1,"versionNonce":1,"x":1e999}]',
    );
    expect(() => canonicalizeWhiteboardScene(nonFinite)).toThrow("non-finite number");

    expect(() =>
      canonicalizeWhiteboardScene(
        JSON.stringify(
          scene([
            {
              id: "unsafe-version",
              type: "rectangle",
              version: Number.MAX_SAFE_INTEGER + 1,
              versionNonce: 1,
            },
          ]),
        ),
      ),
    ).toThrow("invalid version");

    const prefix = Buffer.from(
      '{"type":"excalidraw","version":2,"elements":[],"appState":{"label":"',
    );
    const suffix = Buffer.from('"},"files":{}}');
    const invalidUtf8 = Buffer.concat([prefix, Buffer.from([0xc3, 0x28]), suffix]);
    expect(() => canonicalizeWhiteboardScene(invalidUtf8)).toThrow("valid UTF-8");
  });

  it("rejects invalid ids and scenes larger than the release bound", () => {
    expect(() =>
      canonicalizeWhiteboardScene(
        JSON.stringify(
          scene([{ id: "contains space", type: "rectangle", version: 1, versionNonce: 1 }]),
        ),
      ),
    ).toThrow("invalid id");

    const oversized = scene([
      {
        id: "text",
        type: "text",
        version: 1,
        versionNonce: 1,
        text: "x".repeat(WHITEBOARD_SCENE_MAX_BYTES),
      },
    ]);
    expect(() => canonicalizeWhiteboardScene(JSON.stringify(oversized))).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({ code: "whiteboard.scene-too-large" }),
    );

    const whitespacePadded = `${" ".repeat(WHITEBOARD_SCENE_MAX_BYTES)}${JSON.stringify(scene())}`;
    expect(() => canonicalizeWhiteboardScene(whitespacePadded)).toThrowError(
      expect.objectContaining<Partial<WhiteboardError>>({ code: "whiteboard.scene-too-large" }),
    );
  });
});
