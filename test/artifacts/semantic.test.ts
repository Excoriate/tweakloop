import { describe, expect, it } from "vitest";
import { extractHtmlSemanticIndex } from "../../src/artifacts/html-semantic.js";
import { extractMarkdownSemanticIndex } from "../../src/artifacts/markdown-semantic.js";
import {
  BEHAVIOR_RESERVED_KINDS,
  diffSemanticIndexes,
  lintSemantic,
} from "../../src/artifacts/semantic.js";
import { guardSemanticPublish } from "../../src/artifacts/semantic-guard.js";

describe("HTML semantic extraction", () => {
  it("parses multiline quoted attributes and accepts an open custom lower-kebab kind", () => {
    const index = extractHtmlSemanticIndex(`<!doctype html>
<html><body>
  <section
    class="decorative"
    data-tweak-kind='prior-art'
    data-tweak-id="architecture.prior-art"
  ><p>Prior   systems</p></section>
</body></html>`);

    expect(index.nodes).toEqual([
      expect.objectContaining({
        id: "architecture.prior-art",
        kind: "prior-art",
        normalizedContent: "Prior systems",
        sourceRange: expect.objectContaining({ startLine: 3, endLine: 7 }),
        structuralPosition: expect.objectContaining({ parentId: null }),
      }),
    ]);
    expect(index.findings).toEqual([]);
  });

  it("reports duplicate, missing ID/kind, malformed kind, and placeholder findings together", () => {
    const result = lintSemantic(
      "html",
      `<!doctype html><html><body>
        <section data-tweak-id="decision.auth" data-tweak-kind="decision">One</section>
        <section data-tweak-id="decision.auth">Two [[REPLACE_ME]]</section>
        <section data-tweak-kind="Not Valid">Three</section>
      </body></html>`,
    );
    const codes = result.findings.map((finding) => finding.code);

    expect(result.ok).toBe(false);
    expect(codes).toContain("anchor.duplicate-id");
    expect(codes).toContain("anchor.missing-kind");
    expect(codes).toContain("anchor.missing-id");
    expect(codes).toContain("anchor.invalid-kind");
    expect(codes).toContain("template.placeholder");
  });

  it("does not interpret tag-shaped JavaScript or CSS text as semantic nodes", () => {
    const index = extractHtmlSemanticIndex(`<!doctype html><html><body>
      <script>const fake = '<p data-tweak-id="fake.script" data-tweak-kind="paragraph">';</script>
      <style>.x::before { content: '<p data-tweak-id="fake.style" data-tweak-kind="paragraph">'; }</style>
      <p data-tweak-id="real.content" data-tweak-kind="paragraph">Real</p>
    </body></html>`);
    expect(index.nodes.map((node) => node.id)).toEqual(["real.content"]);
  });

  it("warns on presentation-shaped IDs without rejecting otherwise valid custom kinds", () => {
    const result = lintSemantic(
      "html",
      '<!doctype html><html><body><div data-tweak-id="left-card-3" data-tweak-kind="interface">X</div></body></html>',
    );
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: "anchor.invalid-id", severity: "warning" }),
    ]);
  });
});

describe("Markdown semantic extraction", () => {
  it("extracts canonical Markdown directly with heading/paragraph kinds and source ranges", () => {
    const index = extractMarkdownSemanticIndex(
      "# Platform {#architecture.platform}\n\nOpening context.\n\n## Network\n\nPrivate links.\n",
    );

    expect(
      index.nodes.map((node) => [node.id, node.kind, node.structuralPosition.parentId]),
    ).toEqual([
      ["architecture.platform", "heading", null],
      ["architecture.platform.paragraph-1", "paragraph", "architecture.platform"],
      ["architecture.platform.network", "heading", "architecture.platform"],
      ["architecture.platform.network.paragraph-1", "paragraph", "architecture.platform.network"],
    ]);
    expect(index.nodes.every((node) => node.sourceRange !== undefined)).toBe(true);
  });

  it("surfaces duplicate explicit Markdown identities instead of trusting generated HTML", () => {
    const index = extractMarkdownSemanticIndex(
      "# One {#decision.auth}\n\n# Two {#decision.auth}\n",
    );
    expect(index.nodes.map((node) => node.id)).toEqual(["decision.auth", "decision.auth"]);
    expect(index.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "anchor.duplicate-id", semanticId: "decision.auth" }),
      ]),
    );
  });
});

