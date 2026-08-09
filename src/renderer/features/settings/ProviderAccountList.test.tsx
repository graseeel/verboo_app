import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderAccountSummary } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { ProviderAccountList } from './ProviderAccountList'
import type { ProviderUsageRowState } from './useProviderAccounts'

afterEach(cleanup)

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
        rows={[{ account, status: 'unavailable', errorCode: 'provider_usage_unavailable' }]}
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
  it('renders an explicit active-turn lock and disables account switching', () => {
    renderList({ switchLocked: true })
    expect(screen.getByText('Verboo is responding. Wait or stop the response before switching accounts.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Use here' })).toHaveProperty('disabled', true)
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
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove' }))
    expect(onRemove).toHaveBeenCalledWith('codex', 'codex-a')
  })
})
