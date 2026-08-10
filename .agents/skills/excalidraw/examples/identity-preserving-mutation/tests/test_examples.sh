#!/usr/bin/env bash
set -euo pipefail

fixture_dir=$(cd "$(dirname "$0")/.." && pwd)
grep -q 'never constructs an element object' "$fixture_dir/README.md"
grep -q 'target identities intact' "$fixture_dir/README.md"
