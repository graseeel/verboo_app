import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderAccountSummary, ProviderUsageSnapshot, ProviderUsageWindow } from '../../../shared/types'
import { I18nProvider } from '../../i18n'
import { ProviderUsageWindows } from './ProviderUsageWindows'
import type { ProviderUsageRowState } from './useProviderAccounts'

afterEach(cleanup)

const account: ProviderAccountSummary = {
  schemaVersion: 1,
  provider: 'claude',
  accountId: 'claude-a',
  displayLabel: 'Claude 1',
  isDefault: true,
  connectionState: 'connected',
}

function windowOf(
  id: string,
  kind: ProviderUsageWindow['kind'],
  usedPercent: number,
  modelScope?: string,
): ProviderUsageWindow {
  return {
    id,
    kind,
    displayLabel: id,
    usedPercent,
    modelScope,
    resetsAt: '2026-08-10T12:00:00.000Z',
  }
}

function state(snapshot: ProviderUsageSnapshot): ProviderUsageRowState {
  return { account: { ...account, provider: snapshot.provider, accountId: snapshot.accountId }, status: 'fresh', snapshot }
}

function renderUsage(value: ProviderUsageRowState, language: 'en-US' | 'pt-BR' = 'en-US') {
  return render(
    <I18nProvider language={language}>
      <ProviderUsageWindows state={value} />
    </I18nProvider>,
  )
}

describe('ProviderUsageWindows', () => {
  it('renders Codex weekly/scoped windows and never invents a five-hour window', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'codex',
      accountId: 'codex-a',
      plan: { id: 'plus', displayName: 'Plus' },
      windows: [
        windowOf('weekly', 'weekly', 32),
        windowOf('spark', 'model-scoped-weekly', 71, 'spark'),
        windowOf('session', 'session', 9),
      ],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(screen.getByText('32%')).toBeInTheDocument()
    expect(screen.getByText('71%')).toBeInTheDocument()
    expect(screen.queryByText(/5 hours|5 horas/i)).toBeNull()
  })

  it('shows Claude Pro five-hour and weekly windows without a Fable placeholder', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      plan: { id: 'pro', displayName: 'Pro' },
      windows: [windowOf('5h', 'session', 15), windowOf('weekly', 'weekly', 20)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(screen.getByText(/5 hours|5 horas/i)).toBeInTheDocument()
    expect(screen.getByText(/Weekly|Semanal/i)).toBeInTheDocument()
    expect(screen.queryByText(/did not report|não informou/i)).toBeNull()
  })

  it('makes a Claude Max missing scoped window explicit instead of fabricating a counter', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      plan: { id: 'max', displayName: 'Max' },
      windows: [windowOf('5h', 'session', 15), windowOf('weekly', 'weekly', 20)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(screen.getByText(/not reported|não foi informado/i)).toBeInTheDocument()
    expect(screen.queryByText('0%')).toBeNull()
  })

  it('keeps unavailable usage honest and does not render 0%', () => {
    renderUsage({ account, status: 'unavailable', errorCode: 'provider_usage_timeout' })
    expect(screen.getByText(/usage unavailable|uso indisponível/i)).toBeInTheDocument()
    expect(screen.queryByText('0%')).toBeNull()
  })
})
