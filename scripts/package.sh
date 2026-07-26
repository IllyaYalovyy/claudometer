#!/usr/bin/env bash
# Build the installable release zip for Claudometer.
#
# - Refuses to pack unless ./scripts/quality.sh passes.
# - Reads the version from src/metadata.json ("version-name", the single
#   source of truth) and names the artifact after it.
# - Bundles every file under src/. The schema ships as XML only:
#   `gnome-extensions install` compiles gschemas.compiled at install time
#   (verified on GNOME Shell 49).
#
# Output: dist/claudometer-v<version>.shell-extension.zip
set -euo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "${repo_root}"

for tool in gnome-extensions python3; do
    if ! command -v "${tool}" >/dev/null 2>&1; then
        echo "FAIL: ${tool} not found; cannot build the package" >&2
        exit 1
    fi
done

echo "==> Running the quality gate (packaging refuses on red)"
if ! ./scripts/quality.sh; then
    echo "FAIL: quality gate is red; refusing to pack" >&2
    exit 1
fi

read -r uuid version < <(python3 - <<'PY'
import json
meta = json.load(open("src/metadata.json"))
print(meta["uuid"], meta["version-name"])
PY
)

# gnome-extensions pack only bundles extension.js, prefs.js, metadata.json,
# stylesheet.css, and schemas/ on its own; pass everything else in src/ as
# --extra-source so a new source file can never be silently left out.
pack_defaults=(extension.js prefs.js metadata.json stylesheet.css schemas)
extra_args=()
for entry in src/*; do
    name=$(basename "${entry}")
    is_default=false
    for default in "${pack_defaults[@]}"; do
        if [[ ${name} == "${default}" ]]; then
            is_default=true
            break
        fi
    done
    if ! ${is_default}; then
        extra_args+=("--extra-source=${name}")
    fi
done

mkdir -p dist
echo "==> Packing ${uuid} v${version}"
gnome-extensions pack src --force --out-dir=dist "${extra_args[@]}"

artifact="dist/claudometer-v${version}.shell-extension.zip"
mv -f "dist/${uuid}.shell-extension.zip" "${artifact}"

echo "==> Verifying zip contents against src/"
python3 - "${artifact}" <<'PY'
import sys
import zipfile
from pathlib import Path

artifact = sys.argv[1]
with zipfile.ZipFile(artifact) as zf:
    packed = {name for name in zf.namelist() if not name.endswith("/")}

# gschemas.compiled is a local build artifact; the installed copy is
# compiled from the XML by `gnome-extensions install`.
expected = {
    str(path.relative_to("src"))
    for path in Path("src").rglob("*")
    if path.is_file() and path.name != "gschemas.compiled"
}
missing = sorted(expected - packed)
if missing:
    sys.exit(f"FAIL: {artifact} is missing source files: {missing}")
print(f"zip contents: OK ({len(packed)} files)")
PY

echo "==> Built ${artifact}"
echo "Install with: gnome-extensions install --force ${artifact}"
