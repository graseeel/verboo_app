# Plugins Sidebar Persistent — Spec Cirúrgica (Codex parity)

> **Status:** SPEC — implementation gated by Maestro GO/NO-GO.
> **Owner:** Kratos (Architect). Implementation: Ciri (FE only).
> **GO explícito:** Gabriel liberou a área da sidebar (2026-07-14).
> **Out of scope:** P5 backend, ícones, detail view, tabs Habilidades. Apenas layout/sidebar.
> **Constraint absoluta:** peek 100% intacto. Zero mudança nas classes/estados peek.

---

## §1 Mapeamento do estado atual (read-only)

### §1.1 Como `activeView === 'plugins'` esconde a sidebar hoje

**Três mecanismos combinam** para esconder a sidebar em views fullscreen (settings/profile/plugins):

| # | Local | Mecanismo | Linha |
|---|---|---|---|
| 1 | `App.tsx` | `isFullscreenView = activeView === 'settings' \|\| 'profile' \|\| 'plugins'` → `effectiveSidebarWidth = 0` | App.tsx:509-510 |
| 2 | `App.tsx` | Conditional render: rail E sidebar-shell **não montam** quando `activeView` é fullscreen | App.tsx:4205, 4230 |
| 3 | `App.tsx` | Classe `view-fullscreen` aplicada ao `.app-layout` | App.tsx:4203 |
| 4 | `layout.css` | `.app-layout.view-fullscreen { grid-template-columns: 0 minmax(0,1fr) ... }` + `.workspace { grid-column: 1 / -1 }` | layout.css:530-536 |

**Resultado:** em `activeView === 'plugins'`, o grid colapsa a coluna da sidebar para `0`, o `<aside>` não é renderizado, e o `.workspace` ocupa `grid-column: 1 / -1` (full-bleed).

### §1.2 Como `activeView === 'chat'` renderiza sidebar + workspace lado a lado

| Condição | Renderiza |
|---|---|
| `sidebarMode === 'hidden' && !sidebarPeek && !sidebarPeekLeaving` | Apenas o rail (botão thin hit-area) |
| `sidebarMode !== 'hidden' \|\| sidebarPeek \|\| sidebarPeekLeaving` | sidebar-shell completo (com AppSidebar + resizer) |
| Sempre | `.workspace` com `grid-column: 2` (default do grid) |

Grid normal (layout.css:405):
```css
.app-layout {
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--subagents-panel-width, 0px) var(--review-width) var(--terminal-width);
}
```

### §1.3 Interação peek × views fullscreen (HOJE)

**Hoje, peek é completamente suprimido em views fullscreen** porque:
- App.tsx:4205 — rail só renderiza se `activeView !== 'settings' && 'profile' && 'plugins'`
- App.tsx:4230 — sidebar-shell só renderiza sob mesma condição
- Resultado: em plugins, mesmo se `sidebarMode === 'hidden'` e o usuário hover a borda esquerda, **nada acontece**. Não há rail, não há shell, não há peek.

**Isso é o que Gabriel quer mudar.** Peek deve voltar a funcionar em plugins (igual chat).

### §1.4 Toggle de colapso (toggleSidebarVisibility)

- Em chat: alterna `sidebarMode` entre `'hidden'` e `'expanded'` (ou último estado não-hidden).
- Em views fullscreen hoje: o toggle **não é exposto na sidebar** (porque a sidebar não está montada). O usuário só tem ← Voltar e ESC.
- **Pós-spec:** o toggle volta a ser exposto porque a sidebar volta a ser montada.

### §1.5 Estado ativo do item Plugins

AppSidebar.tsx:210 já marca `active` quando `activeView === 'plugins'`:
```tsx
className={`sidebar-action ${activeView === 'plugins' ? 'active' : ''}`}
onClick={() => onSelectView('plugins')}
```
**Não precisa mudar.** Já funciona.

### §1.6 Navegação chat/projeto saindo de plugins

- `onSelectView('chat')` é chamado pelo AppSidebar quando user clica em "Novo chat" ou item de chat/projeto.
- `onSelectConversation(id)` seleciona a conversa (não muda `activeView` explicitamente, mas o fluxo atual já seta `activeView='chat'` em `selectConversation` — verificar em P5.1).
- **Hoje:** clicar num chat na sidebar enquanto está em plugins → `onSelectConversation` é chamado → App.tsx precisa setar `activeView='chat'`. Verificar se já faz isso (provável sim, pois é o mesmo handler do chat).

