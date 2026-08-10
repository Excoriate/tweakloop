---
title: Authoring HTML and Markdown
description: Load for semantic HTML or Markdown authoring, anchor preservation, scaffolding, lint, diff, and rendered checks.
---

# Authoring HTML and Markdown

Load this reference only when authoring or structurally changing HTML/Markdown, using the plan
starter, preserving semantic anchors/kinds, or running `lint`, `diff`, or `check`. Mere opening of
an already-ready artifact does not need it. Workspace recovery does not belong here.

## Authoring contract

For a plan, design, proposal, or decision document, begin with
[`../assets/minimal-plan-starter.html`](../assets/minimal-plan-starter.html). Replace every
`[[PLACEHOLDER]]`, delete sections that do not earn their space, and add domain-specific content.
For Markdown, heading slugs are anchors, so keep reviewed heading text stable.

Every reviewable HTML section needs stable semantic identity:

```html
<section data-tweak-id="decision.auth-model" data-tweak-kind="decision"
         aria-labelledby="auth-model-title">
  <h2 id="auth-model-title">Authentication model</h2>
</section>
```

- `data-tweak-id` describes meaning, never presentation: `plan.phase.testing`,
  `decision.auth-model`, `requirement.rate-limits`; never `div-3` or `left-card`.
- Preserve IDs across revisions. A possible rename is remove+add until a human authorizes identity
  transfer; never silently rename a protected/commented anchor.
- `data-tweak-kind` is an open classification hint, not identity. Useful values include
  `document-identity`, `decision`, `question`, `requirement`, `success-criteria`, `ordered-plan`,
  `plan-phase`, `implementation-detail`, `alternative-analysis`, `risk-set`, `review-guidance`,
  `heading`, and `paragraph`. Unknown valid kinds remain valid.
- Optionally use `data-tweak-source="docs/plan.md#section"` for repository provenance.

## Reading-quality contract

- Put title, one-sentence purpose, status, requested decision, and next step on the first screen.
- Keep prose readable (roughly 60–75 characters), hierarchy obvious, and sections single-purpose.
- Keep recommendation, scope, risks, and next actions visible. Put transcripts, matrices,
  alternatives, and implementation depth in native `<details>`; never hide a blocking fact.
- Prefer semantic HTML, links, tables, and `<details>` over custom JavaScript, animation, navigation
  chrome, or dashboard widgets. Use no CDN, remote font, tracking, or network dependency.
- Remain readable at 360 px and wide widths without page-level horizontal overflow. Give wide
  tables their own scroll area; preserve keyboard focus, contrast, labels beyond color,
  `prefers-reduced-motion`, and print styles.

## Validate before publication

After drafting and before publishing:

```bash
tweak lint <file> --json
tweak diff <file> --json
tweak check <file> --json
```

`lint` and `diff` must expose removed/protected anchors and kind changes. Unknown protected-anchor
state blocks publication. For an exact unregistered path, `diff` uses an explicit empty baseline:
`artifactId` and `beforeRevisionId` are null and every semantic node is added. An explicit unknown
`--artifact` still fails; never reinterpret a claimed durable identity as a new document. `check`
is the browser truth surface; if its packaged browser is
unavailable, report the block rather than treating syntax as rendered success. Also search for
unreplaced `[[...]]` and verify narrow/wide rendering. A valid but clipped, network-dependent, or
unscannable document is not ready.

Whiteboard requests route to [`../../excalidraw/SKILL.md`](../../excalidraw/SKILL.md); do not embed
its authoring or compare-and-swap protocol here.
