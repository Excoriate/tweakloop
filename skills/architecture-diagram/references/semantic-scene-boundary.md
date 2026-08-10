---
title: Semantic scene boundary
description: Capability, operation, authority, and proof constraints for architecture scene mutation.
---

# Semantic scene boundary

The current repository source defines seven public leaves: `add-node`, `add-edge`, `set-label`,
`group`, `layout`, `inspect`, and `publish`. They map to `node.upsert`, `edge.upsert`, `label.set`,
`group.set`, and `layout.apply`; the agent never authors the request envelope or raw payload fields.
At runtime, `tweak whiteboard scene --help` is the capability authority. If it shows only parent
`whiteboard` commands or omits any required leaf, the installed distribution is stale/absent and the
skill MUST take its truthful fallback.

Every mutation requires the active `--session` receipt and a caller-visible `--idempotency-key`.
The key identifies one logical mutation and MUST stay stable across exact retries; different
mutations MUST have distinct keys. `inspect` normally brackets mutation. A published whiteboard may
not yet have a managed semantic draft: only the typed `whiteboard.draft-missing` failure on the
identity-resolved active-session document permits one first idempotent semantic mutation to
initialize it. The accepted receipt MUST be followed immediately by a successful inspect before any
later mutation or publication. `layout` is deterministic and last, and `publish` targets the exact
inspected draft. `set-label` requires exactly one of `--text` or `--clear`. Manual node `--x`/`--y`
placement is not the default architecture route and both values must be present when the exceptional
fixed-placement route is explicitly requested.

`label.set` is deliberately narrower than the word “entity” suggests: its target MUST be an active
node or edge key from the latest successful inspect. A semantic group exposes exactly `semanticKey`
plus `members`; it has no public label field and is never a `set-label` target. The renderer derives
one locked, unlabeled boundary enclosure for each non-empty group without exposing renderer identity
through inspect. Freeze the node, edge, and group key ledger before mutation and copy exact keys into
all later targets, endpoints, member lists, and scopes. Near-name aliases such as `order-service`
for an inspected `order-service-boundary` are invalid even when their prose meaning is similar.

After semantic publication in an already-active session, `tweak session url <session-id>
--document <document> --json` is the only review-link route taught here. It mints a private one-use
browser capability without adding an event, revision, attachment, or session. `tweak open` is not a
review-link helper: using it after publication can churn durable identity or content. Do not consume
the returned one-use URL during agent-side verification.

The server owns renderer identity, raw geometry/coordinates, versions, nonces, bindings, file
references, and serialization. The optional paired `--x`/`--y` flags are the only public semantic
placement exception; the agent never authors renderer geometry. The agent owns semantic keys,
architecture meaning, operation ordering, stable business retry keys, and receipt accounting. The
coherence judge owns whether the rendered topology tells the intended truth.

A parseable command is structural proof. An accepted durable receipt proves the named mutation. A
before/after inspect comparison proves semantic state for an existing draft. On cold start, the
first accepted receipt plus immediate inspect proves initialization; the final inspect proves the
completed semantic state. A rendered check can prove visible effect. Only their combination, with a
reversed-edge or wrong-group control, supports a topology-correctness claim. Publication is not
review acceptance. None of these proves installed skill activation or human acceptance in a fresh
review session.

Verification note: command grammar was checked against the current `src/cli/index.ts` semantic scene
subtree and the rebuilt checkout `dist/cli/index.js` help on 2026-08-08; both expose all seven
leaves. This checkout proof does not promote an older installed binary or a registry package, so
every run still performs the runtime help gate.
