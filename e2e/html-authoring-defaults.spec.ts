import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const starterPath = fileURLToPath(
  new URL("../skills/tweakloop/assets/minimal-plan-starter.html", import.meta.url),
);

function renderedStarter(): string {
  return readFileSync(starterPath, "utf8").replace(
    /\[\[([A-Z0-9_]+)\]\]/g,
    (_token, name: string) =>
      ({
        TITLE: "Replace the metrics store safely",
        DOCUMENT_TYPE: "Technical design",
        STATUS: "Ready for review",
        ONE_SENTENCE_PURPOSE:
          "Prove whether the candidate preserves query meaning and operational recovery before a production decision.",
        OWNER: "Aggregation team",
        DATE: "4 August 2026",
        DECISION_QUESTION: "Should the team run the bounded proof of concept?",
        RECOMMENDATION: "Run one shadow workload with explicit stop conditions.",
        DECISION_DATE: "After the evidence review",
        IMMEDIATE_NEXT_STEP: "Approve the four proof gates",
        CONFIDENCE_AND_REASON: "Medium · runtime evidence is still required",
        SUCCESS_SUMMARY: "The proof is useful only if it can change the migration decision.",
        OUTCOME_1: "Equivalent answers",
        OUTCOME_1_PROOF: "Golden queries match the baseline.",
        OUTCOME_2: "Bounded latency",
        OUTCOME_2_PROOF: "Cold and warm percentiles are recorded.",
        OUTCOME_3: "Recoverable failure",
        OUTCOME_3_PROOF: "A restore drill meets the accepted objective.",
        OUTCOME_4: "Decision-ready cost",
        OUTCOME_4_PROOF: "The measured workload has an attributable cost.",
        APPROACH_SUMMARY: "Baseline, shadow, break, then decide—without production traffic.",
        IMPLEMENTATION_DETAIL:
          "Keep the baseline authoritative and replay the same immutable fixture.",
        ALTERNATIVE_ANALYSIS: "A direct migration cannot isolate semantic and operational risk.",
        STOP_CONDITION: "Stop if one golden query changes meaning.",
        RISK: "High-cardinality workload is under-represented",
        RISK_SIGNAL: "Plans diverge under the production-shaped fixture",
        RISK_RESPONSE: "Expand the fixture before making a decision",
        RISK_OWNER: "Data platform",
      })[name] ?? name.toLowerCase().replaceAll("_", " "),
  );
}

test("the shipped HTML starter is readable, responsive, accessible, and progressively disclosed", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) externalRequests.push(request.url());
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(renderedStarter());

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Replace the metrics store safely",
  );
  await expect(
    page.getByRole("heading", { name: "Should the team run the bounded proof of concept?" }),
  ).toBeVisible();
  await expect(page.getByText("Approve the four proof gates", { exact: true })).toBeVisible();
  await expect(page.getByText("Golden queries match the baseline.")).toBeVisible();
  await expect(page.getByText("Keep the baseline authoritative")).toBeHidden();

  const detail = page.getByText("Open implementation detail", { exact: true });
  await detail.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("Keep the baseline authoritative")).toBeVisible();

  const semanticIds = await page
    .locator("[data-tweak-id]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-tweak-id")));
  expect(new Set(semanticIds).size).toBe(semanticIds.length);
  expect(semanticIds).toContain("plan.decision");
  expect(externalRequests).toEqual([]);

  await page.setViewportSize({ width: 360, height: 800 });
  const narrow = await page.evaluate(() => {
    const decision = document.querySelector(".decision");
    const steps = document.querySelector(".steps");
    if (!(decision instanceof HTMLElement) || !(steps instanceof HTMLElement)) {
      throw new Error("starter layout regions are missing");
    }
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      decisionTracks: getComputedStyle(decision).gridTemplateColumns.trim().split(/\s+/).length,
      stepTracks: getComputedStyle(steps).gridTemplateColumns.trim().split(/\s+/).length,
    };
  });
  expect(narrow.documentWidth).toBeLessThanOrEqual(narrow.viewportWidth);
  expect(narrow.decisionTracks).toBe(1);
  expect(narrow.stepTracks).toBe(1);

  await page.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior))
    .toBe("auto");
});
