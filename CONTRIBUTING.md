# Contributing to Tweakloop

Thanks for your interest! This project values a small, sharp core over breadth — please read the design docs before proposing structural changes.

## Setup

Requirements: **Node ≥ 24**, **pnpm** (version pinned in `package.json` → `packageManager`), and [`just`](https://github.com/casey/just).

```bash
pnpm install
just check   # build + tests + lint — the same thing CI runs
```

The `Justfile` is the single entry point for every dev task — run `just` to list recipes (`just dev`, `just open examples/plan.html`, `just status`, ...).

## Before you open a PR

1. `just check` must pass.
2. Read [docs/architecture/](docs/architecture/) — it is the **authoritative design**; code must comply with it. Start with [docs/design-principles.md](docs/design-principles.md) and [docs/ubiquitous-language.md](docs/ubiquitous-language.md) (use those terms in code and PRs).
3. Architecture-relevant changes need a matching docs/ADR update in the same PR.

## Non-negotiables (enforced in review)

- **The domain core is pure.** `src/domain/` performs no I/O: no filesystem, network, database, clocks, random IDs, or environment access — those arrive as inputs. No classes, no mutable module state.
- **The events table is append-only.** Facts are never updated or deleted; supersede them with new facts. Projections (`p_*` tables) are disposable and must rebuild deterministically from the log.
- **All durable mutations go through the command envelope → transactor path.** Nothing else writes to SQLite.
- **Protocols are data.** Public envelopes and payloads are versioned JSON Schemas in `src/protocol/schemas/`; evolve them additively.

## Tests

New durable behavior needs: a `decide()` table test, and a projection-replay test where applicable (incremental application must equal full rebuild). Failure-path behavior (idempotent retry, stale versions, crash recovery) is part of the feature, not an afterthought — see [docs/architecture/14-failure-and-testing.md](docs/architecture/14-failure-and-testing.md).
