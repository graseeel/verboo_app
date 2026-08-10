import { describe, expect, it } from 'vitest'
import type { ProviderAccountSummary, ProviderUsageWindow } from '../../../shared/types'
import type { ProviderUsageRowState } from '../settings/useProviderAccounts'
import { classifyProviderQuota, formatQuotaReset, parseResetsAt, selectedExhaustedQuota, selectedQuotaReset } from './providerQuotaPresentation'

function row(accountId: string, status: ProviderUsageRowState['status'], kind: 'weekly' | 'model-scoped-weekly', resetsAt?: string, modelScope?: string, extraWindows: ProviderUsageWindow[] = []): ProviderUsageRowState {
  const account: ProviderAccountSummary = {
    schemaVersion: 1,
    provider: 'codex',
    accountId,
    displayLabel: accountId,
    isDefault: accountId === 'local-a',
    connectionState: 'connected',
  }
  return {
    account,
    status,
    snapshot: {
      schemaVersion: 1,
      provider: 'codex',
      accountId,
      windows: [{ id: modelScope ?? 'base', kind, displayLabel: 'Weekly', modelScope, usedPercent: 100, resetsAt }, ...extraWindows],
      fetchedAt: '2026-08-09T12:00:00.000Z',
    },
  }
}

describe('provider quota presentation', () => {
  it('claims all exhausted only when every connected account has a fresh matching window', () => {
    expect(classifyProviderQuota({ kind: 'weekly' }, [
      row('local-a', 'fresh', 'weekly', '2026-08-12T17:30:00.000Z'),
      row('local-b', 'fresh', 'weekly', '2026-08-13T10:00:00.000Z'),
    ])).toMatchObject({ allExhausted: true, nextResetAt: '2026-08-12T17:30:00.000Z' })
    expect(classifyProviderQuota({ kind: 'weekly' }, [
      row('local-a', 'fresh', 'weekly'),
      row('local-b', 'stale', 'weekly'),
    ]).allExhausted).toBe(false)
  })

  it('does not match a base weekly error to a scoped model window', () => {
    expect(classifyProviderQuota({ kind: 'weekly' }, [row('local-a', 'fresh', 'model-scoped-weekly', undefined, 'gpt-5.3-codex-spark')]).allExhausted).toBe(false)
  })

  it('keeps a selected reset separate from the aggregate claim', () => {
    expect(selectedQuotaReset({ kind: 'weekly' }, row('local-a', 'fresh', 'weekly', '2026-08-12T17:30:00.000Z'))).toBe('2026-08-12T17:30:00.000Z')
    expect(selectedQuotaReset({ kind: 'weekly' }, row('local-a', 'stale', 'weekly', '2026-08-12T17:30:00.000Z'))).toBeUndefined()
  })

  it('does not guess which reset applies when the selected account has multiple exhausted windows', () => {
    const selected = row(
      'local-a',
      'fresh',
      'weekly',
      '2026-08-12T17:30:00.000Z',
      undefined,
      [{
        id: 'fable',
        kind: 'model-scoped-weekly',
        displayLabel: 'Fable weekly',
        modelScope: 'fable',
        usedPercent: 100,
        resetsAt: '2026-08-13T17:30:00.000Z',
      }],
    )

    expect(selectedExhaustedQuota([selected], 'local-a')).toBeUndefined()
  })

  describe('parseResetsAt', () => {
    it('normalizes the captured microsecond+offset timestamp to spec milliseconds', () => {
      // Captured real value from the provider envelope (2026-08-10):
      // "2026-08-10T16:00:00.349529+00:00" — six-digit fraction, offset form.
      expect(parseResetsAt('2026-08-10T16:00:00.349529+00:00')?.toISOString()).toBe('2026-08-10T16:00:00.349Z')
    })

    it('trims surrounding whitespace before parsing', () => {
      expect(parseResetsAt(' 2026-08-10T16:00:00.349529+00:00 ')?.toISOString()).toBe('2026-08-10T16:00:00.349Z')
    })

    it('keeps the millisecond form untouched', () => {
      expect(parseResetsAt('2026-08-10T12:00:00.000Z')?.toISOString()).toBe('2026-08-10T12:00:00.000Z')
    })

    it('returns undefined for missing or unparseable values so the fallback stays honest', () => {
      expect(parseResetsAt(undefined)).toBeUndefined()
      expect(parseResetsAt('')).toBeUndefined()
      expect(parseResetsAt('not-a-date')).toBeUndefined()
    })

    it('formats the captured microsecond timestamp through formatQuotaReset', () => {
      expect(formatQuotaReset('2026-08-10T16:00:00.349529+00:00', 'en-US')).toMatch(/Aug 10, 2026/)
    })
  })
})
