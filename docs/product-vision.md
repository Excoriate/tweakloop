# Tweakloop Product Vision

**Tweakloop it is.**

The important conclusion is this:

> **Do not build "Lavish with more features." Build the missing control plane between human judgment and agent execution.**

Lavish is already becoming a capable local review overlay: an agent writes HTML, Lavish injects an SDK, the human annotates rendered elements, and a long-poll returns the feedback to the agent. It also supports live reload, layout diagnostics, structured input controls, export, sharing, and editable Mermaid diagrams.

But its fundamental unit remains approximately:

> **one mutable HTML file + one review session + free-form prompts**

Tweakloop's fundamental unit should instead be:

> **a versioned artifact contract + structured human intent + durable agent execution + verification evidence**

That is the difference between an editor and an **agentic workflow IDE**.

## The gaps with order-of-magnitude leverage

| Gap in the current model | What Tweakloop should introduce | Why it matters |
|---|---|---|
| Feedback is mostly text attached to DOM locations | Typed **intent operations** | Agents receive unambiguous changes rather than interpreting prose |
| The artifact mutates in place | A persistent **revision graph** | Humans review deltas instead of rereading everything |
| DOM selectors are the main anchor | Stable semantic identities and source maps | Feedback survives regeneration and can target repository files |
| One agent polls one file | Durable agent mailbox with leases, acknowledgements and replay | Agent crashes, handoffs and parallel workers stop losing workflow state |
| HTML is treated as the artifact itself | HTML as a projection of Markdown, JSON, code or another canonical source | The review surface stays rich without becoming the unmaintainable source of truth |
| Annotation and interaction compete for clicks | Explicit inspect, manipulate and annotate semantics | Real interactive applications remain usable while being reviewed |
| "Agent changed it" is treated as completion | Requirement-to-evidence verification | Tweakloop can show whether the requested outcome was actually achieved |
| Sessions are file-oriented | Workspace-oriented artifact graph | Plans, diagrams, implementations, tests and decisions remain connected |

These are not hypothetical problems. Lavish has an open proposal for revision capture and rendered or DOM-level diffs because reviewers currently have to reread artifacts after each round. Its interaction layer can also swallow ordinary links, videos and custom controls while annotation mode is active, demonstrating that "interactive artifact" and "annotatable document" are not yet cleanly separated concepts.

Open issues also request scoped conversations tied to particular regions, rather than one global conversation stream. And the current single-server, file-path-oriented model has produced concerns around workspace isolation, parallel worktrees and agent sandboxes. One reported state-storage race could even lose feedback when multiple sessions update a shared state file concurrently.

Those issues point to the same architectural conclusion: **Lavish is session-oriented; Tweakloop should be workflow-oriented.**

## 1. Structured intent, not merely annotations

This is probably the single highest-leverage difference.

When the human selects something, Tweakloop should not only create:

> "Change this section; it is too vague."

It should support operations such as:

- **Replace** this text with an exact value.
- **Delete** this component.
- **Move** this step before another step.
- **Constrain** this design: private networking only.
- **Choose** option B and reject A and C.
- **Question** this assumption without requesting a change yet.
- **Request evidence** for this claim.
- **Approve** this section and freeze it against unnecessary regeneration.
- **Implement** this approved portion in the repository.
- **Verify** this acceptance criterion.
- **Delegate** this operation to a particular agent or role.

Internally, these become append-only operations:

```json
{
  "operation": "replace",
  "artifactId": "azure-platform-plan",
  "revision": 7,
  "target": {
    "semanticId": "networking.ingress",
    "source": "docs/platform-plan.md#private-ingress"
  },
  "value": "Private ingress through the internal Application Gateway",
  "author": "human",
  "status": "queued"
}
```

The complexity moves from the human having to formulate perfect prompts into Tweakloop maintaining a precise intent model. That is exactly where the complexity belongs.

## 2. A revision graph, not live reload alone

Live reload solves rendering freshness. It does not solve cognitive continuity.

Every meaningful save should create a revision with:

- parent revision;
- agent and session responsible;
- feedback operations addressed;
- semantic nodes changed;
- unresolved feedback carried forward;
- source files modified;
- verification evidence;
- acceptance state.

The reviewer should be able to ask:

- What changed since my last review?
- Which comments were addressed?
- Which changes were unrelated to my request?
- Which approved sections changed unexpectedly?
- Which assumptions were introduced?
- Which annotations no longer have a valid target?

Lavish's open revision proposal already identifies the rereading problem and suggests rendered-text and DOM diffs. Tweakloop should go further with **semantic diffing**.

A CSS-class regeneration is irrelevant. Changing an architecture component from "managed PostgreSQL" to "InfluxDB on Container Apps" is highly relevant even when the visible text barely changes.

## 3. Stable semantic anchors

Raw DOM paths are too fragile for agent-generated HTML because agents routinely regenerate the document.

Tweakloop artifacts should expose stable identities:

```html
<section
  data-tweak-id="architecture.data-platform"
  data-tweak-source="docs/architecture.md#data-platform"
>
```

For richer artifacts, the manifest should map rendered objects to their origins:

```json
{
  "architecture.data-platform": {
    "kind": "architecture-component",
    "sourceFiles": [
      "docs/architecture.md",
      "infra/data-platform/main.tf"
    ],
    "dependencies": [
      "architecture.network",
      "architecture.identity"
    ]
  }
}
```

This enables four powerful behaviors:

1. Feedback survives layout regeneration.
2. Selecting a rendered node can reveal its underlying Markdown, JSON, Terraform or code.
3. The agent knows which repository context to inspect.
4. Tweakloop can detect collateral changes to approved components.

