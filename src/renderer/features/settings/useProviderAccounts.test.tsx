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
  it('keeps legacy cards hidden when the background capability prefetch fails', async () => {
    const api = {
      ...bridge(vi.fn(async () => [])),
      providerCapabilities: vi.fn(async () => {
        throw new Error('provider_cli_unavailable')
      }),
    }
    const { result } = renderHook(() => useProviderAccounts({ visible: false, bridge: api }))

    await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.providerAccountsList).toHaveBeenCalledTimes(1))
    expect(result.current.accountsLoaded).toBe(false)
    expect(result.current.capabilities.providerAccountsV1).toBe(false)
  })

  it('does not commit a stale hidden prefetch after the visible discovery succeeds', async () => {
    let resolveHidden!: (value: ProviderCapabilities) => void
    const hiddenCapabilities = new Promise<ProviderCapabilities>(resolve => { resolveHidden = resolve })
    const api = {
      ...bridge(vi.fn(async () => [])),
      providerCapabilities: vi.fn()
        .mockImplementationOnce(() => hiddenCapabilities)
        .mockResolvedValueOnce(capabilities),
    }
    const { result, rerender } = renderHook(
      ({ visible }) => useProviderAccounts({ visible, bridge: api }),
      { initialProps: { visible: false } },
    )
    await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(1))

    rerender({ visible: true })
    await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(result.current.capabilities.providerAccountsV1).toBe(true))
    await waitFor(() => expect(result.current.accountsLoaded).toBe(true))

    await act(async () => {
      resolveHidden({ providerAccountsV1: false, providerUsageV1: false })
      await hiddenCapabilities
    })
    expect(result.current.capabilities.providerAccountsV1).toBe(true)
    expect(result.current.accountsLoaded).toBe(true)
  })

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
    // The rows commit on a separate microtask from the usage mock resolution —
    // assert inside waitFor (deterministic race under load, not flaky).
    await waitFor(() => expect(result.current.rows.every(row => row.status === 'fresh')).toBe(true))
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

  it('commits a multi-account usage refresh as one completed batch', async () => {
    let resolveA!: (value: ProviderUsageResult[]) => void
    let resolveB!: (value: ProviderUsageResult[]) => void
    const pendingA = new Promise<ProviderUsageResult[]>(resolve => { resolveA = resolve })
    const pendingB = new Promise<ProviderUsageResult[]>(resolve => { resolveB = resolve })
    const usage = vi.fn((_provider?: 'codex' | 'claude', accountId?: string) => (
      accountId === 'local-a' ? pendingA : pendingB
    ))
    const { result } = renderHook(() => useProviderAccounts({ visible: true, bridge: bridge(usage) }))

    await waitFor(() => {
      expect(result.current.rows).toHaveLength(2)
      expect(result.current.rows.every(row => row.status === 'loading')).toBe(true)
    })

    await act(async () => {
      resolveA([{ provider: 'codex', accountId: 'local-a', snapshot: snapshot('local-a') }])
      await pendingA
    })
    expect(result.current.rows.every(row => row.status === 'loading')).toBe(true)

    await act(async () => {
      resolveB([{ provider: 'codex', accountId: 'local-b', snapshot: snapshot('local-b') }])
      await Promise.all([pendingA, pendingB])
    })
    await waitFor(() => expect(result.current.rows.every(row => row.status === 'fresh')).toBe(true))
  })

  // L1 — capabilities and the account list are two independent CLI spawns.
  // The list must be requested in parallel with capabilities, not after them.
  it('L1: requests the account list without waiting for capabilities to resolve', async () => {
    let resolveCaps!: (value: ProviderCapabilities) => void
    const pendingCaps = new Promise<ProviderCapabilities>(done => { resolveCaps = done })
    const list = vi.fn(async () => accounts)
    const api = {
      ...bridge(vi.fn(async () => [])),
      providerCapabilities: vi.fn(() => pendingCaps),
      providerAccountsList: list,
    }
    renderHook(() => useProviderAccounts({ visible: false, bridge: api }))
    // Capabilities never resolves here — the list request must still go out.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1), { timeout: 1500 })
    resolveCaps(capabilities)
  })

  // L2 — capabilities + list are cached for ~30s so re-entering the tab does
  // not re-spawn the CLI. Usage per account still refreshes on every entry.
  it('L2: re-entering within the TTL reuses cached capabilities and list', async () => {
    const api = bridge(vi.fn(async () => []))
    const { result, rerender } = renderHook(
      ({ visible }) => useProviderAccounts({ visible, bridge: api }),
      { initialProps: { visible: true } },
    )
    // First entry fetches capabilities + list and fills the cache.
    await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.providerAccountsList).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.accountsLoaded).toBe(true))
    rerender({ visible: false })
    rerender({ visible: true })
    // TTL still valid → no new spawns.
    await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.providerAccountsList).toHaveBeenCalledTimes(1))
  })

  it('L2: after the TTL expires the next entry re-fetches capabilities and list', async () => {
    const t0 = Date.now()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const api = bridge(vi.fn(async () => []))
      const { result, rerender } = renderHook(
        ({ visible }) => useProviderAccounts({ visible, bridge: api }),
        { initialProps: { visible: true } },
      )
      await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(result.current.accountsLoaded).toBe(true))
      rerender({ visible: false })
      vi.setSystemTime(t0 + 31_000)
      rerender({ visible: true })
      await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(api.providerAccountsList).toHaveBeenCalledTimes(2))
    } finally {
      vi.useRealTimers()
    }
  })

  // L2 — the connected event invalidates the discovery cache so a just-linked
  // account appears immediately, without waiting out the 30s TTL.
  it('L2: invalidating the discovery cache makes a connected account appear before the TTL elapses', async () => {
    const api = bridge(vi.fn(async () => []))
    const { result, rerender } = renderHook(
      ({ visible }) => useProviderAccounts({ visible, bridge: api }),
      { initialProps: { visible: true } },
    )
    // First entry fetches capabilities + list and fills the cache.
    await waitFor(() => expect(api.providerCapabilities).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(api.providerAccountsList).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.accountsLoaded).toBe(true))

    // Within the TTL a plain reload must serve the cache (no re-spawn).
    await act(async () => { await result.current.reloadAccounts() })
    expect(api.providerCapabilities).toHaveBeenCalledTimes(1)
    expect(api.providerAccountsList).toHaveBeenCalledTimes(1)

    // The connected path invalidates, so the very next reload re-fetches.
    act(() => { result.current.invalidateDiscoveryCache() })
    await act(async () => { await result.current.reloadAccounts() })
    expect(api.providerCapabilities).toHaveBeenCalledTimes(2)
    expect(api.providerAccountsList).toHaveBeenCalledTimes(2)
  })
})
