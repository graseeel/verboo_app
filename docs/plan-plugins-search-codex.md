# Plano Plugins + Search Codex-aligned

> Combina Part 1 (seções A-C) e Part 2 (seções D-G) das notes do canvas Maestri
> (`plano-plugins-search-codex` + `plano-plugins-search-codex-2`).

> **CALLOUT — Decisão de produto Gabriel (2026-07-13, revisão search placement):**
> Search **NÃO** vai no topbar. Topbar permanece só `Terminal | Review`.
> **Preferência primária:** MANTER "Pesquisar" onde está na sidebar; ao clicar abre o modal `CommandPalette` (não expandir input inline).
> **Alternativa aceita (secundária):** mover search para logo acima do "Novo chat" na sidebar.
> Pin/collapse continua na row Novo chat (sem mudança).

> **STATUS (2026-07-13):**
> - **Wave 1 DONE** (Gabriel validated) — P0 Kratos spec + Ciri FE chrome (search modal + item Plugins + placeholder view)
> - **Wave 2 IN PROGRESS** — Geralt P5 backend
> - **Wave 3 pending** — Ciri PluginsView real P6

**LOCKED:** Plugins item na sidebar → view dedicada fullscreen; Search fica na sidebar (item "Pesquisar" abre modal CommandPalette, sem input inline); Pin/collapse mantido na row Novo chat; Backend REAL via CLI 0.13; UI Verboo clean/minimal/animada (inspirar Codex).

---

## A) IA sidebar + pin placement

### Ordem sidebar pós-mudança (espelha Codex Image1)
```
SIDEBAR
├── [item nav] Pesquisar (MANTIDO onde está; click abre modal CommandPalette, sem input inline)
├── [row] Novo chat + pin/collapse (MANTIDO como hoje)
├── [item nav] Plugins (novo, ícone Blocks)
├── [seção] Projetos
├── [seção] Chats
└── [footer] user

TOPBAR (sem mudança — só Terminal + Review)
├── [button] Terminal
└── [button] Review
```

**Alternativa secundária (se Gabriel pedir):** mover "Pesquisar" para logo acima do "Novo chat" (primeiro item da sidebar). Mesma semântica: click abre modal, sem input inline.

### Pin/collapse — MANTIDO na row do Novo chat
Gabriel locked: search não compete com pin. Pin/collapse fica onde está (`AppSidebar.tsx:182-205`):
- Peek → botão Pin (persiste expanded)
- Expanded → botão PanelLeftClose (colapsa)
- Hidden → rail na borda esquerda (já existe, `App.tsx:4174`)

Sem mudança nesta área. Só trocamos o comportamento do item "Pesquisar" (click → modal em vez de expandir input inline) e adicionamos item Plugins.

### Item Plugins
- **Ícone:** `Blocks` (lucide-react) — neutro, não jigsaw toy como `Puzzle`
- **Posição:** após row Novo chat, antes de Projetos. Cluster de ações/nav, não de listas
- **Comportamento:** `onClick` → `onSelectView('plugins')` → `setActiveView('plugins')`
- **Estado ativo:** `activeView === 'plugins'` destaca item
- **Hidden em fullscreen:** sidebar não renderiza em `isFullscreenView`

### Mudanças de tipos
- `AppView` (`AppSidebar.tsx:32`): adicionar `'plugins'`
- `isFullscreenView` (`App.tsx:500`): incluir `'plugins'`
- `view-fullscreen` className (`App.tsx:4172`): incluir `'plugins'`
- Render (`App.tsx:4253-4263`): branch `activeView === 'plugins' ? <PluginsView/>`
- ESC handler (`App.tsx:745`): guard inclui `'plugins'`

---

## B) Search modal (estender CommandPalette)

### Decisão: REUSAR CommandPalette, não criar novo
`CommandPalette.tsx` já é padrão shadcn Command (input top, actions + chats, keyboard nav, backdrop). Codex Image2 = exatamente este padrão. Estender, não duplicar.

