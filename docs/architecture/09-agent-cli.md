# Agent CLI contract

Covers section 14 of the authoritative architecture. Back to the [index](README.md).

## 14. Agent CLI contract

Recommended commands:

| Command | Purpose |
|---|---|
| `tweak init` | Initialize project identity |
| `tweak open <path>` | Register, publish and open an artifact |
| `tweak publish <path>` | Publish a new immutable revision |
| `tweak review submit-comments <path>` | Validate comment input, then hand the human action to the authenticated review shell |
| `tweak work create-from-intents <ids...>` | Explicitly create one agent-owned Intent→Work relation |
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
| `tweak session attach <session> <path>` | Attach the exact registered head without creating session churn |
| `tweak session url <session>` | Mint a fresh one-use review URL without durable mutation |
| `tweak whiteboard scene add-node|add-edge|set-label|group|layout` | Apply one session-bound semantic scene mutation with a stable idempotency key |
| `tweak whiteboard scene inspect|publish` | Inspect the managed semantic draft or publish the exact observed draft |

Machine output requirements:

- `--json` produces one documented JSON value on stdout.
- Human diagnostics go to stderr.
- Exit codes are stable and documented.
- No progress narration appears in machine output.
- Commands accept idempotency keys.
- Every successful mutation returns the committed event sequence range.
- Errors include a stable code and actionable detail.
- A fresh published whiteboard may return `whiteboard.draft-missing` from semantic inspect; exactly
  that code permits one session-authorized idempotent semantic mutation to initialize the managed
  draft, followed by mandatory immediate inspection. Other inspect failures remain blocking.
- After semantic publication in an existing session, `session url <session> --document <document>`
  is the non-mutating review handoff. Agents do not call `open` just to mint a URL and do not consume
  the private one-use URL during their own verification.
- Human-only leaves return `human.browser-required` with `mutated: false` and a safe review-shell
  continuation; they never perform the human mutation through the CLI.
- Semantic scene leaves expose finite semantic receipts, not raw Excalidraw renderer or authority
  fields. Mutation/publish retries use visible stable idempotency keys.
- `whiteboard scene inspect --json` is a closed projection with top-level `protocol`, `artifactId`,
  and `scene`. The scene contains semantic-key-ordered `nodes`, `edges`, and `groups`; node fields
  are `semanticKey/kind/shape/label/bounds/deleted`, edge fields are
  `semanticKey/kind/from/to/label/bounds/deleted`, and group fields are `semanticKey/members`.
  Draft/base/hash/version state, the internal semantic-map wrapper, renderer bookkeeping,
  authority, paths, and URLs remain private.

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
