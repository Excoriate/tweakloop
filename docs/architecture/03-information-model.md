# Information model

Covers section 6 of the authoritative architecture. Back to the [index](README.md).

## 6. Information model

Tweakloop should resemble the **information-model discipline** of Datomic without attempting to reimplement Datomic. Datomic treats durable information as immutable facts ordered by transactions; Tweakloop needs the same conceptual benefit at a much smaller, embedded scale.

### 6.1 Principal entities

| Entity | Purpose |
|---|---|
| Project | Connects related workspace instances |
| Workspace | Local authority and repository context |
| Artifact | Stable identity of a reviewable thing |
| Revision | Immutable artifact snapshot |
| Semantic node | Stable addressable concept within a revision |
| Review batch | Human submission boundary |
| Intent | One typed human request, question, constraint, or decision |
| Work item | Unit offered to agents |
| Claim | Temporary ownership of work |
| Result | Agent account of what it changed |
| Evidence | Immutable proof attached to a result or verification |
| Verification | Evaluation of evidence against an expectation |
| Decision | Human acceptance, rejection, approval, or reopening |

### 6.2 Events, not mutable histories

Use a compact event vocabulary.

Initial event families:

```text
project.registered
workspace.opened

artifact.registered
artifact.revision-published
artifact.revision-presented
artifact.anchor-orphaned

review.batch-submitted

intent.created
intent.superseded
intent.cancelled

work.created
work.claimed
work.abandoned
work.addressed

evidence.recorded
verification.recorded

decision.approved
decision.accepted
decision.rejected
decision.reopened
```

Do not create a new event for every UI movement.

Durable events represent facts relevant to workflow history.

### 6.3 Ephemeral state is allowed, but must be named as such

The following do not belong in the durable event log:

- cursor position;
- hover state;
- open panels;
- agent heartbeat packets;
- browser connection presence;
- unsaved keystrokes;
- current iframe scroll position;
- temporary selection geometry.

Crash-resilient drafts and runtime leases may use mutable tables because they are explicitly working state, not historical truth.

Examples:

```text
review_drafts
runtime_leases
browser_presence
projection_offsets
```

Submitting a draft creates immutable intent events.

Claiming work creates a durable `work.claimed` event, while heartbeat renewal updates the ephemeral lease record.

This prevents heartbeat noise from polluting domain history.
