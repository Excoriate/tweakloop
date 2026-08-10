#!/usr/bin/env bash
set -euo pipefail

fixture_dir=$(cd "$(dirname "$0")/.." && pwd)
test "$(grep -c '^|' "$fixture_dir/README.md")" -ge 9
grep -q 'reversed-edge control passes' "$fixture_dir/README.md"
grep -q 'transport may not exist' "$fixture_dir/README.md"
grep -q 'operation-name-only impostor' "$fixture_dir/README.md"