---

## §2 Caminho cirúrgico de menor risco

### §2.1 Princípio fundamental

**Remover `'plugins'` da lista de views fullscreen.** Tudo o mais decorre disso. Settings e Profile continuam fullscreen (não tocados).

### §2.2 Mudança 1 — `isFullscreenView` (App.tsx:509)

**Antes:**
```tsx
const isFullscreenView = activeView === 'settings' || activeView === 'profile' || activeView === 'plugins'
```

**Depois:**
```tsx
const isFullscreenView = activeView === 'settings' || activeView === 'profile'
```

**Efeito cascata automática:**
- `effectiveSidebarWidth` passa a usar `sidebarVisualMode` (não 0) quando `activeView === 'plugins'`.
- `--sidebar-width` CSS var passa a refletir a largura real da sidebar.
- Grid volta a ter coluna sidebar + workspace.

### §2.3 Mudança 2 — Conditional render do rail (App.tsx:4205)

**Antes:**
```tsx
{activeView !== 'settings' && activeView !== 'profile' && activeView !== 'plugins' && sidebarMode === 'hidden' && !sidebarPeek && !sidebarPeekLeaving && (
  <button className="sidebar-rail" ... />
)}
```

**Depois:**
```tsx
{activeView !== 'settings' && activeView !== 'profile' && sidebarMode === 'hidden' && !sidebarPeek && !sidebarPeekLeaving && (
  <button className="sidebar-rail" ... />
)}
```

**Efeito:** rail volta a montar em plugins quando sidebar hidden. Peek funciona.

### §2.4 Mudança 3 — Conditional render do sidebar-shell (App.tsx:4230)

**Antes:**
```tsx
{activeView !== 'settings' && activeView !== 'profile' && activeView !== 'plugins' && (sidebarMode !== 'hidden' || sidebarPeek || sidebarPeekLeaving) && (
  <div className="sidebar-shell" ...>
    <AppSidebar ... />
    ...
  </div>
)}
```

**Depois:**
```tsx
{activeView !== 'settings' && activeView !== 'profile' && (sidebarMode !== 'hidden' || sidebarPeek || sidebarPeekLeaving) && (
  <div className="sidebar-shell" ...>
    <AppSidebar ... />
    ...
  </div>
)}
```

**Efeito:** sidebar-shell volta a montar em plugins. AppSidebar renderiza com `activeView='plugins'` → item Plugins fica ativo (já funciona, AppSidebar.tsx:210).

### §2.5 Mudança 4 — Classe `view-fullscreen` (App.tsx:4203)

**Antes:**
```tsx
className={`app-layout sidebar-${sidebarMode} ${sidebarPeek ? 'sidebar-peek' : ''} ${activeView === 'settings' ? 'settings-open' : ''} ${activeView === 'settings' || activeView === 'profile' || activeView === 'plugins' ? 'view-fullscreen' : ''} ${terminal.terminalOpen ? 'terminal-open' : ''} ${review.reviewOpen ? 'review-open' : ''}`}
```

**Depois:**
```tsx
className={`app-layout sidebar-${sidebarMode} ${sidebarPeek ? 'sidebar-peek' : ''} ${activeView === 'settings' ? 'settings-open' : ''} ${activeView === 'settings' || activeView === 'profile' ? 'view-fullscreen' : ''} ${terminal.terminalOpen ? 'terminal-open' : ''} ${review.reviewOpen ? 'review-open' : ''}`}
```

**Efeito:** classe `view-fullscreen` NÃO é mais aplicada em plugins. Grid volta ao normal (coluna sidebar + workspace). layout.css:530-536 não se aplica mais a plugins.

### §2.6 Mudança 5 — Workspace `grid-column` (layout.css)

