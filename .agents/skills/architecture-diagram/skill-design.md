---
title: Architecture diagram skill design
summary: Thin semantic-scene orchestration with artifact and coherence oracles.
type: design
---

# Skill design — architecture-diagram

## Endgame

A fresh agent turns a basic architecture request into an editable Tweakloop scene without owning
Excalidraw internals. The hardest normal case is a boundary whose visual grouping must not change
edge meaning. The rejected near-miss is a polished screenshot or valid scene receipt with a reversed
dependency. When the scene interface is absent, the golden outcome is an explicit stop plus a text
plan labeled as not an editable whiteboard.

## Evidence ledger

| Claim (load-bearing) | Class | Warrant |
|---|---|---|
| The public source grammar is `add-node`, `add-edge`, `set-label`, `group`, `layout`, `inspect`, and `publish`, mapping to five semantic operations. | Known | Current `src/cli/index.ts` semantic scene subtree inspected 2026-08-08. |
| A first semantic mutation can initialize a managed draft for a published whiteboard whose inspect returns `whiteboard.draft-missing`. | Known | Fresh isolated agent probe: direct `add-node` exited 0 and the immediate inspect returned one node. |
| Inspect exposes only the closed semantic projection, never draft/base/hash/version state. | Known | Current projector, CLI reference contract, and focused inspect projection tests. |
| A non-empty semantic group projects to one server-owned, locked, unlabeled enclosure around exactly its members; the enclosure is not a public semantic entity or a `set-label` target. | Inferred pending final behavioral proof | The group renderer and strict projection controls are being repaired after held-out dogfood proved that membership-only state can look correct to inspect while rendering no visible boundary. |
| Post-publication review handoff in an active session must use non-mutating `session url`, not `open`. | Known | Held-out fresh agent used the ambiguous former guidance, created an avoidable revision/session, then recovered; current CLI contract says `session url` creates no durable event, revision, or session. |
| Renderer IDs, raw geometry/coordinates, versions, nonces, and bindings stay behind the scene boundary; paired semantic x/y is an explicit non-default CLI exception. | Known | Current CLI source plus R38/R47 and the upgraded Excalidraw skill contract. |
| Artifact acceptance plus a coherence oracle detects valid-but-wrong architecture. | Inferred | A reversed-edge control remains structurally valid but fails semantic reading. |
| The rebuilt checkout distribution exposes the current-source scene leaves. | Known | Final package-help parity and fresh-agent runtime help exposed all seven leaves on 2026-08-08. |
| A future installed CLI exposes the source-confirmed scene grammar. | Unknown | Probe: run `tweak whiteboard scene --help`, then an isolated accepted mutation, before/after inspect, publish, and rendered review. |
| A fresh isolated Codex session activates and follows this checkout skill. | Known | Fresh-agent dogfood loaded the skill and reproduced its former pre-inspect dead-end; rerun after repair is the behavioral promotion probe. |
| Fresh Claude or Cursor sessions activate this skill. | Unknown | Probe: isolated listing, invocation, and observed route in each client. |

## Make-vs-buy verdict

**Verdict: Skill.** Architecture-to-scene judgment is episodic and transferable; renderer and
transport implementation belongs to Tweakloop. A root rule would burden unrelated work, while a new
scene generator would duplicate the server boundary.

## Golden end-state

- **PRIMARY substrate:** artifact
- **SECONDARY substrate:** coherence-oracle
- **CEILING surface:** accepted semantic receipt plus rendered human review
- **Cardinality:** one diagram tuple containing graph plan, accepted scene, and coherence grade
- **Judge-availability:** current-source and rebuilt-checkout grammar known; behavioral ceiling requires the repaired fresh-agent run, accepted scene, and rendered review
- **Near-miss:** a valid scene with one reversed edge or decorative group implying false ownership
- **Base-model negative control:** without the skill, an agent may invent raw JSON or claim a board from a text plan; with it, capability absence stops mutation and valid-but-wrong meaning is rejected.

## Discrimination Evidence Record

