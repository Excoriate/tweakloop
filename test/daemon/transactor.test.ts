import { describe, expect, it } from "vitest";
import { rebuildProjections } from "../../src/daemon/projections.js";
import { createTransactor } from "../../src/daemon/transactor.js";
import type { EventEnvelope } from "../../src/protocol/envelopes.js";
import { openDatabase } from "../../src/storage/sqlite/db.js";

const WS = "ws_test";

function setup() {
  const db = openDatabase(":memory:");
  const published: EventEnvelope[] = [];
  let eventCounter = 0;
  const transactor = createTransactor({
    db,
    workspaceId: WS,
    newEventId: () => `evt_${++eventCounter}`,
    now: () => "2026-08-03T00:00:00.000Z",
    onCommitted: (envelopes) => published.push(...envelopes),
  });
  return { db, transactor, published };
}

function registerEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "tweakloop.command/v1",
    commandId: "cmd-1",
    idempotencyKey: "key-1",
    workspaceId: WS,
    actor: { kind: "human", id: "alex" },
    type: "artifact.register",
    payload: {
      artifactId: "artifact_1",
      name: "plan.html",
      format: "html",
      sourcePath: "/repo/plan.html",
    },
    ...overrides,
  };
}

describe("transactor", () => {
  it("commits events, projections, and receipts atomically", () => {
    const { db, transactor, published } = setup();
    const result = transactor.execute(registerEnvelope());
    expect(result).toMatchObject({
      status: "accepted",
      firstEventSeq: 1,
      lastEventSeq: 1,
      response: { artifactId: "artifact_1" },
    });

    const artifactRows = db.prepare("SELECT * FROM p_artifacts").all();
    expect(artifactRows).toHaveLength(1);
    const timelineRows = db.prepare("SELECT * FROM p_timeline").all();
    expect(timelineRows).toHaveLength(1);
    expect(published).toHaveLength(1);
    expect(published[0]?.eventType).toBe("artifact.registered");
  });

  it("returns the original receipt for a retried idempotency key", () => {
    const { db, transactor } = setup();
    const first = transactor.execute(registerEnvelope());
    const retry = transactor.execute(registerEnvelope({ commandId: "cmd-2" }));
    expect(retry).toEqual(first);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("rejects domain violations without durable effects", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    const duplicate = transactor.execute(
      registerEnvelope({ commandId: "cmd-3", idempotencyKey: "key-3" }),
    );
    expect(duplicate).toMatchObject({ status: "rejected", code: "artifact.already-registered" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events").get()).toEqual({ n: 1 });
  });

  it("rejects stale expected stream versions", () => {
    const { transactor } = setup();
    transactor.execute(registerEnvelope());
    const stale = transactor.execute(
      registerEnvelope({
        commandId: "cmd-4",
        idempotencyKey: "key-4",
        expected: { streamId: "artifact_1", streamVersion: 0 },
        payload: {
          artifactId: "artifact_2",
          name: "plan2.html",
          format: "html",
          sourcePath: "/repo/plan2.html",
        },
      }),
    );
    expect(stale).toMatchObject({ status: "rejected", code: "concurrency.version-conflict" });
  });

  it("rejects malformed and unknown commands at the protocol boundary", () => {
    const { transactor } = setup();
    expect(transactor.execute({ nonsense: true })).toMatchObject({
      status: "rejected",
      code: "protocol.invalid-envelope",
    });
    expect(transactor.execute(registerEnvelope({ type: "artifact.explode" }))).toMatchObject({
      status: "rejected",
      code: "protocol.unknown-command",
    });
  });

  it("rebuilds projections identically from the event log", () => {
    const { db, transactor } = setup();
    transactor.execute(registerEnvelope());
    transactor.execute(
      registerEnvelope({
        commandId: "cmd-5",
        idempotencyKey: "key-5",
        payload: {
          artifactId: "artifact_2",
          name: "notes.md",
          format: "markdown",
          sourcePath: "/repo/notes.md",
        },
      }),
    );

    const before = {
      artifacts: db.prepare("SELECT * FROM p_artifacts ORDER BY artifact_id").all(),
      timeline: db.prepare("SELECT * FROM p_timeline ORDER BY seq").all(),
    };
    rebuildProjections(db, WS);
    const after = {
      artifacts: db.prepare("SELECT * FROM p_artifacts ORDER BY artifact_id").all(),
      timeline: db.prepare("SELECT * FROM p_timeline ORDER BY seq").all(),
    };
    expect(after).toEqual(before);
  });
});
