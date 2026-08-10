# CLI reference

This is the complete reference for all 69 public leaf commands in the current TypeScript source on
2026-08-09. The default parity test derives the exact command tree, usage, and purpose from the
source registrars. Rebuilt package-help parity is a separate release check because checked-in
`dist/` can lag the current source; daemon-backed behavior is tested elsewhere.

## Find a command family

- [Local authoring and project commands](#local-authoring-and-project-commands)
- [Review, publication, and inspection](#review-publication-and-inspection)
- [Daemon lifecycle](#daemon-lifecycle)
- [Work and human decisions](#work-and-human-decisions)
- [Typed questions and inbound delivery](#typed-questions-and-inbound-delivery)
- [Chat](#chat)
- [Durable sessions](#durable-sessions)
- [Presence](#presence)
- [Native client hooks](#native-client-hooks)
- [Whiteboards](#whiteboards)
- [Workspace portability](#workspace-portability)

## Choose the executable first

Inside this source checkout, use the working-tree build before any globally installed copy:

```bash
pnpm build
node dist/cli/index.js --help
```

`pnpm tweak --help` runs the same built entry point through the package script; command arguments
follow `pnpm tweak` directly, without an extra `--`. The examples below use `tweak` for readability;
inside the checkout, replace that prefix with `node dist/cli/index.js`.

Outside this checkout, use an installed binary first. Use the npx form only as the fallback after
the package is published to a registry. Preserve the outer npx spelling so continuation commands
returned by Tweakloop do not point at an ephemeral package-cache script:

```bash
tweak --help

TWEAKLOOP_INVOCATION_JSON='["npx","-y","tweakloop"]' \
  npx -y tweakloop --help
```

The ordered contract below is parsed by the documentation test. Registry publication, an installed
binary, and npx availability are not exercised by this repository-only test.

```json cli-invocation-contract
{
  "order": ["checkout", "installed", "npx"],
  "checkout": ["node", "dist/cli/index.js"],
  "checkoutAlternative": ["pnpm", "tweak"],
  "installed": ["tweak"],
  "npx": ["npx", "-y", "tweakloop"],
  "npxInvocationEnv": ["npx", "-y", "tweakloop"],
  "registryAvailability": "unverified"
}
```

### Resolve identity before authoring

Before creating or overwriting an artifact, run `artifacts list --json`, then `session list
--document <intended-path> --json`. An exact unregistered path returns a typed empty session list.
An existing artifact/session lineage means the next write is a revision of that durable identity;
an ambiguous selector fails closed. File existence alone does not answer “new artifact or new
revision.” Use the invocation prefix selected above for both probes.

## Global selection and output semantics

```text
tweak [--workspace <path>] [--json] <command> [command options]
```

- `--workspace <path>` selects the Tweakloop workspace. It defaults to the process's current
  directory and is normalized to an absolute path for project identity, daemon discovery, state,
  and generated continuation commands. It does not change the process working directory: relative
  artifact, destination, and config paths are still resolved from the shell's current directory.
- `--json` requests machine output for ordinary finite commands. One finite result is emitted as
  one JSON value on stdout; diagnostics remain on stderr. Pretty-printed JSON can span lines—it is
  still one value, not JSONL.
- `--version` prints the CLI version. `--help` and `-h` print help; every leaf supports them, so they
  are omitted from the command-specific option lists below.
- The default agent identity is `TWEAKLOOP_AGENT_ID`, then `USER`, then `cli`, where a command offers
  a defaulted `--agent`. An `agent:` prefix is canonicalized away on the session/work paths that
  resolve agent identity.
- Selectors are exact unless their option says `id-or-path`. Session-bound operations derive
  agent/process identity from the durable session and reject conflicting assertions. `--from-work`
  similarly derives chat identity and typed references from the claimed work item.

### Finite results versus streams

The `output` field in every leaf record below describes machine-output framing:

- `finite`: the command produces at most one machine result and exits. `next --wait`, `chat next
  --wait`, `work next --wait`, `question wait`, `decision wait`, and `work claim --wait` are bounded
  waits, not listeners.
- `jsonl`: a persistent listener emits one compact JSON object per stdout line until interrupted or
  disconnected. Only `session listen` and `chat listen` use this framing. They do not need `--json`.
- `daemon start --foreground` is also long-running, but it is a service process with diagnostics on
  stderr—not a JSONL consumer stream.

`next`, `chat next`, `work next`, `question ask`, `question wait`, and `chat acknowledge` require `--json`; `work claim
--wait` also requires it. Several agent-protocol leaves emit finite JSON even without the flag:
successful/all-mode `work claim`, `work progress`, `work heartbeat`, `work recover`, and the three
`decision` leaves. For all other finite leaves, pass `--json` when a machine will consume stdout.

Exit code `0` means the command completed its modeled outcome. Invalid input and ordinary failures
use `1`. Commands with an explicit bounded-timeout, conflict, or recovery-needed outcome may use
`2`; inspect their JSON receipt instead of treating every nonzero status as the same failure.

### Human authority stays in the review shell

Human decisions, comment submission, and default-human chat actions derive authority from the
authenticated browser transport. Their CLI leaves validate bounded context, then return the typed
error `human.browser-required` with `mutated: false` and a safe `session url <sessionId>` handoff;
they do not perform the human mutation or mint/export browser authority. When the exact session is
unknown, the next action is an exact active-session lookup followed by `session url`.

Explicit agent chat and tracking remain CLI operations. `chat send` needs an agent identity derived
from `--session`, `--from-work`, or explicit `--agent`; `chat promote --agent` remains an agent
tracking route. `work create-from-intents` also remains an agent operation, but attempting to reopen
accepted work returns `work.accepted-browser-required` so the human makes that decision in the
review shell.

```json cli-human-authority-contract
{
  "errorCode": "human.browser-required",
  "mutated": false,
  "nextAction": "session url <sessionId>",
  "alwaysBrowser": ["decision accept", "decision reopen", "review submit-comments"],
  "conditionalBrowser": ["chat send", "chat promote"],
  "agentCli": ["chat send", "chat promote", "work create-from-intents"],
  "acceptedWorkReopen": "work.accepted-browser-required"
}
```

## Local authoring and project commands

<!-- cli-reference-leaf {"path":"init","usage":"tweak init [options]","purpose":"initialize project identity (.tweakloop/project.json)","output":"finite"} -->
### `tweak init`

```text
tweak init
```

Initializes `.tweakloop/project.json` for the selected workspace. No command-specific options.

<!-- cli-reference-leaf {"path":"new plan","usage":"tweak new plan [options] <path>","purpose":"create a new HTML plan from the packaged starter without overwriting","output":"finite"} -->
### `tweak new plan`

```text
tweak new plan <path>
```

Creates an HTML plan from the packaged starter and refuses to overwrite an existing path. No
command-specific options.

<!-- cli-reference-leaf {"path":"lint","usage":"tweak lint [options] <path>","purpose":"analyze HTML or Markdown semantic identity without starting the daemon","output":"finite"} -->
### `tweak lint`

```text
tweak lint <path>
```

Checks HTML or Markdown semantic identity without starting the daemon. No command-specific options.

<!-- cli-reference-leaf {"path":"diff","usage":"tweak diff [options] <path>","purpose":"compare a candidate semantic index with its immutable head or an empty baseline","output":"finite"} -->
### `tweak diff`

```text
tweak diff <path> [--artifact <id-or-path>]
```

Compares the candidate semantic index with the immutable current head. An exact unregistered path
uses an explicit empty baseline and reports every semantic node as added. The daemon must be running.

- `--artifact <id-or-path>` selects an existing artifact when source-path resolution is unavailable;
  an explicit unknown artifact fails instead of becoming a new identity.

<!-- cli-reference-leaf {"path":"check","usage":"tweak check [options] <path>","purpose":"render HTML or Markdown in Chromium and enforce the browser quality contract","output":"finite"} -->
### `tweak check`

```text
tweak check <path>
```

Runs semantic lint, renders HTML or Markdown in Chromium, and enforces the browser quality
contract. No command-specific options.

## Review, publication, and inspection

<!-- cli-reference-leaf {"path":"open","usage":"tweak open [options] <path>","purpose":"register an artifact and open the review shell","output":"finite"} -->
### `tweak open`

```text
tweak open <path> [--no-browser] [--agent <id>] [--session <id>]
  [--role <primary|opened|whiteboard>] [--process <nonce>]
tweak open <path> [--no-browser] [--agent <id>] [--process <nonce>]
  [--title <text>] [--goal <text>]
```

Without `--session`, publishes the source, starts or discovers the workspace daemon, creates a
generated durable session, and mints a one-time review URL. With `--session`, atomically opens or
attaches the source in that existing active session and mints a fresh one-use URL; it does not
create, resume, or replace session authority.

- `--no-browser` prints the URL instead of launching a browser.
- `--agent <id>` owns a newly generated session or identifies the actor opening into an existing
  session; default: the default agent identity.
- `--session <id>` targets an existing active session only. `--role` selects `primary`, `opened`, or
  `whiteboard` attachment and is valid only with `--session`.
- `--process <nonce>` supplies a new-session process identity or asserts the exact process recorded
  by the existing session.
- `--title <text>` and `--goal <text>` apply only to the no-`--session` creation branch. Combining
  either with `--session` returns `session.open-option-conflict` without mutation.

For a caller-selected new session ID, use the explicit lifecycle; later `open --session` calls are
existing-session operations:

```text
tweak publish <path> --agent <id> --json
tweak session start <path> --agent <id> --session-id <new-session-id> \
  [--process <nonce>] [--title <text>] [--goal <text>] --json
tweak open <path> --agent <id> --session <new-session-id> [--process <nonce>] --no-browser --json
```

<!-- cli-reference-leaf {"path":"publish","usage":"tweak publish [options] <path>","purpose":"snapshot the source file as a new immutable revision","output":"finite"} -->
### `tweak publish`

```text
tweak publish <path> [--agent <id>] [--session <id>] [--artifact <id>]
tweak publish <path> --complete <workId> --summary <text> [--intent-ids <csv>]
```

Snapshots a file as an immutable revision. With `--complete`, it atomically follows the exact work
identity through publication and completion; identity overrides are then rejected.

- `--agent <id>` publishes as an agent.
- `--session <id>` correlates the revision with a durable session.
- `--artifact <id>` publishes to an existing session artifact and requires `--session`.
- `--complete <workId>` completes claimed work with the exact published revision.
- `--summary <text>` is required with `--complete`.
- `--intent-ids <csv>` lists the intents addressed by the completion.

<!-- cli-reference-leaf {"path":"status","usage":"tweak status [options]","purpose":"report daemon health and workspace projections","output":"finite"} -->
### `tweak status`

```text
tweak status [--summary]
```

Reports stopped/running daemon state and the selected workspace's derived snapshot.

- `--summary` returns compact health and identity fields instead of the full JSON snapshot.

<!-- cli-reference-leaf {"path":"artifacts list","usage":"tweak artifacts list [options]","purpose":"list artifact identities","output":"finite"} -->
### `tweak artifacts list`

```text
tweak artifacts list
```

Lists registered artifact identities. No command-specific options.

<!-- cli-reference-leaf {"path":"restore","usage":"tweak restore [options] <revisionId>","purpose":"republish a prior revision as the new head (rollback), and sync the source file","output":"finite"} -->
### `tweak restore`

```text
tweak restore <revisionId> [--no-write-source] [--agent <id>]
```

Republishes prior revision content as a new head; history is not rewritten. By default it also
writes the restored bytes to the artifact's source path when one exists.

- `--no-write-source` leaves the source file unchanged.
- `--agent <id>` attributes the restoration to an agent.

<!-- cli-reference-leaf {"path":"repair","usage":"tweak repair [options]","purpose":"workspace maintenance (daemon must be stopped)","output":"finite"} -->
### `tweak repair`

```text
tweak repair --rebuild-projections
```

Runs in-process maintenance while holding the startup lock. The daemon must be stopped.

- `--rebuild-projections` is required in practice; it rebuilds every `p_*` projection from the
  append-only event log.

<!-- cli-reference-leaf {"path":"events list","usage":"tweak events list [options]","purpose":"print committed events after a sequence number","output":"finite"} -->
### `tweak events list`

```text
tweak events list [--after <seq>]
```

Lists committed events in database-sequence order.

- `--after <seq>` returns events after the sequence; default: `0`.

## Daemon lifecycle

<!-- cli-reference-leaf {"path":"daemon start","usage":"tweak daemon start [options]","purpose":"start the daemon for this workspace","output":"finite"} -->
### `tweak daemon start`

```text
tweak daemon start [--foreground]
```

Starts or discovers the selected workspace's daemon.

- `--foreground` keeps the daemon in this process and writes logs to stderr until interrupted.

<!-- cli-reference-leaf {"path":"daemon stop","usage":"tweak daemon stop [options]","purpose":"stop this workspace's daemon","output":"finite"} -->
### `tweak daemon stop`

```text
tweak daemon stop
```

Requests shutdown of the selected workspace's daemon. No command-specific options.

## Work and human decisions

<!-- cli-reference-leaf {"path":"work create-from-intents","usage":"tweak work create-from-intents [options] <intentIds...>","purpose":"explicitly track existing review intents as one work relation","output":"finite"} -->
### `tweak work create-from-intents`

```text
tweak work create-from-intents <intentIds...> --reason <text>
  --idempotency-key <key> [--session <id>] [--assignee-agent <id>] [--agent <id>]
```

Creates one explicit agent-owned Intent→Work relation. It never creates a second comment identity
or implicitly converts every comment into work.

- `--reason <text>` and the caller-stable `--idempotency-key <key>` are required.
- Intent IDs must be nonempty and unique; the CLI normalizes their order before deriving stable
  command, work, and decision identities.
- `--session <id>` correlates one exact session; `--assignee-agent <id>` selects the routed agent;
  `--agent <id>` records the agent making the tracking decision.
- Open work remains trackable through this agent path. Reopening accepted work requires browser
  authority; the server returns `work.accepted-browser-required` without creating another relation.

<!-- cli-reference-leaf {"path":"work next","usage":"tweak work next [options]","purpose":"return the next existing work claim","output":"finite"} -->
### `tweak work next`

```text
tweak work next --session <id> [--agent <id>] [--process <nonce>]
  [--wait] [--timeout <ms>] [--ttl <ms>] --json
```

Uses the same atomic selector and recovery authority as top-level `next`, but admits only work.
Earlier eligible chat remains unreserved. Use this facade when the harness has a separate chat
waiter; otherwise prefer top-level `next` so one process wakes for either kind.

<!-- cli-reference-leaf {"path":"review submit-comments","usage":"tweak review submit-comments [options] <document>","purpose":"hand off comment submission to the human-authenticated review shell","output":"finite"} -->
### `tweak review submit-comments`

```text
tweak review submit-comments <document> --comments-json <json>
  --idempotency-key <key> [--session <id>] [--assignee-agent <id>] [--agent <id>]
```

Validates the nonempty comment array and exact registered document head, then returns
`human.browser-required` with `mutated: false`. Comment bodies and the idempotency key are not echoed
in the handoff. `--agent` and `--assignee-agent` are compatibility hints only; they do not confer
human authority. Complete the comment submission in the fresh review-shell URL.

<!-- cli-reference-leaf {"path":"work claim","usage":"tweak work claim [options]","purpose":"claim the next open work item (typed intents + revision context)","output":"finite"} -->
### `tweak work claim`

```text
tweak work claim [--agent <id>] [--work <id> | --session <id> | --document <id-or-path>]
  [--all] [--process <nonce>] [--ttl <ms>] [--wait] [--timeout <ms>]
```

Claims one exact or next matching open work item with its typed intents and revision context.

- `--agent <id>` selects the agent; with `--session`, identity is derived and this is an assertion.
- `--work <id>` selects one exact work item and cannot combine with session/document/all filters.
- `--session <id>` and `--document <id-or-path>` constrain eligible work.
- `--all` claims the bounded set currently open in the snapshot; it cannot combine with `--wait`.
- `--process <nonce>` supplies the process nonce; default: `TWEAKLOOP_SESSION_NONCE` or generated.
- `--ttl <ms>` sets lease lifetime; default: `30000`.
- `--wait` waits for one claim and requires `--json`; `--timeout <ms>` defaults to `30000`.

<!-- cli-reference-leaf {"path":"work complete","usage":"tweak work complete [options] <workId>","purpose":"record claimed work as addressed, with a summary and the revision produced","output":"finite"} -->
### `tweak work complete`

```text
tweak work complete <workId> --claim <claimId> --summary <summary>
  [--agent <id>] [--revision-id <revisionId>] [--intent-ids <ids>]
```

Records claimed work as addressed; this does not imply human acceptance.

- `--claim <claimId>` and `--summary <summary>` are required.
- `--agent <id>` optionally asserts the agent otherwise derived from the claim.
- `--revision-id <revisionId>` records the produced revision.
- `--intent-ids <ids>` is a comma-separated addressed subset; default: all work intents.

<!-- cli-reference-leaf {"path":"work progress","usage":"tweak work progress [options] <workId>","purpose":"record immutable progress without implying human acceptance","output":"finite"} -->
### `tweak work progress`

```text
tweak work progress <workId> --claim <claimId> --summary <summary> --intent-ids <ids>
  [--agent <id>] [--revision-id <revisionId>] [--release]
```

Records immutable partial progress without changing human acceptance.

- `--claim`, `--summary`, and comma-separated `--intent-ids` are required.
- `--agent <id>` defaults to the default agent identity.
- `--revision-id <revisionId>` associates a revision.
- `--release` releases the claim so remaining work can be claimed.

<!-- cli-reference-leaf {"path":"work heartbeat","usage":"tweak work heartbeat [options] <workId>","purpose":"renew the ephemeral lease for a durable claim","output":"finite"} -->
### `tweak work heartbeat`

```text
tweak work heartbeat <workId> --claim <claimId> --process <nonce>
  [--agent <id>] [--ttl <ms>]
```

Renews the ephemeral lease protecting a durable claim.

- `--claim <claimId>` and `--process <nonce>` are required.
- `--agent <id>` defaults to the default agent identity.
- `--ttl <ms>` defaults to `30000`.

<!-- cli-reference-leaf {"path":"work recover","usage":"tweak work recover [options] <workId>","purpose":"replace an expired claim with a new durable claim","output":"finite"} -->
### `tweak work recover`

```text
tweak work recover <workId> --stale-claim <claimId> --process <nonce>
  [--agent <id>] [--ttl <ms>]
```

Replaces an expired claim with a new guarded claim.

- `--stale-claim <claimId>` and `--process <nonce>` are required.
- `--agent <id>` defaults to the default agent identity.
- `--ttl <ms>` defaults to `30000`.

<!-- cli-reference-leaf {"path":"work list","usage":"tweak work list [options]","purpose":"list work items and their status","output":"finite"} -->
### `tweak work list`

```text
tweak work list [--status <status>] [--work <workId>] [--session <sessionId>]
  [--artifact <artifactId-or-source-path>] [--cursor <cursor>] [--full]
```

Lists compact work summaries after exact filtering.

- `--status <status>` is `open`, `claimed`, `addressed`, or `all`; default: `open`.
- `--work`, `--session`, and `--artifact` select exact identities.
- `--cursor <cursor>` continues a prior compact result with the same filters.
- `--full` includes complete work values instead of compact summaries.

<!-- cli-reference-leaf {"path":"decision accept","usage":"tweak decision accept [options] <workId>","purpose":"hand off acceptance to the human-authenticated review shell","output":"finite"} -->
### `tweak decision accept`

```text
tweak decision accept <workId> [--reason <text>]
```

Validates the work identity, then returns `human.browser-required` with `mutated: false` and the
exact review-shell continuation. The optional `--reason <text>` is accepted for compatibility but
is not submitted or echoed; acceptance occurs only in the authenticated browser.

<!-- cli-reference-leaf {"path":"decision reopen","usage":"tweak decision reopen [options] <workId>","purpose":"hand off reopening to the human-authenticated review shell","output":"finite"} -->
### `tweak decision reopen`

```text
tweak decision reopen <workId> --reason <text>
```

Validates the work identity, then returns `human.browser-required` with `mutated: false` and the
exact review-shell continuation. `--reason <text>` remains required for compatibility but is not
submitted or echoed; reopening occurs only in the authenticated browser.

<!-- cli-reference-leaf {"path":"decision wait","usage":"tweak decision wait [options] <workId>","purpose":"wait for the human accept/reopen decision on one work item","output":"finite"} -->
### `tweak decision wait`

```text
tweak decision wait <workId> [--timeout <ms>]
```

Waits for one final accept/reopen result, emits one JSON value, and exits. `--timeout <ms>` defaults
to `60000`; timeout returns a pending receipt and exit code `2`.

## Typed questions and inbound delivery

<!-- cli-reference-leaf {"path":"question ask","usage":"tweak question ask [options] <prompt>","purpose":"ask one bounded choice question as the exact session agent","output":"finite"} -->
### `tweak question ask`

```text
tweak question ask <prompt> --session <id> --option <key=label...> --json
```

Asks a durable choice question as the exact active-session agent.

- `--session <id>` is required.
- `--option <key=label...>` is required and accepts 2–8 unique, nonempty keys and labels.
- `--json` is required and returns the question message ID.

<!-- cli-reference-leaf {"path":"question wait","usage":"tweak question wait [options] <questionMessageId>","purpose":"block until one final answer or timeout, then emit exactly one result","output":"finite"} -->
### `tweak question wait`

```text
tweak question wait <questionMessageId> [--timeout <ms>] --json
```

Waits for one current answer and exits; it is not a listener. `--timeout <ms>` defaults to `60000`.
Timeout emits one pending receipt, uses exit code `2`, and `--json` is required.

<!-- cli-reference-leaf {"path":"next","usage":"tweak next [options]","purpose":"return the next routed chat delivery or existing work claim","output":"finite"} -->
### `tweak next`

```text
tweak next --session <id> [--agent <id>] [--process <nonce>]
  [--wait] [--timeout <ms>] [--ttl <ms>] --json
```

Returns one routed chat delivery or existing work claim, then exits. A chat result includes the
one-time acknowledgement command.

- `--session <id>` and `--json` are required.
- `--agent` and `--process` are optional exact assertions against session identity.
- `--wait` waits for one result; `--timeout <ms>` defaults to `30000`.
- `--ttl <ms>` sets a selected work claim's lease lifetime; default: `30000`.
- An ordinary empty timeout emits `{ "kind": "none", "timedOut": true }` and exits `0`, so a
  finite poll is not reported to an agent harness as a command failure. An unknown transport outcome
  emits `kind: "indeterminate"`, includes an exact recovery command, and exits `3`.
- A chat offer's `redeliveryEligibleAt` is the earliest time the daemon may offer a newer delivery
  generation. It is **not** an acknowledgement expiry and grants no processing authority. The exact
  returned acknowledgement remains valid until a newer generation supersedes it; action-bearing
  work still requires explicit promotion to Work and a WorkClaim.

<!-- cli-reference-leaf {"path":"chat next","usage":"tweak chat next [options]","purpose":"return the next routed chat delivery","output":"finite"} -->
### `tweak chat next`

```text
tweak chat next --session <id> [--agent <id>] [--process <nonce>]
  [--wait] [--timeout <ms>] [--ttl <ms>] --json
```

Uses the same atomic selector, delivery authority, timeout, and recovery contract as top-level
`next`, but admits only chat. Earlier eligible work remains unclaimed. Use this facade when the
harness has a separate work waiter; otherwise prefer top-level `next` to avoid competing waiters.

<!-- cli-reference-leaf {"path":"chat acknowledge","usage":"tweak chat acknowledge [options] <messageId>","purpose":"explicitly acknowledge one capability-bound chat delivery attempt","output":"finite"} -->
### `tweak chat acknowledge`

```text
tweak chat acknowledge <messageId> --delivery <attemptId> --capability <secret>
  --session <id> [--agent <id>] [--process <nonce>] --json
```

Acknowledges the exact capability-bound delivery attempt returned by `tweak next`.

- `--delivery`, `--capability`, `--session`, and `--json` are required.
- `--agent` and `--process` are optional exact session assertions.
- Acknowledgement proves receipt of that delivery generation only. It does not prove comprehension,
  ongoing live presence, work ownership, completion, or human acceptance.

## Chat

<!-- cli-reference-leaf {"path":"chat send","usage":"tweak chat send [options] <text>","purpose":"send as an agent; human messages continue in the authenticated review shell","output":"finite"} -->
### `tweak chat send`

```text
tweak chat send <text> [references and routing options]
```

Sends durable chat only when the actor is an agent derived from `--session`, `--from-work`, or
explicit `--agent`. Without an agent actor, the command returns `human.browser-required` with
`mutated: false` before reading or uploading attachments; human chat continues in the review shell.

- `--artifact <id>` scopes the message to an artifact; `--agent <id>` selects the actor when no
  session/work identity derives it; `--attach <paths...>` uploads files.
- `--mention <ids...>` is the legacy alias for `--document <ids...>`.
- `--document`, `--comment`, `--task`, and `--whiteboard` attach typed stable references.
- `--selection <document>` requires `--quote <text>` or `--semantic-id <id>`; `--revision <id>`
  pins it to an immutable revision.
- `--session`, `--to-agent`, `--thread`, `--work`, and `--intent` set correlation/routing.
- `--from-work <id>` derives agent, session, task, comment, and selection references from one work
  item and rejects conflicting overrides.

<!-- cli-reference-leaf {"path":"chat promote","usage":"tweak chat promote [options] <messageId>","purpose":"track as an agent; otherwise continue the human action in the review shell","output":"finite"} -->
### `tweak chat promote`

```text
tweak chat promote <messageId> [--session <id>] [--agent <id>]
```

Tracks an artifact-attached human message as agent work only when `--agent <id>` identifies the
routed agent. Without `--agent`, the leaf returns `human.browser-required` with `mutated: false` so
the human performs the conversion in the review shell.

- `--session <id>` asserts session ownership.
- `--agent <id>` asserts the message's routed agent.

<!-- cli-reference-leaf {"path":"chat attachment fetch","usage":"tweak chat attachment fetch [options] <hash> <destination>","purpose":"download one received attachment by hash without overwriting a local file","output":"finite"} -->
### `tweak chat attachment fetch`

```text
tweak chat attachment fetch <sha256> <destination>
```

Fetches, hash-verifies, and writes one immutable attachment without overwriting an existing file.
No command-specific options.

<!-- cli-reference-leaf {"path":"chat list","usage":"tweak chat list [options]","purpose":"read the chat (agents: poll this between steps)","output":"finite"} -->
### `tweak chat list`

```text
tweak chat list [--artifact <id>] [--after <seq>]
```

Reads a finite chat snapshot for polling.

- `--artifact <id>` filters to one artifact while retaining workspace-level messages.
- `--after <seq>` returns messages created after the sequence; default: `0`.

<!-- cli-reference-leaf {"path":"chat listen","usage":"tweak chat listen [options]","purpose":"stream chat messages live (one JSON per line); marks you as listening in the shell","output":"jsonl"} -->
### `tweak chat listen`

```text
tweak chat listen [--agent <id>] [--after <seq>]
```

Streams incoming chat as compact JSONL until interrupted or disconnected; diagnostics go to stderr.

- `--agent <id>` defaults to the default agent identity and suppresses that agent's own messages.
- `--after <seq>` replays after a sequence; default: `0`.

## Durable sessions

<!-- cli-reference-leaf {"path":"session start","usage":"tweak session start [options] [document]","purpose":"start a durable session with one document or no artifacts","output":"finite"} -->
### `tweak session start`

```text
tweak session start <document> [options]
tweak session start --empty [options]
```

Starts exactly one document session or a zero-artifact session and returns review/continuation data.

- `--empty` selects zero artifacts and cannot combine with a document.
- `--agent <id>` defaults to the default identity; `--process <nonce>` and `--session-id <id>`
  override generated identities.
- `--base-revision <id>`, `--title <text>`, and `--goal <text>` override derived session metadata.

<!-- cli-reference-leaf {"path":"session attach","usage":"tweak session attach [options] <sessionId> <document>","purpose":"attach the exact registered document head to an existing session","output":"finite"} -->
### `tweak session attach`

```text
tweak session attach <sessionId> <document> [--role <role>] [--agent <id>]
```

Attaches the exact registered head selected from one snapshot without publishing, starting another
session, or following a later global head.

- `--role <role>` is `primary`, `opened`, or `whiteboard`; default: `opened`.
- `--agent <id>` identifies the agent performing the attachment; default: the default identity.
- An exact retry returns the original attachment receipt; an already attached revision is reported
  without session churn.

<!-- cli-reference-leaf {"path":"session url","usage":"tweak session url [options] <sessionId>","purpose":"mint a fresh one-use review URL without durable mutation","output":"finite"} -->
### `tweak session url`

```text
tweak session url <sessionId> [--document <id-or-path>]
```

Mints a fresh single-use review-shell URL for an existing session without creating a durable event,
revision, or session. `--document <id-or-path>` selects one exact artifact already attached to that
session. Treat the returned URL as private browser authority; do not persist it in artifacts,
receipts, or logs.

<!-- cli-reference-leaf {"path":"session list","usage":"tweak session list [options]","purpose":"discover current and previous durable sessions","output":"finite"} -->
### `tweak session list`

```text
tweak session list [--document <id-or-path>] [--agent <id>]
  [--status <active|handed-off|ended>]
```

Lists current or historical durable sessions after exact filters.

<!-- cli-reference-leaf {"path":"session show","usage":"tweak session show [options] <sessionId>","purpose":"show lineage plus complete derived work, comments, and chat context","output":"finite"} -->
### `tweak session show`

```text
tweak session show <sessionId>
```

Shows complete derived session lineage, artifacts, work, comments, and chat. No command-specific
options.

<!-- cli-reference-leaf {"path":"session fetch","usage":"tweak session fetch [options] <sessionId> <artifactId> <destination>","purpose":"fetch the exact current bytes of one artifact attached to a session","output":"finite"} -->
### `tweak session fetch`

```text
tweak session fetch <sessionId> <artifactId> <destination>
```

Hash-verifies and writes the current bytes of one attached artifact without overwriting the
destination. No command-specific options.

<!-- cli-reference-leaf {"path":"session handoff","usage":"tweak session handoff [options] <sessionId>","purpose":"offer a durable session takeover to another agent","output":"finite"} -->
### `tweak session handoff`

```text
tweak session handoff <sessionId> --to-agent <id> --summary <text> [--agent <id>]
```

Offers a durable takeover without erasing the current session or its lineage.

- `--to-agent <id>` and `--summary <text>` are required.
- `--agent <id>` identifies the current owner; default: the default agent identity.

<!-- cli-reference-leaf {"path":"session resume","usage":"tweak session resume [options] <predecessorSessionId>","purpose":"create a successor session with the predecessor's full document context","output":"finite"} -->
### `tweak session resume`

```text
tweak session resume <predecessorSessionId> [--agent <id>] [--process <nonce>]
  [--session-id <id>] [--base-revision <id>] [--title <text>] [--goal <text>]
```

Creates an independent successor session carrying the predecessor's full document context.

- `--agent <id>` defaults to the default identity.
- `--process <nonce>` and `--session-id <id>` override generated identities.
- `--base-revision <id>` defaults to current head; title/goal otherwise inherit.

<!-- cli-reference-leaf {"path":"session end","usage":"tweak session end [options] <sessionId>","purpose":"end a durable session without erasing its lineage","output":"finite"} -->
### `tweak session end`

```text
tweak session end <sessionId> --summary <text> [--agent <id>]
```

Ends a durable session without erasing lineage. `--summary` is required; `--agent` identifies the
current owner and defaults to the default agent identity.

<!-- cli-reference-leaf {"path":"session listen","usage":"tweak session listen [options]","purpose":"attach to a durable session and emit its chat, work, revisions, and decisions","output":"jsonl"} -->
### `tweak session listen`

```text
tweak session listen [--session <id>] [--artifact <id>]
  [--agent <id>] [--process <nonce>]
  [--presence <listening|thinking|working>]
  [--until-work-settled <workId>]
```

Emits an initial agent-session snapshot followed by heartbeat, delta, resync, and whiteboard-draft
JSONL records. It stays attached until interrupted or disconnected.

- `--session <id>` scopes the complete multi-document session and derives agent/process identity.
- `--artifact <id>` selects whiteboard draft traffic; without a session it also filters durable
  traffic to that artifact.
- `--agent` and `--process` are assertions when a session supplies identity. Process default may
  come from `TWEAKLOOP_SESSION_NONCE` when no session is supplied.
- `--presence` binds ephemeral live state to the authenticated stream socket. `working` requires
  `--until-work-settled` so a generic listener cannot impersonate active claimed work.
- `--until-work-settled` requires `--session`, preflights the exact claim/agent/process authority,
  renews only that claim lease, and exits when the work is released or addressed. If renewal loses
  the exact claim authority, it emits a compact `work.listener-claim-lost` JSONL error, exits
  nonzero, and closes Working without mutating durable work. Socket liveness never emits
  `work.progressed`; semantic milestones remain explicit durable commands.
- Listener failure is non-authoritative: it forbids claiming visible Working but does not revoke an
  otherwise valid work claim or block its durable publication.

## Presence

<!-- cli-reference-leaf {"path":"presence","usage":"tweak presence [options] <state>","purpose":"set ephemeral presence shown in the shell (thinking, working, idle)","output":"finite"} -->
### `tweak presence`

```text
tweak presence <state> [--agent <id>] [--ttl <ms>]
```

Sets ephemeral shell presence. `thinking`, `working`, and `idle` are the documented state labels;
the CLI sends the supplied string to the daemon.

- `--agent <id>` defaults to the default agent identity.
- `--ttl <ms>` controls auto-expiry; default: `20000`.

## Native client hooks

These finite, JSON-only commands support the optional public Stop adapter in `hooks/v2`. They bind
one already-running native Codex, Claude Code, or Cursor conversation to one exact active
Tweakloop session. Binding requires the session's client-custodied runtime capability; only hashes
are stored by the daemon, while the binding secret remains in mode-`0600` state outside the
workspace.

Observation is deliberately read-only and at-least-once. It may report the same eligible human
chat message until the ordinary `next` delivery protocol offers that message. It does not reserve
or acknowledge delivery, claim work, publish progress or presence, start a native client, or wake a
stopped conversation. The repository ships no activated Codex, Claude Code, or Cursor hook config.
The package does ship `hooks/v2/configure-client.mjs`, which writes one explicitly requested,
previously absent project-local config and refuses existing settings. Configuration generation is
not client trust, conversation binding, or hook invocation.

<!-- cli-reference-leaf {"path":"native-hook bind","usage":"tweak native-hook bind [options]","purpose":"bind one native conversation to an exact active Tweakloop session","output":"finite"} -->
### `tweak native-hook bind`

```text
tweak --json native-hook bind --session <id>
  --client <codex|claude-code|cursor>
  --profile <stable-non-secret-id>
  --conversation <opaque-native-conversation-id>
```

Creates or exactly retries one binding. A conversation already bound to different current
authority fails closed; session handoff, resume, end, and daemon-generation changes revoke or stale
the old binding. The response contains no runtime capability or binding secret.

<!-- cli-reference-leaf {"path":"native-hook observe","usage":"tweak native-hook observe [options]","purpose":"read whether the bound native conversation has exact undelivered inbound chat","output":"finite"} -->
### `tweak native-hook observe`

```text
tweak --json native-hook observe
  --client <codex|claude-code|cursor>
  --profile <stable-non-secret-id>
  --conversation <opaque-native-conversation-id>
```

Returns either `{protocol:"tweakloop.native-hook-observation/v1",kind:"none"}` or a closed
`kind:"continue"` response containing only the exact Tweakloop session and message identities. A
missing, neighboring, revoked, or stale binding fails before an observation is returned.

## Whiteboards

The semantic scene path is the ordinary terminal-agent workflow for boxes, arrows, labels, groups,
and deterministic layout. The daemon owns Excalidraw element IDs, versions, nonces, bindings, and
geometry. Scene commands accept semantic identities only: no raw Excalidraw element, renderer
bookkeeping, or authority fields enter the request or response.

Five mutation leaves require the exact active `--session` and a visible caller-stable
`--idempotency-key`. The session binds automation to the runtime capability created at
`session start` or `session resume`; only its hash is durable, while the client keeps plaintext in
private external state. Each request mints a separate scoped one-use automation token. Restart,
resume, handoff, and end invalidate or rotate runtime authority. The daemon consumes the token,
revalidates session/generation/scope, checks the application idempotency receipt, and applies the
draft mutation in one immediate transaction.

If the daemon generation changes before a scene mutation, the CLI fails before token mint or draft
mutation with `runtime-capability.daemon-generation-changed`, `details.mutated:false`, and an exact
`session resume` command in `error.nextAction`. Execute that command, use the returned successor
`sessionId`, and retry the original scene command with its unchanged idempotency key. Generic
missing, corrupt, or identity-mismatched custody does not receive this recovery route.

This proves possession by the current capability holder, not physical model or OS-process identity.
A hostile same-user sibling able to read the holder's files or memory is outside the threat model.
Runtime authority and automation tokens are never exported in scene output, artifacts, semantic
bodies, or browser credentials. The human browser cookie cannot mint or redeem agent automation,
and the agent token cannot become the broad human cookie.

Every scene leaf has finite output. Mutations return one compact semantic receipt. `inspect` reads
the managed current draft and returns its semantic map without a throwaway file. `publish` pins the
observed draft version, scene hash, and expected head, then publishes that exact immutable revision;
it does not require hand-supplied draft/head IDs.

<!-- cli-reference-leaf {"path":"whiteboard scene add-node","usage":"tweak whiteboard scene add-node [options] <document> <semanticKey>","purpose":"add or update one semantic node","output":"finite"} -->
### `tweak whiteboard scene add-node`

```text
tweak whiteboard scene add-node <document> <semanticKey> --session <id>
  --idempotency-key <key> [--shape <rectangle|ellipse|diamond>] [--label <text>]
  [--x <number> --y <number>]
```

Adds or updates one semantic node. `--x` and `--y` must appear together and be finite. Stable
`semanticKey` addresses the node across updates; the daemon owns renderer identity and repair.

<!-- cli-reference-leaf {"path":"whiteboard scene add-edge","usage":"tweak whiteboard scene add-edge [options] <document> <semanticKey>","purpose":"add or update one semantic edge","output":"finite"} -->
### `tweak whiteboard scene add-edge`

```text
tweak whiteboard scene add-edge <document> <semanticKey> --session <id>
  --idempotency-key <key> --from <semanticKey> --to <semanticKey> [--label <text>]
```

Adds or updates one semantic edge between exact source and target node keys. It does not accept raw
element IDs or bindings.

<!-- cli-reference-leaf {"path":"whiteboard scene set-label","usage":"tweak whiteboard scene set-label [options] <document> <target>","purpose":"set or clear one semantic node or edge label","output":"finite"} -->
### `tweak whiteboard scene set-label`

```text
tweak whiteboard scene set-label <document> <target> --session <id>
  --idempotency-key <key> (--text <text> | --clear)
```

Sets or clears the label of one semantic node or edge. Exactly one of `--text` and `--clear` is
required. A group is membership-only and is not a label target; callers must reuse the exact node or
edge key returned by scene inspection rather than inventing a near-name.

<!-- cli-reference-leaf {"path":"whiteboard scene group","usage":"tweak whiteboard scene group [options] <document> <semanticKey>","purpose":"set semantic group membership and render its enclosure","output":"finite"} -->
### `tweak whiteboard scene group`

```text
tweak whiteboard scene group <document> <semanticKey> --session <id>
  --idempotency-key <key> --members <semanticKey...>
```

Sets the complete semantic membership of one group and renders one server-owned, locked, unlabeled
enclosure around the current members. The enclosure is a projection rather than a labelable entity;
its identity, geometry, and version remain absent from public scene inspection.

<!-- cli-reference-leaf {"path":"whiteboard scene layout","usage":"tweak whiteboard scene layout [options] <document>","purpose":"apply deterministic semantic layout","output":"finite"} -->
### `tweak whiteboard scene layout`

```text
tweak whiteboard scene layout <document> --session <id> --idempotency-key <key>
  [--direction <lr|tb>] [--gap <number>] [--scope <semanticKey...>]
```

Applies deterministic left-to-right or top-to-bottom layout to the whole semantic map or an exact
scope. `--gap` must be finite. Viewer camera and panel geometry never enter the semantic request, so
the same request produces the same scene geometry for every viewer.

<!-- cli-reference-leaf {"path":"whiteboard scene inspect","usage":"tweak whiteboard scene inspect [options] <document>","purpose":"inspect the current semantic map without exposing renderer JSON","output":"finite"} -->
### `tweak whiteboard scene inspect`

```text
tweak whiteboard scene inspect <document> [--json]
```

Reads and validates the managed current draft, then emits the closed, finite
`tweakloop.whiteboard-scene-inspect/v1` projection below. `nodes`, `edges`, and `groups` are each
ordered by `semanticKey`. This is a semantic-only read: draft/base/hash/version state, the internal
`semanticMap` wrapper, raw renderer IDs/seeds/nonces/versions/retired elements/group IDs, runtime
authority, filesystem paths, and URLs are not public fields.

A published whiteboard can legitimately have no managed semantic draft yet. In that state JSON mode
fails with stable code `whiteboard.draft-missing`. A session-authorized semantic mutation such as
`add-node` initializes the draft from the immutable head; the caller must preserve that mutation
receipt and immediately rerun `inspect` before further mutation or `publish`. No other inspect error
authorizes this cold-start branch.

```json cli-whiteboard-scene-inspect-contract
{
  "protocol": "tweakloop.whiteboard-scene-inspect/v1",
  "topLevelFields": ["protocol", "artifactId", "scene"],
  "sceneFields": ["nodes", "edges", "groups"],
  "nodeFields": ["semanticKey", "kind", "shape", "label", "bounds", "deleted"],
  "edgeFields": ["semanticKey", "kind", "from", "to", "label", "bounds", "deleted"],
  "groupFields": ["semanticKey", "members"],
  "ordering": "semanticKey",
  "forbiddenFields": [
    "draftId",
    "baseRevisionId",
    "draftVersion",
    "sceneHash",
    "semanticMap",
    "anchorId",
    "elementId",
    "elementSeed",
    "elementVersion",
    "elementVersionNonce",
    "labelElementId",
    "labelSeed",
    "labelVersion",
    "labelVersionNonce",
    "retiredElements",
    "groupId"
  ]
}
```

Node `kind` is `node`; `shape` is `rectangle`, `ellipse`, or `diamond`; `label` is a string or
`null`; `bounds` contains finite `x`, `y`, `width`, and `height`; and `deleted` is boolean. Edge
`kind` is `edge`; `from` and `to` are semantic keys; `label`, `bounds`, and `deleted` have the same
public meanings. A group contains its `semanticKey` and member semantic keys. Inspect does not mint
automation authority or expose raw Excalidraw scene JSON.

<!-- cli-reference-leaf {"path":"whiteboard scene publish","usage":"tweak whiteboard scene publish [options] <document>","purpose":"publish the exact currently observed semantic draft","output":"finite"} -->
### `tweak whiteboard scene publish`

```text
tweak whiteboard scene publish <document> --idempotency-key <key> [--agent <id>]
```

Reads the managed current draft, pins its draft ID/version, scene hash, and expected head, and
publishes that exact immutable revision. `--idempotency-key <key>` is required and must remain stable
across a dropped-response retry. `--agent <id>` defaults to the default agent identity. This leaf
uses the ordinary immutable publish command; it does not mint a semantic mutation token.

The managed workspace path is the explicit native-scene workflow for edits beyond the semantic
builder. The low-level draft commands expose CAS primitives for diagnostics, integrations, and
explicit conflict resolution.

<!-- cli-reference-leaf {"path":"whiteboard workspace checkout","usage":"tweak whiteboard workspace checkout [options] <artifactId> <path>","purpose":"check out the current draft with an opaque local sync-state sidecar","output":"finite"} -->
### `tweak whiteboard workspace checkout`

```text
tweak whiteboard workspace checkout <artifactId> <path>
  [--agent <id>] [--target-element <id...>]
```

Checks out the current draft with opaque local sync state and refuses unsafe replacement.

- `--agent <id>` defaults to the default identity.
- `--target-element <id...>` names existing elements whose collaboration identity must survive.

<!-- cli-reference-leaf {"path":"whiteboard workspace sync","usage":"tweak whiteboard workspace sync [options] <path>","purpose":"CAS-sync a checked-out .excalidraw file using its local state","output":"finite"} -->
### `tweak whiteboard workspace sync`

```text
tweak whiteboard workspace sync <path>
```

CAS-syncs a managed `.excalidraw` working file using its sidecar. Conflict is explicit and uses exit
code `2`. No command-specific options.

<!-- cli-reference-leaf {"path":"whiteboard workspace publish","usage":"tweak whiteboard workspace publish [options] <path>","purpose":"publish the exact draft observed by a managed working file","output":"finite"} -->
### `tweak whiteboard workspace publish`

```text
tweak whiteboard workspace publish <path>
```

Publishes exactly the draft observed by a managed working file. No command-specific options.

<!-- cli-reference-leaf {"path":"whiteboard draft get","usage":"tweak whiteboard draft get [options] <artifactId>","purpose":"inspect current draft metadata and optionally write the canonical scene","output":"finite"} -->
### `tweak whiteboard draft get`

```text
tweak --json whiteboard draft get <artifactId>
tweak whiteboard draft get <artifactId> --output <path>
```

Without `--output`, returns current draft metadata without fetching scene bytes or writing a file.
Use `--output <path>` to also write the current canonical draft scene.

<!-- cli-reference-leaf {"path":"whiteboard draft put","usage":"tweak whiteboard draft put [options] <artifactId> <path>","purpose":"CAS-update a live draft from a canonicalized .excalidraw file","output":"finite"} -->
### `tweak whiteboard draft put`

```text
tweak whiteboard draft put <artifactId> <path> --draft-id <id>
  --base-revision <id> --expected-version <n> --client-id <id>
  --client-sequence <n> [--agent <id>]
```

Performs a low-level CAS update from canonicalized Excalidraw bytes.

- Draft ID, base revision, expected version, client ID, and monotonic client sequence are required.
- `--expected-version 0` initializes a draft.
- `--agent <id>` defaults to the default identity.

<!-- cli-reference-leaf {"path":"whiteboard publish","usage":"tweak whiteboard publish [options] <artifactId>","purpose":"publish one observed draft version as an ordinary immutable revision","output":"finite"} -->
### `tweak whiteboard publish`

```text
tweak whiteboard publish <artifactId> --draft-id <id>
  --expected-draft-version <n> --expected-head <revisionId>
  [--agent <id>] [--idempotency-key <key>]
```

Publishes one precisely observed draft/head pair as an immutable revision.

- Draft ID, expected draft version, and expected artifact head are required.
- `--agent <id>` defaults to the default identity.
- `--idempotency-key <key>` supplies a stable retry key; otherwise one is generated.

<!-- cli-reference-leaf {"path":"whiteboard conflicts","usage":"tweak whiteboard conflicts [options] <artifactId>","purpose":"list retained whiteboard draft conflicts","output":"finite"} -->
### `tweak whiteboard conflicts`

```text
tweak whiteboard conflicts <artifactId>
```

Lists retained open and resolved draft conflicts. No command-specific options.

<!-- cli-reference-leaf {"path":"whiteboard resolve","usage":"tweak whiteboard resolve [options] <artifactId> <conflictId> <path>","purpose":"resolve a conflict with a new explicit CAS scene","output":"finite"} -->
### `tweak whiteboard resolve`

```text
tweak whiteboard resolve <artifactId> <conflictId> <path> --draft-id <id>
  --base-revision <id> --expected-version <n> --client-id <id>
  --client-sequence <n> [--agent <id>]
```

Resolves a retained conflict with a new explicit CAS scene. Draft/base/version/client fields are
required; `--agent <id>` defaults to the default identity. A racing resolution remains a conflict
and uses exit code `2`.

## Workspace portability

<!-- cli-reference-leaf {"path":"workspace restore-inventory","usage":"tweak workspace restore-inventory [options]","purpose":"inspect durable restore evidence, capacity, and recovery states","output":"finite"} -->
### `tweak workspace restore-inventory`

```text
tweak workspace restore-inventory
```

Reports restore/fork operation state, evidence quota, reservations, and retained bundle bytes. It
does not compact or delete evidence.

<!-- cli-reference-leaf {"path":"workspace restore-compact","usage":"tweak workspace restore-compact [options]","purpose":"release one completed restore evidence chain after proof-gated validation","output":"finite"} -->
### `tweak workspace restore-compact`

```text
tweak workspace restore-compact --kind <restore|fork> --operation <id>
  [--bundle <directory>]
```

Releases one completed evidence chain only after generation, retained-state, and runtime-absence
validation. A live matching runtime or corrupt retained DB/CAS/root evidence blocks compaction.
`--bundle` is an explicit migration/evidence override, not a way to skip validation.

<!-- cli-reference-leaf {"path":"workspace export","usage":"tweak workspace export [options] <directory>","purpose":"save bound collaboration state and a quiescent-verified workspace file set","output":"finite"} -->
### `tweak workspace export`

```text
tweak workspace export <directory> [--files-config <path>] [--operation <id>]
```

Writes a versioned bound collaboration bundle. First publication requires a new destination; an
exact retry with the same operation may find the matching completed bundle and returns its stable
receipt. A changed request or unrelated existing destination is a typed conflict.

- `--files-config <path>` also captures an explicit versioned workspace-file skeleton with
  inclusion/exclusion receipts.
- `--operation <id>` supplies the stable public operation identity for lost-response retry.

The collaboration rail is `event-seq-exact`: its captured and observed-end database sequences must
match. The optional file rail is separately `quiescent-verified`: selected membership, exclusions,
entry type, file identity, bytes, and mode must produce the same closed-set fingerprint before copy,
after object staging, and immediately before envelope publication. A change aborts publication with
no completed bundle receipt; the same operation can recapture.

This is not a kernel-atomic filesystem snapshot and not one joint collaboration/filesystem instant.
An ABA change that restores every observed field between observations, or a mutation after the last
observation, needs a stronger filesystem generation primitive to detect. Bound v1 file bundles must
be re-exported; they do not silently inherit the v2 guarantee.

<!-- cli-reference-leaf {"path":"workspace fork","usage":"tweak workspace fork [options] <bundle-directory>","purpose":"reconstruct one saved session into a new independent workspace","output":"finite"} -->
### `tweak workspace fork`

```text
tweak workspace fork <bundle-directory> --session <id> --into <directory>
  [--agent <id>]
```

Reconstructs one saved session into an independent workspace while preserving content identity and
minting new workspace/session/process ownership.

- `--session <id>` selects the exact saved checkpoint.
- `--into <directory>` is required and must be outside the source workspace. First publication
  requires an unclaimed destination; exact retry may reuse only its matching generation/journal.
- `--agent <id>` defaults to the default identity for the forked session.

<!-- cli-reference-leaf {"path":"workspace restore","usage":"tweak workspace restore [options] <directory>","purpose":"verify a saved workspace and open an isolated restored copy","output":"finite"} -->
### `tweak workspace restore`

```text
tweak workspace restore <directory> [--agent <id>]
```

Verifies a saved bundle and opens a Tweakloop-owned isolated restored copy. `--agent <id>` defaults
to the default identity for the restored session.

## Proof boundary

`test/docs/cli-reference.test.ts` proves that every current-source public leaf has exactly one
complete reference record whose usage and purpose match the TypeScript registrar. It also checks
the seven semantic scene leaves, human-authority boundary, two JSONL classifications, and the
working-tree/installed/npx order contract. After the final root build, run it with
`TWEAKLOOP_VERIFY_PACKAGED_HELP=1` to require rebuilt package-help parity.

The default structural/source proof does not establish checked-in `dist` parity, daemon-backed
success for every option, published npm availability, npx execution, listener liveness, or human
comprehension. The final build, runtime dogfood matrix, and browser checks are separate release
evidence.
