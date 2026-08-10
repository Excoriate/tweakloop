# Tweakloop

A local-first information system for human–agent artifact iteration. Immutable revisions, typed human intent, durable agent work, verification evidence. The authoritative design lives in docs/architecture/ — code must comply with it; read docs/design-principles.md and docs/ubiquitous-language.md before modeling anything new.

## Skills

**To use Tweakloop as a product** (publish an artifact for human review, claim and address typed
feedback), follow the canonical `<repo-root>/.agents/skills/tweakloop/SKILL.md`. It is the complete
workflow: author semantic anchors, `tweak open`, `work claim`, revise, `publish`, `work complete`.
`.agents/skills/` is canonical; `skills/` is the installable package projection and
`.claude/skills/` is the Claude projection. Do not edit either projection by hand.

## Commands

The Justfile is the single DX entry point (`just` lists recipes):

- `just install` / `just build` / `just test` / `just lint` — pnpm + tsc + vitest + biome
- `just check` — build, tests, lint (what CI runs)
- `just e2e` — Playwright end-to-end (full review loop in a real browser)
- `just dev` — run the workspace daemon in the foreground
- `just open examples/plan.html` — publish a revision and open the review shell
- `just status` / `just stop` / `just events` — daemon lifecycle and event log

## Layout (single package; see docs/architecture/13-technology.md)

- `src/domain/` — pure decision core: `decide()`, `evolve()`, event/command values. No I/O, no classes, no clocks, no random IDs — those arrive as inputs. Never import storage/daemon/http here.
- `src/protocol/` — versioned public schemas (JSON Schema) + ajv validation. Protocols are data.
- `src/storage/sqlite/` — better-sqlite3 fact log (STRICT tables), migrations, idempotency receipts. Only the daemon transactor writes. `src/storage/object-store/` — content-addressed bytes (sha256), never overwritten.
- `src/artifacts/` — ingestion adapters and projections (HTML, Markdown).
- `src/daemon/` — serialized transactor, projections, runtime discovery (state dir + runtime.json), two-origin HTTP (shell + artifact), SSE event stream.
- `src/cli/` — `tweak` bin; thin daemon client, machine-readable `--json` output on stdout, diagnostics on stderr.
- `web/shell/` — trusted review shell (static, no build step). `web/bridge/` — the sandboxed artifact bridge.
- `test/` — vitest, mirrors src/. `e2e/` — Playwright vertical-slice test.
- `docs/` — PRD, design principles, ubiquitous language, architecture chapters, ADRs. `docs/architecture/16-implementation-status.md` is the verified docs ↔ code map.

## Invariants (never violate; full list in docs/architecture/14-failure-and-testing.md)

- The events table is append-only; revisions and evidence are immutable values. Supersede, never rewrite.
- Every durable mutation goes through one command envelope → the transactor → one immediate transaction. No other writer touches SQLite or the object store.
- Retried idempotency keys must return the original receipt, never duplicate effects.
- Current state is derived: projections (p_* tables) must be rebuildable from the event log; reducers are deterministic.
- Ordering comes from the database seq, never wall-clock time.
- Status dimensions stay orthogonal — no braided status enums.
- The daemon binds loopback only; the artifact origin has no mutation routes and no shell credentials.
- ESM with NodeNext resolution: relative imports need explicit `.js` extensions.
