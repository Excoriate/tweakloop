import type { SemanticBounds, SemanticSceneMap } from "../whiteboard/semantic-representation.js";

export const WHITEBOARD_SCENE_INSPECT_PROTOCOL = "tweakloop.whiteboard-scene-inspect/v1" as const;

export type WhiteboardSceneInspectNode = Readonly<{
  semanticKey: string;
  kind: "node";
  shape: "rectangle" | "ellipse" | "diamond";
  label: string | null;
  bounds: SemanticBounds;
  deleted: boolean;
}>;

export type WhiteboardSceneInspectEdge = Readonly<{
  semanticKey: string;
  kind: "edge";
  from: string;
  to: string;
  label: string | null;
  bounds: SemanticBounds;
  deleted: boolean;
}>;

export type WhiteboardSceneInspectGroup = Readonly<{
  semanticKey: string;
  members: readonly string[];
}>;

export type WhiteboardSceneInspect = Readonly<{
  protocol: typeof WHITEBOARD_SCENE_INSPECT_PROTOCOL;
  artifactId: string;
  scene: Readonly<{
    nodes: readonly WhiteboardSceneInspectNode[];
    edges: readonly WhiteboardSceneInspectEdge[];
    groups: readonly WhiteboardSceneInspectGroup[];
  }>;
}>;

/**
 * Project the renderer-aware internal map into the closed public inspection ABI.
 * Every field is selected explicitly so additions to the internal representation
 * remain private by default.
 */
export function projectWhiteboardSceneInspect(
  artifactId: string,
  semanticMap: SemanticSceneMap,
): WhiteboardSceneInspect {
  const entities = Object.values(semanticMap.entities).sort(compareSemanticKey);
  return {
    protocol: WHITEBOARD_SCENE_INSPECT_PROTOCOL,
    artifactId,
    scene: {
      nodes: entities
        .filter((entity) => entity.kind === "node")
        .map((entity) => ({
          semanticKey: entity.semanticKey,
          kind: "node",
          shape: entity.shape as WhiteboardSceneInspectNode["shape"],
          label: entity.label,
          bounds: publicBounds(entity.bounds),
          deleted: entity.deleted,
        })),
      edges: entities
        .filter((entity) => entity.kind === "edge")
        .map((entity) => ({
          semanticKey: entity.semanticKey,
          kind: "edge",
          from: entity.from as string,
          to: entity.to as string,
          label: entity.label,
          bounds: publicBounds(entity.bounds),
          deleted: entity.deleted,
        })),
      groups: Object.values(semanticMap.groups)
        .sort(compareSemanticKey)
        .map((group) => ({
          semanticKey: group.semanticKey,
          members: [...group.members],
        })),
    },
  };
}

function publicBounds(bounds: SemanticBounds): SemanticBounds {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function compareSemanticKey(
  left: Readonly<{ semanticKey: string }>,
  right: Readonly<{ semanticKey: string }>,
): number {
  return left.semanticKey < right.semanticKey ? -1 : left.semanticKey > right.semanticKey ? 1 : 0;
}
