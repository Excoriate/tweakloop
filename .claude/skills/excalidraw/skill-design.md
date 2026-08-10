---
title: Excalidraw for Tweakloop skill design
summary: Upgrade design for identity-safe editable whiteboard iteration.
type: design
---

# Skill design — excalidraw

## Endgame

A future agent chooses a currently controllable editor capability, preserves targeted board
identity, and publishes an immutable editable revision through accepted managed state. The edge case
is terminal-only architecture authoring, which may use the server-owned semantic route. The rejected
near-miss is hand-authored raw elements or a flattened preview presented as the editable board.

## Evidence ledger

| Claim (load-bearing) | Class | Warrant |
|---|---|---|
| Renderer IDs, versions, nonces, bindings, and file references belong to the editor/server boundary. | Known | Original objective whiteboard friction and `01-task-requirements-final.md` R38. |
| Existing targeted elements and Tweakloop anchors must survive a revision. | Known | Current skill non-negotiable contract and managed checkout target guards. |
| Semantic scene commands can replace a native editor for basic diagrams. | Inferred | The server-owned model removes raw schema and coordinate ownership; falsified if a required operation demands renderer fields. |
| Fresh target clients currently activate this upgraded package. | Unknown | Probe: isolated native listing/invocation in Claude, Codex, and Cursor is required. |

## Make-vs-buy verdict

**Verdict: Skill.** Excalidraw identity and managed sync behavior is episodic, tool-specific
knowledge; always-on repository guidance would burden unrelated work.

## Golden end-state

- **PRIMARY substrate:** state-delta
- **CEILING surface:** observed-effect through accepted draft/revision plus rendered board
- **Cardinality:** one tuple with editor and semantic-capability routes
- **Judge-availability:** provisional for native client activation; recorded managed-edit specimen available
- **Near-miss:** a valid-looking scene whose target IDs/anchors changed, or a PNG standing in for editable JSON
- **Base-model negative control:** without this skill, an agent may synthesize raw elements or publish after a save; with it, capability selection and accepted sync gate publication.

## Native Shape
Shape: gated-pipeline
Spine: Enforcement Contract → Mental Model — identity-bearing scene and replaceable rendering → Decision Core — choose the editing capability → Non-negotiable contract → Decision Framework — choose the board shape → Worked Mutation — managed board revision → Embed by immutable reference → Advanced protocol path
Why this shape: Excalidraw collaboration fails when scene identity, editor capability, and Tweakloop publication are conflated, because valid pixels can hide a broken anchor or stale revision.
Sections kept / cut / added: Kept the managed operator flow and embedding contract; added capability routing and identity mental model; no generic checklist was added.
Invocation-mode: agent-discovered

## Structure declaration

| Component | Include / Omit | Defense |
|---|---|---|
| `SKILL.md` | Include | Capability and managed mutation decisions. |
| `references/` | Include | Point-of-need editor/scene/fallback routing. |
| `examples/` | Include | Positive identity-preserving mutation specimen. |
| `scripts/` | Omit | Tweakloop and the native editor own deterministic scene operations. |
| `tests/` | Omit | Repository-focused skill tests exercise route markers and package parity. |
| `assets/templates/` | Omit | A scene template would invite cargo-cult raw JSON ownership. |
| Verification oracle | Include | Accepted receipt + identity differential + rendered board, with native activation separate. |

## Sign-off

The direct implementation request authorizes this upgrade; runtime activation and human visual grade
remain outside structural certification.

## Calibration Record

CALIBRATION-WAIVED: "go straight to the enhancement/fix, iterate, and so on. Skip ceremonies."
