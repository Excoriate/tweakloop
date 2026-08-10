import { describe, expect, it } from "vitest";
import { contentSha256, stableCliIdentity } from "../../src/cli/request-identity.js";

describe("stable CLI request identity", () => {
  it("is invariant to object key order and stable for an exact retry", () => {
    const first = stableCliIdentity("request", {
      sessionId: "session_1",
      path: "/repo/plan.html",
      contentSha256: "abc",
      role: "opened",
      actor: { kind: "agent", id: "codex" },
    });
    const retry = stableCliIdentity("request", {
      actor: { id: "codex", kind: "agent" },
      role: "opened",
      contentSha256: "abc",
      path: "/repo/plan.html",
      sessionId: "session_1",
    });

    expect(retry).toBe(first);
    expect(first).toMatch(/^request_[a-f0-9]{32}$/);
  });

  it.each([
    ["content", { contentSha256: "different" }],
    ["role", { role: "primary" }],
    ["actor", { actor: { kind: "agent", id: "other" } }],
    ["session", { sessionId: "session_2" }],
  ])("changes when normalized %s changes", (_label, changed) => {
    const base = {
      sessionId: "session_1",
      path: "/repo/plan.html",
      contentSha256: "abc",
      role: "opened",
      actor: { kind: "agent", id: "codex" },
    };
    expect(stableCliIdentity("request", { ...base, ...changed })).not.toBe(
      stableCliIdentity("request", base),
    );
  });

  it("hashes bytes rather than a lossy string projection", () => {
    expect(contentSha256(Uint8Array.from([0, 255]))).not.toBe(
      contentSha256(Uint8Array.from([0, 254])),
    );
  });
});
