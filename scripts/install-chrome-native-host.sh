#!/usr/bin/env bash
#
# install-chrome-native-host.sh — install the Verboo Chrome extension
# Native Messaging host manifest for the current user.
#
# Multi-user: expands $HOME at install time. No hardcoded user paths.
#
# Usage:
#   EXTENSION_ID=abcdefghijklmnopqrstuvwxyz123456 \
#     ./scripts/install-chrome-native-host.sh
#
# Required env:
#   EXTENSION_ID  — Chrome extension ID (32 lowercase a-z chars)
#
# Optional env:
#   CHROME_FLAVOR  — "google-chrome" (default) | "chromium" | "chrome-beta"
#   HOST_BIN       — path to node binary (default: auto-detect)
#   HOST_SCRIPT    — path to host.mjs (default: <repo>/extensions/verboo-chrome/native-messaging/host.mjs)
#   UNINSTALL      — "1" to remove instead of install

set -euo pipefail

# ── Resolve repo root from script location ────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# ── Validate env ─────────────────────────────────────────────
if [[ -z "${EXTENSION_ID:-}" ]]; then
  echo "ERROR: EXTENSION_ID env var is required (the 32-char Chrome extension ID)." >&2
  echo "       Find it at chrome://extensions with Developer mode on." >&2
  exit 1
fi

if [[ ! "${EXTENSION_ID}" =~ ^[a-z]{32}$ ]]; then
  echo "ERROR: EXTENSION_ID must be 32 lowercase a-z characters. Got: ${EXTENSION_ID}" >&2
  exit 1
fi

CHROME_FLAVOR="${CHROME_FLAVOR:-google-chrome}"
HOST_SCRIPT="${HOST_SCRIPT:-${REPO_ROOT}/extensions/verboo-chrome/native-messaging/host.mjs}"

if [[ ! -f "${HOST_SCRIPT}" ]]; then
  echo "ERROR: host script not found at: ${HOST_SCRIPT}" >&2
  exit 1
fi

# ── Resolve node binary ──────────────────────────────────────
HOST_BIN="${HOST_BIN:-}"
if [[ -z "${HOST_BIN}" ]]; then
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "${HOME}/.local/bin/node" "${HOME}/.nvm/versions/node"/*/bin/node; do
    if [[ -x "${candidate}" ]]; then
      HOST_BIN="${candidate}"
      break
    fi
  done
fi
if [[ -z "${HOST_BIN}" ]] || [[ ! -x "${HOST_BIN}" ]]; then
  echo "ERROR: node binary not found. Set HOST_BIN env var to your node path." >&2
  exit 1
fi

# ── Resolve per-platform NativeMessagingHosts dir ─────────────
OS_NAME="$(uname -s)"
case "${OS_NAME}" in
  Darwin)
    HOSTS_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    case "${CHROME_FLAVOR}" in
      chromium) HOSTS_DIR="${HOME}/.config/chromium/NativeMessagingHosts" ;;
      chrome-beta) HOSTS_DIR="${HOME}/.config/google-chrome-beta/NativeMessagingHosts" ;;
      *) HOSTS_DIR="${HOME}/.config/google-chrome/NativeMessagingHosts" ;;
    esac
    ;;
  *)
    echo "ERROR: unsupported OS: ${OS_NAME}. Windows uses a registry-based install; see README." >&2
    exit 1
    ;;
esac

HOST_NAME="com.verboo.code.browser_extension"
MANIFEST_PATH="${HOSTS_DIR}/${HOST_NAME}.json"

# ── Uninstall path ────────────────────────────────────────────
if [[ "${UNINSTALL:-0}" == "1" ]]; then
  echo "Removing ${MANIFEST_PATH}"
  rm -f "${MANIFEST_PATH}"
  echo "Uninstalled ${HOST_NAME}."
  exit 0
fi

# ── Install ───────────────────────────────────────────────────
mkdir -p "${HOSTS_DIR}"

# Write the manifest with the resolved host script path and the
# caller-supplied extension ID. The path must be absolute.
cat > "${MANIFEST_PATH}" <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Verboo Code Desktop — Browser Extension bridge",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
JSON

chmod 0644 "${MANIFEST_PATH}"

echo "Installed ${HOST_NAME}"
echo "  Manifest: ${MANIFEST_PATH}"
echo "  Host:     ${HOST_SCRIPT}"
echo "  Node:     ${HOST_BIN}"
echo "  Origin:   chrome-extension://${EXTENSION_ID}/"
echo ""
echo "Note: Chrome must be restarted for the host to be discovered."
echo "The host script will be spawned by Chrome on connectNative('${HOST_NAME}')."