Without stable semantic identity, Tweakloop remains a sophisticated screenshot-commenting tool.

## 4. HTML must be a projection, not necessarily the source

The strongest design is not "Markdown versus HTML."

It is:

- Markdown or structured data for durable reasoning;
- HTML for inspection and manipulation;
- source code for implementation;
- an operation log for human intent;
- evidence for verification.

HTML works best as a review surface when comparison, navigation, interaction or spatial presentation matter. Markdown remains stronger as a durable, diffable repository record.

Tweakloop should therefore support several artifact contracts:

| Canonical source | Interactive projection |
|---|---|
| Markdown plan | Navigable plan with approvals, dependencies and editable decisions |
| Architecture JSON/YAML | Interactive topology with selectable components and scenario toggles |
| Terraform plan | Resource graph, risk filters and approval controls |
| PR diff | File map, execution path and finding triage |
| Requirements document | Traceability matrix and implementation status |
| Agent-generated HTML | Sandboxed arbitrary application with semantic annotations |

For arbitrary HTML, the HTML can remain canonical. But Tweakloop should not force every workflow into that model.

## 5. Durable, agent-neutral execution

Long-polling is an ingenious low-complexity bridge, but it should not become Tweakloop's central coordination model.

The durable model should be:

- Tweakloop stores operations in an append-only local event log.
- Agents claim work using a lease.
- Claimed operations are acknowledged.
- Work remains recoverable if an agent exits.
- Another agent can resume from the operation and artifact state.
- Results reference the exact operations they address.
- Duplicate execution is detectable.
- Humans can cancel, supersede or reroute queued operations.

A local SQLite database using WAL mode would be sufficient for an OSS-first implementation. It gives Tweakloop transactional state, concurrent readers, recoverability and queryable history without requiring a cloud service.

Agent integrations should remain thin:

```bash
tweakloop artifact open architecture.html
tweakloop work claim --agent claude-code
tweakloop work complete <operation-id> --revision <revision-id>
tweakloop events watch
```

Claude Code, Codex, OpenCode, OMP and future harnesses then become adapters around one stable protocol—not separate product implementations.

## 6. The artifact should drive implementation

The biggest opportunity is connecting review directly to repository work.

Consider an architecture artifact:

1. The agent proposes Azure Container Apps plus InfluxDB.
2. You select the InfluxDB component.
3. You replace it with Azure PostgreSQL Flexible Server plus TimescaleDB.
4. You add the constraint: "No public ingress."
5. You approve the revised data flow.
6. You press **Implement approved architecture**.
7. The coding agent receives the approved semantic changes, linked source files and constraints.
8. It modifies Terraform and documentation.
9. Tweakloop shows the repository diff, validation results and updated architecture.
10. You approve or reopen only the failed requirements.

That collapses several separate activities:

- explaining the architecture;
- rewriting the prompt;
- reminding the agent what was approved;
- locating relevant files;
- checking whether it followed constraints;
- comparing the new result with the old plan.

That is where a credible order-of-magnitude gain could come from.

## 7. Verification must be first-class

An agent saying "done" is not evidence.

Every actionable operation should have a lifecycle:

| State | Meaning |
|---|---|
| Proposed | Agent generated the idea |
| Reviewed | Human inspected it |
| Approved | Human authorized execution |
| Claimed | An agent accepted responsibility |
| Implemented | The agent reports a change |
| Verified | Required checks produced evidence |
| Accepted | Human accepted the result |
| Reopened | The result failed review or verification |

Evidence might include:

- tests;
- screenshots;
- browser recordings;
- Terraform plan output;
- policy results;
- benchmark changes;
- links to code diffs;
- rendered before-and-after snapshots;
- agent rationale and uncertainty.

This turns Tweakloop from a feedback channel into an **accountability system for agent work**.

## The initial product boundary

The first release should not try to support every artifact format.

### Tweakloop v0.1

Build these together because they form one coherent loop:

1. Local daemon with SQLite event storage.
2. HTML and Markdown artifact support.
3. Stable `data-tweak-id` semantic anchors.
4. Typed feedback operations.
5. Revision snapshots and semantic/visible diffs.
6. Annotation re-anchoring across revisions.
7. Durable agent claim/acknowledge/complete protocol.
8. Claude Code, Codex and OpenCode adapters.
9. Source links from rendered elements to repository files.
10. Acceptance and verification states.

### Defer initially

Avoid spending the first cycle on:

- PowerPoint;
- collaborative cloud accounts;
- extensive theme systems;
- dozens of artifact templates;
- public hosting;
- full Figma-like visual editing;
- arbitrary workflow automation;
- enterprise permissions.

Those can be valuable, but they do not establish the moat. Lavish already has pressure to expand into additional outputs such as presentations, but adding formats alone does not repair the semantic and execution gaps in the loop.

## Product definition

**Tweakloop is an agent-native artifact IDE where humans review, manipulate and approve plans, architectures and other generated artifacts, while agents consume structured intent, execute approved changes and return versioned evidence.**

A tighter tagline:

> **Shape agent work. See what changed. Ship what you approved.**

Or more developer-oriented:

> **The visual control plane for coding agents.**

## The key architectural distinction

Lavish asks:

> "How can a human comment precisely on an agent-generated HTML page?"

Tweakloop should ask:

> "How can an artifact become a durable, executable contract between a human and any number of agents?"

That is the product.

**Assumption:** your dominant workflow is iterative, repository-connected work where an artifact eventually causes implementation or another consequential agent action.

**Falsifier:** if users mostly consume one-shot visual outputs and rarely execute changes from them, this architecture is excessive. In that market, a polished Lavish-compatible editor with better annotation UX would be the better product.
