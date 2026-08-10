import { describe, expect, it } from "vitest";
import { failureEnvelope } from "../../src/cli/output.js";
import { withStartupDiagnostics } from "../../src/cli/startup-diagnostics.js";

describe("early daemon startup diagnostics", () => {
  it("replaces zero-byte-log-only advice with an exact foreground command", () => {
    const command =
      "'/opt/node/bin/node' '/repo/dist/cli/index.js' '--workspace' '/tmp/work space' 'daemon' 'start' '--foreground'";
    const envelope = failureEnvelope(
      withStartupDiagnostics(
        new Error("daemon did not become healthy within 10s — see /tmp/state/daemon.log"),
        command,
      ),
    );

    expect(envelope).toEqual({
      protocol: "tweakloop.cli/v1",
      error: {
        code: "daemon.startup-failed",
        message: "daemon did not become healthy within 10s — see /tmp/state/daemon.log",
        retryable: true,
        details: {
          diagnosticSource: "foreground-command",
          backgroundDiagnostic:
            "daemon did not become healthy within 10s — see /tmp/state/daemon.log",
        },
        nextAction: {
          command,
          reason: "run the same workspace daemon in the foreground to expose pre-logger failure",
        },
      },
    });
  });

  it("does not relabel unrelated action failures as startup faults", () => {
    const original = new Error("session is ambiguous");
    expect(withStartupDiagnostics(original, "ignored")).toBe(original);
  });
});
