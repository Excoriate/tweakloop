import type { DomainCommand } from "./commands.js";
import type { DomainEvent } from "./events.js";
import type { DomainState } from "./state.js";

export type Decision =
  | Readonly<{ ok: true; events: readonly DomainEvent[]; response: unknown }>
  | Readonly<{ ok: false; code: string; message: string; details?: unknown }>;

/**
 * The pure decision boundary: no I/O, no clock, no randomness.
 * Given current state and a command, decide which facts become true.
 */
export function decide(state: DomainState, command: DomainCommand): Decision {
  switch (command.type) {
    case "workspace.open": {
      if (state.workspaceOpened) {
        return {
          ok: true,
          events: [],
          response: { alreadyOpen: true, projectId: state.projectId },
        };
      }
      return {
        ok: true,
        events: [
          {
            type: "workspace.opened",
            workspaceId: command.workspaceId,
            projectId: command.projectId,
            rootPath: command.rootPath,
          },
        ],
        response: { alreadyOpen: false, projectId: command.projectId },
      };
    }

    case "artifact.register": {
      if (state.artifacts.has(command.artifactId)) {
        return {
          ok: false,
          code: "artifact.already-registered",
          message: `artifact ${command.artifactId} is already registered`,
          details: { artifactId: command.artifactId },
        };
      }
      if (command.sourcePath !== null) {
        for (const existing of state.artifacts.values()) {
          if (existing.sourcePath === command.sourcePath) {
            return {
              ok: false,
              code: "artifact.source-already-registered",
              message: `source ${command.sourcePath} is already registered as ${existing.artifactId}`,
              details: { artifactId: existing.artifactId },
            };
          }
        }
      }
      return {
        ok: true,
        events: [
          {
            type: "artifact.registered",
            artifactId: command.artifactId,
            name: command.name,
            format: command.format,
            sourcePath: command.sourcePath,
          },
        ],
        response: { artifactId: command.artifactId },
      };
    }
  }
}
