import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountSummary } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { ProviderAccountList } from './ProviderAccountList'
import type { ProviderUsageRowState } from './useProviderAccounts'
import { getProviderAccountNickname, setProviderAccountNickname } from './providerAccountNicknames'

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

  it('UI: Use here sits centered below the usage windows, not in the kebab row', () => {
    renderList({})
    const useButton = screen.getByRole('button', { name: 'Use here' })
    const useRow = document.querySelector('.provider-account-use-row') as HTMLElement
    const actionsRow = document.querySelector('.provider-account-actions') as HTMLElement
    expect(useRow).not.toBeNull()
    expect(actionsRow).not.toBeNull()
    expect(useRow.contains(useButton)).toBe(true)
    expect(actionsRow.contains(useButton)).toBe(false)
    // The kebab stays exactly where it was: in the actions row.
    const kebab = screen.getByRole('button', { name: /account menu|menu da conta/i })
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
})
