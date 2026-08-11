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

# ─────────────────────────────────────────────────────────────────────────────
# Detect the Cargo target directory ONCE, up front. We need it before the
# build to snapshot the pre-build .app mtime (the load-bearing signal for
# distinguishing a benign updater-signing failure from a real build abort).
# Resolution order: CARGO_TARGET_DIR env → src-tauri/.cargo/config.toml
# target-dir → $HOME/.cache/verboo-target fallback.
# ─────────────────────────────────────────────────────────────────────────────
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-}"
if [[ -z "$CARGO_TARGET_DIR" ]]; then
  CARGO_CUSTOM_DIR=$(awk -F'=' '/^target-dir/{gsub(/[ "]/, "", $2); print $2}' \
    "src-tauri/.cargo/config.toml" 2>/dev/null)
  if [[ -n "$CARGO_CUSTOM_DIR" ]]; then
    CARGO_TARGET_DIR="$CARGO_CUSTOM_DIR"
  fi
fi
CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HOME/.cache/verboo-target}"
BUNDLE_ROOT="${CARGO_TARGET_DIR}/release/bundle/macos"
DMG_ROOT="${CARGO_TARGET_DIR}/release/bundle/dmg"
EXECUTABLE_PATH="${CARGO_TARGET_DIR}/release/verboo-desktop"

# Snapshot the pre-build .app mtime. The benign failure mode (updater
# tarball signing without TAURI_SIGNING_PRIVATE_KEY) happens AFTER cargo
# produces the .app, so the .app mtime WILL advance on a benign failure.
# A real failure (tsc, vite, cargo abort) leaves the .app untouched — same
# mtime as before. Comparing mtimes is robust against fragile error-text
# matching and proves actual delivery.
PRE_BUILD_APP_MTIME=""
PRE_BUILD_APP_PATH=$(find "$BUNDLE_ROOT" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -1 || true)
if [[ -n "$PRE_BUILD_APP_PATH" ]]; then
  PRE_BUILD_APP_MTIME=$(stat -f '%m' "$PRE_BUILD_APP_PATH" 2>/dev/null || echo '')
fi

# Tolerate updater-signing failure: when TAURI_SIGNING_PRIVATE_KEY is unset
# (local builds without the release key), `tauri build` still produces the
# .app and .dmg successfully but errors out at the very end trying to sign
# the updater tarball. The .app/.dmg are valid; only the updater channel
# is unusable until CI signs it. We accept that trade-off locally — BUT
# only when the .app was actually produced/updated this run. If the .app
# is missing or carries the pre-build mtime, the failure is REAL (tsc,
# vite, cargo abort) and we must NOT sign a stale artifact.
TAURI_BUILD_FAILED=0
if ! npm run tauri:build; then
  TAURI_BUILD_FAILED=1
  echo "⚠️  npm run tauri:build saiu com erro."
  echo "    Verificando se o .app foi de fato produzido nesta execução…"
  POST_BUILD_APP_PATH=$(find "$BUNDLE_ROOT" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -1 || true)
  if [[ -z "$POST_BUILD_APP_PATH" ]]; then
    echo "FAIL: nenhum .app encontrado em $BUNDLE_ROOT — o build abortou antes de produzir artefato."
    echo "      Não vou assinar artefato de build anterior. Corrija o erro acima e rode novamente."
    exit 1
  fi
  POST_BUILD_APP_MTIME=$(stat -f '%m' "$POST_BUILD_APP_PATH" 2>/dev/null || echo '')
  if [[ -n "$PRE_BUILD_APP_MTIME" && "$POST_BUILD_APP_MTIME" == "$PRE_BUILD_APP_MTIME" ]]; then
    echo "FAIL: .app presente em $POST_BUILD_APP_PATH mas com mtime idêntico ao pré-build"
    echo "      ($PRE_BUILD_APP_MTIME). O cargo NÃO recompilou — o .app é de um build anterior."
    echo "      Não vou assinar artefato velho. Corrija o erro acima e rode novamente."
    exit 1
  fi
  echo "    ✓ .app foi atualizado nesta execução (mtime $POST_BUILD_APP_MTIME)."
  echo "    A falha do tauri:build é provavelmente a assinatura do tarball do updater"
  echo "    (sem TAURI_SIGNING_PRIVATE_KEY local) — falha benigna, seguindo."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Delivery verification: confirm the renderer embedded in the binary
