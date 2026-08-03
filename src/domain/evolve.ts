import type { DomainEvent } from "./events.js";
import { type DomainState, initialState } from "./state.js";

/** Deterministic fold step: same events in the same order, same state. */
export function evolve(state: DomainState, event: DomainEvent): DomainState {
  switch (event.type) {
    case "workspace.opened":
      return { ...state, workspaceOpened: true, projectId: event.projectId };
    case "artifact.registered": {
      const artifacts = new Map(state.artifacts);
      artifacts.set(event.artifactId, {
        artifactId: event.artifactId,
        name: event.name,
        format: event.format,
        sourcePath: event.sourcePath,
      });
      return { ...state, artifacts };
    }
  }
}

export function replay(events: readonly DomainEvent[]): DomainState {
  return events.reduce(evolve, initialState);
}
