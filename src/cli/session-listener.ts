import type { AgentSessionSnapshot } from "../protocol/agent-session.js";
import type { EventEnvelope } from "../protocol/envelopes.js";

export async function refreshClaimSnapshot(
  current: AgentSessionSnapshot,
  event: EventEnvelope,
  load: () => Promise<AgentSessionSnapshot>,
): Promise<AgentSessionSnapshot> {
  return event.streamType === "work" ? load() : current;
}

export function workListenerState(
  current: AgentSessionSnapshot,
  workId: string,
  expectedClaimId: string,
): "active" | "settled" | "claim-changed" {
  const work = current.work.find((item) => item.workId === workId);
  if (work === undefined || work.status !== "claimed" || work.claim === null) return "settled";
  return work.claim.claimId === expectedClaimId ? "active" : "claim-changed";
}
