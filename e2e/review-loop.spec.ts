import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { WorkspaceExportManifest } from "../src/protocol/workspace-export.js";
import type { WorkspaceExportStableResult } from "../src/workspace/export-journal.js";
import {
  validateWorkspaceBundleEnvelope,
  WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL,
  type WorkspaceBundleEnvelope,
  type WorkspaceBundleValidationResult,
} from "../src/workspace/files.js";

declare global {
  interface Window {
    __tweakloopHidden: boolean;
    __tweakloopNotifications: Array<{
      title: string;
      options: unknown;
      onclick: null | (() => void);
    }>;
  }
}

/**
 * The v0.1 vertical slice, end to end through the real product:
 * agent publishes a plan → human reviews it in the browser shell
 * (immutable revision in a sandboxed iframe, typed intents via the
 * bridge) → agent claims the work over the CLI, revises, publishes R2,
 * completes with a summary → the human watches every step live.
 */

const cli = fileURLToPath(new URL("../dist/cli/index.js", import.meta.url));
const PRIMARY_AGENT = "agent:final-independent-verification";

function contrastRatio(first: string, second: string): number {
  const luminance = (hex: string) => {
    const channels = hex
      .replace("#", "")
      .match(/.{2}/g)
      ?.map((channel) => Number.parseInt(channel, 16) / 255);
    if (channels?.length !== 3) throw new Error(`Expected #rrggbb, received ${hex}`);
    const linear = channels.map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const PLAN_V1 = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ADO → GitHub migration CLI — Plan</title></head>
<body>
<h1>ADO → GitHub migration CLI — Plan</h1>
<section data-tweak-id="plan.overview" data-tweak-kind="plan-section">
  <h2>Overview</h2>
  <p>A CLI that migrates Azure DevOps project configuration to GitHub.</p>
</section>
<section data-tweak-id="plan.phase.migration" data-tweak-kind="plan-phase">
  <h2>Phase 2 — Migration</h2>
  <p>Export ADO pipelines, variable groups and service connections; import into GitHub Actions.</p>
</section>
<section data-tweak-id="decision.auth" data-tweak-kind="decision">
  <h2>Decision: Authentication</h2>
  <p>Use personal access tokens for both ADO and GitHub.</p>
</section>
</body>
</html>
`;

const PLAN_V2 = PLAN_V1.replace(
  "<p>Use personal access tokens for both ADO and GitHub.</p>",
  "<p>Authenticate with GitHub OAuth apps only; PATs are forbidden.</p>",
).replace(
  "<p>Export ADO pipelines, variable groups and service connections; import into GitHub Actions.</p>",
  "<p>Export ADO pipelines and variable groups into GitHub Actions. Service connections map to GitHub environments with OIDC federation — one environment per connection, credentials never copied.</p>",
);

const CONTEXT_DOCUMENT = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Context collaboration</title></head>
<body>
<h1>Context collaboration</h1>
<section data-tweak-id="context.overview" data-tweak-kind="plan-section" aria-labelledby="context-overview-title">
  <h2 id="context-overview-title">Overview</h2>
  <p>The agent and human revise this exact passage together.</p>
</section>
</body>
</html>
`;

const EMPTY_BOARD = JSON.stringify({
  type: "excalidraw",
  version: 2,
  source: "https://tweakloop.local",
  elements: [],
  appState: { viewBackgroundColor: "#ffffff" },
  files: {},
});

let stateDir: string;
let workspaceDir: string;
let env: NodeJS.ProcessEnv;

function tweak(args: string[]): string {
  return execFileSync(process.execPath, [cli, "--workspace", workspaceDir, ...args], {
    env,
    encoding: "utf8",
  });
}

type DurableEvent = {
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
};

type WorkspaceExportResponse = WorkspaceExportManifest &
  Readonly<{
    bundle: WorkspaceBundleEnvelope;
    operation: WorkspaceExportStableResult;
    alreadyExported: boolean;
  }>;

function expectBoundWorkspaceExport(
  response: WorkspaceExportResponse,
  collaborationManifest: WorkspaceExportManifest,
  validated: WorkspaceBundleValidationResult,
  destination: string,
): void {
  const { bundle, operation, alreadyExported, ...collaborationSnapshot } = response;
  expect(collaborationSnapshot).toEqual(collaborationManifest);
  expect(validated.collaborationManifest).toEqual(collaborationManifest);
  expect(bundle).toEqual(validated.envelope);
  expect(bundle.protocol).toBe(WORKSPACE_BUNDLE_ENVELOPE_PROTOCOL);
  expect(alreadyExported).toBe(false);
  expect(operation).toMatchObject({
    protocol: "tweakloop.workspace-export-result/v1",
    sourceWorkspaceId: collaborationManifest.source.workspaceId,
    sourceCheckpoint: collaborationManifest.capturedSeq,
    destination,
    bundleId: validated.envelope.bundleId,
    collaborationManifestHash: validated.envelope.collaboration.manifestHash,
    workspaceFilesManifestHash: validated.envelope.workspaceFiles?.manifestHash ?? null,
  });
}

function durableEvents(after = 0): DurableEvent[] {
  return JSON.parse(tweak(["--json", "events", "list", "--after", String(after)]))
    .events as DurableEvent[];
}

async function trackCommentAsTask(page: Page, text: string, afterSeq: number): Promise<string> {
  const commentEvents = durableEvents(afterSeq);
  const intentCreated = commentEvents.filter((event) => event.eventType === "intent.created");
  expect(intentCreated).toHaveLength(1);
  expect(intentCreated[0]?.payload).toMatchObject({ intentType: "comment" });
  expect(commentEvents.filter((event) => event.eventType === "work.created")).toHaveLength(0);

  await page.getByTestId("rail-tab-feedback").click();
  const comment = page.getByTestId("intent-item").filter({ hasText: text });
  await expect(comment).toHaveCount(1);
  await expect(page.getByTestId("work-item")).toHaveCount(0);
  const intentId = String(intentCreated[0]?.payload.intentId);
  const track = comment.getByTestId("comment-track");
  await expect(track).toHaveText("Track as task");
  await track.click();

  await expect
    .poll(() => durableEvents(afterSeq).filter((event) => event.eventType === "work.created"))
    .toHaveLength(1);
  const workCreated = durableEvents(afterSeq).find((event) => event.eventType === "work.created");
  expect(workCreated?.payload).toMatchObject({ intentIds: [intentId] });
  const workId = String(workCreated?.payload.workId);
  const relatedWork = JSON.parse(
    tweak(["--json", "work", "list", "--status", "all", "--full"]),
  ).work.filter((work: { workId: string }) => work.workId === workId);
  expect(relatedWork).toEqual([expect.objectContaining({ workId, intentIds: [intentId] })]);
  await expect(page.getByTestId("work-item")).toHaveCount(1);
  return workId;
}

test.beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), "tweakloop-e2e-state-"));
  workspaceDir = mkdtempSync(join(tmpdir(), "tweakloop-e2e-ws-"));
  env = { ...process.env, TWEAKLOOP_STATE_DIR: stateDir };
  writeFileSync(join(workspaceDir, "plan.html"), PLAN_V1);
});

test.afterAll(() => {
  try {
    tweak(["daemon", "stop"]);
  } catch {
    // already stopped
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workspaceDir, { recursive: true, force: true });
});

