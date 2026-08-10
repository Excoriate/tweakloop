import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import { WORKSPACE_EXPORT_PROTOCOL } from "../../src/protocol/versions.js";
import {
  WORKSPACE_EXPORT_MANIFEST_PATH,
  WORKSPACE_EXPORT_OBJECT_PREFIX,
  type WorkspaceExportManifest,
} from "../../src/protocol/workspace-export.js";
import {
  captureWorkspaceFiles,
  planWorkspaceFilesOverlay,
  publishWorkspaceBundle,
  restoreWorkspaceFiles,
  stageWorkspaceFilesOverlay,
  validateWorkspaceBundleEnvelope,
  validateWorkspaceFilesConfig,
  validateWorkspaceFilesManifest,
  WORKSPACE_BUNDLE_ENVELOPE_PATH,
  WORKSPACE_FILES_CONFIG_PROTOCOL,
  WORKSPACE_FILES_MANIFEST_PATH,
  WORKSPACE_FILES_SNAPSHOT_PROTOCOL,
  WorkspaceFilesError,
  writeWorkspaceBundleEnvelope,
} from "../../src/workspace/files.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function fixture(): { root: string; source: string; snapshot: string; restored: string } {
  const root = mkdtempSync(join(tmpdir(), "tweakloop-workspace-files-"));
  roots.push(root);
  const source = join(root, "source");
  mkdirSync(source);
  return {
    root,
    source,
    snapshot: join(root, "snapshot"),
    restored: join(root, "restored"),
  };
}

function config(overrides: Partial<{ includes: string[]; excludes: string[] }> = {}) {
  return {
    protocol: WORKSPACE_FILES_CONFIG_PROTOCOL,
    includes: overrides.includes ?? ["src/**", "README.md"],
    excludes: overrides.excludes ?? ["src/generated/**"],
    notes: ["Portable source skeleton; managed review history lives in the event bundle."],
  };
}

function sha(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type DurableFixture = Readonly<{ path: string; bytes: string; artifactId?: string }>;

function collaborationManifest(durable: readonly DurableFixture[]): WorkspaceExportManifest {
  const workspaceEvent: EventEnvelope = {
    seq: 1,
    eventId: "event_1",
    workspaceId: "workspace_source",
    streamType: "workspace",
    streamId: "workspace_source",
    streamVersion: 1,
    eventType: "workspace.opened",
    schemaVersion: 1,
    recordedAt: "2026-08-08T12:00:00.000Z",
    actor: { kind: "agent", id: "codex" },
    causationId: "command_1",
    correlationId: "correlation_1",
    payload: {
      type: "workspace.opened",
      workspaceId: "workspace_source",
      projectId: "project_source",
      rootPath: "/source",
    },
  };
  return {
    protocol: WORKSPACE_EXPORT_PROTOCOL,
    source: {
      workspaceId: "workspace_source",
      projectId: "project_source",
      rootPath: "/source",
    },
    capturedSeq: 1,
    artifacts: durable.map((entry, index) => {
      const artifactId = entry.artifactId ?? `artifact_${index + 1}`;
      return {
        artifactId,
        format: "markdown",
        headRevisionId: `revision_${index + 1}`,
        headSeq: index + 1,
        entryHash: sha(entry.bytes),
        exportedPath: entry.path,
      };
    }),
    revisions: durable.map((entry, index) => {
      const hash = sha(entry.bytes);
      return {
        revisionId: `revision_${index + 1}`,
        artifactId: entry.artifactId ?? `artifact_${index + 1}`,
        parentId: null,
        seq: 1,
        format: "markdown",
        entryPath: entry.path,
        entryHash: hash,
        objectPath: `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${hash}`,
        files: [
          {
            path: entry.path,
            hash,
            mediaType: "text/markdown",
            byteLength: Buffer.byteLength(entry.bytes),
            objectPath: `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${hash}`,
          },
        ],
      };
    }),
    attachments: [],
    events: [workspaceEvent],
  };
}

function writeCollaborationManifest(bundle: string, manifest: WorkspaceExportManifest): void {
  const manifestPath = join(bundle, WORKSPACE_EXPORT_MANIFEST_PATH);
  mkdirSync(join(manifestPath, ".."), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writeWorkingFiles(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, bytes] of Object.entries(files)) {
    const target = join(root, ...path.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  }
}

function boundBundle(
  input: Readonly<{
    durable: readonly DurableFixture[];
    working?: Readonly<Record<string, string>>;
  }>,
): Readonly<{ root: string; bundle: string; source: string }> {
  const root = mkdtempSync(join(tmpdir(), "tweakloop-bound-bundle-"));
  roots.push(root);
  const bundle = join(root, "bundle");
  const source = join(root, "source");
  mkdirSync(bundle);
  mkdirSync(source);
  writeCollaborationManifest(bundle, collaborationManifest(input.durable));
  if (input.working !== undefined) {
    writeWorkingFiles(source, input.working);
    captureWorkspaceFiles({
      workspaceRoot: source,
      destination: join(bundle, "workspace-files"),
      config: config({
        includes: Object.keys(input.working).length > 0 ? Object.keys(input.working) : ["**"],
      }),
    });
  }
  writeWorkspaceBundleEnvelope({
    bundleRoot: bundle,
    includeWorkspaceFiles: input.working !== undefined,
    observedEndSeq: 1,
  });
  return { root, bundle, source };
}

async function expectPublicationCaptureChanged(
  mutate: (input: Readonly<{ root: string; source: string; selected: string }>) => void,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "tweakloop-publication-capture-"));
  roots.push(root);
  const source = join(root, "source");
  const destination = join(root, "bundle");
  const selected = join(source, "selected.txt");
  mkdirSync(source);
  writeFileSync(selected, "stable\n");
  const ownershipNonce = "c".repeat(48);

  await expect(
    publishWorkspaceBundle({
      destination,
      operationId: "operation_capture_changed",
      ownershipNonce,
      capture: async (bundleRoot) => {
        writeCollaborationManifest(
          bundleRoot,
          collaborationManifest([{ path: "plan.md", bytes: "durable\n" }]),
        );
        const captured = captureWorkspaceFiles({
          workspaceRoot: source,
          destination: join(bundleRoot, "workspace-files"),
          config: config({ includes: ["**"], excludes: [] }),
        });
        mutate({ root, source, selected });
        return {
          includeWorkspaceFiles: true,
          observedEndSeq: 1,
          workspaceFilesVerification: captured.verification,
        };
      },
    }),
  ).rejects.toMatchObject({ code: "workspace-files.capture-changed" });
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(join(root, `.tweakloop-bundle-${ownershipNonce}`))).toBe(false);
}

