---
name: architecture-diagram
description: 'Use for editable Tweakloop architecture scenes. NOT for Mermaid, prose, freehand, or raw JSON.'
metadata:
  builder_provenance: true
  substrate: artifact
  secondary_substrate: coherence-oracle
---

# Architecture diagram — semantic scene orchestration

## Enforcement Contract

This skill is a thin planner over a server-owned scene capability. **MUST** discover the current
interface before mutation. **NEVER** invent request fields, renderer IDs, element versions, nonces,
bindings, raw renderer coordinates, or raw Excalidraw objects. Manual semantic `--x`/`--y`
placement is allowed only for an explicitly requested fixed position and is never the default.
Missing capability makes scene creation **BLOCKED**, not partially successful.

## Mental Model — semantic graph first and renderer projection second

Model architecture as named components and relationships. Tweakloop owns renderer bookkeeping and
returns the durable scene receipt; the browser render is a projection used to judge coherence.

## Decision Core — select the right diagram route

| Trigger / condition | Action | Why / wrong neighbor |
|---|---|---|
| Basic components, directed relationships, labels, boundaries, or groups | Use this skill after the capability probe | Semantic identity survives renderer/layout changes. |
| Existing editable board needs freeform, decorative, or precise native edits | Route to [Excalidraw](../excalidraw/SKILL.md) | This skill does not control pixels or raw elements. |
| The requested output is only explanatory prose or Mermaid | Stay in the requested medium | Creating a Tweakloop board would add an unwanted artifact. |
| The scene capability is absent or its schema is not discoverable | Stop; use the truthful fallback below | Guessing a transport can fabricate success or corrupt identity. |

## Heuristic Chain — graph before layout

For ambiguous boundaries or relationship direction, load
[`architecture-grammar.md`](knowledge/architecture-grammar.md) before planning.

1. Extract one stable semantic key per component, relationship, and group, plus one plain-language
   role label for each node or edge that needs visible text. Freeze this exact key ledger before the
   first mutation. Merge synonyms; do not create one box per noun, reorder key words later, or use a
   display phrase as an alias for a frozen semantic key.
2. State every relationship as `source → meaning → target`. If direction or meaning is unknown,
   label the uncertainty instead of implying a dependency.
3. Use groups only for a real boundary (ownership, trust, runtime, or lifecycle), never as decoration.
4. Keep labels short enough to scan. Put explanation in the review document, not inside every node.
5. Apply layout last. Layout may move shapes; it must not change semantic keys or graph meaning.

## Generator Route — capability-gated semantic commands

1. Pin the executable and workspace through the [Tweakloop skill](../tweakloop/SKILL.md).
2. Run `tweak whiteboard scene --help`. Continue only when the runtime help lists `add-node`,
   `add-edge`, `set-label`, `group`, `layout`, `inspect`, and `publish`. Source can be newer than the
   executable; parent `whiteboard` help without those leaves means the runtime is stale and mutation
   is **BLOCKED**. Apply the authority and proof split in
   [`semantic-scene-boundary.md`](references/semantic-scene-boundary.md).
3. Inspect before mutation with `tweak whiteboard scene inspect <document> --json`. A successful
   read exposes only `protocol`, `artifactId`, and the semantic `scene` collections; preserve that
   public projection and do not infer private draft/base/hash/version state. Exactly one failure has
   a safe creation route: `error.code` is `whiteboard.draft-missing`, durable identity proves the
   document is a published whiteboard attached to the active session, and this change is creating its
   first managed semantic draft. In that cold-start state, continue with exactly the first planned
   idempotent semantic mutation, preserve its accepted receipt, then immediately inspect again. The
   second inspect MUST succeed before any later mutation or publication. Every other inspect failure
   makes mutation **BLOCKED**.
4. Choose one stable semantic key for every component, edge, and group. Choose one visible stable
   `<change-id>` for this logical change and derive a different idempotency key per mutation. A retry
   MUST repeat the exact same command with the same key; a different mutation MUST use a different
   key. Every later `--from`, `--to`, `--members`, `--scope`, and label target MUST be copied from
   that frozen ledger or from the exact `semanticKey` returned by a successful inspect; never
   improvise a near-name.
