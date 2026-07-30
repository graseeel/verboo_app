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
#   rodou. FIX original: roda cargo test --lib com --skip dos 13 testes
#   que falham por ambiente (git_service: 5 testes exigem git real;
#   video::prepare: 4 exigem ffmpeg; video::probe: 4 exigem ffprobe).
#
#   2026-07-30 (A1b-DOCKER): os binários agora existem no container
#   (git, ffmpeg, ffprobe, Node 22). Os 13 --skip foram REMOVIDOS. O
#   guard de "filtered out count" agora espera 0 — qualquer skip
#   silencioso novo é bloqueante (regra QA: skip só existe se declarado
#   no runner E visível no log).
#
#   2026-07-30 (A1b-SIDECARS-resolved): os 8 --skip nominais
#   (video::prepare + video::probe) foram REMOVIDOS depois que o TORNO
#   unificou host_target() em src-tauri/src/services/video/target.rs
#   com as 6 plataformas. Contrato final: zero --skip, guard espera 0.
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

# Node 22 pinado em 22.11.0 (LTS "Jod"). Node flutuante faria o container
# divergir da máquina do usuário sem avisar — pinar é obrigatório.
# NodeSource setup oficial (nodesource/distributions) é a fonte canônica.
# O verboo-cli-update.yml já usa Node 22; este container casa com ele.
ENV NODE_VERSION=22.11.0

RUN export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && \
    apt-get install -y -qq \
      build-essential pkg-config libssl-dev \
      libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
      librsvg2-dev libjavascriptcoregtk-4.1-dev \
      curl ca-certificates \
      git \
      ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Node 22 binário oficial (pinado). Baixa do nodejs.org, verifica SHA-256
# contra o checksum publicado, extrai em /opt/node. ffprobe vem junto do
# pacote ffmpeg do Ubuntu (já instalado acima).
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

# ─────────────────────────────────────────────────────────────────────
# PROTEÇÃO CONTRA SOBRESCREVER BINÁRIOS macOS (apple-darwin).
# O container monta o repo REAL via -v REPO:REPO. Sem esta proteção,
# um bug de triple ou de path poderia sobrescrever o ffmpeg de 7,5 MB
# do macOS — arquivo gitignored, não volta com git checkout. O usuário
# ficaria sem vídeo no app local. Esta checagem ABORTA o script antes
# que qualquer arquivo com sufixo apple-darwin seja tocado.
# ─────────────────────────────────────────────────────────────────────
DARWIN_FILES=$(find "$BINDIR" -maxdepth 1 -name "*-apple-darwin*" -type f 2>/dev/null || true)
if [ -n "$DARWIN_FILES" ]; then
  echo "    binários macOS presentes (intocáveis):"
  echo "$DARWIN_FILES" | while read -r f; do echo "      $f"; done
fi

