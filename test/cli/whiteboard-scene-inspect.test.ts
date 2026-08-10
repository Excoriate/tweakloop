import { describe, expect, it } from "vitest";
import {
  projectWhiteboardSceneInspect,
  WHITEBOARD_SCENE_INSPECT_PROTOCOL,
} from "../../src/cli/whiteboard-scene-inspect.js";
import type {
  SemanticSceneEntity,
  SemanticSceneMap,
} from "../../src/whiteboard/semantic-representation.js";

describe("public whiteboard scene inspection", () => {
  it("projects only the closed semantic node, edge, and group fields", () => {
    const output = projectWhiteboardSceneInspect("artifact_board", internalMap());

    expect(output).toEqual({
      protocol: WHITEBOARD_SCENE_INSPECT_PROTOCOL,
      artifactId: "artifact_board",
      scene: {
        nodes: [
          {
            semanticKey: "api",
            kind: "node",
            shape: "ellipse",
            label: "API",
            bounds: { x: 300, y: 20, width: 120, height: 80 },
            deleted: false,
          },
          {
            semanticKey: "browser",
            kind: "node",
            shape: "rectangle",
            label: "Browser",
            bounds: { x: 20, y: 20, width: 120, height: 80 },
            deleted: false,
          },
          {
            semanticKey: "retired-ui",
            kind: "node",
            shape: "diamond",
            label: "Retired UI",
            bounds: { x: 20, y: 180, width: 120, height: 80 },
            deleted: true,
          },
        ],
        edges: [
          {
            semanticKey: "browser-api",
            kind: "edge",
            from: "browser",
            to: "api",
            label: "HTTPS",
            bounds: { x: 80, y: 60, width: 280, height: 0 },
            deleted: false,
          },
        ],
        groups: [
          { semanticKey: "clients", members: ["browser"] },
          { semanticKey: "system", members: ["browser", "api"] },
        ],
      },
    });
  });

  it("recursively excludes renderer state and authority, path, and URL-shaped fields", () => {
    const output = projectWhiteboardSceneInspect("artifact_board", internalMap());
    const keys = recursiveKeys(output);
    const forbiddenKeys = new Set([
      "elementId",
      "elementSeed",
      "elementVersion",
      "elementVersionNonce",
      "labelElementId",
      "labelSeed",
      "labelVersion",
      "labelVersionNonce",
      "anchorId",
      "retiredElements",
      "groupId",
    ]);

    expect(keys.filter((key) => forbiddenKeys.has(key))).toEqual([]);
    expect(keys.filter((key) => /(seed|nonce|version)/i.test(key))).toEqual([]);
    expect(keys.filter((key) => /(authority|path|url)/i.test(key))).toEqual([]);
    const serialized = JSON.stringify(output);
    for (const privateSentinel of [
      "anchor_api_private",
      "element_api_private",
      "label_api_private",
      "retired_api_private",
      "group_clients_private",
      "authority_private",
      "path_private",
      "url_private",
    ]) {
      expect(serialized).not.toContain(privateSentinel);
    }
  });
});

function internalMap(): SemanticSceneMap {
  const map: SemanticSceneMap = {
    protocol: "tweakloop.semantic-scene-map/v1",
    entities: {
      browser: entity({
        semanticKey: "browser",
        kind: "node",
        shape: "rectangle",
        label: "Browser",
        from: null,
        to: null,
        deleted: false,
        bounds: { x: 20, y: 20, width: 120, height: 80 },
        anchorId: "anchor_browser_private",
        elementId: "element_browser_private",
        labelElementId: "label_browser_private",
      }),
      "browser-api": entity({
        semanticKey: "browser-api",
        kind: "edge",
        shape: null,
        label: "HTTPS",
        from: "browser",
        to: "api",
        deleted: false,
        bounds: { x: 80, y: 60, width: 280, height: 0 },
        anchorId: "anchor_edge_private",
        elementId: "element_edge_private",
        labelElementId: "label_edge_private",
      }),
      api: entity({
        semanticKey: "api",
        kind: "node",
        shape: "ellipse",
        label: "API",
        from: null,
        to: null,
        deleted: false,
        bounds: { x: 300, y: 20, width: 120, height: 80 },
        anchorId: "anchor_api_private",
        elementId: "element_api_private",
        labelElementId: "label_api_private",
      }),
      "retired-ui": entity({
        semanticKey: "retired-ui",
        kind: "node",
        shape: "diamond",
        label: "Retired UI",
        from: null,
        to: null,
        deleted: true,
        bounds: { x: 20, y: 180, width: 120, height: 80 },
        anchorId: "anchor_retired_ui_private",
        elementId: null,
        labelElementId: null,
      }),
    },
    groups: {
      system: {
        semanticKey: "system",
        groupId: "group_system_private",
        members: ["browser", "api"],
      },
      clients: {
        semanticKey: "clients",
        groupId: "group_clients_private",
        members: ["browser"],
      },
    },
  };
  return {
    ...map,
    authority: "authority_private",
    sourcePath: "path_private",
    sceneUrl: "url_private",
    normalizationVersion: 99,
    entities: Object.fromEntries(
      Object.entries(map.entities).map(([semanticKey, value]) => [
        semanticKey,
        {
          ...value,
          rendererPath: "path_private",
          authority: "authority_private",
          rendererVersion: 99,
        },
      ]),
    ),
  } as unknown as SemanticSceneMap;
}

function entity(
  input: Pick<
    SemanticSceneEntity,
    | "semanticKey"
    | "kind"
    | "shape"
    | "label"
    | "from"
    | "to"
    | "deleted"
    | "bounds"
    | "anchorId"
    | "elementId"
    | "labelElementId"
  >,
): SemanticSceneEntity {
  return {
    ...input,
    elementVersion: input.elementId === null ? null : 7,
    elementVersionNonce: input.elementId === null ? null : 11,
    elementSeed: input.elementId === null ? null : 13,
    labelVersion: input.labelElementId === null ? null : 17,
    labelVersionNonce: input.labelElementId === null ? null : 19,
    labelSeed: input.labelElementId === null ? null : 23,
    retiredElements: [
      {
        elementId: `retired_${input.semanticKey}_private`,
        elementType: "rectangle",
        role: "primary",
        version: 3,
        versionNonce: 5,
        seed: 7,
      },
    ],
  };
}

function recursiveKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(recursiveKeys);
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...recursiveKeys(child)]);
}
