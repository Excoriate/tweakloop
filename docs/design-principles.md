# Tweakloop design principles

Distilled from the authoritative architecture ([docs/architecture/](architecture/)). The stance is Rich Hickey-inspired — *Simple Made Easy* applied to a local-first information system — without selecting technologies because Hickey created them. "Simple" does not mean one process, one file, or fewer modules; it means identity, storage, rendering, workflow, presence, execution, and verification are never braided together. The full normative text is [architecture/02-design-laws.md](architecture/02-design-laws.md); this document is the working summary.

## The eight laws

1. **Values over mutable places.** A revision, an intent, evidence, a decision — each is an immutable value. Never update an old revision to represent a new one; never rewrite a submitted intent; never modify evidence. Supersede with new facts.

2. **Identity is not location.** Paths, filenames, "latest", CSS selectors, PIDs, ports, and browser tabs are locators. Workspaces, artifacts, revisions, semantic nodes, agents, and work carry their own identities (see [architecture/01-overview.md](architecture/01-overview.md) §5.2 and ADR-004).

3. **Ordering is not wall-clock time.** The database-assigned `seq` is the authoritative local order of durable events. Timestamps are metadata; processes disagree about clocks.

4. **Current state is derived.** "Current revision", "unresolved feedback", "agent working", "approved" — all are projections over facts. There is no single mutable session object holding workflow truth.

5. **Orthogonal dimensions stay orthogonal.** Submission, disposition, execution, verification, and acceptance are independent dimensions. Never a braided status like `"submitted-and-claimed-but-unverified"`. One intent may simultaneously be submitted, active, addressed, verification-failed, and not yet accepted — as separate facts.

6. **Effects remain at the edges.** The domain core reads no files, calls no Git, touches no SQLite, knows no HTTP, no React, no agent brand, no live DOM. Values in, values out.

7. **Protocols are data.** Commands, events, manifests, bridge messages, and evidence formats are versioned data schemas — never exported TypeScript classes.

8. **No silent recovery.** Never silently retarget an annotation, discard feedback, overwrite a revision, steal active work, accept stale output, treat missing evidence as passing, linearize a branch, or report a dead agent as working. Ambiguity becomes visible state.

## Domain coding constraints

Inside `src/domain` (from [architecture/13-technology.md](architecture/13-technology.md) §23.3):

- no classes;
- no mutable module-level variables;
- no framework, database, or filesystem imports;
- no internally generated timestamps or random IDs;
- no environment access;
- no implicit singletons.

Time, IDs, actors, and current facts arrive as inputs. The domain exposes `decide(state, command) → {events, response}` and `evolve(state, event) → state`, both pure. Infrastructure modules may use controlled mutation where the runtime requires it.

## Dependency direction

From [architecture/13-technology.md](architecture/13-technology.md) §25.

Allowed:

```text
web → protocol
cli → protocol
daemon → domain + protocol + storage + artifacts
storage → protocol primitives
artifacts → protocol primitives
domain → protocol value types
```

Forbidden: `domain →` daemon, storage, web, or CLI; `artifact adapter → agent implementation`; `bridge → shell implementation`. The domain must remain executable in an in-memory test with plain values.

## Build discipline

From [architecture/15-roadmap.md](architecture/15-roadmap.md) §33. Implementation order: protocol schemas → pure domain decisions and projections → in-memory tests → SQLite append transaction → object store → daemon and CLI → immutable HTML revision serving → browser shell and bridge → typed feedback → work claims → diff and evidence → UX refinement. Do not begin with the polished UI.

For **every** feature, identify before coding:

- the durable fact;
- the command;
- the pure decision;
- the projections;
- the ephemeral state;
- idempotency behavior;
- stale-input behavior;
- crash behavior;
- the protocol schema;
- replay tests;
- an end-to-end test.

Do not add abstractions because they sound reusable. Add one only after at least two concrete implementations reveal the same independent responsibility.