5. Form the semantic graph in this order:

   - `node.upsert` for each stable component;
   - `label.set` only to change or clear an already-existing node or edge label;
   - `edge.upsert` for each directed relationship;
   - `group.set` only for justified boundaries;
   - `layout.apply` once, after graph meaning is complete.

### Executable current-source grammar

The following public spelling is verified against the current repository source. Runtime help MUST
still expose it before use:

```text
tweak whiteboard scene add-node <document> <semanticKey> --session <id> --idempotency-key <key> [--shape rectangle|ellipse|diamond] [--label <text>] [--x <number> --y <number>]
tweak whiteboard scene add-edge <document> <semanticKey> --session <id> --idempotency-key <key> --from <semanticKey> --to <semanticKey> [--label <text>]
tweak whiteboard scene set-label <document> <target> --session <id> --idempotency-key <key> (--text <text>|--clear)
tweak whiteboard scene group <document> <semanticKey> --session <id> --idempotency-key <key> --members <semanticKey...>
tweak whiteboard scene layout <document> --session <id> --idempotency-key <key> [--direction lr|tb] [--gap <number>] [--scope <semanticKey...>]
tweak whiteboard scene inspect <document>
tweak whiteboard scene publish <document> --idempotency-key <key> [--agent <id>]
```

`set-label` targets only a node or edge semantic key that exists in the latest successful inspect.
It NEVER targets `scene.groups`: public group inspection contains only `semanticKey` and `members`,
and the public scene protocol has no group-label field. A non-empty group renders one server-owned,
locked, unlabeled enclosure around its current members; that enclosure is a projection, not another
semantic entity. Prefer `--label` on `add-node`/`add-edge` when the label is known at creation. Give a
group a descriptive stable key such as `order-service-boundary`, but do not issue a second label
command for it. If visible text naming the container is essential, report that the current semantic
group capability is insufficient instead of fabricating a label target.

For the normal architecture route, MUST omit `--x` and `--y`; manual placement is an explicit
exception for a requested fixed semantic position and both coordinates are required together.
Deterministic `layout` is the default because hand coordinates braid architecture meaning with one
renderer projection.

### Normal agent workflow

Replace angle-bracket values with the pinned document, active session receipt, agent identity, and a
stable change identity. These commands deliberately use stable keys and no manual placement:

```bash
# Existing draft: this succeeds and establishes the before-scene.
# Fresh published board: ONLY error.code=whiteboard.draft-missing permits the first add-node below;
# its accepted receipt initializes the managed draft, and the immediately following inspect is required.
tweak whiteboard scene inspect <document> --json
tweak whiteboard scene add-node <document> browser --session <session-id> --idempotency-key <change-id>-node-browser --shape rectangle --label "Browser"
tweak whiteboard scene inspect <document> --json
tweak whiteboard scene add-node <document> api --session <session-id> --idempotency-key <change-id>-node-api --shape rectangle
tweak whiteboard scene set-label <document> api --session <session-id> --idempotency-key <change-id>-label-api --text "API"
tweak whiteboard scene add-node <document> database --session <session-id> --idempotency-key <change-id>-node-database --shape rectangle --label "Database"
tweak whiteboard scene add-edge <document> browser-calls-api --session <session-id> --idempotency-key <change-id>-edge-browser-api --from browser --to api --label "calls"
tweak whiteboard scene add-edge <document> api-reads-database --session <session-id> --idempotency-key <change-id>-edge-api-database --from api --to database --label "reads"
tweak whiteboard scene group <document> service-runtime --session <session-id> --idempotency-key <change-id>-group-service-runtime --members api database
tweak whiteboard scene layout <document> --session <session-id> --idempotency-key <change-id>-layout-main --direction lr --gap 96
tweak whiteboard scene inspect <document> --json
tweak whiteboard scene publish <document> --idempotency-key <change-id>-publish --agent <agent-id>
tweak session url <session-id> --document <document> --json
```