describe("workspace file snapshots", () => {
  it("round-trips only explicit includes with hashes, modes, and exclusion receipts", () => {
    const paths = fixture();
    mkdirSync(join(paths.source, "src", "generated"), { recursive: true });
    writeFileSync(join(paths.source, "README.md"), "hello\n");
    writeFileSync(join(paths.source, "src", "main.ts"), "export const answer = 42;\n");
    writeFileSync(join(paths.source, "src", "generated", "ignored.ts"), "ignored\n");
    writeFileSync(join(paths.source, "notes.txt"), "not allowlisted\n");
    chmodSync(join(paths.source, "src", "main.ts"), 0o744);

    const captured = captureWorkspaceFiles({
      workspaceRoot: paths.source,
      destination: paths.snapshot,
      config: config(),
    });
    expect(captured.manifest.files.map((file) => file.path)).toEqual(["README.md", "src/main.ts"]);
    expect(captured.manifest.files.find((file) => file.path === "src/main.ts")?.mode).toBe(0o744);
    expect(captured.manifest.excluded).toContainEqual({
      path: "src/generated/**",
      reason: "configured",
    });
    expect(existsSync(join(paths.snapshot, WORKSPACE_FILES_MANIFEST_PATH))).toBe(true);

    const restored = restoreWorkspaceFiles({
      snapshotRoot: paths.snapshot,
      destination: paths.restored,
    });
    expect(restored.restored).toHaveLength(2);
    expect(readFileSync(join(paths.restored, "src", "main.ts"), "utf8")).toContain("answer");
    expect(existsSync(join(paths.restored, "src", "generated", "ignored.ts"))).toBe(false);
    expect(existsSync(join(paths.restored, "notes.txt"))).toBe(false);
  });

  it("captures duplicate content once while retaining both path descriptors", () => {
    const paths = fixture();
    mkdirSync(join(paths.source, "src"));
    writeFileSync(join(paths.source, "src", "first.txt"), "shared\n");
    writeFileSync(join(paths.source, "src", "second.txt"), "shared\n");
    const captured = captureWorkspaceFiles({
      workspaceRoot: paths.source,
      destination: paths.snapshot,
      config: config({ includes: ["src/**"] }),
    });
    expect(captured.manifest.files).toHaveLength(2);
    expect(new Set(captured.manifest.files.map((file) => file.hash)).size).toBe(1);
    restoreWorkspaceFiles({ snapshotRoot: paths.snapshot, destination: paths.restored });
    expect(readFileSync(join(paths.restored, "src", "first.txt"), "utf8")).toBe("shared\n");
    expect(readFileSync(join(paths.restored, "src", "second.txt"), "utf8")).toBe("shared\n");
  });

  it("rejects absolute and traversal config patterns", () => {
    expect(() => validateWorkspaceFilesConfig(config({ includes: ["../outside"] }))).toThrowError(
      expect.objectContaining({ code: "workspace-files.config-traversal" }),
    );
    expect(() => validateWorkspaceFilesConfig(config({ includes: ["/etc/**"] }))).toThrowError(
      expect.objectContaining({ code: "workspace-files.config-path" }),
    );
  });

  it("rejects symlinks instead of following them", () => {
    const paths = fixture();
    mkdirSync(join(paths.source, "src"));
    writeFileSync(join(paths.root, "outside.txt"), "outside secret\n");
    symlinkSync(join(paths.root, "outside.txt"), join(paths.source, "src", "linked.txt"));
    expect(() =>
      captureWorkspaceFiles({
        workspaceRoot: paths.source,
        destination: paths.snapshot,
        config: config({ includes: ["src/**"] }),
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.symlink-refused" }));
    expect(existsSync(paths.snapshot)).toBe(false);
  });

  it("excludes secret-default files from broad includes and records why", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "README.md"), "safe\n");
    writeFileSync(join(paths.source, ".env"), "TOKEN=secret\n");
    writeFileSync(join(paths.source, "deploy.key"), "secret\n");
    const captured = captureWorkspaceFiles({
      workspaceRoot: paths.source,
      destination: paths.snapshot,
      config: config({ includes: ["**"] }),
    });
    expect(captured.manifest.files.map((file) => file.path)).toEqual(["README.md"]);
    expect(captured.manifest.excluded).toEqual([
      { path: ".env", reason: "secret-default" },
      { path: "deploy.key", reason: "secret-default" },
    ]);
  });

  it("refuses an explicitly named secret-default file", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, ".env"), "TOKEN=secret\n");
    expect(() =>
      captureWorkspaceFiles({
        workspaceRoot: paths.source,
        destination: paths.snapshot,
        config: config({ includes: [".env"] }),
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.secret-explicitly-included" }));
  });

  it("verifies every object before creating the restored destination", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "README.md"), "original\n");
    const captured = captureWorkspaceFiles({
      workspaceRoot: paths.source,
      destination: paths.snapshot,
      config: config(),
    });
    const object = captured.manifest.files[0]?.objectPath;
    expect(object).toBeDefined();
    writeFileSync(join(paths.snapshot, ...(object as string).split("/")), "corrupt\n");
    expect(() =>
      restoreWorkspaceFiles({ snapshotRoot: paths.snapshot, destination: paths.restored }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.object-invalid" }));
    expect(existsSync(paths.restored)).toBe(false);
  });

  it("refuses to overwrite a non-empty destination", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "README.md"), "original\n");
    captureWorkspaceFiles({
      workspaceRoot: paths.source,
      destination: paths.snapshot,
      config: config(),
    });
    mkdirSync(paths.restored);
    writeFileSync(join(paths.restored, "owned.txt"), "keep\n");
    expect(() =>
      restoreWorkspaceFiles({ snapshotRoot: paths.snapshot, destination: paths.restored }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.destination-not-empty" }));
    expect(readFileSync(join(paths.restored, "owned.txt"), "utf8")).toBe("keep\n");
  });

  it("rejects a manifest object path that escapes the snapshot", () => {
    const paths = fixture();
    writeFileSync(join(paths.source, "README.md"), "original\n");
    captureWorkspaceFiles({
      workspaceRoot: paths.source,
      destination: paths.snapshot,
      config: config(),
    });
    const manifestPath = join(paths.snapshot, WORKSPACE_FILES_MANIFEST_PATH);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files[0].objectPath = "../outside";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() =>
      restoreWorkspaceFiles({ snapshotRoot: paths.snapshot, destination: paths.restored }),
    ).toThrowError(WorkspaceFilesError);
    expect(existsSync(paths.restored)).toBe(false);
  });

  for (const mask of [0o022, 0o077]) {
    it(`preserves the exact mode matrix with descriptor fchmod under umask ${mask.toString(8)}`, () => {
      const paths = fixture();
      const modes = [0o600, 0o644, 0o700, 0o755, 0o777];
      mkdirSync(join(paths.source, "modes"));
      for (const mode of modes) {
        const path = join(paths.source, "modes", `${mode.toString(8)}.txt`);
        writeFileSync(path, `${mode.toString(8)}\n`);
        chmodSync(path, mode);
      }
      const previous = process.umask(mask);
      try {
        captureWorkspaceFiles({
          workspaceRoot: paths.source,
          destination: paths.snapshot,
          config: config({ includes: ["modes/**"] }),
        });
        restoreWorkspaceFiles({ snapshotRoot: paths.snapshot, destination: paths.restored });
      } finally {
        process.umask(previous);
      }
      for (const mode of modes) {
        expect(
          statSync(join(paths.restored, "modes", `${mode.toString(8)}.txt`)).mode & 0o777,
        ).toBe(mode);
      }
    });
  }
});

