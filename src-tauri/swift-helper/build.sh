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
  main.swift \
  -o "$OUT_DIR/computer-use-helper-$TRIPLE"

echo "Built: $OUT_DIR/computer-use-helper-$TRIPLE"
