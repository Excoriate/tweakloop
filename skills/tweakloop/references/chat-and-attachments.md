---
title: Chat, references, and attachments
description: Load for finite chat receipt, acknowledgement, context references, attachment disclosure, and chat-to-work promotion.
---

# Chat, references, and attachments

Load this reference only to send/receive chat or carry a file, document, comment, task, selection,
reference, or attachment. It does not own workspace reconstruction or whiteboard internals.

## Receive and acknowledge

Use the finite turn-shaped selector:

```bash
tweak next --session <sessionId> --wait --timeout 300000 --json
```

This unified selector is the default when one consumer must wake for either chat or work.
When a deployment deliberately runs separate waiters, use the exact filtered facades instead:

```bash
tweak chat next --session <sessionId> --wait --timeout 300000 --json
tweak work next --session <sessionId> --wait --timeout 300000 --json
```

Both share the same atomic selector and recovery authority. A filtered waiter leaves the excluded
kind untouched; do not run all three against one session unless competing consumers are intended.

Execute a chat delivery's returned `acknowledgeCommand` exactly, handle the message, then call
`next` again. Acknowledgement proves receipt, not comprehension. Use `session listen` only for a
persistent daemon/TUI or live whiteboard consumer. An ordinary empty timeout is a typed `none`
result with exit code 0; transport uncertainty is a typed `indeterminate` result with exit code 3
and an exact recovery command.

`redeliveryEligibleAt` is retry eligibility, not authority expiry. The exact acknowledgement stays
valid until a newer delivery generation supersedes it, and receipt never authorizes side effects.
For action-bearing text, promote the message to Work, claim that Work, then mutate. Do not infer
ongoing live presence from an acknowledgement after the finite agent turn exits.

## Ask one bounded choice

Use typed chat only when progress depends on a genuine 2–8 option choice. Keys and labels must be
unique; the active session agent asks, and the human answers in that exact session:

```bash
tweak question ask "Which rollout should I implement?" --session <sessionId> \
  --option staged="Staged rollout" immediate="Immediate cutover" --json
tweak question wait <questionMessageId> --timeout 300000 --json
```

`question wait` blocks for that exact question, emits one answered/timeout JSON result, and exits.
It does not select an ambient latest question or keep a stream open. A changed human choice is a new
immutable answer that explicitly supersedes the current answer; earlier answers remain history.
Question and answer facts do not create work, accept a revision, or acknowledge delivery.

## Send with durable context

Stable references carry identity; labels are presentation only. Supported shapes include document
artifact, artifact+revision selection, comment intent, task work, whiteboard artifact, and file
hash. Inspect every referenced source and preserve its stable identity.

```bash
tweak chat send "Here is the result." --session <sessionId> \
  --attach <intentional-existing-path...> \
  --document <artifactId-or-path> --comment <intentId...> --task <workId...> --json
tweak chat send "Changing exactly this passage." --session <sessionId> \
  --selection <artifactId-or-path> --quote "exact selected text" \
  --semantic-id <anchor> --json
tweak chat send "I claimed this work and its references." \
  --from-work <workId> --attach <intentional-existing-path...> --json
```

Prefer `--from-work`: it preserves the task, every comment, and every selection-bearing intent,
including multiple selections, without copied tuples. A session or work derives agent identity and
must reject conflicting explicit `--agent` values.

Attachments are intentional disclosure. If the path is absent, ambiguous, or not the intended
bytes, sending is **BLOCKED**; never search for a plausible same-named file or silently omit it.
Fetch a received content-addressed attachment to a new path with:

```bash
tweak chat attachment fetch <file.hash> <new-local-path> --json
```

The hash must verify and an existing destination must not be overwritten.

## Promote actionable chat

Ordinary chat remains conversational. Before acting on a substantive change request, promote the
exact durable message rather than copying its text:

```bash
tweak chat promote <messageId> --session <sessionId> --json
```

The receipt links `intentId` and `workId`; claim/receive that work, publish a descendant revision,
complete it, and wait for Accept or Another pass. Promotion is idempotent. Stale, artifact-free,
changed, already-tracked, or agent-authored messages fail without creating duplicate work. Only a
durable human-authored message can become human review intent.