describe("bound workspace bundles", () => {
  it("requires explicit migration for v1 envelope and file snapshot proof", () => {
    expect(() =>
      validateWorkspaceFilesManifest({ protocol: "tweakloop.workspace-file-snapshot/v1" }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.migration-required" }));

    const legacy = boundBundle({ durable: [{ path: "plan.md", bytes: "durable\n" }] });
    const envelopePath = join(legacy.bundle, WORKSPACE_BUNDLE_ENVELOPE_PATH);
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
    envelope.protocol = "tweakloop.workspace-bundle/v1";
    writeFileSync(envelopePath, JSON.stringify(envelope));
    expect(() => validateWorkspaceBundleEnvelope(legacy.bundle)).toThrowError(
      expect.objectContaining({ code: "workspace-bundle.migration-required" }),
    );
  });

  it("binds exact component bytes, source identity, capture checkpoint, and explicit absence", () => {
    const withFiles = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working\n" },
    });
    const validated = validateWorkspaceBundleEnvelope(withFiles.bundle);
    expect(validated.envelope).toMatchObject({
      bundleId: expect.stringMatching(/^bundle_[a-f0-9]{64}$/),
      source: { workspaceId: "workspace_source", projectId: "project_source", capturedSeq: 1 },
      capture: {
        collaboration: {
          capturedSeq: 1,
          observedEndSeq: 1,
          consistency: "event-seq-exact",
        },
        workspaceFiles: {
          consistency: "quiescent-verified",
          observation: "selected-closed-set/v1",
          startFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          endFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          publicationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      },
      workspaceFiles: {
        precedence: "workspace-files-over-durable-head",
        overlayVersion: 1,
      },
    });
    expect(validated.collaborationManifest.artifacts[0]?.artifactId).toBe("artifact_1");
    expect(validated.workspaceFilesManifest?.files[0]?.path).toBe("plan.md");

    const collaborationOnly = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
    });
    const withoutFiles = validateWorkspaceBundleEnvelope(collaborationOnly.bundle);
    expect(withoutFiles.envelope.workspaceFiles).toBeNull();
    expect(withoutFiles.workspaceFilesManifest).toBeNull();
  });

  it("rejects deleted, spliced, and byte-reformatted bound components", () => {
    const omitted = boundBundle({ durable: [{ path: "plan.md", bytes: "durable\n" }] });
    const envelopePath = join(omitted.bundle, WORKSPACE_BUNDLE_ENVELOPE_PATH);
    const envelope = JSON.parse(readFileSync(envelopePath, "utf8"));
    delete envelope.workspaceFiles;
    writeFileSync(envelopePath, JSON.stringify(envelope));
    expect(() => validateWorkspaceBundleEnvelope(omitted.bundle)).toThrowError(
      expect.objectContaining({ code: "workspace-bundle.workspace-files-binding-invalid" }),
    );

    const deleted = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working\n" },
    });
    rmSync(join(deleted.bundle, "workspace-files", WORKSPACE_FILES_MANIFEST_PATH));
    expect(() => validateWorkspaceBundleEnvelope(deleted.bundle)).toThrowError(
      expect.objectContaining({ code: "workspace-bundle.workspace-files-missing" }),
    );

    const first = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working-a\n" },
    });
    const second = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working-b\n" },
    });
    writeFileSync(
      join(first.bundle, "workspace-files", WORKSPACE_FILES_MANIFEST_PATH),
      readFileSync(join(second.bundle, "workspace-files", WORKSPACE_FILES_MANIFEST_PATH)),
    );
    expect(() => validateWorkspaceBundleEnvelope(first.bundle)).toThrowError(
      expect.objectContaining({ code: "workspace-bundle.workspace-files-manifest-mismatch" }),
    );

    const reformatted = boundBundle({ durable: [{ path: "plan.md", bytes: "durable\n" }] });
    const collaborationPath = join(reformatted.bundle, WORKSPACE_EXPORT_MANIFEST_PATH);
    writeFileSync(
      collaborationPath,
      JSON.stringify(JSON.parse(readFileSync(collaborationPath, "utf8"))),
    );
    expect(() => validateWorkspaceBundleEnvelope(reformatted.bundle)).toThrowError(
      expect.objectContaining({ code: "workspace-bundle.collaboration-manifest-mismatch" }),
    );
  });

  it("does not accept a present snapshot through an explicit workspaceFiles:null binding", () => {
    const bundle = boundBundle({ durable: [{ path: "plan.md", bytes: "durable\n" }] });
    mkdirSync(join(bundle.bundle, "workspace-files"));
    expect(() => validateWorkspaceBundleEnvelope(bundle.bundle)).toThrowError(
      expect.objectContaining({ code: "workspace-bundle.workspace-files-unbound" }),
    );
  });

  it("gives identical collaboration bytes and different working snapshots different bundle IDs", () => {
    const first = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working-a\n" },
    });
    const second = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working-b\n" },
    });
    expect(readFileSync(join(first.bundle, WORKSPACE_EXPORT_MANIFEST_PATH))).toEqual(
      readFileSync(join(second.bundle, WORKSPACE_EXPORT_MANIFEST_PATH)),
    );
    expect(validateWorkspaceBundleEnvelope(first.bundle).envelope.bundleId).not.toBe(
      validateWorkspaceBundleEnvelope(second.bundle).envelope.bundleId,
    );
  });

  it("rejects a collaboration checkpoint that advanced during file capture", () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-capture-advanced-"));
    roots.push(root);
    const bundle = join(root, "bundle");
    mkdirSync(bundle);
    writeCollaborationManifest(bundle, collaborationManifest([]));
    expect(() =>
      writeWorkspaceBundleEnvelope({
        bundleRoot: bundle,
        includeWorkspaceFiles: false,
        observedEndSeq: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-bundle.capture-advanced" }));
    expect(existsSync(join(bundle, WORKSPACE_BUNDLE_ENVELOPE_PATH))).toBe(false);
  });

  it("enforces one combined object-byte limit without allocating the declared payloads", () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-combined-limit-"));
    roots.push(root);
    const bundle = join(root, "bundle");
    mkdirSync(bundle);
    const collaboration = collaborationManifest([{ path: "plan.md", bytes: "durable\n" }]);
    const oversizedRevision = collaboration
      .revisions[0] as WorkspaceExportManifest["revisions"][number];
    writeCollaborationManifest(bundle, {
      ...collaboration,
      revisions: [
        {
          ...oversizedRevision,
          files: [
            { ...(oversizedRevision.files[0] as object), byteLength: 1_200_000_000 } as never,
          ],
        },
      ],
    });
    const workingHash = "b".repeat(64);
    const workspaceManifest = {
      protocol: WORKSPACE_FILES_SNAPSHOT_PROTOCOL,
      config: config({ includes: ["working.md"] }),
      files: [
        {
          path: "working.md",
          hash: workingHash,
          byteLength: 1_200_000_000,
          mode: 0o644,
          objectPath: `${WORKSPACE_EXPORT_OBJECT_PREFIX}/${workingHash}`,
        },
      ],
      excluded: [],
      totalBytes: 1_200_000_000,
      capture: {
        consistency: "quiescent-verified",
        observation: "selected-closed-set/v1",
        fingerprintAlgorithm: "sha256",
        observedFields: [
          "selected-path-membership",
          "exclusions",
          "entry-type",
          "file-identity",
          "bytes",
          "mode",
        ],
        startFingerprint: "a".repeat(64),
        endFingerprint: "a".repeat(64),
      },
    };
    const workspaceManifestPath = join(bundle, "workspace-files", WORKSPACE_FILES_MANIFEST_PATH);
    mkdirSync(join(workspaceManifestPath, ".."), { recursive: true });
    writeFileSync(workspaceManifestPath, JSON.stringify(workspaceManifest));
    expect(() =>
      writeWorkspaceBundleEnvelope({
        bundleRoot: bundle,
        includeWorkspaceFiles: true,
        observedEndSeq: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-bundle.total-too-large" }));
  });
});

describe("workspace bundle publication", () => {
  it("publishes a stable quiescent-verified closed set with matching boundary fingerprints", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-stable-capture-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "bundle");
    mkdirSync(source);
    writeFileSync(join(source, "selected.txt"), "stable\n");

    const published = await publishWorkspaceBundle({
      destination,
      operationId: "operation_stable_capture",
      ownershipNonce: "b".repeat(48),
      capture: async (bundleRoot) => {
        writeCollaborationManifest(
          bundleRoot,
          collaborationManifest([{ path: "plan.md", bytes: "durable\n" }]),
        );
        const captured = captureWorkspaceFiles({
          workspaceRoot: source,
          destination: join(bundleRoot, "workspace-files"),
          config: config({ includes: ["**"], excludes: [] }),
        });
        return {
          includeWorkspaceFiles: true,
          observedEndSeq: 1,
          workspaceFilesVerification: captured.verification,
        };
      },
    });

    const boundary = published.envelope.capture.workspaceFiles;
    expect(boundary).toMatchObject({
      consistency: "quiescent-verified",
      observation: "selected-closed-set/v1",
    });
    expect(boundary?.startFingerprint).toBe(boundary?.endFingerprint);
    expect(boundary?.endFingerprint).toBe(boundary?.publicationFingerprint);
    expect(validateWorkspaceBundleEnvelope(destination).envelope.bundleId).toBe(
      published.envelope.bundleId,
    );
  });

  it("rejects a selected path added after component capture without publishing", async () => {
    await expectPublicationCaptureChanged(({ source }) => {
      writeFileSync(join(source, "added.txt"), "added\n");
    });
  });

  it("rejects a selected path removed after component capture without publishing", async () => {
    await expectPublicationCaptureChanged(({ selected }) => {
      rmSync(selected);
    });
  });

  it("rejects a mode-only change after component capture without publishing", async () => {
    await expectPublicationCaptureChanged(({ selected }) => {
      chmodSync(selected, 0o700);
    });
  });

  it("rejects a symlink substitution after component capture without publishing", async () => {
    await expectPublicationCaptureChanged(({ root, selected }) => {
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "outside\n");
      rmSync(selected);
      symlinkSync(outside, selected);
    });
  });

  it("documents the ABA ceiling: restored bytes, mode, and inode remain indistinguishable", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-aba-capture-"));
    roots.push(root);
    const source = join(root, "source");
    const destination = join(root, "bundle");
    const selected = join(source, "selected.txt");
    mkdirSync(source);
    writeFileSync(selected, "before\n");
    chmodSync(selected, 0o640);
    const originalInode = statSync(selected).ino;

    const published = await publishWorkspaceBundle({
      destination,
      operationId: "operation_aba_capture",
      ownershipNonce: "d".repeat(48),
      capture: async (bundleRoot) => {
        writeCollaborationManifest(
          bundleRoot,
          collaborationManifest([{ path: "plan.md", bytes: "durable\n" }]),
        );
        const captured = captureWorkspaceFiles({
          workspaceRoot: source,
          destination: join(bundleRoot, "workspace-files"),
          config: config({ includes: ["selected.txt"], excludes: [] }),
        });
        writeFileSync(selected, "temporary\n");
        chmodSync(selected, 0o700);
        writeFileSync(selected, "before\n");
        chmodSync(selected, 0o640);
        return {
          includeWorkspaceFiles: true,
          observedEndSeq: 1,
          workspaceFilesVerification: captured.verification,
        };
      },
    });

    expect(statSync(selected).ino).toBe(originalInode);
    expect(readFileSync(selected, "utf8")).toBe("before\n");
    expect(statSync(selected).mode & 0o777).toBe(0o640);
    expect(published.envelope.capture.workspaceFiles?.consistency).toBe("quiescent-verified");
  });

  it("leaves no final bundle or nonce-owned staging when component capture fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-bundle-publish-"));
    roots.push(root);
    const destination = join(root, "saved");
    await expect(
      publishWorkspaceBundle({
        destination,
        operationId: "export-failure",
        ownershipNonce: "a".repeat(32),
        capture: async (bundleRoot) => {
          writeCollaborationManifest(bundleRoot, collaborationManifest([]));
          throw new Error("forced file capture failure");
        },
      }),
    ).rejects.toThrow("forced file capture failure");
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(root, `.tweakloop-bundle-${"a".repeat(32)}`))).toBe(false);
  });

  it("publishes nothing when the workspace advances after collaboration capture", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-bundle-publish-"));
    roots.push(root);
    const destination = join(root, "saved");
    const nonce = "7".repeat(32);
    await expect(
      publishWorkspaceBundle({
        destination,
        operationId: "export-advanced",
        ownershipNonce: nonce,
        capture: async (bundleRoot) => {
          writeCollaborationManifest(bundleRoot, collaborationManifest([]));
          return { includeWorkspaceFiles: false, observedEndSeq: 2 };
        },
      }),
    ).rejects.toMatchObject({ code: "workspace-bundle.capture-advanced" });
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(root, `.tweakloop-bundle-${nonce}`))).toBe(false);
  });

  it("refuses a symlink introduced into the private export stage before publication", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-bundle-publish-"));
    roots.push(root);
    const destination = join(root, "saved");
    const nonce = "4".repeat(32);
    writeFileSync(join(root, "outside.txt"), "outside\n");
    await expect(
      publishWorkspaceBundle({
        destination,
        operationId: "export-stage-symlink",
        ownershipNonce: nonce,
        capture: async (bundleRoot) => {
          writeCollaborationManifest(bundleRoot, collaborationManifest([]));
          symlinkSync(join(root, "outside.txt"), join(bundleRoot, "linked.txt"));
          return { includeWorkspaceFiles: false, observedEndSeq: 1 };
        },
      }),
    ).rejects.toMatchObject({ code: "workspace-bundle.stage-symlink" });
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(root, `.tweakloop-bundle-${nonce}`))).toBe(false);
  });

  it("publishes one envelope-valid destination and removes its staging claim", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-bundle-publish-"));
    roots.push(root);
    const destination = join(root, "saved");
    const result = await publishWorkspaceBundle({
      destination,
      operationId: "export-success",
      ownershipNonce: "b".repeat(32),
      capture: async (bundleRoot) => {
        writeCollaborationManifest(bundleRoot, collaborationManifest([]));
        return { includeWorkspaceFiles: false, observedEndSeq: 1 };
      },
    });
    expect(result.destination).toBe(destination);
    expect(validateWorkspaceBundleEnvelope(destination).envelope.bundleId).toBe(
      result.envelope.bundleId,
    );
    expect(existsSync(join(root, `.tweakloop-bundle-${"b".repeat(32)}`))).toBe(false);
  });

  it("preserves an existing destination byte-for-byte and refuses target appearance", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-bundle-publish-"));
    roots.push(root);
    const destination = join(root, "saved");
    mkdirSync(destination);
    writeFileSync(join(destination, "owned.txt"), "keep\n");
    await expect(
      publishWorkspaceBundle({
        destination,
        operationId: "export-existing",
        ownershipNonce: "c".repeat(32),
        capture: async () => ({ includeWorkspaceFiles: false, observedEndSeq: 1 }),
      }),
    ).rejects.toMatchObject({ code: "workspace-bundle.destination-exists" });
    expect(readFileSync(join(destination, "owned.txt"), "utf8")).toBe("keep\n");

    rmSync(destination, { recursive: true });
    await expect(
      publishWorkspaceBundle({
        destination,
        operationId: "export-race",
        ownershipNonce: "d".repeat(32),
        capture: async (bundleRoot) => {
          writeCollaborationManifest(bundleRoot, collaborationManifest([]));
          mkdirSync(destination);
          writeFileSync(join(destination, "racer.txt"), "racer\n");
          return { includeWorkspaceFiles: false, observedEndSeq: 1 };
        },
      }),
    ).rejects.toMatchObject({ code: "workspace-bundle.destination-appeared" });
    expect(readFileSync(join(destination, "racer.txt"), "utf8")).toBe("racer\n");
    expect(existsSync(join(root, `.tweakloop-bundle-${"d".repeat(32)}`))).toBe(false);
  });

  it("refuses to delete a staging path whose claimed inode was replaced", async () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-bundle-publish-"));
    roots.push(root);
    const destination = join(root, "saved");
    const nonce = "9".repeat(32);
    const claimRoot = join(root, `.tweakloop-bundle-${nonce}`);
    const displaced = join(root, "displaced-owned-stage");
    await expect(
      publishWorkspaceBundle({
        destination,
        operationId: "export-stage-swap",
        ownershipNonce: nonce,
        capture: async (bundleRoot) => {
          writeCollaborationManifest(bundleRoot, collaborationManifest([]));
          renameSync(claimRoot, displaced);
          mkdirSync(claimRoot);
          writeFileSync(join(claimRoot, "replacement.txt"), "do not delete\n");
          return { includeWorkspaceFiles: false, observedEndSeq: 1 };
        },
      }),
    ).rejects.toMatchObject({ code: "workspace-bundle.cleanup-ownership-lost" });
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(join(claimRoot, "replacement.txt"), "utf8")).toBe("do not delete\n");
    expect(existsSync(displaced)).toBe(true);
  });
});

