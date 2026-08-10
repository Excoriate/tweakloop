import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attachArtifactToSession,
  type DaemonConnection,
  mintSessionUrl,
  openArtifactInSession,
} from "../../src/cli/daemon-client.js";

const connection: DaemonConnection = {
  baseUrl: "http://127.0.0.1:9999",
  token: "secret",
  descriptor: {
    pid: 1,
    startNonce: "nonce",
    shellPort: 9999,
    artifactPort: 9998,
    protocolVersion: 1,
    workspaceId: "ws",
    cliToken: "secret",
  },
};

afterEach(() => vi.restoreAllMocks());

describe("settled session daemon-client adapters", () => {
  it("posts existing-session open to the one atomic endpoint", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        protocol: "tweakloop.session-open/v1",
        sessionId: "session_1",
        artifactId: "artifact_1",
        revisionId: "rev_1",
        seq: 1,
        created: true,
        unchanged: false,
        alreadyAttached: false,
        attachedRevisionId: "rev_1",
      }),
    );
    const input = {
      sessionId: "session_1",
      path: "/repo/plan.html",
      requestId: "request_1",
      expectedContentSha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      role: "opened" as const,
      actor: { kind: "agent", id: "codex" },
    };

    await expect(openArtifactInSession(connection, input)).resolves.toMatchObject({
      revisionId: "rev_1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://127.0.0.1:9999/api/v1/sessions/open-artifact");
    expect(JSON.parse(String(init?.body))).toEqual(input);
  });

  it("preserves a rejected attach as a protocol result", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json(
        {
          status: "rejected",
          commandId: "cmd_1",
          code: "session.artifact-already-attached",
          message: "conflict",
        },
        { status: 409 },
      ),
    );

    await expect(
      attachArtifactToSession(connection, {
        sessionId: "session_1",
        artifactId: "artifact_1",
        revisionId: "rev_1",
        requestId: "request_1",
        role: "opened",
        actor: { kind: "agent", id: "codex" },
      }),
    ).resolves.toMatchObject({ status: "rejected", code: "session.artifact-already-attached" });
  });

  it("uses the fresh URL endpoint instead of the compatibility bootstrap route", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          protocol: "tweakloop.session-url/v1",
          url: "http://127.0.0.1:9999/bootstrap/one",
          artifactId: "artifact_1",
          agentId: "codex",
          sessionId: "session_1",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          protocol: "tweakloop.session-url/v1",
          url: "http://127.0.0.1:9999/bootstrap/two",
          artifactId: "artifact_1",
          agentId: "codex",
          sessionId: "session_1",
        }),
      );

    const input = { sessionId: "session_1", artifactId: "artifact_1", agentId: "codex" };
    const first = await mintSessionUrl(connection, input);
    const second = await mintSessionUrl(connection, input);
    expect(first.url).not.toBe(second.url);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:9999/api/v1/sessions/url",
      "http://127.0.0.1:9999/api/v1/sessions/url",
    ]);
  });
});
