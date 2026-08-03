# Non-negotiable design laws

Covers section 3 of the authoritative architecture. These laws are normative. Back to the [index](README.md).

## 3.1 Values over mutable places

A revision is a value. An intent is a value. Evidence is a value. A decision is a value.

Never update an old revision to make it represent a new revision.

Never rewrite a submitted intent to change what the human previously requested. Supersede it with another fact.

Never modify evidence after submission. Add corrected or superseding evidence.

## 3.2 Identity is not location

Do not identify:

- workspaces only by filesystem path;
- artifacts only by filename;
- revisions only by "latest";
- nodes only by CSS selectors;
- agents only by process ID;
- work only by a browser session.

Paths, selectors, ports, PIDs, and browser tabs are locators. They are not identities.

## 3.3 Ordering is not wall-clock time

Use a database-assigned monotonically increasing sequence as the authoritative local order of durable events.

Timestamps are metadata. Two machines or processes may disagree about wall-clock time.

## 3.4 Current state is derived

"Current revision," "unresolved feedback," "agent working," "approved," and "verification failed" must be derived from facts.

Do not create a single mutable session object containing the truth of the entire workflow.

## 3.5 Orthogonal dimensions stay orthogonal

Never give an intent one braided status such as:

```ts
status: "submitted-and-claimed-but-unverified"
```

Submission, disposition, execution, verification, and acceptance are independent dimensions.

A single intent may simultaneously be:

- submitted;
- active rather than superseded;
- addressed by an agent;
- verification-failed;
- not yet accepted.

Model those as separate facts and projections.

## 3.6 Effects remain at the edges

The domain core must not:

- read files;
- call Git;
- access SQLite;
- know HTTP;
- know React;
- know Claude Code, Codex, OpenCode, or OMP;
- inspect live DOM nodes.

The core receives values and returns values.

## 3.7 Protocols are data

Public commands, events, manifests, bridge messages, and evidence formats must be versioned data schemas.

Do not expose internal TypeScript classes as the protocol.

## 3.8 No silent recovery

Never silently:

- retarget an annotation;
- discard submitted feedback;
- overwrite a revision;
- steal active work;
- accept stale agent output;
- interpret missing evidence as passing;
- convert a branch into a linear revision;
- report a dead agent as "working."

Ambiguity must become visible state.
