import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ProviderAccountSummary,
  ProviderCapabilities,
  ProviderUsageResult,
  ProviderUsageSnapshot,
} from '../../../shared/types'
import { useProviderAccounts, type ProviderAccountsBridge, type ProviderUsageRowState } from './useProviderAccounts'

const capabilities: ProviderCapabilities = {
  providerAccountsV1: true,
  providerUsageV1: true,
  loginTransport: 'pty-slash-v1',
}
const accounts: ProviderAccountSummary[] = [
  { schemaVersion: 1, provider: 'codex', accountId: 'local-a', displayLabel: 'Codex 1', isDefault: true, connectionState: 'connected' },
  { schemaVersion: 1, provider: 'codex', accountId: 'local-b', displayLabel: 'Codex 2', isDefault: false, connectionState: 'connected' },
]

function snapshot(accountId: string): ProviderUsageSnapshot {
  return {
    schemaVersion: 1,
    provider: 'codex',
    accountId,
    plan: { id: 'plus', displayName: 'Plus' },
    windows: [{ id: 'weekly', kind: 'weekly', displayLabel: 'Weekly', usedPercent: 32 }],
    fetchedAt: '2026-08-09T12:00:00.000Z',
  }
}

function bridge(usage: ProviderAccountsBridge['providerAccountsUsage']): ProviderAccountsBridge {
  return {
    providerCapabilities: vi.fn(async () => capabilities),
    providerAccountsList: vi.fn(async () => accounts),
    providerAccountsUsage: usage,
    providerAccountSetDefault: vi.fn(async () => undefined),
    providerAccountRemove: vi.fn(async () => undefined),
  }
}

describe('useProviderAccounts', () => {
  it('revalidates every account on every false-to-true Providers entry', async () => {
    const usage = vi.fn(async (_provider?: 'codex' | 'claude', accountId?: string): Promise<ProviderUsageResult[]> => [{
      provider: 'codex',
      accountId: accountId!,
      snapshot: snapshot(accountId!),
    }])
    const api = bridge(usage)
    const { result, rerender } = renderHook(
      ({ visible }) => useProviderAccounts({ visible, bridge: api }),
      { initialProps: { visible: false } },
    )
    rerender({ visible: true })
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(2))
    rerender({ visible: false })
    rerender({ visible: true })
    await waitFor(() => expect(usage).toHaveBeenCalledTimes(4))
    expect(result.current.rows.every(row => row.status === 'fresh')).toBe(true)
  })

  it('reuses only the identical request that is currently in flight', async () => {
    let resolve!: (value: ProviderUsageResult[]) => void
    const pending = new Promise<ProviderUsageResult[]>(done => { resolve = done })
    const usage = vi.fn(() => pending)
    const api = bridge(usage)
    const { result } = renderHook(() => useProviderAccounts({ visible: false, bridge: api }))
    let first!: Promise<ProviderUsageRowState | undefined>
    let duplicate!: Promise<ProviderUsageRowState | undefined>
    act(() => {
      first = result.current.refreshAccount('codex', 'local-a')
      duplicate = result.current.refreshAccount('codex', 'local-a')
    })
    expect(usage).toHaveBeenCalledTimes(1)
    resolve([{ provider: 'codex', accountId: 'local-a', snapshot: snapshot('local-a') }])
    await act(async () => { await Promise.all([first, duplicate]) })
    await act(async () => { await result.current.refreshAccount('codex', 'local-a') })
    expect(usage).toHaveBeenCalledTimes(2)
  })

  it('settles one failed account as unavailable without hiding the successful row', async () => {
    const usage = vi.fn(async (_provider?: 'codex' | 'claude', accountId?: string) => {
      if (accountId === 'local-b') return [{ provider: 'codex' as const, accountId, errorCode: 'provider_usage_timeout' }]
      return [{ provider: 'codex' as const, accountId: accountId!, snapshot: snapshot(accountId!) }]
    })
    const { result } = renderHook(() => useProviderAccounts({ visible: true, bridge: bridge(usage) }))
    await waitFor(() => expect(result.current.rows).toHaveLength(2))
    await waitFor(() => expect(result.current.rows.find(row => row.account.accountId === 'local-a')?.status).toBe('fresh'))
    await waitFor(() => expect(result.current.rows.find(row => row.account.accountId === 'local-b')?.status).toBe('unavailable'))
  })
})
