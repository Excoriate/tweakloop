/**
 * The projection snapshot served to browsers and the CLI —
 * versioned public data, like every protocol shape.
 */

export type SnapshotArtifact = Readonly<{
  artifactId: string;
  name: string;
  format: string;
  sourcePath: string | null;
  registeredSeq: number;
}>;

export type SnapshotTimelineEntry = Readonly<{
  seq: number;
  recordedAt: string;
  eventType: string;
  streamType: string;
  streamId: string;
  summary: string;
}>;

export type Snapshot = Readonly<{
  protocol: "tweakloop.snapshot/v1";
  workspace: Readonly<{
    workspaceId: string;
    projectId: string;
    rootPath: string;
    protocolVersion: number;
  }>;
  artifacts: readonly SnapshotArtifact[];
  timeline: readonly SnapshotTimelineEntry[];
  lastSeq: number;
}>;
