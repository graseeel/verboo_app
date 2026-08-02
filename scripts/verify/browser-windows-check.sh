#!/usr/bin/env bash
# Verificação de compilação cruzada para Windows x86_64 via cargo-xwin.
#
# PROVA: compilação do crate Rust para o triple x86_64-pc-windows-msvc.
# NAO PROVA: comportamento em runtime, testes de integração, sidecars.
# A compilação passar significa que o cfg(windows) gate está correto e
# que nenhum tipo ou import Windows-specific quebrou.
#
# O TORNO provou o valor deste check em 2026-07-30: rodando cargo-xwin
# num commit já testado (macOS 22 avisos, Windows 17), encontrou 7
# defeitos reais de CommandExt que o gate macOS-only nunca exercita.
# O Windows check é o complemento do browser-linux-check.sh para cobrir
# as tres plataformas que publicamos (macOS + Windows + Linux) sem push.
#
# AVISO CONHECIDO — keep_until_process_exit nunca usado:
#   Aparece apenas no Windows, no cli_spawn.rs. É BENIGNO porque no
#   caminho não-macOS o app.restart() do Tauri diverge e não há o que
#   segurar. A própria compilação passar prova que o tipo de retorno
#   fecha — se o restart retornasse algo diferente, a assinatura não
#   compilaria. Não tratar como erro.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$SCRIPT_DIR/../.."
REPO="$(cd "$REPO" && pwd)"

# ─────────────────────────────────────────────────────────────────────
# Pré-requisito: cargo-xwin
# ─────────────────────────────────────────────────────────────────────
if ! command -v cargo-xwin &>/dev/null && ! cargo xwin --version &>/dev/null; then
  echo "==> cargo-xwin não encontrado. Instale com:"
  echo "    cargo install cargo-xwin"
  echo ""
  echo "    cargo-xwin baixa os CRT headers/libs do Microsoft no primeiro"
  echo "    uso (~150 MB) e faz cache em ~/.cache/cargo-xwin/."
  echo "    A instalação é única e offline depois do cache."
  echo ""
  echo "    brew/cargo: cargo install cargo-xwin"
  exit 1
fi

echo "==> cargo xwin check --target x86_64-pc-windows-msvc (lib)"
echo "    Cross-compila o crate Rust para Windows x86_64 via CRT bundlado."
echo "    Prova: compilação. Não prova: runtime, sidecars, integração."
echo ""

CHECK_OUTPUT="$(mktemp)"
set +e
cargo xwin check \
  --manifest-path "$REPO/src-tauri/Cargo.toml" \
  --target x86_64-pc-windows-msvc \
  --lib 2>&1 | tee "$CHECK_OUTPUT"
CHECK_EXIT="${PIPESTATUS[0]}"
set -e

if [ "$CHECK_EXIT" -eq 0 ]; then
  echo ""
  echo "================================================"
  echo "  ✓ Windows x86_64 compilou sem erros"
  echo "================================================"
  rm -f "$CHECK_OUTPUT"
  exit 0
fi

# Non-zero exit — coletar warnings conhecidos benignos para filtrar
# ruído do report.
echo ""
echo "================================================"
echo "  ✗ Windows x86_64 — erros de compilação"
echo "================================================"

# Nota: keep_until_process_exit warning é BENIGNO (ver header deste script).
# Se for a única diferença, não é bloqueante, mas ainda reportamos acima.

rm -f "$CHECK_OUTPUT"
exit "$CHECK_EXIT"
