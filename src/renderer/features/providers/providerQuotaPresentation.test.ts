import { describe, expect, it } from 'vitest'
import type { ProviderAccountSummary } from '../../../shared/types'
import type { ProviderUsageRowState } from '../settings/useProviderAccounts'
import { classifyProviderQuota, selectedQuotaReset } from './providerQuotaPresentation'

function row(accountId: string, status: ProviderUsageRowState['status'], kind: 'weekly' | 'model-scoped-weekly', resetsAt?: string, modelScope?: string): ProviderUsageRowState {
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
      windows: [{ id: modelScope ?? 'base', kind, displayLabel: 'Weekly', modelScope, usedPercent: 100, resetsAt }],
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
})
