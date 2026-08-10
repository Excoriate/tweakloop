---
title: Architecture-diagram ablation controls
description: Component-removal tests proving the mental model, decision core, generator, and oracle are load-bearing.
---

# Ablation controls

| Ablated surface | Plausibly wrong behavior | Discriminating observation |
|---|---|---|
| Mental Model | Agent treats screenshot pixels as the architecture authority. | A pretty render can replace semantic identity and still be called complete. |
| Decision Core | Every “diagram” request routes here, including Mermaid and freehand editing. | Wrong-neighbor cases create unwanted boards or raw edits. |
| Heuristic Chain | Agent creates one node per noun and decorative groups. | Alias nodes and meaningless boundaries appear despite a valid receipt. |
| Generator Route | Agent invents a request payload or renderer fields without probing help. | The route can claim success against an unsupported interface. |
| Executable CLI grammar | Agent lists `node.upsert` and peers but never supplies document, session, stable idempotency keys, edge endpoints, group members, layout options, inspect, or publish. | The operation-name-only impostor cannot execute one accepted mutation or complete before/after verification. |
| Coherence Oracle | Agent accepts any valid, attractive scene. | A reversed-edge control passes even though topology meaning changed. |
| Truthful Fallback | Capability absence becomes a fabricated “generated board.” | No accepted scene receipt exists, yet delivery claims an editable artifact. |
| Native-wrapper discovery | A fresh agent without `.agents/skills/architecture-diagram` is said to use this route anyway. | The wrapper-ablated session cannot list or invoke the skill, so source presence cannot count as activation. |
| Scene-builder capability | The skill invents request fields after `tweak whiteboard scene --help` is absent. | The builder-ablated run must stop BLOCKED and produce no accepted scene receipt. |

The decisive ablation is the coherence oracle. Remove it and the artifact oracle still passes a
plausibly wrong dependency direction; therefore parseability and durable mutation are necessary but
not sufficient. Remove executable grammar and a vocabulary-only skill passes while no agent can
supply the required session, identity, or lifecycle commands. Remove the generator probe and even
the artifact claim loses authority because the installed transport may not exist. Remove fallback
honesty and a text plan becomes indistinguishable in prose from a real editable whiteboard.
Native-wrapper and scene-builder ablations additionally keep source packaging, discovery, and
executable behavior from being collapsed into one false-green claim.
