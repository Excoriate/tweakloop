import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("whiteboard distribution and bridge contracts", () => {
  it("keeps the document entry tiny and defers the local editor runtime", () => {
    const loaderPath = resolve(root, "web/artifact/whiteboard.js");
    const loader = readFileSync(loaderPath, "utf8");
    expect(statSync(loaderPath).size).toBeLessThan(5_000);
    expect(loader).toContain("./assets/");
    expect(loader).toContain("runtime.js");
    expect(loader).not.toMatch(/esm\.sh|tldraw@|https?:\/\//);
    expect(statSync(resolve(root, "web/artifact/assets/runtime.js")).size).toBeGreaterThan(100_000);
    expect(statSync(resolve(root, "web/artifact/assets/runtime.css")).size).toBeGreaterThan(
      100_000,
    );
  });

  it("routes whiteboard mutations and element targeting only through the sandbox bridge", () => {
    const bridge = readFileSync(resolve(root, "web/bridge/bridge.js"), "utf8");
    const runtime = readFileSync(resolve(root, "web/artifact/src/whiteboard-runtime.jsx"), "utf8");
    for (const contract of [
      "apply-whiteboard-scene",
      "whiteboard-scene-applied",
      "whiteboard-scene-error",
      "apply-whiteboard-object",
      "whiteboard-object-applied",
      "whiteboard-object-error",
      "whiteboard-change",
      "tweakloop:whiteboard-selection",
      "whiteboardArtifactId",
      "baseRevisionId",
      "boardAnchor",
      "elementAnchor",
    ]) {
      expect(bridge).toContain(contract);
    }
    expect(runtime).toContain("captureUpdate: CaptureUpdateAction.NEVER");
    expect(runtime).toContain("waitForSceneCommit");
    expect(bridge).not.toMatch(/["']Authorization["']|Bearer\s/i);
  });
});
