import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountSummary } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { ProviderAccountList } from './ProviderAccountList'
import type { ProviderUsageRowState } from './useProviderAccounts'
import { getProviderAccountNickname, setProviderAccountNickname } from './providerAccountNicknames'
import { getProviderAccountViewMode, setProviderAccountViewMode } from './providerAccountViewMode'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

const account: ProviderAccountSummary = {
  schemaVersion: 1,
  provider: 'codex',
  accountId: 'codex-a',
  displayLabel: 'Codex 1',
  planDisplayName: 'Plus',
  isDefault: true,
  connectionState: 'connected',
}

function renderList(overrides: Partial<React.ComponentProps<typeof ProviderAccountList>> = {}) {
  return render(
    <I18nProvider language="en-US">
      <ProviderAccountList
        rows={overrides.rows ?? [{ account, status: 'unavailable', errorCode: 'provider_usage_unavailable' }]}
        conversationBindings={{}}
        switchLocked={false}
        onAdd={() => {}}
        onSetDefault={() => {}}
        onUse={() => {}}
        onReconnect={() => {}}
        onRemove={() => {}}
        onRefresh={() => {}}
        {...overrides}
      />
    </I18nProvider>,
  )
}

describe('ProviderAccountList', () => {
  it('renders an explicit active-turn lock and disables every account-switching action', () => {
    const nonDefaultRow: ProviderUsageRowState = {
      account: { ...account, isDefault: false },
      status: 'unavailable',
      errorCode: 'provider_usage_unavailable',
    }
    renderList({ switchLocked: true, rows: [nonDefaultRow] })
    expect(screen.getByText('Verboo is responding. Wait or stop the response before switching accounts.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use here' })).toHaveProperty('disabled', true)
    // P1 — todos os itens do kebab que trocam a conta ficam bloqueados sob
    // lock; apenas Refresh (somente leitura) permanece ativo.
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    expect(screen.getByRole('menuitem', { name: /make default|tornar padrão/i })).toHaveProperty('disabled', true)
    expect(screen.getByRole('menuitem', { name: /reconnect|reconectar/i })).toHaveProperty('disabled', true)
    expect(screen.getByRole('menuitem', { name: /^Remove$|^Remover$/i })).toHaveProperty('disabled', true)
    expect(screen.getByRole('menuitem', { name: /^Refresh$|^Atualizar$/i })).toHaveProperty('disabled', false)
  })

  it('P1: shows the primary action as in use when the account is bound to the conversation', () => {
    renderList({ conversationBindings: { codex: 'codex-a' } })
    expect(screen.getByText(/in use|em uso/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use here|usar aqui/i })).toBeNull()
  })

  it('P1: opens a kebab menu with the non-primary actions', () => {
    const nonDefaultRow: ProviderUsageRowState = {
      account: { ...account, isDefault: false },
      status: 'unavailable',
      errorCode: 'provider_usage_unavailable',
    }
    renderList({ rows: [nonDefaultRow] })
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    expect(screen.getByRole('menuitem', { name: /make default|tornar padrão/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /reconnect|reconectar/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Refresh$|^Atualizar$/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Remove$|^Remover$/i })).toBeInTheDocument()
  })

  it('P1: hides the make-default item when the account is already the default', () => {
    renderList({})
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    expect(screen.queryByRole('menuitem', { name: /make default|tornar padrão/i })).toBeNull()
  })

  it('P1: kebab actions still fire their callbacks', () => {
    const onReconnect = vi.fn()
    const onRefresh = vi.fn()
    const onSetDefault = vi.fn()
    const nonDefaultRow: ProviderUsageRowState = {
      account: { ...account, isDefault: false },
      status: 'unavailable',
      errorCode: 'provider_usage_unavailable',
    }
    renderList({
      rows: [nonDefaultRow],
      onReconnect,
      onRefresh,
      onSetDefault,
    })
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /reconnect|reconectar/i }))
    expect(onReconnect).toHaveBeenCalledWith('codex', 'codex-a')
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Refresh$|^Atualizar$/i }))
    expect(onRefresh).toHaveBeenCalledWith('codex', 'codex-a')
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /make default|tornar padrão/i }))
    expect(onSetDefault).toHaveBeenCalledWith('codex', 'codex-a')
  })

  it('P1: disabled kebab actions do not fire under lock', () => {
    const onReconnect = vi.fn()
    renderList({ switchLocked: true, onReconnect })
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /reconnect|reconectar/i }))
    expect(onReconnect).not.toHaveBeenCalled()
  })

  it('requires confirmation before binding an account to the conversation', () => {
    const onUse = vi.fn()
    renderList({ onUse })
    fireEvent.click(screen.getByRole('button', { name: 'Use here' }))
    expect(onUse).not.toHaveBeenCalled()
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Use this account' }))
    expect(onUse).toHaveBeenCalledWith('codex', 'codex-a')
  })

  it('requires confirmation before removing the local account', () => {
    const onRemove = vi.fn()
    renderList({ onRemove })
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    fireEvent.click(screen.getByRole('menuitem', { name: /^Remove$|^Remover$/i }))
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledWith('codex', 'codex-a')
  })

  it('P3: shows the user nickname when one is saved, else the CLI display label', () => {
    renderList({})
    expect(screen.getByText('Codex 1')).toBeInTheDocument()

    cleanup()
    setProviderAccountNickname('codex', 'codex-a', 'Work Codex')
    renderList({})
    expect(screen.getByText('Work Codex')).toBeInTheDocument()
    expect(screen.queryByText('Codex 1')).toBeNull()
    expect(getProviderAccountNickname('codex', 'codex-a')).toBe('Work Codex')
  })

  it('UI: the nickname pencil sits inline, right of the account name (not in the kebab row)', () => {
    renderList({})
    const editButton = screen.getByRole('button', { name: /edit nickname|editar apelido/i })
    const nameRow = document.querySelector('.provider-account-name') as HTMLElement
    const actionsRow = document.querySelector('.provider-account-actions') as HTMLElement
    expect(nameRow).not.toBeNull()
    expect(actionsRow).not.toBeNull()
    expect(nameRow.contains(editButton)).toBe(true)
    expect(actionsRow.contains(editButton)).toBe(false)
  })

  it('UI: Use here and the kebab sit on one aligned actions row', () => {
    renderList({})
    const useButton = screen.getByRole('button', { name: 'Use here' })
    const actionsRow = document.querySelector('.provider-account-actions') as HTMLElement
    const kebab = screen.getByRole('button', { name: /account menu|menu da conta/i })
    expect(actionsRow).not.toBeNull()
    expect(actionsRow.contains(useButton)).toBe(true)
    expect(actionsRow.contains(kebab)).toBe(true)
  })

  it('P3: edits the nickname inline and persists it locally', () => {
    renderList({})
    fireEvent.click(screen.getByRole('button', { name: /edit nickname|editar apelido/i }))
    const input = screen.getByRole('textbox', { name: /nickname|apelido/i })
    fireEvent.change(input, { target: { value: 'Home' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(getProviderAccountNickname('codex', 'codex-a')).toBe('Home')
    expect(screen.getByText('Home')).toBeInTheDocument()
    expect(screen.queryByText('Codex 1')).toBeNull()
  })

  // L1 — UX do login no caminho novo (providerAccountsV1): o card do grupo
  // precisa mostrar o estágio + Cancelar durante o fluxo, e o botão
  // Adicionar conta precisa travar para evitar dois providerLoginStart
  // simultâneos. O App.tsx já mantém connectingProvider/providerLoginStage
  // e o invoke provider_login_cancel já existe no caminho legacy.
  function codexGroup(): HTMLElement {
    return screen.getByRole('heading', { name: 'Codex' }).closest('.provider-account-group') as HTMLElement
  }

  it('L1: disables the Add account button when a login for that provider is in progress', () => {
    renderList({ connectingProvider: 'codex' })
    const addBtn = within(codexGroup()).getByRole('button', { name: /add account|adicionar conta/i })
    expect(addBtn).toHaveProperty('disabled', true)
  })

  it('L1: the Add account button stays enabled when a different provider is connecting', () => {
    renderList({ connectingProvider: 'claude' })
    const addBtn = within(codexGroup()).getByRole('button', { name: /add account|adicionar conta/i })
    expect(addBtn).toHaveProperty('disabled', false)
  })

  it('L1: renders the starting stage as quiet status and Cancel fires onCancelLogin', () => {
    const onCancelLogin = vi.fn()
    renderList({ connectingProvider: 'codex', loginStage: 'starting', onCancelLogin })
    // O estágio NÃO é um botão — é status quieto (texto + spinner pequeno).
    expect(within(codexGroup()).queryByRole('button', { name: /connecting…|conectando…/i })).toBeNull()
    const stage = within(codexGroup()).getByText(/connecting…|conectando…/i)
    const stageBox = stage.closest('.provider-login-stage')
    expect(stageBox).not.toBeNull()
    expect(stageBox?.querySelector('.spin-icon')).toBeTruthy()
    // Cancelar é botão secundário padrão, clicável, mesma linha.
    const cancel = within(codexGroup()).getByRole('button', { name: /^cancel$|^cancelar$/i })
    expect(cancel).toHaveProperty('disabled', false)
    fireEvent.click(cancel)
    expect(onCancelLogin).toHaveBeenCalledTimes(1)
  })

  it('L1: renders the awaiting_browser stage label on the connecting group', () => {
    renderList({ connectingProvider: 'codex', loginStage: 'awaiting_browser' })
    const stage = within(codexGroup()).getByText(/waiting for browser…|aguardando navegador…/i)
    expect(stage.closest('.provider-login-stage')).not.toBeNull()
    expect(within(codexGroup()).queryByRole('button', { name: /waiting for browser…/i })).toBeNull()
  })

  // L2 (1) — renomear a conta não pode apagar o símbolo do provedor. O card
  // da conta precisa exibir o ícone do provedor SEMPRE (com e sem nickname):
  // o relato do usuário (screenshot) mostra a conta renomeada "Sharon g" sem
  // nenhuma referência visual ao provedor depois que o displayLabel do CLI
  // ("Codex 2") foi substituído pelo apelido.
  it('L2: the provider symbol stays on the account card after renaming', () => {
    setProviderAccountNickname('codex', 'codex-a', 'Home')
    renderList({})
    expect(document.querySelector('.provider-account-card [data-testid="provider-icon-codex"]')).toBeTruthy()
  })

  it('L2: the provider symbol is visible on every account card, renamed or not', () => {
    renderList({})
    expect(document.querySelector('.provider-account-card [data-testid="provider-icon-codex"]')).toBeTruthy()
  })

  // L2 (2) — uma única linha de ações: a ação primária (Usar aqui / Em uso)
  // e o kebab alinhados verticalmente na MESMA row.
  it('L2: primary action and kebab share one aligned actions row', () => {
    renderList({})
    const actionsRow = document.querySelector('.provider-account-actions') as HTMLElement
    const useButton = screen.getByRole('button', { name: 'Use here' })
    const kebab = screen.getByRole('button', { name: /account menu|menu da conta/i })
    expect(actionsRow).not.toBeNull()
    expect(actionsRow.contains(useButton)).toBe(true)
    expect(actionsRow.contains(kebab)).toBe(true)
  })

  // ONDA B + EMENDA — a lista vertical de contas vira CARDS COMPACTOS por
  // conta, no máximo 3 por linha; a partir da 4ª conta QUEBRA para a linha
  // de baixo (wrap). SEM rolagem lateral (o usuário não gostou do scroll).
  it('ONDA B: four accounts render as four sibling cards in one wrap container (no horizontal scroll)', () => {
    const others: ProviderUsageRowState[] = ['codex-b', 'codex-c', 'codex-d'].map((accountId, i) => ({
      account: {
        ...account,
        accountId,
        displayLabel: `Codex ${i + 2}`,
        isDefault: false,
      },
      status: 'unavailable' as const,
      errorCode: 'provider_usage_unavailable',
    }))
    renderList({ rows: [{ account, status: 'unavailable', errorCode: 'provider_usage_unavailable' }, ...others] })
    const container = document.querySelector('.provider-account-cards')
    expect(container).not.toBeNull()
    const cards = Array.from(container?.querySelectorAll('.provider-account-card') ?? [])
    expect(cards.length).toBe(4)
    // Irmãos: cada card é filho DIRETO do container (o wrap é CSS no
    // container; os cards jamais ficam aninhados).
    for (const card of cards) {
      expect(card.parentElement).toBe(container)
    }
  })

  // A2 — a ação primária fica imediatamente ABAIXO das janelas de uso,
  // alinhada à esquerda com o bloco; o kebab permanece à direita na MESMA
  // linha (não mais centralizado na largura toda).
  it('A2: primary action sits below the usage windows, left-aligned, kebab right on the same line', () => {
    const readyRow: ProviderUsageRowState = {
      account,
      status: 'fresh',
      snapshot: {
        schemaVersion: 1,
        provider: 'codex',
        accountId: 'codex-a',
        fetchedAt: '2026-08-09T12:00:00.000Z',
        plan: undefined,
        windows: [{ id: 'weekly', kind: 'weekly', displayLabel: 'Weekly', usedPercent: 20, resetsAt: '2026-08-16T18:00:00.000Z' }],
      },
    }
    renderList({ rows: [readyRow] })
    const card = document.querySelector('.provider-account-card') as HTMLElement
    expect(card).not.toBeNull()
    const usage = card.querySelector('.provider-usage-windows') as HTMLElement
    const actions = card.querySelector('.provider-account-actions') as HTMLElement
    expect(usage).not.toBeNull()
    expect(actions).not.toBeNull()
    // Actions vêm DEPOIS (abaixo) das janelas de uso.
    expect(usage.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Ação primeiro (à esquerda), kebab depois (à direita), mesma linha.
    const useButton = screen.getByRole('button', { name: 'Use here' })
    const kebab = screen.getByRole('button', { name: /account menu|menu da conta/i })
    expect(actions.firstElementChild).toBe(useButton)
    expect(actions.lastElementChild).toBe(kebab)
  })

  // VIEW — modo de visualização alternável, persistido em localStorage
  // (padrão providerAccountNicknames — nunca no protocolo CLI).
  it('VIEW: defaults to simple (compact cards) and the toggle switches to expanded rows', () => {
    renderList({})
    expect(document.querySelector('.provider-account-cards')).not.toBeNull()
    expect(document.querySelector('.provider-account-row')).toBeNull()
    const toggle = screen.getByRole('button', { name: /view: simple|visualização: simples/i })
    expect(toggle).toHaveProperty('title', 'View: simple')
    fireEvent.click(toggle)
    expect(document.querySelector('.provider-account-cards')).toBeNull()
    expect(document.querySelector('.provider-account-row')).not.toBeNull()
    expect(document.querySelector('.provider-account-list')?.className).toContain('is-expanded')
  })

  it('VIEW: toggling back returns to simple cards', () => {
    renderList({})
    fireEvent.click(screen.getByRole('button', { name: /view: simple|visualização: simples/i }))
    expect(document.querySelector('.provider-account-row')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /view: expanded|visualização: expandida/i }))
    expect(document.querySelector('.provider-account-cards')).not.toBeNull()
    expect(document.querySelector('.provider-account-row')).toBeNull()
  })

  it('VIEW: the mode persists across re-renders (localStorage, never the CLI)', () => {
    renderList({})
    fireEvent.click(screen.getByRole('button', { name: /view: simple|visualização: simples/i }))
    expect(document.querySelector('.provider-account-row')).not.toBeNull()
    cleanup()
    renderList({})
    expect(document.querySelector('.provider-account-row')).not.toBeNull()
    expect(document.querySelector('.provider-account-cards')).toBeNull()
    expect(window.localStorage.getItem('verboo.providerAccountViewMode')).toBe('expanded')
  })

  it('VIEW: an invalid stored value falls back to simple', () => {
    window.localStorage.setItem('verboo.providerAccountViewMode', 'widescreen')
    expect(getProviderAccountViewMode()).toBe('simple')
    renderList({})
    expect(document.querySelector('.provider-account-cards')).not.toBeNull()
  })
})

