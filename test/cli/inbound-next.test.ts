import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeCommand,
  inboundNextExitCode,
  waitForNext,
} from "../../src/cli/inbound-commands.js";
import type { NextDelivery } from "../../src/protocol/chat-delivery.js";

const none: NextDelivery = { kind: "none", timedOut: false };
const work: NextDelivery = { kind: "work", claim: { status: "claimed", workId: "work_1" } };

describe("inbound next CLI wait boundary", () => {
  it("treats a typed empty timeout as a normal finite result", () => {
    expect(inboundNextExitCode({ kind: "none", timedOut: true })).toBe(0);
    expect(
      inboundNextExitCode({
        kind: "indeterminate",
        timedOut: true,
        reason: "transport-outcome-unknown",
        retryAfterMs: 0,
      }),
    ).toBe(3);
  });

  it("preserves a runnable selected invocation in the acknowledgement command", () => {
    const command = acknowledgeCommand(
      "/tmp/workspace with spaces",
      {
        message: { messageId: "message_1" },
        attemptId: "delivery_1",
        capability: "secret_1",
        sessionId: "session_1",
        agentId: "codex",
        processNonce: "process_1",
      },
      {
        prefix: ["/opt/node 24/bin/node", "/repo with spaces/dist/cli/index.js"],
        source: "local-node",
      },
    );

    expect(command).toMatch(
      /^'\/opt\/node 24\/bin\/node' '\/repo with spaces\/dist\/cli\/index\.js' /,
    );
    expect(command).not.toMatch(/^tweak\b/);
    expect(command).toContain("'--workspace' '/tmp/workspace with spaces'");
  });

  it("returns an immediate tagged result with one probe", async () => {
    const probe = vi.fn(async () => work);
    await expect(waitForNext(probe, true, 10)).resolves.toEqual(work);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not abort the first timeout-zero reservation before its receipt returns", async () => {
    const probe = vi.fn(
      () => new Promise<NextDelivery>((resolve) => setTimeout(() => resolve(work), 20)),
    );

    await expect(waitForNext(probe, true, 0)).resolves.toEqual(work);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("gives a non-waiting reservation enough transport time to return", async () => {
    const probe = vi.fn(
      () => new Promise<NextDelivery>((resolve) => setTimeout(() => resolve(work), 20)),
    );

    await expect(waitForNext(probe, false, 0)).resolves.toEqual(work);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not invent waiting when --wait is absent", async () => {
    const probe = vi.fn(async () => none);
    await expect(waitForNext(probe, false, 10)).resolves.toEqual(none);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("performs a final timeout probe and accepts a boundary arrival", async () => {
    const probe = vi.fn().mockResolvedValueOnce(none).mockResolvedValueOnce(work);
    await expect(waitForNext(probe, true, 0)).resolves.toEqual(work);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("does not abort a committed final reservation before its transport receipt returns", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(none)
      .mockImplementationOnce(
        () => new Promise<NextDelivery>((resolve) => setTimeout(() => resolve(work), 20)),
      );

    await expect(waitForNext(probe, true, 0)).resolves.toEqual(work);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("returns one timedOut protocol result only after the final probe is empty", async () => {
    const probe = vi.fn(async () => none);
    await expect(waitForNext(probe, true, 0)).resolves.toEqual({
      kind: "none",
      timedOut: true,
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("reports an indeterminate outcome when transport expires instead of inventing no work", async () => {
    const signals: AbortSignal[] = [];
    const probe = vi.fn(
      (signal: AbortSignal) =>
        new Promise<NextDelivery>(() => {
          signals.push(signal);
        }),
    );
    const started = Date.now();

    await expect(waitForNext(probe, true, 5)).resolves.toEqual({
      kind: "indeterminate",
      timedOut: true,
      reason: "transport-outcome-unknown",
      retryAfterMs: 0,
    });

    expect(Date.now() - started).toBeLessThan(250);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("never reports none after a plausible committed response outlives the transport budget", async () => {
    const probe = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<NextDelivery>((resolve) => setTimeout(() => resolve(work), 150)),
      )
      .mockResolvedValueOnce(none);

    await expect(waitForNext(probe, true, 0)).resolves.toMatchObject({
      kind: "indeterminate",
      reason: "transport-outcome-unknown",
    });
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
