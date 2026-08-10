---
title: Tweakloop skill design
summary: Upgrade design for the durable human-agent artifact iteration skill.
type: design
---

# Skill design — tweakloop

## Endgame

A fresh agent selects the working-tree executable, resolves durable document identity before
authoring, completes one exact receipt-driven review loop, and never upgrades agent work into human
acceptance. The edge case is a source-less artifact, which routes to session handoff. The rejected
near-miss is ordinary file editing with no Tweakloop collaboration state.

## Evidence ledger

| Claim (load-bearing) | Class | Warrant |
|---|---|---|
| The in-repository route must build and use the absolute local CLI. | Known | `01-task-requirements-final.md` R01 and `test/skills/agent-workflow.test.ts` local-build assertions. |
| Document identity must precede authoring or overwrite. | Known | `01-task-requirements-final.md` R02 and the resident Gate 2 negative controls. |
| A receipt proves only its named durable fact, not comprehension or acceptance. | Known | `docs/architecture/08-intents-and-work.md` and the R04/R13 honesty contract. |
| Fresh Claude, Codex, and Cursor discovery of the shadow packages is active. | Unknown | Run isolated native skill listing and invocation in each client; source parity cannot resolve it. |

## Make-vs-buy verdict

**Verdict: Skill.** Tweakloop operation is episodic and task-specific; loading its command and
authority contract into every repository task would dilute always-on project guidance.

## Golden end-state

- **PRIMARY substrate:** state-delta
- **CEILING surface:** observed-effect; user acceptance remains a separate human grade
- **Cardinality:** 1 review-loop tuple
- **Judge-availability:** provisional for external client activation; recorded repository fixture available
- **Near-miss:** green commands against the wrong executable or document identity, followed by a false acceptance claim
- **Base-model negative control:** without the skill, an agent may author before identity discovery or reconstruct IDs; with it, the first mutation follows the exact identity/receipt gates.

Recorded fixture -> `examples/ordinary-review/README.md`, checked by its adjacent test. Its
observed-effect assertion is a lineage-bound immutable revision for `work_plan_12`, while human
acceptance remains absent. On failure or partial publication, the operator runs the exact returned
recovery command; if none is available, the agent escalates without reconstructing durable IDs.

## Native Shape
Shape: gated-pipeline
Spine: Enforcement Contract → Mental model — durable facts authorize transitions → Gate 1 — pin workspace and executable before any Tweakloop command → Gate 2 — resolve durable identity before authoring or overwriting → Reference Map — load optional depth exactly when triggered → Typed intent and honesty → Worked Trace — ordinary five-step review loop
Why this shape: Tweakloop durable review fails when workspace invocation, revision identity, and work authority are reordered, because the wrong document can be published under a valid-looking receipt.
Sections kept / cut / added: Kept the two blocking gates and worked trace; added one compact mental model; cut generic setup prose to preserve the 6000-byte resident budget.
Invocation-mode: agent-discovered

## Structure declaration

| Component | Include / Omit | Defense |
|---|---|---|
| `SKILL.md` | Include | Resident invocation, identity, authority, and ordinary-loop decisions. |
| `references/` | Include | Conditional authoring, chat, handoff, workspace, and recovery contracts. |
| `examples/` | Include | A positive ordinary-review trace distinguishes receipt discipline from syntax. |
| `scripts/` | Omit | Product CLI commands own deterministic work; a wrapper would create a second invocation contract. |
| `tests/` | Omit | No skill-owned executable exists; repository tests exercise package routes and command markers. |
| `assets/templates/` | Include | The minimal plan starter is deterministic authoring input. |
| Verification oracle | Include | Focused route/ablation tests plus fresh-client activation when available. |

## Sign-off

The user explicitly requested direct iterative implementation. Structural upgrade may proceed; live
client activation remains unverified and cannot be promoted by this sign-off.

## Calibration Record

CALIBRATION-WAIVED: "go straight to the enhancement/fix, iterate, and so on. Skip ceremonies."
