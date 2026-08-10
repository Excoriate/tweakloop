import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  formatForPath,
  IngestBytesError,
  ingestBytes,
  ingestFile,
} from "../../src/artifacts/ingest.js";
import { readObject } from "../../src/storage/object-store/index.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";

describe("artifact format detection", () => {
  it("prepares validated path-free HTML and Markdown snapshots", () => {
    const html = ingestBytes("../Unsafe: plan.html", Buffer.from("<!doctype html><p>hello</p>"));
    expect(html.revision).toMatchObject({
      format: "html",
      entryPath: "Unsafe- plan.html",
      files: [{ mediaType: "text/html" }],
    });
    expect(html.objects[0]?.hash).toBe(html.revision.entryHash);

    const markdown = ingestBytes("notes.markdown", Buffer.from("# Notes\n"));
    expect(markdown.revision).toMatchObject({
      format: "markdown",
      entryPath: "notes.markdown",
      files: [{ mediaType: "text/markdown" }],
    });
  });

  it("rejects unsupported, oversized, malformed, and invalid UTF-8 input", () => {
    const cases = [
      () => ingestBytes("notes.txt", Buffer.from("hello")),
      () => ingestBytes("plan.html", Buffer.from("plain text")),
      () => ingestBytes("notes.md", Buffer.from([0xff, 0xfe])),
      () => ingestBytes("notes.md", Buffer.from("large"), 2),
    ];
    for (const run of cases) expect(run).toThrow(IngestBytesError);
  });

  it("canonicalizes path-free Excalidraw bytes and prepares its element index", () => {
    const ingested = ingestBytes(
      "board.excalidraw",
      Buffer.from(JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {} })),
    );
    expect(ingested.revision.format).toBe("whiteboard");
    expect(ingested.revision.files.map((file) => file.path)).toEqual([
      "board.excalidraw",
      ".tweakloop/elements.json",
    ]);
    expect(ingested.objects).toHaveLength(2);
  });

  it.each([
    ["architecture.html", "html"],
    ["notes.md", "markdown"],
    ["notes.MARKDOWN", "markdown"],
    ["system.excalidraw", "whiteboard"],
    ["system.EXCALIDRAW", "whiteboard"],
  ] as const)("maps %s to %s", (sourcePath, expected) => {
    expect(formatForPath(sourcePath)).toBe(expected);
  });

  it("does not mistake arbitrary JSON for a whiteboard", () => {
    expect(formatForPath("system.json")).toBe("html");
  });

  it("canonicalizes an initial whiteboard and stores its element index", () => {
    const root = mkdtempSync(join(tmpdir(), "tweakloop-whiteboard-ingest-"));
    const sourcePath = join(root, "system.excalidraw");
    const objectsDir = join(root, "objects");
    const db = openDatabase(":memory:");
    writeFileSync(
      sourcePath,
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "test",
        elements: [
          {
            id: "service",
            type: "rectangle",
            version: 1,
            versionNonce: 42,
            isDeleted: false,
          },
        ],
        appState: { zoom: { value: 2 }, viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    );
    try {
      const revision = ingestFile(
        { db, objectsDir, now: () => "2026-08-04T00:00:00.000Z" },
        sourcePath,
      );
      expect(revision.format).toBe("whiteboard");
      expect(revision.files).toHaveLength(2);
      expect(revision.files[0]?.mediaType).toBe("application/vnd.excalidraw+json");
      expect(revision.files[1]?.mediaType).toBe("application/vnd.tweakloop.whiteboard-index+json");
      const canonical = JSON.parse(readObject(objectsDir, revision.entryHash).toString("utf8"));
      expect(canonical.appState).toEqual({ viewBackgroundColor: "#ffffff" });
      const index = JSON.parse(
        readObject(objectsDir, revision.files[1]?.hash ?? "").toString("utf8"),
      );
      expect(index.elements).toEqual([
        expect.objectContaining({
          elementId: "service",
          elementType: "rectangle",
          elementVersion: 1,
          elementVersionNonce: 42,
        }),
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
