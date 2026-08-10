import type { SnapshotChatMessage } from "./snapshot.js";

export const INBOUND_CHAT_BACKLOG_LIMIT = 20_000;

export const CHAT_DELIVERY_PROTOCOL = "tweakloop.chat-delivery/v1" as const;

export type ChatDelivery = Readonly<{
  protocol: typeof CHAT_DELIVERY_PROTOCOL;
  status: "offered";
  message: SnapshotChatMessage;
  attemptId: string;
  attemptNumber: number;
  agentId: string;
  sessionId: string;
  processNonce: string;
  offeredAt: string;
  /** Time when another delivery generation may be offered; it does not revoke this generation's ack authority. */
  redeliveryEligibleAt: string;
  /** Receipt delivery is not authority to perform action-bearing side effects. */
  processingAuthority: "none";
  /** Promote action-bearing chat to Work and claim that Work before side effects. */
  requiresWorkClaimForSideEffects: true;
  capability: string;
  acknowledgeCommand?: string;
}>;

export type WorkClaimDelivery = Readonly<{
  kind: "work";
  claim: Readonly<Record<string, unknown>>;
}>;

export type ChatNextDelivery = Readonly<{
  kind: "chat";
  delivery: ChatDelivery;
}>;

export type NoNextDelivery = Readonly<{
  kind: "none";
  timedOut: boolean;
}>;

export type IndeterminateNextDelivery = Readonly<{
  kind: "indeterminate";
  timedOut: true;
  reason: "transport-outcome-unknown";
  retryAfterMs: number;
  recoveryCommand?: string;
}>;

export type NextDelivery =
  | ChatNextDelivery
  | WorkClaimDelivery
  | NoNextDelivery
  | IndeterminateNextDelivery;
