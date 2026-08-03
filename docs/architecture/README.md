# Tweakloop architecture

**Status:** Authoritative initial architecture
**Audience:** Agent or engineering team implementing Tweakloop
**Design stance:** Rich Hickey-inspired, without selecting technologies merely because Hickey created them

This directory is the authoritative design. Code must comply with it; deviations require updating these documents (and the relevant ADR in [`../adr/`](../adr/)) first.

## Chapters

Read in order:

| Chapter | Covers |
|---|---|
| [01-overview.md](01-overview.md) | Executive decision, product boundary, system topology, process model |
| [02-design-laws.md](02-design-laws.md) | The non-negotiable design laws (normative) |
| [03-information-model.md](03-information-model.md) | Principal entities, event vocabulary, ephemeral vs durable state |
| [04-commands-and-transactions.md](04-commands-and-transactions.md) | Command envelope, pure decision boundary, serialized writer |
| [05-storage.md](05-storage.md) | SQLite fact log, content-addressed object store, driver choice |
| [06-artifacts.md](06-artifacts.md) | Artifact vs file, revision manifests, immutable presentation, branching, adapters |
| [07-semantic-identity.md](07-semantic-identity.md) | Stable semantic IDs, anchor records, re-anchoring, Markdown identity |
| [08-intents-and-work.md](08-intents-and-work.md) | Typed intents, review batches, approval, work items, claims and leases |
| [09-agent-cli.md](09-agent-cli.md) | Agent CLI contract and machine output requirements |
| [10-browser.md](10-browser.md) | Two origins, iframe sandbox, MessageChannel bridge, interaction modes |
| [11-realtime-and-http.md](11-realtime-and-http.md) | SSE, projections, HTTP surface, browser authentication and security |
| [12-diff-evidence-verification.md](12-diff-evidence-verification.md) | Semantic diff, results, evidence, verification |
| [13-technology.md](13-technology.md) | Technology selection, domain coding constraints, source layout, dependency direction |
| [14-failure-and-testing.md](14-failure-and-testing.md) | Failure/recovery behavior, testing strategy, the 20 architecture invariants |
| [15-roadmap.md](15-roadmap.md) | Rejected designs, v0.1 vertical slice, implementation phases, build discipline |
| [16-implementation-status.md](16-implementation-status.md) | The verified docs ↔ code map: what is implemented, partial, or designed-only, plus declared deviations |

Section numbers referenced throughout (e.g. "section 7.2") are the original authoritative document's numbering, preserved inside each chapter.
