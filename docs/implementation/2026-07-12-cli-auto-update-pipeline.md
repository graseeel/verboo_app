# [CLI Auto-Update Pipeline] Implementation Plan

**Data:** 2026-07-12  
**Plano:** Ellie (SCRIBE) — baseado em `docs/effort-cli-auto-update-design.md` Entrega 2  
**Agentes:** Master Chief (Build Engineer), Geralt (Rust), Ciri (FE), Dutch (Repository Manager)

---

## For agentic workers

Worktree **já está dirty** (git status mostra múltiplos arquivos modificados fora deste escopo). Preserve alterações alheias. Nunca `git add -A` ou `git add .`. Stageie apenas paths explícitos do seu escopo. Dutch é o único que pode commit. Cada task termina com: solicitar review de Dutch + stage de paths explícitos + `git diff --cached --check` + commit local. Sem push/tag/PR.

Node sidecar é **bloqueador separado** — não implementar neste plano. Issue própria: "Empacotar Node.js sidecar por plataforma para distribuição self-contained".

---

## Goal

Tornar o CLI bundled sempre atualizável via (1) workflow diário que detecta `@verboo/code` latest e cria PR de bump para `dev`, e (2) Tauri Updater reparado com `createUpdaterArtifacts=true` + `.sig` signatures + CI gates que garantem manifests válidos. App version e CLI version são eixos independentes.

---

## Architecture

- **CLI bump:** Workflow GitHub Actions diário → detecta latest npm → PR para `dev` com dependency bump (nunca app version) → gates (test, build, effort arg, bundled CLI version, patch textual guard) → Dutch review.
- **Release:** Master Chief prepara release PR separado que bumpa app version (package.json + Cargo.toml + tauri.conf) → Dutch merge + tag → `tauri-release.yml` → builds + updater artifacts + `.sig` → publish.
- **Updater runtime:** `UpdateService` com `auto_download: true`, download em background, install no restart.

---

## Tech Stack

- GitHub Actions (YAML workflows: `cli-bump.yml`, `tauri-release.yml`)
- Rust (Tauri v2, `UpdateService`, `cli_spawn`, `lib.rs`)
- TypeScript/React (FE update UI, bridge, types)
- Node.js: `scripts/verify/generate-tauri-update-manifest.mjs`
- Markdown: `docs/updater-signing.md`
- Testes: shell (manifest/signature), `cargo test`, `vitest`

---

## Global Constraints

- CLI bump nunca altera app version. App version bump é PR separado.
- `generate-tauri-update-manifest.mjs` **copia** conteúdo de `.sig` files — nunca gera/assina signature.
- CI falha se `TAURI_SIGNING_PRIVATE_KEY` ausente ou `.sig` vazio/inexistente.
- Node sidecar não faz parte deste plano.
- Auto-update nunca interrompe turno ativo (Tauri plugin gerencia install-on-restart).

---

## Tasks

### 1. Configurar `bundle.createUpdaterArtifacts` no tauri.conf.json

- [ ] **1a. Adicionar `createUpdaterArtifacts: true`**
  - Em `src-tauri/tauri.conf.json`, dentro de `"bundle"`, adicionar:
    ```json
    "createUpdaterArtifacts": true
    ```
  - Resultado: `cargo tauri build` passa a gerar arquivos `.tar.gz` + `.sig` no diretório de saída (quando `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` estão no ambiente).

**Files:** Modify `src-tauri/tauri.conf.json`  
**Handoff:** `git add src-tauri/tauri.conf.json` → `git diff --cached --check` → solicitar review Dutch → commit local

---

### 2. Modificar `generate-tauri-update-manifest.mjs` para ler `.sig` files

- [ ] **2a. Analisar estrutura atual**
  - O script atualmente gera `signature: ""` (linha 124).
  - Precisa: para cada plataforma, localizar `*.tar.gz.sig` no `bundlesDir`, ler conteúdo, copiar para `platforms[target].signature`.

- [ ] **2b. Implementar leitura de `.sig`**
  - Após determinar o nome do bundle para cada plataforma, adicionar:
    ```javascript
    // Localizar .sig file correspondente ao bundle
    const sigFile = path.join(bundlesDir, `${basename}.sig`)
    let signature = ''
    try {
      const sigContent = await readFile(sigFile, 'utf8')
      signature = sigContent.trim()
    } catch {
      console.error(`WARNING: .sig not found or empty for ${basename}`)
      // CI step posterior falha se signature vazia
    }
    // Em vez de signature: ""
    // Atualizar a entrada da plataforma:
    output.platforms[platform] = {
      signature,
      url: `${RELEASE_URL}/${basename}`,
      // ... demais campos
    }
    ```
  - Detalhe: o formato do `.sig` gerado por `cargo tauri build` é uma string base64 (sem quebras de linha). Ler com `readFile(sigFile, 'utf8')` e `trim()`.
  - Se `.sig` não existir, `signature` fica vazia — o CI step de validação falha.

