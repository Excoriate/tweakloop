# Tweakloop documentation

The [`architecture/`](architecture/) directory is the **authoritative design**. Code must comply with it; deviations require updating the architecture (and the relevant ADR) first.

## Reading order

1. [product-vision.md](product-vision.md) — why Tweakloop exists: the gap analysis vs session-oriented review tools, structured intent, the revision graph, verification as a first-class concern.
2. [prd.md](prd.md) — problem, users, product definition, the v0.1 vertical slice as acceptance criteria, phased requirements, non-goals, success criteria and falsifier.
3. [design-principles.md](design-principles.md) — the eight design laws, domain coding constraints, dependency direction, and per-feature build discipline in working-summary form.
4. [ubiquitous-language.md](ubiquitous-language.md) — the shared vocabulary (artifact vs file, claim vs lease, verification vs acceptance, event vs command, ...). Use these words exactly, in code and prose.
5. [architecture/](architecture/) — the authoritative design, split into 15 chapters ([architecture/README.md](architecture/README.md) is the chapter index):
   - [01-overview.md](architecture/01-overview.md) · [02-design-laws.md](architecture/02-design-laws.md) · [03-information-model.md](architecture/03-information-model.md) · [04-commands-and-transactions.md](architecture/04-commands-and-transactions.md) · [05-storage.md](architecture/05-storage.md)
   - [06-artifacts.md](architecture/06-artifacts.md) · [07-semantic-identity.md](architecture/07-semantic-identity.md) · [08-intents-and-work.md](architecture/08-intents-and-work.md) · [09-agent-cli.md](architecture/09-agent-cli.md) · [10-browser.md](architecture/10-browser.md)
   - [11-realtime-and-http.md](architecture/11-realtime-and-http.md) · [12-diff-evidence-verification.md](architecture/12-diff-evidence-verification.md) · [13-technology.md](architecture/13-technology.md) · [14-failure-and-testing.md](architecture/14-failure-and-testing.md) · [15-roadmap.md](architecture/15-roadmap.md)
   - [16-implementation-status.md](architecture/16-implementation-status.md) — the verified docs ↔ code map: implemented vs designed-only, with declared deviations
6. [adr/](adr/) — the twelve founding architecture decision records, each with context, decision, alternatives rejected, consequences, falsifier, and migration path:
   - [ADR-001](adr/ADR-001.md) Immutable facts and rebuildable projections · [ADR-002](adr/ADR-002.md) One daemon and serialized transactor per workspace · [ADR-003](adr/ADR-003.md) SQLite plus content-addressed objects · [ADR-004](adr/ADR-004.md) Project/workspace/artifact/revision identity
   - [ADR-005](adr/ADR-005.md) Separate shell and artifact origins · [ADR-006](adr/ADR-006.md) Versioned command/event/bridge schemas · [ADR-007](adr/ADR-007.md) Typed intents with free-form fallback · [ADR-008](adr/ADR-008.md) Durable claims with ephemeral leases
   - [ADR-009](adr/ADR-009.md) Semantic IDs and explicit orphaning · [ADR-010](adr/ADR-010.md) Agent execution outside the daemon · [ADR-011](adr/ADR-011.md) POST commands plus SSE · [ADR-012](adr/ADR-012.md) No CRDT, cloud sync or plugin runtime in v0.1
