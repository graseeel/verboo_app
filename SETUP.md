# SETUP.md — Platform Guide

## macOS (Stable)

### System Requirements
- macOS 12 Monterey or newer
- Apple Silicon (M1, M2, M3, M4) arm64

### Dependencies
The packaged bundle ships Node.js 24.19.0. On first launch it installs the
latest compatible signed CLI under app-data. System Node, npm, Homebrew, and a
global Verboo CLI are not required and are never modified.

For development:

```bash
# Xcode Command Line Tools (for native modules)
xcode-select --install
```

### Preflight for unsigned builds

```bash
scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"
```

### Known Issues
- Unsigned builds may be blocked by Gatekeeper. Use `--clear-quarantine` flag or Developer ID signing for distribution.
- Terminal integration uses the Rust-side `portable-pty` crate (Tauri terminal sidecar) for `darwin-arm64`.

---

## Windows (Beta)

### System Requirements
- Windows 10 build 17763 (1809) or newer
- x64 processor
- [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/) support required for terminal integration (built into Windows 10 1809+)

### Dependencies
The packaged bundle ships Node.js 24.19.0. On first launch it installs the
latest compatible signed CLI under app-data. System Node, npm, and a global
Verboo CLI are not required and are never modified.

For development:

```powershell
# Install Git for Windows
winget install Git.Git

# Install Visual Studio Build Tools (for native module compilation)
# Required: Desktop development with C++ workload
```

### Preflight for unsigned builds

```powershell
scripts/requirements/win-x64-preflight.ps1
```

### Known Issues
- Credentials are encrypted with Windows DPAPI via the Tauri keyring plugin — credentials are machine-specific and bound to the user account.
- Terminal defaults to `powershell.exe`. If you have PowerShell Core installed, set `$env:SHELL` to `pwsh.exe` for an improved experience.
- WSL users: GUI requires WSLg (Windows 11) or a third-party X server. The terminal panel works with WSL bash if `wsl.exe` is found.

---

## Linux (Beta)

### System Requirements
- glibc 2.28+ (Ubuntu 20.04+, Debian 11+, Fedora 35+)
- x64 processor
- GNOME, KDE, or other standards-compliant desktop environment

### Dependencies
The packaged bundle ships Node.js 24.19.0. On first launch it installs the
latest compatible signed CLI under app-data. System Node, npm, and a global
Verboo CLI are not required and are never modified.

For development:

```bash
# Debian / Ubuntu
sudo apt-get update
sudo apt-get install -y build-essential libsecret-1-dev libx11-dev \
  libxkbfile-dev libgbm-dev libasound2-dev

# Fedora / RHEL
sudo dnf install gcc-c++ make libsecret-devel libX11-devel \
  libxkbfile-devel libgbm-devel alsa-lib-devel
```

### Preflight for unsigned builds

```bash
scripts/requirements/linux-x64-preflight.sh
```

### Known Issues
- Credential encryption requires `libsecret-1` to be installed (used by the Tauri keyring plugin). Without it, credentials fall back to plaintext storage (file is still `chmod 600` inside the app data directory).
- To install libsecret on Debian/Ubuntu: `sudo apt-get install libsecret-1-dev`
- To install libsecret on Fedora: `sudo dnf install libsecret-devel`
- Terminal defaults to `$SHELL` or `/bin/bash`. Zsh works if installed.
- The app titlebar uses the native window manager decorations. If your WM uses CSD (client-side decorations), window controls may look different than macOS hiddenInset.
- Tauri uses the system WebKitGTK on Linux. For native Wayland support, ensure `webkit2gtk` is built with Wayland support (default on modern distros). XWayland fallback works by default.

---

## Cross-Platform Credential Storage

| OS | Backend | Fallback |
|----|---------|----------|
| macOS | Keychain (via Tauri keyring plugin) | — |
| Windows | DPAPI (via Tauri keyring plugin) | — |
| Linux | libsecret (via Tauri keyring plugin) | Plaintext file (mode 0600) |

## Cross-Platform Icons