- [ ] **2c. Adicionar validação pós-geração**
  - Após gerar todos os manifests, verificar:
    ```javascript
    for (const [platform, data] of Object.entries(output.platforms)) {
      if (!data.signature || data.signature.length === 0) {
        console.error(`FATAL: ${platform} has empty signature`)
        process.exit(1)
      }
    }
    ```

**Files:** Modify `scripts/verify/generate-tauri-update-manifest.mjs`  
**Interfaces consumes:** `bundlesDir` contendo `*.tar.gz.sig` files  
**Interfaces produces:** Manifests JSON com `signature` populada  
**Handoff:** `git add scripts/verify/generate-tauri-update-manifest.mjs` → `node scripts/verify/generate-tauri-update-manifest.mjs --help` (verifica parse) → `git diff --cached --check` → solicitar review Dutch → commit local

---

### 3. Hardening do `tauri-release.yml`

- [ ] **3a. Adicionar env vars ao job `build-tauri`**
  - Garantir que `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` estejam no `env` dos jobs que executam `cargo tauri build`.

- [ ] **3b. Step de validação de secrets**
  - No job `build-tauri`, antes do build:
    ```yaml
    - name: Validate signing secrets
      shell: bash
      run: |
        if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
          echo "::error::TAURI_SIGNING_PRIVATE_KEY is not set — updater artifacts would be unsigned"
          exit 1
        fi
        if [ -z "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" ]; then
          echo "::error::TAURI_SIGNING_PRIVATE_KEY_PASSWORD is not set"
          exit 1
        fi
    ```

- [ ] **3c. Step de validação pós-build: `.sig` existe e não vazio**
  - No job `publish-updates-manifest` (ou após build):
    ```yaml
    - name: Validate updater artifacts
      shell: bash
      run: |
        shopt -s nullglob
        for sig in bundles/*.sig; do
          if [ ! -s "$sig" ]; then
            echo "::error::$sig is empty or missing"
            exit 1
          fi
          echo "OK: $(basename $sig) ($(wc -c < "$sig") bytes)"
        done
        # Validar manifests gerados
        for manifest in update-manifests/latest*.json; do
          signature=$(jq -r '.platforms | to_entries[0].value.signature // ""' "$manifest")
          if [ -z "$signature" ]; then
            echo "::error::$manifest has empty signature"
            exit 1
          fi
          echo "OK: $(basename $manifest) signature present"
        done
    ```

- [ ] **3d. Adicionar `createUpdaterArtifacts` gate**
  - Verificar se `tauri.conf.json` contém a flag:
    ```yaml
    - name: Verify createUpdaterArtifacts
      shell: bash
      run: |
        if ! jq -e '.bundle.createUpdaterArtifacts == true' src-tauri/tauri.conf.json > /dev/null; then
          echo "::error::bundle.createUpdaterArtifacts must be true"
          exit 1
        fi
    ```

**Files:** Modify `.github/workflows/tauri-release.yml`  
**Interfaces consumes:** Secrets `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`  
**Interfaces produces:** Workflow que falha se secrets/artefatos ausentes  
**Handoff:** `git add .github/workflows/tauri-release.yml` → `git diff --cached --check` → solicitar review Dutch → commit local

---

### 4. Atualizar `UpdateService` — autoDownload default true

- [ ] **4a. Mudar default `auto_download`**
  - Em `src-tauri/src/services/update_service.rs`, linha 61:
    ```rust
    auto_download: true,  // antes: false
    ```
  - Também no fallback da linha 89-92:
    ```rust
    unwrap_or(UpdateSettings {
        channel: UpdateChannel::Beta,
        auto_check: true,
        auto_download: true,  // antes: false
    })
    ```
  - Teste `configure_updates_channel_and_settings` precisa ser atualizado para `auto_download: true` (já testa com `true` explicitamente na linha 286 — não precisa mudar, mas verificar).

- [ ] **4b. Garantir que `configure` aceita o novo default**
  - Teste existente `configure_updates_channel_and_settings` (linhas 280-294) já testa `auto_download: true` explicitamente — OK.
  - Adicionar teste:
    ```rust
    #[test]
    fn new_service_auto_download_true() {
        let s = service(true);
        assert!(s.settings().auto_download);
    }
    ```
  - Comando: `cargo test new_service_auto_download_true`
  - Resultado: `ok`