describe("semantic diff", () => {
  it("keeps same-text/new-ID as remove plus add and only suggests a possible rename", () => {
    const before = extractHtmlSemanticIndex(
      '<section data-tweak-id="decision.auth" data-tweak-kind="decision">OAuth only</section>',
    );
    const after = extractHtmlSemanticIndex(
      '<section data-tweak-id="decision.authentication" data-tweak-kind="decision">OAuth only</section>',
    );
    const diff = diffSemanticIndexes(before, after);

    expect(diff.removed.map((node) => node.id)).toEqual(["decision.auth"]);
    expect(diff.added.map((node) => node.id)).toEqual(["decision.authentication"]);
    expect(diff.unchanged).toEqual([]);
    expect(diff.possibleRenames).toEqual([
      {
        removedId: "decision.auth",
        addedId: "decision.authentication",
        reason: "unique-content-kind-and-parent-match",
      },
    ]);
  });

  it("reports structural movement and kind change independently of stable identity", () => {
    const before = extractHtmlSemanticIndex(
      '<main><section data-tweak-id="plan" data-tweak-kind="ordered-plan"><p data-tweak-id="plan.phase" data-tweak-kind="plan-phase">Ship</p></section></main>',
    );
    const after = extractHtmlSemanticIndex(
      '<main><p data-tweak-id="plan.phase" data-tweak-kind="implementation-detail">Ship</p><section data-tweak-id="plan" data-tweak-kind="ordered-plan"></section></main>',
    );
    const diff = diffSemanticIndexes(before, after);

    expect(diff.moved.map((change) => change.after.id)).toContain("plan.phase");
    expect(diff.kindChanged.map((change) => change.after.id)).toEqual(["plan.phase"]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged.map((node) => node.id)).not.toContain("plan.phase");
  });

  it("documents only the initial behavior-reserved kinds", () => {
    expect(BEHAVIOR_RESERVED_KINDS).toEqual(["document-title", "whiteboard"]);
  });
});

describe("protected semantic anchor policy", () => {
  const head = extractHtmlSemanticIndex(
    '<section data-tweak-id="decision.auth" data-tweak-kind="decision">OAuth only</section>',
  );
  const removed = extractHtmlSemanticIndex("<main>No decision yet</main>");

  it("rejects unresolved protected loss but allows an unprotected removal", () => {
    expect(
      guardSemanticPublish(head, removed, [
        {
          intentId: "intent_comment",
          intentType: "comment",
          semanticId: "decision.auth",
          status: "submitted",
          actorKind: "human",
        },
      ]),
    ).toMatchObject({
      ok: false,
      code: "artifact.protected-anchor-loss",
      details: { semanticIds: ["decision.auth"], intentIds: ["intent_comment"] },
    });
    expect(guardSemanticPublish(head, removed, [])).toEqual({ ok: true });
  });

  it("allows only an exact unresolved human removal intent to authorize deletion", () => {
    const comment = {
      intentId: "intent_comment",
      intentType: "comment",
      semanticId: "decision.auth",
      status: "submitted" as const,
      actorKind: "human" as const,
    };
    expect(
      guardSemanticPublish(head, removed, [
        comment,
        {
          intentId: "intent_remove",
          intentType: "remove",
          semanticId: "decision.auth",
          status: "submitted",
          actorKind: "human",
        },
      ]),
    ).toEqual({ ok: true });
    expect(
      guardSemanticPublish(head, removed, [
        comment,
        {
          intentId: "intent_agent_remove",
          intentType: "remove",
          semanticId: "decision.auth",
          status: "submitted",
          actorKind: "agent",
        },
      ]),
    ).toMatchObject({ ok: false, code: "artifact.protected-anchor-loss" });
  });
});
