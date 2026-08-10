import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  derivePublishCompleteContext,
  publishAndComplete,
} from "../../src/cli/publish-complete.js";
import type { CommandResult } from "../../src/protocol/envelopes.js";
import type { Snapshot } from "../../src/protocol/snapshot.js";

const invocation = {
  prefix: ["/opt/node bin/node", "/repo with spaces/dist/cli/index.js"],
  source: "local-node" as const,
};

describe("publish --complete composition", () => {
  it("derives exact claim/session/agent/artifact and completes with only the returned revision", async () => {
    const snapshot = fixtureSnapshot();
    const publish = vi.fn(async () => ({
      artifactId: "artifact_a",
      revisionId: "rev_returned",
      seq: 12,
      unchanged: false,
    }));
    const complete = vi.fn(
      async (_context, published): Promise<CommandResult> => ({
        status: "accepted",
        commandId: "command_1",
        firstEventSeq: 13,
        lastEventSeq: 13,
        response: { workId: "work_1", status: "addressed", revisionId: published.revisionId },
      }),
    );

    await expect(
      publishAndComplete(
        {
          snapshot,
          path: "/workspace/plan.md",
          rootPath: "/workspace",
          workId: "work_1",
          summary: "done",
          invocation,
        },
        { publish, complete },
      ),
    ).resolves.toEqual({
      kind: "completed",
      receipt: {
        artifactId: "artifact_a",
        revisionId: "rev_returned",
        seq: 12,
        unchanged: false,
        workId: "work_1",
        status: "addressed",
      },
    });
    expect(publish).toHaveBeenCalledWith({
      workId: "work_1",
      artifactId: "artifact_a",
      baseRevisionId: "rev_base",
      sessionId: "session_1",
      claimId: "claim_1",
      agentId: "agent_1",
    });
    expect(complete.mock.calls[0]?.[1].revisionId).toBe("rev_returned");
  });

  it("rejects a different artifact path before calling publish", async () => {
    const publish = vi.fn();
    const complete = vi.fn();
    await expect(
      publishAndComplete(
        {
          snapshot: fixtureSnapshot(),
          path: "/workspace/other.md",
          rootPath: "/workspace",
          workId: "work_1",
          summary: "done",
          invocation,
        },
        { publish, complete },
      ),
    ).rejects.toThrow(/^publish-complete\.artifact-mismatch:/);
    expect(publish).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("does not attempt completion when publication fails", async () => {
    const complete = vi.fn();
    await expect(
      publishAndComplete(
        {
          snapshot: fixtureSnapshot(),
          path: "/workspace/plan.md",
          rootPath: "/workspace",
          workId: "work_1",
          summary: "done",
          invocation,
        },
        {
          publish: async () => {
            throw new Error("publish rejected");
          },
          complete,
        },
      ),
    ).rejects.toThrow("publish rejected");
    expect(complete).not.toHaveBeenCalled();
  });

  it("publishes imported bytes through the exact work artifact and session identity", () => {
    const base = fixtureSnapshot();
    const snapshot: Snapshot = {
      ...base,
      artifacts: base.artifacts.map((artifact) => ({ ...artifact, sourcePath: null })),
    };
    expect(derivePublishCompleteContext(snapshot, "work_1", "/tmp/imported.md")).toMatchObject({
      artifactId: "artifact_a",
      sessionId: "session_1",
    });
  });

  it("executes stale-claim recovery as a read-only current-identity inspection", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tweakloop-stale-recovery-"));
    const statePath = join(directory, "state.json");
    const runnerPath = join(directory, "inspect.mjs");
    const staleState = {
      work: [{ workId: "work_1", status: "claimed", claimId: "claim_1" }],
      effects: [],
    };
    const currentState = {
      work: [{ workId: "work_1", status: "claimed", claimId: "claim_current" }],
      effects: [],
    };
    writeFileSync(statePath, JSON.stringify(staleState));
    writeFileSync(
      runnerPath,
      [
        'import { readFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        `const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));`,
        'const workId = args[args.indexOf("--work") + 1];',
        "const work = state.work.find((item) => item.workId === workId);",
        'process.stdout.write(JSON.stringify({ args, work, effects: state.effects }) + "\\n");',
      ].join("\n"),
    );

    try {
      const result = await publishAndComplete(
        {
          snapshot: fixtureSnapshot(),
          path: "/workspace/plan.md",
          rootPath: "/workspace with spaces",
          workId: "work_1",
          summary: "fixed user's request",
          intentIds: ["intent_1"],
          invocation: { prefix: [process.execPath, runnerPath], source: "local-node" },
        },
        {
          publish: async () => ({
            artifactId: "artifact_a",
            revisionId: "rev_published",
            seq: 12,
            unchanged: false,
          }),
          complete: async () => {
            writeFileSync(statePath, JSON.stringify(currentState));
            return {
              status: "rejected",
              commandId: "command_1",
              code: "work.stale-claim",
              message: "claim changed",
            };
          },
        },
      );
      expect(result).toMatchObject({
        kind: "partial",
        code: "publish-complete.partial",
        receipt: { revisionId: "rev_published", status: "published" },
        recoveryKind: "inspect-current-work",
      });
      if (result.kind !== "partial") throw new Error("expected partial");
      expect(result.recoveryCommand).toContain("'work' 'list'");
      expect(result.recoveryCommand).toContain("'--work' 'work_1'");
      expect(result.recoveryCommand).toContain("'--status' 'all'");
      expect(result.recoveryCommand).not.toContain("claim_1");
      expect(result.recoveryCommand).not.toContain("work' 'complete");

      const beforeRecovery = readFileSync(statePath, "utf8");
      const inspected = JSON.parse(execSync(result.recoveryCommand, { encoding: "utf8" })) as {
        args: string[];
        work: { workId: string; claimId: string };
        effects: unknown[];
      };
      expect(inspected.args).toEqual([
        "--workspace",
        "/workspace with spaces",
        "work",
        "list",
        "--work",
        "work_1",
        "--status",
        "all",
        "--json",
      ]);
      expect(inspected.work).toEqual({
        workId: "work_1",
        status: "claimed",
        claimId: "claim_current",
      });
      expect(inspected.effects).toEqual([]);
      expect(readFileSync(statePath, "utf8")).toBe(beforeRecovery);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps a shell-safe direct completion retry for non-stale rejection", async () => {
    const result = await publishAndComplete(
      {
        snapshot: fixtureSnapshot(),
        path: "/workspace/plan.md",
        rootPath: "/workspace with spaces",
        workId: "work_1",
        summary: "fixed user's request",
        intentIds: ["intent_1"],
        invocation,
      },
      {
        publish: async () => ({
          artifactId: "artifact_a",
          revisionId: "rev_published",
          seq: 12,
          unchanged: false,
        }),
        complete: async () => ({
          status: "rejected",
          commandId: "command_1",
          code: "work.intent-coverage",
          message: "intent set incomplete",
        }),
      },
    );
    expect(result).toMatchObject({
      kind: "partial",
      receipt: { revisionId: "rev_published", status: "published" },
      recoveryKind: "retry-completion",
    });
    if (result.kind !== "partial") throw new Error("expected partial");
    expect(result.recoveryCommand).toContain("'/opt/node bin/node'");
    expect(result.recoveryCommand).toContain("'--revision-id' 'rev_published'");
    expect(result.recoveryCommand).toContain("'fixed user'\"'\"'s request'");
  });

  it("does not complete unchanged bytes at the reviewed base", async () => {
    const complete = vi.fn();
    const result = await publishAndComplete(
      {
        snapshot: fixtureSnapshot(),
        path: "/workspace/plan.md",
        rootPath: "/workspace",
        workId: "work_1",
        summary: "no artifact change required",
        invocation,
      },
      {
        publish: async () => ({
          artifactId: "artifact_a",
          revisionId: "rev_base",
          seq: 4,
          unchanged: true,
        }),
        complete,
      },
    );
    expect(result).toMatchObject({
      kind: "unchanged-base",
      code: "publish-complete.unchanged-base",
      receipt: { unchanged: true, status: "claimed" },
      recoveryKind: "retry-completion",
    });
    if (result.kind !== "unchanged-base") throw new Error("expected unchanged base");
    expect(result.recoveryCommand).not.toContain("--revision-id");
    expect(complete).not.toHaveBeenCalled();
  });

  it("reuses an unchanged descendant after a partial failure instead of publishing another fact", async () => {
    const complete = vi.fn(
      async (): Promise<CommandResult> => ({
        status: "accepted",
        commandId: "command_retry",
        firstEventSeq: 20,
        lastEventSeq: 20,
        response: { workId: "work_1", status: "addressed" },
      }),
    );
    const result = await publishAndComplete(
      {
        snapshot: fixtureSnapshot(),
        path: "/workspace/plan.md",
        rootPath: "/workspace",
        workId: "work_1",
        summary: "done",
        invocation,
      },
      {
        publish: async () => ({
          artifactId: "artifact_a",
          revisionId: "rev_existing_descendant",
          seq: 12,
          unchanged: true,
        }),
        complete,
      },
    );
    expect(result).toMatchObject({
      kind: "completed",
      receipt: { revisionId: "rev_existing_descendant", unchanged: true },
    });
    expect(complete.mock.calls[0]?.[1].revisionId).toBe("rev_existing_descendant");
  });
});

function fixtureSnapshot(): Snapshot {
  return {
    protocol: "tweakloop.snapshot/v1",
    workspace: {
      workspaceId: "workspace_1",
      projectId: "project_1",
      rootPath: "/workspace",
      protocolVersion: 1,
      artifactOrigin: "http://127.0.0.1:2",
    },
    artifacts: [
      {
        artifactId: "artifact_a",
        name: "plan.md",
        format: "markdown",
        sourcePath: "/workspace/plan.md",
        provenance: { kind: "workspace-source" },
        registeredSeq: 1,
      },
    ],
    sessionArtifacts: [],
    revisions: [],
    intents: [],
    work: [
      {
        workId: "work_1",
        artifactId: "artifact_a",
        baseRevisionId: "rev_base",
        intentIds: ["intent_1"],
        status: "claimed",
        assigneeAgentId: "agent_1",
        sessionId: "session_1",
        claim: { claimId: "claim_1", agentId: "agent_1" },
        result: null,
        progress: [],
        decision: "pending",
        createdSeq: 3,
      },
    ],
    chat: [],
    timeline: [],
    lastSeq: 3,
  };
}
