---
name: tweakloop
description: 'Use for durable Tweakloop review and recovery. NOT for ordinary editing or human acceptance.'
metadata:
  builder_provenance: true
  substrate: state-delta
---

# Tweakloop

## Enforcement Contract

Missing identity, authority, intended bytes, safe destination, or exact receipt makes a step
**BLOCKED**. Use `--json`; preserve receipts and run returned commands verbatim. Only humans accept.

## Mental model — durable facts authorize transitions

Tweakloop is `durable fact → receipt → exact command`, never `path → guessed IDs`; success proves
only that mutation.

## Gate 1 — pin workspace and executable before any Tweakloop command

1. Resolve one absolute workspace root from the user path, else cwd; **NEVER** infer it from a URL,
   daemon, artifact, or receipt.
2. Before `PATH`: in a source checkout run `just build` and absolute
   `node <repo-root>/dist/cli/index.js`. Build failure stops: **NEVER** fall back globally.
3. Else use installed `tweak` or `npx -y tweakloop`. With the selected prefix run
   `--workspace <root> status --summary --json`. `running`: preserve it; source build alone
   **NEVER** authorizes restart—it breaks the browser/SSE origin. `stopped`: run
   `daemon start --json`; failure blocks. Explicit incompatibility: restart, use the returned URL;
   the old shell is stale. Health ≠ generation parity.

Below, `tweak` means prefix plus `--workspace <absolute-root>`; retain both.

## Gate 2 — resolve durable identity before authoring or overwriting

Before creating, editing, or overwriting, inspect:

```bash
tweak artifacts list --json
tweak session list --document <exact-intended-path-or-artifact-id> --json
```

Use lineage, not file existence. The same logical document stays on its artifact/revision line; a
new proposal uses an unregistered path and new artifact ID. Ambiguous identity, authority, or bytes
requires one question.

Ordinary content preference waits until revision 1; before it, only identity, authority, missing bytes,
destructive ambiguity, or safety blocks. A later genuine
2–8 option choice may use `tweak question ask`; generic preference does not block.

## Reference Map — load optional depth exactly when triggered

Load only the matching reference:

| Trigger | Action | Why / wrong neighbor |
|---|---|---|
| HTML/Markdown structure, anchors, kinds, scaffold, lint/diff/check | [`authoring-html.md`](references/authoring-html.md) | open/recovery |
| Chat, file, comment, task, selection, reference, attachment | [`chat-and-attachments.md`](references/chat-and-attachments.md) | board internals |
| Active work, lease, progress, pause, or block | [`live-progress.md`](references/live-progress.md) | receipt/acceptance |
| Resume, handoff, end, fetch, multiple artifacts | [`session-handoff.md`](references/session-handoff.md) | export/restore |
| Save, export, restore, fork, rebuild, archive | [`workspace-export-restore.md`](references/workspace-export-restore.md) | session resume |
| Partial result, stale claim, failure, rollback, history | [`recovery-and-inspection.md`](references/recovery-and-inspection.md) | healthy review |
| Architecture/topology with semantic scene capability | [architecture-diagram](../architecture-diagram/SKILL.md) | raw JSON |
| Native/freeform or existing board | [Excalidraw](../excalidraw/SKILL.md) | architecture only |

## Typed intent and honesty

The receipt owns `workId`, `claimId`, session, artifact, revision, and `intents`:

| Intent | Obligation |
|---|---|
| `comment`; `question` | Consider; answer in revision/summary. |
| `replace-text` | Apply `body.value` to its target. |
| `add-constraint` | Preserve `body.statement` later. |
| `remove`, `move`, `choose`, `reject-option` | Apply to the target. |
| `approve-node`; `request-implementation`; `reopen` | Preserve, evidence, or redo. |

Preserve targets/quotes. Account for every `intentId`; publish only intended bytes. Complete only
after durable publication. A receipt is not comprehension or human acceptance.

## Worked Trace — ordinary five-step review loop

Identity and authority bind every step; missing receipt or failure blocks transition.

1. **Open.** After identity, lint, diff, and check pass, run
   `tweak open <file> --agent agent:<name> --json`.
   Preserve its IDs and next action.
2. **Receive or claim.** Run
   `tweak next --session <sessionId> --wait --timeout 300000 --json`. It returns one item and exits.
   Execute chat `acknowledgeCommand` exactly; do not reclaim work.
   `session listen` is only for a persistent daemon/TUI or live board stream.
3. **Revise under the live-turn gate.** After claiming, start
   `tweak session listen --session <sessionId> --presence working --until-work-settled <workId>`
   in a long-lived process. The socket sustains Working and the claim lease; failure forbids
   claiming live Working, not durable work. Use `work progress` only for a truthful partial/phase
   milestone: nonempty intent IDs become addressed; all remaining use completion. Heartbeat is
   never progress. If `sourcePath` is null, a fetched path is not identity.
4. **Publish and complete.** Use the claim-derived route:
   `tweak publish <file> --complete <workId> --summary <truthful-intent-account> --json`.
   Never copy IDs. Partial/recovery output stops and loads recovery.
5. **Wait for the human decision.** Run finite `next` again. Reopen continues history; human Accept
   closes it. Never report agent completion as acceptance.

Fixture: `examples/ordinary-review/README.md`. Proof is its lineage-bound publication plus a later
human decision; exit 0 is not proof. On failure, use returned recovery or escalate.

## Structure Declaration

| Directory | Status |
|---|---|
| knowledge | OMITTED — drift risk |
| references | INCLUDED — route depth |
| scripts | OMITTED — CLI drift |
| assets | INCLUDED — starter file |
| examples | INCLUDED — specimen |
| tests | OMITTED — test drift |
