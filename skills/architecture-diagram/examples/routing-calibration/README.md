---
title: Architecture-diagram trigger discrimination
description: Five should-trigger cases, five should-not-trigger cases, and the wrong-neighbor boundary.
---

# Trigger discrimination — 5 + 5

## Should trigger

1. “Put the browser, API, queue, worker, and database on an editable Tweakloop topology.”
2. “Revise this basic service diagram so the worker consumes the queue instead of the API.”
3. “Group the public and private components by trust boundary and retain semantic identities.”
4. “Show which service publishes each event and which consumer receives it.”
5. “Create a simple deployment topology with regions, services, and directed dependencies.”

Each case asks for architecture components, relationships, or meaningful groups on an editable
Tweakloop board. Each still requires the capability probe before mutation. A positive response that
only lists `node.upsert`, `edge.upsert`, `label.set`, `group.set`, and `layout.apply` is a near-miss:
it MUST supply the executable leaf commands, stable keys, existing-draft before/after inspection or
the typed cold-start receipt-plus-immediate-inspect branch, deterministic layout,
publish, a non-mutating `session url` handoff, and the human-review boundary.

## Should not trigger

1. “Sketch a mascot beside the service boxes.” Route to a controllable native Excalidraw editor.
2. “Make this hand-drawn board pixel-perfect.” Route to native Excalidraw; pixels are not semantic operations.
3. “Give me Mermaid in this Markdown file.” Stay in Mermaid; no board was requested.
4. “Explain the architecture in prose.” Stay in prose; artifact creation would expand scope.
5. “Patch the raw element nonce and binding arrays.” Refuse raw authorship and route to the editor boundary.

## Wrong neighbor

The nearest wrong neighbor is the Excalidraw skill. It is correct for native/freeform editing and
existing board details; architecture-diagram is correct only for basic graph semantics through a
confirmed server-owned scene interface. If the semantic capability is missing, architecture-diagram
does not silently borrow Excalidraw raw JSON. It stops, emits a text plan labeled “not an editable
whiteboard,” and routes to Excalidraw only when a native editor is actually controllable.
