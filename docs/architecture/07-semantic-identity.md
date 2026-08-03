# Semantic identity and annotation anchoring

Covers section 11 of the authoritative architecture. Back to the [index](README.md).

## 11. Semantic identity and annotation anchoring

### 11.1 Stable semantic IDs

Agent-generated HTML should support:

```html
<section
  data-tweak-id="architecture.data-storage"
  data-tweak-kind="architecture-component"
  data-tweak-source="docs/architecture.md#data-storage"
>
```

Recommended attributes:

| Attribute | Meaning |
|---|---|
| `data-tweak-id` | Stable semantic identity |
| `data-tweak-kind` | Domain-neutral node category |
| `data-tweak-source` | Canonical source reference |
| `data-tweak-interaction` | Interaction policy for the subtree |
| `data-tweak-question` | Stable structured-input identity |

IDs describe meaning, not presentation.

Good:

```text
architecture.data-storage
decision.database-choice
plan.phase.testing
requirement.private-ingress
```

Bad:

```text
left-card-3
blue-box
div-17
row-2
```

### 11.2 Anchor record

An intent target should preserve several independent clues:

```json
{
  "revisionId": "rev_...",
  "semanticId": "architecture.data-storage",
  "sourceRef": {
    "path": "docs/architecture.md",
    "startLine": 84,
    "endLine": 103
  },
  "textQuote": {
    "exact": "PostgreSQL Flexible Server",
    "prefix": "The selected database is ",
    "suffix": " with private networking."
  },
  "domHint": {
    "selector": "[data-tweak-id='architecture.data-storage']"
  },
  "anchorStrength": "strong"
}
```

Geometry is temporary UI metadata, not a durable target.

### 11.3 Re-anchoring order

When presenting an intent against a newer revision, try:

1. exact semantic ID;
2. explicit source reference;
3. uniquely matching text quote with context;
4. normalized structural path;
5. orphan the target.

Never silently attach feedback to a merely similar element.

Record an explicit `artifact.anchor-orphaned` fact when a submitted intent loses its target.

The user can then:

- retarget it;
- dismiss it;
- ask the agent to resolve it;
- keep it as artifact-level feedback.

### 11.4 Markdown identity

For Markdown:

- honor explicit heading IDs;
- generate deterministic IDs from heading ancestry and block role;
- retain parser source positions;
- map rendered elements back to Markdown ranges;
- keep IDs stable when text inside a section changes;
- warn when repeated or ambiguous headings weaken identity.

Do not use a content hash alone as semantic identity; content hashes change precisely when the content changes.
