---
title: Excalidraw capability routing
description: Load when choosing among the live Tweakloop canvas, semantic scene commands, a managed native editor, or a truthful blocked fallback.
---

# Excalidraw capability routing

Build the situation model before consulting this table: is the task a basic semantic architecture
diagram, a freeform/new board, or an identity-sensitive edit to an existing board? Which editor or
CLI surface is actually controllable in this run?

| Capability observed now | Route | Evidence before publish | Stop condition |
|---|---|---|---|
| Live Tweakloop canvas accepts editor input | Edit in canvas | Rendered change plus a newer accepted draft receipt | No receipt, hidden/off-canvas result, or lost target identity |
| Tweakloop help exposes server-owned semantic node/edge/label/group/layout operations | Architecture-diagram skill | Semantic changed-target receipt and rendered scene | Missing operation, raw renderer field required, or absent render witness |
| Native Excalidraw editor can open/save the managed checkout | Checkout, native edit, managed sync/publish | Accepted sync and immutable revision receipt | Conflict, stale target, or sidecar uncertainty |
| None of the above | Request an editor or semantic scene-builder capability | Explicitly recorded blocked surface | Never downgrade to raw element synthesis or blind coordinates |

The semantic route is deliberately narrow. It owns ordinary architecture boxes, arrows, labels,
groups, and layout only. Freehand composition, bespoke styling, imported media, and an existing
board whose element identities must be visually edited remain native-editor work.

Client capability is temporal. Documentation or a source file does not prove the current process
can control a browser/editor or invoke a scene command. Probe help/runtime, preserve the output in
the task receipt, and report unavailable capabilities rather than manufacturing parity.