| Decision surface | Base-model prediction without upgrade | Skill-shifted outcome and mechanism | Discriminating observable | Already-knows check |
|---|---|---|---|---|
| Semantic mutation | Lists `node.upsert` and peers or invents a payload. | Uses the seven exact leaf commands with document, session, stable per-mutation idempotency keys, endpoints/members/options, inspect, and publish. | An operation-name-only impostor fails focused tests because no executable command grammar or lifecycle exists. | The prior certified skill demonstrated the baseline failure, so the command grammar is load-bearing. |
| Placement | Adds manual x/y to make a tidy screenshot. | Omits x/y by default and runs one deterministic layout after graph completion. | Normal specimen contains layout direction/gap and no coordinate flags. | Base models often reach for coordinates in drawing tasks; the abstraction boundary changes that route. |
| Service boundary | Treats `group.set` membership or a group key as sufficient visual proof, or tries to label the group as if it were a node. | Freezes the exact group key, never calls `set-label` on it, and requires the renderer-owned locked enclosure to contain all and only the declared members. | A membership-only renderer and a near-name group label both fail the focused boundary oracle even though the semantic group can exist. | Held-out dogfood and the independent attack demonstrated that accepted group membership can still produce a visually absent boundary. |
| Capability truth | Treats current source or exit 0 from parent help as installed support. | Requires all seven leaves in runtime help; otherwise emits BLOCKED plus a non-whiteboard text plan. | Stale checked-in dist triggers fallback despite current source containing the commands. | Source/runtime skew is repository-specific and not safely supplied by generic knowledge. |
| Completion | Stops at mutation receipt or publish, or calls `open` again only to obtain a URL. | Existing drafts bracket with inspect; a cold start accepts only typed `whiteboard.draft-missing`, requires one first mutation receipt plus immediate inspect, publishes the final inspected draft, mints a non-mutating `session url` handoff, then requires a distinct human review fact. | An English error match or unchecked first mutation could widen failure into unauthorized creation; `open` can churn identity/content; publication without after-inspect and review cannot satisfy the artifact/coherence ceiling. | Fresh-agent dogfood proved both the former mandatory pre-inspect dead end and the ambiguous post-publish handoff. |

## Native Shape
Shape: semantic-compiler
Spine: Enforcement Contract → Mental Model — semantic graph first and renderer projection second → Decision Core — select the right diagram route → Heuristic Chain — graph before layout → Generator Route — capability-gated semantic commands → Coherence Oracle — artifact and meaning must agree → Worked Example — three-tier service topology → Truthful Fallback — absence is not a scene
Why this shape: Architecture diagram components, relationships, and boundaries stay semantic because reviews fail when a valid whiteboard preserves pixels while reversing topology meaning.
Sections kept / cut / added: Kept the Enforcement Contract and Tweakloop receipt authority because identity must remain durable; added Decision Core and Coherence Oracle to reject wrong-neighbor and reversed-edge failures; cut raw workflow and renderer authoring because those belong to the server.
Invocation-mode: agent-discovered

## Structure declaration

| Component | Include / Omit | Defense |
|---|---|---|
| `SKILL.md` | Include | Thin selection, planning, generation, verification, and fallback route. |
| `knowledge/` | Include | Small architecture grammar for boundaries and relationships. |
| `references/` | Include | Semantic operation boundary and proof ceiling. |
| `examples/` | Include | Golden topology, 5+5 routing, wrong-neighbor, and ablation controls. |
| `scripts/` | Omit | The interface is source-confirmed, but a wrapper would hide runtime help gating and stable business-key choices; command examples keep those judgments visible. |
| `assets/` | Omit | Would invite raw renderer payloads. |
| `tests/` | Omit | Focused repository tests own package discrimination and drift checks. |
| Verification oracle | Include | Accepted receipt plus rendered semantic coherence. |

## Calibration Record

CALIBRATION-WAIVED: "go straight to the enhancement/fix, iterate, and so on. Skip ceremonies."

## Sign-off

The package may ship as command-complete current-source and rebuilt-checkout guidance only after the
group enclosure survives strict projection, replay, legacy-upgrade, and rendered-review controls.
The HTML view is a snapshot of this design. Registry-installed discovery, Claude/Cursor activation,
rendered coherence, and human review remain outside structural certification until directly
observed; the fresh Codex checkout route must pass again after this repair.