**Files:** Modify `src-tauri/src/services/update_service.rs`  
**Interfaces consumes:** `UpdateSettings.auto_download`  
**Interfaces produces:** Default `auto_download: true`  
**Handoff:** `git add src-tauri/src/services/update_service.rs` → `cargo test` → `git diff --cached --check` → solicitar review Dutch → commit local

---

### 5. UI de diagnóstico de update + CLI version

- [ ] **5a. Settings > Updates — expor CLI version e source**
  - Em `src/renderer/features/settings/SettingsView.tsx`, na tab 'updates':
    - Já existe `updateSnapshot` com `currentVersion` (app version).
    - Adicionar seção "Bundled CLI":
      ```tsx
      <div className="settings-section">
        <h3>{t('settings.cliVersion')}</h3>
        <div className="settings-row">
          <span>{t('settings.cliVersionLabel')}</span>
          <span>{cliVersion ?? t('common.loading')}</span>
        </div>
        <div className="settings-row">
          <span>{t('settings.cliSourceLabel')}</span>
          <span>{cliSource === 'bundled' ? t('settings.cliSourceBundled') : cliSource === 'global' ? t('settings.cliSourceGlobal') : t('settings.cliSourceNone')}</span>
        </div>
      </div>
      ```
    - Carregar via bridge ao montar:
      ```typescript
      const [cliVersion, setCliVersion] = useState<string>('')
      const [cliSource, setCliSource] = useState<string>('')
      useEffect(() => {
        window.verboo.getBundledCliVersion().then(setCliVersion)
        window.verboo.getCliSource?.().then(setCliSource)
      }, [])
      ```

- [ ] **5b. i18n chaves**
  - EN: `'settings.cliVersion': 'Bundled CLI'`, `'settings.cliVersionLabel': 'Version'`, `'settings.cliSourceLabel': 'Source'`, `'settings.cliSourceBundled': 'Bundled'`, `'settings.cliSourceGlobal': 'Global (PATH)'`, `'settings.cliSourceNone': 'Not found'`
  - PT-BR: equivalentes traduzidos.

- [ ] **5c. Botão "Verificar agora" + progresso**
  - Já implementado parcialmente via `UpdateService` + `checkUpdate` bridge.
  - Verificar se o botão existe na SettingsView; se não, adicionar:
    ```tsx
    <button onClick={() => window.verboo.checkForUpdates?.()}>
      {t('settings.checkForUpdates')}
    </button>
    ```
  - Exibir `updateSnapshot.percent` durante download.

**Files:** Modify `src/renderer/features/settings/SettingsView.tsx`, `src/renderer/i18n.tsx`  
**Interfaces consumes:** `window.verboo.getBundledCliVersion()`, `window.verboo.getCliSource?.()`, `updateSnapshot`  
**Interfaces produces:** UI de diagnóstico  
**Handoff:** `git add src/renderer/features/settings/SettingsView.tsx src/renderer/i18n.tsx` → `npx vitest run` → `git diff --cached --check` → solicitar review Dutch → commit local

---

### 6. Criar `.github/workflows/cli-bump.yml`

