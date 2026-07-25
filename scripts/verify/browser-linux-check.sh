#!/usr/bin/env bash
# Verificação de compilação Linux via bind-mount (NÃO copia a árvore).
# COPY . . estourava o disco da VM; o mount lê o código no lugar e
# guarda o target/ num volume nomeado, reaproveitado entre execuções.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
IMAGE="verboo-linux-check:ubuntu24"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "==> construindo imagem base (uma vez)"
  docker build -t "$IMAGE" - <<'DOCKERFILE'
FROM ubuntu:24.04
RUN export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && \
    apt-get install -y -qq build-essential pkg-config libssl-dev \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libjavascriptcoregtk-4.1-dev curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
ENV PATH="/root/.cargo/bin:${PATH}"
DOCKERFILE
fi

echo "==> cargo check Linux (bind-mount, sem cópia)"
docker run --rm \
  -v "$REPO:/workspace" \
  -v verboo-linux-target:/target \
  -v verboo-cargo-registry:/root/.cargo/registry \
  -e CARGO_TARGET_DIR=/target \
  -w /workspace "$IMAGE" \
  cargo check --locked --manifest-path src-tauri/Cargo.toml --lib
