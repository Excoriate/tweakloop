# Failure behavior, testing strategy and invariants

Covers sections 26, 27 and 28 of the authoritative architecture. Back to the [index](README.md).

## 26. Failure and recovery behavior

| Failure | Required behavior |
|---|---|
| Daemon crashes after command commit | Restart reconstructs projections and clients resume after event sequence |
| Daemon crashes before commit | No partial durable effect |
| CLI setup fails before publication | Reject before the first artifact/revision fact; no hidden durable effect |
| CLI setup fails after publication | Return the exact committed artifact/revision/seq and an executable recovery action; never report an unqualified total failure |
| CLI retries a successful command | Idempotency receipt returns original response |
| Browser refreshes | Fetch projection snapshot, then resume event stream |
| Agent exits before claiming | Work remains claimable |
| Agent exits after claiming | Lease expires; abandonment becomes visible |
| Stale agent completes old claim | Reject completion |
| Two agents publish from same parent | Preserve both branches |
| Source file changes mid-read | Reject or retry snapshot; never publish mixed bytes |
| Annotation target disappears | Mark orphaned; never silently retarget |
| Evidence references old Git SHA | Mark stale |
| No agent is listening | Feedback remains submitted and visible |
| Artifact script crashes | Shell remains operational and exposes renderer failure |
| Artifact attempts shell mutation | Origin and credential boundary rejects it |
| Projection table corrupts | Rebuild from event log |
| Object is missing for known hash | Raise integrity failure; do not fabricate revision |

## 27. Testing strategy

### 27.1 Domain tests

Test commands as tables of:

```text
prior facts
command
expected events
expected rejection
```

Test every invariant without database or HTTP.

### 27.2 Projection replay tests

For each event fixture:

1. build projection incrementally;
2. rebuild projection from the full event sequence;
3. assert equality.

### 27.3 Property and model-based tests

Generate sequences involving:

- submit;
- supersede;
- claim;
- expire;
- reclaim;
- complete;
- verify;
- accept;
- reopen;
- publish competing revisions.

Assert invariants after every event.

### 27.4 Concurrency tests

Prove:

- one work item cannot have two live claims;
- duplicate idempotency keys do not duplicate events;
- stale stream versions fail;
- concurrent revision publications create branches;
- readers never observe half-written projection changes.

### 27.5 Crash tests

Kill the daemon:

- before object rename;
- after object rename but before event commit;
- during projection update;
- after event commit but before HTTP response;
- during browser event delivery.

Verify recovery and idempotent retry.

Also inject client-side failures on both sides of the commit boundary. A pre-publication rejection
must preserve exact event and projection equality. A post-publication rejection must expose a typed
committed-result receipt; executing its returned recovery command must reuse the same artifact and
revision rather than create a second revision. A green retry alone is insufficient because it can
hide an acknowledgement split-brain.

### 27.6 Artifact tests

Maintain golden fixtures for:

- malformed HTML;
- nested local assets;
- missing assets;
- interactive forms;
- custom JavaScript;
- large documents;
- duplicate semantic IDs;
- Markdown heading edits;
- moved sections;
- deleted annotation targets;
- CSP-bearing documents;
- browser history navigation.

### 27.7 Browser security tests

Use Playwright to verify:

- artifact cannot read shell DOM;
- artifact cannot call mutation API;
- shell rejects wrong Origin;
- bridge rejects wrong source and malformed messages;
- interaction works in Chrome, Firefox and WebKit;
- annotation mode never silently disables native controls;
- expired bootstrap tokens fail;
- token disappears from final browser URL.

## 28. Architecture invariants

The implementation is unacceptable unless all of these hold:

1. An existing revision's bytes never change.
2. A submitted intent is never lost during daemon or agent crashes.
3. A retried command never produces duplicate durable effects.
4. No work item has two valid active claims.
5. A stale agent cannot complete work under an expired claim.
6. Concurrent agent revisions never silently overwrite one another.
7. Wall-clock timestamps never determine authoritative ordering.
8. A missing semantic target is visible as orphaned.
9. Artifact JavaScript cannot invoke privileged shell mutations.
10. Projections can be fully rebuilt from durable facts.
11. Browser refresh does not alter workflow truth.
12. Agent presence does not determine whether feedback may be submitted.
13. Agent prose does not count as verification evidence by itself.
14. Approval of one revision does not automatically approve changed content.
15. The domain core runs with no filesystem, network or database.
16. Public protocol schemas are versioned independently from implementation code.
17. Old protocol data remains readable after additive evolution.
18. The CLI emits clean, stable machine output.
19. A mutable source file is never served as if it were an immutable reviewed revision.
20. Repository modification remains outside the daemon's initial trusted boundary.
