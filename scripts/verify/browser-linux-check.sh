#!/usr/bin/env bash
# ============================================================================
# browser-linux-check.sh
# ============================================================================
# Verificação do adaptador WebKitGTK (Linux) para o Navegador Embutido.
#
# Pré-requisitos:
#   - Docker instalado (v24+)
#   - Acesso a ghcr.io ou hub.docker.com para puxar ubuntu:22.04
#
# Uso:
#   ./scripts/verify/browser-linux-check.sh
#
# O script monta o src-tauri dentro de um container Ubuntu 22.04,
# instala as dependências do WebKitGTK (libwebkit2gtk-4.1-dev etc.),
# e roda `cargo check --locked` e `cargo test --locked --lib`.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../" && pwd)"
CARGO_MANIFEST_DIR="$PROJECT_DIR/src-tauri"

echo "[browser-linux-check] SRC-TAURI: $CARGO_MANIFEST_DIR"
echo "[browser-linux-check] Platform: linux/amd64"
echo "[browser-linux-check] Image: ubuntu:22.04"
echo ""

# Cria um Dockerfile temporário.
DOCKERFILE=$(mktemp)
trap 'rm -f "$DOCKERFILE"' EXIT

cat > "$DOCKERFILE" << 'DOCKERFILE_EOF'
FROM ubuntu:22.04

RUN export DEBIAN_FRONTEND=noninteractive && \
    apt-get update -qq && \
    apt-get install -y -qq \
        build-essential \
        pkg-config \
        libssl-dev \
        libwebkit2gtk-4.1-dev \
        libgtk-3-dev \
        libayatana-appindicator3-dev \
        librsvg2-dev \
        libjavascriptcoregtk-4.1-dev \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Instala Rust via rustup (toolchain estável).
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /workspace
COPY . .

RUN cargo check --locked --manifest-path src-tauri/Cargo.toml --lib 2>&1

RUN cargo test --locked --manifest-path src-tauri/Cargo.toml --lib 2>&1

DOCKERFILE_EOF

echo "[browser-linux-check] Building container image (first run downloads base)..."

# Monta o src-tauri — copia todo o project dir mas só o Cargo.* + src/ + binaries/ importam.
docker build \
    --platform linux/amd64 \
    -t verboo-browser-linux-check \
    -f "$DOCKERFILE" \
    "$PROJECT_DIR" \
    2>&1

echo ""
echo "[browser-linux-check] DONE — cargo check + test passaram no container Linux."