**Nenhuma mudança em layout.css necessária.** As regras existentes já cobrem:
- `.app-layout` (sem `view-fullscreen`) → grid normal com `var(--sidebar-width)` na coluna 1.
- `.workspace` → `grid-column: 2` (default, não precisa de regra explícita).
- Quando `activeView === 'plugins'` e `sidebarMode === 'hidden'` (sem peek), `--sidebar-width = 0` → workspace ocupa tudo (igual chat sem sidebar).
- Quando peek dispara, `--sidebar-peek-width` expande o shell flutuante (igual chat).

**Verificar:** `.workspace` tem `grid-column` default? Se sim, OK. Se não, pode precisar de regra explícita. **Ação Ciri:** grep `\.workspace` em layout.css e confirmar.

### §2.7 Mudança 6 — ESC handler (App.tsx:780)

**Nenhuma mudança.** ESC continua funcionando para plugins:
```tsx
if (activeView !== 'settings' && activeView !== 'profile' && activeView !== 'plugins') return undefined
```
Continua cobrindo plugins. ESC → `setActiveView('chat')`.

### §2.8 Mudança 7 — ← Voltar no PluginsView

**Nenhuma mudança.** PluginsView.tsx:343 já tem `<button className="profile-back" onClick={onClose}>`. `onClose` continua sendo `() => setActiveView('chat')` (App.tsx:4305). Funciona.

### §2.9 Mudança 8 — `onSelectConversation` saindo de plugins

**Verificar (Ciri):** quando user clica num chat na sidebar enquanto está em plugins, `onSelectConversation(id)` é chamado. Esse handler (em App.tsx) precisa setar `activeView='chat'` para sair de plugins. **Provável que já faça** (mesmo handler usado em chat mode), mas Ciri deve confirmar com grep.

Se NÃO fizer: adicionar `setActiveView('chat')` no handler `selectConversation`. Risco baixo.

### §2.10 Resumo das mudanças

| # | Arquivo | Linha | Mudança | Risco |
|---|---|---|---|---|
| 1 | App.tsx | 509 | Remover `\|\| activeView === 'plugins'` de `isFullscreenView` | LOW |
| 2 | App.tsx | 4205 | Remover `&& activeView !== 'plugins'` do conditional do rail | LOW |
| 3 | App.tsx | 4230 | Remover `&& activeView !== 'plugins'` do conditional do sidebar-shell | LOW |
| 4 | App.tsx | 4203 | Remover `\|\| activeView === 'plugins'` da classe `view-fullscreen` | LOW |
| 5 | layout.css | — | **Nenhuma** (verificar §2.6) | NONE |
| 6 | App.tsx | 780 | **Nenhuma** (ESC já cobre plugins) | NONE |
| 7 | PluginsView.tsx | 343 | **Nenhuma** (← Voltar já existe) | NONE |
| 8 | App.tsx | selectConversation | **Verificar** se seta `activeView='chat'` | LOW |

**Total: 4 edits cirúrgicos + 1 verificação.** Sem refactor. Sem novos componentes. Sem novas classes CSS.

---

## §3 Peek 100% intacto — prova de não-regressão

### §3.1 Por que o peek não é tocado

O peek é controlado por:
- `sidebarPeek` state (App.tsx:375)
- `sidebarPeekLeaving` state (App.tsx:380)
- `peekSuppressUntilPointerLeft` ref (App.tsx:389)
- `sidebarVisualMode` derivado (App.tsx:506)
- `--sidebar-peek-width` CSS var (App.tsx:530)
- Handlers `showSidebarPeek` / `scheduleHideSidebarPeek` / `pinSidebar`
- Classes CSS `.is-peek` / `.is-peek-leaving` (layout.css:134, 149)
- Animações `sidebar-peek-enter` / `sidebar-peek-leave` (layout.css:183, 188)
- Reduced-motion fallback (layout.css:1261)

**Nenhum desses é tocado pela spec.** A única mudança que afeta peek indiretamente é: o rail e o sidebar-shell voltam a ser montados em plugins (Mudanças 2 e 3). Isso **reativa** o peek em plugins — exatamente o comportamento desejado.

### §3.2 Matriz de estados peek × views (pós-spec)

