#!/usr/bin/env bash
# Reproduz o CI localmente via Docker (Ubuntu 24.04 + Node 22 + Rust stable).
# Roda os mesmos checks que falharam no PR:
#   1. npx tsc --noEmit          (renderer build gate)
#   2. npm run build:renderer    (tsc + vite)
#   3. cargo test --lib          (Rust library tests)
#
# Uso: bash scripts/verify/ci-local-docker.sh
set -euo pipefail

# Disable Git Bash automatic path conversion (breaks Docker -w and -v flags)
export MSYS_NO_PATHCONV=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Convert Git Bash path (/c/Projetos/verboo_app) to Windows path (C:/Projetos/verboo_app)
REPO_WIN="$REPO"
if [[ "$REPO" =~ ^/([a-zA-Z])/(.*) ]]; then
  DRIVE="${BASH_REMATCH[1]}"
  REST="${BASH_REMATCH[2]}"
  REPO_WIN="${DRIVE^^}:/${REST}"
fi

IMAGE="verboo-linux-check:ubuntu24"
MOUNT="/workspace"

echo "REPO_WIN=$REPO_WIN"
echo "MOUNT=$MOUNT"

# ── 1. Build da imagem base (uma vez) ──────────────────────────────────────
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> construindo imagem base Ubuntu 24.04 + Node 22 + Rust"
  docker build -t "$IMAGE" - <<'DOCKERFILE'
FROM ubuntu:24.04

ENV NODE_VERSION=22.11.0

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -qq && \
    apt-get install -y -qq \
      build-essential pkg-config libssl-dev \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libjavascriptcoregtk-4.1-dev \
      curl ca-certificates \
      git \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in \
      amd64)  NODE_ARCH="x64";   NODE_SHA="83bf07dd343002a26211cf1fcd46a9d9534219aad42ee02847816940bf610a72" ;; \
      arm64)  NODE_ARCH="arm64"; NODE_SHA="6031d04b98f59ff0f7cb98566f65b115ecd893d3b7870821171708cdbaf7ae6e" ;; \
      *) echo "unsupported arch: $ARCH" >&2; exit 1 ;; \
    esac; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    tar -xJf "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" -C /opt; \
    ln -s "/opt/node-v${NODE_VERSION}-linux-${NODE_ARCH}" /opt/node; \
    rm "node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" SHASUMS256.txt; \
    PATH="/opt/node/bin:${PATH}" /opt/node/bin/node --version; \
    PATH="/opt/node/bin:${PATH}" /opt/node/bin/npm --version

ENV PATH="/opt/node/bin:/root/.cargo/bin:${PATH}"

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
DOCKERFILE
fi

# ── 2. Preparar sidecars (stubs vazios) ────────────────────────────────────
echo "==> criando stubs de sidecar para o triple do container"
docker run --rm \
  -v "$REPO_WIN:$MOUNT" \
  -e CARGO_TARGET_DIR=/target \
  -w "$MOUNT" \
  "$IMAGE" \
  bash -c '
set -euo pipefail
TRIPLE="$(rustc -vV | grep "^host:" | sed "s/^host: //")"
BINDIR="src-tauri/binaries"
mkdir -p "$BINDIR"
for SIDECAR in verboo-in-chrome verboo-ios-simulator verboo-ffmpeg verboo-ffprobe verboo-whisper computer-use-helper; do
  TARGET="$BINDIR/${SIDECAR}-${TRIPLE}"
  case "$SIDECAR" in
    verboo-ffmpeg)   cp -f /usr/bin/ffmpeg "$TARGET"; chmod +x "$TARGET" ;;
    verboo-ffprobe)  cp -f /usr/bin/ffprobe "$TARGET"; chmod +x "$TARGET" ;;
    *)               [ ! -s "$TARGET" ] && touch "$TARGET" ;;
  esac
done
echo "    ✓ sidecars prontos para $TRIPLE"
'

# ── 3. Criar dist-renderer placeholder (necessário para cargo check) ───────
mkdir -p "$REPO/dist-renderer"
: > "$REPO/dist-renderer/index.html"

# ── 4. Rodar os checks do CI ───────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  CI LOCAL DOCKER — reproduzindo ambiente GitHub Actions     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

FAILED=0

