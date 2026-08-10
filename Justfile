# Tweakloop developer commands — the single centralized entry point.
# Run `just` to list everything.

set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# install dependencies (pnpm, Node >= 24)
install:
    pnpm install

# compile TypeScript to dist/
build:
    pnpm build

# run the public product/OSS test suite once
test:
    pnpm test

# run tests in watch mode
test-watch:
    pnpm test:watch

# lint and format checks (biome)
lint:
    pnpm lint

# apply formatting
format:
    pnpm format

# browser end-to-end tests (Playwright)
e2e: build
    pnpm e2e

# everything CI runs: build, OSS guide/skill/hook projection parity, product tests, lint
check: build check-guides check-skills check-hooks test lint

# run the workspace daemon in the foreground (logs to stderr)
dev: build
    node dist/cli/index.js daemon start --foreground

# register an artifact and open the review shell, e.g. `just open examples/plan.html`
open path: build
    node dist/cli/index.js open {{path}}

# report daemon health and workspace projections
status: build
    node dist/cli/index.js status

# stop this workspace's daemon
stop: build
    node dist/cli/index.js daemon stop

# print committed events, e.g. `just events 0`
events after="0": build
    node dist/cli/index.js events list --after {{after}}

# remove build output
clean:
    rm -rf dist

# replace root agent-guide consumers from the canonical product-owned guide
sync-guides:
    node scripts/sync-guides.mjs

# verify root agent-guide consumers without contributor-specific tooling
check-guides:
    node scripts/sync-guides.mjs --check

# replace repository-local discovery copies from the complete canonical skills
sync-skills:
    node scripts/sync-skills.mjs

# verify OSS skill projections without requiring or mutating the optional private harness
check-skills:
    node scripts/sync-skills.mjs --check

# replace the package-facing public native-hook projection from its canonical source
sync-hooks:
    node scripts/sync-hooks.mjs

# verify public native-hook projection parity without activating any native client config
check-hooks:
    node scripts/sync-hooks.mjs --check
