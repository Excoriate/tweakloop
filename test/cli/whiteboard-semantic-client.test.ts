import { describe, expect, it, vi } from "vitest";
import type { DaemonConnection } from "../../src/cli/daemon-client.js";
import {
  applyWhiteboardSemanticScene,
  mintWhiteboardAutomationToken,
} from "../../src/cli/whiteboard-semantic-client.js";
import {
  SEMANTIC_SCENE_REQUEST_PROTOCOL,
  type SemanticSceneRequest,
} from "../../src/whiteboard/semantic-scene.js";

const connection: DaemonConnection = {
  baseUrl: "http://127.0.0.1:4321",
  token: "cli-secret",
  descriptor: {
    pid: 1,
    startNonce: "daemon_1",
    shellPort: 4321,
    artifactPort: 4322,
    protocolVersion: 1,
    workspaceId: "ws_1234567890abcdef",
    cliToken: "cli-secret",
  },
};

const request: SemanticSceneRequest = {
  protocol: SEMANTIC_SCENE_REQUEST_PROTOCOL,
  artifactId: "artifact_1",
  idempotencyKey: "business-key-1",
  operations: [{ type: "node.upsert", semanticKey: "node-a", label: "A" }],
};

function tokenResponse(token: string): Response {
  return Response.json(
    {
      protocol: "tweakloop.whiteboard-automation-token/v1",
      automationToken: token,
      expiresAt: 10_000,
      operationId: "whiteboard.semantic-scene.apply.v1",
      routeSetVersion: 1,
    },
    { status: 201 },
  );
}

function acceptedResponse(): Response {
  return Response.json({
    protocol: "tweakloop.whiteboard-scene-response/v1",
    status: "accepted",
    artifactId: request.artifactId,
    idempotencyKey: request.idempotencyKey,
    normalizationVersion: 1,
    baseRevisionId: "revision_1",
    draftVersion: 2,
    sceneHash: "a".repeat(64),
    elementIndexHash: "b".repeat(64),
    expectedHeadRevisionId: "revision_1",
    unchanged: false,
    changedTargets: [],
    changedBounds: null,
  });
}

describe("whiteboard semantic automation client", () => {
  it("mints with the exact closed ABI and keeps the capability out of the result", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(tokenResponse("t".repeat(48)));
    const result = await mintWhiteboardAutomationToken(
      connection,
      { sessionId: "session_1", runtimeCapability: "runtime-secret", request },
      fetcher,
    );

    expect(JSON.stringify(result)).not.toContain("runtime-secret");
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:4321/api/v1/automation/whiteboard-tokens");
    expect(init?.headers).toEqual({
      authorization: "Bearer cli-secret",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      protocol: "tweakloop.whiteboard-automation-mint/v1",
      sessionId: "session_1",
      runtimeCapability: "runtime-secret",
      artifactId: "artifact_1",
      method: "POST",
      operationId: "whiteboard.semantic-scene.apply.v1",
      routeSetVersion: 1,
      request,
    });
  });

  it("applies with only the one-use bearer and no authority fields in the body", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("t".repeat(48)))
      .mockResolvedValueOnce(acceptedResponse());

    const result = await applyWhiteboardSemanticScene(
      connection,
      { sessionId: "session_1", runtimeCapability: "runtime-secret", request },
      { fetch: fetcher },
    );

    expect(result.idempotencyKey).toBe("business-key-1");
    expect(JSON.stringify(result)).not.toContain("runtime-secret");
    expect(JSON.stringify(result)).not.toContain("t".repeat(48));
    const [url, init] = fetcher.mock.calls[1] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:4321/api/v1/whiteboards/artifact_1/scene-commands");
    expect(init?.headers).toEqual({
      authorization: `Bearer ${"t".repeat(48)}`,
      "content-type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual(request);
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("sessionId");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("actor");
    expect(JSON.parse(String(init?.body))).not.toHaveProperty("runtimeCapability");
  });

  it("uses a fresh transport token with the exact same business request after token replay", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("a".repeat(48)))
      .mockResolvedValueOnce(
        Response.json(
          {
            protocol: "tweakloop.whiteboard-error/v1",
            code: "whiteboard.automation-token-used",
            error: "automation token has already been used",
          },
          { status: 403 },
        ),
      )
      .mockResolvedValueOnce(tokenResponse("b".repeat(48)))
      .mockResolvedValueOnce(acceptedResponse());

    await applyWhiteboardSemanticScene(
      connection,
      { sessionId: "session_1", runtimeCapability: "runtime-secret", request },
      { fetch: fetcher },
    );

    const firstApply = fetcher.mock.calls[1]?.[1];
    const secondApply = fetcher.mock.calls[3]?.[1];
    expect(firstApply?.headers).toMatchObject({ authorization: `Bearer ${"a".repeat(48)}` });
    expect(secondApply?.headers).toMatchObject({ authorization: `Bearer ${"b".repeat(48)}` });
    expect(secondApply?.body).toBe(firstApply?.body);
  });

  it("repeats the exact mint request when the mint response is lost", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("socket closed"))
      .mockResolvedValueOnce(tokenResponse("b".repeat(48)))
      .mockResolvedValueOnce(acceptedResponse());

    await applyWhiteboardSemanticScene(
      connection,
      { sessionId: "session_1", runtimeCapability: "runtime-secret", request },
      { fetch: fetcher },
    );

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(fetcher.mock.calls[0]?.[1]?.body);
  });

  it("does not retry a rejected runtime capability mint", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          protocol: "tweakloop.whiteboard-error/v1",
          code: "whiteboard.runtime-capability-invalid",
          error: "runtime capability is invalid",
        },
        { status: 403 },
      ),
    );

    await expect(
      applyWhiteboardSemanticScene(
        connection,
        { sessionId: "session_1", runtimeCapability: "wrong-secret", request },
        { fetch: fetcher },
      ),
    ).rejects.toMatchObject({ code: "whiteboard.runtime-capability-invalid" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("binds a changed request to a separately minted token", async () => {
    const changed = {
      ...request,
      idempotencyKey: "business-key-2",
      operations: [{ type: "node.upsert", semanticKey: "node-b" }] as const,
    } satisfies SemanticSceneRequest;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse("a".repeat(48)))
      .mockResolvedValueOnce(acceptedResponse())
      .mockResolvedValueOnce(tokenResponse("b".repeat(48)))
      .mockResolvedValueOnce(
        Response.json({
          ...(await acceptedResponse().json()),
          idempotencyKey: changed.idempotencyKey,
        }),
      );

    await applyWhiteboardSemanticScene(
      connection,
      { sessionId: "session_1", runtimeCapability: "runtime-secret", request },
      { fetch: fetcher },
    );
    await applyWhiteboardSemanticScene(
      connection,
      { sessionId: "session_1", runtimeCapability: "runtime-secret", request: changed },
      { fetch: fetcher },
    );

    const firstMint = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const changedMint = JSON.parse(String(fetcher.mock.calls[2]?.[1]?.body));
    expect(changedMint.request).toEqual(changed);
    expect(changedMint.request).not.toEqual(firstMint.request);
  });
});