| `activeView` | `sidebarMode` | `sidebarPeek` | Rail? | Shell? | Comportamento |
|---|---|---|---|---|---|
| chat | expanded | false | NO | YES | Sidebar pinned |
| chat | hidden | false | YES | NO | Rail visível, hover abre peek |
| chat | hidden | true | NO | YES (peek) | Peek ativo |
| chat | hidden | — (leaving) | NO | YES (leaving) | Fade out |
| **plugins** | **expanded** | **false** | **NO** | **YES** | **Sidebar pinned (NOVO)** |
| **plugins** | **hidden** | **false** | **YES** | **NO** | **Rail visível (NOVO)** |
| **plugins** | **hidden** | **true** | **NO** | **YES (peek)** | **Peek ativo (NOVO)** |
| **plugins** | **hidden** | **— (leaving)** | **NO** | **YES (leaving)** | **Fade out (NOVO)** |
| settings | — | — | NO | NO | Fullscreen (intacto) |
| profile | — | — | NO | NO | Fullscreen (intacto) |

**Todos os estados NOVOS em plugins são idênticos aos estados equivalentes em chat.** Peek usa exatamente os mesmos handlers, classes, animações. Zero código novo no path do peek.

---

## §4 Comportamento esperado pós-spec

### §4.1 Entrar em Plugins
1. User clica item Plugins na sidebar.
2. `onSelectView('plugins')` → `setActiveView('plugins')`.
3. App.tsx re-renderiza: `isFullscreenView = false` (não mais inclui plugins).
4. `effectiveSidebarWidth = sidebarWidth` (ou compact/hidden conforme estado).
5. Grid: coluna sidebar + workspace. Sidebar permanece montada.
6. PluginsView renderiza no `.workspace` (grid-column 2).
7. Item Plugins na sidebar fica `active` (já funciona).

### §4.2 Sair de Plugins (3 caminhos)
- **← Voltar:** click no botão `profile-back` do PluginsView → `onClose` → `setActiveView('chat')`.
- **ESC:** keydown handler → `setActiveView('chat')`.
- **Clicar num chat/projeto na sidebar:** `onSelectConversation(id)` ou `onSelectView('chat')` → volta para chat.

### §4.3 Colapsar sidebar em Plugins
1. User clica no toggle de colapso (botão no AppSidebar).
2. `toggleSidebarVisibility` → `sidebarMode = 'hidden'`.
3. Sidebar desmonta, rail monta.
4. Workspace expande para full-width.
5. Hover na borda esquerda → peek funciona (igual chat).

### §4.4 Re-expandir sidebar em Plugins
- Click no rail → `pinSidebar` → `sidebarMode = 'expanded'`.
- OU hover no rail → peek → click no pin → `pinSidebar`.

---

## §5 Riscos e testes de regressão (Aloy)

### §5.1 Riscos identificados

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| R1 | Workspace não ocupa `grid-column: 2` corretamente em plugins | MED | Verificar §2.6 — grep `.workspace` em layout.css |
| R2 | `selectConversation` não seta `activeView='chat'` → user fica preso em plugins ao clicar num chat | MED | Verificar §2.9 — grep `selectConversation` em App.tsx |
| R3 | Peek começa a disparar em plugins quando não deveria (ex: user não quer peek em plugins) | LOW | Comportamento é idêntico ao chat. Se user não quer peek, colapsa a sidebar (mesmo UX) |
| R4 | `--sidebar-peek-width` não é setado quando `activeView === 'plugins'` | LOW | App.tsx:530 já usa `sidebarMode === 'hidden' && (sidebarPeek \|\| sidebarPeekLeaving)` — não depende de `activeView` |
| R5 | PluginsView assume que é fullscreen e tem CSS próprio full-bleed | LOW | PluginsView.tsx não tem CSS de layout (só conteúdo). Verificar |
| R6 | `view-fullscreen.settings-open` regras em layout.css:539-543 podem ter efeito colateral | LOW | Só se aplicam se `view-fullscreen` estiver setado. Plugins não terá mais essa classe |
| R7 | Focus trap: ESC em plugins com sidebar visível pode conflitar com atalhos da sidebar | LOW | ESC handler é window-level, não conflita com sidebar |
| R8 | Resizer da sidebar aparece em plugins (App.tsx:4269) — pode ser indesejado | LOW | É o mesmo comportamento do chat. Manter |
| R9 | `workspace-folder-badge` (App.tsx:4288) só renderiza em `activeView === 'chat'` — plugins não mostra | NONE | Já é o comportamento hoje. Sem mudança |
| R10 | Subagent panel / terminal / review podem abrir sobre plugins | LOW | Já é o comportamento hoje (grid columns). Sem mudança |

