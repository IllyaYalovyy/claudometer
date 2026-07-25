#!/usr/bin/env bash
# Run every unit test under tests/unit/ headlessly with `gjs -m`.
# Exits non-zero if any test file fails. See docs/TESTING.md.
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "${repo_root}"

if ! command -v gjs >/dev/null 2>&1; then
    echo "FAIL: gjs not found; unit tests cannot run" >&2
    exit 1
fi

shopt -s nullglob
test_files=(tests/unit/*.test.js)
if [[ ${#test_files[@]} -eq 0 ]]; then
    echo "FAIL: no test files found under tests/unit/" >&2
    exit 1
fi

status=0
for test_file in "${test_files[@]}"; do
    echo "==> ${test_file}"
    gjs -m "${test_file}" || status=1
done

if [[ ${status} -ne 0 ]]; then
    echo "unit tests: FAILED" >&2
else
    echo "unit tests: OK"
fi
exit "${status}"
