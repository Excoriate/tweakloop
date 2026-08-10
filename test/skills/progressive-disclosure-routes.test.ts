import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const skillPath = join(root, "skills/tweakloop/SKILL.md");
const core = readFileSync(skillPath, "utf8");

const optionalRoutes = [
  ["authoring", "references/authoring-html.md", "open/recovery"],
  ["chat", "references/chat-and-attachments.md", "board internals"],
  ["progress", "references/live-progress.md", "receipt/acceptance"],
  ["session", "references/session-handoff.md", "export/restore"],
  ["workspace", "references/workspace-export-restore.md", "session resume"],
  ["recovery", "references/recovery-and-inspection.md", "healthy review"],
  ["architecture", "../architecture-diagram/SKILL.md", "raw JSON"],
  ["whiteboard", "../excalidraw/SKILL.md", "architecture only"],
] as const;

function routeRow(path: string, text = core): string | undefined {
  return text.split("\n").find((line) => line.startsWith("|") && line.includes(`](${path})`));
}

function residentFailures(text: string): string[] {
  const failures: string[] = [];
  const required = [
    "in a source checkout",
    "run `just build`",
    "node <repo-root>/dist/cli/index.js",
    "Build failure stops",
    "Resolve one absolute workspace root",
    "status --summary --json",
    "`running`: preserve it",
    "source build alone",
    "NEVER** authorizes restart",
    "browser/SSE origin",
    "daemon start --json",
    "Explicit incompatibility",
    "old shell is stale",
    "retain both",
    "resolve durable identity before authoring or overwriting",
    "tweak artifacts list --json",
    "same logical document stays on",
    "unregistered path and new artifact ID",
    "Ordinary content preference waits until revision 1",
    "ordinary five-step review loop",
    "tweak next --session <sessionId> --wait --timeout 300000 --json",
    "--presence working --until-work-settled <workId>",
    "claiming live Working, not durable work",
    "nonempty intent IDs become addressed",
    "tweak publish <file> --complete <workId>",
    "Account for every `intentId`",
    "human Accept",
  ];
  for (const marker of required) {
    if (!text.includes(marker)) failures.push(marker);
  }
  return failures;
}

describe("progressive-disclosure route controls", () => {
  it.each(optionalRoutes)(
    "%s has one positive route and names its wrong neighbor",
    (_name, path, wrongNeighbor) => {
      const row = routeRow(path);
      expect(row, `missing route for ${path}`).toBeDefined();
      const expectedMentions = 1;
      expect(core.match(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(
        expectedMentions,
      );
      expect(row).toContain(wrongNeighbor);
    },
  );

  it("does not route an ordinary ready-file review to specialist references", () => {
    const authoringRow = routeRow("references/authoring-html.md");
    expect(authoringRow).toContain("HTML/Markdown structure");
    expect(core).toContain("After identity, lint, diff, and check pass");
    expect(core).not.toContain("tweak workspace export <new-directory>");
    expect(core).not.toContain("whiteboard workspace checkout");
  });

  it("keeps work completion and typed blocking questions resident, not in wrong neighbors", () => {
    expect(core).toContain("tweak publish <file> --complete <workId>");
    expect(core).not.toContain("tweak workspace export <new-directory>");
    expect(core).toContain("Ambiguous identity, authority, or bytes");
    expect(core).toContain("Ordinary content preference waits until revision 1");
    expect(core).toMatch(/2–8 option choice may use\s+`tweak question ask`/);
  });

  it("routes active work to progress truth without loading it for receipt-only chat", () => {
    const progressRow = routeRow("references/live-progress.md");
    expect(progressRow).toContain("Active work, lease, progress, pause, or block");
    expect(progressRow).toContain("receipt/acceptance");
    expect(routeRow("references/chat-and-attachments.md")).not.toContain("progress");
  });

  it("fails the resident contract when either load-bearing gate is ablated", () => {
    expect(residentFailures(core)).toEqual([]);

    const noInvocation = core.replace(/## Gate 1[\s\S]*?(?=## Gate 2)/, "## Gate 1 — ablated\n\n");
    expect(residentFailures(noInvocation)).toContain("in a source checkout");
    expect(residentFailures(noInvocation)).toContain("node <repo-root>/dist/cli/index.js");

    const noIdentity = core.replace(
      /## Gate 2[\s\S]*?(?=## Reference Map)/,
      "## Gate 2 — ablated\n\n",
    );
    expect(residentFailures(noIdentity)).toContain(
      "resolve durable identity before authoring or overwriting",
    );
    expect(residentFailures(noIdentity)).toContain("same logical document stays on");

    const noLiveTurnGate = core.replace(
      /3\. \*\*Revise under the live-turn gate\.\*\*[\s\S]*?(?=4\. \*\*Publish and complete\.\*\*)/,
      "3. **Revise.** Address every intent.\n",
    );
    expect(routeRow("references/live-progress.md", noLiveTurnGate)).toBeDefined();
    expect(residentFailures(noLiveTurnGate)).toContain(
      "--presence working --until-work-settled <workId>",
    );
  });

  it.each(optionalRoutes)("%s ablation removes its only retrieval route", (_name, path) => {
    const row = routeRow(path);
    expect(row).toBeDefined();
    const ablated = core.replace(`${row}\n`, "");
    expect(routeRow(path, ablated)).toBeUndefined();
  });
});
