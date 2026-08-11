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
    expect(screen.getByText(/32% used|32% usado/)).toBeInTheDocument()
    expect(screen.getByText(/71% used|71% usado/)).toBeInTheDocument()
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

  // P2 — a 100% weekly window was unreadable (read as 100% available). The
  // label must say "used" and the remaining percentage must be explicit.
  it('P2: labels a 100% weekly window as used with 0% remaining', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'codex',
      accountId: 'codex-a',
      plan: { id: 'plus', displayName: 'Plus' },
      windows: [windowOf('weekly', 'weekly', 100)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(screen.getByText(/100% used|100% usado/)).toBeInTheDocument()
    expect(screen.getByText(/0% remaining|0% restante/)).toBeInTheDocument()
    expect(screen.queryByText(/^100%$/)).toBeNull()
  })

  it('P2: shows used and remaining labels on a partially used window', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'codex',
      accountId: 'codex-a',
      plan: { id: 'plus', displayName: 'Plus' },
      windows: [windowOf('weekly', 'weekly', 32)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(screen.getByText(/32% used|32% usado/)).toBeInTheDocument()
    expect(screen.getByText(/68% remaining|68% restante/)).toBeInTheDocument()
  })

  it('P2: colors the bar by band — warning at >=80%, danger at 100%', () => {
    const warning = renderUsage(state({
      schemaVersion: 1,
      provider: 'codex',
      accountId: 'codex-a',
      plan: { id: 'plus', displayName: 'Plus' },
      windows: [windowOf('weekly', 'weekly', 80)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(warning.container.querySelector('.provider-usage-window')?.className).toContain('is-warning')

    cleanup()

    const exhausted = renderUsage(state({
      schemaVersion: 1,
      provider: 'codex',
      accountId: 'codex-a',
      plan: { id: 'plus', displayName: 'Plus' },
      windows: [windowOf('weekly', 'weekly', 100)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(exhausted.container.querySelector('.provider-usage-window')?.className).toContain('is-exhausted')
  })

  // Captured 2026-08-10 — real envelope value for the Claude 5-hour window:
  // resetsAt: "2026-08-10T16:00:00.349529+00:00" (microseconds + offset).
  it('shows the reset time of a 5-hour window when resetsAt carries microseconds+offset', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      plan: { id: 'pro', displayName: 'Pro' },
      windows: [{ ...windowOf('5h', 'session', 15), resetsAt: '2026-08-10T16:00:00.349529+00:00' }],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    // The captured microsecond timestamp must render a concrete reset time,
    // never the "Horário de reset não informado" fallback.
    expect(screen.queryByText(/reset time not reported|horário de reset não informado/i)).toBeNull()
    expect(screen.getByText(/2026/i)).toBeInTheDocument()
  })

  // Boundary artifact: the same captured timestamp wrapped in whitespace.
  // new Date() rejects any surrounding whitespace (returns Invalid Date),
  // so the raw parse shows the "não informado" fallback — the presentation
  // must normalize before parsing.
  it('renders the reset time even when the captured resetsAt carries surrounding whitespace', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      plan: { id: 'pro', displayName: 'Pro' },
      windows: [{ ...windowOf('5h', 'session', 15), resetsAt: ' 2026-08-10T16:00:00.349529+00:00 ' }],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    expect(screen.queryByText(/reset time not reported|horário de reset não informado/i)).toBeNull()
    expect(screen.getByText(/2026/i)).toBeInTheDocument()
  })

  // A3 — o card do Claude mostrava "5 horas / Semanal / Fable Weekly": o
  // último é o displayLabel CRU do CLI (vaza inglês). Para kind
  // model-scoped-weekly o rótulo deve ser {modelScope capitalizado} + a
  // palavra semanal/weekly LOCALIZADA (pt: "Fable semanal"; en: "Fable
  // Weekly") — nunca o displayLabel.
  it('A3: localizes the model-scoped weekly label in pt-BR (never the raw CLI displayLabel)', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      plan: { id: 'max', displayName: 'Max' },
      windows: [{
        id: 'fable-weekly',
        kind: 'model-scoped-weekly',
        displayLabel: 'Fable Weekly',
        modelScope: 'fable',
        usedPercent: 22,
        resetsAt: '2026-08-16T18:00:00.000Z',
      }],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }), 'pt-BR')
    expect(screen.getByText(/Fable semanal/i)).toBeInTheDocument()
    expect(screen.queryByText(/Fable Weekly/i)).toBeNull()
  })

  it('A3: builds the model-scoped weekly label with the localized weekly word in en-US', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      plan: { id: 'max', displayName: 'Max' },
      windows: [{
        id: 'fable-weekly',
        kind: 'model-scoped-weekly',
        displayLabel: 'Fable Weekly',
        modelScope: 'fable',
        usedPercent: 22,
        resetsAt: '2026-08-16T18:00:00.000Z',
      }],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }), 'en-US')
    expect(screen.getByText(/Fable Weekly/i)).toBeInTheDocument()
  })

  it('A3: other window kinds stay localized (five hours + weekly)', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'claude',
      accountId: 'claude-a',
      plan: { id: 'pro', displayName: 'Pro' },
      windows: [windowOf('5h', 'session', 15), windowOf('weekly', 'weekly', 20)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }), 'pt-BR')
    expect(screen.getByText(/5 horas/i)).toBeInTheDocument()
    expect(screen.getByText(/Semanal/i)).toBeInTheDocument()
    expect(screen.queryByText(/Weekly/i)).toBeNull()
  })

  it('P2: exposes used and remaining in the progressbar aria-valuetext', () => {
    renderUsage(state({
      schemaVersion: 1,
      provider: 'codex',
      accountId: 'codex-a',
      plan: { id: 'plus', displayName: 'Plus' },
      windows: [windowOf('weekly', 'weekly', 100)],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    }))
    const bar = screen.getByRole('progressbar')
    expect(bar.getAttribute('aria-valuetext')).toMatch(/100% used, 0% remaining|100% usado, 0% restante/i)
  })
})
