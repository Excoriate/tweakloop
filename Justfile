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

# run the full test suite once
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

# everything CI runs: build, tests, lint
check: build test lint

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
