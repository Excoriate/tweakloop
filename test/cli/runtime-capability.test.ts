import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  completeRuntimeCapabilityPreparation,
  loadRuntimeCapability,
  prepareRuntimeCapability,
  type RuntimeCapabilityError,
} from "../../src/cli/runtime-capability.js";

const roots: string[] = [];
const originalStateDir = process.env.TWEAKLOOP_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.TWEAKLOOP_STATE_DIR;
  else process.env.TWEAKLOOP_STATE_DIR = originalStateDir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function isolatedState(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tweakloop-capability-test-"));
  roots.push(root);
  process.env.TWEAKLOOP_STATE_DIR = root;
  return root;
}

const scope = {
  workspaceId: "ws_1234567890abcdef",
  workspaceRoot: join(tmpdir(), "tweakloop-capability-workspace"),
  daemonStartNonce: "daemon_1",
  operationIdentity: "operation_1",
  agentId: "codex",
};

describe("runtime capability custody", () => {
  it("atomically stores only the plaintext custody file at mode 0600", async () => {
    const stateRoot = await isolatedState();
    const prepared = prepareRuntimeCapability(scope);
    const loaded = loadRuntimeCapability({
      workspaceId: scope.workspaceId,
      workspaceRoot: scope.workspaceRoot,
      daemonStartNonce: scope.daemonStartNonce,
      sessionId: prepared.sessionId,
      agentId: scope.agentId,
      processNonce: prepared.processNonce,
    });

    expect(prepared.capabilityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(prepared)).not.toContain(loaded.capability);
    expect(statSync(prepared.custodyPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(prepared.pendingPath, "utf8")).not.toContain(loaded.capability);
    expect(readFileSync(prepared.pendingPath, "utf8")).not.toContain(loaded.capabilityHash);
    expect(prepared.custodyPath.startsWith(stateRoot)).toBe(true);
    expect(readdirSync(join(stateRoot, "tweakloop", "workspaces", scope.workspaceId))).toEqual([
      "runtime-capabilities",
    ]);
  });

  it("recovers the exact session, process, and capability after lost response", async () => {
    await isolatedState();
    const first = prepareRuntimeCapability(scope);
    const recovered = prepareRuntimeCapability(scope);

    expect(recovered).toMatchObject({
      sessionId: first.sessionId,
      processNonce: first.processNonce,
      capabilityHash: first.capabilityHash,
      custodyPath: first.custodyPath,
      pendingPath: first.pendingPath,
    });

    completeRuntimeCapabilityPreparation(recovered);
    const nextLogicalSession = prepareRuntimeCapability(scope);
    expect(nextLogicalSession.sessionId).not.toBe(first.sessionId);
    expect(nextLogicalSession.processNonce).not.toBe(first.processNonce);
    expect(nextLogicalSession.capabilityHash).not.toBe(first.capabilityHash);
  });

  it("rejects stale-runtime, wrong-process, and missing custody", async () => {
    await isolatedState();
    const prepared = prepareRuntimeCapability(scope);
    const base = {
      workspaceId: scope.workspaceId,
      workspaceRoot: scope.workspaceRoot,
      daemonStartNonce: scope.daemonStartNonce,
      sessionId: prepared.sessionId,
      agentId: scope.agentId,
      processNonce: prepared.processNonce,
    };

    expect(() => loadRuntimeCapability({ ...base, daemonStartNonce: "daemon_2" })).toThrowError(
      expect.objectContaining<Partial<RuntimeCapabilityError>>({
        code: "runtime-capability.scope-mismatch",
        details: { reason: "daemon-generation-changed" },
      }),
    );
    expect(() => loadRuntimeCapability({ ...base, processNonce: "wrong-process" })).toThrowError(
      expect.objectContaining<Partial<RuntimeCapabilityError>>({
        code: "runtime-capability.missing",
      }),
    );
    rmSync(prepared.custodyPath);
    expect(() => loadRuntimeCapability(base)).toThrowError(
      expect.objectContaining<Partial<RuntimeCapabilityError>>({
        code: "runtime-capability.missing",
      }),
    );
  });

  it("does not classify a corrupt identity scope as recoverable daemon generation drift", async () => {
    await isolatedState();
    const prepared = prepareRuntimeCapability(scope);
    const custody = JSON.parse(readFileSync(prepared.custodyPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      prepared.custodyPath,
      `${JSON.stringify({ ...custody, processNonce: "wrong-process" })}\n`,
      { mode: 0o600 },
    );

    expect(() =>
      loadRuntimeCapability({
        workspaceId: scope.workspaceId,
        workspaceRoot: scope.workspaceRoot,
        daemonStartNonce: scope.daemonStartNonce,
        sessionId: prepared.sessionId,
        agentId: scope.agentId,
        processNonce: prepared.processNonce,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeCapabilityError>>({
        code: "runtime-capability.scope-mismatch",
        details: { reason: "identity-mismatch", dimension: "processNonce" },
      }),
    );
  });

  it("refuses to place plaintext custody inside the workspace", async () => {
    const stateRoot = await isolatedState();
    expect(() => prepareRuntimeCapability({ ...scope, workspaceRoot: stateRoot })).toThrowError(
      expect.objectContaining<Partial<RuntimeCapabilityError>>({
        code: "runtime-capability.workspace-custody-forbidden",
      }),
    );
  });

  it("atomically rotates completed custody for a legitimate new daemon generation", async () => {
    await isolatedState();
    const fixedScope = {
      ...scope,
      sessionId: "session_fixed",
      processNonce: "process_fixed",
    };
    const generationA = prepareRuntimeCapability({
      ...fixedScope,
      operationIdentity: "operation_generation_a",
    });
    const secretA = loadRuntimeCapability({
      workspaceId: scope.workspaceId,
      workspaceRoot: scope.workspaceRoot,
      daemonStartNonce: "daemon_1",
      sessionId: fixedScope.sessionId,
      agentId: scope.agentId,
      processNonce: fixedScope.processNonce,
    }).capability;

    expect(() =>
      prepareRuntimeCapability({
        ...fixedScope,
        daemonStartNonce: "daemon_2",
        operationIdentity: "operation_generation_a",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeCapabilityError>>({
        code: "runtime-capability.scope-mismatch",
      }),
    );

    completeRuntimeCapabilityPreparation(generationA);
    const generationB = prepareRuntimeCapability({
      ...fixedScope,
      daemonStartNonce: "daemon_2",
      operationIdentity: "operation_generation_b",
    });
    const loadedB = loadRuntimeCapability({
      workspaceId: scope.workspaceId,
      workspaceRoot: scope.workspaceRoot,
      daemonStartNonce: "daemon_2",
      sessionId: fixedScope.sessionId,
      agentId: scope.agentId,
      processNonce: fixedScope.processNonce,
    });

    expect(generationB.custodyPath).toBe(generationA.custodyPath);
    expect(generationB.capabilityHash).not.toBe(generationA.capabilityHash);
    expect(loadedB.capability).not.toBe(secretA);
    expect(JSON.stringify(generationB)).not.toContain(loadedB.capability);
    expect(readFileSync(generationB.custodyPath, "utf8")).not.toContain(secretA);
    expect(statSync(generationB.custodyPath).mode & 0o777).toBe(0o600);
    expect(() =>
      loadRuntimeCapability({
        workspaceId: scope.workspaceId,
        workspaceRoot: scope.workspaceRoot,
        daemonStartNonce: "daemon_1",
        sessionId: fixedScope.sessionId,
        agentId: scope.agentId,
        processNonce: fixedScope.processNonce,
      }),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeCapabilityError>>({
        code: "runtime-capability.scope-mismatch",
      }),
    );
  });
});
