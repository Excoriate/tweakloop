import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkArtifact } from "../../src/cli/artifact-check.js";

describe("artifact browser-check capability failures", () => {
  it("fails closed when Chromium is unavailable instead of returning source-only success", async () => {
    const path = fixture("valid.html", validHtml());
    const result = await checkArtifact(path, [], {
      loadAxeSource: async () => "globalThis.axe = {};",
      loadBrowser: async () => {
        throw new Error("browser executable missing");
      },
    });

    expect(result.status).toBe("fail");
    expect(result.testedViewports).toEqual([]);
    expect(result.findings).toEqual([
      expect.objectContaining({
        code: "check.browser-unavailable",
        message: expect.stringContaining("browser executable missing"),
      }),
    ]);
  });

  it("fails closed when the named contrast auditor is unavailable before launching a browser", async () => {
    const loadBrowser = vi.fn();
    const path = fixture("valid.html", validHtml());
    const result = await checkArtifact(path, [], {
      loadAxeSource: async () => {
        throw new Error("axe missing");
      },
      loadBrowser,
    });

    expect(result.status).toBe("fail");
    expect(result.findings[0]).toMatchObject({ code: "check.auditor-unavailable" });
    expect(loadBrowser).not.toHaveBeenCalled();
  });

  it("rejects unsupported source instead of treating a parser as a browser", async () => {
    const loadBrowser = vi.fn();
    const result = await checkArtifact(fixture("artifact.txt", "plain text"), [], {
      loadBrowser,
    });

    expect(result.status).toBe("fail");
    expect(result.findings[0]).toMatchObject({ code: "check.unsupported-format" });
    expect(loadBrowser).not.toHaveBeenCalled();
  });
});

function fixture(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "tweakloop-check-capability-"));
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

function validHtml(): string {
  return "<!doctype html><html><body><h1>Plan</h1></body></html>";
}
