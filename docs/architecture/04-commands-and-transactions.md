# Command and transaction model

Covers section 7 of the authoritative architecture. Back to the [index](README.md).

## 7. Command and transaction model

### 7.1 Command envelope

All durable mutations enter through one versioned command envelope:

```json
{
  "protocol": "tweakloop.command/v1",
  "commandId": "0f3d26bb-8957-40bc-a50f-7e6adad74b31",
  "idempotencyKey": "agent-run-72:publish:architecture:8",
  "workspaceId": "ws_...",
  "actor": {
    "kind": "agent",
    "id": "claude-code",
    "runId": "run_72"
  },
  "type": "artifact.publish",
  "expected": {
    "streamId": "artifact_...",
    "streamVersion": 7
  },
  "payload": {}
}
```

Requirements:

- `commandId` identifies the invocation.
- `idempotencyKey` prevents duplicated effects.
- `expected.streamVersion` provides optimistic concurrency.
- `actor` records who requested the change.
- `payload` is validated against the schema for `type`.

### 7.2 Pure decision boundary

The domain should expose two conceptual operations:

```ts
type Decision = Readonly<{
  events: readonly DomainEvent[];
  response: unknown;
}>;

function decide(
  current: Readonly<DomainState>,
  command: Readonly<DomainCommand>,
): Decision;

function evolve(
  current: Readonly<DomainState>,
  event: Readonly<DomainEvent>,
): DomainState;
```

`decide` must perform no I/O.

The transactor performs the following:

1. Validate the command envelope and typed payload.
2. Check for an existing idempotency receipt.
3. Load relevant stream events or projection state.
4. Check expected stream version.
5. Call the pure decision function.
6. Begin an immediate SQLite transaction.
7. Append all returned events.
8. Update synchronous projections.
9. Record the idempotency receipt and response.
10. Commit.
11. Publish committed envelopes to connected observers.

No browser or agent receives an event before the transaction commits.

### 7.3 One serialized writer

SQLite permits multiple readers but only one simultaneous writer; WAL mode allows readers to continue against snapshots while the writer appends changes. This naturally matches a local daemon with one transactor and many read projections.

Do not let:

- the CLI;
- browser workers;
- artifact renderer;
- plugin processes;
- agent adapters

write directly to SQLite.

All durable mutations pass through the daemon transactor.

### 7.4 Authority is derived before command execution

The generic command boundary derives human authority from the authenticated shell transport. The
CLI can submit explicit agent operations, but it cannot label a command human: `decision accept`,
`decision reopen`, `review submit-comments`, and default-human chat paths stop with
`human.browser-required`, `mutated: false`, and a fresh-shell continuation before mutation.

Semantic whiteboard automation uses a narrower transaction. The daemon validates and consumes one
scoped automation token, revalidates the active session and runtime generation, checks the
caller-visible application idempotency key, and applies the draft mutation inside one immediate
transaction. A used token cannot replay transport authority; a freshly minted token with the same
business key and identical payload returns the original semantic receipt without reapplying.
