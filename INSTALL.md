# Install — Verboo Code (macOS Apple Silicon)

Verboo Code is an **independent** app for Macs with **Apple Silicon (M1 or newer)**, built with Tauri v2 (Rust backend + native system WebView).
You do **not** need Node.js, npm, Homebrew, or the Verboo CLI installed. The app embeds Node.js and installs a signed compatible CLI under app-data on first use.

## Requirements

- macOS 12 (Monterey) or newer
- Apple Silicon Mac (M1, M2, M3, M4…). Intel x64 builds are available as Beta — see [README.md](README.md) for the Intel installer.

## First launch (important step)

The app is **not yet signed/notarized by Apple** (developer account in progress).
On first launch, macOS may block it with a message like:

> _"Verboo Code is damaged and can't be opened."_
> _"…can't be opened because Apple cannot check it."_

This is **expected** and does **not** mean the app is broken — it is macOS Gatekeeper protecting against unsigned apps. To unblock:

1. Move **Verboo Code.app** into the **Applications** folder (or wherever you prefer).
2. Open **Terminal** and run the command below (adjust the path if the app lives elsewhere):

   ```bash
   xattr -cr "/Applications/Verboo Code.app"
   ```

3. Open the app normally (double click).

> From then on it opens directly — the step above is needed only once.

### Alternative (without Terminal)

**Right-click** the app → **Open** → **Open** in the confirmation dialog.
If it still says "damaged", use the `xattr` method above — it is the most reliable.

## What is NOT required

- ❌ npm
- ❌ Homebrew
- ❌ System Node.js
- ❌ Global Verboo CLI (`verboo`)
- ✅ The Tauri bundle ships the Rust backend, Node.js 24.19.0, and the embedded native modules. The signed CLI bootstrap needs internet access on first use.

## First use

When the app opens, sign in with your Verboo account through the app interface. Done.

## Português (Brasil)

O Verboo Code é um app **independente** para Macs com chip **Apple Silicon (M1 ou superior)**, construído com Tauri v2 (backend Rust + WebView nativo do sistema).
Você **não** precisa de Node.js, npm, Homebrew nem do CLI global do Verboo. O app embarca o Node.js e instala um CLI assinado compatível nos dados do app no primeiro uso.

### Requisitos

- macOS 12 (Monterey) ou superior
- Mac com Apple Silicon (M1, M2, M3, M4…). Builds Intel x64 estão disponíveis como Beta — veja [README.md](README.md) para o instalador Intel.

### Primeira abertura (passo importante)

O app ainda **não é assinado/notarizado pela Apple** (conta de desenvolvedor em andamento).
Por isso, na primeira vez, o macOS pode bloquear com uma mensagem como:

> _"Verboo Code está danificado e não pode ser aberto."_
> _"…não pode ser aberto porque a Apple não pode verificá-lo."_

Isso é **esperado** e **não** significa que o app está com problema — é só o Gatekeeper do macOS
protegendo contra apps sem assinatura. Para liberar:

1. Mova o **Verboo Code.app** para a pasta **Aplicativos** (ou onde preferir).
2. Abra o **Terminal** e rode o comando abaixo (ajuste o caminho se o app estiver em outro lugar):

   ```bash
   xattr -cr "/Applications/Verboo Code.app"
   ```

3. Abra o app normalmente (duplo clique).

> A partir daí ele abre direto — o passo acima só é necessário uma vez.

#### Alternativa (sem Terminal)

Clique com o **botão direito** no app → **Abrir** → **Abrir** na janela de confirmação.
Se ainda aparecer "danificado", use o método do `xattr` acima — é o mais confiável.

### O que NÃO é necessário

- ❌ npm
- ❌ Homebrew
- ❌ Node.js do sistema
- ❌ CLI global do Verboo (`verboo`)
- ✅ O bundle Tauri já vem com backend Rust, Node.js 24.19.0 e módulos nativos. O bootstrap assinado do CLI precisa de internet no primeiro uso.

### Primeiro uso

Ao abrir, faça login com sua conta Verboo pela própria interface do app. Pronto.