describe("workspace overlay planning and private staging", () => {
  it("classifies the full base/working matrix and gives working bytes explicit staged precedence", () => {
    const bundle = boundBundle({
      durable: [
        { path: "plan.md", bytes: "durable plan\n" },
        { path: "same.md", bytes: "same\n" },
        { path: "durable-only.md", bytes: "durable only\n" },
      ],
      working: {
        "plan.md": "working plan\n",
        "same.md": "same\n",
        "untracked.md": "untracked\n",
      },
    });
    const validated = validateWorkspaceBundleEnvelope(bundle.bundle);
    const plan = planWorkspaceFilesOverlay(validated);
    expect(Object.fromEntries(plan.entries.map((entry) => [entry.path, entry.state]))).toEqual({
      "durable-only.md": "durable-only",
      "plan.md": "modified",
      "same.md": "clean",
      "untracked.md": "untracked",
    });
    expect(plan.entries.find((entry) => entry.path === "plan.md")).toMatchObject({
      artifactId: "artifact_1",
      revisionId: "revision_1",
      baseHash: sha("durable plan\n"),
      workingHash: sha("working plan\n"),
    });

    const stagedRoot = join(bundle.root, "combined-stage");
    mkdirSync(stagedRoot);
    for (const entry of [
      ["plan.md", "durable plan\n"],
      ["same.md", "same\n"],
      ["durable-only.md", "durable only\n"],
    ] as const) {
      writeFileSync(join(stagedRoot, entry[0]), entry[1]);
    }
    expect(() =>
      stageWorkspaceFilesOverlay({
        snapshotRoot: join(bundle.bundle, "workspace-files"),
        stagedRoot,
        plan: {
          ...plan,
          entries: plan.entries.filter((entry) => entry.path !== "untracked.md"),
        },
        operationId: "fork-overlay-omitted",
        ownershipNonce: "6".repeat(32),
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.overlay-plan-incomplete" }));
    const staged = stageWorkspaceFilesOverlay({
      snapshotRoot: join(bundle.bundle, "workspace-files"),
      stagedRoot,
      plan,
      operationId: "fork-overlay",
      ownershipNonce: "e".repeat(32),
    });
    expect(staged.entries).toEqual(plan.entries);
    expect(readFileSync(join(stagedRoot, "plan.md"), "utf8")).toBe("working plan\n");
    expect(readFileSync(join(stagedRoot, "same.md"), "utf8")).toBe("same\n");
    expect(readFileSync(join(stagedRoot, "durable-only.md"), "utf8")).toBe("durable only\n");
    expect(readFileSync(join(stagedRoot, "untracked.md"), "utf8")).toBe("untracked\n");
    expect(validated.collaborationManifest.revisions[0]?.entryHash).toBe(sha("durable plan\n"));

    const retried = stageWorkspaceFilesOverlay({
      snapshotRoot: join(bundle.bundle, "workspace-files"),
      stagedRoot,
      plan,
      operationId: "fork-overlay",
      ownershipNonce: "e".repeat(32),
    });
    expect(retried.installed).toBe(0);
    expect(retried.unchanged).toBe(3);
    expect(readFileSync(join(stagedRoot, "plan.md"), "utf8")).toBe("working plan\n");
  });

  it("rejects prefix, case-fold, NFC, and reserved cross-rail collisions before staging", () => {
    const base = boundBundle({
      durable: [{ path: "durable.md", bytes: "durable\n" }],
      working: { "working.md": "working\n" },
    });
    const validated = validateWorkspaceBundleEnvelope(base.bundle);
    const cases = [
      { durable: "a", working: "a/b", code: "workspace-files.overlay-prefix-collision" },
      {
        durable: "Plan.md",
        working: "plan.md",
        code: "workspace-files.overlay-normalized-collision",
      },
      {
        durable: "caf\u00e9.md",
        working: "cafe\u0301.md",
        code: "workspace-files.overlay-normalized-collision",
      },
      {
        durable: "durable.md",
        working: ".tweakloop/artifacts/artifact_1/working.md",
        code: "workspace-files.overlay-reserved-path",
      },
    ];
    for (const candidate of cases) {
      const collaboration = validated.collaborationManifest;
      const workspaceFiles = validated.workspaceFilesManifest;
      expect(workspaceFiles).not.toBeNull();
      const changed = {
        ...validated,
        collaborationManifest: {
          ...collaboration,
          artifacts: [
            { ...(collaboration.artifacts[0] as object), exportedPath: candidate.durable },
          ],
        } as WorkspaceExportManifest,
        workspaceFilesManifest: {
          ...(workspaceFiles as NonNullable<typeof workspaceFiles>),
          files: [
            {
              ...((workspaceFiles as NonNullable<typeof workspaceFiles>).files[0] as object),
              path: candidate.working,
            },
          ],
        } as NonNullable<typeof workspaceFiles>,
      };
      expect(() => planWorkspaceFilesOverlay(changed)).toThrowError(
        expect.objectContaining({ code: candidate.code }),
      );
    }
  });

  it("accepts only the collaboration manifest's exact exporter-owned artifact fallback", () => {
    const artifactId = "artifact_browser_only";
    const exportedPath = `.tweakloop/artifacts/${artifactId}/human-selected-design.html`;
    const bundle = boundBundle({
      durable: [{ path: exportedPath, bytes: "<main>portable</main>\n", artifactId }],
    });
    const validated = validateWorkspaceBundleEnvelope(bundle.bundle);

    expect(planWorkspaceFilesOverlay(validated).entries).toEqual([
      expect.objectContaining({
        path: exportedPath,
        state: "durable-only",
        artifactId,
        workingHash: null,
      }),
    ]);

    const mismatched = {
      ...validated,
      collaborationManifest: {
        ...validated.collaborationManifest,
        artifacts: validated.collaborationManifest.artifacts.map((artifact) => ({
          ...artifact,
          exportedPath: ".tweakloop/artifacts/artifact_alien/human-selected-design.html",
        })),
      } as WorkspaceExportManifest,
    };
    expect(() => planWorkspaceFilesOverlay(mismatched)).toThrowError(
      expect.objectContaining({ code: "workspace-files.overlay-reserved-path" }),
    );
  });

  it("rehashes a private source copy and leaves the combined stage untouched after source corruption", () => {
    const bundle = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working\n", "untracked.md": "untracked\n" },
    });
    const validated = validateWorkspaceBundleEnvelope(bundle.bundle);
    const plan = planWorkspaceFilesOverlay(validated);
    const corrupted = validated.workspaceFilesManifest?.files.find(
      (file) => file.path === "untracked.md",
    );
    expect(corrupted).toBeDefined();
    writeFileSync(
      join(
        bundle.bundle,
        "workspace-files",
        ...(corrupted as { objectPath: string }).objectPath.split("/"),
      ),
      "corrupt\n",
    );
    const stagedRoot = join(bundle.root, "combined-stage");
    mkdirSync(stagedRoot);
    writeFileSync(join(stagedRoot, "plan.md"), "durable\n");
    expect(() =>
      stageWorkspaceFilesOverlay({
        snapshotRoot: join(bundle.bundle, "workspace-files"),
        stagedRoot,
        plan,
        operationId: "fork-corrupt",
        ownershipNonce: "f".repeat(32),
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.object-invalid" }));
    expect(readFileSync(join(stagedRoot, "plan.md"), "utf8")).toBe("durable\n");
    expect(existsSync(join(stagedRoot, "untracked.md"))).toBe(false);
    expect(existsSync(join(bundle.root, `.tweakloop-workspace-stage-${"f".repeat(32)}`))).toBe(
      false,
    );
  });

  it("rejects a workspace manifest changed after envelope validation before staging bytes", () => {
    const bundle = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working\n" },
    });
    const validated = validateWorkspaceBundleEnvelope(bundle.bundle);
    const plan = planWorkspaceFilesOverlay(validated);
    const manifestPath = join(bundle.bundle, "workspace-files", WORKSPACE_FILES_MANIFEST_PATH);
    writeFileSync(manifestPath, JSON.stringify(JSON.parse(readFileSync(manifestPath, "utf8"))));
    const stagedRoot = join(bundle.root, "combined-stage");
    mkdirSync(stagedRoot);
    writeFileSync(join(stagedRoot, "plan.md"), "durable\n");
    expect(() =>
      stageWorkspaceFilesOverlay({
        snapshotRoot: join(bundle.bundle, "workspace-files"),
        stagedRoot,
        plan,
        operationId: "fork-manifest-swap",
        ownershipNonce: "5".repeat(32),
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.overlay-manifest-mismatch" }));
    expect(readFileSync(join(stagedRoot, "plan.md"), "utf8")).toBe("durable\n");
  });

  it("rejects a swapped workspace-object ancestor before touching the combined stage", () => {
    const bundle = boundBundle({
      durable: [{ path: "plan.md", bytes: "durable\n" }],
      working: { "plan.md": "working\n" },
    });
    const validated = validateWorkspaceBundleEnvelope(bundle.bundle);
    const plan = planWorkspaceFilesOverlay(validated);
    const descriptor = validated.workspaceFilesManifest?.files[0];
    expect(descriptor).toBeDefined();
    const objectsDirectory = join(bundle.bundle, "workspace-files", ".tweakloop", "objects");
    const replacement = join(bundle.root, "replacement-objects");
    rmSync(objectsDirectory, { recursive: true });
    mkdirSync(join(replacement, "sha256"), { recursive: true });
    writeFileSync(join(replacement, "sha256", descriptor?.hash as string), "working\n");
    symlinkSync(replacement, objectsDirectory);

    const stagedRoot = join(bundle.root, "combined-stage");
    mkdirSync(stagedRoot);
    writeFileSync(join(stagedRoot, "plan.md"), "durable\n");
    expect(() =>
      stageWorkspaceFilesOverlay({
        snapshotRoot: join(bundle.bundle, "workspace-files"),
        stagedRoot,
        plan,
        operationId: "fork-source-swap",
        ownershipNonce: "8".repeat(32),
      }),
    ).toThrowError(expect.objectContaining({ code: "workspace-files.symlink-refused" }));
    expect(readFileSync(join(stagedRoot, "plan.md"), "utf8")).toBe("durable\n");
  });
});
