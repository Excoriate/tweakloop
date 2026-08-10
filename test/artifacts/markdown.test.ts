import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { formatForPath, ingestFile } from "../../src/artifacts/ingest.js";
import { renderMarkdown } from "../../src/artifacts/markdown.js";
import { startDaemon } from "../../src/daemon/index.js";
import { readObject } from "../../src/storage/object-store/index.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";

function tweakIds(html: string): string[] {
  return [...html.matchAll(/data-tweak-id="([^"]+)"/g)].map((match) => match[1] ?? "");
}

describe("Markdown artifact adapter", () => {
  it("renders a strict embedded whiteboard reference without enabling raw HTML", () => {
    const html = renderMarkdown(
      "```tweakloop-whiteboard {#architecture.flow artifact=artifact_board revision=rev_board_3}\n```",
      "board.md",
    );
    expect(html).toContain("data-tweakloop-whiteboard");
    expect(html).toContain('data-tweak-id="architecture.flow"');
    expect(html).toContain('data-tweak-whiteboard-artifact="artifact_board"');
    expect(html).toContain('data-tweak-whiteboard-revision="rev_board_3"');
  });

  it.each([
    "```tweakloop-whiteboard {#architecture.flow artifact=artifact_board revision=rev_board_3 extra=yes}\n```",
    "```tweakloop-whiteboard {#architecture.flow artifact=artifact_board revision=rev_board_3}\nmutable inline scene\n```",
  ])("rejects malformed or mutable whiteboard directives", (source) => {
    expect(() => renderMarkdown(source, "board.md")).toThrow(
      "invalid tweakloop-whiteboard directive",
    );
  });

  it("renders heading ancestry and prose blocks as unique semantic targets", () => {
    const html = renderMarkdown(
      [
        "# Platform",
        "",
        "Opening context.",
        "",
        "## Networking",
        "",
        "First network paragraph.",
        "",
        "Second network paragraph.",
        "",
        "## Networking",
        "",
        "A repeated section remains targetable.",
      ].join("\n"),
      "plan.md",
    );

    expect(tweakIds(html)).toEqual([
      "platform",
      "platform.paragraph-1",
      "platform.networking",
      "platform.networking.paragraph-1",
      "platform.networking.paragraph-2",
      "platform.networking-2",
      "platform.networking-2.paragraph-1",
    ]);
    expect(new Set(tweakIds(html)).size).toBe(tweakIds(html).length);
  });

  it("keeps paragraph targets stable when prose changes", () => {
    const before = renderMarkdown("# Plan\n\nThe first draft.\n\n## Risks\n\nOld risk.", "plan.md");
    const after = renderMarkdown(
      "# Plan\n\nA substantially rewritten first draft.\n\n## Risks\n\nA revised and longer risk.",
      "plan.md",
    );

    expect(tweakIds(after)).toEqual(tweakIds(before));
  });

  it("honors explicit heading ids and preserves rich inline Markdown", () => {
    const html = renderMarkdown(
      "# **Live** collaboration {#collaboration.live}\n\nReview [the guide](/guide).",
      "plan.md",
    );

    expect(html).toContain(
      '<h1 data-tweak-id="collaboration.live" data-tweak-kind="heading"><strong>Live</strong> collaboration</h1>',
    );
    expect(html).toContain('data-tweak-id="collaboration.live.paragraph-1"');
    expect(html).toContain('<a href="/guide">the guide</a>');
    expect(html).not.toContain("{#collaboration.live}");
  });

  it("renders raw HTML inert and strips executable URL schemes", () => {
    const html = renderMarkdown(
      [
        "# Safety",
        "",
        '<script data-probe="raw">globalThis.pwned = true</script>',
        "",
        "[unsafe](javascript:alert(1)) and ![pixel](data:text/html;base64,PHNjcmlwdD4=)",
      ].join("\n"),
      '</title><script data-probe="title">alert(1)</script>',
    );

    expect(html).not.toContain('<script data-probe="raw">');
    expect(html).not.toContain('<script data-probe="title">');
    expect(html).not.toMatch(/(?:href|src)="(?:javascript|data):/i);
    expect(html).toContain("&lt;script data-probe=&quot;raw&quot;&gt;");
    expect(html).toContain("&lt;/title&gt;&lt;script data-probe=&quot;title&quot;&gt;");
  });

  it("recognizes common Markdown extensions case-insensitively", () => {
    expect(formatForPath("plan.md")).toBe("markdown");
    expect(formatForPath("plan.MARKDOWN")).toBe("markdown");
    expect(formatForPath("plan.mdown")).toBe("markdown");
    expect(formatForPath("plan.mkd")).toBe("markdown");
    expect(formatForPath("plan.html")).toBe("html");
  });

  it("snapshots Markdown bytes and media type without rewriting the canonical source", () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "tweakloop-markdown-test-"));
    const sourcePath = join(tempRoot, "collaboration.markdown");
    const objectsDir = join(tempRoot, "objects");
    const source = "# Collaboration\n\nOne immutable revision.\n";
    writeFileSync(sourcePath, source, "utf8");
    const db = openDatabase(":memory:");

    try {
      const revision = ingestFile(
        { db, objectsDir, now: () => "2026-08-04T00:00:00.000Z" },
        sourcePath,
      );

      expect(revision).toMatchObject({
        format: "markdown",
        entryPath: "collaboration.markdown",
        files: [{ path: "collaboration.markdown", mediaType: "text/markdown" }],
      });
      expect(readObject(objectsDir, revision.entryHash).toString("utf8")).toBe(source);
      expect(
        db.prepare("SELECT media_type FROM blobs WHERE hash = ?").get(revision.entryHash),
      ).toEqual({ media_type: "text/markdown" });
    } finally {
      db.close();
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("carries an anchored Markdown comment through work, chat, and an immutable revised projection", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "tweakloop-markdown-loop-"));
    const stateDir = join(tempRoot, "state");
    const workspaceRoot = join(tempRoot, "workspace");
    const sourcePath = join(workspaceRoot, "review.md");
    mkdirSync(workspaceRoot, { recursive: true });
    const original = [
      "# Markdown review {#markdown-review}",
      "",
      "## Dynamic TaskBar {#taskbar}",
      "",
      "The first collaboration draft.",
    ].join("\n");
    const revised = original.replace(
      "The first collaboration draft.",
      "The selected comment is now the focal point of the collaboration rail.",
    );
    writeFileSync(sourcePath, original, "utf8");
    process.env.TWEAKLOOP_STATE_DIR = stateDir;
    const daemon = await startDaemon({ rootPath: workspaceRoot, log: () => {} });
    let browser: Browser | null = null;
    const shellOrigin = `http://127.0.0.1:${daemon.shellPort}`;
    const artifactOrigin = `http://127.0.0.1:${daemon.artifactPort}`;
    const cliHeaders = {
      authorization: `Bearer ${daemon.cliToken}`,
      "content-type": "application/json",
    };

    async function publish(): Promise<Record<string, unknown>> {
      const response = await fetch(`${shellOrigin}/api/v1/publish`, {
        method: "POST",
        headers: cliHeaders,
        body: JSON.stringify({ path: sourcePath, actor: { kind: "agent", id: "agent:markdown" } }),
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Record<string, unknown>;
    }

    async function command(
      commandId: string,
      type: string,
      payload: Record<string, unknown>,
      actor: { kind: "agent" | "human"; id: string } = {
        kind: "agent",
        id: "agent:markdown",
      },
    ): Promise<Record<string, unknown>> {
      const response = await fetch(`${shellOrigin}/api/v1/commands`, {
        method: "POST",
        headers: cliHeaders,
        body: JSON.stringify({
          protocol: "tweakloop.command/v1",
          commandId,
          idempotencyKey: commandId,
          workspaceId: daemon.workspaceId,
          actor,
          type,
          payload,
        }),
      });
      const result = (await response.json()) as Record<string, unknown>;
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    }

    async function events(): Promise<
      Array<{ eventType: string; payload: Record<string, unknown> }>
    > {
      const response = await fetch(`${shellOrigin}/api/v1/events?after=0`, {
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      });
      expect(response.status).toBe(200);
      return (await response.json()) as Array<{
        eventType: string;
        payload: Record<string, unknown>;
      }>;
    }

    try {
      const first = await publish();
      const artifactId = String(first.artifactId);
      const firstRevisionId = String(first.revisionId);
      const firstProjectionUrl = `${artifactOrigin}/r/${firstRevisionId}/review.md`;
      const firstProjection = await (await fetch(firstProjectionUrl)).text();
      expect(firstProjection).toContain('data-tweak-id="taskbar.paragraph-1"');
      expect(firstProjection).toContain("The first collaboration draft.");

      await command("cmd-session-markdown", "session.start", {
        sessionId: "session_markdown",
        artifactId,
        agentId: "agent:markdown",
        processNonce: "process_markdown",
        baseRevisionId: firstRevisionId,
        title: "Markdown collaboration",
        goal: "Carry anchored feedback through an immutable revision",
      });

      const bootstrapResponse = await fetch(`${shellOrigin}/api/v1/bootstrap-tokens`, {
        method: "POST",
        headers: cliHeaders,
        body: JSON.stringify({
          artifactId,
          agentId: "agent:markdown",
          sessionId: "session_markdown",
        }),
      });
      expect(bootstrapResponse.status).toBe(201);
      const bootstrap = (await bootstrapResponse.json()) as { url: string };
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      page.setDefaultTimeout(3_000);
      page.setDefaultNavigationTimeout(5_000);
      await page.goto(bootstrap.url);

      const outlineItem = page.getByTestId("outline-item").filter({ hasText: "Dynamic TaskBar" });
      await outlineItem.waitFor();
      expect(await outlineItem.count()).toBe(1);
      const frame = page.frameLocator('[data-testid="viewer-frame"]');
      const paragraph = frame.locator('[data-tweak-id="taskbar.paragraph-1"]');
      await paragraph.waitFor();
      await page.getByTestId("mode-toggle").click();
      await paragraph.click();
      await page.getByTestId("draft-form").waitFor();
      await page.getByTestId("draft-text").fill("Make this the rail's focal point.");
      await page.getByTestId("draft-send").click();
      await page.getByTestId("intent-item").waitFor();

      const commentSnapshot = (await (
        await fetch(`${shellOrigin}/api/v1/snapshot`, {
          headers: { authorization: `Bearer ${daemon.cliToken}` },
        })
      ).json()) as {
        intents: Array<{
          intentId: string;
          intentType: string;
          target: { semanticId?: string; textQuote?: { exact?: string } };
        }>;
        work: Array<{ workId: string }>;
      };
      expect(commentSnapshot.intents).toHaveLength(1);
      expect(commentSnapshot.intents[0]).toMatchObject({
        intentType: "comment",
        target: {
          semanticId: "taskbar.paragraph-1",
          textQuote: { exact: "The first collaboration draft." },
        },
      });
      expect(commentSnapshot.work).toHaveLength(0);
      const intentId = commentSnapshot.intents[0]?.intentId;
      expect(intentId).toBeTruthy();
      const commentEvents = await events();
      expect(commentEvents.filter((event) => event.eventType === "intent.created")).toHaveLength(1);
      expect(commentEvents.filter((event) => event.eventType === "work.created")).toHaveLength(0);

      const track = page.getByTestId("comment-track");
      await track.waitFor();
      expect(await track.textContent()).toContain("Track as task");
      await track.click();
      await page.getByTestId("rail-tab-work").click();
      await page.getByTestId("work-item").waitFor();

      await page.getByTestId("rail-tab-chat").click();
      await page.getByTestId("chat-input").fill("Please keep this anchored while revising it.");
      await page.getByTestId("chat-send").click();
      await page.getByTestId("chat-item").waitFor();

      const reviewedSnapshot = (await (
        await fetch(`${shellOrigin}/api/v1/snapshot`, {
          headers: { authorization: `Bearer ${daemon.cliToken}` },
        })
      ).json()) as {
        intents: Array<{
          intentId: string;
          target: { semanticId?: string; textQuote?: { exact?: string } };
        }>;
        work: Array<{ workId: string; intentIds: string[] }>;
      };
      expect(reviewedSnapshot.intents).toHaveLength(1);
      expect(reviewedSnapshot.work).toHaveLength(1);
      const workId = reviewedSnapshot.work[0]?.workId;
      expect(workId).toBeTruthy();
      expect(reviewedSnapshot.work[0]?.intentIds).toEqual([intentId]);
      expect(reviewedSnapshot.intents[0]?.target).toMatchObject({
        semanticId: "taskbar.paragraph-1",
        textQuote: { exact: "The first collaboration draft." },
      });
      const trackedEvents = await events();
      const workCreated = trackedEvents.filter((event) => event.eventType === "work.created");
      expect(workCreated).toHaveLength(1);
      expect(workCreated[0]?.payload).toMatchObject({
        workId,
        intentIds: [intentId],
      });
      expect(Object.keys(workCreated[0]?.payload ?? {}).sort()).toEqual(
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

      await command("cmd-markdown-claim", "work.claim", {
        claimId: "claim_markdown",
        agentId: "agent:markdown",
        workId,
      });

      writeFileSync(sourcePath, revised, "utf8");
      const second = await publish();
      const secondRevisionId = String(second.revisionId);
      await command("cmd-markdown-complete", "work.complete", {
        workId,
        claimId: "claim_markdown",
        agentId: "agent:markdown",
        summary: "Made the selected Markdown paragraph the collaboration focal point.",
        revisionId: secondRevisionId,
      });
      await command("cmd-markdown-chat-agent", "chat.send", {
        messageId: "message_markdown_agent",
        artifactId,
        text: "Revised and published as a new immutable Markdown revision.",
        context: {
          revisionId: secondRevisionId,
          semanticId: "taskbar.paragraph-1",
          textQuote: {
            exact: "The selected comment is now the focal point of the collaboration rail.",
          },
        },
        mentions: [artifactId],
        sessionId: "session_markdown",
        recipientAgentId: null,
        threadId: `intent:${intentId}`,
        workId,
        intentId,
      });

      await page.waitForFunction(
        (revisionId) =>
          (document.querySelector('[data-testid="revision-select"]') as HTMLSelectElement)
            ?.value === revisionId,
        secondRevisionId,
      );
      await frame.locator('[data-tweak-id="taskbar.paragraph-1"]').waitFor();
      expect(await frame.locator('[data-tweak-id="taskbar.paragraph-1"]').textContent()).toContain(
        "The selected comment is now the focal point",
      );
      await page.waitForFunction(
        () => document.querySelector("#taskbar-addressed")?.textContent === "1",
      );

      const oldProjection = await (await fetch(firstProjectionUrl)).text();
      const newProjection = await (
        await fetch(`${artifactOrigin}/r/${secondRevisionId}/review.md`)
      ).text();
      expect(oldProjection).toContain("The first collaboration draft.");
      expect(oldProjection).not.toContain("The selected comment is now");
      expect(newProjection).toContain('data-tweak-id="taskbar.paragraph-1"');
      expect(newProjection).toContain("The selected comment is now the focal point");

      const snapshot = (await (
        await fetch(`${shellOrigin}/api/v1/snapshot`, {
          headers: { authorization: `Bearer ${daemon.cliToken}` },
        })
      ).json()) as {
        revisions: Array<{ revisionId: string }>;
        intents: Array<{ intentId: string; status: string; target: { semanticId?: string } }>;
        work: Array<{ workId: string; status: string }>;
        chat: Array<{ messageId: string; text: string; threadId?: string | null }>;
      };
      expect(snapshot.revisions.map((revision) => revision.revisionId)).toEqual([
        firstRevisionId,
        secondRevisionId,
      ]);
      expect(snapshot.intents).toContainEqual(
        expect.objectContaining({
          intentId,
          status: "addressed",
          target: expect.objectContaining({ semanticId: "taskbar.paragraph-1" }),
        }),
      );
      expect(snapshot.work).toContainEqual(
        expect.objectContaining({ workId, status: "addressed" }),
      );
      expect(snapshot.chat).toEqual([
        expect.objectContaining({
          text: "Please keep this anchored while revising it.",
        }),
        expect.objectContaining({
          messageId: "message_markdown_agent",
          threadId: `intent:${intentId}`,
        }),
      ]);
    } finally {
      await browser?.close();
      daemon.close();
      delete process.env.TWEAKLOOP_STATE_DIR;
      rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
