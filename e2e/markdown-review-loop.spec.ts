import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const agent = "agent:markdown-browser";

const markdownV1 = `# Aggregation POC {#aggregation-poc}

## MVP decision {#decision-database}

Use Azure PostgreSQL Flexible Server with TimescaleDB, but keep the decision gate vague.

## Proof {#proof-gates}

- Query parity
- Recovery
`;

const markdownV2 = markdownV1.replace(
  "Use Azure PostgreSQL Flexible Server with TimescaleDB, but keep the decision gate vague.",
  "Use Azure PostgreSQL Flexible Server with TimescaleDB only if query parity, fail-open isolation, recovery, and measured cost all pass.",
);

test("Markdown completes the browser comment → agent revision → human decision loop", async ({
  page,
}) => {
  const stateDir = mkdtempSync(join(tmpdir(), "tweakloop-markdown-browser-state-"));
  const workspaceDir = mkdtempSync(join(tmpdir(), "tweakloop-markdown-browser-workspace-"));
  const sourcePath = join(workspaceDir, "aggregation-poc.md");
  const environment = { ...process.env, TWEAKLOOP_STATE_DIR: stateDir };
  const tweak = (arguments_: string[]): string =>
    execFileSync(process.execPath, [cli, "--workspace", workspaceDir, ...arguments_], {
      env: environment,
      encoding: "utf8",
    });

  try {
    writeFileSync(sourcePath, markdownV1);
    const opened = JSON.parse(
      tweak(["--json", "open", sourcePath, "--agent", agent, "--no-browser"]),
    );

    await page.goto(opened.url);
    await expect(page.getByTestId("connection")).toHaveText("synced");
    await expect(page.getByTestId("artifact-item")).toContainText("markdown");

    const frame = page.frameLocator('[data-testid="viewer-frame"]');
    const decision = frame.locator('[data-tweak-id="decision-database"]');
    await expect(decision).toContainText("MVP decision");

    await page.getByTestId("mode-toggle").click();
    await expect(page.getByTestId("mode-toggle")).toHaveText(/Comment/);
    await decision.click();
    await page
      .getByTestId("draft-text")
      .fill("Make the database decision executable with four explicit proof gates.");
    await page.getByTestId("draft-add").click();
    await expect(page.getByTestId("draft-item")).toHaveCount(1);
    await page.getByTestId("draft-send-now").click();

    await page.getByTestId("rail-tab-feedback").click();
    const comment = page
      .getByTestId("intent-item")
      .filter({ hasText: "Make the database decision executable with four explicit proof gates." });
    await expect(comment).toHaveCount(1);

    type DurableEvent = {
      eventType: string;
      payload: Record<string, unknown>;
    };
    const durableEvents = (): DurableEvent[] =>
      JSON.parse(tweak(["--json", "events", "list"])).events as DurableEvent[];
    const commentEvents = durableEvents();
    const createdIntents = commentEvents.filter((event) => event.eventType === "intent.created");
    expect(createdIntents).toHaveLength(1);
    expect(createdIntents[0]?.payload).toMatchObject({ intentType: "comment" });
    expect(createdIntents[0]?.payload).not.toHaveProperty("workId");
    expect(commentEvents.filter((event) => event.eventType === "work.created")).toHaveLength(0);
    expect(JSON.parse(tweak(["--json", "work", "list"])).work).toHaveLength(0);

    const commentIntentId = createdIntents[0]?.payload.intentId;
    expect(commentIntentId).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );
    type TrackCommand = {
      protocol: string;
      commandId: string;
      idempotencyKey: string;
      workspaceId: string;
      actor: { kind: string; id: string };
      type: string;
      payload: {
        workId: string;
        intentIds: string[];
        decisionId: string;
      };
    };
    const trackAttempts: TrackCommand[] = [];
    await page.route("**/api/v1/commands", async (route) => {
      const command = route.request().postDataJSON() as TrackCommand;
      if (command.type === "work.create-from-intents") trackAttempts.push(command);
      await route.continue();
    });

    const track = comment.getByTestId("comment-track");
    await expect(track).toHaveText("Track as task");
    await track.click();
    await expect.poll(() => trackAttempts.length).toBe(1);
    await expect.poll(() => JSON.parse(tweak(["--json", "work", "list"])).work.length).toBe(1);
    expect(durableEvents().filter((event) => event.eventType === "work.created")).toHaveLength(1);
    await page.unroute("**/api/v1/commands");

    const [firstTrack] = trackAttempts;
    expect(firstTrack).toMatchObject({
      type: "work.create-from-intents",
      payload: { intentIds: [commentIntentId] },
    });
    const retry = await page.evaluate(async (command) => {
      const response = await fetch("/api/v1/commands", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      return {
        status: response.status,
        body: (await response.json()) as { status?: string },
      };
    }, firstTrack);
    expect(retry).toMatchObject({ status: 200, body: { status: "accepted" } });

    const trackedEvents = durableEvents();
    const workCreatedEvents = trackedEvents.filter((event) => event.eventType === "work.created");
    expect(workCreatedEvents).toHaveLength(1);
    expect(workCreatedEvents[0]?.payload).toMatchObject({
      workId: firstTrack?.payload.workId,
      intentIds: [commentIntentId],
      sourceMessageId: null,
    });
    expect(Object.keys(workCreatedEvents[0]?.payload ?? {}).sort()).toEqual(
      [
        "artifactId",
        "assigneeAgentId",
        "baseRevisionId",
        "intentIds",
        "sessionId",
        "sourceMessageId",
        "type",
        "workId",
      ].sort(),
    );
    const trackedWork = JSON.parse(tweak(["--json", "work", "list", "--full"])).work;
    expect(trackedWork).toHaveLength(1);
    expect(trackedWork[0]).toMatchObject({
      workId: firstTrack?.payload.workId,
      intentIds: [commentIntentId],
    });

    await page.getByTestId("rail-tab-work").click();
    await expect(page.getByTestId("work-item")).toHaveCount(1);
    await expect(page.getByTestId("work-item")).toContainText(/open/i);

    const listed = JSON.parse(tweak(["--json", "work", "list"]));
    expect(listed.work).toHaveLength(1);
    const claim = JSON.parse(
      tweak([
        "--json",
        "work",
        "claim",
        "--work",
        listed.work[0].workId,
        "--agent",
        agent,
        "--process",
        "process-markdown-browser",
      ]),
    );
    expect(claim.sourcePath).toBe(sourcePath);
    await expect(page.getByTestId("work-item")).toContainText(/claimed/i);
    await expect(page.getByTestId("work-item").locator(".task-spinner")).toHaveCount(0);

    writeFileSync(sourcePath, markdownV2);
    const published = JSON.parse(tweak(["--json", "publish", sourcePath, "--agent", agent]));
    expect(published.unchanged).toBe(false);
    tweak([
      "--json",
      "work",
      "complete",
      claim.workId,
      "--claim",
      claim.claimId,
      "--agent",
      agent,
      "--revision-id",
      published.revisionId,
      "--summary",
      "Made the Markdown decision executable with query parity, isolation, recovery, and cost gates.",
    ]);

    await expect(page.getByTestId("work-item")).toHaveAttribute("data-work-status", "addressed", {
      timeout: 10_000,
    });
    await expect(page.getByTestId("work-item")).toHaveAttribute("data-decision-status", "pending");
    await expect(frame.locator('[data-tweak-id="decision-database"]')).toContainText(
      "MVP decision",
    );
    await expect(frame.locator("body")).toContainText("query parity, fail-open isolation");

    await page.getByTestId("decision-accept").click();
    await expect(page.getByTestId("work-item")).toContainText(/accepted/i, { timeout: 10_000 });

    const accepted = JSON.parse(tweak(["--json", "work", "list", "--status", "all", "--full"]))
      .work[0];
    expect(accepted.decision).toBe("accepted");
    expect(accepted.result.revisionId).toBe(published.revisionId);
  } finally {
    try {
      tweak(["daemon", "stop"]);
    } catch {
      // The test may fail before daemon startup.
    }
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
