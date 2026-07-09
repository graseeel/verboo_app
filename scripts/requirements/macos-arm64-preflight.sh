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

# Tauri bundles the CLI as a resource under
# Contents/Resources/resources/cli-package/dist/cli.mjs (copied by
# scripts/verify/copy-cli-resource.mjs at build time). The app spawns it via
# system Node — it does NOT use ELECTRON_RUN_AS_NODE (that was Electron-only).
CLI_PATH="$APP_PATH/Contents/Resources/resources/cli-package/dist/cli.mjs"
if [[ -f "$CLI_PATH" ]]; then
  print_pass "Embedded Verboo CLI entrypoint found: $CLI_PATH"
else
  print_fail "Embedded Verboo CLI not found at expected Tauri resource path: $CLI_PATH"
fi

# Verify the bundled CLI actually runs under system Node. The Tauri app binary
# is Rust, not Electron, so ELECTRON_RUN_AS_NODE does not apply. We require a
# system Node on PATH (the same runtime the app uses at startup).
if [[ -f "$CLI_PATH" ]]; then
  if command -v node >/dev/null 2>&1; then
    if CLI_VERSION="$(node "$CLI_PATH" --version 2>&1)"; then
      print_pass "Embedded Verboo CLI runs: $CLI_VERSION"
    else
      print_fail "Embedded Verboo CLI failed: $CLI_VERSION"
    fi
  else
    print_warn "System Node not on PATH; cannot verify embedded CLI runs. The app requires Node at runtime."
  fi
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

if command -v node >/dev/null 2>&1; then
  print_pass "System Node is present: $(node --version)"
else
  print_warn "System Node is absent. The packaged Tauri app requires Node on PATH to run the embedded CLI."
fi

if command -v verboo >/dev/null 2>&1; then
  print_pass "Global Verboo CLI is present but not required: $(command -v verboo)"
else
  print_pass "Global Verboo CLI is absent; packaged app uses embedded CLI."
fi

printf '\nSummary: %s failure(s), %s warning(s).\n' "$FAILURES" "$WARNINGS"
if (( FAILURES > 0 )); then
  exit 1
fi
