#!/usr/bin/env bash
# Builds the Swift computer-use helper and copies the binary to
# `../binaries/computer-use-helper-<triple>` so Tauri's `externalBin`
# sidecar mechanism can find it.
#
# Triples produced: aarch64-apple-darwin (Apple Silicon), x86_64-apple-darwin (Intel).
# Run from anywhere; resolves paths relative to this script.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUT_DIR="$SCRIPT_DIR/../binaries"
mkdir -p "$OUT_DIR"

ARCH="$(uname -m)"
case "$ARCH" in
  arm64)   TRIPLE="aarch64-apple-darwin"; TARGET="arm64-apple-macosx12.0" ;;
  x86_64)  TRIPLE="x86_64-apple-darwin";  TARGET="x86_64-apple-macosx12.0" ;;
  *) echo "Unsupported arch: $ARCH" >&2; exit 1 ;;
esac

echo "Building computer-use-helper for $TRIPLE..."

# Use Swift compiler directly. SPM is also supported but adds overhead
# for a single-file target. `-target <arch>-apple-macosx12.0` pins the
# deployment target (Tauri's min macOS is 12.0 — see tauri.conf.json).
swiftc \
  -O \
  -whole-module-optimization \
  -target "$TARGET" \
  -framework Foundation \
  -framework AppKit \
  -framework ApplicationServices \
  -framework Carbon \
  -framework CoreImage \
  -framework CoreMedia \
  -framework CoreVideo \
  -framework ScreenCaptureKit \
  main.swift \
  -o "$OUT_DIR/computer-use-helper-$TRIPLE"

echo "Built: $OUT_DIR/computer-use-helper-$TRIPLE"

AGENT_APP="$OUT_DIR/Verboo Computer Use.app"
AGENT_CONTENTS="$AGENT_APP/Contents"
AGENT_EXECUTABLE="$AGENT_CONTENTS/MacOS/computer-use-helper"
AGENT_RESOURCES="$AGENT_CONTENTS/Resources"
ICON_SOURCE="$SCRIPT_DIR/../icons/verboo-computer-use.png"
ICONSET="$OUT_DIR/VerbooComputerUse.iconset"
VERSION="$(plutil -extract version raw "$SCRIPT_DIR/../tauri.conf.json")"

rm -rf "$AGENT_APP" "$ICONSET"
mkdir -p "$AGENT_CONTENTS/MacOS" "$AGENT_RESOURCES" "$ICONSET"
cp "$OUT_DIR/computer-use-helper-$TRIPLE" "$AGENT_EXECUTABLE"
chmod 0755 "$AGENT_EXECUTABLE"

for spec in \
  "16 icon_16x16.png" \
  "32 icon_16x16@2x.png" \
  "32 icon_32x32.png" \
  "64 icon_32x32@2x.png" \
  "128 icon_128x128.png" \
  "256 icon_128x128@2x.png" \
  "256 icon_256x256.png" \
  "512 icon_256x256@2x.png" \
  "512 icon_512x512.png" \
  "1024 icon_512x512@2x.png"
do
  size="${spec%% *}"
  name="${spec#* }"
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/$name" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$AGENT_RESOURCES/VerbooComputerUse.icns"
rm -rf "$ICONSET"

INFO_PLIST="$AGENT_CONTENTS/Info.plist"
plutil -create xml1 "$INFO_PLIST"
plutil -insert CFBundleDevelopmentRegion -string en "$INFO_PLIST"
plutil -insert CFBundleDisplayName -string "Verboo Computer Use" "$INFO_PLIST"
plutil -insert CFBundleExecutable -string computer-use-helper "$INFO_PLIST"
plutil -insert CFBundleIconFile -string VerbooComputerUse "$INFO_PLIST"
plutil -insert CFBundleIdentifier -string ai.verboo.code.computer-use "$INFO_PLIST"
plutil -insert CFBundleInfoDictionaryVersion -string 6.0 "$INFO_PLIST"
plutil -insert CFBundleName -string "Verboo Computer Use" "$INFO_PLIST"
plutil -insert CFBundlePackageType -string APPL "$INFO_PLIST"
plutil -insert CFBundleShortVersionString -string "$VERSION" "$INFO_PLIST"
plutil -insert CFBundleVersion -string "$VERSION" "$INFO_PLIST"
plutil -insert LSMinimumSystemVersion -string 12.0 "$INFO_PLIST"
plutil -insert LSUIElement -bool true "$INFO_PLIST"
plutil -insert NSHighResolutionCapable -bool true "$INFO_PLIST"
plutil -insert NSScreenCaptureUsageDescription -string "Verboo Computer Use captures only the explicitly authorized app window so the agent can see and verify actions." "$INFO_PLIST"

# Development builds remain launchable. Distribution builds must re-sign this
# nested agent and the outer app with the same stable Apple identity.
xattr -cr "$AGENT_APP"
SIGNING_IDENTITY="${MACOS_CODESIGN_IDENTITY:-${APPLE_SIGNING_IDENTITY:-}}"
if [[ -n "$SIGNING_IDENTITY" ]]; then
  if [[ "$SIGNING_IDENTITY" == Developer\ ID\ Application:* ]]; then
    codesign --force --deep --options runtime --sign "$SIGNING_IDENTITY" --timestamp "$AGENT_APP"
  else
    codesign --force --deep --options runtime --sign "$SIGNING_IDENTITY" --timestamp=none "$AGENT_APP"
  fi
  echo "Signed agent with stable identity: $SIGNING_IDENTITY"
else
  codesign --force --deep --sign - --timestamp=none "$AGENT_APP"
fi
echo "Built agent app: $AGENT_APP"
