#!/usr/bin/env bash
set -euo pipefail

fixture_dir=$(cd "$(dirname "$0")/.." && pwd)
for operation in node.upsert edge.upsert label.set group.set layout.apply; do
  grep -q "$operation" "$fixture_dir/README.md"
done
for leaf in add-node add-edge set-label group layout inspect publish; do
  grep -q "tweak whiteboard scene $leaf" "$fixture_dir/README.md"
done
grep -q -- '--session <session-id>' "$fixture_dir/README.md"
grep -q -- '--idempotency-key service-topology-' "$fixture_dir/README.md"
grep -q -- '--from browser --to api' "$fixture_dir/README.md"
grep -q -- '--members api database' "$fixture_dir/README.md"
grep -q -- '--direction lr --gap 96' "$fixture_dir/README.md"
test "$(grep -c 'tweak whiteboard scene inspect <document>' "$fixture_dir/README.md")" -eq 3
grep -q 'locked, unlabeled' "$fixture_dir/README.md"
! grep -q 'set-label <document> service-runtime' "$fixture_dir/README.md"
! grep -q -- ' --x ' "$fixture_dir/README.md"
! grep -q -- ' --y ' "$fixture_dir/README.md"
grep -q 'negative control reverses the reads edge' "$fixture_dir/README.md"
grep -q 'server retains' "$fixture_dir/README.md"
