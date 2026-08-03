# Overview

Covers sections 1, 2, 4 and 5 of the authoritative architecture. Back to the [index](README.md).

## 1. Executive decision

Build Tweakloop as a **local-first information system for human–agent artifact iteration**, not as an HTML editor with an AI sidebar.

The system must preserve four separate things:

1. The immutable artifact revisions that existed.
2. The human intentions expressed against those revisions.
3. The agent work performed in response.
4. The evidence and decisions that determined whether the work was accepted.

Everything else—browser state, agent presence, queues, dashboards, "current status," selected tabs, live reload—is a projection or an ephemeral convenience.

Lavish currently centers its workflow on a local HTML file, an injected iframe SDK, canonical file-path session identity, local session state, and an agent long-polling for feedback. That is an effective review transport, but Tweakloop must deliberately replace **mutable session state** with **durable workflow facts and immutable revisions**.

The architecture follows several principles associated with *Simple Made Easy*: keep data as data, separate independent dimensions, prefer values and queues over shared mutable actors, and judge the resulting artifact rather than the convenience of the authoring construct.

Do not interpret "simple" as "one process, one file, one table, or fewer modules." Simplicity here means that identity, storage, rendering, workflow, presence, execution, and verification are not braided together.

## 2. Product boundary

Tweakloop is responsible for:

- registering artifacts;
- snapshotting immutable artifact revisions;
- rendering HTML and Markdown revisions;
- identifying semantic targets inside artifacts;
- collecting typed human intentions;
- maintaining revision and decision history;
- offering durable work to external agents;
- receiving agent results and evidence;
- diffing revisions;
- determining what remains unresolved;
- providing a browser review environment.

Tweakloop is **not** initially responsible for:

- executing arbitrary shell commands;
- directly modifying repository files;
- hosting language models;
- orchestrating model prompts internally;
- replacing Git;
- becoming a general workflow engine;
- collaborative document editing;
- cloud synchronization;
- autonomous approval;
- arbitrary plugin execution;
- becoming a WYSIWYG web-design application.

Agents continue to edit repositories through their existing harnesses. Tweakloop communicates **what was requested, what revision it concerns, and what evidence is expected**.

## 4. Recommended system topology

```text
[Tweakloop workspace
  [Repository
    [Canonical Markdown, HTML, code, diagrams, configuration]
    [Git metadata]
  ]
  [Tweakloop daemon
    [Workspace discovery]
    [Command boundary]
    [Single transactor]
    [SQLite fact log]
    [Materialized projections]
    [Content-addressed object store]
    [Artifact ingestion adapters]
    [Semantic indexer and diff engine]
    [File watcher]
    [Browser event stream]
    [Agent work service]
  ]
  [Browser environment
    [Trusted review shell origin]
    [Isolated artifact origin]
    [Artifact bridge]
    [Inspector, diff and feedback panels]
  ]
  [Thin CLI
    [Human commands]
    [Agent commands]
    [Stable machine-readable output]
  ]
  [External agents
    [Claude Code]
    [Codex]
    [OpenCode or OMP]
    [Any process capable of invoking the CLI]
  ]
]
```

All of these may run locally, but they are distinct responsibilities.

## 5. Process model

### 5.1 One daemon per workspace instance

Run one daemon for each Git worktree or explicit non-Git workspace.

The daemon owns:

- the SQLite write connection;
- the workspace runtime lock;
- the event sequence;
- artifact watchers;
- browser listeners;
- agent work claims;
- the artifact rendering server.

CLI processes never open the database directly. They communicate with the daemon.

This gives Tweakloop one serialized authority for local commands without requiring distributed coordination.

### 5.2 Project identity and workspace identity

Maintain two identities:

| Identity | Meaning | Persistence |
|---|---|---|
| `project_id` | Logical project shared across clones or worktrees | `.tweakloop/project.json`, safe to commit |
| `workspace_id` | One local worktree or directory instance | Local state directory |
| `artifact_id` | Logical artifact across revisions | Event store |
| `revision_id` | One immutable occurrence in artifact history | Event store |
| `content_hash` | Identity of exact bytes | Content-addressed store |

A project configuration should initially contain only stable, non-secret metadata:

```json
{
  "$schema": "https://tweakloop.dev/schemas/project/v1.json",
  "projectId": "9ef923b5-13df-4b66-a025-95499169a52d",
  "schemaVersion": 1
}
```

Local workspace state belongs under an OS-appropriate state directory:

```text
$XDG_STATE_HOME/tweakloop/workspaces/<workspace-id>/
```

Equivalent platform-specific locations should be used on macOS and Windows.

Recommended contents:

```text
events.sqlite
objects/
runtime.json
daemon.log
```

`runtime.json` is ephemeral and may contain:

- daemon PID;
- shell port;
- artifact port;
- process start nonce;
- protocol version.

It is not authoritative durable state.

### 5.3 Daemon lifecycle

`tweak open`, `tweak publish`, and other commands perform this sequence:

1. Discover the workspace.
2. Read the runtime descriptor.
3. Verify the daemon health endpoint and process nonce.
4. If unavailable, acquire the workspace startup lock.
5. Start the daemon on two OS-assigned loopback ports.
6. Write the runtime descriptor atomically.
7. Release the startup lock.
8. Send the requested command.

Never assume a fixed port.

Never expose the daemon beyond loopback by default.
