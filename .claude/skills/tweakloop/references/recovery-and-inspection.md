---
title: Recovery and inspection
description: Load for exact returned recovery commands, stale state, daemon or claim failure, rollback, and explicit full-history inspection.
---

# Recovery and inspection

Load this reference only for partial publish-complete, daemon/claim/lease failure, a stale returned
command, restore/check failure, rollback, or explicit full-history inspection. Healthy ordinary
review should not load it.

## Recovery rule

Use the executable prefix selected by the core invocation gate. Execute the exact recovery or
recompute command returned by the failed receipt; never hard-code global `tweak`, synthesize IDs, or
retry a stale state-conditioned action. A stale `nextAction` must fail before mutation and return a
fresh recompute route. If the command prefix is unavailable or current state no longer matches the
receipt, stop and re-inspect.

For a partial `publish --complete`, do not separately complete a guessed revision. Preserve the
receipt, run its recovery action verbatim, and confirm whether publication occurred and completion
did not before retrying.

For `open.committed-partial`, publication already succeeded even though review-session setup did
not. Treat `error.details.committed` as the durable result: preserve its exact `artifactId`,
`revisionId`, and database `seq`. The envelope is deliberately `retryable:false`; do not blindly
rerun `open` or reconstruct its arguments. Execute `error.nextAction.command` verbatim. A correct
recovery returns the same artifact and revision with `unchanged:true`, never a second revision.

For `runtime-capability.daemon-generation-changed`, the requested semantic mutation did not mint an
automation token and reports `details.mutated:false`. Preserve its visible idempotency key, execute
`error.nextAction.command` verbatim, and take the returned successor `sessionId`. Retry the original
scene command with that successor and the same business key. Never copy the predecessor capability,
invent a successor ID, or reuse this route for a generic identity/custody mismatch.

## Claims and leases

A finite `next` work result already owns its claim; do not claim twice. For deliberately batched
work use:

```bash
tweak work claim --session <sessionId> --all --json
```

Long work may require the exact returned heartbeat action. After process restart/lease expiry use
the exact `tweak work recover ... --json` action from current inspection. Never overwrite another
live claim or reconstruct agent/process/claim IDs from memory.

## Inspect only as deeply as needed

```bash
tweak status --summary --json
tweak work list --json
tweak session list --document <id-or-path> --json
tweak events list --json
```

The summary and compact open-work view are defaults. Request full status/history only when the
failure hypothesis needs it; event order comes from database sequence, not wall-clock time. A
daemon-unavailable result is not an empty workspace.

## Roll back without rewriting history

```bash
tweak restore <revisionId> --json
```

Restore republishes old immutable content as the new head; it never rewrites history. If the human
restored from the shell, run the exact returned restore/recompute action or re-fetch the current
source before editing. A restore or browser-check failure remains a failure—do not promote source
syntax or an old local file to current runtime truth.