- [ ] **6a. Estrutura do workflow**
  ```yaml
  name: CLI Bump
  on:
    schedule:
      - cron: '7 6 * * *'   # diário ~06:07 UTC
    workflow_dispatch:
      inputs:
        version:
          description: 'CLI version to bump to (default: npm latest)'
          required: false
          type: string

  permissions:
    contents: write
    pull-requests: write

  concurrency:
    group: cli-bump
    cancel-in-progress: false

  jobs:
    detect-and-bump:
      name: Detect and bump @verboo/code
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
          with:
            ref: dev
            fetch-depth: 0

        - uses: actions/setup-node@v4
          with:
            node-version: '22'

        - name: Detect latest CLI version
          id: detect
          shell: bash
          run: |
            if [ -n "${{ github.event.inputs.version }}" ]; then
              VERSION="${{ github.event.inputs.version }}"
            else
              VERSION=$(npm view @verboo/code version)
            fi
            echo "detected=$VERSION" >> "$GITHUB_OUTPUT"
            CURRENT=$(node -e "console.log(require('./package.json').dependencies['@verboo/code'])")
            echo "current=$CURRENT" >> "$GITHUB_OUTPUT"

        - name: Skip if same version
          if: steps.detect.outputs.detected == steps.detect.outputs.current
          run: echo "No update needed — latest is ${{ steps.detect.outputs.detected }}"

        - name: Create bump branch
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          run: |
            git config user.name "verboo-bot"
            git config user.email "noreply@code.verboo.ai"
            git checkout -b "chore/cli-bump-${{ steps.detect.outputs.detected }}"

        - name: Install exact version
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          run: |
            npm install --save-exact @verboo/code@${{ steps.detect.outputs.detected }}

        - name: Sync requirements metadata
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          shell: bash
          run: |
            node -e "
            const p = require('./requirements/macos-arm64.json');
            p.bundledComponents[0].version = '${{ steps.detect.outputs.detected }}';
            require('fs').writeFileSync('./requirements/macos-arm64.json', JSON.stringify(p, null, 2) + '\n');
            "

        - name: Gate — npm ci + dedup + copy
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          run: |
            npm ci --ignore-scripts
            node scripts/verify/dedup-cli-package.mjs
            node scripts/verify/copy-cli-resource.mjs

        - name: Gate — bundled CLI --version
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          run: |
            node src-tauri/resources/cli-package/dist/cli.mjs --version

        - name: Gate — isAutoUpdaterDisabled guard
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          shell: bash
          run: |
            if grep -q 'isAutoUpdaterDisabled' src-tauri/resources/cli-package/dist/cli.mjs; then
              echo "OK: isAutoUpdaterDisabled found"
            else
              echo "::warning::isAutoUpdaterDisabled NOT found — upstream may have removed the guard"
            fi

        - name: Gate — npm test
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          run: npm test

        - name: Gate — build renderer
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          run: npm run build:renderer

        - name: Gate — cargo test
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          run: cargo test

        - name: Version sync check
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          shell: bash
          run: |
            PKG_VER=$(node -e "console.log(require('./package.json').dependencies['@verboo/code'])")
            REQ_VER=$(node -e "console.log(require('./requirements/macos-arm64.json').bundledComponents[0].version)")
            if [ "$PKG_VER" != "$REQ_VER" ]; then
              echo "::error::Version mismatch: package.json ($PKG_VER) != requirements ($REQ_VER)"
              exit 1
            fi
            echo "OK: version sync verified"

        - name: Detect effort block
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          shell: bash
          id: effort-check
          run: |
            DETECTED="${{ steps.detect.outputs.detected }}"
            # Compare major.minor
            MAJOR=$(echo "$DETECTED" | cut -d. -f1)
            MINOR=$(echo "$DETECTED" | cut -d. -f2)
            if [ "$MAJOR" -eq 0 ] && [ "$MINOR" -lt 12 ]; then
              echo "blocked=true" >> "$GITHUB_OUTPUT"
            else
              echo "blocked=false" >> "$GITHUB_OUTPUT"
            fi

        - name: Create PR
          if: steps.detect.outputs.detected != steps.detect.outputs.current
          uses: peter-evans/create-pull-request@v7
          with:
            token: ${{ secrets.GITHUB_TOKEN }}
            base: dev
            branch: chore/cli-bump-${{ steps.detect.outputs.detected }}
            title: ${{ steps.effort-check.outputs.blocked == 'true' && format('[EFFORT_BLOCKED] chore: bump @verboo/code to {0}', steps.detect.outputs.detected) || format('chore: bump @verboo/code to {0}', steps.detect.outputs.detected) }}
            body: |
              ## Summary
              Automated CLI version bump detected by daily workflow.

              - **Previous:** ${{ steps.detect.outputs.current }}
              - **Detected:** ${{ steps.detect.outputs.detected }}

              Gates passed: npm ci, dedup+copy, bundled CLI --version,
              isAutoUpdaterDisabled guard, npm test, build renderer,
              cargo test, version sync.

              ${{ steps.effort-check.outputs.blocked == 'true' && '**⚠️ EFFORT_BLOCKED:** CLI < 0.12.0. Effort feature requires >= 0.12.0.' || '' }}

              **Reviewer:** Dutch — manual review required. No auto-merge.
            reviewers: graseeel
  ```

**Files:** Create `.github/workflows/cli-bump.yml`  
**Interfaces consumes:** `@verboo/code` npm package, `dev` branch  
**Interfaces produces:** PR para `dev` com dependency bump + CI gates  
**Handoff:** `git add .github/workflows/cli-bump.yml` → `git diff --cached --check` → solicitar review Dutch → commit local

---

### 7. Atualizar `docs/updater-signing.md`

