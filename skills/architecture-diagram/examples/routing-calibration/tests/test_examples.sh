#!/usr/bin/env bash
set -euo pipefail

fixture_dir=$(cd "$(dirname "$0")/.." && pwd)
test "$(grep -cE '^[1-5]\. “' "$fixture_dir/README.md")" -eq 10
grep -q '^## Wrong neighbor' "$fixture_dir/README.md"
grep -q 'not an editable' "$fixture_dir/README.md"
grep -q 'only lists `node.upsert`' "$fixture_dir/README.md"
grep -q 'executable leaf commands' "$fixture_dir/README.md"
