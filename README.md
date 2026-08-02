# Verboo Code Desktop

Verboo Code Desktop is an independent desktop client for working with the Verboo Code CLI from a focused app interface. It wraps the CLI-oriented workflow with project navigation, chat history, model selection, skill selection, permission controls, profile views, feedback reporting, and a desktop shell that runs on macOS, Windows, and Linux.

The desktop shell is built with **Tauri v2** (Rust backend + system WebView frontend) and ships a bundled `cli-package` sidecar (the `@verboo/code` CLI, which requires Node.js ≥22 on the host).

Official CLI upstream: [verbeux-ai/code](https://github.com/verbeux-ai/code).

## Screenshots

| | |
|:---:|:---:|
| ![Verboo Code welcome screen with the prompt "Em que devemos trabalhar agora?"](docs/screenshots/welcome.png) | ![The agent streaming a full design plan with color tokens, typography choices, and executed commands](docs/screenshots/agent-working.png) |
| **Welcome** · Tela inicial<br>Start a chat or open a project in one step | **Agent at work** · Modelo trabalhando<br>Design plan, color tokens, and live command steps |
| ![The Verboo mascot pet sitting in the sidebar while the agent keeps working](docs/screenshots/pet.png) | ![Video understanding consent modal over a blurred workspace, disclosing exactly what is sent](docs/screenshots/video-consent.png) |
| **Pet** · Mascote invocável<br>Company in the sidebar while the agent works | **Video understanding** · Compreensão de vídeo<br>Explicit consent disclosing the exact route before analysis |

## Platform Support

| Platform | Architecture | Status | Installer |
|----------|--------------|--------|-----------|
| macOS | arm64 (Apple Silicon) | Stable | DMG, `.app` |
| macOS | x64 (Intel) | Beta | DMG, `.app` |
| Windows | x64 | Beta | NSIS `.exe` |
| Linux | x64 | Beta | AppImage, `.deb`, `.rpm` |

The packaged bundle ships the Rust backend, the embedded `cli-package` (the
Verboo CLI plus its Node dependency closure), and the image/OCR dependencies it
needs to start. The bundled CLI is JavaScript and runs on a system Node.js
runtime (≥22.0.0). The macOS, Linux, and Windows installers do not ship a Node
runtime — the app resolves Node from the system (Homebrew, nvm, fnm, Volta, or
PATH).

For per-platform setup, known issues, and troubleshooting, see
[SETUP.md](SETUP.md).

## Independent Build Notice

This is not an official Verboo product.

This repository is an independent build created with authorization to work on a Verboo desktop experience, but it is not developed, maintained, reviewed, endorsed, or shipped by Verboo as an official desktop product. Verboo, Verboo Code, the Verboo mascot, and related brand assets remain the property of their respective owners.

Use this app as an experimental community/independent desktop build. Expect bugs, incomplete behavior, and implementation differences from the official Verboo CLI.

## What It Does

- Runs the bundled Verboo CLI (`cli-package` sidecar) from a Tauri v2 desktop app with a Rust backend.
- Detects Verboo CLI authentication or a valid Verboo API key before unlocking the app.
- Lists models available to the authenticated Verboo account when possible.
- Supports model selection and per-model context-window configuration.
- Provides project and chat organization similar to coding-assistant desktop apps.
- Supports local skill discovery and multi-skill selection in the composer.
- Supports image attachment handling, including a vision-helper fallback path when the selected model does not support vision.
- Includes a local terminal side panel for project commands.
- Includes a feedback/report-bug flow backed by Supabase, with `mailto:` fallback.
- **Embedded browser panel** with multi-tab navigation, hide/restore, an 8-tab
  live cap with eviction, and a User-Agent override on macOS and Linux so web
  apps see a current browser identity. Windows (WebView2/Chromium) keeps its
  default UA, which already reports a modern identity; the Linux override is
  defensive and not yet verified on a real Linux machine.
- **Transcript annotations** — select any passage of the assistant's reply,
  capture a private comment, and send it as the next user message in turn
  order.
- **Media sidecars** — `verboo-ffmpeg`, `verboo-ffprobe`, and `verboo-whisper`
  are bundled per platform for video/audio understanding without external
  installs.
- **Chrome extension** (`extensions/verboo-chrome`, v0.2.1) — bridges the
  browser's active tab into the desktop app via native messaging.

## Requirements

- A supported desktop platform:
  - macOS 12.0 or newer (Apple Silicon arm64, Intel x64)
  - Windows 10 1809 or newer (x64)
  - Linux x64 with glibc 2.28+ (Ubuntu 20.04+, Debian 11+, Fedora 35+)
- Internet access and a valid Verboo session or API key.

The packaged bundle ships the Rust backend, the embedded `cli-package` (Verboo
CLI + Node dependency closure), and the image/OCR dependencies it needs to
start. The bundled CLI is JavaScript and runs on a system Node.js (≥22.0.0).

npm, Homebrew, and a global `@verboo/code` CLI are not required to run the
packaged app. The app resolves Node from the system (Homebrew, nvm, fnm,
Volta, or PATH) and leaves user-installed Node untouched. If the user already
has newer compatible versions of those tools, the app leaves them untouched.

Git is optional, but useful when the assistant works inside a real repository.

On first launch per app version, Verboo Code runs a requirements check. It
blocks only fatal package/platform problems: missing embedded CLI, or missing
bundled native modules. Optional tools such as Git are warnings only.

See [requirements/README.md](requirements/README.md) for the full runtime
contract.

### Internal Unsigned Builds

Unsigned/ad-hoc builds are for internal testing. They can be blocked by
Gatekeeper on another Mac with messages such as "damaged" or "cannot verify the
developer". For public distribution, use Developer ID signing and notarization.

For an internal build that you trust, you can run the preflight script:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"
```

If macOS quarantine is blocking a trusted internal build:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app" --clear-quarantine
```

## Development

```bash
npm install
npm run tauri:dev
```

Build the renderer (TypeScript check + Vite bundle):

```bash
npm run build:renderer
```

Build the full Tauri bundle (renderer + Rust + cli-package copy):

```bash
npm run tauri:build
```

The `tauri:build` script runs `build:tauri-deps` (dedup the cli-package, copy
it into `src-tauri/resources/cli-package/`, and build the renderer) and then
`cargo +1.89.0 tauri build`. The resulting `.app`/`.dmg`/`.exe`/`.AppImage`/`.deb`/`.rpm`
artifacts land in `src-tauri/target/release/bundle/`.

### GitHub Releases

Tagged releases are built and published by GitHub Actions in
`.github/workflows/tauri-release.yml`. The workflow runs a 4-target matrix and
publishes:

- macOS arm64: `.app`, `.dmg`
- macOS x64: `.app`, `.dmg`
- Windows x64: NSIS `.exe`
- Linux x64: `.AppImage`, `.deb`, `.rpm`

The Tauri updater downloads a per-release `latest.json` manifest and verifies
each update bundle against the public key in `src-tauri/tauri.conf.json`.

> **macOS signing status:** Current builds are ad-hoc signed. They can be tested
> locally, but macOS Gatekeeper and update installation are significantly more
> reliable after Developer ID signing and notarization. The updater code is
> designed to keep working when signing is enabled later.

See [.github/workflows/tauri-release.yml](.github/workflows/tauri-release.yml)
for the active release pipeline; the updater key and endpoints live in
[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) under `plugins.updater`.

## Feedback Backend

Feedback is sent to a Supabase Edge Function when configured:

```bash
VERBOO_FEEDBACK_ENDPOINT=https://YOUR_PROJECT.supabase.co/functions/v1/feedback
VERBOO_FEEDBACK_PUBLIC_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

If Supabase is unavailable or not configured, the app opens a prefilled email to the maintainer.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the feedback backend layout.

## Security Notes

- Do not commit real Verboo API keys.
- Do not commit Supabase service-role keys.
- API keys saved in the app are encrypted locally with the OS credential store (macOS Keychain, Windows DPAPI, Linux libsecret) via the Tauri keyring plugin.
- Feedback diagnostics intentionally avoid sending full chat transcripts.
- Full-access mode can allow broad local machine access through the underlying CLI and should be treated as a high-trust mode.

## Open Source

The application code is released under the MIT License.

The license applies to this repository's source code. It does not grant ownership or unrestricted reuse rights over Verboo trademarks, service names, logos, mascot art, or other Verboo-owned brand assets unless the Verboo owner separately grants those rights.

---

## Português (Brasil)

Verboo Code Desktop é um cliente desktop independente para trabalhar com o CLI do Verboo Code em uma interface focada. Ele envolve o fluxo orientado por CLI com navegação de projetos, histórico de chats, seleção de modelos, seleção de habilidades, controles de permissão, perfil, envio de feedback e uma experiência desktop amigável para macOS.

O shell desktop é construído com **Tauri v2** (backend Rust + WebView nativo do sistema) e embarca um sidecar `cli-package` (o CLI `@verboo/code`, que precisa de Node.js ≥22 no host).

CLI oficial usado como upstream: [verbeux-ai/code](https://github.com/verbeux-ai/code).

### Aviso de build independente

Este não é um produto oficial da Verboo.

Este repositório é um build independente criado com autorização para trabalhar em uma experiência desktop do Verboo, mas não é desenvolvido, mantido, revisado, endossado ou distribuído pela Verboo como produto desktop oficial. Verboo, Verboo Code, o mascote Verboo e os ativos de marca relacionados continuam sendo propriedade dos respectivos donos.

Use este app como um build experimental independente/comunitário. Espere bugs, comportamentos incompletos e diferenças de implementação em relação ao CLI oficial do Verboo.

### O que ele faz

- Executa o CLI Verboo embutido (sidecar `cli-package`) a partir de um app Tauri v2 com backend Rust.
- Detecta autenticação do CLI Verboo ou uma chave de API Verboo válida antes de liberar o app.
- Lista os modelos disponíveis para a conta autenticada quando possível.
- Suporta seleção de modelo e configuração de janela de contexto por modelo.
- Organiza projetos e chats em uma experiência parecida com apps desktop de assistentes de código.
- Suporta descoberta local de habilidades e seleção de múltiplas habilidades no composer.
- Suporta anexos de imagem, incluindo fallback com helper vision quando o modelo selecionado não suporta visão.
- Inclui um painel lateral de terminal local para comandos do projeto.
- Inclui fluxo de feedback/reporte de bug via Supabase, com fallback para `mailto:`.
- **Painel de navegador embutido** com navegação multi-aba, esconder/restaurar,
  teto de 8 abas ativas com despejo e User-Agent próprio no macOS e no Linux,
  para que apps web vejam uma identidade de navegador atual. O Windows
  (WebView2/Chromium) mantém o UA default, que já reporta identidade moderna;
  o override do Linux é defensivo e ainda não foi verificado em máquina Linux
  real.
- **Anotações no transcript** — selecione qualquer trecho da resposta do
  assistente, capture um comentário privado e envie como a próxima mensagem
  do usuário, na ordem da conversa.
- **Sidecars de mídia** — `verboo-ffmpeg`, `verboo-ffprobe` e `verboo-whisper`
  são embarcados por plataforma para compreensão de vídeo e áudio sem
  instalação externa.
- **Extensão do Chrome** (`extensions/verboo-chrome`, v0.2.1) — conecta a aba
  ativa do navegador ao app desktop via native messaging.

### Requisitos

- macOS 12.0 ou mais recente.
- Mac Apple Silicon arm64 (build Intel x64 disponível como beta).
- Acesso à internet e uma sessão Verboo válida ou chave de API.

O bundle Tauri embarca o backend Rust, o `cli-package` (CLI Verboo + closure de dependências Node) e as dependências de imagem/OCR necessárias para iniciar. O CLI embutido é JavaScript e roda em um Node.js de sistema (≥22.0.0) — npm, Homebrew e um CLI global `@verboo/code` não são necessários. O app resolve o Node pelo sistema (Homebrew, nvm, fnm, Volta ou PATH) e não altera Node instalado pelo usuário. Se o usuário já tiver versões mais recentes compatíveis dessas ferramentas, o app não altera essas instalações.

Git e Apple Command Line Tools são opcionais, mas úteis quando o assistente trabalha dentro de um repositório real:

```bash
git --version
xcode-select -p
```

No primeiro início por versão do app, o Verboo Code roda uma checagem de requisitos. Ele bloqueia apenas problemas fatais de pacote/plataforma: não ser macOS, não ser arm64, versão de macOS incompatível, CLI embutido ausente ou módulos nativos empacotados ausentes. Ferramentas opcionais como Git geram apenas avisos.

Veja [requirements/README.md](requirements/README.md) para o contrato completo de runtime.

### Builds internos sem assinatura

Builds sem assinatura/ad-hoc são para testes internos. Eles podem ser bloqueados pelo Gatekeeper em outro Mac com mensagens como "damaged" ou "cannot verify the developer". Para distribuição pública, use assinatura Developer ID e notarização.

Para um build interno confiável, rode o script de preflight:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"
```

Se a quarentena do macOS estiver bloqueando um build interno confiável:

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app" --clear-quarantine
```

### Desenvolvimento

```bash
npm install
npm run tauri:dev
```

Build do renderer (checagem TypeScript + bundle Vite):

```bash
npm run build:renderer
```

Build do bundle Tauri completo (renderer + Rust + cópia do cli-package):

```bash
npm run tauri:build
```

O script `tauri:build` roda `build:tauri-deps` (dedup do cli-package, cópia
para `src-tauri/resources/cli-package/` e build do renderer) e depois
`cargo +1.89.0 tauri build`. Os artefatos `.app`/`.dmg`/`.exe`/`.AppImage`/`.deb`/`.rpm`
ficam em `src-tauri/target/release/bundle/`.

### GitHub Releases

Releases versionadas são construídas e publicadas pelo GitHub Actions em
`.github/workflows/tauri-release.yml`. O workflow roda uma matriz de 4 alvos e
publica:

- macOS arm64: `.app`, `.dmg`
- macOS x64: `.app`, `.dmg`
- Windows x64: NSIS `.exe`
- Linux x64: `.AppImage`, `.deb`, `.rpm`

O updater do Tauri baixa um manifesto `latest.json` por release e verifica cada
bundle de atualização contra a chave pública em `src-tauri/tauri.conf.json`.

> **Status de assinatura macOS:** Os builds atuais são assinados como ad-hoc.
> Eles funcionam para teste local, mas o Gatekeeper e a instalação de
> atualizações são significativamente mais confiáveis após assinatura Developer
> ID e notarização. O código do updater foi projetado para continuar funcionando
> quando a assinatura for ativada.

Veja [.github/workflows/tauri-release.yml](.github/workflows/tauri-release.yml)
para o pipeline de release ativo; a chave e os endpoints do updater ficam em
[src-tauri/tauri.conf.json](src-tauri/tauri.conf.json) em `plugins.updater`.

### Backend de feedback

O feedback é enviado para uma Supabase Edge Function quando configurado:

```bash
VERBOO_FEEDBACK_ENDPOINT=https://YOUR_PROJECT.supabase.co/functions/v1/feedback
VERBOO_FEEDBACK_PUBLIC_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Se o Supabase estiver indisponível ou não configurado, o app abre um e-mail preenchido para o mantenedor.

Veja [CONTRIBUTING.md](CONTRIBUTING.md) para a estrutura do backend de feedback.

### Segurança

- Não faça commit de chaves reais da API Verboo.
- Não faça commit de chaves Supabase service-role.
- Chaves de API salvas no app são criptografadas localmente com o credential store do sistema (Keychain no macOS, DPAPI no Windows, libsecret no Linux) via o plugin Tauri keyring.
- Diagnósticos de feedback evitam enviar o transcript completo do chat.
- Modo livre pode permitir acesso amplo à máquina local através do CLI subjacente e deve ser tratado como modo de alta confiança.

### Open source

O código do aplicativo é distribuído sob a licença MIT.

A licença se aplica ao código-fonte deste repositório. Ela não concede propriedade nem direitos irrestritos de reutilização sobre marcas, nomes de serviço, logos, arte do mascote ou outros ativos de marca pertencentes à Verboo, exceto quando o dono da Verboo conceder esses direitos separadamente.
