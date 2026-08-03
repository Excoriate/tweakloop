import type { ServerResponse } from "node:http";
import type { EventEnvelope } from "../protocol/envelopes.js";

export type EventHub = Readonly<{
  publish: (envelopes: readonly EventEnvelope[]) => void;
  subscribe: (res: ServerResponse) => () => void;
}>;

export function writeSse(res: ServerResponse, envelope: EventEnvelope): void {
  // A client can vanish between its 'close' handler and a publish.
  if (res.destroyed || res.writableEnded) return;
  res.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
}

/** Fan-out of committed events. Publish happens only after commit. */
export function createEventHub(): EventHub {
  const clients = new Set<ServerResponse>();
  return {
    publish(envelopes) {
      for (const res of clients) {
        for (const envelope of envelopes) {
          writeSse(res, envelope);
        }
      }
    },
    subscribe(res) {
      res.on("error", () => {});
      clients.add(res);
      return () => clients.delete(res);
    },
  };
}
