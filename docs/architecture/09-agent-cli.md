# Agent CLI contract

Covers section 14 of the authoritative architecture. Back to the [index](README.md).

## 14. Agent CLI contract

Recommended commands:

| Command | Purpose |
|---|---|
| `tweak init` | Initialize project identity |
| `tweak open <path>` | Register, publish and open an artifact |
| `tweak publish <path>` | Publish a new immutable revision |
| `tweak artifacts list` | List artifact identities and heads |
| `tweak revision show <id>` | Return manifest and source metadata |
| `tweak work claim` | Atomically claim available work |
| `tweak work claim --wait` | Wait until claimable work exists |
| `tweak work show <id>` | Return intents, targets and context |
| `tweak work heartbeat <claim-id>` | Renew the ephemeral lease |
| `tweak work complete <claim-id>` | Record result and addressed intents |
| `tweak evidence add` | Attach immutable evidence |
| `tweak status` | Return current projections |
| `tweak protocol describe` | Return supported protocol versions |
| `tweak daemon stop` | Stop this workspace daemon |

Machine output requirements:

- `--json` produces one documented JSON value on stdout.
- Human diagnostics go to stderr.
- Exit codes are stable and documented.
- No progress narration appears in machine output.
- Commands accept idempotency keys.
- Every successful mutation returns the committed event sequence range.
- Errors include a stable code and actionable detail.

Example claim response:

```json
{
  "protocol": "tweakloop.cli/v1",
  "status": "claimed",
  "workspaceId": "ws_...",
  "work": {
    "workId": "work_...",
    "claimId": "claim_...",
    "leaseExpiresAt": "2026-08-03T13:40:00Z",
    "baseRevisionId": "rev_...",
    "intentIds": ["intent_1", "intent_2"]
  },
  "next": {
    "command": "tweak work show work_... --json"
  }
}
```

### 14.1 Waiting for work

`tweak work claim --wait` may use a long-lived HTTP request or daemon event stream internally.

The durable queue does not depend on the waiting process remaining alive.

If the agent process exits:

- work remains unclaimed, or
- its lease eventually expires.

Re-running the command is sufficient.
