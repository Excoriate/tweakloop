---
title: Workspace export, restore, and fork
description: Load for versioned workspace export, restore, fork, rebuild, archive, and allowlisted file reconstruction.
---

# Workspace export, restore, and fork

Load this reference for save, export, archive, restore, fork, rebuild, or file reconstruction of a
collaboration workspace. It does not own ordinary session resume or whiteboard authoring.

## Export a bound, retryable boundary

Choose a new destination and one stable operation ID. Preserve that ID and the returned receipt for
exact retry; never invent another ID after uncertain output:

```bash
tweak workspace export <new-directory> --operation <stable-id> --json
```

Export binds immutable heads/history/attachments/events at one exact database-sequence fence. First
publication requires a new destination. An exact retry may find the matching completed bundle and
must return the stable receipt; a changed request or unrelated destination is **BLOCKED**.

To save selected working files as well as collaboration facts, create a versioned JSON policy:

```json
{
  "protocol": "tweakloop.workspace-files/v1",
  "includes": ["src/**", "docs/**", "package.json"],
  "excludes": ["docs/generated/**"],
  "notes": ["Source and authored docs reconstruct this workspace; generated docs rebuild."]
}
```

Then export with the policy:

```bash
tweak workspace export <new-directory> --files-config <policy.json> \
  --operation <stable-id> --json
```

This is an explicit allowlist, not a whole-directory backup. Includes and excludes must be relative.
Traversal, absolute paths, symlinks, and an explicitly named secret-default file are refused.
Broad includes omit secret-default classes such as `.env` and key material with exclusion receipts.
Managed `.tweakloop/**` state is never copied as a working file. Each included file records its
SHA-256, size, and mode; all objects verify before restore places any file.

Collaboration and files have different clocks. Collaboration is `event-seq-exact`. Selected files
are `quiescent-verified`: membership, exclusions, type, device/inode identity, bytes, and mode must
match before copy, after object staging, and immediately before envelope publication. Any change
aborts with no completed destination/receipt; rerun the same operation after the workspace settles.

This is not a kernel-atomic filesystem snapshot or one joint collaboration/filesystem instant. An
ABA change that restores every observed field between observations, or a mutation after the final
observation, is outside the portable guarantee. Bound v1 file bundles require re-export.

## Restore an isolated workspace

```bash
tweak workspace restore <saved-directory> --agent agent:<name> --json
```

Restore verifies the manifest and every object, creates an isolated Tweakloop-owned workspace, and
returns a new session and review URL. It never merges into or overwrites the selected bundle.
Inspect the returned exact artifact/session mapping rather than following ambient/global heads.

## Fork for file reconstruction

When the request is to reconstruct collaboration files into a new working directory while keeping
history:

```bash
tweak workspace fork <bundle-directory> --session <sessionId> \
  --into <new-empty-directory> --agent agent:<name> --json
```

Preflight the exact source bundle, session, scope, destination policy, and collision behavior. A
fork validates the saved-session checkpoint before restoring files. It preserves exact content
hashes, artifact IDs, revision IDs, and ordered artifact/revision/role membership. It mints new
workspace, session, process, event, command, and correlation identities; source identities remain
audit provenance only. The returned `nextCommand` is the exact turn-shaped continuation command.

The destination must be outside the source workspace and unclaimed on first publication. An exact
retry may reuse only its matching journal/generation. A fork is not a silent merge,
checkout, or global-head copy. If any selected file path escapes the declared destination, is a
symlink, fails its hash, or would overwrite existing bytes, stop and report it. Two forks from the
same bundle are independent histories; mutations in either must not appear in the source or sibling.

## Inspect and release retained restore evidence

```bash
tweak workspace restore-inventory --json
tweak workspace restore-compact --kind <restore|fork> --operation <operationId> --json
```

Inventory is read-only. Compact only a completed operation after reviewing its exact ID; a live
matching runtime or corrupt retained DB/CAS/root evidence blocks deletion. Preserve the receipt.