| Platform | Format | File |
|----------|--------|------|
| macOS | `.icns` | `src-tauri/icons/icon.icns` |
| Windows | `.ico` | `src-tauri/icons/icon.ico` |
| Linux | `.png` | `src-tauri/icons/32x32.png`, `128x128.png`, `128x128@2x.png` |

If you build on a platform where the icon file is missing, `cargo tauri build` will warn but still produce a bundle with a default icon.

## Cross-Platform Build Recipes

```bash
# Install dependencies (any platform)
npm install

# Development mode (any platform) — starts Vite + cargo tauri dev
npm run tauri:dev

# Build the renderer only (TypeScript check + Vite bundle)
npm run build:renderer

# Build the full Tauri bundle for the current platform
# (renderer + Rust + verified embedded runtimes + cargo tauri build)
npm run tauri:build

# Run frontend unit tests
npm test
```

For cross-platform builds, push a tag and let the GitHub Actions matrix build each target — see [.github/workflows/tauri-release.yml](.github/workflows/tauri-release.yml).

## Português (Brasil)

### macOS (Estável)

- Requisitos: macOS 12 Monterey ou superior; Apple Silicon (M1–M4) arm64.
- O bundle embarca Node.js 24.19.0. Na primeira abertura, instala o CLI assinado compatível nos dados do app. Node, npm, Homebrew e CLI global do usuário não são necessários nem modificados.
- Para desenvolvimento: `xcode-select --install` (Command Line Tools, para módulos nativos).
- Preflight de builds sem assinatura: `scripts/requirements/macos-arm64-preflight.sh "/Applications/Verboo Code.app"`.
- Problemas conhecidos: builds sem assinatura podem ser bloqueados pelo Gatekeeper (use `--clear-quarantine` ou assinatura Developer ID para distribuição); a integração de terminal usa o crate Rust `portable-pty`.

### Windows (Beta)

- Requisitos: Windows 10 build 17763 (1809) ou superior; x64; suporte a ConPTY (embutido no 1809+).
- O bundle embarca Node.js 24.19.0. Na primeira abertura, instala o CLI assinado compatível nos dados do app. Node, npm e CLI global do usuário não são necessários nem modificados.
- Para desenvolvimento: `winget install Git.Git` e Visual Studio Build Tools (workload "Desktop development with C++").
- Preflight: `scripts/requirements/win-x64-preflight.ps1`.
- Problemas conhecidos: credenciais criptografadas com DPAPI via plugin keyring do Tauri (presas à máquina/usuário); o terminal usa `powershell.exe` por padrão (defina `$env:SHELL` como `pwsh.exe` se preferir); WSL: GUI requer WSLg (Windows 11) ou X server de terceiros.

### Linux (Beta)

- Requisitos: glibc 2.28+ (Ubuntu 20.04+, Debian 11+, Fedora 35+); x64; desktop compatível (GNOME, KDE etc.).
- O bundle embarca Node.js 24.19.0. Na primeira abertura, instala o CLI assinado compatível nos dados do app. Node, npm e CLI global do usuário não são necessários nem modificados.
- Para desenvolvimento, instale as dependências listadas na seção em inglês (`build-essential`, `libsecret-1-dev` etc.).
- Preflight: `scripts/requirements/linux-x64-preflight.sh`.
- Problemas conhecidos: criptografia de credenciais requer `libsecret-1` (sem ele, fallback em arquivo texto `chmod 600`); terminal usa `$SHELL` ou `/bin/bash`; decorações de janela seguem o window manager; o Tauri usa o WebKitGTK do sistema (Wayland nativo nas distros modernas, fallback XWayland).

### Armazenamento de credenciais, ícones e receitas de build

As tabelas e comandos das seções em inglês valem igualmente: keyring por plataforma (Keychain/DPAPI/libsecret), ícones por formato (`.icns`/`.ico`/`.png`) e as receitas `npm install`, `npm run tauri:dev`, `npm run build:renderer`, `npm run tauri:build` e `npm test`. Para builds multiplataforma, publique uma tag e deixe a matriz do GitHub Actions construir cada alvo — veja [.github/workflows/tauri-release.yml](.github/workflows/tauri-release.yml).
