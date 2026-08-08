#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-/Applications/Verboo Code.app}"
CLEAR_QUARANTINE="false"
FAILURES=0
WARNINGS=0

for arg in "$@"; do
  case "$arg" in
    --clear-quarantine)
      CLEAR_QUARANTINE="true"
      ;;
  esac
done

print_pass() {
  printf 'PASS  %s\n' "$1"
}

print_warn() {
  WARNINGS=$((WARNINGS + 1))
  printf 'WARN  %s\n' "$1"
}

print_fail() {
  FAILURES=$((FAILURES + 1))
  printf 'FAIL  %s\n' "$1"
}

if [[ "$(uname -s)" == "Darwin" ]]; then
  print_pass "macOS detected: $(sw_vers -productVersion)"
else
  print_fail "This build supports macOS only."
fi

if [[ "$(uname -m)" == "arm64" ]]; then
  print_pass "Apple Silicon arm64 detected."
else
  print_fail "This package is Apple Silicon arm64 only."
fi

MACOS_MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [[ "$MACOS_MAJOR" =~ ^[0-9]+$ ]] && (( MACOS_MAJOR >= 12 )); then
  print_pass "macOS version is supported."
else
  print_fail "macOS 12.0 or newer is required."
fi

if [[ -d "$APP_PATH" ]]; then
  print_pass "App bundle found: $APP_PATH"
else
  print_fail "App bundle not found: $APP_PATH"
fi

APP_BINARY="$APP_PATH/Contents/MacOS/verboo-desktop"
if [[ -x "$APP_BINARY" ]]; then
  print_pass "App executable found."
  if file "$APP_BINARY" | grep -q 'arm64'; then
    print_pass "App executable contains arm64 code."
  else
    print_fail "App executable is not arm64."
  fi
else
  print_fail "App executable not found or not executable."
fi

# Node belongs to the app bundle. The signed CLI is intentionally absent from
# the bundle and is installed under app-data after its upstream manifest and
# archive digest are verified.
NODE_PATH="$APP_PATH/Contents/MacOS/verboo-node"
if [[ -x "$NODE_PATH" ]]; then
  print_pass "Embedded Node runtime found: $NODE_PATH"
  NODE_CONTRACT="$("$NODE_PATH" -p '`${process.versions.node}/${process.versions.modules}/${process.versions.napi}`' 2>&1)"
  if [[ "$NODE_CONTRACT" == "24.19.0/137/10" ]]; then
    print_pass "Embedded Node runtime contract: $NODE_CONTRACT"
  else
    print_fail "Embedded Node runtime contract mismatch: $NODE_CONTRACT"
  fi
else
  print_fail "Embedded Node runtime not found: $NODE_PATH"
fi

if find "$APP_PATH/Contents/Resources" -path '*cli-package*' -print -quit 2>/dev/null | grep -q .; then
  print_fail "The app bundle still contains the obsolete cli-package resource."
else
  print_pass "App bundle contains no CLI payload."
fi

if /usr/bin/xattr -p com.apple.quarantine "$APP_PATH" >/dev/null 2>&1; then
  if [[ "$CLEAR_QUARANTINE" == "true" ]]; then
    /usr/bin/xattr -dr com.apple.quarantine "$APP_PATH"
    print_pass "Quarantine attribute removed for trusted internal build."
  else
    print_warn "Quarantine is present. Use --clear-quarantine only for trusted internal builds."
  fi
else
  print_pass "No quarantine attribute found."
fi

if /usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH" >/dev/null 2>&1; then
  print_pass "Code signature verification passed."
else
  print_warn "Code signature verification failed or app is ad-hoc signed. Notarization is required for public distribution."
fi

if /usr/sbin/spctl --assess --type execute -vv "$APP_PATH" >/dev/null 2>&1; then
  print_pass "Gatekeeper assessment passed."
else
  print_warn "Gatekeeper assessment did not pass. Unsigned/internal builds can be blocked on another Mac."
fi

if /usr/bin/git --version >/dev/null 2>&1; then
  print_pass "$(/usr/bin/git --version)"
else
  print_warn "Git is not available. Repository-aware tasks may be limited."
fi

if /usr/bin/xcode-select -p >/dev/null 2>&1; then
  print_pass "Apple Command Line Tools path: $(/usr/bin/xcode-select -p)"
else
  print_warn "Apple Command Line Tools are not installed. Build/git tasks may be limited."
fi

if command -v verboo >/dev/null 2>&1; then
  print_pass "Global Verboo CLI is present and remains untouched: $(command -v verboo)"
else
  print_pass "Global Verboo CLI is absent; the app manages its signed CLI under app-data."
fi

printf '\nSummary: %s failure(s), %s warning(s).\n' "$FAILURES" "$WARNINGS"
if (( FAILURES > 0 )); then
  exit 1
fi
