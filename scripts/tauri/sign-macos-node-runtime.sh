#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd -P)
REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd -P)
ENTITLEMENTS_PATH="$REPO_ROOT/src-tauri/Entitlements.plist"
APP_PATH=${1:?"usage: sign-macos-node-runtime.sh APP_PATH SIGNING_IDENTITY [KEYCHAIN_PATH]"}
SIGNING_IDENTITY=${2:?"usage: sign-macos-node-runtime.sh APP_PATH SIGNING_IDENTITY [KEYCHAIN_PATH]"}
KEYCHAIN_PATH=${3:-}
NODE_PATH="$APP_PATH/Contents/MacOS/verboo-node"

test -d "$APP_PATH"
test -x "$NODE_PATH"
test -f "$ENTITLEMENTS_PATH"

CODESIGN_ARGS=(
  --force
  --options runtime
  --timestamp
  --entitlements "$ENTITLEMENTS_PATH"
)
if [[ -n "$KEYCHAIN_PATH" ]]; then
  test -f "$KEYCHAIN_PATH"
  CODESIGN_ARGS+=(--keychain "$KEYCHAIN_PATH")
fi
CODESIGN_ARGS+=(--sign "$SIGNING_IDENTITY")

# Tauri signs externalBin entries again while assembling the bundle. That
# final nested signature must explicitly retain V8's hardened-runtime
# entitlements; otherwise Node starts but aborts as soon as it reserves the
# executable CodeRange used to run JavaScript.
/usr/bin/codesign "${CODESIGN_ARGS[@]}" "$NODE_PATH"

# Changing a nested code object invalidates the outer bundle seal. Re-sign the
# app after Node so Gatekeeper/notarization see one coherent signature graph.
/usr/bin/codesign "${CODESIGN_ARGS[@]}" "$APP_PATH"

/usr/bin/codesign --verify --strict --verbose=2 "$NODE_PATH"
/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"

NODE_ENTITLEMENTS=$(/usr/bin/codesign -d --entitlements - --xml "$NODE_PATH" 2>&1)
NODE_ENTITLEMENTS_COMPACT=$(printf '%s' "$NODE_ENTITLEMENTS" | tr -d '[:space:]')
for entitlement in \
  com.apple.security.cs.allow-jit \
  com.apple.security.cs.allow-unsigned-executable-memory \
  com.apple.security.cs.disable-library-validation
do
  printf '%s' "$NODE_ENTITLEMENTS_COMPACT" \
    | grep -F "<key>$entitlement</key><true/>" >/dev/null
done

# Signature inspection alone missed the field crash. Execute JavaScript so a
# future entitlement regression fails before the app or DMG can be published.
"$NODE_PATH" -e 'const value = Array.from({length: 4}, (_, index) => index + 1).reduce((sum, value) => sum + value, 0); if (value !== 10) process.exit(1); process.stdout.write("embedded-node-js-ok\n")'