### Mudanças no CommandPalette

**1. Trigger (3 caminhos):**
- ⌘K (hoje, mantido) — `App.tsx:2478`
- ⌘P (alias novo, padrão VS Code Go to File)
- Click no item "Pesquisar" da sidebar (novo comportamento — antes expandia input inline, agora abre o modal `CommandPalette` via `setPaletteOpen(true)`)

**2. Seções (ordem, espelha Codex Image2):**
```
┌─────────────────────────────┐
│ 🔍 [input]            esc   │
├─────────────────────────────┤
│ Recents                     │ ← query vazia: top 5 por updatedAt
│   Chat A · 2m               │
├─────────────────────────────┤
│ Suggestions                 │ ← query vazia: actions padrão
│   + New thread              │
│   ⚙ Go to Settings          │
│   🧩 Open Plugins           │ ← NOVO
│   📁 Open project…          │
├─────────────────────────────┤
│ Projects                    │ ← se query match
│   project-name              │
├─────────────────────────────┤
│ Chats                       │ ← se query match
│   chat-title                │
└─────────────────────────────┘
```

**3. Lógica de seções:**
- Query vazia → Recents (5) + Suggestions (actions)
- Query não-vazia → filtra actions + projects + chats por nome. Recents esconde
- Empty state: query vazia → "Digite para buscar…"; sem match → "Nenhum resultado para {query}"

**4. Actions do palette (estender `paletteIcons` em `CommandPalette.tsx:154`):**
- Adicionar `plugins: <Blocks size={14}/>`
- Adicionar action "Abrir Plugins" no array de actions em `App.tsx`

**5. Não pôr busca de plugins no palette:** marketplace data tem latência CLI. Busca dentro de plugins fica na view dedicada (input próprio)

### Sidebar search item (substitui "TopBar search button")
**Decisão revisada (Gabriel 2026-07-13):** search **não** vai no topbar. Topbar permanece só `Terminal | Review` (`TopBar.tsx:53` `topbar-actions` sem mudança). O item "Pesquisar" da sidebar (`AppSidebar.tsx:207-220`) é mantido na posição atual, mas muda de comportamento: em vez de expandir um input inline, o click chama `setPaletteOpen(true)` e abre o `CommandPalette` como modal central.

**Alternativa secundária:** se Gabriel preferir, mover "Pesquisar" para logo acima do "Novo chat" (primeiro item da sidebar). Mesmo comportamento de click → modal. Decisão visual, sem impacto funcional.

**Remover:** o input inline de search que existe hoje em `AppSidebar.tsx:207-220` (estado `searchOpen` + input expansível). Substituir por `onClick={() => onOpenPalette()}` direto.

---

## C) PluginsView UI wireframe + motion

### Wireframe (espelha Codex Image3)
```
┌──────────────────────────────────────────────────────────┐
│ ← Voltar                                                 │
│ Plugins                                                  │
│ Instale e gerencie extensões do marketplace Verboo.      │
├──────────────────────────────────────────────────────────┤
│ 🔍 [Buscar plugins…]        [Manage marketplaces]        │
├──────────────────────────────────────────────────────────┤
│ INSTALADOS (3)                                           │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│ │ Plugin A   │ │ Plugin B   │ │ Plugin C   │            │
│ │ v1.2.0     │ │ v0.9.1     │ │ v2.0.0     │            │
│ │ desc…      │ │ desc…      │ │ desc…      │            │
│ │ [✓ On] [⋯] │ │ [Off] [⋯]  │ │ [Off] [⋯] │            │
│ └────────────┘ └────────────┘ └────────────┘            │
├──────────────────────────────────────────────────────────┤
│ FEATURED                                                 │
│ ┌────────────┐ ┌────────────┐ ┌────────────┐            │
│ │ Plugin D   │ │ Plugin E   │ │ Plugin F   │            │
│ │ [Install]  │ │ [Install]  │ │ [Install]  │            │
│ └────────────┘ └────────────┘ └────────────┘            │
├──────────────────────────────────────────────────────────┤
│ PRODUCTIVITY                                             │
│ ┌────────────┐ ┌────────────┐                            │
│ │ Plugin G   │ │ Plugin H   │                            │
│ │ [Install]  │ │ [Install]  │                            │
│ └────────────┘ └────────────┘                            │
├──────────────────────────────────────────────────────────┤
│ [Browse MCP marketplaces →]                              │
└──────────────────────────────────────────────────────────┘
```

