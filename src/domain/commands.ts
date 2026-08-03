import type { ArtifactFormat } from "./state.js";

/**
 * Domain commands are values built at the boundary from validated
 * command envelopes. IDs and paths arrive as inputs — the domain never
 * generates identity, time, or randomness.
 */
export type DomainCommand =
  | Readonly<{
      type: "workspace.open";
      workspaceId: string;
      projectId: string;
      rootPath: string;
    }>
  | Readonly<{
      type: "artifact.register";
      artifactId: string;
      name: string;
      format: ArtifactFormat;
      sourcePath: string | null;
    }>;
