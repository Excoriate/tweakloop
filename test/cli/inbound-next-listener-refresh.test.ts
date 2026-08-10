import { describe, expect, it, vi } from "vitest";
import { refreshClaimSnapshot, workListenerState } from "../../src/cli/session-listener.js";
import type { AgentSessionSnapshot } from "../../src/protocol/agent-session.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";

const stale = {
  protocol: "tweakloop.agent-session/v1",
  kind: "snapshot",
  appliedSeq: 1,
  agentId: "codex",
  processNonce: "process_1",
  sessionId: "session_1",
  artifactId: null,
  artifacts: [],
  work: [],
  chat: [],
} as AgentSessionSnapshot;

const claimEvent = {
  seq: 2,
  streamType: "work",
  streamId: "work_1",
  eventType: "work.claimed",
} as EventEnvelope;

describe("inbound next listener claim refresh", () => {
  it("replaces the stale heartbeat snapshot on every relevant work fact", async () => {
    const current = {
      ...stale,
      appliedSeq: 2,
      work: [
        {
          workId: "work_1",
          claim: { claimId: "claim_1", agentId: "codex" },
        },
      ],
    } as unknown as AgentSessionSnapshot;
    const load = vi.fn(async () => current);
    await expect(refreshClaimSnapshot(stale, claimEvent, load)).resolves.toBe(current);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the claim cache for unrelated streams", async () => {
    const load = vi.fn(async () => stale);
    const chatEvent = { ...claimEvent, streamType: "chat", eventType: "chat.message" };
    await expect(refreshClaimSnapshot(stale, chatEvent, load)).resolves.toBe(stale);
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps exact claimed work live and settles on release or completion", () => {
    const claimed = {
      ...stale,
      work: [
        {
          workId: "work_1",
          status: "claimed",
          claim: { claimId: "claim_1", agentId: "codex" },
        },
      ],
    } as unknown as AgentSessionSnapshot;
    expect(workListenerState(claimed, "work_1", "claim_1")).toBe("active");
    expect(
      workListenerState(
        {
          ...claimed,
          work: [{ ...claimed.work[0], status: "addressed", claim: null }],
        } as AgentSessionSnapshot,
        "work_1",
        "claim_1",
      ),
    ).toBe("settled");
    expect(workListenerState({ ...claimed, work: [] }, "work_1", "claim_1")).toBe("settled");
    expect(
      workListenerState(
        {
          ...claimed,
          work: [
            {
              ...claimed.work[0],
              claim: { claimId: "claim_replacement", agentId: "codex" },
            },
          ],
        } as AgentSessionSnapshot,
        "work_1",
        "claim_1",
      ),
    ).toBe("claim-changed");
  });
});