### Componentes
- `PluginsView.tsx` — container fullscreen (header + search + seções + footer)
- `PluginCard.tsx` — card único (nome, versão, desc, toggle/actions, install button)
- `PluginInstallModal.tsx` — confirm com validate output (hash, warnings)
- `MarketplaceModal.tsx` — lista marketplaces + add/remove
- `pluginsStore.ts` — cache + hooks (`usePlugins`, `useMarketplaces`, `useInstallPlugin`, etc.)

### Motion (padrão Verboo, Ivo)
- **View enter:** fade-in 200ms + translateY(8px→0), `cubic-bezier(0.23,1,0.32,1)`. Mesmo padrão SettingsView/ProfileView
- **Cards:** stagger enter 40ms por card (max 8 cards, depois sem stagger)
- **Toggle enable/disable:** 120ms background-color transition, sem layout shift
- **Install flow:** botão → spinner 120ms fade-in → sucesso toast. Card move Featured→Instalados com FLIP (300ms) se v2; MVP: re-fetch lista + fade
- **Loading skeletons:** 3-5 skeleton cards, shimmer 1.2s loop
- **Empty states:** ilustração + copy, fade-in 200ms
- **Error banner:** slide-down 200ms, slide-up on dismiss
- **Reduced-motion:** opacity-only 80ms, sem translate/stagger

### Estados
- **Empty (no installed, marketplace OK):** só seção Featured + categorias, "Instalados" escondido ou com CTA
- **Empty (no marketplace results):** "Nenhum plugin encontrado para {query}"
- **Loading (list):** skeleton cards
- **Loading (install/update):** spinner no botão, row disabled
- **Error (CLI fail):** banner topo "Falha ao conectar ao CLI" + retry
- **Error (offline):** "Sem conexão" + retry
- **Error (auth):** "Autenticação necessária" + botão login
- **Restart required:** banner persistente pós-update "Reiniciar para aplicar" + botão

---

## D) Backend stack

### Tauri invoke vs shell-out — SHELL-OUT via tauri-plugin-shell

**Decisão:** shell-out para `verboo` CLI, não implementar lógica de plugins em Rust. Razões:
1. CLI 0.13 já tem toda a lógica (install/enable/disable/validate/marketplace)
2. Duplicar em Rust = drift com CLI
3. `shell:allow-execute` já concedido (`capabilities/default.json:46`)
4. CLI mantém source-of-truth (arquivos de plugin em disco)

**Pattern:** cada Tauri command = wrapper fino que:
1. Resolve path do `verboo` binary (já resolvido em outro lugar do app — reusar)
2. Spawn `verboo plugin <subcommand> --json` com timeout
3. Parse stdout JSON → structs
4. Map stderr/exit-code → `PluginError` enum
5. Retorna `Result<T, PluginError>`

### Types (`src/shared/plugins.ts` — novo)
```typescript
export type PluginScope = 'user' | 'project' | 'local'
export type PluginStatus = 'installed' | 'available' | 'updating' | 'error'
export type MarketplaceTrust = 'official' | 'verified' | 'community'

export interface Plugin {
  id: string              // name@marketplace
  name: string
  version: string
  description: string
  marketplace: string
  scope: PluginScope
  status: PluginStatus
  enabled: boolean
  installed: boolean
  hash?: string
  homepage?: string
  author?: string
  categories?: string[]
  error?: string
}

export interface Marketplace {
  name: string
  url: string
  trust: MarketplaceTrust
  enabled: boolean
  pluginCount?: number
}

export interface PluginValidateResult {
  valid: boolean
  warnings: string[]
  errors: string[]
  hash?: string
  signature?: string
}

export type PluginError =
  | { kind: 'cli_not_found' }
  | { kind: 'cli_auth_required' }
  | { kind: 'network_error'; message: string }
  | { kind: 'parse_error'; message: string }
  | { kind: 'invalid_plugin'; errors: string[] }
  | { kind: 'already_installed'; plugin: string }
  | { kind: 'not_installed'; plugin: string }
  | { kind: 'timeout' }
  | { kind: 'unknown'; message: string }
```

