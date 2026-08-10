import { describe, expect, it } from "vitest";
import {
  CliFailure,
  type CliFailure as CliFailureType,
  fail,
  failureEnvelope,
  jsonRequested,
  normalizeJsonOutput,
} from "../../src/cli/output.js";

describe("CLI failure unwinding", () => {
  it("runs surrounding cleanup before the top-level process exit", () => {
    let released = false;

    expect(() => {
      try {
        fail("precondition rejected", 3);
      } finally {
        released = true;
      }
    }).toThrowError(expect.objectContaining<Partial<CliFailureType>>({ exitCode: 3 }));
    expect(released).toBe(true);
  });

  it("returns the one versioned error envelope with stable typed fields", () => {
    expect(
      failureEnvelope(
        new CliFailure("daemon did not become healthy", {
          code: "daemon.startup-failed",
          retryable: true,
          nextAction: { command: "'/repo/dist/cli/index.js' daemon start --foreground" },
        }),
      ),
    ).toEqual({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "daemon.startup-failed",
        message: "daemon did not become healthy",
        retryable: true,
        nextAction: { command: "'/repo/dist/cli/index.js' daemon start --foreground" },
      },
    });
  });

  it("normalizes former leaf-local errors without rewriting successful payloads", () => {
    const success = { protocol: "tweakloop.cli/v1", status: "pass", value: 1 };
    expect(normalizeJsonOutput(success)).toBe(success);
    expect(
      normalizeJsonOutput({
        protocol: "legacy/v1",
        status: "error",
        code: "whiteboard.conflict",
        message: "stale draft",
        details: { version: 2 },
        recoveryCommand: "tweak whiteboard conflicts artifact_1",
        published: { revisionId: "revision_1" },
      }),
    ).toEqual({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "whiteboard.conflict",
        message: "stale draft",
        retryable: false,
        details: { version: 2, published: { revisionId: "revision_1" } },
        nextAction: { command: "tweak whiteboard conflicts artifact_1" },
      },
    });
  });

  it("normalizes former conflict payloads instead of exposing a successful-looking result", () => {
    expect(
      normalizeJsonOutput({
        protocol: "tweakloop.whiteboard/v1",
        status: "conflict",
        currentVersion: 4,
        recovery: "refresh and retry",
      }),
    ).toEqual({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "cli.conflict",
        message: "command conflicted with current state",
        retryable: true,
        details: { currentVersion: 4 },
        nextAction: "refresh and retry",
      },
    });
  });

  it("detects supported pre- and post-command JSON placement independently of parser state", () => {
    expect(jsonRequested(["--json", "lint", "plan.html"])).toBe(true);
    expect(jsonRequested(["lint", "plan.html", "--json"])).toBe(true);
    expect(jsonRequested(["lint", "plan.html"])).toBe(false);
  });
});
