---
name: excalidraw
description: 'Use for Tweakloop whiteboards with managed tools. NOT for raw Excalidraw JSON or flat images.'
metadata:
  builder_provenance: true
  substrate: state-delta
---

# Excalidraw in Tweakloop

## Enforcement Contract

This skill's gates and instructions are binding. **MUST** means required; **NEVER** marks an
identity- or conflict-breaking route. Missing native-editor control, a target identity, or an
accepted managed sync makes publication **BLOCKED**—report the missing surface and stop.

Use Tweakloop's managed agent workflow to turn a native Excalidraw scene into a live,
reviewable board. Keep the full document/task/chat workflow in the main
[Tweakloop skill](../tweakloop/SKILL.md); use this skill for board-specific authoring and edits.

## Mental Model — identity-bearing scene and replaceable rendering

The editable scene is authority; previews and browser pixels are projections. Semantic anchors and
targeted element identity survive revisions, while editor-owned versions, nonces, bindings, and
layout bookkeeping remain outside agent-authored JSON.

## Decision Core — choose the editing capability

Build the board/task model first. If the route is not obvious, load
[`references/capability-routing.md`](references/capability-routing.md), record the chosen capability,
and stop if that reference is missing—the fallback boundary would otherwise be guessed.

| Trigger / condition | Action | Why / reasoning |
|---|---|---|
| Live Tweakloop canvas is controllable | Edit there and verify the next draft receipt | The mounted editor owns identities and exposes the shortest observed-effect loop. |
| Basic architecture boxes/arrows and semantic scene commands are confirmed | Hand off to [architecture-diagram](../architecture-diagram/SKILL.md) | The daemon can own renderer bookkeeping without browser-coordinate automation. |
| A native editor can save the managed checkout | Use checkout → native edit → sync → publish | The editor owns raw Excalidraw schema while Tweakloop owns conflicts and revision identity. |
| No confirmed editor or scene-command capability exists | Request that capability and report **BLOCKED** | Guessing raw elements or browser coordinates can look successful while corrupting identity. |

## Non-negotiable contract

- Treat editable `.excalidraw` JSON as canonical. Generate PNG or SVG only from that JSON as a
  derived preview; never edit a preview, re-import it as the source, or replace the board with a
  flattened image.
- Preserve every targeted element's existing `id`, `type`, and
  `customData.tweakloop.anchorId`. Preserve unrelated elements instead of regenerating the scene.
- For non-trivial element additions or changes, a native Excalidraw editor MUST own element schema,
  IDs, versions, nonces, bindings, and file references. NEVER synthesize those raw objects from this
  skill. Direct JSON is limited to a bounded `appState`-only change that leaves `elements[]`
  byte-for-byte intact.
- Use `tweak whiteboard workspace checkout|sync|publish` for normal work. Treat the generated
  sync-state sidecar as opaque: never inspect, copy, edit, delete, or synthesize it.
- Stop on every conflict, stale-state error, target-identity error, or nonzero exit. Never publish
  after a failed sync and never make an automatic winner choice.

## Decision Framework — choose the board shape

- **Standalone board:** keep the `.excalidraw` artifact as its own document and open it directly.
- **Embedded board:** open the board first, then embed its real artifact and immutable revision IDs
  in an HTML or Markdown document. Keep the board JSON separate; never duplicate mutable scene JSON
  inside the parent document.

Start a new board from a valid Excalidraw export or this minimal editable scene:

```json
{"type":"excalidraw","version":2,"source":"https://tweakloop.local","elements":[],"appState":{"viewBackgroundColor":"#ffffff"},"files":{}}
```

Prefer native shapes, arrows, bindings, and text so the result remains editable. A generated image
may be a visual reference or preview, but it is not the board.

## Worked Mutation — managed board revision

Always request JSON for finite commands; `session listen` intentionally emits JSON Lines. The
durable session stores agent/process identity, so attach and claim derive it instead of requiring
manual re-entry.

Every gate above remains binding throughout this mutation. A native-editor save is not publication;
only accepted sync plus an immutable revision permits completion.

### 1. Open or resume the board session

For a new or locally-authored board:

```bash
tweak open <board.excalidraw> --agent agent:<name> --json
tweak session listen --session <sessionId> --artifact <artifactId>
```

Save the returned `artifactId`, `revisionId`, `sessionId`, `processNonce`, and review `url`.

For an already-published board, inspect its durable context before editing:

```bash
tweak session list --document <artifact-id-or-source-path> --json
tweak session show <sessionId> --json
```

If no prior session exists, start one:

```bash
tweak session start <artifact-id-or-source-path> --agent agent:<name> \
  --process <stable-process-nonce> --goal "<board goal>" --json
```

Continue an active session only when it belongs to this agent/process. `session listen --session`
derives both and rejects explicit mismatches. Otherwise resume it as a successor:

```bash
tweak session resume <predecessorSessionId> --agent agent:<name> --json
```

Then listen on the selected session and board artifact. Do not infer liveness from durable session
status; the listener and claim lease are separate truths.

### 2. Claim exact board work when assigned

For initial “diagram this” authoring, publish revision 1 and wait for review; no work item exists yet.
When the session stream or snapshot contains assigned review work, claim that exact `workId` with
the same identity and collect every targeted Excalidraw element ID from its intent/comment targets:

```bash
tweak work claim --session <sessionId> --all --json
```

Account for every `intentId`. Do not treat chat alone as authorization to complete formal work.