### Tauri commands (`src-tauri/src/plugins.rs` — novo)
```rust
#[tauri::command]
pub async fn plugin_list(scope: Option<PluginScope>) -> Result<Vec<Plugin>, PluginError>
#[tauri::command]
pub async fn plugin_available(marketplace: Option<String>) -> Result<Vec<Plugin>, PluginError>
#[tauri::command]
pub async fn plugin_install(name: String, marketplace: String, scope: PluginScope) -> Result<Plugin, PluginError>
#[tauri::command]
pub async fn plugin_enable(name: String, marketplace: String) -> Result<(), PluginError>
#[tauri::command]
pub async fn plugin_disable(name: String, marketplace: String) -> Result<(), PluginError>
#[tauri::command]
pub async fn plugin_uninstall(name: String, marketplace: String) -> Result<(), PluginError>
#[tauri::command]
pub async fn plugin_update(name: String, marketplace: String) -> Result<Plugin, PluginError>
#[tauri::command]
pub async fn plugin_validate(name: String, marketplace: String) -> Result<PluginValidateResult, PluginError>
#[tauri::command]
pub async fn marketplace_list() -> Result<Vec<Marketplace>, PluginError>
#[tauri::command]
pub async fn marketplace_add(name: String, url: String) -> Result<Marketplace, PluginError>
#[tauri::command]
pub async fn marketplace_remove(name: String) -> Result<(), PluginError>
```

### Error mapping
- Exit code 127 / binary not found → `cli_not_found`
- stderr contém auth/login/token → `cli_auth_required`
- stderr contém network/ECONNREFUSED/timeout → `network_error`
- stdout não é JSON válido → `parse_error`
- `validate` retorna `valid=false` → `invalid_plugin` com errors
- Exit code != 0 + nenhum padrão → `unknown` com stderr truncado (500 chars)

### Feature-detect `--json`
- Primeira chamada: tentar `verboo plugin list --json`
- Se stderr contém "unknown flag --json" → flag `cli_supports_json = false`, fallback parse texto com warning log
- Cache flag em state Rust (OnceCell). UI mostra banner "CLI desatualizado" se false

### Timeout
- `plugin_list` / `marketplace_list`: 15s
- `plugin_install` / `plugin_update`: 60s (download)
- `plugin_validate`: 30s
- Outros: 10s

### Auth gate
- Antes de qualquer command, checar `cliAuth` state (já existe no app)
- Se não logado: retornar `cli_auth_required` sem chamar CLI. UI mostra CTA login

---

## E) Fases P0-P6 com arquivos e dependências

### P0 — Spec (Kratos, gate)
- **Arquivos:** `docs/plugins-marketplace.md` (novo)
- **Conteúdo:** data model, fluxos, estados, threat model §0 com tags [FEATURE]/[EXISTING]/[BOTH], riscos, mitigações, critérios de aceite
- **Dependência:** nenhuma
- **Gate:** Maestro GO/NO-GO
- **Owner:** Kratos

### P1 — Sidebar fade bug fix (Ciri, isolado)
- **Arquivos:**
  - `src/renderer/App.tsx` (state peek: `setSidebarPeek(false)` junto com `setSidebarPeekLeaving(true)`, key remount para re-enter fresh, simplificação unmount timer)
  - `src/renderer/styles/layout.css` (classes peek: leave usa só `is-peek-leaving`, nunca ambas)
