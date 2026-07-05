# SETUP.md — Platform Guide

## macOS (Stable)

### System Requirements
- macOS 12 Monterey or newer
- Apple Silicon (M1, M2, M3, M4) arm64

### Dependencies
The packaged app is self-contained. Node.js and npm are **not required** for normal use.

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
- Terminal integration uses bundled node-pty prebuild for `darwin-arm64`.

---

## Windows (Beta)

### System Requirements
- Windows 10 build 17763 (1809) or newer
- x64 processor
- [ConPTY](https://devblogs.microsoft.com/commandline/windows-command-line-introducing-the-windows-pseudo-console-conpty/) support required for terminal integration (built into Windows 10 1809+)

### Dependencies
The packaged app is self-contained. Node.js and npm are **not required** for normal use.

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
- `safeStorage` uses Windows DPAPI — credentials are machine-specific and bound to the user account.
- Node.js detection searches `%PROGRAMFILES%\nodejs`, nvm-windows, fnm, and Volta paths.
- Terminal defaults to `powershell.exe`. If you have PowerShell Core installed, set `$env:SHELL` to `pwsh.exe` for an improved experience.
- WSL users: GUI requires WSLg (Windows 11) or a third-party X server. The terminal panel works with WSL bash if `wsl.exe` is found.

---

## Linux (Beta)

### System Requirements
- glibc 2.28+ (Ubuntu 20.04+, Debian 11+, Fedora 35+)
- x64 processor
- GNOME, KDE, or other standards-compliant desktop environment

### Dependencies
The packaged app is self-contained. Node.js and npm are **not required** for normal use.

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
- `safeStorage` requires `libsecret-1` to be installed. Without it, credentials fall back to plaintext storage (file is still `chmod 600` inside `userData`).
- To install libsecret on Debian/Ubuntu: `sudo apt-get install libsecret-1-dev`
- To install libsecret on Fedora: `sudo dnf install libsecret-devel`
- Terminal defaults to `$SHELL` or `/bin/bash`. Zsh works if installed.
- The app titlebar uses the native window manager decorations. If your WM uses CSD (client-side decorations), window controls may look different than macOS hiddenInset.
- Electron on Wayland: set `ELECTRON_OZONE_PLATFORM_HINT=wayland` for native Wayland support. XWayland fallback works by default.

---

## Cross-Platform Credential Storage

| OS | Backend | Fallback |
|----|---------|----------|
| macOS | Keychain (`/usr/bin/security`) | — |
| Windows | DPAPI (`safeStorage.encryptString`) | — |
| Linux | libsecret (`safeStorage.encryptString`) | Plaintext file (mode 0600) |

## Cross-Platform Icons

| Platform | Format | File |
|----------|--------|------|
| macOS | `.icns` | `assets/branding/verboo.icns` |
| Windows | `.ico` | `assets/branding/verboo.ico` |
| Linux | `.png` | `assets/branding/verboo.png` |

If you build on a platform where the icon file is missing, electron-builder will warn but still produce a package with a default icon.

## Cross-Platform Build Recipes

```bash
# Install dependencies (any platform)
npm install

# Development mode (any platform)
npm run dev

# Build (any platform)
npm run build

# Package for the current platform
npm run package

# Create distributable for the current platform
npm run dist

# Platform-specific release scripts
npm run release:mac:local   # macOS DMG + ZIP (unsigned)
npm run release:win:local   # Windows NSIS .exe
npm run release:linux:local # Linux AppImage + .deb
```
