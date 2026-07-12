# Effort Dinâmico + CLI Auto-Update — Design Specification

**Data:** 2026-07-12  
**Autor:** Ellie (SCRIBE)  
**Maestro:** Codex  
**Ownership:** Especificação — Ellie. Implementação — Geralt (Rust), Ciri (FE), Aloy (QA), Master Chief (Build Engineer), Dutch (Repository Manager).

---

## Índice

1. [Contexto e Problemas Identificados](#1-contexto-e-problemas-identificados)
2. [Objetivos e Não-Objetivos](#2-objetivos-e-não-objetivos)
3. [Entrega 1 — Effort Dinâmico e UI Aprovada](#3-entrega-1--effort-dinâmico-e-ui-aprovada)
   - 3.1 Fontes de Dados
   - 3.2 Regra de Resolução
   - 3.3 Arquitetura de Componentes
   - 3.4 Fluxo de Dados
   - 3.5 Estados e Falhas
   - 3.6 Migração (localStorage → UserSettings)
4. [Entrega 2 — CLI Sempre Atualizado](#4-entrega-2--cli-sempre-atualizado)
   - 4.1 Arquitetura Geral
   - 4.2 Workflow Diário de CLI Update
   - 4.3 Auto-Update do App (Tauri Updater)
   - 4.4 Reparo do Updater
   - 4.5 Gates de CI
   - 4.6 Diagnóstico de Versão
   - 4.7 Offline, Rollback e Matriz de Compatibilidade
   - 4.8 Node Sidecar (bloqueador separado)
5. [Riscos Atuais](#5-riscos-atuais)
6. [Ownership por Agente](#6-ownership-por-agente)
7. [Critérios de Aceitação](#7-critérios-de-aceitação)
8. [Estratégia de Testes](#8-estratégia-de-testes)
9. [Self-Review](#9-self-review)

---

## 1. Contexto e Problemas Identificados

### 1.1 Cadeia de Esforço (Effort)

O Verboo Router expõe `model.reasoning` com `effortLevels: string[]` e `defaultEffort`. O FE já consome esse campo (promovido por `extract_reasoning` no Rust), mas:

- **CLI 0.10.6 não tem lógica dinâmica Verboo.** Os métodos `getVerbooModelReasoning`/`getVerbooReasoningEffort` não existem. `modelSupportsMaxEffort` faz downgrade de `max` em modo Verboo. A versão 0.12.0 (confirmada como latest no npm registry) implementa ambos — a cadeia dinâmica de effort só funciona com CLI >= 0.12.0.
- **Preferência duplicada:** FE salva em `localStorage('verboo:effort-by-model')`; Rust `UserSettings.effort_by_model` existe mas não é a fonte única.
- **UI atual:** setas `ChevronRight` + submenus por linha no model selector + footer duplicado. Altura instável; nenhum "Usar padrão" discreto.
- **Teste end-to-end ausente:** sem prova de que `--effort` chega ao provider (Gate C — obrigatório para release).

### 1.2 Cadeia de CLI Versionamento

- **CLI bundlado fixo em 0.10.6.** `@verboo/code` em `package.json`. `copy-cli-resource.mjs` copia de `node_modules/`. Para atualizar, precisa de PR manual + rebuild.
- **Patch textual removido:** `copy-cli-resource.mjs` (linha 182) fazia replace de `autoUpdateCliInBackground` no `cli.mjs`. CLI 0.12.0 confirma que `autoUpdateCliInBackground` chama `isAutoUpdaterDisabled()`, que honra `DISABLE_AUTOUPDATER`. O patch textual foi substituído por `protect_user_cli_env` com `DISABLE_AUTOUPDATER=1` em `cli_spawn.rs`. Teste CI prova que o upstream contém/honra `isAutoUpdaterDisabled`; se uma versão futura remover o guard, o CLI bump PR falha (sem reaplicação silenciosa).
- **Updater signature vazia:** `generate-tauri-update-manifest.mjs` (linha 124) gera `"signature": ""`. `tauri-plugin-updater` verifica a signature contra a pubkey; signature vazia faz o update falhar em produção.
- **Node sidecar incompleto:** o app depende de Node runtime do sistema (PATH) para executar o bundled CLI. Docs atuais (README, SETUP, INSTALL) prometem que Node não é necessário — essa promessa é falsa enquanto o sidecar não existir.
- **Sem CI gates para:** esforço end-to-end, manifest/signature, CLI bundled --version, contract models/reasoning.

---

## 2. Objetivos e Não-Objetivos

### Objetivos

1. **Effort dinâmico funcional**: usuário seleciona nível, nível chega ao provider (CLI 0.12.0+), UI aprovada B. Inclui prova Gate C (Router/provider) como requisito de release.
2. **Fonte única de preferência**: `UserSettings.effortByModel` no Rust; localStorage removido após migração.
3. **CLI sempre atualizado**: workflow diário detecta `@verboo/code` latest, cria PR para `dev`; app auto-update com Tauri Updater.
4. **Updater reparado**: `bundle.createUpdaterArtifacts=true`, manifests com signature via `.sig` files; CI falha se secrets/artefatos ausentes.
5. **Gates de CI**: effort arg test, bundled CLI, manifest/signature, contract.

### Não-Objetivos (fora de escopo)

- ❌ Instalar/baixar `npm latest` dentro do app runtime.
- ❌ Mutar `.app` bundle em runtime (`/Applications/Verboo Code.app`).
- ❌ Substituir Tauri Updater por update mechanism próprio.
- ❌ Node sidecar empacotado por plataforma (bloqueador separado — ver 4.8).
- ❌ Auto-update interno do CLI que altere instalação global do usuário.
- ❌ Runtime CLI em appData (roadmap futuro).

---

## 3. Entrega 1 — Effort Dinâmico e UI Aprovada

### 3.1 Fontes de Dados

| Fonte | Propósito | Exemplo (ilustrativo) |
|---|---|---|
| Router `model.reasoning.effortLevels` | Níveis disponíveis | `["none","low","medium","high","max"]` |
| Router `model.reasoning.defaultEffort` | Fallback sem preferência | `"medium"` |
| `UserSettings.effortByModel` | Preferência persistida do usuário | `{"ultra/glm-5.2": "high"}` |
| `VerbooModel.reasoning` (promovido) | FE lê daqui primeiro | `{ effortLevels: [...], defaultEffort: string }` |
| `model.raw?.reasoning` | Fallback backward-compat | Mesma shape |

**Nenhum ID de modelo ou lista de níveis hardcoded.** O Router é a fonte da verdade.

### 3.2 Regra de Resolução

```
reasoning = getModelReasoning(model)

// saved = preferência do usuário, pode ser qualquer string inclusive "none"
saved = effortByModel[model.id]

// validOverride: saved só é válido se está entre os effortLevels do modelo
validOverride = saved && reasoning.effortLevels.includes(saved) ? saved : undefined

// displayEffort: o que a UI mostra (para exibição no pill e footer)
displayEffort = validOverride ?? reasoning.defaultEffort

// requestEffort: o que é enviado ao CLI via --effort (ou undefined = sem flag)
requestEffort = validOverride   // undefined se não há override
```

**Conceitos chave (separação explícita):**
- `validOverride`: `undefined` ou valor que está em `effortLevels`. Inclui `"none"`.
- `displayEffort`: sempre definido se modelo tem `defaultEffort`. Usado para exibição.
- `requestEffort`: só definido quando há override. Se `undefined`, CLI usa default **do modelo/Router** (nenhuma flag `--effort` é passada).
- `saved='none'` é **nível real**: deve passar `--effort none`. Nunca tratar `none` como ausência/default.
- "Usar padrão" remove entrada do `effortByModel` → `validOverride` vira `undefined` → `requestEffort` vira `undefined`.

**Regra de envio ao CLI:**
- `requestEffort === undefined` → não passar `--effort` (CLI/Router aplica default do modelo).
- `requestEffort === "none"` → passar `--effort none` (nível real; override explícito para "nenhum esforço").
- `requestEffort` é qualquer outro nível em `effortLevels` → passar `--effort <nível>`.

**Regra aprovada (Maestro):** sem preferência válida, usar `defaultEffort` informado pelo CLI/Router. **Nunca forçar `max`.**

### 3.3 Arquitetura de Componentes

```
App.tsx
 ├─ UserSettings.effortByModel  (fonte única, via bridge Rust → FE)
 ├─ handleEffortSelect(modelId, effort)
 │    └─ atualiza UserSettings (NÃO localStorage)
 │    └─ se modelId !== selectedModel → seleciona modelo também
 ├─ validOverride (memo: effortByModel[selectedModel] se em effortLevels)
 ├─ displayEffort (memo: validOverride ?? defaultEffort)
 ├─ requestEffort (memo: validOverride)
 └─ ModelSelector
      ├─ effortByModel prop
      ├─ selectedEffortLevels prop (do modelo selecionado)
      ├─ selectedEffort prop (displayEffort)
      ├─ onSelectEffort callback
      ├─ footer: título "Nível de raciocínio"
      │    + botões renderizados via effortLevels.map() com label i18n
      │    + ação "Usar padrão" (visible apenas se validOverride existe)
      └─ footer oculto se modelo sem effort (effortLevels vazio/undefined)
```

**Design Aprovado B (mudanças em relação ao atual):**
- Estado atual: cada modelo com suporte a effort tem `ChevronRight` + submenu dropdown + há também um footer duplicado no rodapé do menu.
- **Design B:** remover `ChevronRight` + submenu por linha (`model-option-effort-arrow` + `model-effort-submenu`). Manter apenas o footer fixo único no rodapé do menu de modelos.
- Footer: título i18n `composer.effortFooterTitle`, seguido de um botão por nível via `effortLevels.map()`. Rótulos: usar i18n para níveis conhecidos (`none→composer.effortNone`, `low→composer.effortLow`, etc.); níveis desconhecidos recebem Title Case automático. Ação "Usar padrão" (label i18n `composer.effortUseDefault`) só visível quando `validOverride` existe.
- Footer oculto completamente se modelo selecionado não tem `effortLevels` ou lista vazia.
- Altura da lista de modelos é estável (footer não varia por modelo selecionado **dentro do mesmo modelo**, mas muda entre modelos com diferentes quantidades de níveis — isso é esperado e aceito).
- Pill do composer continua: `<modelo> · <nível>` (sem mudar geometria). O nível exibido é `displayEffort`.
- "Usar padrão": ao clicar, `handleEffortSelect(modelId, undefined)` → Rust remove entrada do `effort_by_model`. Footer passa a mostrar `defaultEffort` como seleção default.
- Teclado: navegação por Tab entre níveis.
- Responsive: footer empilha verticalmente em largura < 320px.

#### Seleção visual no footer

O footer sempre mostra `displayEffort` como o nível ativo. Existem duas situações visuais:

- **Override ativo** (`validOverride` definido): o nível correspondente a `validOverride` aparece com estilo de seleção (ex.: cor de destaque, checkmark). Botão "Usar padrão" visível.
- **Sem override** (somente `defaultEffort`): o nível correspondente a `defaultEffort` aparece como **seleção default** — visualmente distinto de não-selecionado (ex.: leve destaque ou borda), mas SEM o estilo de override (sem checkmark, sem cor de destaque forte). "Usar padrão" oculto.

A distinção visual entre "seleção default" e "override" é responsabilidade do CSS (classes diferentes como `.effort-default` e `.effort-override`).

### 3.4 Fluxo de Dados

```
Router → raw.reasoning
  → extract_reasoning() [Rust]
    → VerbooModel.reasoning [promovido]
      → FE recebe via model_discovery bridge
        → App.tsx calcula displayEffort / requestEffort
          → AgentTurnRequest.effort = requestEffort (se definido)
            → Rust turn_service monta args: --effort <nível> (se requestEffort definido)
              → CLI 0.12.0+ aceita --effort, implementa getVerbooReasoningEffort
                → deve chegar ao provider; Gate C confirma (ver 8.1)
```

O fluxo termina no provider apenas se Gate C for aprovado. Sem Gate C, a cadeia é verificada até o CLI (Gates A + B) mas a prova no provider é pendente.

### 3.5 Estados e Falhas

| Estado | Comportamento |
|---|---|
| Modelo sem `reasoning.effortLevels` | Footer inteiro oculto. `displayEffort` = `undefined`. Pill mostra só modelo. |
| Modelo com `effortLevels` vazio `[]` | Mesmo que sem effort. Footer oculto. |
| `effortByModel` vazio (sem preferência) | Footer visível (se modelo tem effort). `defaultEffort` aparece como seleção visual default (sem estilo de override). "Usar padrão" oculto. `requestEffort` = `undefined`. CLI usa default do modelo. |
| Preferência salva para nível que não existe mais (Router mudou) | `validOverride` = `undefined`. `displayEffort` cai em `defaultEffort`. UI mostra `defaultEffort` como seleção default. `requestEffort` = `undefined`. |
| `saved` = `"none"` (válido em `effortLevels`) | `validOverride` = `"none"`. `displayEffort` = label i18n "Nenhum". `requestEffort` = `"none"`. **Passa `--effort none`.** |
| Router offline/cache stale (`ModelDiscoveryResult.stale`) | Dados de reasoning podem estar desatualizados. Mesma regra de resolução — dados são o que temos. |
| CLI rejeita `--effort` (versão antiga < 0.12.0) | Erro capturado em stderr, exibido ao usuário. FE não precisa tratar — o erro é do CLI. |
| "Usar padrão" clicado | `handleEffortSelect(modelId, undefined)` → Rust remove entrada do `effort_by_model`. `validOverride` = `undefined`. `requestEffort` = `undefined`. CLI usa default. |
| Modelo suporta effort mas `defaultEffort` é `null`/ausente | Caso extremo (Router não enviou). `displayEffort` = `undefined`. Footer mostra níveis mas nenhum selecionado (nem default, nem override). `requestEffort` = `undefined`. |

### 3.6 Migração (localStorage → UserSettings)

**Helper one-time de migração:**

```typescript
// Executado uma vez na inicialização do App, antes de qualquer leitura de effortByModel.
// Lê localStorage legado, valida estrutura, tenta gravar em UserSettings.
// Só remove chave legada após confirmação de persistência bem-sucedida.
// Se a persistência falhar, mantém a chave para retry na próxima sessão.
async function migrateEffortFromLocalStorage(
  currentSettings: UserSettings
): Promise<void> {
  const KEY = 'verboo:effort-by-model'
  // Se backend já tem dados, é fonte primária — não sobrescrever
  if (Object.keys(currentSettings.effortByModel ?? {}).length > 0) {
    window.localStorage.removeItem(KEY) // backend venceu, cleanup seguro
    return
  }

  let raw: string | null
  try { raw = window.localStorage.getItem(KEY) } catch { return }
  if (!raw) return

  let parsed: Record<string, string>
  try { parsed = JSON.parse(raw) } catch { return }
  if (typeof parsed !== 'object' || parsed === null) return

  // Remover entradas inválidas
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v !== 'string' || v === '') delete parsed[k]
  }
  if (Object.keys(parsed).length === 0) return

  // Persistir via bridge — só remove localStorage se sucesso
  try {
    await updateUserSettings({ effortByModel: parsed })
    window.localStorage.removeItem(KEY)
  } catch {
    // Falha na persistência: manter chave para retry na próxima sessão
    // O estado local parsed ainda pode ser usado como fallback visual
  }
}
```

**Contrato:**
- Helper é executado **uma vez por sessão**, antes do state inicial de `effortByModel`.
- Se `UserSettings.effortByModel` já tem dados (Rust retornou não-vazio), o helper não sobrescreve — o backend é fonte primária. Remove a chave legada como cleanup seguro.
- Se a persistência via `updateUserSettings` falhar, a chave localStorage NÃO é removida. Próxima sessão tentará novamente.
- Helper persiste no código por uma janela de compatibilidade (2 releases) para garantir que usuários que não abriram o app entre releases não percam a preferência.
- Após janela de compatibilidade: chave `EFFORT_BY_MODEL_KEY`, `readEffortByModel()` e helper de migração são removidos.

---

## 4. Entrega 2 — CLI Sempre Atualizado

### 4.1 Arquitetura Geral

```
[GitHub Actions — CLI bump]
  scheduled_workflow (diário, ~06:00 UTC)
    → detecta @verboo/code latest no npm
    → se diferente de dev atual:
      → cria PR para dev com dependency bump (lock + metadata)
      → roda gates CI (ver 4.5)
      → PR marcado como [BROKEN] se gates falham
      → Dutch review manual (nunca auto-merge)
    → se igual, exit silencioso

  workflow_dispatch (manual, mesmo workflow)
    → parâmetro: version (default: npm latest)

[GitHub Actions — Release]
  Master Chief prepara release PR:
    → bump app version (package.json, Cargo.toml, tauri.conf)
    → Dutch aprova + mergeia
    → Dutch cria tag v*.*.* (app version)
    → tag push → tauri-release.yml
      → build matrix + updater artifacts + .sig signatures
      → publish release como prerelease

[App runtime]
  Tauri Updater check (auto + manual)
    → download bundle
    → verifica signature via .sig file e pubkey
    → instala no próximo restart
    → preserva turno ativo (nunca interrompe)
```

**App version e CLI version são eixos independentes.** O workflow de CLI bump nunca altera app version. O release PR (preparado por Master Chief) só altera app version. Ambos convivem no mesmo bundle.

### 4.2 Workflow Diário de CLI Update

**Trigger:** Diário (~06:00 UTC) via `schedule` + `workflow_dispatch`.

**Arquivo:** `.github/workflows/cli-bump.yml`

**Passos:**

1. **Checkout** do branch `dev`.
2. **Detectar latest:** `npm view @verboo/code version`.
3. **Comparar** com `package.json` → `dependencies.@verboo/code`. Se igual, exit(0).
4. **Criar branch:** `chore/cli-bump-<detected-version>`.
5. **Atualizar versão CLI (app version NÃO é alterada):**
   - `package.json` — `npm install --save-exact @verboo/code@<detected-version>` (atualiza dependency + lock + hoisted deps).
   - `package-lock.json` — atualizado pelo comando acima.
   - `requirements/macos-arm64.json` — campo `bundledComponents[0].version`.
6. **Rodar gates** (ver 4.5). Se qualquer gate falhar, PR marcado como `[BROKEN]`.
7. **Criar PR** para `dev` com título `chore: bump @verboo/code to <detected-version>`.
8. **Assign** para Dutch (`graseeel`) para review manual.

**Fluxo de release completo:**

1. CLI bump PR é aprovado por Dutch e mergeado em `dev`.
2. Master Chief prepara **release PR separado** que:
   - Incrementa app version patch/pre-release em:
     - `package.json` → `version`
     - `src-tauri/Cargo.toml` → `package.version`
     - `src-tauri/tauri.conf.json` → `version`
   - **Não altera** CLI dependency (já atualizada pelo bump PR).
3. Dutch aprova release PR, mergeia em `dev`, cria tag `v<app-version>`.
4. Push da tag dispara `tauri-release.yml`.
5. `tauri-release.yml` faz build matrix, gera updater artifacts com `.sig`, publica release.

**Gates do workflow cli-bump:**

| Gate | Comando | Falha |
|---|---|---|
| install | `npm ci --ignore-scripts` | ❌ |
| dedup + copy | `node scripts/verify/dedup-cli-package.mjs && node scripts/verify/copy-cli-resource.mjs` | ❌ |
| bundled CLI --version | `node src-tauri/resources/cli-package/dist/cli.mjs --version` | ❌ |
| npm test | `npm test` | ❌ |
| build renderer | `npm run build:renderer` | ❌ |
| cargo test | `cargo test` | ❌ |
| effort arg test | Teste Rust que spawna CLI com `--effort medium` e `--effort none`, captura args | ❌ |
| closure deps check | `copy-cli-resource.mjs` já verifica (linha 197) | ❌ |
| patch textual guard | cli-bump | Teste que prova `isAutoUpdaterDisabled()` no bundled CLI. Se ausente, PR falha. |
| version sync | Confirmar CLI version em `package.json` dep + `requirements/*.json` | ❌ |

#### 4.2.1 Patch Textual: Substituído por Env Var

O patch textual em `copy-cli-resource.mjs` (linha 182) desabilitava `autoUpdateCliInBackground` via replace de string no `cli.mjs`. A verificação direta no CLI 0.12.0 confirmou que `autoUpdateCliInBackground` chama `isAutoUpdaterDisabled()`, e esta função honra a env var `DISABLE_AUTOUPDATER`.

**Decisão fechada para CLI >= 0.12.0:**
1. Remover o patch textual de `copy-cli-resource.mjs`.
2. Adicionar `protect_user_cli_env` em `cli_spawn.rs` que injeta `DISABLE_AUTOUPDATER=1` no ambiente do processo filho.
3. Adicionar teste CI que prova que o bundled CLI contém `isAutoUpdaterDisabled` e que a função responde a `DISABLE_AUTOUPDATER`.
4. Se uma versão futura do CLI remover `isAutoUpdaterDisabled` ou quebrar o guard, o CLI bump PR falha no teste — **nunca reaplicar patch textual silenciosamente**.
5. Bloqueador de release: `protect_user_cli_env` + teste CI precisam existir para qualquer release.

### 4.3 Auto-Update do App (Tauri Updater)

**Configuração atual** (`tauri.conf.json`):
```json
"plugins": {
  "updater": {
    "active": true,
    "endpoints": [
      "https://github.com/graseeel/verboo_app/releases/latest/download/latest.json"
    ],
    "pubkey": "<base64>"
  }
}
```

**Comportamento runtime atual** (parcialmente implementado via `UpdateSnapshot`/`UpdateStatus` em `types.ts`):
- `autoCheck` e `autoDownload` são configuráveis via `UpdateSettings` — atualmente `autoCheck: true`, `autoDownload: false` (default no `UpdateService`).
- Download ocorre em background quando `autoDownload: true`.
- Instalação do bundle baixado acontece apenas no próximo restart do app (Tauri plugin gerencia a troca do binário).
- **Preserva turno ativo:** o updater nunca interrompe uma execução em andamento.

**Melhorias necessárias nesta entrega:**
- Alterar default de `autoDownload` de `false` para `true` no `UpdateService`.
- Expor na UI de Settings > Updates: última verificação, versão disponível, botão "Verificar agora", % de download, status do download.
- Adicionar notificação de update disponível (toast ou badge).
- Confirmar que o fluxo download → install-on-restart funciona com `bundle.createUpdaterArtifacts` + `.sig` signature.

### 4.4 Reparo do Updater

**Problema:** `signature: ""` em `generate-tauri-update-manifest.mjs` (linha 124). Sem signature, `tauri-plugin-updater` rejeita o update.

**Solução oficial Tauri v2:**

1. **`tauri.conf.json`**: adicionar `bundle.createUpdaterArtifacts = true`:
   ```json
   "bundle": {
     "createUpdaterArtifacts": true,
     ...
   }
   ```
   Com isso, `cargo tauri build` gera automaticamente os bundles de updater e arquivos `.sig` contendo a signature (quando `TAURI_SIGNING_PRIVATE_KEY`/`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` estão no ambiente).

2. **`generate-tauri-update-manifest.mjs`** deve ser modificado para:
   - Localizar o bundle correto gerado por `cargo tauri build` (ex.: `Verboo Code_0.5.0-beta.1_aarch64_dmg.tar.gz` no diretório de saída do updater).
   - Localizar o arquivo `.sig` correspondente (ex.: `Verboo Code_0.5.0-beta.1_aarch64_dmg.tar.gz.sig`).
   - Ler o conteúdo do `.sig` (a signature em base64) e **copiar** para `platforms[target].signature`.
   - CI falha se o bundle `.sig` não existe ou está vazio.

   **Referência oficial:** https://v2.tauri.app/plugin/updater/ (seção "Signing updates").

3. **CI deve falhar se artefatos ausentes:**
   ```bash
   if [ -z "$TAURI_SIGNING_PRIVATE_KEY" ]; then
     echo "::error::TAURI_SIGNING_PRIVATE_KEY not set — updater artifacts would be unsigned"
     exit 1
   fi
   for sig in update-manifests/*.sig; do
     [ -s "$sig" ] || { echo "::error::$sig is empty or missing"; exit 1; }
   done
   ```

4. **Garantir** que `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` estejam no env dos jobs `build-tauri` e `publish-updates-manifest` no `tauri-release.yml`.

5. **Documentar** em `docs/updater-signing.md` a obrigatoriedade dos secrets e do `createUpdaterArtifacts`.

### 4.5 Gates de CI

Gates a serem adicionados no `tauri-release.yml` e no `cli-bump.yml`:

| Gate | Onde | Descrição |
|---|---|---|
| `npm test` | Ambos | `vitest run` |
| `build renderer` | Ambos | `npm run build:renderer` |
| `cargo test` | Ambos | `cargo test` (Rust lib tests) |
| `CLI bundled --version` | Ambos | `node src-tauri/resources/cli-package/dist/cli.mjs --version` |
| Effort arg test | cli-bump | Teste Rust: spawn CLI e prova `--effort` exato no args |
| Closure deps check | cli-bump | `copy-cli-resource.mjs` já verifica |
| Patch textual valid | cli-bump | Warn se `autoUpdateCliInBackground` patch ainda necessário |
| `Builds matrix` | tauri-release | 4 targets (já existe) |
| `Manifest/signature` | tauri-release | Pós-build: `.sig` existe e não vazio; manifest copia conteúdo |
| `createUpdaterArtifacts` | tauri-release | Confirmar `tauri.conf.json` tem a flag |
| version sync | cli-bump | Confirmar CLI version em package.json + requirements |

### 4.6 Diagnóstico de Versão

**Info a expor na UI (Settings > Updates):**
- Versão atual do app (já existe: `UpdateSnapshot.currentVersion`).
- Versão do CLI bundled: ler de `src-tauri/resources/cli-package/package.json` via bridge Rust → exibir na UI.
- Source do CLI: `"bundled" | "global (PATH)" | "not found"`. Runtime detecta via `cli_spawn.rs` se o bundled CLI roda. Se bundled não disponível (dev build sem copy-cli-resource), mostra global PATH.
- **Regra:** packaged app deve sempre preferir bundled, nunca global por acidente.

**Bridge Rust:** `get_cli_version` → `{ version: string, source: 'bundled' | 'global' | 'none' }`.

### 4.7 Offline, Rollback e Matriz de Compatibilidade

**Offline:**
- Versão bundled atual continua funcionando. Tauri Updater falha silenciosamente (`UpdateStatus: 'error'` ou `'not-available'`).
- Ausência de update não degrada runtime funcional.

**Rollback:**
- Rollback manual: reinstalar versão anterior do `.dmg`. Tauri Updater não suporta downgrade programático.

**Matriz de compatibilidade mínima testada:**

| App version | CLI version mínima | Efeito se abaixo |
|---|---|---|
| Qualquer | >= 0.12.0 | Effort funcional (Gates A+B+C) |
| Qualquer | >= 0.10.6, < 0.12.0 | App funciona. Effort não chega ao provider (CLI ignora `--effort`). Gates B/C falham. |
| Qualquer | < 0.10.6 | Não testado. CLI pode não suportar flags usadas pelo `turn_service`. |

- O **PR de CLI bump** deve validar que a nova versão >= 0.12.0. Se a versão detectada for < 0.12.0, o PR é criado com warning `[EFFORT_BLOCKED]` no título.
- O **release PR** só pode ser aprovado se o CLI bundled atual for >= 0.12.0.

### 4.8 Node Sidecar (bloqueador separado)

**Problema:** O bundled CLI depende de Node runtime do sistema. Em máquina sem Node, o app falha ao iniciar o CLI.

**Classificação:** Bloqueador separado, **não parte desta entrega.** Deve ser resolvido em issue própria antes de qualquer release que afirme distribuição self-contained.

**Issue separada a criar (fora desta spec):**
- Título: "Empacotar Node.js sidecar por plataforma para distribuição self-contained"
- Conteúdo: descrição do problema, documentos a corrigir (README/SETUP/INSTALL/requirements), critério de aceitação.

**Critério:** Nenhuma distribuição pública pode afirmar "self-contained" ou "Node não é necessário" enquanto o Node sidecar não existir. O primeiro release que fizer essa afirmação deve ter a issue resolvida.

---

## 5. Riscos Atuais

| Risco | Severidade | Status |
|---|---|---|
| **Updater signature vazia** (`signature: ""`) | **CRÍTICO** — usuários não recebem updates automáticos | Aberto. `generate-tauri-update-manifest.mjs:124` + falta `createUpdaterArtifacts` |
| **CLI 0.10.6** não tem `getVerbooModelReasoning`/`getVerbooReasoningEffort` | **ALTO** — effort não chega ao provider | Aberto. Bump para 0.12.0+ necessário |
| **Patch textual substituído** — `protect_user_cli_env` + `DISABLE_AUTOUPDATER=1` em `cli_spawn.rs`. Teste CI prova guard no upstream. | **BAIXO** — upstream pode remover `isAutoUpdaterDisabled` no futuro; teste CI detecta e falha o PR. | Fechado. CLI >= 0.12.0 confirmado. |
| **Node sidecar ausente** + docs prometem self-contained | **ALTO** — contradição documentada | Aberto. Issue separada necessária |
| **Falta de gates CI** (effort, manifest, bundled CLI) | **MÉDIO** — regressões não detectadas | Aberto. Nenhum dos gates listados em 4.5 existe |
| **Sem prova Gate C** (Router/provider) | **ALTO** — bloqueia release de effort | Aberto. Requer acesso a logs/endpoint Router |
| **Preferência duplicada localStorage vs UserSettings** | **BAIXO** — resolvido na migração (3.6) | Aberto. |

---

## 6. Ownership por Agente

| Agente | Responsabilidade |
|---|---|
| **Geralt (Rust)** | `extract_reasoning` — confirmar que promove `reasoning.effortLevels` + `defaultEffort`. `UserSettings.effort_by_model` — confirmar serialização/round-trip. `turn_service` — limpeza de comentários obsoletos. Bridge `get_cli_version`. Implementar `protect_user_cli_env` com `DISABLE_AUTOUPDATER=1` em `cli_spawn.rs`; remover patch textual de `copy-cli-resource.mjs`. Teste Rust/spawn que prova args `--effort`. |
| **Ciri (FE)** | Design B do ModelSelector (remover seta/submenu, footer fixo único via `effortLevels.map()`, "Usar padrão", ocultar sem effort). Três estados (validOverride/displayEffort/requestEffort). Seleção visual default vs override. Helper de migração localStorage → UserSettings (async, só remove após persistência confirmada). Settings > Updates: versão CLI, source, botão check. Pill composer com label. i18n. Keyboard. Responsive. |
| **Aloy (QA)** | Gate A (arg test). Gate B smoke com CLI 0.12. Gate C investigação Router/provider (logs/endpoint). Regressão: npm test + cargo test + build renderer. Validar signature no CI. |
| **Master Chief (Build Engineer)** | Criar `.github/workflows/cli-bump.yml` (diário + dispatch). Adicionar `createUpdaterArtifacts=true` ao `tauri.conf.json`. Modificar `generate-tauri-update-manifest.mjs` para ler `.sig` files. Adicionar gates ao `tauri-release.yml`. Release PR (bump app version). Rebuild pós-merge. |
| **Dutch (Repository Manager)** | Revisar e aprovar PRs de CLI bump. Revisar e aprovar release PR. Gate de release (merge + tag). |

---

## 7. Critérios de Aceitação

### Entrega 1 — Effort

- [ ] `validOverride` = `saved` se `effortLevels.includes(saved)` (inclusive `"none"`). `displayEffort` = `validOverride ?? defaultEffort`. `requestEffort` = `validOverride`.
- [ ] `saved='none'` é nível real: passa `--effort none`. Não tratado como ausência.
- [ ] Design B: footer fixo único com `effortLevels.map()`, sem `ChevronRight`/submenu por linha. "Usar padrão" quando `validOverride` existe.
- [ ] Seleção visual: `defaultEffort` aparece como default (sem estilo de override); `validOverride` aparece com estilo de override (checkmark/destaque).
- [ ] Footer oculto para modelos sem `effortLevels` ou lista vazia.
- [ ] Pill do composer mostra `<modelo> · <nível>` (inalterado).
- [ ] Helper de migração localStorage → `UserSettings.effortByModel` na primeira carga. Valida objeto. **Só remove chave após `await updateUserSettings` confirmar sucesso.** Mantido por janela de compatibilidade.
- [ ] `handleEffortSelect` escreve em `UserSettings`, não em localStorage.
- [ ] CLI 0.12.0+ bundled. `--effort` passa pelo novo pipeline `getVerbooReasoningEffort`.
- [ ] Gate A: teste Rust/spawn prova `--effort medium` e `--effort none` nos args.
- [ ] Gate C: prova de que `--effort` chega ao provider (ver 8.1). **Release bloqueado sem esta prova.**

### Entrega 2 — CLI Auto-Update

- [ ] `.github/workflows/cli-bump.yml` existe, roda diariamente, detecta latest, cria PR para `dev`.
- [ ] PR de bump usa `npm install --save-exact @verboo/code@<detected>`. Atualiza apenas a dependency + lock + `requirements/*.json`. **Nunca altera app version.**
- [ ] Gates do cli-bump rodam. Se falham, PR marcado como `[BROKEN]`.
- [ ] CLI < 0.12.0 detectado: PR criado com warning `[EFFORT_BLOCKED]`.
- [ ] `tauri.conf.json` tem `bundle.createUpdaterArtifacts = true`.
- [ ] `generate-tauri-update-manifest.mjs` lê `.sig` files e copia conteúdo para `signature`.
- [ ] `tauri-release.yml` valida: `.sig` existe e não vazio; `TAURI_SIGNING_PRIVATE_KEY` configurado.
- [ ] Se secrets ausentes no CI, build falha com erro explícito.
- [ ] `get_cli_version` bridge implementada. UI mostra versão e source.
- [ ] `protect_user_cli_env` com `DISABLE_AUTOUPDATER=1` em `cli_spawn.rs` implementado. Patch textual removido de `copy-cli-resource.mjs`.
  - [ ] Teste CI prova que o bundled CLI contém `isAutoUpdaterDisabled` e honra `DISABLE_AUTOUPDATER`.
  - [ ] Se versão futura remover o guard, CLI bump PR falha (sem reaplicação silenciosa).
- [ ] Release PR: Master Chief prepara bump de app version (package.json + Cargo.toml + tauri.conf). CLI version não é alterada. Dutch aprova + merge + tag.
- [ ] Matriz de compatibilidade: release PR bloqueado se CLI bundled < 0.12.0.
- [ ] Tests Rust (`cargo test`) e FE (`npm test`) passando.
- [ ] Offline: app funcional sem update; falha de update não degrada runtime.

---

## 8. Estratégia de Testes

### 8.1 Effort — Três Gates de Prova

#### Gate A: Argumento `--effort` (OBRIGATÓRIO, implementável agora)

Teste Rust que verifica a construção de argumentos do CLI:

```rust
#[test]
fn effort_arg_passed_to_cli() {
    let args = build_cli_args(AgentTurnRequest {
        effort: Some("medium".into()),
        ..default()
    });
    assert!(args.contains(&"--effort".to_string()));
    assert!(args.contains(&"medium".to_string()));
}

#[test]
fn effort_none_passed_explicitly() {
    let args = build_cli_args(AgentTurnRequest {
        effort: Some("none".into()),
        ..default()
    });
    assert!(args.contains(&"--effort".to_string()));
    assert!(args.contains(&"none".to_string()));
}

#[test]
fn effort_undefined_not_passed() {
    let args = build_cli_args(AgentTurnRequest {
        effort: None,
        ..default()
    });
    assert!(!args.contains(&"--effort".to_string()));
}
```

**Gate A implementável agora, sem dependência de CLI 0.12.0.**

#### Gate B: CLI Smoke Test (DEPENDE DE CLI 0.12.0+)

Após bump para 0.12.0+, spawn CLI real com `--effort medium` e capture saída. Usar somente flags confirmadas no `--help` do CLI:

```bash
node src-tauri/resources/cli-package/dist/cli.mjs \
  --model ultra/glm-5.2 \
  --effort medium \
  -p \
  --output-format stream-json \
  "test prompt" 2>&1 | head -100
```

- Provar que o metadata/evento do CLI contém o `effort` esperado.
- **Se o CLI 0.12.0 não expuser `effort` no output `-p --output-format stream-json`, este gate fica BLOCKED** — não é possível provar via smoke test sem flag dedicada.

#### Gate C: Prova Router/Provider (OBRIGATÓRIO — release bloqueado sem ela)

- Provar que `--effort medium` resulta em `output_config.effort === "medium"` no provider.
- Métodos possíveis (dependem de acesso ao Router/logs):
  - Correlation ID: CLI envia `x-request-id`, Router loga `effort` no request.
  - Endpoint de teste: ambiente autorizado que ecoa o payload recebido.
  - Log analysis: acesso aos logs do provider.
- **Se nenhum destes estiver disponível no ambiente atual, este gate é BLOCKED.** Release não pode alegar "effort funciona ponta-a-ponta" sem esta prova. O release de effort fica bloqueado até que a prova seja obtida.

### 8.2 CLI Bump Workflow

- PR gerado tem apenas as alterações de versão CLI (package.json dep, lock, requirements).
- App version não é alterada.
- Falha em qualquer gate → PR marcado `[BROKEN]`.
- CLI < 0.12.0 → PR marcado `[EFFORT_BLOCKED]`.
- Gates passam e CLI >= 0.12.0 → PR assignado para Dutch.

### 8.3 Updater Manifest

- `tauri.conf.json` com `createUpdaterArtifacts=true`.
- `cargo tauri build` com env vars gera `.tar.gz` + `.sig`.
- `generate-tauri-update-manifest.mjs` lê `.sig`, copia para `signature`.
- CI step valida: `[ -s "update-manifests/latest-mac.json" ]` e `jq '.platforms.darwin.signature | length > 0'`.
- Se env vars ausentes: exit 1 com erro.

### 8.4 Regressão

- `npm test` + `cargo test` + `npm run build:renderer` passando.
- `node copy-cli-resource.mjs` sucede com CLI 0.12.0+.
- TSC sem erros.

---

## 9. Self-Review

### 9.1 Decisões Fechadas

| Tópico | Decisão |
|---|---|
| CLI 0.12.0 existe? | Confirmado no npm registry. Todas as referências atualizadas. |
| Signature generation? | Delegado ao `cargo tauri build` com `createUpdaterArtifacts=true`. `.sig` gerado pelo Tauri tooling. Script copia conteúdo, não gera signature. |
| `cli-bump.yml` trigger? | Diário + `workflow_dispatch`. |
| Auto-merge? | Não. Dutch faz review manual em CLI bump e release PR. |
| `effort: "none"`? | Nível real, passa `--effort none`. Não é ausência. |
| App version vs CLI version? | Eixos separados. CLI bump não altera app version. Release PR altera app version. |
| Patch textual `autoUpdateCliInBackground`? | Resolvido: `protect_user_cli_env` + `DISABLE_AUTOUPDATER=1` em `cli_spawn.rs`. Patch textual removido. Teste CI prova guard no upstream. |
| Gate C? | Obrigatório para release. Se não observável, release de effort fica bloqueado. |
| AutoDownload default? | Atualmente `false` no UpdateService. Mudar para `true` nesta entrega. |

### 9.2 Contradições Verificadas

- **Nenhuma.** Três conceitos separados (validOverride/displayEffort/requestEffort) eliminam ambiguidade anterior sobre `none`.
- Regra "nunca forçar max" confirmada.
- `none` como nível real (não ausência) em todas as seções.
- "Usar padrão" remove entrada → `requestEffort` = `undefined` → CLI usa default. Consistente.
- Footer com `effortLevels.map()`: sem hardcode, altura varia entre modelos, esperado.
- App version e CLI version: eixos independentes, dois PRs separados.

### 9.3 Escopo Verificado

- Entregas 1 e 2 são independentes? **Sim.**
- CLI 0.12.0 bump é pré-requisito da Entrega 1? **Sim.** Sem CLI 0.12.0, effort não chega ao provider.
- Updater repair bloqueia release? **Sim.** Signature vazia torna auto-update inoperante.
- Node sidecar bloqueia distribuição pública? **Sim.** Issue separada necessária. Não é critério desta entrega.
- Gate C (Router/provider) bloqueia release de effort? **Sim.** Release não alega ponta-a-ponta sem ela.
