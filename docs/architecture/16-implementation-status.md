# 16 — Implementation status (docs ↔ code cross-check)

**Purpose:** the verified map between this architecture and the codebase, so features can be built on top with confidence. Updated whenever code lands.
**Last cross-checked:** Phase 0 completion (initial commit).

## Phase 0 exit condition — met

> One test command creates one event and rebuildable projection.

`artifact.register` flows through envelope validation → the pure `decide()` → one immediate transaction appending to `events` → `p_artifacts`/`p_timeline` projections → SSE publish. `test/daemon/transactor.test.ts` proves commit, idempotent retry, rejection-without-effects, version conflict, and rebuild equality. The daemon starts, serves the authenticated shell, and survives restart with full history (event log in the workspace state directory).

## Chapter-by-chapter status

| Chapter | Status | Code |
|---|---|---|
| 01 Overview — one daemon per workspace, runtime discovery, startup lock, loopback only | ✅ Implemented | `src/daemon/runtime.ts`, `src/cli/daemon-client.ts`, `src/daemon/index.ts` |
| 02 Design laws | ✅ Enforced in Phase 0 code | See "Law compliance" below |
| 03 Information model — events as facts; `workspace.opened`, `artifact.registered` only | 🟡 Partial (Phase 0 vocabulary) | `src/domain/events.ts` |
| 04 Commands & transactions — envelope, idempotency receipts, expected stream version, pure `decide`/`evolve`, 11-step transactor | ✅ Implemented | `src/protocol/envelopes.ts`, `src/protocol/validation.ts`, `src/domain/`, `src/daemon/transactor.ts` |
| 05 Storage — STRICT `events`/`command_receipts`/`blobs` schema, WAL, better-sqlite3 behind a narrow port | ✅ Implemented (`blobs` unused until Phase 1) | `src/storage/sqlite/` — object store not yet built |
| 06 Artifacts — immutable revisions, manifests, content-addressed store | 📐 Designed only (Phase 1) | Artifacts today are registered identities with a `sourcePath` locator; no revision snapshots yet |
| 07 Semantic identity — anchors, re-anchoring, orphaning | 📐 Designed only (Phase 2) | — |
| 08 Intents & work — typed intents, review batches, claims, leases | 📐 Designed only (Phases 2–3) | — |
| 09 Agent CLI — machine output discipline, `--json`, stdout/stderr split, stable protocols | ✅ Implemented for Phase 0 commands | `src/cli/index.ts`, `src/cli/output.ts` — `tweak init/open/status/artifacts list/daemon start\|stop/events list/repair` (`publish`, `work *`, `evidence add`, `revision show`, `protocol describe` arrive with their phases) |
| 10 Browser — two origins, sandboxed iframe, bridge | 🟡 Partial | Both loopback origins run (`src/daemon/http.ts`); the artifact origin serves only `/health` until Phase 1 revisions; iframe + `MessageChannel` bridge are Phase 2 |
| 11 Realtime & HTTP — POST commands + SSE with seq ids, snapshot, projections, bootstrap auth | ✅ Implemented | `src/daemon/http.ts`, `src/daemon/event-stream.ts`, `src/daemon/projections.ts`, `web/shell/` |
| 12 Diff, evidence, verification | 📐 Designed only (Phase 4) | — |
| 13 Technology — TypeScript, better-sqlite3, native `node:http`, JSON Schema (ajv), pnpm, domain purity | ✅ Implemented | Whole tree; domain constraints verified below |
| 14 Failure & testing | 🟡 Partial | Domain tables, replay/rebuild, transactor, HTTP auth tests exist (`test/`); property, crash, and Playwright browser-security suites are owed as Phases 1–2 land |
| 15 Roadmap | — | This file tracks it |

## Design-law compliance (verified against code)

- **Values over mutable places** — `events` is append-only; no `UPDATE`/`DELETE` targets it anywhere in `src/`. Projections (`p_*`) are the only mutable tables, and `tweak repair --rebuild-projections` rebuilds them from facts (`src/daemon/projections.ts`).
- **Identity is not location** — artifacts have `artifact_<uuid>` identities with `sourcePath` stored as a locator; the workspace id is a stable local handle; ports/PIDs live only in the ephemeral `runtime.json`.
- **Ordering is not wall-clock** — `seq` (database autoincrement) orders everything: SSE ids, `--after` replay, projection rebuild. `recordedAt` is metadata.
- **Current state is derived** — the transactor folds `decide`/`evolve` over stored events; `p_*` tables are disposable; the shell renders snapshot + events only.
- **Effects at the edges** — `src/domain/` imports nothing but its own modules; IDs and timestamps enter via `TransactorDeps` (`newEventId`, `now`).
- **Protocols are data** — `tweakloop.command/v1` envelope + per-command payload JSON Schemas in `src/protocol/schemas/`, validated with ajv at the boundary.
- **No silent recovery** — duplicate registrations are explicit rejections (`artifact.already-registered`, `artifact.source-already-registered` with the existing id in `details`); stale expected versions reject with `concurrency.version-conflict`; a dead daemon is detected by start-nonce mismatch, never assumed alive.

## Declared deviations (all additive; none contradict the design)

1. **Flat domain modules.** `src/domain/commands.ts` (etc.) are single files rather than section 24's subdirectories. Boundaries and dependency direction are identical; files split into directories when their contents warrant it (build discipline: no speculative structure).
2. **`runtime.json` carries a `cliToken`.** The runtime descriptor (section 5.2) additionally holds a bearer token, file mode 0600 — filesystem permissions are the local authority that lets the CLI (and agents) call the daemon API. Browser access still requires the one-time bootstrap flow.
3. **Two auxiliary shell routes.** `POST /api/v1/bootstrap-tokens` (CLI-token-gated minting for section 22's bootstrap flow) and `POST /api/v1/shutdown` (backs `tweak daemon stop`). The artifact origin still has zero mutation routes.
4. **Same-origin check instead of a CSRF token.** Cookie-authenticated mutations require exact `Origin` + host-allowlist match — the "equivalent same-origin request token" permitted by section 22.
5. **`GET /api/v1/events` also serves JSON.** With `Accept: text/event-stream` it streams SSE; otherwise it returns the committed events as a JSON array (used by `tweak events list`). Same data, same ordering.
6. **`workspace.opened` is recorded once per workspace**, via the durable idempotency receipt `workspace.open:<workspaceId>` — repeat opens are receipt replays, not new facts.
7. **`Decision` is a result value.** `decide()` returns `{ ok: true, events, response } | { ok: false, code, message, details? }` — rejections are values, not exceptions, which section 7.2's sketch left implicit.
8. **`tweak repair` runs in-process only while the daemon is stopped.** The single-writer rule holds: whichever process runs it is the sole writer at that moment.
9. **Unit tests use vitest** (section 23.1 permits "a similarly minimal runner"). Playwright arrives with the browser bridge.

## What to build next (Phase 1 entry points)

Immutable revisions: content-addressed object store under the workspace state directory (`blobs` table is already migrated), `artifact.revision-published` events, revision manifests, `/r/:revisionId/*` on the artifact origin, and `tweak publish`. See [06-artifacts.md](06-artifacts.md) and [15-roadmap.md](15-roadmap.md).
