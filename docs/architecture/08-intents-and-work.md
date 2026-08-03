# Typed intents and the work model

Covers sections 12 and 13 of the authoritative architecture. Back to the [index](README.md).

## 12. Typed intent model

Free-form messages remain available, but they are the fallback.

Initial intent types:

| Intent type | Meaning |
|---|---|
| `comment` | Non-prescriptive observation |
| `question` | Request explanation before change |
| `replace-text` | Exact textual replacement |
| `remove` | Remove a semantic node |
| `move` | Change semantic ordering or parent |
| `choose` | Select one structured option |
| `reject-option` | Explicitly reject an option |
| `add-constraint` | Add a rule future work must preserve |
| `approve-node` | Approve a node at a specific revision/hash |
| `request-implementation` | Authorize repository changes |
| `request-verification` | Require defined evidence |
| `accept-result` | Human accepts addressed work |
| `reopen` | Accepted or addressed work is insufficient |

Example:

```json
{
  "$schema": "https://tweakloop.dev/schemas/intent/add-constraint/v1.json",
  "intentId": "intent_...",
  "type": "add-constraint",
  "target": {
    "artifactId": "artifact_...",
    "revisionId": "rev_...",
    "semanticId": "architecture.network-ingress"
  },
  "constraint": {
    "statement": "No public ingress is permitted.",
    "scope": "architecture-and-implementation"
  },
  "rationale": "All access must remain on private networking."
}
```

### 12.1 Review batches

The browser may accumulate drafts.

Pressing **Submit review** performs one transaction that:

1. creates a `review.batch-submitted` event;
2. creates immutable intent events;
3. creates or updates the corresponding work item;
4. clears submitted drafts;
5. publishes the committed events.

This gives humans a deliberate commit boundary without conflating it with agent presence.

### 12.2 Approval is revision-specific

Approving a node means:

> The human approved this semantic node with this content digest at this revision.

If a later revision changes the approved node, the projection shows the approval as invalidated.

Do not mutate the prior approval.

Do not prohibit changes mechanically unless the human explicitly created a constraint to do so.

## 13. Work model for arbitrary agents

### 13.1 Agents are external actors

The Tweakloop core must have no special code paths for Claude Code, Codex, OpenCode, or OMP.

An agent only needs to:

- invoke the CLI;
- parse versioned output;
- read artifact or source files;
- claim work;
- publish a revision;
- record a result and evidence.

Agent-specific skills and hooks are discovery adapters, not core architecture.

### 13.2 Work item

A work item references:

- one or more intent IDs;
- the revision reviewed by the human;
- expected capabilities;
- dependencies;
- optional verification requirements;
- priority;
- project and workspace.

Avoid creating a general DAG scheduler in v0.1.

Support only:

- independent work;
- explicit `dependsOn` relationships;
- one active claim per work item.

### 13.3 Durable claim, ephemeral lease

Claiming work produces a durable `work.claimed` event.

The active lease is maintained in an ephemeral table:

```text
work_id
claim_id
agent_id
process_nonce
expires_at
last_heartbeat_at
```

Rules:

- claim is atomic;
- only one non-expired lease exists per work item;
- heartbeat extends the lease;
- agent completion requires the claim ID;
- expired work becomes claimable;
- reclaiming records `work.abandoned` for the previous claim;
- stale claim completion is rejected;
- a human can explicitly cancel or supersede work.

### 13.4 No global "agent working" lock

Humans may submit more feedback while an agent works.

New feedback can:

- join an unclaimed work item;
- become a new work item;
- supersede an earlier intent;
- wait on the current work item.

Do not disable all human input because one agent is active.

Agent presence is informational. It is not a global synchronization primitive.
