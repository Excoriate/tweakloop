# Tweakloop

A local-first information system for human–agent artifact iteration. Immutable revisions, typed human intent, durable agent work, verification evidence. The authoritative design lives in docs/architecture/ — code must comply with it; read docs/design-principles.md and docs/ubiquitous-language.md before modeling anything new.

## Commands

The Justfile is the single DX entry point (`just` lists recipes):

- `just install` / `just build` / `just test` / `just lint` — pnpm + tsc + vitest + biome
- `just check` — build, tests, lint (what CI runs)
- `just dev` — run the workspace daemon in the foreground
- `just open examples/plan.html` — register an artifact and open the review shell
- `just status` / `just stop` / `just events` — daemon lifecycle and event log

## Layout (single package; see docs/architecture/13-technology.md)

- `src/domain/` — pure decision core: `decide()`, `evolve()`, event/command values. No I/O, no classes, no clocks, no random IDs — those arrive as inputs. Never import storage/daemon/http here.
- `src/protocol/` — versioned public schemas (JSON Schema) + ajv validation. Protocols are data.
- `src/storage/sqlite/` — better-sqlite3 fact log (STRICT tables), migrations, idempotency receipts. Only the daemon transactor writes.
- `src/daemon/` — serialized transactor, projections, runtime discovery (state dir + runtime.json), two-origin HTTP (shell + artifact), SSE event stream.
- `src/cli/` — `tweak` bin; thin daemon client, machine-readable `--json` output on stdout, diagnostics on stderr.
- `web/shell/` — trusted review shell (static, no build step in Phase 0).
- `test/` — vitest; mirrors src/ structure.
- `docs/` — PRD, design principles, ubiquitous language, architecture chapters, ADRs.

## Invariants (never violate; full list in docs/architecture/14-failure-and-testing.md)

- The events table is append-only; revisions and evidence are immutable values. Supersede, never rewrite.
- Every durable mutation goes through one command envelope → the transactor → one immediate transaction. No other writer touches SQLite.
- Retried idempotency keys must return the original receipt, never duplicate effects.
- Current state is derived: projections (p_* tables) must be rebuildable from the event log; reducers are deterministic.
- Ordering comes from the database seq, never wall-clock time.
- Status dimensions stay orthogonal — no braided status enums.
- The daemon binds loopback only; artifact origin has no mutation routes and no shell credentials.
- ESM with NodeNext resolution: relative imports need explicit `.js` extensions.
