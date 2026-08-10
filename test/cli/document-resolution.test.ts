import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDocumentReference } from "../../src/cli/document-resolution.js";

const root = "/workspace";
const temporaryRoots: string[] = [];
const daemonControls = vi.hoisted(() => ({
  snapshot: null as unknown,
  command: null as unknown,
}));

vi.mock("../../src/cli/daemon-client.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    discoverDaemon: async () => ({
      baseUrl: "http://127.0.0.1:1",
      token: "document-alias-test-token",
      descriptor: { workspaceId: "ws_document_alias_test" },
    }),
    getSnapshot: async () => daemonControls.snapshot,
    postCommand: async (_connection: unknown, command: unknown) => {
      daemonControls.command = command;
      return { status: "accepted", response: { messageId: "message_document_alias_test" } };
    },
  };
});

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function pathAliasFixture() {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "tweakloop-document-alias-"));
  temporaryRoots.push(temporaryRoot);
  let aliasRoot = temporaryRoot;
  let canonicalRoot = realpathSync(temporaryRoot);
  if (aliasRoot === canonicalRoot) {
    canonicalRoot = join(temporaryRoot, "canonical");
    aliasRoot = join(temporaryRoot, "alias");
    mkdirSync(canonicalRoot);
    symlinkSync(canonicalRoot, aliasRoot, "dir");
  }
  expect(aliasRoot).not.toBe(canonicalRoot);
  const canonicalWorkspace = join(canonicalRoot, "workspace");
  const aliasWorkspace = join(aliasRoot, "workspace");
  mkdirSync(join(canonicalWorkspace, "plans"), { recursive: true });
  mkdirSync(join(canonicalWorkspace, "neighbor"), { recursive: true });
  const canonicalDocument = join(canonicalWorkspace, "plans", "design.html");
  const aliasDocument = join(aliasWorkspace, "plans", "design.html");
  const wrongNeighbor = join(aliasWorkspace, "neighbor", "design.html");
  const finalFileSymlink = join(aliasWorkspace, "plans", "design-link.html");
  writeFileSync(canonicalDocument, "registered\n");
  writeFileSync(wrongNeighbor, "different\n");
  symlinkSync(canonicalDocument, finalFileSymlink, "file");
  return {
    aliasWorkspace,
    canonicalDocument,
    aliasDocument,
    wrongNeighbor,
    finalFileSymlink,
  };
}

describe("typed document resolution", () => {
  it("returns only an exact missing path as unregistered", () => {
    expect(resolveDocumentReference([], "plans/new.html", root)).toEqual({
      status: "unregistered",
      absolutePath: resolve(root, "plans/new.html"),
    });
  });

  it("resolves registered identity and registered source path", () => {
    const artifacts = [{ artifactId: "artifact_1", sourcePath: "/workspace/plans/a.html" }];
    expect(resolveDocumentReference(artifacts, "artifact_1", root)).toMatchObject({
      status: "registered",
      artifactId: "artifact_1",
    });
    expect(resolveDocumentReference(artifacts, "plans/a.html", root)).toMatchObject({
      status: "registered",
      artifactId: "artifact_1",
    });
  });

  it("resolves parent path aliases without accepting a same-basename neighbor", () => {
    const fixture = pathAliasFixture();
    const artifacts = [{ artifactId: "artifact_alias", sourcePath: fixture.canonicalDocument }];

    expect(
      resolveDocumentReference(artifacts, fixture.canonicalDocument, fixture.aliasWorkspace),
    ).toMatchObject({ status: "registered", artifactId: "artifact_alias" });
    expect(
      resolveDocumentReference(artifacts, fixture.aliasDocument, fixture.aliasWorkspace),
    ).toMatchObject({ status: "registered", artifactId: "artifact_alias" });
    expect(
      resolveDocumentReference(artifacts, fixture.wrongNeighbor, fixture.aliasWorkspace),
    ).toEqual({
      status: "unregistered",
      absolutePath: fixture.wrongNeighbor,
    });
    expect(
      resolveDocumentReference(artifacts, fixture.finalFileSymlink, fixture.aliasWorkspace),
    ).toEqual({
      status: "unregistered",
      absolutePath: fixture.finalFileSymlink,
    });
  });

  it("routes chat send --document parent aliases through the shared resolver", async () => {
    const fixture = pathAliasFixture();
    daemonControls.snapshot = {
      artifacts: [
        {
          artifactId: "artifact_alias",
          name: "design.html",
          format: "html",
          sourcePath: fixture.canonicalDocument,
        },
      ],
      revisions: [],
      intents: [],
      work: [],
      chat: [],
    };
    daemonControls.command = null;

    const priorArgv = process.argv;
    const priorExitCode = process.exitCode;
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    process.argv = [
      process.execPath,
      "tweak",
      "--workspace",
      fixture.aliasWorkspace,
      "--json",
      "chat",
      "send",
      "path alias check",
      "--agent",
      "codex",
      "--document",
      fixture.aliasDocument,
    ];
    try {
      await import("../../src/cli/index.js");
    } finally {
      process.argv = priorArgv;
      process.exitCode = priorExitCode;
      output.mockRestore();
    }

    expect(daemonControls.command).toMatchObject({
      workspaceId: "ws_document_alias_test",
      type: "chat.send",
      actor: { kind: "agent", id: "codex" },
      payload: {
        artifactId: null,
        text: "path alias check",
        mentions: ["artifact_alias"],
        references: [
          {
            kind: "document",
            label: "design.html",
            artifactId: "artifact_alias",
          },
        ],
      },
    });
  });

  it("keeps ambiguous, corrupt, and invalid states distinct from absence", () => {
    expect(
      resolveDocumentReference(
        [
          { artifactId: "artifact_1", sourcePath: "/workspace/plans/a.html" },
          { artifactId: "artifact_2", sourcePath: "/workspace/plans/a.html" },
        ],
        "plans/a.html",
        root,
      ),
    ).toMatchObject({ status: "ambiguous", matchCount: 2 });

    expect(
      resolveDocumentReference(
        [
          { artifactId: "artifact_1", sourcePath: "/workspace/plans/a.html" },
          { artifactId: "artifact_1", sourcePath: "/workspace/plans/b.html" },
        ],
        "artifact_1",
        root,
      ),
    ).toMatchObject({ status: "corrupt" });

    expect(resolveDocumentReference([], "../outside.html", root)).toMatchObject({
      status: "path-invalid",
    });
    expect(resolveDocumentReference([], "artifact_missing", root)).toMatchObject({
      status: "path-invalid",
    });
  });

  it("rejects malformed registry rows instead of manufacturing empty success", () => {
    expect(
      resolveDocumentReference(
        [{ artifactId: "artifact_1", sourcePath: "relative/source.html" }],
        "plans/new.html",
        root,
      ),
    ).toMatchObject({ status: "corrupt" });
  });
});
