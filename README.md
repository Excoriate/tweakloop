# Tweakloop

> **Shape agent work. See what changed. Ship what you approved.**

![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)
![Node: >=24](https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg)
![Status: Phase 0](https://img.shields.io/badge/status-phase_0-orange.svg)

Tweakloop is a **local-first control plane for human–agent artifact iteration** — an agent-native artifact IDE. Your coding agents produce plans, architectures, and documents; you review **immutable revisions** in a browser shell, express **typed intent** instead of re-typing prompts, and agents claim that work durably and return **versioned evidence**. Nothing is lost when a tab closes, a daemon restarts, or an agent crashes.

---

## Why Tweakloop?

Most agent-review tools are *session-oriented*: one mutable HTML file, one browser session, free-form prompts — and when the loop breaks, your feedback, history, and approvals evaporate with it.

Tweakloop is *workflow-oriented*. Its fundamental unit is:

> **a versioned artifact contract + structured human intent + durable agent execution + verification evidence**

| Session-oriented review | Tweakloop |
|---|---|
| One mutable HTML file | Immutable, replayable revisions |
| Free-form prompt feedback | Typed intents (`replace`, `constrain`, `approve`, …) |
| Agent long-polls a browser session | Agents claim durable work with leases |
| "The agent says it's done" | Evidence, verification, and explicit human acceptance |
| State dies with the session | Append-only fact log; every projection is rebuildable |

Inspired by (and grateful to) [lavish-axi](https://github.com/kunchenguid/lavish-axi) — Tweakloop deliberately builds the missing layer *between* human judgment and agent execution rather than a better annotation overlay.

## The loop

```
        you                                   your agents
         │                                        │
         ▼                                        ▼
 ┌───────────────┐    typed intents      ┌──────────────────┐
 │  review shell │ ────────────────────▶ │  claim work      │
 │  (browser)    │                       │  (lease, resume) │
 └───────┬───────┘                       └────────┬─────────┘
         │              ┌──────────┐              │
         └─────────────▶│ event    │◀─────────────┘
        approve/reopen  │ log      │   new revision + evidence
                        │ (SQLite) │
                        └────┬─────┘
                             │  SSE
                             ▼
                  every state is derived,
                  ordered, and replayable
```

One daemon per workspace owns an append-only SQLite fact log. Humans and agents are both just actors submitting **command envelopes**; committed events stream back to every observer. Kill any process — browser, CLI, agent, daemon — and the workflow truth survives.

## Quickstart

**Prerequisites:** [Node.js ≥ 24](https://nodejs.org), [pnpm](https://pnpm.io), [just](https://github.com/casey/just)

```bash
git clone <this-repo> && cd tweakloop
just install        # pnpm install
just check          # build + tests + lint
just open examples/plan.html
```

`just open` starts the workspace daemon (if needed), registers the artifact as a durable identity, and prints a **one-time bootstrap URL** that opens the authenticated review shell in your browser.

Day-to-day:

```bash
just dev            # run the daemon in the foreground
just status         # daemon health + workspace projections
just events         # inspect the committed event log
just stop           # stop this workspace's daemon
```

Prefer the raw CLI? Everything is also available as `tweak` (or `node dist/cli/index.js` / `pnpm tweak` before it's linked):

```bash
tweak init                          # project identity (.tweakloop/project.json)
tweak open examples/plan.html       # register + open (add --no-browser to just print the URL)
tweak status --json                 # machine-readable output on stdout
tweak artifacts list
tweak events list --after 0
tweak daemon start --foreground
tweak daemon stop
```

Every command supports `--json` — one documented JSON value on stdout, diagnostics on stderr. Agents integrate through this CLI protocol; there are no agent-specific code paths.

## Status: Phase 0 (honest edition)

This is the **architecture skeleton** — deliberately small, deliberately solid. What works today:

- ✅ One daemon per workspace: runtime discovery, dynamic loopback ports, health + start-nonce
- ✅ Append-only **SQLite fact log** (STRICT tables, WAL) behind a single serialized transactor
- ✅ **Command envelopes** with JSON Schema validation, idempotency receipts, optimistic stream versions
- ✅ Pure domain core (`decide`/`evolve`) with zero I/O — fully table-testable
- ✅ Rebuildable **projections** + live **SSE** event stream
- ✅ Bootstrap-token-authenticated **browser shell** (artifact catalog, live timeline)
- ✅ `tweak` CLI with machine-readable output

What's designed but not yet built (see [docs/architecture/](docs/architecture/)):

| Phase | Delivers | Status |
|---|---|---|
| 0 — Skeleton | Fact log, transactor, projections, daemon, CLI, shell | ✅ done |
| 1 — Immutable revisions | Content-addressed store, revision manifests, isolated artifact origin | 🔜 next |
| 2 — Semantic feedback | Bridge, interaction modes, typed intents, anchors, orphan detection | 📐 designed |
| 3 — Agent work protocol | Atomic claims, leases, `tweak work claim --wait`, results | 📐 designed |
| 4 — Diff, evidence, decisions | Semantic diff, evidence objects, accept/reopen, timeline | 📐 designed |
| 5 — Markdown + OSS hardening | Source-mapped Markdown adapter, agent skills, installers | 📐 designed |

## Design principles

The architecture is [Rich Hickey-inspired](docs/design-principles.md), without the cargo cult:

- **Values over mutable places** — revisions, intents, and evidence are immutable facts; supersede, never rewrite
- **Current state is derived** — every projection rebuilds from the event log, deterministically
- **Identity is not location** — file paths, DOM selectors, ports, and PIDs are locators, not identities
- **Effects at the edges** — the domain core touches no filesystem, network, clock, or randomness
- **Agents are external actors** — any process that can invoke a stable CLI can participate

The full, normative design lives in [docs/architecture/](docs/architecture/) — fifteen readable chapters, cross-checked against this codebase.

## Documentation

| | |
|---|---|
| [docs/README.md](docs/README.md) | Documentation index and reading order |
| [docs/product-vision.md](docs/product-vision.md) | Why Tweakloop exists, and what would falsify it |
| [docs/prd.md](docs/prd.md) | Product requirements and the v0.1 vertical slice |
| [docs/design-principles.md](docs/design-principles.md) | The non-negotiable design laws |
| [docs/ubiquitous-language.md](docs/ubiquitous-language.md) | The shared vocabulary (DDD) |
| [docs/architecture/](docs/architecture/) | The authoritative architecture, chapter by chapter |
| [docs/adr/](docs/adr/) | Architecture decision records |

## Contributing

Early days — issues and PRs welcome. The bar: `just check` must pass, and changes must respect the [design laws](docs/architecture/02-design-laws.md). If a change contradicts the architecture docs, the docs get amended first (or the change is wrong).

## License

[MIT](LICENSE)
