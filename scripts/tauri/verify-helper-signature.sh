#!/usr/bin/env bash
# Verify computer-use-helper codesign. Exit non-zero if invalid.
set -euo pipefail
path="${1:-}"
[[ -n "$path" && -f "$path" ]] || { echo "Usage: $0 <helper-path>" >&2; exit 1; }

codesign --verify --verbose=2 "$path"
codesign -dv --verbose=4 "$path" 2>&1 | tee /tmp/cu-helper-codesign.txt

if [[ "${REQUIRE_RELEASE_SIGN:-0}" == "1" ]]; then
  if grep -q "Signature=adhoc" /tmp/cu-helper-codesign.txt; then
    echo "REFUSE: ad-hoc signature not allowed when REQUIRE_RELEASE_SIGN=1" >&2
    exit 2
  fi
fi
echo "OK: $path"
