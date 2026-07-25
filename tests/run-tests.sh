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
    file_status=0
    output=$(gjs -m "${test_file}" 2>&1) || file_status=1
    printf '%s\n' "${output}"
    # gjs only warns about promise rejections nothing awaited; async code
    # that leaks one is broken even if every assertion passed.
    if grep -qi 'unhandled promise rejection' <<<"${output}"; then
        echo "FAIL: ${test_file}: unhandled promise rejection" >&2
        file_status=1
    fi
    if [[ ${file_status} -ne 0 ]]; then
        status=1
    fi
done

if [[ ${status} -ne 0 ]]; then
    echo "unit tests: FAILED" >&2
else
    echo "unit tests: OK"
fi
exit "${status}"
