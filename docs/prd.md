# Tweakloop PRD

## Problem

Developers increasingly produce plans, architectures, diagrams, and applications through coding agents, and review them as agent-generated HTML or Markdown. Today that review loop runs on free-form prompts against mutable files: feedback is prose attached to DOM locations, the artifact mutates in place so reviewers reread everything each round, DOM anchors break when agents regenerate documents, one agent polls one file so crashes and handoffs lose workflow state, and "the agent changed it" is treated as completion with no evidence. Human intent, history, and verification all evaporate between rounds.

## Target users

Developers driving coding agents — Claude Code, Codex, OpenCode, or any harness that can invoke a CLI — through iterative, repository-connected work where a reviewed artifact eventually causes implementation or another consequential agent action.

## Product definition

**Tweakloop is an agent-native artifact IDE where humans review, manipulate and approve plans, architectures and other generated artifacts, while agents consume structured intent, execute approved changes and return versioned evidence.**

> **Shape agent work. See what changed. Ship what you approved.**

> **The visual control plane for coding agents.**

Its fundamental unit is not *one mutable HTML file + one review session + free-form prompts* but *a versioned artifact contract + structured human intent + durable agent execution + verification evidence*.

## The core loop

1. An agent publishes an artifact; Tweakloop snapshots it as an immutable revision.
2. The human reviews it in the browser shell — interacting, inspecting semantic nodes, and drafting typed intents against stable anchors.
3. Submitting a review batch commits immutable intent facts and creates claimable work.
4. Any agent claims the work atomically, receives the intents, revision manifest, and source references, does the work in its own harness, publishes a new revision with an explicit parent, and records a result with evidence.
5. The human sees a semantic diff, addressed intents, evidence, and invalidated approvals — then accepts or reopens.
6. Every step is a durable fact; the whole history survives crashes, restarts, and projection rebuilds.

## v0.1 vertical slice (user stories / acceptance criteria)

The release is acceptable only when this exact scenario works reliably end to end (authoritative: [architecture/15-roadmap.md](architecture/15-roadmap.md) §30):

1. An agent creates `architecture.html` containing stable `data-tweak-id` attributes.
2. The agent runs `tweak open architecture.html`.
3. Tweakloop snapshots the file and assets as revision R1.
4. The trusted shell opens R1 from the isolated artifact origin.
5. The human selects `architecture.data-storage`.
6. The human submits one replacement intent, one networking constraint, and one request for implementation.
7. The daemon commits one review batch and creates claimable work.
8. A different agent runs `tweak work claim --wait --json`.
9. The agent receives intent values, the R1 manifest, source references, and expected verification.
10. The agent edits repository files.
11. The agent publishes R2 with R1 as its parent.
12. The agent records its result and test evidence.
13. The browser receives committed events through SSE.
14. The browser displays the semantic R1-vs-R2 diff, addressed intents, evidence, changed approved nodes, and remaining unresolved items.
15. The human accepts or reopens the result.
16. The complete history survives daemon restart and projection rebuild.

## Functional requirements by phase

From [architecture/15-roadmap.md](architecture/15-roadmap.md) §31. Each phase has a hard exit condition.

| Phase | Delivers | Exit condition |
|---|---|---|
| 0 — Architecture skeleton | Module boundaries, public JSON schemas, event/command envelopes, in-memory domain tests, SQLite migration framework, daemon runtime discovery, CLI health communication | One test command creates one event and a rebuildable projection |
| 1 — Immutable artifact revisions | Project/workspace identity, object store, HTML ingestion, revision manifests, revision graph, isolated artifact server, trusted shell, bootstrap authentication | Two historical revisions open independently after source files change |
| 2 — Semantic feedback | Bridge, three interaction modes, semantic-node discovery, text/source anchors, drafts, review-batch submission, typed intents, orphan detection | Feedback stays valid across a controlled revision change or becomes explicitly orphaned |
| 3 — Agent-neutral work protocol | Work projection, atomic claims, leases, CLI machine output, result recording, revision publication from claimed work, crash/retry handling | Two concurrent fake agents cannot claim the same work; abandoned work recovers |
| 4 — Diff, evidence and decisions | Semantic diff, rendered-text diff, evidence objects, verification records, accept/reject/reopen decisions, timeline | The full vertical slice passes browser, crash and concurrency tests |
| 5 — Markdown adapter and OSS hardening | Markdown ingestion with source mapping and stable heading identity, installer, agent-harness skills, protocol docs, contribution fixtures, repair commands | A Markdown plan and an interactive HTML architecture use the same intent/work/evidence model |

## Non-goals

Tweakloop v0.1 is **not**: an executor of arbitrary shell commands; a direct modifier of repository files; a model host or prompt orchestrator; a Git replacement; a general workflow engine; a collaborative document editor; cloud sync; an autonomous approver; a plugin runtime; a WYSIWYG web-design app.

Deliberately deferred (they do not establish the moat): PowerPoint and format templates, collaborative cloud accounts, theme systems, artifact template galleries, public hosting, Figma-like visual editing, arbitrary workflow automation, enterprise permissions.

## Success criteria

- The v0.1 vertical slice passes reliably, including crash, concurrency, and browser-security tests.
- The 20 architecture invariants ([architecture/14-failure-and-testing.md](architecture/14-failure-and-testing.md) §28) all hold.
- The final architectural test holds: a browser tab, daemon process, CLI invocation, source file, Git worktree, or agent process may disappear without erasing what was reviewed, what the human meant, what work an agent claimed, what changed, what evidence was produced, or what the human accepted.
- At least two different agent harnesses complete the loop using only the public CLI protocol.

**Assumption:** the dominant workflow is iterative, repository-connected work where an artifact eventually causes implementation.

**Falsifier:** if users mostly consume one-shot visual outputs and rarely execute changes from them, this architecture is excessive — in that market, a polished session-oriented editor with better annotation UX would be the better product.

## Positioning vs lavish-axi

[Lavish](https://github.com/kunchenguid/lavish-axi) is an effective **session-oriented** review transport: a local HTML file, an injected SDK, file-path session identity, and an agent long-polling for feedback. Tweakloop is **workflow-oriented**: immutable revisions instead of a mutable file, typed intent facts instead of free-form prompts, a durable claim/lease work protocol instead of long-polling, semantic anchors with explicit orphaning instead of DOM selectors, and evidence-backed verification instead of "agent changed it". Lavish asks *"how can a human comment precisely on an agent-generated HTML page?"* Tweakloop asks *"how can an artifact become a durable, executable contract between a human and any number of agents?"* See [product-vision.md](product-vision.md) for the full gap analysis.