# matches the renderer just built in dist-renderer/assets/. This is the
# load-bearing proof that the binary actually contains this run's
# renderer — not a stale artifact from a previous build. The Vite hash
# (index-<hash>.js) is embedded as a literal string in the binary by
# Tauri's asset bundling, so we grep it out with `strings`. If the hashes
# diverge, the binary has a renderer from a different build and we MUST
# fail — signing it would ship a stale UI.
# ─────────────────────────────────────────────────────────────────────────────
RENDERER_ASSET_DIR="dist-renderer/assets"
RENDERER_BUILT_HASH=$(find "$RENDERER_ASSET_DIR" -maxdepth 1 -type f -name 'index-*.js' 2>/dev/null | head -1 || true)
if [[ -z "$RENDERER_BUILT_HASH" ]]; then
  echo "FAIL: nenhum asset index-*.js encontrado em $RENDERER_ASSET_DIR."
  echo "      O build do renderer não produziu saída — abortando antes de assinar."
  exit 1
fi
RENDERER_BUILT_BASENAME=$(basename "$RENDERER_BUILT_HASH")
# Extract the index-<hash>.js literal from the binary. We accept the
# Vite default hash charset ([A-Za-z0-9_-]) and 8+ chars. `strings` is
# present on macOS via binutils; the binary is large (~40MB) but this
# runs in well under a second.
if [[ ! -f "$EXECUTABLE_PATH" ]]; then
  echo "FAIL: executável $EXECUTABLE_PATH não encontrado — o cargo não produziu binário."
  echo "      Não vou assinar artefato de build anterior."
  exit 1
fi
RENDERER_EMBEDDED_HASH=$(strings "$EXECUTABLE_PATH" 2>/dev/null \
  | grep -oE 'index-[A-Za-z0-9_-]{8,}\.js' | sort -u | head -1 || true)
if [[ -z "$RENDERER_EMBEDDED_HASH" ]]; then
  echo "FAIL: nenhum literal index-*.js encontrado no binário $EXECUTABLE_PATH."
  echo "      O renderer não foi embutido no executável — abortando."
  exit 1
fi
if [[ "$RENDERER_BUILT_BASENAME" != "$RENDERER_EMBEDDED_HASH" ]]; then
  echo "FAIL: divergência de renderer — o binário tem renderer VELHO."
  echo "    Built renderer:  $RENDERER_BUILT_BASENAME"
  echo "    Embedded in bin: $RENDERER_EMBEDDED_HASH"
  echo "    O cargo reusou um binário anterior sem recompilar o renderer embutido."
  echo "    Limpe o target (cargo clean) ou remova o executável e rode novamente."
  echo "    Não vou assinar artefato com renderer divergente."
  exit 1
fi
echo "✓ Renderer entregue: $RENDERER_BUILT_BASENAME (binário e dist-renderer batem)."

