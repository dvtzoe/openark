#!/usr/bin/env bash
# Enforce the 999-line cap on authored files. LICENSE (canonical text),
# build output, and dependencies are exempt.
set -euo pipefail
cd "$(dirname "$0")/.."

cap=999
fail=0

while IFS= read -r f; do
  lines=$(wc -l < "$f")
  if (( lines > cap )); then
    echo "FAIL: $f has $lines lines (cap $cap)"
    fail=1
  fi
done < <(find . -type f \
  -not -path './.git/*' \
  -not -path './plugin/node_modules/*' \
  -not -path './plugin/dist/*' \
  -not -path './plugin/coverage/*' \
  -not -path './service/.venv/*' \
  -not -path './service/.pytest_cache/*' \
  -not -path './service/.ruff_cache/*' \
  -not -path '*/__pycache__/*' \
  -not -name 'LICENSE' \
  -not -name 'bun.lock' \
  -not -name 'uv.lock' \
  -not -path './plugin/src/generated/*')

if (( fail )); then
  echo "File size cap exceeded. Split the file(s) listed above."
  exit 1
fi
echo "OK: all authored files are <= $cap lines."