test("human review → typed intents → agent claim → revision → completion", async ({ page }) => {
  // Agent publishes R1 and mints the human's one-time bootstrap URL.
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      join(workspaceDir, "plan.html"),
      "--agent",
      PRIMARY_AGENT,
      "--no-browser",
    ]),
  );
  expect(opened.seq).toBe(1);

  await page.addInitScript(() => {
    window.__tweakloopNotifications = [];
    window.__tweakloopHidden = false;
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: null | (() => void) = null;
      options: unknown;
      title: string;
      constructor(title: string, options: unknown) {
        this.title = title;
        this.options = options;
        window.__tweakloopNotifications.push(this);
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: FakeNotification,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (window.__tweakloopHidden ? "hidden" : "visible"),
    });
  });

  await page.goto(opened.url);
  await expect(page).toHaveURL(/\/app\?artifact=artifact_/);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await page.getByTestId("notifications-toggle").click();
  await expect(page.getByTestId("notifications-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        await document.fonts.ready;
        return {
          assistantLoaded: document.fonts.check("14px Assistant"),
          cascadiaLoaded: document.fonts.check("12px 'Cascadia Code'"),
          bodyFamily: getComputedStyle(document.body).fontFamily,
          metadataFamily: getComputedStyle(document.querySelector(".workspace") ?? document.body)
            .fontFamily,
        };
      }),
    )
    .toMatchObject({
      assistantLoaded: true,
      cascadiaLoaded: true,
      bodyFamily: /Assistant/,
      metadataFamily: /Cascadia Code/,
    });

  // Collaboration is one explicit viewport: Chat owns the rail by default,
  // the diagonal affordance visibly widens it, and the view tabs never mix content.
  await expect(page.locator("#section-chat")).toBeVisible();
  await expect(page.locator("#section-work")).toBeHidden();
  await expect(page.locator("#section-feedback")).toBeHidden();
  await expect(page.locator("#chat-heading")).toHaveCount(0);
  await expect(page.getByRole("tab")).toHaveCount(3);
  await expect(page.getByTestId("rail-tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("rail-tab-chat")).toHaveAttribute("tabindex", "0");
  await page.getByTestId("rail-tab-chat").focus();
  await page.getByTestId("rail-tab-chat").press("ArrowLeft");
  await expect(page.getByTestId("rail-tab-feedback")).toBeFocused();
  await expect(page.getByTestId("rail-tab-feedback")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("rail-tab-feedback").press("Home");
  await expect(page.getByTestId("rail-tab-work")).toBeFocused();
  await expect(page.locator("#section-work")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("tweakloop-collaboration-tab")))
    .toBe("work");
  await page.reload();
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await expect(page.getByTestId("rail-tab-work")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#section-work")).toBeVisible();
  await page.getByTestId("rail-tab-work").press("End");
  await expect(page.getByTestId("rail-tab-chat")).toBeFocused();
  await expect(page.locator("#section-chat")).toBeVisible();
  await expect(page.getByTestId("chat-send")).toBeDisabled();
  await expect(page.getByTestId("chat-send")).toHaveAttribute(
    "title",
    "Write a message or add context before sending",
  );
  await expect(page.locator("#chat-send-requirement")).toBeVisible();
  await page.setViewportSize({ width: 1242, height: 698 });
  const chatGeometry = await page.evaluate(() => {
    const rail = document.querySelector("#agent-rail")?.getBoundingClientRect();
    const messages = document.querySelector("#chat-list")?.getBoundingClientRect();
    const height = (selector: string) =>
      document.querySelector(selector)?.getBoundingClientRect().height ?? 0;
    return {
      railHeight: rail?.height ?? 0,
      messagesHeight: messages?.height ?? 0,
      headerHeight: height(".agent-header"),
      taskbarHeight: height(".dynamic-taskbar"),
      navHeight: height(".collaboration-nav"),
      sectionHeight: height(".chat-section"),
      composerHeight: height(".chat-composer-shell"),
      ratio: rail && messages ? messages.height / rail.height : 0,
    };
  });
  expect(
    chatGeometry.ratio,
    `Chat geometry: ${JSON.stringify(chatGeometry)}`,
  ).toBeGreaterThanOrEqual(0.55);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId("chat-expand").click();
  await expect(page.getByTestId("workspace-shell")).toHaveClass(/chat-expanded/);
  await expect(page.getByTestId("chat-expand")).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workspace-shell")).not.toHaveClass(/chat-expanded/);
  await expect(page.getByTestId("chat-expand")).toBeFocused();
  await page.setViewportSize({ width: 320, height: 720 });
  const narrowGeometry = await page.evaluate(() => {
    const visible = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
    };
    const controls = [...document.querySelectorAll<HTMLElement>(".toolbar button, .toolbar select")]
      .filter(visible)
      .map((element) => ({ id: element.id, rect: element.getBoundingClientRect().toJSON() }));
    const escaped = controls.filter(
      ({ rect }) => rect.left < 0 || rect.right > innerWidth || rect.width <= 0,
    );
    const toolbar = document.querySelector(".toolbar")?.getBoundingClientRect();
    const documents = document.querySelector("#outline-rail")?.getBoundingClientRect();
    return {
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth,
      escaped,
      toolbarBottom: toolbar?.bottom ?? 0,
      documentsTop: documents?.top ?? 0,
      actionableFont: Number.parseFloat(
        getComputedStyle(document.querySelector("#rail-tab-chat") as Element).fontSize,
      ),
      metadataFont: Number.parseFloat(
        getComputedStyle(document.querySelector(".meta") as Element).fontSize,
      ),
    };
  });
  expect(narrowGeometry.scrollWidth).toBeLessThanOrEqual(narrowGeometry.innerWidth);
  expect(narrowGeometry.escaped).toEqual([]);
  expect(narrowGeometry.documentsTop).toBeGreaterThanOrEqual(narrowGeometry.toolbarBottom);
  expect(narrowGeometry.actionableFont).toBeGreaterThanOrEqual(14);
  expect(narrowGeometry.metadataFont).toBeGreaterThanOrEqual(12);
  await page.setViewportSize({ width: 900, height: 800 });
  await expect(page.getByTestId("chat-expand")).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByTestId("rail-tab-work").click();
  await expect(page.getByTestId("chat-expand")).toBeHidden();
  await expect(page.locator("#section-work")).toBeVisible();
  await expect(page.locator("#section-feedback")).toBeHidden();
  await expect(page.locator("#section-chat")).toBeHidden();
  await page.getByTestId("rail-tab-feedback").click();
  await expect(page.locator("#section-work")).toBeHidden();
  await expect(page.locator("#section-feedback")).toBeVisible();
  await expect(page.locator("#section-chat")).toBeHidden();
  await page.getByTestId("rail-tab-chat").click();
  await expect(page.locator("#section-chat")).toBeVisible();

  // The immutable revision renders in the sandboxed iframe from the artifact origin.
  await expect(page.getByTestId("artifact-item")).toHaveCount(1);
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  await expect(frame.locator('[data-tweak-id="decision.auth"]')).toBeVisible();
  await expect(frame.locator('[data-tweak-id="decision.auth"]')).toContainText(
    "personal access tokens",
  );

  // Comment: a replace-text intent on the auth decision...
  await page.getByTestId("mode-toggle").click();
  await expect(page.getByTestId("mode-toggle")).toHaveText(/Comment/);
  await frame.locator('[data-tweak-id="decision.auth"]').click();
  await expect(page.getByTestId("draft-form")).toBeVisible();
  await page.locator(".advanced-intent summary").click();
  await page.getByTestId("draft-intent-type").selectOption("replace-text");
  await page
    .getByTestId("draft-text")
    .fill("Authenticate with GitHub OAuth apps only; PATs are forbidden.");
  await page.getByTestId("draft-add").click();
  await expect(page.getByTestId("draft-item")).toHaveCount(1);

  // ...and a question on the migration phase.
  await frame.locator('[data-tweak-id="plan.phase.migration"]').click();
  await expect(page.getByTestId("draft-form")).toBeVisible();
  await page.getByTestId("draft-intent-type").selectOption("question");
  await page
    .getByTestId("draft-text")
    .fill("How are ADO service connections mapped to GitHub environments?");
  await page.getByTestId("draft-add").click();
  await expect(page.getByTestId("draft-item")).toHaveCount(2);

  // A third progressive note joins the local TaskBar immediately.
  await frame.locator('[data-tweak-id="plan.overview"]').click();
  await expect(page.getByTestId("draft-form")).toBeVisible();
  await page.getByTestId("draft-intent-type").selectOption("comment");
  await page.getByTestId("draft-text").fill("Keep the opening description concise.");
  await page.getByTestId("draft-add").click();
  await expect(page.getByTestId("draft-item")).toHaveCount(3);
  await expect(page.locator("#taskbar-drafts")).toHaveText("3");

  // The human can dispatch one comment now, then submit the remainder as one batch.
  const firstCommentCursor = durableEvents().at(-1)?.seq ?? 0;
  await page
    .getByTestId("draft-item")
    .filter({ hasText: "Keep the opening description concise." })
    .getByTestId("draft-send-now")
    .click();
  await expect(page.getByTestId("draft-item")).toHaveCount(2);
  await expect(page.locator("#taskbar-drafts")).toHaveText("2");
  await trackCommentAsTask(page, "Keep the opening description concise.", firstCommentCursor);

  await page.getByTestId("submit-review").click();
  await expect(page.getByTestId("draft-item")).toHaveCount(0);
  await expect(page.locator("#taskbar-drafts")).toHaveText("0");
  await page.getByTestId("rail-tab-feedback").click();
  await expect(page.getByTestId("intent-item")).toHaveCount(3);
  await page.getByTestId("rail-tab-work").click();
  await expect(page.getByTestId("work-item")).toHaveCount(2);
  await expect(page.getByTestId("work-item").filter({ hasText: /open/i })).toHaveCount(2);

  // The agent can claim the granular item and the bounded batch explicitly.
  const listed = JSON.parse(tweak(["--json", "work", "list"]));
  const claims = listed.work.map((item: { workId: string }) =>
    JSON.parse(
      tweak([
        "--json",
        "work",
        "claim",
        "--work",
        item.workId,
        "--agent",
        PRIMARY_AGENT,
        "--process",
        "process-e2e",
      ]),
    ),
  );
  expect(claims).toHaveLength(2);
  expect(claims.every((claim: { status: string }) => claim.status === "claimed")).toBe(true);
  expect(claims.flatMap((claim: { intents: unknown[] }) => claim.intents)).toHaveLength(3);
  const replaceIntent = claims
    .flatMap((claim: { intents: Array<{ intentType: string }> }) => claim.intents)
    .find((intent: { intentType: string }) => intent.intentType === "replace-text");
  expect(replaceIntent.target.semanticId).toBe("decision.auth");
  expect(replaceIntent.body.value).toContain("OAuth apps only");
  expect(
    claims.every(
      (claim: { sourcePath: string }) => claim.sourcePath === join(workspaceDir, "plan.html"),
    ),
  ).toBe(true);

  // A claim is ownership; explicit live working presence is the separate activity fact.
  tweak(["presence", "working", "--agent", PRIMARY_AGENT, "--ttl", "30000"]);
  await expect(page.getByTestId("work-item").filter({ hasText: /working/i })).toHaveCount(2, {
    timeout: 10_000,
  });
  await expect(page.locator(".task-spinner")).not.toHaveCount(0);
  tweak(["presence", "idle", "--agent", PRIMARY_AGENT]);
  await expect(page.locator("#agent-status")).not.toHaveText("Working", { timeout: 6_000 });

  // The agent revises the plan, publishes R2, and completes the work.
  writeFileSync(join(workspaceDir, "plan.html"), PLAN_V2);
  const published = JSON.parse(
    tweak(["--json", "publish", join(workspaceDir, "plan.html"), "--agent", PRIMARY_AGENT]),
  );
  expect(published.seq).toBe(2);
  expect(published.unchanged).toBe(false);

  await page.evaluate(() => {
    window.__tweakloopHidden = true;
  });

  const completions = claims.map((claim: { workId: string; claimId: string }) =>
    JSON.parse(
      tweak([
        "--json",
        "work",
        "complete",
        claim.workId,
        "--claim",
        claim.claimId,
        "--agent",
        PRIMARY_AGENT,
        "--revision-id",
        published.revisionId,
        "--summary",
        "Applied every intent in this bounded work item; published OAuth-only authentication and OIDC environment mapping while keeping the overview concise.",
      ]),
    ),
  );
  expect(
    completions.every((completed: { status: string }) => completed.status === "addressed"),
  ).toBe(true);

  // Completion, addressed intents, and the new head revision all arrive live.
  await expect(
    page.locator(
      '[data-testid="work-item"][data-work-status="addressed"][data-decision-status="pending"]',
    ),
  ).toHaveCount(2, { timeout: 10_000 });
  await page.getByTestId("rail-tab-feedback").click();
  await expect(page.locator('#intent-list [data-testid="intent-item"]')).toHaveCount(3);
  await expect(page.locator('#intent-list [data-testid="intent-item"]').first()).toContainText(
    /ready to review/i,
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.__tweakloopNotifications.map((notification) => notification.title),
      ),
    )
    .toEqual(["Tweakloop: review ready", "Tweakloop: review ready"]);
  await page.evaluate(() => {
    window.__tweakloopHidden = false;
    window.__tweakloopNotifications[0]?.onclick?.();
  });

  // Former pointer-only reveal and clamp affordances are native controls with observable effects.
  await expect(page.locator("#viewer-body")).toHaveAttribute("aria-busy", "false", {
    timeout: 10_000,
  });
  const authTaskLocate = page.getByTestId("task-item").filter({ hasText: /Authentication/i });
  await expect(authTaskLocate).toHaveAttribute("aria-label", /Open task in artifact/i);
  await authTaskLocate.focus();
  await authTaskLocate.press("Enter");
  await expect(page.locator("#viewer-flash")).toContainText(
    "Located decision.auth in the artifact.",
  );
  const clampToggle = page.locator(".clamp-toggle").first();
  await expect(clampToggle).toHaveAttribute("aria-expanded", "false");
  await clampToggle.press("Enter");
  await expect(clampToggle).toHaveAttribute("aria-expanded", "true");
  await expect(clampToggle).toHaveText("Show less");
  await page.getByTestId("rail-tab-feedback").click();
  await page.locator("#viewer-flash").evaluate((element) => {
    (element as HTMLElement).hidden = true;
  });
  const authCommentLocate = page
    .locator('#intent-list [data-testid="intent-item"]')
    .filter({ hasText: /Authentication/i });
  await expect(authCommentLocate).toHaveAttribute("aria-label", /Open comment in artifact/i);
  await authCommentLocate.focus();
  await authCommentLocate.press("Space");
  await expect(page.locator("#viewer-flash")).toContainText(
    "Located decision.auth in the artifact.",
  );
  await page.getByTestId("rail-tab-work").click();

  // Addressed is not accepted: the human makes that decision explicitly.
  const decisionStyles = await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    const root = getComputedStyle(document.documentElement);
    const accept = getComputedStyle(document.querySelector(".decision-accept") as Element);
    const another = getComputedStyle(document.querySelector(".decision-reopen") as Element);
    return {
      primaryAction: root.getPropertyValue("--primary-action").trim(),
      primaryContrast: root.getPropertyValue("--primary-contrast").trim(),
      acceptBackground: accept.backgroundColor,
      anotherBackground: another.backgroundColor,
    };
  });
  expect(
    contrastRatio(decisionStyles.primaryAction, decisionStyles.primaryContrast),
  ).toBeGreaterThanOrEqual(4.5);
  expect(decisionStyles.acceptBackground).not.toBe(decisionStyles.anotherBackground);
  await page.getByTestId("decision-accept").first().click();
  await expect(page.getByTestId("decision-accept")).toHaveCount(1, { timeout: 10_000 });
  await page.getByTestId("decision-accept").first().click();
  await expect(page.getByTestId("work-item").filter({ hasText: /accepted/i })).toHaveCount(2, {
    timeout: 10_000,
  });
  await expect(page.locator('#intent-list [data-testid="intent-item"]')).toHaveCount(0);
  await expect(page.locator('#resolved-intent-list [data-testid="intent-item"]')).toHaveCount(3);
  await expect(page.locator("#resolved-comments-count")).toHaveText("3");

  await expect(page.getByTestId("revision-select")).toHaveValue(published.revisionId, {
    timeout: 10_000,
  });
  await expect(frame.locator('[data-tweak-id="decision.auth"]')).toContainText("OAuth apps only", {
    timeout: 10_000,
  });

  // Live chat: human message with selection context reaches the agent CLI...
  await page.getByTestId("rail-tab-chat").click();
  await page
    .getByTestId("chat-input")
    .fill("Please keep the OAuth wording strict and preserve this full verification context.");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-item")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.getByTestId("chat-input")).toHaveValue("");
  await expect
    .poll(() => page.locator(".chat-composer-shell").evaluate((element) => element.clientHeight))
    .toBeLessThanOrEqual(72);
  await expect(page.locator(".chat-presence .presence-line")).toHaveAttribute(
    "title",
    /Saved\. No agent is connected/,
  );
  await page.setViewportSize({ width: 1242, height: 698 });
  const populatedChatRatio = await page.evaluate(() => {
    const rail = document.querySelector("#agent-rail")?.getBoundingClientRect();
    const messages = document.querySelector("#chat-list")?.getBoundingClientRect();
    return rail && messages ? messages.height / rail.height : 0;
  });
  expect(populatedChatRatio).toBeGreaterThanOrEqual(0.55);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const chatSeen = JSON.parse(tweak(["--json", "chat", "list"]));
  expect(chatSeen.messages).toHaveLength(1);
  expect(chatSeen.messages[0].author).toBe("human:browser");

  // ...and the agent's reply appears live in the shell.
  tweak(["--json", "chat", "send", "acknowledged — keeping it strict", "--agent", PRIMARY_AGENT]);
  await expect(page.getByTestId("chat-item")).toHaveCount(2, { timeout: 10_000 });

  // Rollback: pin r1 and restore it as a new head revision (r3).
  await page.getByTestId("revision-select").selectOption(opened.revisionId);
  await expect(page.getByTestId("restore-revision")).toBeVisible();
  await page.getByTestId("restore-revision").click();
  await expect(page.getByTestId("revision-select")).toHaveValue(/^rev_/, { timeout: 10_000 });
  await expect(frame.locator('[data-tweak-id="decision.auth"]')).toContainText(
    "personal access tokens",
    { timeout: 10_000 },
  );
  const restoredList = JSON.parse(tweak(["--json", "artifacts", "list"]));
  expect(restoredList.artifacts).toHaveLength(1);

  // The durable audit trail recorded the whole loop.
  const events = JSON.parse(tweak(["--json", "events", "list"]));
  const kinds = events.events.map((e: { eventType: string }) => e.eventType);
  for (const expected of [
    "workspace.opened",
    "artifact.registered",
    "artifact.revision-published",
    "review.batch-submitted",
    "intent.created",
    "work.created",
    "work.claimed",
    "work.addressed",
    "decision.accepted",
    "chat.message",
  ]) {
    expect(kinds).toContain(expected);
  }
  // r1, r2, and the restore republication of r1's content.
  expect(kinds.filter((k: string) => k === "artifact.revision-published")).toHaveLength(3);
});