- **Dependência:** nenhuma
- **Gate:** Aloy QA (hover in/out 10x, re-enter mid-leave, reduced-motion)
- **Owner:** Ciri

### P2 — Composer cascade + Profile back/ESC (Ciri, isolado)
- **Arquivos:**
  - `src/renderer/styles/login.css` (remover `.send-button:disabled` do seletor agrupado)
  - `src/renderer/styles/composer.css` (`.send-button:disabled` mantém `background: var(--accent-strong)`, só opacity 0.5)
  - `src/renderer/features/profile/ProfileView.tsx` (back button acima do H1, ghost style)
  - `src/renderer/App.tsx` (ESC guard inclui `'profile'`)
- **Dependência:** nenhuma
- **Gate:** Aloy QA
- **Owner:** Ciri

### P3 — Sidebar IA + search modal trigger (Ciri, depende de P1+P2 merged)
- **Arquivos:**
  - `src/renderer/components/AppSidebar.tsx` (manter item "Pesquisar" na posição atual; trocar comportamento: click → `onOpenPalette()` em vez de expandir input inline; remover estado `searchOpen` + input expansível `:207-220`; adicionar item Plugins nav)
  - `src/renderer/App.tsx` (AppView adiciona `'plugins'`, isFullscreenView inclui `'plugins'`, ESC guard inclui `'plugins'`, render branch placeholder; passar `onOpenPalette` para sidebar)
  - `src/renderer/styles/layout.css` (estilos item Plugins nav; remover estilos do input inline de search se exclusivos)
  - `src/renderer/i18n.tsx` (keys `sidebar.plugins`, `sidebar.search` — já existe)
- **Dependência:** P1+P2 (mesma área)
- **Gate:** Aloy QA (item Plugins clica → placeholder view, item "Pesquisar" abre palette, pin/collapse mantido)
- **Owner:** Ciri

### P4 — Search modal estendido (Ciri, paralelo a P3)
- **Arquivos:**
  - `src/renderer/components/CommandPalette.tsx` (seção Recents, seção Projects, action Plugins, empty states diferenciados)
  - `src/renderer/App.tsx` (⌘P alias, actions array inclui "Abrir Plugins")
  - `src/renderer/i18n.tsx` (keys `palette.recents`, `palette.suggestions`, `palette.projects`, `palette.openPlugins`)
- **Dependência:** nenhuma (P3 paralelo, não conflita — CommandPalette vs AppSidebar/TopBar)
- **Gate:** Aloy QA (⌘K, ⌘P, botão topbar, seções, empty states)
- **Owner:** Ciri

### P5 — Plugins backend (Geralt, depende de P0 approved)
- **Arquivos:**
  - `src-tauri/src/plugins.rs` (novo module: 11 commands + error mapping + feature-detect)
  - `src-tauri/src/lib.rs` (registrar commands no invoke_handler)
  - `src/shared/plugins.ts` (novo: types + error enum)
  - `src-tauri/capabilities/default.json` (se scoped capability necessário — provavelmente não, `shell:allow-execute` já broad)
- **Dependência:** P0 (spec define shapes/errors)
- **Gate:** Aloy (invoke tests com CLI real), verifier PASS
- **Owner:** Geralt

### P6 — Plugins FE view (Ciri, depende de P3 + P5 merged)
- **Arquivos:**
  - `src/renderer/features/plugins/PluginsView.tsx` (novo)
  - `src/renderer/features/plugins/PluginCard.tsx` (novo)
  - `src/renderer/features/plugins/PluginInstallModal.tsx` (novo)
  - `src/renderer/features/plugins/MarketplaceModal.tsx` (novo)
  - `src/renderer/state/pluginsStore.ts` (novo: hooks `usePlugins`, `useMarketplaces`, `useInstallPlugin`, etc.)
  - `src/renderer/App.tsx` (render `<PluginsView>` no branch `activeView === 'plugins'`, passar props)
  - `src/renderer/i18n.tsx` (keys `plugins.*` EN+PT)
  - `src/renderer/styles/plugins.css` (novo: estilos view + cards + modal)
