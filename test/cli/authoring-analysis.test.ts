import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type AuthoringAnalysisError,
  diffArtifactBytes,
  diffNewArtifactBytes,
  lintArtifactFile,
} from "../../src/cli/authoring-analysis.js";

describe("authoring semantic CLI adapters", () => {
  it("returns every shared-analyzer lint finding in one run", () => {
    const file = fixture(
      "invalid.html",
      `<!doctype html><html><body>
        <section data-tweak-id="decision.auth" data-tweak-kind="decision">[[ANSWER]]</section>
        <section data-tweak-id="decision.auth">Duplicate</section>
      </body></html>`,
    );

    const receipt = lintArtifactFile(file);

    expect(receipt.status).toBe("fail");
    expect(receipt.findings.map((finding) => finding.code)).toEqual(
      expect.arrayContaining([
        "anchor.duplicate-id",
        "anchor.missing-kind",
        "template.placeholder",
      ]),
    );
  });

  it("reports same-text/new-anchor as remove plus add and only a possible rename", () => {
    const before = html("decision.auth", "decision", "Use OAuth");
    const path = fixture("rename.html", html("decision.authentication", "decision", "Use OAuth"));

    const receipt = diffArtifactBytes({
      path,
      artifactId: "artifact_1",
      beforeRevisionId: "revision_1",
      before,
    });

    expect(receipt.removed.map((node) => node.id)).toEqual(["decision.auth"]);
    expect(receipt).toMatchObject({ baseline: "revision", beforeRevisionId: "revision_1" });
    expect(receipt.added.map((node) => node.id)).toEqual(["decision.authentication"]);
    expect(receipt.unchanged).toEqual([]);
    expect(receipt.possibleRenames).toEqual([
      {
        removedId: "decision.auth",
        addedId: "decision.authentication",
        reason: "unique-content-kind-and-parent-match",
      },
    ]);
  });

  it("uses an explicit empty baseline for an unregistered first revision", () => {
    const path = fixture("first.html", html("decision.auth", "decision", "Use OAuth"));

    const receipt = diffNewArtifactBytes(path);

    expect(receipt).toMatchObject({
      status: "pass",
      baseline: "empty",
      artifactId: null,
      beforeRevisionId: null,
    });
    expect(receipt.added.map((node) => node.id)).toEqual(["decision.auth"]);
    expect(receipt.removed).toEqual([]);
    expect(receipt.changed).toEqual([]);
  });

  it("reports kind changes independently from content and identity", () => {
    const path = fixture("kind.html", html("decision.auth", "requirement", "Use OAuth"));
    const receipt = diffArtifactBytes({
      path,
      artifactId: "artifact_1",
      beforeRevisionId: "revision_1",
      before: html("decision.auth", "decision", "Use OAuth"),
    });

    expect(receipt.added).toEqual([]);
    expect(receipt.removed).toEqual([]);
    expect(receipt.kindChanged).toHaveLength(1);
    expect(receipt.kindChanged[0]).toMatchObject({
      before: { id: "decision.auth", kind: "decision" },
      after: { id: "decision.auth", kind: "requirement" },
    });
  });

  it("rejects unsupported formats before inventing a parser", () => {
    const file = fixture("notes.txt", "plain text");
    expect(() => lintArtifactFile(file)).toThrowError(
      expect.objectContaining<Partial<AuthoringAnalysisError>>({
        code: "authoring.unsupported-format",
      }),
    );
  });
});

function fixture(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "tweakloop-authoring-"));
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

function html(id: string, kind: string, text: string): string {
  return `<!doctype html><html><body><h1>Plan</h1><section data-tweak-id="${id}" data-tweak-kind="${kind}">${text}</section></body></html>`;
}