test("chat carries pasted files and typed workspace context into a verified export", async ({
  page,
}) => {
  const documentPath = join(workspaceDir, "context.html");
  const boardPath = join(workspaceDir, "context-board.excalidraw");
  const cliAttachmentPath = join(workspaceDir, "agent-evidence.json");
  writeFileSync(documentPath, CONTEXT_DOCUMENT);
  writeFileSync(boardPath, EMPTY_BOARD);
  writeFileSync(cliAttachmentPath, '{"verified":true}\n');

  const boardOpened = JSON.parse(
    tweak(["--json", "open", boardPath, "--agent", "agent:e2e-context", "--no-browser"]),
  );
  const opened = JSON.parse(
    tweak(["--json", "open", documentPath, "--agent", "agent:e2e-context", "--no-browser"]),
  );
  await page.addInitScript(() => {
    window.__tweakloopNotifications = [];
    window.__tweakloopHidden = false;
    class FakeNotification {
      static permission = "granted";
      static requestPermission = async () => "granted";
      onclick: null | (() => void) = null;
      options: unknown;
      title: string;
      constructor(title: string, options: unknown) {
        this.title = title;
        this.options = options;
        window.__tweakloopNotifications.push(this);
      }
      close() {}
    }
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: FakeNotification,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => (window.__tweakloopHidden ? "hidden" : "visible"),
    });
  });
  await page.goto(opened.url);
  await expect(page.getByTestId("connection")).toHaveText("synced");
  await page.getByTestId("notifications-toggle").click();
  await expect(page.locator("#viewer-body")).toHaveAttribute("aria-busy", "false", {
    timeout: 10_000,
  });
  await page.setViewportSize({ width: 900, height: 820 });
  await expect(page.locator("#active-outline")).toBeVisible();
  await expect(page.locator("#outline-list .outline-item").first()).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const frame = page.frameLocator('[data-testid="viewer-frame"]');
  const passage = frame.locator('[data-tweak-id="context.overview"] p');
  await expect(passage).toBeVisible();
  const initialChatCount = await page.getByTestId("chat-item").count();

  // Artifact identity and content commit atomically: delayed content is veiled and inert.
  let releaseBoardLoad = () => {};
  const boardLoadGate = new Promise<void>((resolve) => {
    releaseBoardLoad = resolve;
  });
  await page.route(`**/r/${boardOpened.revisionId}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === `/r/${boardOpened.revisionId}/`) await boardLoadGate;
    await route.continue();
  });
  const boardRow = page
    .getByTestId("document-item")
    .filter({ hasText: "context-board.excalidraw" });
  const selectBoard = boardRow.click();
  await expect(page.locator("#viewer-body")).toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#viewer-transition")).toContainText(
    /Loading context-board\.excalidraw/i,
  );
  await expect(page.getByTestId("viewer-frame")).toHaveAttribute("inert", "");
  await expect(page.getByTestId("viewer-frame")).toHaveAttribute("aria-hidden", "true");
  await expect(boardRow).toHaveAttribute("aria-current", "page");
  releaseBoardLoad();
  await selectBoard;
  await expect(page.locator("#viewer-body")).toHaveAttribute("aria-busy", "false", {
    timeout: 15_000,
  });
  await expect(page.locator("#viewer-transition")).toBeHidden();
  await expect(page.getByTestId("viewer-frame")).not.toHaveAttribute("inert", "");
  await page.unroute(`**/r/${boardOpened.revisionId}/**`);
  await page.getByTestId("document-item").filter({ hasText: "context.html" }).click();
  await expect(passage).toBeVisible();

  // Selection marks appear only after the durable command is acknowledged; a failed send retries in place.
  await page.route("**/api/v1/commands", async (route) => {
    const request = route.request();
    const command = request.postDataJSON() as { type?: string; payload?: { text?: string } };
    if (
      command.type === "chat.send" &&
      command.payload?.text === "Keep this exact passage synchronized."
    ) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ status: "rejected", error: "injected durable rejection" }),
      });
      return;
    }
    await route.continue();
  });
  await passage.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await frame.locator("body").evaluate(() => {
    const host = [...document.body.children].find((element) =>
      element.shadowRoot?.querySelector('button[data-act="chat"]'),
    );
    const textarea = host?.shadowRoot?.querySelector("textarea");
    const button = host?.shadowRoot?.querySelector('button[data-act="chat"]');
    if (!(textarea instanceof HTMLTextAreaElement) || !(button instanceof HTMLButtonElement)) {
      throw new Error("selection-to-chat popover did not open");
    }
    textarea.value = "Keep this exact passage synchronized.";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    button.click();
  });
  await expect
    .poll(() =>
      frame.locator("body").evaluate(() => {
        const host = [...document.body.children].find((element) =>
          element.shadowRoot?.querySelector('button[data-act="chat"]'),
        );
        return {
          marks: CSS.highlights?.get("tweakloop-mark")?.size ?? 0,
          status: host?.shadowRoot?.querySelector(".status")?.textContent ?? "",
          textarea: (host?.shadowRoot?.querySelector("textarea") as HTMLTextAreaElement | null)
            ?.value,
          buttonDisabled: (
            host?.shadowRoot?.querySelector('button[data-act="chat"]') as HTMLButtonElement | null
          )?.disabled,
        };
      }),
    )
    .toEqual({
      marks: 0,
      status: "The daemon did not accept this comment.",
      textarea: "Keep this exact passage synchronized.",
      buttonDisabled: false,
    });
  await expect(page.getByTestId("chat-item")).toHaveCount(initialChatCount);
  await page.unroute("**/api/v1/commands");
  await frame.locator("body").evaluate(() => {
    const host = [...document.body.children].find((element) =>
      element.shadowRoot?.querySelector('button[data-act="chat"]'),
    );
    const button = host?.shadowRoot?.querySelector('button[data-act="chat"]');
    if (!(button instanceof HTMLButtonElement)) throw new Error("retry button disappeared");
    button.click();
  });
  await expect(page.getByTestId("chat-item")).toHaveCount(initialChatCount + 1, {
    timeout: 10_000,
  });
  await expect
    .poll(() =>
      frame.locator("body").evaluate(() => ({
        marks: CSS.highlights?.get("tweakloop-mark")?.size ?? 0,
        popoverVisible: [...document.body.children].some(
          (element) => element.shadowRoot && getComputedStyle(element).display !== "none",
        ),
      })),
    )
    .toEqual({ marks: 1, popoverVisible: false });

  // Create one durable comment/task so both identities are available to the @ picker.
  await page.getByTestId("mode-toggle").click();
  await frame.locator('[data-tweak-id="context.overview"]').click();
  await page.getByTestId("draft-text").fill("Make the collaboration guarantee concrete.");
  await page.getByTestId("draft-add").click();
  const mentionCommentCursor = durableEvents().at(-1)?.seq ?? 0;
  await page.getByTestId("draft-send-now").click();
  await trackCommentAsTask(
    page,
    "Make the collaboration guarantee concrete.",
    mentionCommentCursor,
  );

  await page.getByTestId("rail-tab-chat").click();
  const input = page.getByTestId("chat-input");
  await input.fill("@task");
  const currentDocumentTask = page
    .getByTestId("chat-mention-task")
    .filter({ hasText: "context.html" });
  await expect(currentDocumentTask).toHaveCount(1);
  await expect(page.getByTestId("chat-mention-item")).toHaveCount(0);
  await expect(page.getByTestId("chat-mention-list")).toContainText("Enter to attach");
  await expect(currentDocumentTask).toHaveAttribute("title", /Press Enter to attach/);
  await input.press("Tab");
  await expect(page.locator("#chat-mentions .mention-chip")).toHaveCount(0);
  await input.focus();
  await input.fill("@task");
  await input.press("Enter");
  await expect(page.locator("#chat-mentions .mention-chip")).toHaveCount(1);

  await input.fill("@comment");
  await page.getByTestId("chat-mention-item").filter({ hasText: "@comment" }).first().click();
  await input.press("Escape");

  await input.fill("@whiteboard");
  await page.getByTestId("chat-mention-item").filter({ hasText: "@whiteboard" }).first().click();
  await input.press("Escape");

  await input.fill("@context.html");
  await page.getByRole("option", { name: /Documents: context\.html/ }).click();
  await expect(page.locator("#chat-mentions .mention-chip")).toHaveCount(4);

  // Workspace attention and typed references do not disappear when another document is active.
  await page.getByTestId("document-item").filter({ hasText: "context-board.excalidraw" }).click();
  const sourceDocumentRow = page.getByTestId("document-item").filter({ hasText: "context.html" });
  await expect(sourceDocumentRow.locator(".document-attention")).toHaveText("1");
  await expect(page.locator("#taskbar-current")).toContainText("context.html");
  await input.fill("@task");
  const crossDocumentTask = page
    .getByTestId("chat-mention-task")
    .filter({ hasText: "context.html" });
  await expect(crossDocumentTask).toHaveCount(1);
  await expect(crossDocumentTask).toContainText("context.html");
  await input.press("Escape");
  await sourceDocumentRow.click();

  // File input and clipboard images share one observable, atomic upload lifecycle.
  await page.getByTestId("chat-file-input").setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attached through the file picker\n"),
  });
  await input.evaluate((element) => {
    const image = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], "paste.png", {
      type: "image/png",
    });
    const transfer = new DataTransfer();
    transfer.items.add(image);
    element.dispatchEvent(
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }),
    );
  });
  await expect(page.getByTestId("pending-attachment")).toHaveCount(2, { timeout: 10_000 });
  await expect(page.getByTestId("pending-attachment").filter({ hasText: "ready" })).toHaveCount(2, {
    timeout: 10_000,
  });
  await input.fill("Use every attached context item in this iteration.");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("chat-item")).toHaveCount(initialChatCount + 2, {
    timeout: 10_000,
  });

  const browserChat = JSON.parse(tweak(["--json", "chat", "list"]));
  const browserMessage = browserChat.messages.at(-1);
  expect(browserMessage.sessionId).toBe(opened.sessionId);
  expect(browserMessage.recipientAgentId).toBe("e2e-context");
  expect(browserMessage.attachments).toHaveLength(2);
  expect(
    browserMessage.references.filter((item: { kind: string }) => item.kind === "file"),
  ).toHaveLength(2);
  for (const kind of ["task", "comment", "whiteboard", "document"]) {
    expect(browserMessage.references.some((item: { kind: string }) => item.kind === kind)).toBe(
      true,
    );
  }
  const selectionMessage = browserChat.messages.find(
    (message: { references: { kind: string }[] }) =>
      message.references.some(
        (reference: { kind: string; artifactId?: string }) =>
          reference.kind === "selection" && reference.artifactId === opened.artifactId,
      ),
  );
  expect(selectionMessage.references[0]).toMatchObject({
    kind: "selection",
    artifactId: opened.artifactId,
    revisionId: opened.revisionId,
  });

  // The agent gets the same frictionless surface without manually constructing payload JSON.
  const work = JSON.parse(tweak(["--json", "work", "list"])).work.at(-1);
  tweak([
    "--json",
    "chat",
    "send",
    "Agent-side context is attached.",
    "--attach",
    cliAttachmentPath,
    "--document",
    documentPath,
    "--task",
    work.workId,
    "--whiteboard",
    boardOpened.artifactId,
    "--session",
    opened.sessionId,
  ]);
  const agentChat = JSON.parse(tweak(["--json", "chat", "list"])).messages.at(-1);
  expect(agentChat.author).toBe("agent:e2e-context");
  expect(agentChat.attachments).toHaveLength(1);
  expect(new Set(agentChat.references.map((item: { kind: string }) => item.kind))).toEqual(
    new Set(["file", "document", "task", "whiteboard"]),
  );

  // The receiving agent can materialize exact attachment bytes without guessing from the filename.
  const fetchedAttachmentPath = join(workspaceDir, "received-agent-evidence.json");
  const fetchedAttachment = JSON.parse(
    tweak([
      "--json",
      "chat",
      "attachment",
      "fetch",
      agentChat.attachments[0].hash,
      fetchedAttachmentPath,
    ]),
  );
  expect(fetchedAttachment).toMatchObject({
    protocol: "tweakloop.attachment-fetch/v1",
    hash: agentChat.attachments[0].hash,
    destination: fetchedAttachmentPath,
    byteLength: Buffer.byteLength('{"verified":true}\n'),
    verified: true,
  });
  expect(readFileSync(fetchedAttachmentPath, "utf8")).toBe('{"verified":true}\n');
  const fetchedBytesBeforeDuplicate = readFileSync(fetchedAttachmentPath);
  let duplicateFetch: Readonly<{ status: number; stdout: string }> | null = null;
  try {
    tweak([
      "--json",
      "chat",
      "attachment",
      "fetch",
      agentChat.attachments[0].hash,
      fetchedAttachmentPath,
    ]);
  } catch (error) {
    const child = error as { status?: unknown; stdout?: unknown };
    if (typeof child.status !== "number" || typeof child.stdout !== "string") throw error;
    duplicateFetch = { status: child.status, stdout: child.stdout };
  }
  expect(duplicateFetch).not.toBeNull();
  if (!duplicateFetch) throw new Error("duplicate attachment fetch unexpectedly succeeded");
  expect(duplicateFetch.status).not.toBe(0);
  expect(JSON.parse(duplicateFetch.stdout)).toEqual({
    protocol: "tweakloop.cli/v1",
    error: {
      code: "cli.failure",
      message: `attachment destination already exists: ${fetchedAttachmentPath}`,
      retryable: false,
    },
  });
  expect(readFileSync(fetchedAttachmentPath)).toEqual(fetchedBytesBeforeDuplicate);

  // A valid response-only completion keeps the same human decision boundary without inventing a revision.
  const claimed = JSON.parse(
    tweak([
      "--json",
      "work",
      "claim",
      "--work",
      work.workId,
      "--agent",
      "agent:e2e-context",
      "--process",
      "process-e2e-context",
    ]),
  );
  await page.evaluate(() => {
    window.__tweakloopHidden = true;
  });
  const responseOnly = JSON.parse(
    tweak([
      "--json",
      "work",
      "complete",
      work.workId,
      "--claim",
      claimed.claimId,
      "--agent",
      "agent:e2e-context",
      "--summary",
      "Second pass verified the requested explanation; no additional artifact revision required.",
    ]),
  );
  expect(responseOnly.revisionId ?? null).toBeNull();
  await page.getByTestId("rail-tab-work").click();
  const responseOnlyTask = page.locator(`[data-work-id="${work.workId}"]`);
  await expect(responseOnlyTask).toContainText("Response only · no artifact change", {
    timeout: 10_000,
  });
  await expect
    .poll(() => page.evaluate(() => window.__tweakloopNotifications.at(-1)?.title))
    .toBe("Tweakloop: answer ready");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window.__tweakloopNotifications.at(-1)?.options as { body?: string } | undefined)?.body,
      ),
    )
    .toContain("no document changed");
  await page.evaluate(() => {
    window.__tweakloopHidden = false;
  });
  await expect(responseOnlyTask.getByRole("button", { name: "Accept" })).toBeVisible();
  await expect(responseOnlyTask.getByRole("button", { name: "Another pass" })).toBeVisible();
  await responseOnlyTask.getByRole("button", { name: "Accept" }).click();
  await expect(responseOnlyTask).toContainText(/accepted/i, { timeout: 10_000 });
  await expect(responseOnlyTask.getByRole("button", { name: "Reopen" })).toBeVisible();
  await responseOnlyTask.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByTestId("decision-reason")).toBeVisible();
  await page
    .getByTestId("decision-reason")
    .fill("Make the operator handoff explicit before I accept this answer.");
  await page.getByTestId("decision-submit").click();
  await expect(responseOnlyTask).toHaveAttribute("data-work-id", work.workId);
  await expect(responseOnlyTask).toHaveAttribute("data-work-status", "open", {
    timeout: 10_000,
  });
  await expect(responseOnlyTask).toHaveAttribute("data-decision-status", "reopened");
  const reopenedResponseOnly = JSON.parse(
    tweak(["--json", "work", "list", "--status", "all", "--full"]),
  ).work.find((item: { workId: string }) => item.workId === work.workId);
  expect(reopenedResponseOnly).toMatchObject({
    workId: work.workId,
    status: "open",
    decision: "reopened",
  });

  // Chat stays conversational until the human explicitly turns one exact message into work.
  await page.getByTestId("rail-tab-chat").click();
  const browserTaskSource = page
    .getByTestId("chat-item")
    .filter({ hasText: "Use every attached context item in this iteration." });
  const workBeforeBrowserPromotion = JSON.parse(tweak(["--json", "work", "list"])).work.length;
  await expect(browserTaskSource.getByTestId("chat-promote")).toHaveText("Track as task");
  await browserTaskSource.getByTestId("chat-promote").click();
  await expect(browserTaskSource.getByTestId("chat-promote")).toHaveText("✓ Tracked as task", {
    timeout: 10_000,
  });
  await expect
    .poll(() => JSON.parse(tweak(["--json", "work", "list"])).work.length)
    .toBe(workBeforeBrowserPromotion + 1);
  const browserPromotion = JSON.parse(tweak(["--json", "chat", "list"])).messages.find(
    (message: { text: string }) =>
      message.text === "Use every attached context item in this iteration.",
  );
  expect(browserPromotion).toMatchObject({
    workId: expect.stringMatching(/^work_/),
    intentId: expect.stringMatching(/^intent_/),
  });
  const promotedClaim = JSON.parse(
    tweak([
      "--json",
      "work",
      "claim",
      "--work",
      browserPromotion.workId,
      "--agent",
      "agent:e2e-context",
      "--process",
      "process-chat-promotion",
    ]),
  );
  writeFileSync(
    documentPath,
    CONTEXT_DOCUMENT.replace(
      "The agent and human revise this exact passage together.",
      "The agent and human revise this exact passage together through one explicitly tracked task.",
    ),
  );
  const promotedRevision = JSON.parse(
    tweak([
      "--json",
      "publish",
      documentPath,
      "--agent",
      "agent:e2e-context",
      "--session",
      opened.sessionId,
      "--artifact",
      opened.artifactId,
    ]),
  );
  expect(promotedRevision.revisionId).not.toBe(opened.revisionId);
  tweak([
    "--json",
    "work",
    "complete",
    browserPromotion.workId,
    "--claim",
    promotedClaim.claimId,
    "--agent",
    "agent:e2e-context",
    "--summary",
    "Applied the exact chat instruction in a new immutable revision.",
    "--revision-id",
    promotedRevision.revisionId,
  ]);
  await page.getByTestId("rail-tab-work").click();
  const promotedTask = page.locator(`[data-work-id="${browserPromotion.workId}"]`);
  await expect(promotedTask).toHaveAttribute("data-work-id", browserPromotion.workId);
  await expect(promotedTask).toHaveAttribute("data-work-status", "addressed", {
    timeout: 10_000,
  });
  await expect(promotedTask).toHaveAttribute("data-decision-status", "pending");
  const promotedPending = JSON.parse(
    tweak(["--json", "work", "list", "--status", "all", "--full"]),
  ).work.find((item: { workId: string }) => item.workId === browserPromotion.workId);
  expect(promotedPending).toMatchObject({
    workId: browserPromotion.workId,
    status: "addressed",
    decision: "pending",
  });
  await promotedTask.getByRole("button", { name: "Accept" }).click();
  await expect(promotedTask).toContainText(/accepted/i, { timeout: 10_000 });
  await page.getByTestId("rail-tab-chat").click();

  // A browser-authored message stays conversational until its recipient agent explicitly promotes it.
  const genericMessageText = "Turn this exact browser message into tracked work only when asked.";
  const chatBeforeGenericBrowserMessage = JSON.parse(tweak(["--json", "chat", "list"])).messages;
  const chatIdsBeforeGenericBrowserMessage = new Set<string>(
    chatBeforeGenericBrowserMessage.map((message: { messageId: string }) => message.messageId),
  );
  const workBeforeGenericBrowserMessage = JSON.parse(tweak(["--json", "work", "list"])).work;
  const genericBrowserMessageCursor = durableEvents().at(-1)?.seq ?? 0;

  await input.fill(genericMessageText);
  await page.getByTestId("chat-send").click();
  await expect(input).toHaveValue("");
  await expect
    .poll(
      () =>
        JSON.parse(tweak(["--json", "chat", "list"])).messages.filter(
          (message: { messageId: string }) =>
            !chatIdsBeforeGenericBrowserMessage.has(message.messageId),
        ).length,
    )
    .toBe(1);

  const cliHumanMessage = JSON.parse(tweak(["--json", "chat", "list"])).messages.find(
    (message: { messageId: string }) => !chatIdsBeforeGenericBrowserMessage.has(message.messageId),
  );
  expect(cliHumanMessage).toMatchObject({
    text: genericMessageText,
    author: "human:browser",
    recipientAgentId: "e2e-context",
    sessionId: opened.sessionId,
    workId: null,
    intentId: null,
  });
  expect(JSON.parse(tweak(["--json", "work", "list"])).work).toEqual(
    workBeforeGenericBrowserMessage,
  );
  const genericBrowserMessageEvents = durableEvents(genericBrowserMessageCursor);
  expect(
    genericBrowserMessageEvents.filter((event) => event.eventType === "intent.created"),
  ).toHaveLength(0);
  expect(
    genericBrowserMessageEvents.filter((event) => event.eventType === "work.created"),
  ).toHaveLength(0);

  const genericPromotionCursor = durableEvents().at(-1)?.seq ?? 0;
  const cliPromotion = JSON.parse(
    tweak(["--json", "chat", "promote", cliHumanMessage.messageId, "--agent", "agent:e2e-context"]),
  );
  expect(cliPromotion).toMatchObject({
    messageId: cliHumanMessage.messageId,
    workId: expect.stringMatching(/^work_/),
    intentIds: [expect.stringMatching(/^intent_/)],
  });
  await expect
    .poll(() => JSON.parse(tweak(["--json", "work", "list"])).work.length)
    .toBe(workBeforeGenericBrowserMessage.length + 1);
  const genericPromotionEvents = durableEvents(genericPromotionCursor);
  expect(genericPromotionEvents.filter((event) => event.eventType === "intent.created")).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({ intentId: cliPromotion.intentIds[0] }),
    }),
  ]);
  expect(genericPromotionEvents.filter((event) => event.eventType === "work.created")).toEqual([
    expect.objectContaining({
      payload: expect.objectContaining({
        workId: cliPromotion.workId,
        intentIds: cliPromotion.intentIds,
      }),
    }),
  ]);
  expect(
    JSON.parse(tweak(["--json", "chat", "list"])).messages.find(
      (message: { messageId: string }) => message.messageId === cliHumanMessage.messageId,
    ),
  ).toMatchObject({
    workId: cliPromotion.workId,
    intentId: cliPromotion.intentIds[0],
  });

  // The real CLI export captures current sources, immutable history, events, and every attachment.
  const exportPath = join(workspaceDir, "portable-export");
  const exported = JSON.parse(
    tweak(["--json", "workspace", "export", exportPath]),
  ) as WorkspaceExportResponse;
  expect(exported.protocol).toBe("tweakloop.workspace-export/v1");
  expect(exported.artifacts.length).toBeGreaterThanOrEqual(2);
  expect(
    exported.artifacts.some(
      (item: { artifactId: string }) => item.artifactId === opened.artifactId,
    ),
  ).toBe(true);
  expect(
    exported.artifacts.some(
      (item: { artifactId: string }) => item.artifactId === boardOpened.artifactId,
    ),
  ).toBe(true);
  expect(exported.attachments).toHaveLength(3);
  const collaborationManifestPath = join(exportPath, ".tweakloop", "export-manifest.json");
  expect(existsSync(collaborationManifestPath)).toBe(true);
  const collaborationManifest = JSON.parse(
    readFileSync(collaborationManifestPath, "utf8"),
  ) as WorkspaceExportManifest;
  const validatedExport = validateWorkspaceBundleEnvelope(exportPath);
  expectBoundWorkspaceExport(exported, collaborationManifest, validatedExport, exportPath);

  // A neighboring response can be internally self-consistent while pointing at the wrong
  // on-disk bundle. The consumer assertion must reject that response/envelope splice.
  const neighboringBundleId = `bundle_${"f".repeat(64)}`;
  expect(neighboringBundleId).not.toBe(validatedExport.envelope.bundleId);
  const splicedExport: WorkspaceExportResponse = {
    ...exported,
    bundle: { ...exported.bundle, bundleId: neighboringBundleId },
    operation: { ...exported.operation, bundleId: neighboringBundleId },
  };
  expect(() =>
    expectBoundWorkspaceExport(splicedExport, collaborationManifest, validatedExport, exportPath),
  ).toThrow();

  // The browser button exercises the successful native directory-handle branch too.
  await page.evaluate(() => {
    const files = new Map<string, Uint8Array>();
    const writeOrder: string[] = [];
    const directories = new Map<string, ReturnType<typeof makeDirectory>>();

    function makeDirectory(prefix: string) {
      const directory = {
        async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
          const path = prefix ? `${prefix}/${name}` : name;
          const existing = directories.get(path);
          if (existing) return existing;
          if (!options.create) throw new DOMException("Directory not found", "NotFoundError");
          const created = makeDirectory(path);
          directories.set(path, created);
          return created;
        },
        async getFileHandle(name: string) {
          const path = prefix ? `${prefix}/${name}` : name;
          return {
            async createWritable() {
              let pending = new Uint8Array();
              return {
                async write(value: ArrayBuffer | ArrayBufferView) {
                  pending =
                    value instanceof ArrayBuffer
                      ? new Uint8Array(value.slice(0))
                      : new Uint8Array(
                          value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
                        );
                },
                async close() {
                  files.set(path, pending);
                  writeOrder.push(path);
                },
              };
            },
          };
        },
      };
      return directory;
    }

    const root = makeDirectory("");
    Object.assign(window, { __tweakloopBrowserExport: { files, writeOrder } });
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => root,
    });
  });
  await page.getByTestId("workspace-export").click();
  await expect(page.locator("#workspace-export-status")).toContainText(/^Saved tweakloop-export-/);
  const browserExport = await page.evaluate(() => {
    const captured = (
      window as typeof window & {
        __tweakloopBrowserExport: {
          files: Map<string, Uint8Array>;
          writeOrder: string[];
        };
      }
    ).__tweakloopBrowserExport;
    const manifestPath = captured.writeOrder.find((path) =>
      path.endsWith(".tweakloop/export-manifest.json"),
    );
    const manifestBytes = manifestPath ? captured.files.get(manifestPath) : undefined;
    return {
      paths: [...captured.files.keys()],
      writeOrder: captured.writeOrder,
      manifest: manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) : undefined,
    };
  });
  expect(browserExport.paths.some((path) => path.includes("/.tweakloop/objects/sha256/"))).toBe(
    true,
  );
  expect(browserExport.paths.some((path) => path.endsWith("/context.html"))).toBe(true);
  expect(browserExport.manifest).toMatchObject({
    protocol: "tweakloop.workspace-export/v1",
    capturedSeq: expect.any(Number),
  });
  expect(browserExport.manifest.attachments).toHaveLength(3);
  expect(browserExport.writeOrder.at(-1)).toMatch(/\.tweakloop\/export-manifest\.json$/);

  // A mid-write failure names the exact incomplete folder and never presents it as a valid export.
  await page.evaluate(() => {
    const directories = new Map<string, ReturnType<typeof makeFailingDirectory>>();
    let closeCount = 0;

    function makeFailingDirectory(prefix: string) {
      return {
        async getDirectoryHandle(name: string, options: { create?: boolean } = {}) {
          const path = prefix ? `${prefix}/${name}` : name;
          const existing = directories.get(path);
          if (existing) return existing;
          if (!options.create) throw new DOMException("Directory not found", "NotFoundError");
          const created = makeFailingDirectory(path);
          directories.set(path, created);
          return created;
        },
        async getFileHandle() {
          return {
            async createWritable() {
              return {
                async write() {},
                async close() {
                  closeCount += 1;
                  if (closeCount === 2) throw new Error("simulated disk-full condition");
                },
              };
            },
          };
        },
      };
    }

    const root = makeFailingDirectory("");
    Object.defineProperty(window, "showDirectoryPicker", {
      configurable: true,
      value: async () => root,
    });
  });
  await page.getByTestId("workspace-export").click();
  await expect(page.locator("#workspace-export-status")).toContainText(
    /Save did not complete in tweakloop-export-/,
  );
  await expect(page.locator("#workspace-export-status")).toContainText(
    /export-manifest\.json; delete that folder and retry/,
  );

  // The browser Save action exposes an honest recovery path where the native picker is unavailable.
  await page.evaluate(() => {
    Object.defineProperty(window, "showDirectoryPicker", { value: undefined, configurable: true });
  });
  await page.getByTestId("workspace-export").click();
  await expect(page.locator("#workspace-export-status")).toContainText(
    "tweak workspace export <directory>",
  );
});