- **Dependência:** P3 (item nav + AppView) + P5 (backend commands)
- **Gate:** Aloy QA full (install/enable/disable/uninstall/update/validate/offline/auth/restart), verifier PASS
- **Owner:** Ciri

### Pós-MVP (backlog, não bloqueia ship)
- Categorias/featured com cache local (se CLI não suporta)
- Auto-update check periódico
- Plugin settings (config UI por plugin)
- Permissions granular per plugin
- FLIP animation card move (Featured → Instalados)
- Sidebar quick-access se demanda real

---

## F) Riscos + o que NÃO fazer

### Riscos (top 5)
1. **TTY auth prompt** — CLI pede input interativo, shell-out hang (HIGH). Mitigação: Timeout 10s + detectar `--non-interactive`. Se auth missing, retornar `cli_auth_required` sem chamar CLI. Aloy testa hang.
2. **Supply chain** — plugin malicioso no marketplace (HIGH). Mitigação: `plugin_validate` obrigatório antes de install. UI mostra hash/assinatura. Confirm modal explícito. Trust level marketplace visível. Nunca auto-install.
3. **Restart after update** — plugin em uso, estado inconsistente (MED). Mitigação: Banner "Reiniciar para aplicar" pós-update. Não force-restart. User pode adiar.
4. **`--json` ausente em CLI < 0.13** (MED). Mitigação: Feature-detect primeira chamada. Fallback parse texto + warning log. UI banner "CLI desatualizado" se false.
5. **Parse frágil** — output CLI muda entre versões (MED). Mitigação: Parse defensivo (camelCase + snake_case tolerant). Tests com fixtures de múltiplas versões.

### O que NÃO fazer
1. NÃO criar componente de search novo — reusar CommandPalette. Duplicação = drift
2. NÃO pôr busca de plugins no palette — latência CLI mata UX. Busca fica na view dedicada
3. NÃO mesclar Skills e Plugins na mesma UI — conceitos diferentes (skill = prompt template local; plugin = executável remoto). Separar
4. NÃO implementar lógica de plugins em Rust — shell-out para CLI. Duplicar = drift
5. NÃO auto-install plugins — sempre explicit user action com validate + confirm
6. NÃO force-restart após update — banner, user decide
7. NÃO carregar plugins no runtime do app (MVP) — plugins são CLI-only. Runtime loading = sandbox + crash recovery (v2)
8. NÃO adicionar `profile.back` i18n key nova — reusar `settings.back` (mesma semântica "Voltar")
9. NÃO tocar no pin/collapse — Gabriel locked: mantido na row Novo chat
10. NÃO usar `Puzzle` icon — `Blocks` é mais neutro. `Puzzle` parece jigsaw toy
11. NÃO fazer FLIP animation card move no MVP — re-fetch + fade. FLIP é v2
12. NÃO adicionar sidebar quick-access a plugins no MVP — demanda não confirmada
13. NÃO usar `transition: all` — só transform + opacity. Lição Ivo
14. NÃO esquecer reduced-motion — opacity-only 80ms em todas animações
15. NÃO commit sem verifier PASS em P5 e P6

---

## G) Critérios de aceite Gabriel

### P1 (sidebar fade)
- [ ] Hover in/out rápido 10x sem flicker
- [ ] Leave: sidebar fade-out visível (não desaparece instantâneo)
- [ ] Leave: sem buraco vazio à esquerda (grid colapsa junto com fade)
- [ ] Re-enter mid-leave: enter animation fresh (não retoma parcial)
- [ ] Reduced-motion: opacity-only 80ms, sem translate
- [ ] Pin/collapse funcionam normalmente

### P2 (composer + profile)
- [ ] Send button mantém bolinha roxa no estado disabled (só opacity 0.5)
- [ ] Send button alinhado verticalmente com pills (30px ambos)
- [ ] Profile back button acima do H1, alinhado à esquerda, ghost style
- [ ] ESC fecha Profile (não só Settings)
- [ ] Refresh permanece à direita no header do Profile

