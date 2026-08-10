export type DraftChangedTarget = Readonly<{
  semanticKey: string;
  anchorId: string;
  elementId: string | null;
  elementType: "rectangle" | "ellipse" | "diamond" | "arrow";
  elementVersion: number | null;
  elementVersionNonce: number | null;
  deleted: boolean;
  label: string | null;
  bounds: Readonly<{ x: number; y: number; width: number; height: number }>;
}>;

export type DraftInvalidation = Readonly<{
  protocol: "tweakloop.whiteboard-draft/v1";
  kind: "whiteboard-draft";
  artifactId: string;
  draftId: string;
  draftVersion: number;
  baseRevisionId: string;
  sceneHash: string;
  updatedBy: Readonly<{ kind: string; id: string }>;
  deduplicationKey?: string;
  changedTargets?: readonly DraftChangedTarget[];
  changedBounds?: Readonly<{ x: number; y: number; width: number; height: number }> | null;
}>;

export type DraftHub = Readonly<{
  publish: (invalidation: DraftInvalidation) => void;
  subscribe: (artifactId: string, send: (value: DraftInvalidation) => void) => () => void;
}>;

export function createDraftHub(): DraftHub {
  const subscribers = new Map<string, Set<(value: DraftInvalidation) => void>>();
  return {
    publish(invalidation) {
      for (const send of subscribers.get(invalidation.artifactId) ?? []) send(invalidation);
    },
    subscribe(artifactId, send) {
      let listeners = subscribers.get(artifactId);
      if (!listeners) {
        listeners = new Set();
        subscribers.set(artifactId, listeners);
      }
      listeners.add(send);
      return () => {
        listeners?.delete(send);
        if (listeners?.size === 0) subscribers.delete(artifactId);
      };
    },
  };
}
