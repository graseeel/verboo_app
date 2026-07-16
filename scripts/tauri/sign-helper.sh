#!/usr/bin/env bash
# Sign computer-use-helper. No secrets in-repo — identity from env.
set -euo pipefail

usage() {
  echo "Usage: $0 --dev [path] | --release <path>" >&2
  exit 1
}

mode="${1:-}"
path="${2:-}"

case "$mode" in
  --dev)
    if [[ -z "$path" ]]; then
      # Default: first matching binary under src-tauri/binaries
      root="$(cd "$(dirname "$0")/../.." && pwd)"
      path="$(ls "$root"/src-tauri/binaries/computer-use-helper-* 2>/dev/null | head -1 || true)"
    fi
    [[ -n "$path" && -e "$path" ]] || { echo "helper or agent not found" >&2; exit 1; }
    codesign --force --deep --sign - --timestamp=none "$path"
    echo "ad-hoc signed: $path"
    ;;
  --release)
    [[ -n "$path" && -e "$path" ]] || usage
    identity="${MACOS_CODESIGN_IDENTITY:-}"
    [[ -n "$identity" ]] || { echo "Set MACOS_CODESIGN_IDENTITY" >&2; exit 1; }
    codesign --force --deep --options runtime --sign "$identity" --timestamp "$path"
    echo "release signed: $path"
    ;;
  *)
    usage
    ;;
esac
