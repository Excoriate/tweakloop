import type { ArtifactFormat } from "./state.js";

/**
 * Durable domain facts. Events are values: never rewritten, only
 * appended. The stored payload is exactly one of these objects.
 */
export type DomainEvent =
  | Readonly<{
      type: "workspace.opened";
      workspaceId: string;
      projectId: string;
      rootPath: string;
    }>
  | Readonly<{
      type: "artifact.registered";
      artifactId: string;
      name: string;
      format: ArtifactFormat;
      sourcePath: string | null;
    }>;

export type DomainEventType = DomainEvent["type"];

export type StreamRef = Readonly<{ streamType: string; streamId: string }>;

/** Which stream a fact belongs to; stream versions gate optimistic concurrency. */
export function streamOf(event: DomainEvent): StreamRef {
  switch (event.type) {
    case "workspace.opened":
      return { streamType: "workspace", streamId: event.workspaceId };
    case "artifact.registered":
      return { streamType: "artifact", streamId: event.artifactId };
  }
}
