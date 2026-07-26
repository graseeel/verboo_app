#!/usr/bin/env bash
# Verificação de compilação e testes do adaptador Linux WebKitGTK dentro de
# container Ubuntu, sem instalar toolchain nativo no runner macOS.
#
# DEFEITO 1 ORIGINAL — mount em /workspace quebra symlinks absolutos:
#   src-tauri/resources/cli-package/node_modules/@types/node tem symlink
#   absoluto para o path real do repo, que dentro do container não existe.
#   FIX: monta no PRÓPRIO path ($REPO:$REPO), preservando a resolução.
#
# DEFEITO 2 ORIGINAL — cargo check não compila testes:
#   Escrevemos testes de contrato em browser_platform/ e o gate nunca os
#   rodou. FIX: roda cargo test --lib com --skip dos 13 testes que falham
#   por ambiente (git_service: 5 testes exigem git real; video::prepare: 4
#   exigem ffmpeg; video::probe: 4 exigem ffprobe). Quando os binários
#   existirem no container, remova os skips.
#
# DEFEITO 3 ORIGINAL — sidecars ARM ausentes no container:
#   gitignored. FIX: cria stubs vazios no volume montado antes de compilar.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR/../.."

# Normalize path (resolve .. and symlinks)
REPO="$(cd "$REPO" && pwd)"

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

echo "==> criando stubs de sidecar para o triple do container"
docker run --rm \
  -v "$REPO:$REPO" \
  -e CARGO_TARGET_DIR=/target \
  -w "$REPO" \
  "$IMAGE" \
  bash -c '
set -euo pipefail
# Detecta o host triple onde este container roda.
TRIPLE="$(rustc -vV | grep "^host:" | sed "s/^host: //")"
BINDIR="src-tauri/binaries"
mkdir -p "$BINDIR"
for SIDECAR in verboo-in-chrome verboo-ffmpeg verboo-ffprobe verboo-whisper computer-use-helper; do
  STUB="$BINDIR/${SIDECAR}-${TRIPLE}"
  if [ ! -f "$STUB" ]; then
    echo "    stub (vazio): $STUB"
    touch "$STUB"
  fi
done
'

echo "==> cargo test (full --lib) Linux — bind-mount no path real"
echo "    skip: 5 git_service (sem git), 4 video::prepare, 4 video::probe (sem ffmpeg)"
TEST_OUTPUT="$(mktemp)"
# Temporarily disable errexit so the pipeline exit is captured in
# PIPESTATUS instead of killing the script before the guard check.
set +e
docker run --rm \
  -v "$REPO:$REPO" \
  -v verboo-linux-target:/target \
  -v verboo-cargo-registry:/root/.cargo/registry \
  -e CARGO_TARGET_DIR=/target \
  -w "$REPO" \
  "$IMAGE" \
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib -- \
    --skip "rejects_dirty_repo_before_gh_or_push" \
    --skip "reports_nothing_to_commit" \
    --skip "commit_workspace_changes_roundtrip_in_temp_repo" \
    --skip "read_ahead_behind_returns_none_without_upstream" \
    --skip "read_last_commit_parses_hash_and_subject" \
    --skip "a_cancelled_job_refuses_new_media_work" \
    --skip "native_original_route_keeps_the_immutable_source" \
    --skip "preparing_the_hdr_fixture_tonemaps_without_audio_artifacts" \
    --skip "preparing_the_sdr_fixture_yields_frames_sheets_and_audio" \
    --skip "bundled_ffprobe_accepts_the_h264_sdr_fixture" \
    --skip "bundled_ffprobe_reads_the_hevc_pq_fixture" \
    --skip "bundled_ffprobe_reads_the_vp9_no_audio_fixture" \
    --skip "bundled_ffprobe_rejects_the_audio_only_fixture" \
    2>&1 | tee "$TEST_OUTPUT"
TEST_EXIT="${PIPESTATUS[0]}"
set -e
# Propagate cargo test exit first — a non-zero exit means compilation
# error or test failure, which must surface before the guard check.
if [ "$TEST_EXIT" -ne 0 ]; then
  rm -f "$TEST_OUTPUT"
  exit "$TEST_EXIT"
fi

FILTERED="$(grep -oE '[0-9]+ filtered out' "$TEST_OUTPUT" | head -1 | grep -oE '[0-9]+' || echo 0)"
rm -f "$TEST_OUTPUT"

# Guard: if the skip count drifts (someone adds a test name that collides
# with one of our --skip patterns, or a function is renamed), the gate
# catches it here instead of silently filtering.
if [ "$FILTERED" -ne 13 ]; then
  echo "GUARD FAILED: filtered out count is $FILTERED, expected 13"
  echo "The --skip list in scripts/verify/browser-linux-check.sh (lines 74-86)"
  echo "may need updating — a test name now collides with a pattern, or"
  echo "an environmental failure has been fixed and its --skip should be removed."
  exit 1
fi
