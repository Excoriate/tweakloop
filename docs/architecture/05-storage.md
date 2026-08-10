# Storage architecture

Covers section 8 of the authoritative architecture. Back to the [index](README.md).

## 8. Storage architecture

### 8.1 SQLite fact log

Use SQLite as the local durable database.

Recommended initial schema:

```sql
CREATE TABLE events (
    seq                INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id           TEXT NOT NULL UNIQUE,
    workspace_id       TEXT NOT NULL,
    stream_type        TEXT NOT NULL,
    stream_id          TEXT NOT NULL,
    stream_version     INTEGER NOT NULL,
    event_type         TEXT NOT NULL,
    schema_version     INTEGER NOT NULL,
    recorded_at        TEXT NOT NULL,
    actor_json         TEXT NOT NULL,
    causation_id       TEXT,
    correlation_id     TEXT,
    payload_json       TEXT NOT NULL,

    UNIQUE (workspace_id, stream_id, stream_version)
) STRICT;

CREATE INDEX events_by_stream
ON events(workspace_id, stream_id, stream_version);

CREATE INDEX events_by_type
ON events(workspace_id, event_type, seq);

CREATE TABLE command_receipts (
    workspace_id       TEXT NOT NULL,
    idempotency_key    TEXT NOT NULL,
    command_id         TEXT NOT NULL,
    first_event_seq    INTEGER,
    last_event_seq     INTEGER,
    response_json      TEXT NOT NULL,
    recorded_at        TEXT NOT NULL,

    PRIMARY KEY (workspace_id, idempotency_key)
) STRICT;

CREATE TABLE blobs (
    hash               TEXT PRIMARY KEY,
    byte_length        INTEGER NOT NULL,
    media_type         TEXT NOT NULL,
    created_at         TEXT NOT NULL
) STRICT;
```

Projection tables are implementation details and can evolve more freely:

```text
p_artifacts
p_revisions
p_revision_parents
p_semantic_nodes
p_review_batches
p_intents
p_work
p_evidence
p_verifications
p_decisions
p_timeline
```

Prefix projection tables to make their disposable nature explicit.

### 8.2 Content-addressed object store

Store artifact bytes and large evidence outside SQLite:

```text
objects/sha256/ab/cd/<full-hash>
```

Use SHA-256 over exact bytes.

SQLite stores:

- hash;
- media type;
- length;
- relationships;
- metadata.

The filesystem stores:

- HTML;
- Markdown;
- CSS;
- JavaScript;
- images;
- screenshots;
- agent-result documents;
- test logs;
- patches;
- Mermaid or Excalidraw data.

Never overwrite an object at a known hash.

Write objects by:

1. writing a temporary file;
2. flushing and closing it;
3. verifying its hash;
4. atomically renaming it to the content-addressed location.

### 8.3 Database implementation choice

Use `better-sqlite3` behind a narrow storage port for the initial implementation. Its synchronous transaction model aligns with a serialized transactor. Do not let its API escape into the domain.

Do not make `node:sqlite` the public foundation yet: in Node 26.5.0 it remains at release-candidate stability.

Pin a maintained `better-sqlite3` release containing a patched SQLite version. SQLite disclosed a rare WAL reset race in versions through 3.51.2 and fixed it in 3.51.3; current maintained `better-sqlite3` releases include newer SQLite builds.

The storage interface must make replacing the driver mechanical:

```ts
type Store = Readonly<{
  transact: <T>(operation: (tx: Transaction) => T) => T;
  queryEvents: (query: EventQuery) => readonly StoredEvent[];
  readProjection: <T>(query: ProjectionQuery<T>) => T;
}>;
```

Do not create an ORM.

Use explicit SQL and explicit data transformations.

### 8.4 Runtime automation authority

SQLite stores only runtime-capability and one-use automation-token hashes. Runtime session authority
is scoped to workspace, active session, declared agent/process, daemon start nonce, and generation;
handoff, end, resume, or restart invalidates the predecessor. Plaintext runtime capability remains
in private client custody outside the workspace and never enters an artifact, event, receipt, or
export.

Automation rows further bind artifact, method, operation, route-set version, normalized semantic
request hash, and expiry. Token consume, scope revalidation, semantic application receipt lookup,
draft/object bookkeeping, mutation, and invalidation descriptor commit or roll back together. This
is capability-holder provenance, not physical model/process authentication; a hostile same-user
sibling able to read the private capability is outside this boundary.