// VIEW — os comportamentos-chave rodam nos DOIS modos, sem afrouxar pin.
describe.each([
  ['simple', 'provider-account-card', 'provider-account-cards'],
  ['expanded', 'provider-account-row', 'provider-account-group'],
] as const)('VIEW behaviors in %s mode', (viewMode, accountClass, parentClass) => {
  beforeEach(() => {
    setProviderAccountViewMode(viewMode)
  })

  it('keeps the provider symbol on the account row/card', () => {
    renderList({})
    expect(document.querySelector(`.${accountClass} [data-testid="provider-icon-codex"]`)).toBeTruthy()
  })

  it('keeps the kebab menu', () => {
    renderList({})
    fireEvent.click(screen.getByRole('button', { name: /account menu|menu da conta/i }))
    expect(screen.getByRole('menuitem', { name: /reconnect|reconectar/i })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: /^Remove$|^Remover$/i })).toBeInTheDocument()
  })

  it('keeps inline nickname editing', () => {
    renderList({})
    fireEvent.click(screen.getByRole('button', { name: /edit nickname|editar apelido/i }))
    const input = screen.getByRole('textbox', { name: /nickname|apelido/i })
    fireEvent.change(input, { target: { value: 'Home' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(getProviderAccountNickname('codex', 'codex-a')).toBe('Home')
    expect(screen.getByText('Home')).toBeInTheDocument()
  })

  it('keeps the primary action flow (Use here → confirm) and the in-use state', () => {
    const onUse = vi.fn()
    renderList({ onUse })
    fireEvent.click(screen.getByRole('button', { name: 'Use here' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use this account' }))
    expect(onUse).toHaveBeenCalledWith('codex', 'codex-a')
    cleanup()
    renderList({ conversationBindings: { codex: 'codex-a' } })
    expect(screen.getByText(/in use|em uso/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /use here|usar aqui/i })).toBeNull()
  })

  it('keeps the login stage + disabled Add account during login', () => {
    renderList({ connectingProvider: 'codex', loginStage: 'starting' })
    const group = screen.getByRole('heading', { name: 'Codex' }).closest('.provider-account-group') as HTMLElement
    expect(within(group).getByText(/connecting…|conectando…/i)).toBeInTheDocument()
    expect(within(group).queryByRole('button', { name: /connecting…/i })).toBeNull()
    expect(within(group).getByRole('button', { name: /add account|adicionar conta/i })).toHaveProperty('disabled', true)
  })

  it('renders the account inside the expected container for the mode', () => {
    renderList({})
    const rowOrCard = document.querySelector(`.${accountClass}`)
    expect(rowOrCard).not.toBeNull()
    expect(rowOrCard?.parentElement?.className).toBe(parentClass)
  })
})
