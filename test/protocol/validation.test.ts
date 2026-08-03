import { describe, expect, it } from "vitest";
import { validateCommand } from "../../src/protocol/validation.js";

const valid = {
  protocol: "tweakloop.command/v1",
  commandId: "cmd-1",
  idempotencyKey: "key-1",
  workspaceId: "ws_test",
  actor: { kind: "human", id: "alex" },
  type: "artifact.register",
  payload: {
    artifactId: "artifact_1",
    name: "plan.html",
    format: "html",
    sourcePath: "/repo/plan.html",
  },
};

describe("command validation", () => {
  it("accepts a well-formed envelope", () => {
    expect(validateCommand(valid)).toMatchObject({ ok: true });
  });

  it("rejects a malformed envelope", () => {
    expect(validateCommand({ hello: "world" })).toMatchObject({
      ok: false,
      code: "protocol.invalid-envelope",
    });
    expect(validateCommand(null)).toMatchObject({ ok: false });
  });

  it("rejects unknown command types", () => {
    expect(validateCommand({ ...valid, type: "artifact.destroy" })).toMatchObject({
      ok: false,
      code: "protocol.unknown-command",
    });
  });

  it("rejects payloads that fail the per-command schema", () => {
    expect(validateCommand({ ...valid, payload: { artifactId: "a" } })).toMatchObject({
      ok: false,
      code: "protocol.invalid-payload",
    });
    expect(
      validateCommand({ ...valid, payload: { ...valid.payload, format: "pptx" } }),
    ).toMatchObject({ ok: false, code: "protocol.invalid-payload" });
  });
});