### §5.2 Testes de regressão Aloy

#### §5.2.1 Peek (CRÍTICO — zero regressão aceitável)

| # | Cenário | Passo-a-passo | Esperado |
|---|---|---|---|
| P1 | Peek entra em plugins | 1. Sidebar hidden em chat. 2. Click Plugins. 3. Hover borda esquerda. | Rail aparece, peek expande com animação 260ms |
| P2 | Peek sai em plugins | 1. Peek ativo em plugins. 2. Mouse leave. | Fade out 220ms, shell desmonta, rail volta |
| P3 | Peek pin em plugins | 1. Peek ativo em plugins. 2. Click no pin. | `sidebarMode='expanded'`, sidebar persiste |
| P4 | Peek suppress em plugins | 1. Peek ativo. 2. Mouse leave rápido. 3. Hover imediato de volta. | Suppress flag impede re-peek até pointer sair da área |
| P5 | Peek reduced-motion | 1. `prefers-reduced-motion: reduce`. 2. Peek em plugins. | Animação instantânea (120ms fade) |
| P6 | Peek width freeze | 1. Peek ativo em plugins. 2. `sidebarWidth` muda. | Peek mantém largura original até leave |
| P7 | Peek × ESC | 1. Peek ativo em plugins. 2. ESC. | Sai de plugins (não fecha peek) — peek some com view |
| P8 | Peek × toggle collapse | 1. Sidebar expanded em plugins. 2. Toggle collapse. 3. Hover borda. | Peek funciona após collapse |

#### §5.2.2 Colapso / expandir

| # | Cenário | Esperado |
|---|---|---|
| C1 | Collapse em plugins | Sidebar desmonta, rail monta, workspace expande |
| C2 | Expand em plugins (via rail click) | Sidebar remonta, rail desmonta |
| C3 | Compact mode em plugins | Sidebar compacta, resizer some (App.tsx:4269) |
| C4 | Resize sidebar em plugins | `startSidebarResize` funciona, largura persiste |
| C5 | Double-click resizer em plugins | `toggleSidebarCompact` alterna compact/expanded |

#### §5.2.3 Atalhos / navegação

| # | Cenário | Esperado |
|---|---|---|
| A1 | ESC em plugins | Volta para chat |
| A2 | ← Voltar em plugins | Volta para chat |
| A3 | Click item chat na sidebar em plugins | Seleciona chat, volta para chat view |
| A4 | Click "Novo chat" em plugins | Cria novo chat, volta para chat view |
| A5 | Click projeto em plugins | Toggle projeto (não sai de plugins necessariamente) |
| A6 | Tab-focus no rail em plugins | Rail focável, Enter abre peek |
| A7 | Cmd+K (palette) em plugins | Palette abre sobre plugins |
| A8 | Cmd+B (toggle sidebar) em plugins | Toggle funciona (se atalho existir) |

#### §5.2.4 Resize / responsive

| # | Cenário | Esperado |
|---|---|---|
| R1 | Window resize com plugins aberto | Grid reflow, sidebar mantém largura |
| R2 | minWidth 960px com plugins | Sidebar + workspace cabem |
| R3 | Maximize / unmaximize | Sem glitch visual |
| R4 | DPI change (movimento entre monitores) | Sem glitch |

#### §5.2.5 Estado ativo / visual

| # | Cenário | Esperado |
|---|---|---|
| V1 | Item Plugins ativo | `sidebar-action.active` classe aplicada (AppSidebar.tsx:210) |
| V2 | Hover em item chat | Highlight visual, não muda active |
| V3 | Click em Settings | Sai de plugins, vai para settings (fullscreen) |
| V4 | Click em Profile | Sai de plugins, vai para profile (fullscreen) |
| V5 | Transição plugins → chat | Sem flash, sem layout shift |

#### §5.2.6 Casos extremos

