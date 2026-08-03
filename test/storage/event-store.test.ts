import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/storage/sqlite/db.js";
import {
  appendEvent,
  currentStreamVersion,
  getReceipt,
  lastSeq,
  putReceipt,
  readEvents,
} from "../../src/storage/sqlite/event-store.js";

const WS = "ws_test";

function makeInput(overrides: Partial<Parameters<typeof appendEvent>[2]> = {}) {
  return {
    eventId: `evt_${Math.random().toString(36).slice(2)}`,
    streamType: "artifact",
    streamId: "artifact_1",
    eventType: "artifact.registered",
    schemaVersion: 1,
    recordedAt: "2026-08-03T00:00:00.000Z",
    actor: { kind: "system" as const, id: "test" },
    causationId: null,
    correlationId: null,
    payload: { hello: "world" },
    ...overrides,
  };
}

describe("event store", () => {
  it("appends with global seq order and per-stream versions", () => {
    const db = openDatabase(":memory:");
    const first = appendEvent(db, WS, makeInput());
    const second = appendEvent(db, WS, makeInput());
    const other = appendEvent(db, WS, makeInput({ streamId: "artifact_2" }));

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(other.seq).toBe(3);
    expect(first.streamVersion).toBe(1);
    expect(second.streamVersion).toBe(2);
    expect(other.streamVersion).toBe(1);
    expect(currentStreamVersion(db, WS, "artifact_1")).toBe(2);
    expect(lastSeq(db, WS)).toBe(3);
    expect(lastSeq(db, "ws_other")).toBe(0);
  });

  it("replays events after a sequence number with payloads intact", () => {
    const db = openDatabase(":memory:");
    appendEvent(db, WS, makeInput({ payload: { n: 1 } }));
    appendEvent(db, WS, makeInput({ payload: { n: 2 } }));
    const replayed = readEvents(db, WS, 1);
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.payload).toEqual({ n: 2 });
  });

  it("stores and returns idempotency receipts", () => {
    const db = openDatabase(":memory:");
    expect(getReceipt(db, WS, "key-1")).toBeNull();
    const response = {
      status: "accepted" as const,
      commandId: "cmd-1",
      firstEventSeq: 1,
      lastEventSeq: 1,
      response: { artifactId: "artifact_1" },
    };
    putReceipt(db, WS, "key-1", "cmd-1", 1, 1, response, "2026-08-03T00:00:00.000Z");
    expect(getReceipt(db, WS, "key-1")).toEqual(response);
  });
});