### P3 (sidebar IA)
- [ ] Item "Pesquisar" mantido na posição atual da sidebar
- [ ] Click em "Pesquisar" abre modal CommandPalette (não expande input inline)
- [ ] Input inline de search removido (estado `searchOpen` + input expansível)
- [ ] Item "Plugins" aparece após Novo chat, antes de Projetos
- [ ] Click Plugins → abre view dedicada (placeholder OK em P3)
- [ ] Pin/collapse mantido na row Novo chat (sem mudança)
- [ ] Topbar permanece só Terminal + Review (sem search button)
- [ ] Sidebar colapsa quando Plugins abre (fullscreen view)

### P4 (search modal)
- [ ] ⌘K abre palette
- [ ] ⌘P abre palette (alias)
- [ ] Click no item "Pesquisar" da sidebar abre palette
- [ ] Query vazia: mostra Recents (5) + Suggestions (actions)
- [ ] Query não-vazia: filtra actions + projects + chats
- [ ] Empty state query vazia: "Digite para buscar…"
- [ ] Empty state sem match: "Nenhum resultado para {query}"
- [ ] Action "Abrir Plugins" aparece em Suggestions
- [ ] Keyboard nav (↑↓ Enter Esc) funciona

### P5 (plugins backend)
- [ ] 11 Tauri commands registrados no invoke_handler
- [ ] `plugin_list` retorna lista parseada de `verboo plugin list --json`
- [ ] `plugin_install` faz shell-out, retorna Plugin atualizado
- [ ] `plugin_validate` retorna warnings/errors antes de install
- [ ] Feature-detect `--json` (fallback se CLI < 0.13)
- [ ] Timeout por command (15s list, 60s install, 30s validate)
- [ ] Auth gate: se não logado, retorna `cli_auth_required` sem chamar CLI
- [ ] Error mapping cobre 9 variants do `PluginError` enum
- [ ] Unit tests: parse JSON fixtures, error mapping
- [ ] Integration tests: invoke com CLI real (se disponível)
- [ ] Verifier PASS

### P6 (plugins FE)
- [ ] View Plugins abre fullscreen (header + search + seções + footer)
- [ ] Seção "Instalados" mostra plugins com toggle enable + actions
- [ ] Seção "Featured" mostra plugins disponíveis com Install
- [ ] Categorias (Productivity, etc.) se CLI suporta
- [ ] Click Install → validate → confirm modal → install → toast
- [ ] Toggle enable/disable funciona (optimistic UI)
- [ ] Uninstall com confirm modal (destructive)
- [ ] Update → loading → toast → banner restart
- [ ] Empty state (no installed): CTA "Explorar marketplace"
- [ ] Empty state (no results): "Nenhum plugin para {query}"
- [ ] Loading skeletons (shimmer)
- [ ] Error banner (CLI fail/offline/auth) com retry
- [ ] Restart banner persistente pós-update
- [ ] Animações: view enter 200ms, cards stagger 40ms, reduced-motion
- [ ] i18n EN + PT completo
- [ ] Verifier PASS

### Globais
- [ ] `tsc` clean
- [ ] `vitest` all pass
- [ ] `cargo test` all pass
- [ ] Sem regressões em sidebar/peek/composer/profile
- [ ] Transcript INTOCÁVEL

---

## Ordem de execução recomendada

- **P1+P2** (Ciri fixes, isolados, ship rápido) — pode começar imediatamente
- **P0** (Kratos spec, gate para P5+P6) — pode começar em paralelo
- **P3+P4** (Ciri IA refactor, paralelo) — após P1+P2 merge
- **P5** (Geralt backend) — após P0 approved
- **P6** (Ciri FE view) — após P3+P5 merge

Ciri pode começar P1+P2 imediatamente. Kratos pode começar P0 em paralelo. P3+P4 após P1+P2 merge. P5 após P0 approved. P6 após P3+P5 merge.