# ── 4a. npm ci ──────────────────────────────────────────────────────────────
echo "═══ STEP 1/4: npm ci ═══════════════════════════════════════"
docker run --rm \
  -v "$REPO_WIN:$MOUNT" \
  -v verboo-cargo-registry:/root/.cargo/registry \
  -e CARGO_TARGET_DIR=/target \
  -w "$MOUNT" \
  "$IMAGE" \
  bash -c 'set -euo pipefail; npm ci 2>&1 | tail -5; echo "    ✓ npm ci OK"'
echo ""

# ── 4b. npx tsc --noEmit (renderer build gate) ─────────────────────────────
echo "═══ STEP 2/4: npx tsc --noEmit (renderer build gate) ═══════"
if docker run --rm \
  -v "$REPO_WIN:$MOUNT" \
  -v verboo-cargo-registry:/root/.cargo/registry \
  -e CARGO_TARGET_DIR=/target \
  -w "$MOUNT" \
  "$IMAGE" \
  bash -c 'set -euo pipefail; npx tsc --noEmit 2>&1; echo "    ✓ tsc --noEmit: ZERO erros"'; then
  echo "    ✅ PASS"
else
  echo "    ❌ FAIL — tsc --noEmit errou"
  FAILED=1
fi
echo ""

# ── 4c. npm run build:renderer (tsc + vite) ────────────────────────────────
echo "═══ STEP 3/4: npm run build:renderer (tsc + vite) ══════════"
if docker run --rm \
  -v "$REPO_WIN:$MOUNT" \
  -v verboo-cargo-registry:/root/.cargo/registry \
  -e CARGO_TARGET_DIR=/target \
  -w "$MOUNT" \
  "$IMAGE" \
  bash -c 'set -euo pipefail; npm run build:renderer 2>&1 | tail -10; echo "    ✓ build:renderer OK"'; then
  echo "    ✅ PASS"
else
  echo "    ❌ FAIL — build:renderer errou"
  FAILED=1
fi
echo ""

# ── 4d. cargo test --lib (Rust tests) ──────────────────────────────────────
echo "═══ STEP 4/4: cargo test --lib (Linux/WebKitGTK) ═══════════"
TEST_OUTPUT="$(mktemp)"
set +e
docker run --rm \
  -v "$REPO_WIN:$MOUNT" \
  -v verboo-cargo-registry:/root/.cargo/registry \
  -v verboo-linux-target:/target \
  -e CARGO_TARGET_DIR=/target \
  -w "$MOUNT" \
  "$IMAGE" \
  bash -c '
set -euo pipefail
# Force recompile: the target volume may contain a stale binary from a
# previous run. Clean only the verboo-desktop crate to avoid rebuilding
# all dependencies (~5 min penalty vs full clean).
cargo clean --manifest-path src-tauri/Cargo.toml --lib 2>/dev/null || true
FRONTEND_DIST_CREATED=0
if [ ! -d dist-renderer ]; then
  mkdir -p dist-renderer
  FRONTEND_DIST_CREATED=1
fi
cleanup_frontend_dist() {
  if [ "$FRONTEND_DIST_CREATED" -eq 1 ]; then
    rmdir dist-renderer || true
  fi
}
trap cleanup_frontend_dist EXIT
cargo test --locked --manifest-path src-tauri/Cargo.toml --lib 2>&1
' 2>&1 | tee "$TEST_OUTPUT"
CARGO_EXIT="${PIPESTATUS[0]}"
set -e

if [ "$CARGO_EXIT" -eq 0 ]; then
  echo "    ✅ PASS — cargo test --lib"
  # Guard: zero filtered out
  FILTERED="$(grep -oE '[0-9]+ filtered out' "$TEST_OUTPUT" | head -1 | grep -oE '[0-9]+' || echo 0)"
  if [ "$FILTERED" -ne 0 ]; then
    echo "    ⚠️  WARN: $FILTERED tests filtered out (expected 0)"
  fi
else
  echo "    ❌ FAIL — cargo test --lib (exit code: $CARGO_EXIT)"
  FAILED=1
fi
rm -f "$TEST_OUTPUT"
echo ""

# ── 5. Resumo ──────────────────────────────────────────────────────────────
echo "╔══════════════════════════════════════════════════════════════╗"
if [ "$FAILED" -eq 0 ]; then
  echo "║  ✅ TODOS OS CHECKS DO CI PASSARAM NO DOCKER              ║"
else
  echo "║  ❌ ALGUNS CHECKS FALHARAM — ver logs acima               ║"
fi
echo "╚══════════════════════════════════════════════════════════════╝"

exit "$FAILED"
