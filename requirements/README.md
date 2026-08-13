# Verboo Code Runtime Requirements

This folder documents the runtime contract for the distributed Apple Silicon build.

The app manages Node.js 24.19.0 privately under app data. System Node, npm,
Homebrew, and a globally installed `@verboo/code` CLI are not required and are
never modified.

## Supported Target

- macOS 12.0 or newer.
- Apple Silicon arm64 only.
- MacBook Air M1 and newer are in scope for the current package.

## Required Inside The App Bundle

The Tauri bundle ships:

- The Rust backend (`src-tauri/`) compiled into the native binary.
- The system WebView (WKWebView on macOS) for the frontend — no bundled Chromium.
- The local terminal module through the Rust `portable-pty` crate (Tauri terminal sidecar).
- The local terminal UI through `@xterm/xterm`.
- Image/OCR support through `sharp` and `tesseract.js`.

## Optional User Tools

Git and Apple Command Line Tools are useful when the assistant works inside real
repositories, but they are not required for the app to open, authenticate, list
models, or start a normal conversation.

Do not install or downgrade user tools automatically. If the user already has a
newer compatible dependency, leave it intact.

## First Launch

On first launch per app version, the Rust backend validates:

- macOS platform.
- arm64 CPU architecture.
- minimum macOS version.
- required bundled native packages.

Node and the signed CLI are not part of the bundle. First launch downloads the
exact Node archive from nodejs.org, verifies its pinned hash and runtime ABI,
installs it privately under app data, and only then installs the signed CLI.
Network/bootstrap failures leave Settings available and disable only
CLI-backed actions until retry.

## Manual Preflight

For internal unsigned builds, run:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"
```

To remove quarantine from an internal build that you trust:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app" --clear-quarantine
```

For public distribution, the right fix is Developer ID signing and notarization,
not asking users to clear quarantine manually.

## Português (Brasil)

Esta pasta documenta o contrato de runtime do build distribuído para Apple Silicon.

O app gerencia o Node.js 24.19.0 de forma privada nos dados do app. Node do sistema, npm, Homebrew e um CLI `@verboo/code` global não são necessários nem modificados.

### Alvo suportado

- macOS 12.0 ou superior; apenas Apple Silicon arm64 (MacBook Air M1 ou mais novo no escopo do pacote atual).

### Obrigatório dentro do bundle

O bundle Tauri inclui: backend Rust; WebView do sistema; terminal local via `portable-pty` e `@xterm/xterm`; suporte a imagem/OCR via `sharp` e `tesseract.js`.

### Ferramentas opcionais do usuário

Git e Apple Command Line Tools são úteis quando o assistente trabalha em repositórios reais, mas não são necessários para abrir o app, autenticar, listar modelos ou conversar. Não instale nem rebaixe ferramentas do usuário automaticamente.

### Primeira abertura

A cada versão, o backend Rust valida plataforma, arquitetura, versão mínima do macOS e sidecars nativos. Node e CLI não fazem parte do bundle: primeiro o runtime Node oficial é baixado, validado e instalado nos dados do app; depois o CLI assinado é instalado. Falhas de rede mantêm as configurações disponíveis e desabilitam somente ações que dependem do CLI até uma nova tentativa.

### Preflight manual

Para builds internos sem assinatura: `scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"` (adicione `--clear-quarantine` para remover a quarentena de um build confiável). Para distribuição pública, o caminho correto é assinatura Developer ID e notarização — não pedir ao usuário para limpar a quarentena manualmente.
