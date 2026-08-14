# Build Installers — Windows & Linux

> Guia completo para compilar e gerar instaladores do Verboo Code Desktop.

## Pré-requisitos

### Todos os Plataformas

| Ferramenta | Versão | Instalação |
|------------|--------|------------|
| **Node.js** | 24+ | [nodejs.org](https://nodejs.org) ou via app (embarcado) |
| **Rust** | 1.89+ | `rustup` via [rustup.rs](https://rustup.rs) |
| **Git** | 2.x | [git-scm.com](https://git-scm.com) |

### Windows

| Ferramenta | Obrigatório | Instalação |
|------------|-------------|------------|
| **MSYS2** | Sim | `winget install MSYS2.MSYS2` |
| **MinGW GCC** | Sim | `pacman -S mingw-w64-x86_64-gcc mingw-w64-x86_64-toolchain` |
| **NSIS** | Automático | Baixado pelo Tauri no primeiro build |

### Linux

| Ferramenta | Obrigatório | Instalação |
|------------|-------------|------------|
| **build-essential** | Sim | `sudo apt install build-essential` |
| **libsecret** | Sim | `sudo apt install libsecret-1-dev` |
| **libwebkit2gtk** | Sim | `sudo apt install libwebkit2gtk-4.1-dev` |
| **libx11** | Sim | `sudo apt install libx11-dev` |
| **libxkbfile** | Sim | `sudo apt install libxkbfile-dev` |
| **libgbm** | Sim | `sudo apt install libgbm-dev` |
| **libasound2** | Sim | `sudo apt install libasound2-dev` |

---

## Estrutura do Projeto

```
verboo_app/
├── src/                    # Frontend (React + TypeScript + Vite)
│   ├── renderer/           # Componentes React
│   └── shared/             # Tipos compartilhados
├── src-tauri/              # Backend (Rust + Tauri v2)
│   ├── src/                # Código Rust
│   ├── binaries/           # Sidecars (verboo-ffmpeg, etc.)
│   ├── tauri.conf.json     # Configuração Tauri
│   └── Cargo.toml          # Dependências Rust
├── scripts/                # Scripts de build
├── docs/                   # Documentação
└── package.json            # Dependências npm
```

---

## Build para Desenvolvimento

### Rodar localmente (hot-reload)

```bash
# 1. Instalar dependências
npm install

# 2. Rodar em modo dev
npm run tauri:dev
```

### Build do renderer apenas

```bash
npm run build:renderer
```

---

## Build para Produção (Instalador)

### Windows (NSIS)

#### Passo 1: Instalar ferramentas

```powershell
# Instalar MSYS2
winget install MSYS2.MSYS2

# Instalar MinGW (dentro do MSYS2)
C:\msys64\usr\bin\pacman.exe -S --noconfirm mingw-w64-x86_64-gcc mingw-w64-x86_64-toolchain

# Instalar Rust
winget install Rustlang.Rustup
```

#### Passo 2: Criar sidecars dummy (opcional)

Os sidecars (verboo-ffmpeg, verboo-ffprobe, verboo-whisper) são binários auxiliares. Para builds de teste, crie executáveis dummy:

```batch
@echo off
set PATH=C:\msys64\mingw64\bin;%PATH%
cd src-tauri\binaries

echo int main(){return 0;} > dummy.c

x86_64-w64-mingw32-gcc -static -o verboo-in-chrome.exe dummy.c
x86_64-w64-mingw32-gcc -static -o verboo-ios-simulator.exe dummy.c
x86_64-w64-mingw32-gcc -static -o verboo-ffmpeg.exe dummy.c
x86_64-w64-mingw32-gcc -static -o verboo-ffprobe.exe dummy.c
x86_64-w64-mingw32-gcc -static -o verboo-whisper.exe dummy.c

REM Copiar para nomes de plataforma
copy verboo-in-chrome.exe verboo-in-chrome-x86_64-pc-windows-gnu.exe
copy verboo-in-chrome.exe verboo-in-chrome-x86_64-pc-windows-msvc.exe
copy verboo-ios-simulator.exe verboo-ios-simulator-x86_64-pc-windows-gnu.exe
copy verboo-ios-simulator.exe verboo-ios-simulator-x86_64-pc-windows-msvc.exe
copy verboo-ffmpeg.exe verboo-ffmpeg-x86_64-pc-windows-gnu.exe
copy verboo-ffmpeg.exe verboo-ffmpeg-x86_64-pc-windows-msvc.exe
copy verboo-ffprobe.exe verboo-ffprobe-x86_64-pc-windows-gnu.exe
copy verboo-ffprobe.exe verboo-ffprobe-x86_64-pc-windows-msvc.exe
copy verboo-whisper.exe verboo-whisper-x86_64-pc-windows-gnu.exe
copy verboo-whisper.exe verboo-whisper-x86_64-pc-windows-msvc.exe

del dummy.c
```

#### Passo 3: Gerar instalador

```batch
@echo off
set PATH=C:\msys64\mingw64\bin;%USERPROFILE%\.cargo\bin;%PATH%
cd C:\Projetos\verboo_app

REM Build renderer
call npm run build:renderer

REM Build Tauri (gera NSIS installer)
npx tauri build
```

**Saída:** `src-tauri\target\release\bundle\nsis\Verboo Code_0.7.2-beta_x64-setup.exe`

#### Solução de problemas Windows

| Erro | Causa | Solução |
|------|-------|---------|
| `link.exe not found` | MSVC não encontrado | Instalar VS Build Tools: `winget install Microsoft.VisualStudio.2022.BuildTools` |
| `kernel32.lib not found` | Windows SDK ausente | Instalar via VS Installer: `--add Microsoft.VisualStudio.Component.Windows11SDK.26100` |
| `link: extra operand` | Git `link.exe` conflita | Usar MSVC `link.exe` via `vcvarsall.bat` |
| `gcc.exe not found` | MinGW não instalado | Instalar MSYS2 + `pacman -S mingw-w64-x86_64-gcc` |
| `resource path doesn't exist` | Sidecars ausentes | Criar executáveis dummy (Passo 2) |

---

### Linux (DEB/RPM/AppImage)

#### Passo 1: Instalar dependências

```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y build-essential libsecret-1-dev libwebkit2gtk-4.1-dev \
  libx11-dev libxkbfile-dev libgbm-dev libasound2-dev

# Fedora/RHEL
sudo dnf install gcc-c++ make libsecret-devel libX11-devel \
  libxkbfile-devel libgbm-devel alsa-lib-devel
```

#### Passo 2: Gerar instaladores

```bash
# Instalar dependências
npm install

# Build renderer
npm run build:renderer

# Build Tauri (gera DEB, RPM, AppImage)
npx tauri build
```

**Saídas:**
- `src-tauri/target/release/bundle/deb/verboo-desktop_0.7.2-beta_amd64.deb`
- `src-tauri/target/release/bundle/rpm/verboo-desktop-0.7.2-beta.x86_64.rpm`
- `src-tauri/target/release/bundle/appimage/verboo-desktop_0.7.2-beta_amd64.AppImage`

#### Solução de problemas Linux

| Erro | Causa | Solução |
|------|-------|---------|
| `libsecret-1 not found` | libsecret ausente | `sudo apt install libsecret-1-dev` |
| `webkit2gtk not found` | WebKit ausente | `sudo apt install libwebkit2gtk-4.1-dev` |
| `pkg-config not found` | pkg-config ausente | `sudo apt install pkg-config` |

---

## Variáveis de Ambiente

### Obrigatórias

| Variável | Descrição | Exemplo |
|----------|-----------|---------|
| `VERBOO_API_KEY` | Chave API do Verboo | `vbk_pro-...` |

### Opcionais

| Variável | Descrição | Default |
|----------|-----------|---------|
| `VERBOO_FEEDBACK_ENDPOINT` | URL do backend de feedback | — |
| `VERBOO_FEEDBACK_PUBLIC_KEY` | Chave pública Supabase | — |
| `TAURI_SIGNING_PRIVATE_KEY` | Chave de assinatura para auto-update | — |

### Criar arquivo .env

```bash
# Criar .env na raiz do projeto
cat > .env << 'EOF'
VERBOO_API_KEY=vbk_sua_chave_aqui
VERBOO_FEEDBACK_ENDPOINT=https://seu-projeto.supabase.co/functions/v1/feedback
VERBOO_FEEDBACK_PUBLIC_KEY=sua_chave_publica
EOF
```

**⚠️ NUNCA commite o arquivo `.env`** — ele já está no `.gitignore`.

---

## Estrutura do Instalador

### Windows (NSIS)

O instalador NSIS:
1. Verifica pré-requisitos (Windows 10 1809+, x64)
2. Instala o app em `%LOCALAPPDATA%\Programs\verboo-desktop\`
3. Cria atalho no Menu Iniciar
4. Opcionalmente cria atalho na área de trabalho

### Linux (DEB)

O pacote DEB:
1. Instala em `/usr/bin/`
2. Cria atalho no menu de aplicações
3. Instala dependências automaticamente

### Linux (AppImage)

O AppImage:
1. Executável único, sem instalação
2. Funciona em qualquer distribuição Linux
3. Pode ser movido para qualquer local

---

## CI/CD (GitHub Actions)

O repositório inclui um workflow de release em `.github/workflows/tauri-release.yml` que:

1. Compila para 4 alvos (macOS arm64/x64, Windows x64, Linux x64)
2. Gera instaladores para cada plataforma
3. Publica no GitHub Releases

### Trigger

```bash
# Criar tag para triggerar release
git tag v0.7.2-beta
git push origin v0.7.2-beta
```

---

## Tamanho dos Instaladores

| Plataforma | Formato | Tamanho Aprox. |
|------------|---------|----------------|
| Windows x64 | NSIS `.exe` | ~15 MB |
| Linux x64 | DEB | ~15 MB |
| Linux x64 | RPM | ~15 MB |
| Linux x64 | AppImage | ~60 MB |
| macOS arm64 | DMG | ~20 MB |

---

## Checklist de Release

- [ ] Versão atualizada em `package.json` e `tauri.conf.json`
- [ ] Changelog atualizado
- [ ] Testes passando (`npm test`)
- [ ] Build de produção sem erros
- [ ] Instalador testado em ambiente limpo
- [ ] Tag criada e pushada
- [ ] Release publicado no GitHub
