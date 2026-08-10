import { describe, expect, it } from "vitest";
import { parseAgentSessionRecord } from "../../src/protocol/agent-session.js";

describe("tweakloop.agent-session/v1", () => {
  it("parses a snapshot golden record", () => {
    expect(
      parseAgentSessionRecord({
        protocol: "tweakloop.agent-session/v1",
        kind: "snapshot",
        appliedSeq: 42,
        agentId: "codex",
        processNonce: "process_1",
        sessionId: "session_1",
        artifactId: "artifact_1",
        artifacts: [],
        work: [],
        chat: [],
      }),
    ).toMatchObject({ status: "known", record: { kind: "snapshot", appliedSeq: 42 } });
  });

  it("preserves unknown kinds for forward-compatible consumers", () => {
    expect(
      parseAgentSessionRecord({
        protocol: "tweakloop.agent-session/v1",
        kind: "capability-added-later",
        value: 1,
      }),
    ).toMatchObject({
      status: "unknown",
      record: { kind: "capability-added-later", value: { value: 1 } },
    });
  });

  it("rejects malformed known records and protocol mismatches", () => {
    expect(
      parseAgentSessionRecord({ protocol: "tweakloop.agent-session/v1", kind: "delta" }),
    ).toMatchObject({ status: "invalid", message: expect.stringContaining("missing") });
    expect(
      parseAgentSessionRecord({ protocol: "tweakloop.agent-session/v2", kind: "heartbeat" }),
    ).toMatchObject({ status: "invalid", message: expect.stringContaining("unsupported") });
  });
});