6. Preserve every mutation receipt. When the pre-inspect succeeded, compare the final scene with the
   before-scene. On cold start, treat the first accepted mutation receipt plus its immediate
   successful inspect as the initialization witness instead; the final scene must still contain all
   intended stable keys, endpoints, and group membership. Deterministic layout must not change graph
   meaning. Before any `set-label`, require its exact target in the inspected `scene.nodes` or
   `scene.edges`; membership in `scene.groups` is an explicit rejection condition. Do not translate
   receipts into guessed scene fields.
7. Publish only the inspected draft. Preserve the publication receipt. For the already-active
   session, mint the review handoff with
   `tweak session url <session-id> --document <document> --json`; it creates no durable event,
   revision, or session. Never call `tweak open` merely to obtain the post-publication review URL:
   that can republish or create/attach a different session. Treat the one-use URL as private browser
   authority and do not consume it during agent-side verification. Publication is not human
   acceptance; close only after the distinct human review fact exists.

No other scene operation is authorized by this skill. If current help exposes a different operation
set or requires renderer-owned fields, stop and report the contract mismatch.

## Coherence Oracle — artifact and meaning must agree

Verification requires both surfaces:

- **Artifact oracle:** the accepted scene receipt accounts for every planned semantic operation,
  reports no unknown operation, and retains the intended diagram identity.
- **Coherence oracle:** the rendered result has every required component and relationship, arrows
  point the intended way, every non-empty semantic group has one locked enclosure around all and only
  its current members, node/edge labels do not collide or truncate, and layout does not imply a false
  hierarchy. Do not claim a visible group label: the enclosure proves the boundary, while the public
  group model still has no label field.

An exit code, parse success, or attractive screenshot alone is insufficient. A plausibly wrong
control swaps one edge direction: artifact shape may remain valid, but the coherence oracle must
reject the changed meaning.

## Worked Example — three-tier service topology

For “browser calls API; API reads database; API and database are inside the service boundary,” use
the normal workflow above. An existing draft starts with a successful inspect. A fresh published
board takes only the typed `whiteboard.draft-missing` branch, creates Browser with one stable-key
mutation, and immediately proves initialization by inspecting it. Then create the remaining nodes,
labels, two directed edges, and one justified group; apply one `lr` layout, inspect again, publish,
and mint the non-mutating review handoff with `session url`.
Before publishing, read relationships aloud from source to target. After rendering, verify the
database is not shown calling the API and the browser is not accidentally inside the service group.
The command-complete specimen is `examples/service-topology/README.md`.
Use `examples/routing-calibration/README.md` for 5+5 and wrong-neighbor routing, and
`examples/ablations/README.md` for native-wrapper, scene-builder, and section-removal controls.

## Truthful Fallback — absence is not a scene

If `tweak whiteboard scene --help` is unavailable, rejects the route, or does not document a schema:

1. make no board mutation and say **BLOCKED: semantic scene capability unavailable or unconfirmed**;
2. preserve the semantic graph as a reviewable text plan, explicitly labeled **not an editable
   whiteboard**;
3. route to [Excalidraw](../excalidraw/SKILL.md) only when a native editor is currently controllable;
4. name the missing probe needed to promote the result: accepted scene receipt plus rendered review.

## Structure Declaration

| Directory | Status and reason |
|---|---|
| `knowledge/` | INCLUDED — the graph grammar prevents decorative topology mistakes. |
| `references/` | INCLUDED — the semantic boundary prevents transport and renderer drift. |
| `scripts/` | OMITTED — a wrapper risks freezing the wrong CLI request schema. |
| `assets/` | OMITTED — a scene template risks smuggling renderer-owned fields. |
| `examples/` | INCLUDED — specimens expose direction, grouping, and routing failures. |
| `tests/` | OMITTED — repository tests prevent operation and fallback drift. |