### 3. Prefer the live Tweakloop canvas

When the review URL is open in a controllable browser, use the local native Excalidraw editor
already mounted in Tweakloop. Select the board tab, switch to **Interact**, and edit the canvas
through browser/computer control. This is the shortest route: the editor owns element identities,
autosave streams accepted draft versions to the session listener, and **Publish board** creates the
immutable revision used by `work complete`.

For reliable automated text entry, select Excalidraw's Text tool, click the canvas, write the exact
text to the browser clipboard, paste with `Meta+V` (or the platform paste shortcut), then press
Escape to commit. Verify the rendered text and the next `whiteboard-draft` receipt before
publishing. Do not replace this route with raw scene JSON.

Use canvas-wide mode when browser fullscreen is unavailable. Preserve the current camera and
unrelated shapes; comment-targeted elements keep their IDs and anchors.

### 4. Otherwise, check out a fresh managed workspace

Choose a path where neither the `.excalidraw` file nor its sidecar exists:

```bash
tweak whiteboard workspace checkout <artifactId> <fresh-scratch.excalidraw> \
  --agent agent:<name> --target-element <elementId...> --json
```

Pass every assigned/commented existing element through `--target-element`. Checkout records their
element IDs, types, and anchor IDs so sync fails closed if an edit deletes or replaces them.
Omit `--target-element` only when no existing element is targeted.

### 5. Edit the checked-out scene through a native editor

Checkout returns `editRoute.kind: "native-excalidraw-editor"`, the exact `scenePath`, and the next
managed sync command. Open and save that exact file with an available native Excalidraw
desktop/app/editor integration. The editor—not the agent's guessed JSON—owns element shape,
version/nonce, bindings, and embedded files. Preserve targeted identities and make the smallest
visual change satisfying the typed intents. Regenerate any PNG/SVG preview from the saved canonical
scene.

If neither editor route is controllable, probe the current Tweakloop help for a semantic whiteboard
scene-command capability. If it confirms server-owned nodes/edges/labels/groups/layout and the task
is a basic architecture diagram, load the architecture-diagram skill. Otherwise stop with
**BLOCKED: native Excalidraw editor or semantic scene builder unavailable** and request that exact
capability. NEVER substitute raw element JSON. A background-only `appState` change is the sole direct
edit and MUST leave `elements[]` unchanged.

### 6. Sync; stop on conflict

```bash
tweak whiteboard workspace sync <fresh-scratch.excalidraw> --json
```

Proceed only when the response is accepted. Exit code 2 or a conflict/stale/target error means:

1. Stop editing and do not publish.
2. Retain the scene and opaque sidecar unchanged.
3. Inspect `tweak whiteboard conflicts <artifactId> --json`.
4. Resolve deliberately through the human/work intent, or check out the latest draft to a different
   fresh path and reconcile it. Never retry with invented draft, revision, version, or client IDs.

### 7. Publish the observed draft

```bash
tweak whiteboard workspace publish <fresh-scratch.excalidraw> --json
```

Use the returned immutable `revisionId` when completing claimed work. If the board is embedded,
update the parent document to point at this same `artifactId` and new `revisionId`, preserve the
parent's semantic anchor, then publish the parent through the main Tweakloop workflow.

```bash
tweak work complete <workId> --claim <claimId> \
  --revision-id <revisionId> --summary "<intent-by-intent account>" --json
```

Run `work complete` only for a claimed work item. Completion means ready for human review, not
accepted. Keep `tweak session listen` open for the human's accept/reopen decision.

## Embed by immutable reference

HTML:

```html
<section data-tweak-id="diagram.topology" data-tweak-kind="whiteboard"
         data-tweakloop-whiteboard
         data-tweak-whiteboard-artifact="artifact_board"
         data-tweak-whiteboard-revision="rev_board_3"
         style="min-height: 32rem"></section>
```

Markdown uses a strict empty directive:

````markdown
```tweakloop-whiteboard {#diagram.topology artifact=artifact_board revision=rev_board_3}
```
````

Keep `diagram.topology` stable across parent revisions. Update only the referenced board revision
after publishing a new board revision.

## Advanced protocol path

The low-level `tweak whiteboard draft get|put`, `tweak whiteboard publish`, and
`tweak whiteboard resolve` commands expose compare-and-swap metadata directly. Use them only for
protocol diagnostics or a deliberate, explicit conflict-resolution decision. They are not a
shortcut around managed workspace conflicts; consult current `tweak whiteboard --help` and the
main [Tweakloop skill](../tweakloop/SKILL.md) before using them.

Recorded fixture: `examples/identity-preserving-mutation/README.md`. Observed-effect proof requires
accepted sync, preserved target identities, an immutable revision, and the rendered board; exit 0 or
loader-clean is not proof. On failure, retain the opaque state, stop publication, and use the
documented conflict recovery or escalate for a controllable editor.

## Structure Declaration

| Directory | Status and reason |
|---|---|
| `knowledge/` | OMITTED — duplicated scene rules risk schema drift. |
| `references/` | INCLUDED — capability routing prevents raw-JSON mistakes. |
| `scripts/` | OMITTED — wrappers risk bypassing managed conflict state. |
| `assets/` | OMITTED — templates risk inviting raw element authorship. |
| `examples/` | INCLUDED — the mutation fixture exposes identity loss. |
| `tests/` | OMITTED — repository tests prevent capability-route drift. |
