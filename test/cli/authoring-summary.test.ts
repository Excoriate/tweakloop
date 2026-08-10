import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ArtifactDiffReceipt,
  diffArtifactBytes,
  lintArtifactFile,
} from "../../src/cli/authoring-analysis.js";
import { summarizeArtifactDiff, summarizeArtifactLint } from "../../src/cli/authoring-summary.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import type { SnapshotIntent } from "../../src/protocol/snapshot.js";

describe("bounded authoring summaries", () => {
  it("stays fixed-shape and below 8 KiB at 10 and 10,000 nodes", () => {
    const path = fixture("scale.html", "<main></main>");
    const small = summarizeArtifactDiff(diffReceipt(path, 10), emptyProtection());
    const large = summarizeArtifactDiff(diffReceipt(path, 10_000), emptyProtection());
    const smallJson = JSON.stringify({ protocol: "tweakloop.cli/v1", ...small });
    const largeJson = JSON.stringify({ protocol: "tweakloop.cli/v1", ...large });

    expect(Buffer.byteLength(smallJson)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(largeJson)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(largeJson) - Buffer.byteLength(smallJson)).toBeLessThan(16);
    expect(largeJson).not.toMatch(/node_[0-9]|contentFingerprint|findings|sourceRange/);
    expect(arrayPaths(large)).toEqual([]);
    expect(Object.keys(large.counts)).toEqual(Object.keys(small.counts));
  });

  it("counts protected losses and protected changes exactly", () => {
    const path = fixture(
      "protected.html",
      html([
        ["protected.change", "Changed"],
        ["kept", "Kept"],
      ]),
    );
    const receipt = diffArtifactBytes({
      path,
      artifactId: "artifact_1",
      beforeRevisionId: "revision_1",
      before: html([
        ["protected.remove", "Remove me"],
        ["protected.change", "Original"],
        ["free.remove", "No intent"],
        ["kept", "Kept"],
      ]),
    });
    const protection = {
      artifactId: "artifact_1",
      intents: [
        intent("intent_remove_comment", "comment", "protected.remove"),
        intent("intent_change_comment", "comment", "protected.change"),
      ],
      events: [event("intent_remove_comment", "human"), event("intent_change_comment", "human")],
    } as const;

    expect(summarizeArtifactDiff(receipt, protection)).toMatchObject({
      status: "fail",
      counts: {
        removed: 2,
        changed: 1,
        protectedLosses: 1,
        protectedChanges: 1,
      },
    });
    expect(
      summarizeArtifactDiff(receipt, {
        ...protection,
        intents: [
          ...protection.intents,
          intent("intent_authorized_remove", "remove", "protected.remove"),
        ],
        events: [...protection.events, event("intent_authorized_remove", "human")],
      }),
    ).toMatchObject({ counts: { protectedLosses: 0, protectedChanges: 1 } });
  });

  it("keeps a valid semantic-negative as a bounded summary result", () => {
    const path = fixture(
      "invalid.html",
      '<main><section data-tweak-id="decision.auth">[[ANSWER]]</section></main>',
    );
    const receipt = lintArtifactFile(path);
    const summary = summarizeArtifactLint(receipt, ["decision.auth"], {
      artifactId: "artifact_1",
      intents: [intent("intent_comment", "comment", "decision.auth")],
      events: [event("intent_comment", "human")],
    });

    expect(summary).toMatchObject({
      status: "fail",
      counts: {
        nodes: 1,
        anchors: 1,
        protectedAnchors: 1,
        findings: 2,
        errors: 2,
        warnings: 0,
        info: 0,
      },
    });
    expect(arrayPaths(summary)).toEqual([]);
  });
});

function emptyProtection() {
  return { artifactId: null, intents: [], events: [] } as const;
}

function fixture(name: string, contents: string): string {
  const directory = mkdtempSync(join(tmpdir(), "tweakloop-summary-"));
  const path = join(directory, name);
  writeFileSync(path, contents);
  return path;
}

function html(nodes: readonly (readonly [string, string])[]): string {
  return `<main>${nodes
    .map(
      ([id, text]) => `<section data-tweak-id="${id}" data-tweak-kind="section">${text}</section>`,
    )
    .join("")}</main>`;
}

function diffReceipt(path: string, count: number): ArtifactDiffReceipt {
  return {
    status: "pass",
    path,
    format: "html",
    baseline: "empty",
    beforeRevisionId: null,
    artifactId: null,
    added: Array.from({ length: count }, (_, index) => ({
      id: `node_${index}`,
      kind: "section",
      parentId: null,
      order: index,
      contentFingerprint: `sha256:${String(index).padStart(64, "0")}`,
    })),
    removed: [],
    changed: [],
    moved: [],
    kindChanged: [],
    unchanged: [],
    collisions: [],
    unaddressable: [],
    possibleRenames: [],
  };
}

function intent(intentId: string, intentType: string, semanticId: string): SnapshotIntent {
  return {
    intentId,
    batchId: "batch_1",
    artifactId: "artifact_1",
    revisionId: "revision_1",
    intentType,
    target: { semanticId },
    body: {},
    status: "submitted",
    createdSeq: 1,
  };
}

function event(intentId: string, kind: "human" | "agent"): EventEnvelope {
  return {
    seq: 1,
    eventId: `event_${intentId}`,
    workspaceId: "workspace_1",
    streamType: "intent",
    streamId: intentId,
    streamVersion: 1,
    eventType: "intent.created",
    schemaVersion: 1,
    recordedAt: "2026-08-08T00:00:00.000Z",
    actor: { kind, id: `${kind}_1` },
    causationId: null,
    correlationId: null,
    payload: { intentId },
  };
}

function arrayPaths(value: unknown, prefix = "root"): string[] {
  if (Array.isArray(value)) return [prefix];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => arrayPaths(child, `${prefix}.${key}`));
}
