/**
 * Domain state is a derived value: fold events with evolve() to produce
 * it. It is never stored; projections materialize what queries need.
 */

export type ArtifactFormat = "html" | "markdown";

export type ArtifactState = Readonly<{
  artifactId: string;
  name: string;
  format: ArtifactFormat;
  sourcePath: string | null;
}>;

export type DomainState = Readonly<{
  workspaceOpened: boolean;
  projectId: string | null;
  artifacts: ReadonlyMap<string, ArtifactState>;
}>;

export const initialState: DomainState = {
  workspaceOpened: false,
  projectId: null,
  artifacts: new Map(),
};
