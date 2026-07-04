# Verboo Code Desktop

Verboo Code Desktop is an independent desktop client for working with the Verboo Code CLI from a focused app interface. It wraps the CLI-oriented workflow with project navigation, chat history, model selection, skill selection, permission controls, profile views, feedback reporting, and a macOS-friendly desktop shell.

Official CLI upstream: [verbeux-ai/code](https://github.com/verbeux-ai/code).

## Independent Build Notice

This is not an official Verboo product.

This repository is an independent build created with authorization to work on a Verboo desktop experience, but it is not developed, maintained, reviewed, endorsed, or shipped by Verboo as an official desktop product. Verboo, Verboo Code, the Verboo mascot, and related brand assets remain the property of their respective owners.

Use this app as an experimental community/independent desktop build. Expect bugs, incomplete behavior, and implementation differences from the official Verboo CLI.

## What It Does

- Runs the local `@verboo/code` CLI from an Electron desktop app.
- Detects Verboo CLI authentication or a valid Verboo API key before unlocking the app.
- Lists models available to the authenticated Verboo account when possible.
- Supports model selection and per-model context-window configuration.
- Provides project and chat organization similar to coding-assistant desktop apps.
- Supports local skill discovery and multi-skill selection in the composer.
- Supports image attachment handling, including a vision-helper fallback path when the selected model does not support vision.
- Includes a local terminal side panel for project commands.
- Includes a feedback/report-bug flow backed by Supabase, with `mailto:` fallback.

## Requirements

- macOS 12.0 or newer.
- Apple Silicon arm64 Mac. The current package targets MacBook Air M1 and newer.
- Internet access and a valid Verboo session or API key.

The packaged app is self-contained for normal use. It includes the Electron
runtime, the embedded `@verboo/code` CLI, the local terminal module, and the
image/OCR dependencies it needs to start.

Node.js, npm, Homebrew, and a global `@verboo/code` CLI are not required to run
the packaged app. If the user already has newer compatible versions of those
tools, the app leaves them untouched.

Git and Apple Command Line Tools are optional, but useful when the assistant
works inside a real repository:

```bash
git --version
xcode-select -p
```

On first launch per app version, Verboo Code runs a requirements check. It
blocks only fatal package/platform problems: non-macOS, non-arm64, unsupported
macOS version, missing embedded CLI, or missing bundled native modules. Optional
tools such as Git are warnings only.

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
npm run dev
```

Build:

```bash
npm run build
```

Package locally:

```bash
npm run package
```

Create the unsigned internal DMG/ZIP release:

```bash
npm run dist
```

Both commands force unsigned packaging for this independent build and run a
preflight that stops early if a previous `release/mac-arm64/Verboo Code.app`
is still open or a previous Verboo Code DMG is still mounted.

### GitHub Releases

Tagged releases can be built and published by GitHub Actions. The workflow builds
the macOS arm64 DMG/ZIP artifacts and publishes the updater metadata file
`latest-mac.yml`.

See [docs/release-github-actions.md](docs/release-github-actions.md).

## Feedback Backend

Feedback is sent to a Supabase Edge Function when configured:

```bash
VERBOO_FEEDBACK_ENDPOINT=https://YOUR_PROJECT.supabase.co/functions/v1/feedback
VERBOO_FEEDBACK_PUBLIC_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

If Supabase is unavailable or not configured, the app opens a prefilled email to the maintainer.

See [docs/feedback-supabase.md](docs/feedback-supabase.md).

## Security Notes

- Do not commit real Verboo API keys.
- Do not commit Supabase service-role keys.
- API keys saved in the app are encrypted locally with Electron `safeStorage`.
- Feedback diagnostics intentionally avoid sending full chat transcripts.
- Full-access mode can allow broad local machine access through the underlying CLI and should be treated as a high-trust mode.

## Open Source

The application code is released under the MIT License.

The license applies to this repository's source code. It does not grant ownership or unrestricted reuse rights over Verboo trademarks, service names, logos, mascot art, or other Verboo-owned brand assets unless the Verboo owner separately grants those rights.

See [docs/open-source-review.md](docs/open-source-review.md) for the current open-source readiness review.

---

## Português (Brasil)

Verboo Code Desktop é um cliente desktop independente para trabalhar com o CLI do Verboo Code em uma interface focada. Ele envolve o fluxo orientado por CLI com navegação de projetos, histórico de chats, seleção de modelos, seleção de habilidades, controles de permissão, perfil, envio de feedback e uma experiência desktop amigável para macOS.

CLI oficial usado como upstream: [verbeux-ai/code](https://github.com/verbeux-ai/code).

### Aviso de build independente

Este não é um produto oficial da Verboo.

Este repositório é um build independente criado com autorização para trabalhar em uma experiência desktop do Verboo, mas não é desenvolvido, mantido, revisado, endossado ou distribuído pela Verboo como produto desktop oficial. Verboo, Verboo Code, o mascote Verboo e os ativos de marca relacionados continuam sendo propriedade dos respectivos donos.

Use este app como um build experimental independente/comunitário. Espere bugs, comportamentos incompletos e diferenças de implementação em relação ao CLI oficial do Verboo.

### O que ele faz

- Executa o CLI `@verboo/code` embutido a partir de um app Electron.
- Detecta autenticação do CLI Verboo ou uma chave de API Verboo válida antes de liberar o app.
- Lista os modelos disponíveis para a conta autenticada quando possível.
- Suporta seleção de modelo e configuração de janela de contexto por modelo.
- Organiza projetos e chats em uma experiência parecida com apps desktop de assistentes de código.
- Suporta descoberta local de habilidades e seleção de múltiplas habilidades no composer.
- Suporta anexos de imagem, incluindo fallback com helper vision quando o modelo selecionado não suporta visão.
- Inclui um painel lateral de terminal local para comandos do projeto.
- Inclui fluxo de feedback/reporte de bug via Supabase, com fallback para `mailto:`.

### Requisitos

- macOS 12.0 ou mais recente.
- Mac Apple Silicon arm64. O pacote atual mira MacBook Air M1 ou mais recente.
- Acesso à internet e uma sessão Verboo válida ou chave de API.

O app empacotado é autossuficiente para uso normal. Ele inclui o runtime Electron, o CLI `@verboo/code` embutido, o módulo de terminal local e as dependências de imagem/OCR necessárias para iniciar.

Node.js, npm, Homebrew e um CLI global `@verboo/code` não são necessários para executar o app empacotado. Se o usuário já tiver versões mais recentes compatíveis dessas ferramentas, o app não altera essas instalações.

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
npm run dev
```

Build:

```bash
npm run build
```

Empacotamento local sem assinatura:

```bash
npm run package
```

Gerar DMG/ZIP interno sem assinatura:

```bash
npm run dist
```

Os dois comandos forçam empacotamento sem assinatura para este build
independente e rodam um preflight que para cedo se um
`release/mac-arm64/Verboo Code.app` anterior ainda estiver aberto ou se um DMG
anterior do Verboo Code ainda estiver montado.

### GitHub Releases

Releases versionadas podem ser construídas e publicadas pelo GitHub Actions. O
workflow gera os artefatos macOS arm64 em DMG/ZIP e publica o arquivo de
metadados `latest-mac.yml` usado pelo updater.

Veja [docs/release-github-actions.md](docs/release-github-actions.md).

### Backend de feedback

O feedback é enviado para uma Supabase Edge Function quando configurado:

```bash
VERBOO_FEEDBACK_ENDPOINT=https://YOUR_PROJECT.supabase.co/functions/v1/feedback
VERBOO_FEEDBACK_PUBLIC_KEY=YOUR_SUPABASE_PUBLISHABLE_KEY
```

Se o Supabase estiver indisponível ou não configurado, o app abre um e-mail preenchido para o mantenedor.

Veja [docs/feedback-supabase.md](docs/feedback-supabase.md).

### Segurança

- Não faça commit de chaves reais da API Verboo.
- Não faça commit de chaves Supabase service-role.
- Chaves de API salvas no app são criptografadas localmente com Electron `safeStorage`.
- Diagnósticos de feedback evitam enviar o transcript completo do chat.
- Modo livre pode permitir acesso amplo à máquina local através do CLI subjacente e deve ser tratado como modo de alta confiança.

### Open source

O código do aplicativo é distribuído sob a licença MIT.

A licença se aplica ao código-fonte deste repositório. Ela não concede propriedade nem direitos irrestritos de reutilização sobre marcas, nomes de serviço, logos, arte do mascote ou outros ativos de marca pertencentes à Verboo, exceto quando o dono da Verboo conceder esses direitos separadamente.

Veja [docs/open-source-review.md](docs/open-source-review.md) para a revisão atual de prontidão open source.
