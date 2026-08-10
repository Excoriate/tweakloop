---
title: Live work and progress
description: Load only while claimed work is active and visible presence, lease renewal, durable milestones, pause, or failure must remain truthful.
---

# Live work and progress

Load this reference whenever work is claimed. Socket-backed presence keeps a cooperative live turn
visible; it does not make progress automatic or replace claim authority, publication, or a human
decision.

## Keep the five facts separate

| Fact | Command or source | What it proves | What it never proves |
|---|---|---|---|
| Delivery acknowledgement | exact returned `acknowledgeCommand` | This delivery reached the agent. | Comprehension, a claim, or current work. |
| Live presence | explicit presence or the claimed-work session listener | The named agent reported an ephemeral state while its TTL/socket remains live. | A durable claim, progress, or completion. |
| Claim lease | `tweak work heartbeat <workId> --claim <claimId> --process <nonce> --json` | The exact active process renewed its claim lease. | A milestone or user-visible progress. |
| Durable progress | `tweak work progress <workId> --claim <claimId> --summary <truth> --intent-ids <ids> --agent <agentId> --json` | A real milestone for the exact addressed intent subset was recorded. | Completion or human acceptance. |
| Addressed work | claim-derived `publish --complete` or `work complete` | The agent durably addressed the named work. | Human Accept. |

Preserve the exact `agentId`, `processNonce`, `workId`, `claimId`, and `intentId` values returned by
the active session and claim. Never reconstruct them from a path, chat message, old receipt, or
another process.

## Truthful choreography

1. After acknowledging chat but before claiming work, use `presence thinking` only while actually
   reasoning. A receipt alone must never produce `working`.
2. After the exact WorkClaim succeeds, start this in a separate long-lived process/tool session:
   `tweak session listen --session <sessionId> --presence working --until-work-settled <workId>`.
   Its authenticated socket sustains Working and renews that exact claim lease. Start failure is
   non-authoritative: disclose unavailable live status, continue under the valid claim, and never
   assert Working. Browser/API evidence MUST observe the listener's current daemon origin. A shell
   left on the old port after an explicit restart is stale-generation evidence and cannot grade
   Working, progress, or settlement.
3. Heartbeat renews authority only; do not describe it as progress.
4. Run `work progress` only for a truthful partial or phase milestone. Nonempty intent IDs become
   durably addressed; when all remaining intents are addressed, publish and complete instead. An
   evidence milestone may use no intent IDs. Never emit timer-, hook-, token-, or lifecycle-derived
   progress.
5. On completion, publish intended bytes and complete through the claim-derived route; the listener
   exits when exact work settles. On pause or block, stop the listener and use `work progress
   --release` only when a real milestone exists. Human acceptance remains a later human fact.
6. `presence idle` is optional after listener close. Renewal rejection or exact-claim replacement
   makes the listener emit `work.listener-claim-lost`, close its socket, and remove Working without
   mutating durable work. Socket close or TTL expiry prevents permanent Working; failure to clear
   live presence must be disclosed but never rolls back durable work.

Every nonzero heartbeat, progress, publication, or completion stops the next mutation and loads
[`recovery-and-inspection.md`](recovery-and-inspection.md). Do not fabricate a replacement claim or
milestone. If a presence update fails, do not claim that the shell shows live activity; the durable
claim remains governed by its lease.
