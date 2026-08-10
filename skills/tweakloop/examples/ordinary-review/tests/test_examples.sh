#!/usr/bin/env bash
set -euo pipefail

fixture_dir=$(cd "$(dirname "$0")/.." && pwd)
grep -q 'absolute local CLI' "$fixture_dir/README.md"
grep -q 'does not report human acceptance' "$fixture_dir/README.md"
grep -q 'Recorded fixture and observed effect' "$fixture_dir/README.md"
grep -q 'receipt binds `work_plan_12`' "$fixture_dir/README.md"
grep -q 'operator runs the exact returned recovery command' "$fixture_dir/README.md"
