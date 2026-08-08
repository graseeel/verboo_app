# Verboo Code Runtime Requirements

This folder documents the runtime contract for the distributed Apple Silicon build.

The packaged app requires Node.js (≥22.0.0) on the host. The installer does not
ship a Node runtime — Node is resolved from Homebrew, nvm, fnm, Volta, or PATH.
npm, Homebrew, and a globally installed `@verboo/code` CLI are not required.

Note: `macos-arm64.json` in this same directory has always listed Node.js as
`required: true` — the JSON contract was honest even when this prose was not.

## Supported Target

- macOS 12.0 or newer.
- Apple Silicon arm64 only.
- MacBook Air M1 and newer are in scope for the current package.

## Required Inside The App Bundle

The Tauri bundle ships:

- The Rust backend (`src-tauri/`) compiled into the native binary.
- The system WebView (WKWebView on macOS) for the frontend — no bundled Chromium.
- The embedded `cli-package` (the Verboo CLI plus its Node dependency closure) under `src-tauri/resources/cli-package/`.
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
- embedded Verboo CLI availability (the `cli-package` resource is present and runnable on the system Node runtime).
- required bundled native packages.

Fatal failures show a blocking dialog and the app exits. Optional tool gaps are
warnings only.

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

O app empacotado requer Node.js (≥22.0.0) no host. O instalador não embarca runtime Node — o Node é resolvido via Homebrew, nvm, fnm, Volta ou PATH. npm, Homebrew e um CLI `@verboo/code` global não são necessários.

Nota: o `macos-arm64.json` neste mesmo diretório sempre listou Node.js como `required: true` — o contrato JSON foi honesto mesmo quando este texto não.

### Alvo suportado

- macOS 12.0 ou superior; apenas Apple Silicon arm64 (MacBook Air M1 ou mais novo no escopo do pacote atual).

### Obrigatório dentro do bundle

O bundle Tauri inclui: o backend Rust compilado no binário nativo; o WebView do sistema (WKWebView) para o frontend — sem Chromium embutido; o `cli-package` embutido (CLI Verboo + dependências Node) em `src-tauri/resources/cli-package/`; o terminal local via crate Rust `portable-pty` e UI via `@xterm/xterm`; suporte a imagem/OCR via `sharp` e `tesseract.js`.

### Ferramentas opcionais do usuário

Git e Apple Command Line Tools são úteis quando o assistente trabalha em repositórios reais, mas não são necessários para abrir o app, autenticar, listar modelos ou conversar. Não instale nem rebaixe ferramentas do usuário automaticamente.

### Primeira abertura

A cada versão, o backend Rust valida na primeira abertura: plataforma macOS; arquitetura arm64; versão mínima do macOS; disponibilidade do CLI embutido; pacotes nativos obrigatórios. Falhas fatais mostram um diálogo bloqueante e o app encerra; lacunas opcionais são apenas avisos.

### Preflight manual

Para builds internos sem assinatura: `scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"` (adicione `--clear-quarantine` para remover a quarentena de um build confiável). Para distribuição pública, o caminho correto é assinatura Developer ID e notarização — não pedir ao usuário para limpar a quarentena manualmente.