test("stale agent presence degrades to offline and recovers", async ({ page }) => {
  const presenceAgent = "agent:presence-recovery";
  const opened = JSON.parse(
    tweak([
      "--json",
      "open",
      join(workspaceDir, "plan.html"),
      "--agent",
      presenceAgent,
      "--no-browser",
    ]),
  );
  await page.goto(opened.url);
  tweak(["presence", "thinking", "--agent", "presence-recovery", "--ttl", "30000"]);
  await expect(page.locator("#agent-status")).toHaveText("Thinking", { timeout: 6_000 });

  await page.route("**/api/v1/presence", (route) =>
    route.fulfill({ status: 503, body: "temporarily unavailable" }),
  );
  await expect(page.locator("#agent-status")).toContainText("reconnecting", {
    timeout: 6_000,
  });
  await expect(page.locator("#agent-status")).toContainText("offline", { timeout: 9_000 });

  await page.unroute("**/api/v1/presence");
  await expect(page.locator("#agent-status")).toHaveText("Thinking", { timeout: 6_000 });
});

test("notification capability failures stay visible and actionable", async ({ browser }) => {
  const unsupportedOpen = JSON.parse(
    tweak([
      "--json",
      "open",
      join(workspaceDir, "plan.html"),
      "--agent",
      "agent:notification-capability",
      "--no-browser",
    ]),
  );
  const unsupportedContext = await browser.newContext();
  const unsupportedPage = await unsupportedContext.newPage();
  await unsupportedPage.addInitScript(() => {
    Reflect.deleteProperty(window, "Notification");
  });
  await unsupportedPage.goto(unsupportedOpen.url);
  await expect(unsupportedPage.getByTestId("connection")).toHaveText("synced");
  await expect(unsupportedPage.getByTestId("notifications-toggle")).toBeDisabled();
  await expect(unsupportedPage.getByTestId("notifications-toggle")).toHaveAttribute(
    "aria-label",
    "Revision-ready notifications unavailable",
  );
  await expect(unsupportedPage.locator("#notifications-status")).toContainText(
    "Keep Tweakloop open",
  );
  await unsupportedContext.close();

  const deniedOpen = JSON.parse(
    tweak([
      "--json",
      "open",
      join(workspaceDir, "plan.html"),
      "--agent",
      "agent:notification-capability",
      "--no-browser",
    ]),
  );
  const deniedContext = await browser.newContext();
  const deniedPage = await deniedContext.newPage();
  await deniedPage.addInitScript(() => {
    const DeniedNotification = {
      permission: "denied",
      requestPermission: async () => "denied",
    };
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: DeniedNotification,
    });
  });
  await deniedPage.goto(deniedOpen.url);
  await expect(deniedPage.getByTestId("connection")).toHaveText("synced");
  await expect(deniedPage.getByTestId("notifications-toggle")).toBeDisabled();
  await expect(deniedPage.getByTestId("notifications-toggle")).toHaveAttribute(
    "aria-label",
    "Revision-ready notifications blocked in browser settings",
  );
  await expect(deniedPage.locator("#notifications-status")).toContainText(
    "Allow them in this site’s browser settings, then reload",
  );
  await deniedContext.close();
});
