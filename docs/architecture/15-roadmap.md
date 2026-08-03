# Rejected designs, vertical slice, phases and build discipline

Covers sections 29 through 34 of the authoritative architecture. Back to the [index](README.md).

## 29. Explicitly rejected designs

### 29.1 One mutable JSON session file

Rejected because it braids:

- artifact identity;
- pending feedback;
- chat;
- agent presence;
- revision count;
- diagnostics;
- end state.

It becomes difficult to transact, replay, branch or recover independently.

### 29.2 File path as artifact identity

Rejected because files move, repositories are cloned, worktrees coexist, and multiple artifacts may derive from one source.

### 29.3 One global status enum

Rejected because submission, execution, verification and acceptance are independent dimensions.

### 29.4 WebSocket as the default transport

Rejected because POST plus SSE already models commands and committed notifications with less connection state.

### 29.5 CRDT in v0.1

Rejected because Tweakloop is not initially a concurrent text editor.

The core concurrency problem is competing immutable revisions and intents, not simultaneous character insertion.

### 29.6 Microservices

Rejected because the first authority boundary is one local workspace.

Module boundaries provide separability without deployment complexity.

### 29.7 Kafka, Redis or Postgres

Rejected because an embedded single-writer workload does not justify network infrastructure.

### 29.8 Agent-specific core integrations

Rejected because any agent capable of invoking a stable CLI should participate.

### 29.9 Generic event-sourcing framework

Rejected because frameworks tend to impose aggregate, repository and serialization abstractions that can become more complicated than the small domain.

Implement:

- an explicit event table;
- explicit reducers;
- explicit decision functions;
- explicit SQL.

### 29.10 Automatic agent execution from the browser

Rejected because it would transform a review tool into a privileged command-execution system.

## 30. v0.1 vertical slice

Build exactly this end-to-end scenario before expanding horizontally:

1. An agent creates `architecture.html` containing stable `data-tweak-id` attributes.
2. The agent runs `tweak open architecture.html`.
3. Tweakloop snapshots the file and assets as revision R1.
4. The trusted shell opens R1 from the isolated artifact origin.
5. The human selects `architecture.data-storage`.
6. The human submits:
   - one replacement intent;
   - one networking constraint;
   - one request for implementation.
7. The daemon commits one review batch and creates claimable work.
8. A different agent runs `tweak work claim --wait --json`.
9. The agent receives:
   - intent values;
   - R1 manifest;
   - source references;
   - expected verification.
10. The agent edits repository files.
11. The agent publishes R2 with R1 as its parent.
12. The agent records its result and test evidence.
13. The browser receives committed events through SSE.
14. The browser displays:
    - semantic R1 versus R2 diff;
    - addressed intents;
    - evidence;
    - changed approved nodes;
    - remaining unresolved items.
15. The human accepts or reopens the result.
16. The complete history survives daemon restart and projection rebuild.

No feature is complete until this vertical slice works reliably.

## 31. Implementation phases

### Phase 0: Architecture skeleton

Deliver:

- module boundaries;
- public JSON schemas;
- event envelope;
- command envelope;
- in-memory domain tests;
- SQLite migration framework;
- daemon runtime discovery;
- CLI health communication.

Exit condition:

- one test command creates one event and rebuildable projection.

### Phase 1: Immutable artifact revisions

Deliver:

- project/workspace identity;
- object store;
- HTML ingestion;
- revision manifests;
- revision graph;
- isolated artifact server;
- trusted shell;
- browser bootstrap authentication.

Exit condition:

- two historical revisions can be opened independently after source files change.

### Phase 2: Semantic feedback

Deliver:

- bridge;
- three interaction modes;
- semantic-node discovery;
- text and source anchors;
- drafts;
- review-batch submission;
- typed intents;
- orphan detection.

Exit condition:

- submitted feedback remains valid across a controlled revision change or becomes explicitly orphaned.

### Phase 3: Agent-neutral work protocol

Deliver:

- work projection;
- atomic claims;
- leases;
- CLI machine output;
- result recording;
- revision publication from claimed work;
- crash and retry handling.

Exit condition:

- two concurrent fake agents cannot claim the same work, and abandoned work recovers.

### Phase 4: Diff, evidence and decisions

Deliver:

- semantic diff;
- rendered-text diff;
- evidence objects;
- verification records;
- accept, reject and reopen decisions;
- timeline.

Exit condition:

- the complete vertical slice passes browser, crash and concurrency tests.

### Phase 5: Markdown adapter and OSS hardening

Deliver:

- Markdown ingestion;
- source mapping;
- stable heading/block identity;
- installer;
- skills for major agent harnesses;
- protocol documentation;
- contribution fixtures;
- migration and repair commands.

Exit condition:

- a Markdown plan and an interactive HTML architecture use the same intent/work/evidence model.

## 32. First ADRs to create

Before substantive implementation, create these architecture decision records:

1. **ADR-001 — Immutable facts and rebuildable projections**
2. **ADR-002 — One daemon and serialized transactor per workspace**
3. **ADR-003 — SQLite plus content-addressed filesystem objects**
4. **ADR-004 — Project, workspace, artifact and revision identity**
5. **ADR-005 — Separate trusted shell and artifact origins**
6. **ADR-006 — Versioned command, event and bridge schemas**
7. **ADR-007 — Typed intents with free-form fallback**
8. **ADR-008 — Durable work claims with ephemeral leases**
9. **ADR-009 — Semantic IDs and explicit orphaning**
10. **ADR-010 — Agent execution remains outside the daemon**
11. **ADR-011 — POST commands plus SSE notifications**
12. **ADR-012 — No CRDT, cloud sync or plugin runtime in v0.1**

Each ADR must include:

- context;
- decision;
- alternatives rejected;
- consequences;
- falsifier;
- migration path.

These exist in [`../adr/`](../adr/).

## 33. Build discipline for the implementation agent

Do not begin by building the polished browser UI.

Implement in this order:

1. Protocol schemas.
2. Pure domain decisions and projections.
3. In-memory tests.
4. SQLite append transaction.
5. Object store.
6. Daemon and CLI.
7. Immutable HTML revision serving.
8. Browser shell and bridge.
9. Typed feedback.
10. Work claims.
11. Diff and evidence.
12. UX refinement.

For every feature:

- identify the durable fact;
- identify the command;
- identify the pure decision;
- identify the projections;
- identify ephemeral state;
- define idempotency behavior;
- define stale-input behavior;
- define crash behavior;
- define protocol schema;
- add replay tests;
- add an end-to-end test.

Do not add abstractions because they sound generally reusable.

Add an abstraction only after at least two concrete implementations reveal the same independent responsibility.

## 34. Final architectural test

The architecture succeeds when this statement is true:

> A browser tab, daemon process, CLI invocation, source file, Git worktree, or agent process may disappear without erasing what artifact was reviewed, what the human meant, what work an agent claimed, what changed, what evidence was produced, or what the human accepted.

That is Tweakloop's actual product boundary.

The editor is a view over that system.
