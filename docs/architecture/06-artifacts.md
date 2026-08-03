# Artifact architecture

Covers sections 9 and 10 of the authoritative architecture. Back to the [index](README.md).

## 9. Artifact architecture

### 9.1 An artifact is not a file

An artifact is a stable logical identity.

A revision is an immutable snapshot containing:

- an entry document;
- referenced assets;
- source metadata;
- semantic-node index;
- producer metadata;
- parent revisions;
- content hashes;
- optional Git context.

A source file is merely one way to produce a revision.

### 9.2 Revision manifest

Every revision receives a generated manifest:

```json
{
  "$schema": "https://tweakloop.dev/schemas/artifact-revision/v1.json",
  "revisionId": "rev_...",
  "artifactId": "artifact_...",
  "parents": ["rev_parent_..."],
  "format": "html",
  "entryPath": "index.html",
  "entryHash": "sha256:...",
  "files": [
    {
      "path": "index.html",
      "hash": "sha256:...",
      "mediaType": "text/html"
    },
    {
      "path": "architecture.css",
      "hash": "sha256:...",
      "mediaType": "text/css"
    }
  ],
  "semanticIndexHash": "sha256:...",
  "producer": {
    "kind": "agent",
    "id": "claude-code",
    "runId": "run_72"
  },
  "source": {
    "workspaceId": "ws_...",
    "paths": ["docs/architecture.html"],
    "git": {
      "head": "abc123...",
      "dirty": true,
      "workingTreeDigest": "sha256:..."
    }
  },
  "createdAt": "2026-08-03T13:20:00Z"
}
```

The CLI generates this. Agents should not normally author it manually.

### 9.3 Immutable presentation

The browser must render the stored revision snapshot, not the mutable live filesystem file.

When the file changes:

1. wait for a short stability window;
2. read all registered files;
3. validate the entry document;
4. calculate hashes;
5. skip publication when the content set is unchanged;
6. create a new revision;
7. link it to the revision the producer used as its parent;
8. notify the browser.

The browser may auto-follow the newest revision, but it must let the human pin a historical revision.

A new revision never replaces the bytes of the revision currently under review.

### 9.4 Branching is valid state

Two agents may publish from the same parent.

That produces two children.

Do not silently linearize them based on arrival time.

The revision graph must support:

- one parent for ordinary iteration;
- multiple children for concurrent alternatives;
- multiple parents for an explicitly resolved merge revision.

Tweakloop does not need to merge arbitrary HTML in v0.1. It needs to represent the branch honestly.

## 10. Artifact adapters

Define an internal adapter protocol:

```ts
type ArtifactAdapter = Readonly<{
  kind: string;
  detect: (input: ArtifactInput) => boolean;
  ingest: (input: ArtifactInput) => Promise<IngestedArtifact>;
  index: (revision: IngestedArtifact) => Promise<SemanticIndex>;
  diff: (
    before: IndexedRevision,
    after: IndexedRevision,
  ) => Promise<SemanticDiff>;
}>;
```

Initial adapters:

| Adapter | Canonical input | Rendered result |
|---|---|---|
| HTML | HTML and sibling assets | Isolated interactive page |
| Markdown | Markdown source | Generated HTML with automatic source mapping |

Do not expose a third-party plugin API until at least two independently implemented external adapters demonstrate the required abstraction.

An internal registry is sufficient for v0.1.
