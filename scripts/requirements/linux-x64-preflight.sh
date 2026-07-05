#!/usr/bin/env bash
# Linux x64 preflight checks for Verboo Code packaging.
# Runs on Linux to verify the build environment is ready.

set -euo pipefail

echo "Verboo Code — Linux x64 preflight"

# 1. Verify Node.js is available
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed or not on PATH." >&2
  echo "  Install via your package manager or https://github.com/nvm-sh/nvm" >&2
  exit 1
fi
echo "  Node.js: $(node --version)"

# 2. Verify npm is available
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is not installed or not on PATH." >&2
  exit 1
fi
echo "  npm: $(npm --version)"

# 3. Verify build tools (for native modules if rebuild is needed)
if ! command -v make >/dev/null 2>&1; then
  echo "WARNING: 'make' not found. Install 'build-essential' (Debian/Ubuntu) or 'gcc-c++ make' (Fedora/RHEL)."
fi

if ! command -v gcc >/dev/null 2>&1; then
  echo "WARNING: 'gcc' not found. Install 'build-essential' (Debian/Ubuntu) or 'gcc-c++' (Fedora/RHEL)."
fi

# 4. Verify libsecret (for safeStorage on Linux)
# Without libsecret, credential storage falls back to plaintext file
LIBSECRET_FOUND=0
if ldconfig -p 2>/dev/null | grep -q 'libsecret-1.so'; then
  LIBSECRET_FOUND=1
  echo "  libsecret-1: found"
else
  echo "WARNING: libsecret-1 not found. safeStorage will fall back to plaintext file."
  echo "  Install 'libsecret-1-dev' (Debian/Ubuntu) or 'libsecret-devel' (Fedora/RHEL) for full keyring support."
fi

# 5. Verify no Verboo Code processes are running
if pgrep -f "Verboo Code" >/dev/null 2>&1; then
  echo "ERROR: Verboo Code is still running. Close it before packaging." >&2
  pgrep -af "Verboo Code" >&2
  exit 1
fi

echo "Linux preflight passed."