# ─────────────────────────────────────────────────────────────────────────────
# Local Developer ID signing (optional, macOS only).
#
# Why: Tauri's `tauri build` does NOT sign the .app with a Developer ID
# certificate by default — it only signs if you pass CSC_* env vars or use
# tauri-action with secrets. Without a Developer ID signature, macOS
# Gatekeeper blocks the app on first launch with a "cannot be opened because
# the developer cannot be verified" warning, and the user has to
# right-click → Open every time. This step signs the .app (and the DMG if
# present) with the user's Developer ID Application certificate so the
# local build behaves like a CI build for testing.
#
# Skip mechanism: set VERBOO_SKIP_LOCAL_SIGN=1 to bypass entirely (useful
# in CI or when you don't have a Developer ID cert and just want the raw
# unsigned build).
#
# Identity detection: we look for "Developer ID Application:" in the
# default keychain (login keychain). If multiple identities match, we use
# the first one returned by `security find-identity`. If none, we warn
# and continue without signing — the build is still usable, just with
# Gatekeeper warnings.
# ─────────────────────────────────────────────────────────────────────────────
if [[ "$(uname -s)" == "Darwin" && "${VERBOO_SKIP_LOCAL_SIGN:-0}" != "1" ]]; then
  # CARGO_TARGET_DIR and BUNDLE_ROOT already resolved above (pre-build snapshot).
  # `find ... | head -1` under pipefail would abort the script if $BUNDLE_ROOT
  # is missing (find exits 1, pipefail propagates, set -e kills the assignment).
  # The `|| true` guards the pipeline so a missing bundle dir is reported as
  # "no .app found" instead of silently killing the script.
  APP_PATH=$(find "$BUNDLE_ROOT" -maxdepth 1 -type d -name '*.app' 2>/dev/null | head -1 || true)

  if [[ -z "$APP_PATH" ]]; then
    echo "⚠️  Nenhum .app encontrado em $BUNDLE_ROOT — pulando assinatura local."
  else
    SIGNING_IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
      | awk -F'"' '/Developer ID Application:/ { print $2; exit }')

    if [[ -z "$SIGNING_IDENTITY" ]]; then
      echo "⚠️  Nenhuma identidade 'Developer ID Application:' encontrada na keychain."
      echo "    Pulando assinatura local — o .app ficará sem assinatura Developer ID."
      echo "    (Gatekeeper vai alertar na primeira execução. Para silenciar:"
      echo "     export VERBOO_SKIP_LOCAL_SIGN=1 ou instale um cert Developer ID.)"
    else
      echo
      echo "→ Assinando .app localmente com Developer ID…"
      echo "    Identidade: $SIGNING_IDENTITY"
      echo "    Alvo: $APP_PATH"

      # The managed Node runtime is installed under app data after first
      # launch. New packages sign only the application bundle.
      codesign --force \
        --options runtime \
        --timestamp \
        --entitlements src-tauri/Entitlements.plist \
        --sign "$SIGNING_IDENTITY" \
        "$APP_PATH" 2>&1 | sed 's/^/    /'

      # Verify.
      codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 | sed 's/^/    /'
      CODESIGN_INFO=$(codesign --display --verbose=4 "$APP_PATH" 2>&1)
      AUTHORITY=$(printf '%s\n' "$CODESIGN_INFO" | grep -F 'Authority=Developer ID Application:' | head -1)
      if [[ -z "$AUTHORITY" ]]; then
        echo "⚠️  Assinatura não mostra Authority=Developer ID Application — verifique codesign --display."
      else
        echo "    ✓ $AUTHORITY"
      fi

      # Tauri creates the DMG before this local signing block runs. Rebuild it
      # from the now-signed .app; merely signing the existing image would leave
      # the unsigned pre-signing copy of the app inside the DMG.
      # Same pipefail guard as above: `find ... | head -1` would abort under
      # set -e if $DMG_ROOT is missing.
      DMG_PATH=$(find "$DMG_ROOT" -maxdepth 1 -type f -name '*.dmg' 2>/dev/null | head -1 || true)
      if [[ -n "$DMG_PATH" ]]; then
        DMG_SCRIPT="$DMG_ROOT/bundle_dmg.sh"
        DMG_ICON="$DMG_ROOT/icon.icns"
        APP_BASENAME=$(basename "$APP_PATH")
        if [[ ! -x "$DMG_SCRIPT" ]]; then
          echo "FAIL: script de criação do DMG não encontrado: $DMG_SCRIPT"
          exit 1
        fi
        echo "→ Recriando DMG com o .app assinado…"
        rm -f "$DMG_PATH"
        (
          cd "$BUNDLE_ROOT"
          "$DMG_SCRIPT" \
            --volname "${APP_BASENAME%.app}" \
            --icon "$APP_BASENAME" 180 170 \
            --app-drop-link 480 170 \
            --window-size 660 400 \
            --hide-extension "$APP_BASENAME" \
            --volicon "$DMG_ICON" \
            "$DMG_PATH" "$APP_BASENAME"
        )
        echo "→ Assinando DMG localmente…"
        echo "    Alvo: $DMG_PATH"
        codesign --force --timestamp \
          --sign "$SIGNING_IDENTITY" \
          "$DMG_PATH" 2>&1 | sed 's/^/    /'
        codesign --verify --strict --verbose=2 "$DMG_PATH" 2>&1 | sed 's/^/    /'
        hdiutil verify "$DMG_PATH" 2>&1 | sed 's/^/    /'
      fi
    fi
  fi
fi

echo
if [[ "$TAURI_BUILD_FAILED" == "1" ]]; then
  echo "✓ Pronto com falha benigna do updater:"
  echo "    O .app e o binário foram produzidos e o renderer entregue (hash verificado),"
  echo "    mas o tarball do updater NÃO foi assinado."
  if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    echo "    Causa verificada: TAURI_SIGNING_PRIVATE_KEY ausente do ambiente."
  else
    echo "    TAURI_SIGNING_PRIVATE_KEY está definida — a causa real está no erro acima."
  fi
  echo "    AVISO: o canal de auto-update local fica inutilizável — este .app não vai"
  echo "    receber updates via updater; para atualizar, rode o script de novo."
else
  echo "✓ Pronto build OK:"
  echo "    .app, binário e tarball do updater produzidos sem erro."
fi
echo "    App: $BUNDLE_ROOT/Verboo Code.app"
echo "    DMG: $DMG_ROOT/"