| # | Cenário | Esperado |
|---|---|---|
| E1 | Plugins aberto + terminal aberto | Terminal ocupa coluna direita, plugins no meio |
| E2 | Plugins aberto + review aberto | Review ocupa coluna direita |
| E3 | Plugins aberto + subagent panel | Subagent panel ocupa coluna direita |
| E4 | Plugins aberto + turn running | Turn indicator visível (topbar) |
| E5 | Login wall em plugins | Login overlay cobre tudo |
| E6 | Plugins aberto sem conversação ativa | Sem crash |

### §5.3 Verificações automáticas (Aloy)

- [ ] `npm run typecheck` — sem erros TS.
- [ ] `npm run test` — vitest suite passa (292+ testes).
- [ ] `npm run lint` — sem warnings novos.
- [ ] Build dev: `npm run dev:renderer` + `cargo run` — app abre sem crash.
- [ ] Verifier agent: PASS.

### §5.4 Verificações manuais (Aloy + Gabriel)

- [ ] Abrir Plugins → sidebar visível e funcional.
- [ ] Colapsar sidebar em Plugins → peek funciona.
- [ ] ESC sai de Plugins.
- [ ] ← Voltar sai de Plugins.
- [ ] Click num chat na sidebar sai de Plugins e abre o chat.
- [ ] Item Plugins fica ativo.
- [ ] Settings/Profile continuam fullscreen (não regressão).
- [ ] Resize window em Plugins — sem glitch.
- [ ] Reduced-motion — peek instantâneo.

---

## §6 Checklist de implementação Ciri

### §6.1 Pré-flight (read-only, antes de editar)

- [ ] `grep -n "isFullscreenView" src/renderer/App.tsx` — confirmar linha 509.
- [ ] `grep -n "view-fullscreen" src/renderer/App.tsx` — confirmar linha 4203.
- [ ] `grep -n "activeView !== 'settings' && activeView !== 'profile' && activeView !== 'plugins'" src/renderer/App.tsx` — confirmar linhas 4205, 4230, 780.
- [ ] `grep -n "\.workspace" src/renderer/styles/layout.css` — confirmar se tem `grid-column` default.
- [ ] `grep -n "selectConversation" src/renderer/App.tsx` — confirmar se seta `activeView='chat'`.
- [ ] `grep -n "profile-back" src/renderer/features/plugins/PluginsView.tsx` — confirmar ← Voltar existe.

### §6.2 Edits (4 cirúrgicos)

- [ ] App.tsx:509 — remover `|| activeView === 'plugins'` de `isFullscreenView`.
- [ ] App.tsx:4203 — remover `|| activeView === 'plugins'` da classe `view-fullscreen`.
- [ ] App.tsx:4205 — remover `&& activeView !== 'plugins'` do conditional do rail.
- [ ] App.tsx:4230 — remover `&& activeView !== 'plugins'` do conditional do sidebar-shell.

### §6.3 Verificações pós-edit

- [ ] `npm run typecheck` — sem erros.
- [ ] `npm run test` — passa.
- [ ] Build dev abre sem crash.
- [ ] Manual smoke: abrir Plugins, sidebar visível, peek funciona, ESC sai.

### §6.4 Não fazer

- **NÃO** adicionar novas classes CSS.
- **NÃO** tocar em `layout.css` (a menos que §2.6 revele que `.workspace` precisa de `grid-column: 2` explícito — verificar primeiro).
- **NÃO** tocar em `AppSidebar.tsx` (item ativo já funciona).
- **NÃO** tocar em `PluginsView.tsx` (← Voltar já existe).
- **NÃO** adicionar novo state.
- **NÃO** refactorar handlers de peek.
- **NÃO** mudar ESC handler.
- **NÃO** criar novo componente.

---

## §7 Veredito arquitetural

**VIÁVEL AGORA. Risco LOW.**

- 4 edits cirúrgicos em App.tsx, zero em CSS, zero em outros arquivos.
- Peek 100% intacto (prova em §3).
- Comportamento pós-spec é idêntico ao chat (matriz §3.2).
- Settings/Profile não tocados (continuam fullscreen).
- Sem novos componentes, sem novo state, sem refactor.

**Risco principal:** R2 (`selectConversation` não seta `activeView='chat'`). Ciri deve verificar antes de editar. Se confirmado bug, adicionar 1 linha ao handler.

**Sem implementação.** Spec pronta para Ciri executar após GO do Grok.