- [ ] **7a. Adicionar seção sobre `createUpdaterArtifacts`**
  - A flag é necessária para gerar `.tar.gz` + `.sig`.
  - Adicionar instrução:
    ```markdown
    ## createUpdaterArtifacts

    O `tauri.conf.json` deve ter:
    ```json
    "bundle": {
      "createUpdaterArtifacts": true,
      ...
    }
    ```
    Sem esta flag, `cargo tauri build` não gera os bundles `.tar.gz` + `.sig` necessários para o updater.
    ```

- [ ] **7b. Adicionar seção sobre CI validation**
  - Descrever os steps de validação adicionados no `tauri-release.yml`: secrets check, `.sig` validation, manifest signature check.

**Files:** Modify `docs/updater-signing.md`  
**Handoff:** `git add docs/updater-signing.md` → `git diff --cached --check` → solicitar review Dutch → commit local

---

### 8. Testes de workflow e release smoke

- [ ] **8a. Teste manual de `generate-tauri-update-manifest.mjs`**
  - Para verificar a lógica de `.sig`, preparar ambiente de teste:
    ```bash
    mkdir -p /tmp/manifest-test/bundles
    echo "dGVzdC1zaWduYXR1cmU=" > /tmp/manifest-test/bundles/Verboo_Code_0.5.0-beta.1_aarch64_dmg.tar.gz.sig
    touch /tmp/manifest-test/bundles/Verboo_Code_0.5.0-beta.1_aarch64_dmg.tar.gz
    node scripts/verify/generate-tauri-update-manifest.mjs \
      --tag v0.5.0-beta.1 \
      --version 0.5.0-beta.1 \
      --prerelease true \
      --bundles-dir /tmp/manifest-test/bundles \
      --output /tmp/manifest-test/output
    jq '.platforms.darwin.signature' /tmp/manifest-test/output/latest-mac.json
    # Deve imprimir "dGVzdC1zaWduYXR1cmU="
    ```
  - Verificar se `.sig` vazio causa falha.

- [ ] **8b. Teste de workflow release**
  - O workflow real só roda com tag push. Para testar sem tag, usar `act` (se disponível) ou validar a sintaxe:
    ```bash
    node -e "
    const fs = require('fs');
    const wf = fs.readFileSync('.github/workflows/tauri-release.yml', 'utf8');
    // Validar que os steps de validação estão presentes
    console.log(wf.includes('TAURI_SIGNING_PRIVATE_KEY') ? 'OK: secrets check' : 'FAIL');
    console.log(wf.includes('.sig') ? 'OK: .sig validation' : 'FAIL');
    console.log(wf.includes('createUpdaterArtifacts') ? 'OK: createUpdaterArtifacts gate' : 'FAIL');
    "
    ```

- [ ] **8c. Teste de `cli-bump.yml`**
  - Validar YAML syntax:
    ```bash
    node -e "
    const fs = require('fs');
    const yaml = fs.readFileSync('.github/workflows/cli-bump.yml', 'utf8');
    const lines = yaml.split('\n').filter(l => l.trim());
    console.log('Lines: ' + lines.length);
    // Verificar estrutura básica
    if (yaml.includes('schedule') && yaml.includes('workflow_dispatch')) {
      console.log('OK: triggers present');
    }
    if (yaml.includes('npm install --save-exact')) {
      console.log('OK: --save-exact used');
    }
    if (yaml.includes('peter-evans/create-pull-request')) {
      console.log('OK: PR creation present');
    }
    "
    ```

**Files:** Nenhum (testes manuais/scripts)  
**Handoff:** N/A — executar localmente, reportar resultados a Dutch

---

## Acceptance Criteria Summary

- [ ] `tauri.conf.json` com `bundle.createUpdaterArtifacts = true`.
- [ ] `generate-tauri-update-manifest.mjs` lê `.sig` files e copia conteúdo para `signature`. Se `.sig` ausente/vazio, falha.
- [ ] `tauri-release.yml`: valida `TAURI_SIGNING_PRIVATE_KEY` presente; valida `.sig` não vazio; valida `createUpdaterArtifacts`.
- [ ] `UpdateService` default `auto_download: true`.
- [ ] UI Settings > Updates: mostra CLI version + source (bundled/global/none).
- [ ] `.github/workflows/cli-bump.yml` existe: diário + dispatch, detecta latest, PR para `dev`, 8 gates, `--save-exact`, `[EFFORT_BLOCKED]` se < 0.12.0.
- [ ] `docs/updater-signing.md` atualizado com `createUpdaterArtifacts` e CI validation.
- [ ] Testes de manifest e workflow smoke passam.
- [ ] Secrets ausentes → CI falha com erro explícito.
- [ ] Offline: app funcional sem update.
