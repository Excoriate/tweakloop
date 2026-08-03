# Diff, results, evidence and verification

Covers sections 19 and 20 of the authoritative architecture. Back to the [index](README.md).

## 19. Diff architecture

### 19.1 Diff meaning, not generated noise

Raw HTML source diffs are secondary.

Primary diff layers:

1. Semantic-node diff.
2. Rendered visible-text diff.
3. Source-file diff when source mappings exist.
4. Raw artifact diff as an advanced fallback.

### 19.2 Semantic index

Normalize each revision into nodes:

```json
{
  "id": "architecture.data-storage",
  "kind": "architecture-component",
  "parentId": "architecture",
  "order": 4,
  "label": "Data storage",
  "textDigest": "sha256:...",
  "structureDigest": "sha256:...",
  "sourceRefs": [
    {
      "path": "docs/architecture.md",
      "startLine": 84,
      "endLine": 103
    }
  ]
}
```

A semantic diff reports:

- added;
- removed;
- changed;
- moved;
- unchanged;
- identity collision;
- unaddressable.

Do not treat regenerated CSS class names as meaningful change.

### 19.3 Approved-node change detection

When a node was approved, record:

- artifact ID;
- revision ID;
- semantic ID;
- text and structure digests.

A later revision changing either digest should visibly mark:

```text
Approved content changed
```

It must not silently revoke or transfer the approval.

## 20. Results, evidence and verification

### 20.1 Result is not proof

An agent result records:

- what the agent believes it changed;
- which intents it addressed;
- new revision IDs;
- repository paths changed;
- known limitations;
- remaining uncertainty.

It does not automatically satisfy verification.

### 20.2 Evidence

Evidence is immutable and content-addressed.

Initial evidence types:

| Type | Example |
|---|---|
| Command execution | Test command, exit code and output |
| Git diff | Patch or commit range |
| Screenshot | Before or after render |
| Browser assertion | DOM or interaction check |
| Terraform result | Plan output |
| Policy result | OPA or validation result |
| Agent explanation | Bounded rationale |
| Manual observation | Human-recorded evidence |

Evidence envelope:

```json
{
  "$schema": "https://tweakloop.dev/schemas/evidence/command/v1.json",
  "evidenceId": "evidence_...",
  "producer": {
    "kind": "agent",
    "id": "codex",
    "runId": "run_..."
  },
  "subject": {
    "workId": "work_...",
    "revisionId": "rev_..."
  },
  "command": "pnpm test",
  "exitCode": 0,
  "stdoutHash": "sha256:...",
  "stderrHash": "sha256:...",
  "gitHead": "abc123...",
  "recordedAt": "2026-08-03T13:35:00Z"
}
```

### 20.3 Verification

A verification record says whether specified evidence satisfies a requirement.

Verification is separate from human acceptance.

Examples:

- automated tests passed, but human rejected the UX;
- automated verification failed, but the human accepted a documentation-only draft;
- agent reports completion, but no evidence exists;
- evidence applies to an older Git commit and is stale.

### 20.4 No daemon shell runner in v0.1

The daemon must not execute arbitrary verification commands.

The agent harness runs commands and submits evidence.

A future opt-in runner may be introduced behind a separate capability boundary, explicit user authorization, command allowlists, and isolated execution.

Do not make local remote-code execution part of the initial trusted computing base.
