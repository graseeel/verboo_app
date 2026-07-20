#!/usr/bin/env bash
#
# Build do app Verboo Code (release / .app + .dmg) com o ID da extensão
# do Chrome gravado dentro do binário.
#
# ┌───────────────────────────────────────────────────────────────────┐
# │  LUGAR PARA O ID DA EXTENSÃO — preencha DEPOIS de publicar          │
# └───────────────────────────────────────────────────────────────────┘
# Depois de subir a extensão na Chrome Web Store, o painel do
# desenvolvedor mostra um ID de 32 letras (a-p). Cole ele abaixo e rode
# este script de novo — só isso. Enquanto estiver vazio, a integração
# "Verboo no Chrome" continua aparecendo como "não configurável" (é o
# comportamento atual, seguro).
#
VERBOO_CHROME_EXTENSION_ID="nkfgdaoblgcbngpklgnmjkfdabpbmpee"
# Opcional: link da extensão na loja. Preenchendo, o app mostra o botão
# "Instalar extensão" que leva direto para a página. (Só resolve depois
# que a extensão for publicada/aprovada.)
VERBOO_CHROME_WEB_STORE_URL="https://chromewebstore.google.com/detail/nkfgdaoblgcbngpklgnmjkfdabpbmpee"
# ─────────────────────────────────────────────────────────────────────

set -euo pipefail
cd "$(dirname "$0")/.."

export VERBOO_CHROME_EXTENSION_ID
export VERBOO_CHROME_WEB_STORE_URL
# Command Line Tools em vez do Xcode beta (o toolchain do Xcode 27 beta
# corrompe o build — receita já validada). Respeita um DEVELOPER_DIR já
# definido, se houver.
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Library/Developer/CommandLineTools}"

if [ -z "$VERBOO_CHROME_EXTENSION_ID" ]; then
  echo "⚠️  VERBOO_CHROME_EXTENSION_ID vazio — a integração do Chrome NÃO poderá ser configurada neste build."
  echo "    (Isso é esperado até você publicar a extensão e colar o ID no topo deste arquivo.)"
else
  echo "→ Extensão do Chrome: $VERBOO_CHROME_EXTENSION_ID"
fi

echo "→ Compilando o bundle de release (isso leva alguns minutos)…"
npm run tauri:build

echo
echo "✓ Pronto:"
echo "    App: ~/Library/Caches/verboo/target/release/bundle/macos/Verboo Code.app"
echo "    DMG: ~/Library/Caches/verboo/target/release/bundle/dmg/"