# Snapshot de hash ANTES de qualquer write. Esta é a evidência que
# compara com a pós-escrita — não a barreira dura, que já aborta antes
# do write. A barreira IMPEDE; o hash AFIRMA que não houve dano.
#
# Glob "*-apple-darwin*" com aspas no nome do diretório expande em
# múltiplos argumentos para sha256sum, cada caminho tratado como uma
# string completa. Isto é IMUNE a word splitting porque cada caminho
# vira um argv próprio (não um token do shell).
#
# ABORT quando a contagem for ZERO: significa que rodamos do diretório
# errado (não há binários macOS para proteger) e qualquer write abaixo
# seria em vazio. Não declaramos "intactos" sem ter olhado nada.
DARWIN_HASHES_BEFORE=$(sha256sum -- "$BINDIR"/*-apple-darwin* 2>/dev/null || true)
DARWIN_COUNT_BEFORE=$(printf '%s\n' "$DARWIN_HASHES_BEFORE" | grep -c . || true)
if [ "${DARWIN_COUNT_BEFORE:-0}" -eq 0 ]; then
  echo "ABORT: nenhum binário apple-darwin em $BINDIR — rodando do diretório errado?"
  echo "       Para esta verificação fazer sentido, o repo deve ter os 5 sidecars macOS."
  exit 1
fi
if [ "${DARWIN_COUNT_BEFORE:-0}" -ne 5 ]; then
  echo "ABORT: contagem de binários apple-darwin é $DARWIN_COUNT_BEFORE, esperado 5."
  echo "       Investigar antes de prosseguir — proteção fica sem referência."
  exit 1
fi
echo "    snapshot sha256: $DARWIN_COUNT_BEFORE binários macOS capturados antes da operação."

# Para cada sidecar, decide: copiar da distro (ffmpeg/ffprobe) ou stub vazio.
# O TRIPLE do container NUNCA é apple-darwin — se for, aborta (rodando no host errado).
case "$TRIPLE" in
  *apple-darwin*)
    echo "ABORT: triple do container é $TRIPLE — este script só roda em Linux."
    echo "       Se está rodando em macOS, o docker está em modo host incorreto."
    exit 1
    ;;
esac

for SIDECAR in verboo-in-chrome verboo-ffmpeg verboo-ffprobe verboo-whisper computer-use-helper; do
  TARGET="$BINDIR/${SIDECAR}-${TRIPLE}"

  # Barreira dura: nunca escrever em caminho com sufixo apple-darwin.
  case "$TARGET" in
    *apple-darwin*)
      echo "ABORT: tentativa de escrever em $TARGET — sufixo apple-darwin é proibido."
      echo "       Isto indicaria bug na detecção de triple. Abortando antes de tocar."
      exit 1
      ;;
  esac

  case "$SIDECAR" in
    verboo-ffmpeg)
      # Copia o ffmpeg da distro (instalado via apt-get no Dockerfile).
      # Preserva bit de execução com cp -p. Os testes de video::prepare
      # exercem a NOSSA lógica de resolução de path + invocação + parse,
      # não as flags de compilação do ffmpeg — execução honesta.
      # Sempre sobrescreve: se existir stub de 17 bytes de ciclo anterior,
      # a cópia da distro substitui.
      cp -f /usr/bin/ffmpeg "$TARGET"
      chmod +x "$TARGET"
      echo "    binário distro: $TARGET ($(stat -c %s "$TARGET") bytes)"
      ;;
    verboo-ffprobe)
      # ffprobe vem no mesmo pacote ffmpeg do Ubuntu.
      cp -f /usr/bin/ffprobe "$TARGET"
      chmod +x "$TARGET"
      echo "    binário distro: $TARGET ($(stat -c %s "$TARGET") bytes)"
      ;;
    verboo-in-chrome|verboo-whisper|computer-use-helper)
      # Nenhum dos 8 testes de video precisa destes três. Computer Use
      # não está implementado oficialmente no app ainda. Stub vazio.
      # Só cria se não existir (não sobrescreve binário real se já houver).
      if [ ! -s "$TARGET" ]; then
        touch "$TARGET"
        echo "    stub (vazio): $TARGET"
      else
        echo "    já existe: $TARGET ($(stat -c %s "$TARGET") bytes)"
      fi
      ;;
  esac
done

# Verificação pós-escrita: compara hash sha256 de cada binário apple-darwin
# com o snapshot capturado ANTES dos writes. Detecta sobrescrita de conteúdo,
# não só perda de bit de execução. Imune a word splitting (mesma razão do
# glob acima — sha256sum recebe cada caminho como argv próprio).
#
# Esta verificação é EVIDÊNCIA de que não houve dano. A barreira dura
# (case "$TARGET" in *apple-darwin*) ABORT no write é a PROTEÇÃO. Confundir
# as duas categorias — usar verificação decorativa no lugar de evidência
# útil — foi o defeito do ciclo anterior (CADINHO 2026-07-30).
DARWIN_HASHES_AFTER=$(sha256sum -- "$BINDIR"/*-apple-darwin* 2>/dev/null || true)
if [ "$DARWIN_HASHES_BEFORE" != "$DARWIN_HASHES_AFTER" ]; then
  echo "ABORT: binário apple-darwin foi modificado durante a operação."
  echo "       Diff entre snapshot antes e depois:"
  diff <(printf '%s\n' "$DARWIN_HASHES_BEFORE") \
       <(printf '%s\n' "$DARWIN_HASHES_AFTER") || true
  exit 1
fi
echo "    ✓ $DARWIN_COUNT_BEFORE binários macOS apple-darwin bit-for-bit inalterados."
'

echo "==> cargo test (full --lib) Linux — bind-mount no path real"
echo "    sem --skip: git, ffmpeg, ffprobe e Node 22 estão no container;"
echo "    host_target() em src-tauri/src/services/video/target.rs cobre as 6 plataformas."
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
  cargo test --locked --manifest-path src-tauri/Cargo.toml --lib 2>&1 | tee "$TEST_OUTPUT"
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

# Guard (A1b-DOCKER 2026-07-30): skip só existe se declarado no runner E
# visível no log (regra QA). Contrato: ZERO skipped. Se algum teste voltar
# a ser pulado por nome (--skip reintroduzido) ou pelo ambiente (guard
# silencioso em src-tauri/src/services/), o gate falha alto aqui.
# Histórico: este guard já pegou um drift real em 2026-07-30 — quando o
# TORNO corrigiu host_target() e removeu os 8 --skip, o guard gritou
# "expected 8, got 0" sinalizando a boa notícia.
if [ "$FILTERED" -ne 0 ]; then
  echo "GUARD FAILED: filtered out count is $FILTERED, expected 0"
  echo "Alguém reintroduziu um --skip silencioso ou um guard em src-tauri/src/"
  echo "voltou a pular testes por ambiente. Investigue antes de reabilitar."
  echo "Regra QA: skip só existe se declarado no runner E visível no log."
  exit 1
fi
