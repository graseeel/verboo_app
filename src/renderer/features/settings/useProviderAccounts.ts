import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ExternalProviderId,
  ProviderAccountSummary,
  ProviderCapabilities,
  ProviderUsageSnapshot,
  ProviderUsageResult,
} from '../../../shared/types'
import type { VerbooDesktopApi } from '../../verboo-bridge'
import { invalidateProviderModelsCache } from '../providers/providerModelValidation'

export type ProviderUsageRowState = {
  account: ProviderAccountSummary
  status: 'idle' | 'loading' | 'fresh' | 'stale' | 'unavailable'
  snapshot?: ProviderUsageSnapshot
  errorCode?: string
}

export type ProviderAccountsSnapshot = {
  capabilities: ProviderCapabilities
  accounts: ProviderAccountSummary[]
  accountsLoaded: boolean
}

export type ProviderAccountsBridge = Pick<VerbooDesktopApi,
  | 'providerCapabilities'
  | 'providerAccountsList'
  | 'providerAccountsUsage'
  | 'providerAccountSetDefault'
  | 'providerAccountRemove'
>

export type ProviderAccountsController = {
  capabilities: ProviderCapabilities
  accounts: ProviderAccountSummary[]
  accountsLoaded: boolean
  rows: ProviderUsageRowState[]
  refreshAll: () => Promise<void>
  refreshProvider: (provider: ExternalProviderId) => Promise<ProviderUsageRowState[]>
  refreshAccount: (provider: ExternalProviderId, accountId: string) => Promise<ProviderUsageRowState | undefined>
  setDefault: (provider: ExternalProviderId, accountId: string) => Promise<void>
  remove: (provider: ExternalProviderId, accountId: string) => Promise<void>
  /** L2 — drop the cached capabilities/list so the next reload re-fetches,
   *  e.g. right after a provider connect event (no TTL wait). */
  invalidateDiscoveryCache: () => void
  reloadAccounts: (refreshUsage?: boolean) => Promise<ProviderAccountsSnapshot>
  snapshot: () => ProviderAccountsSnapshot
}

const fallbackCapabilities: ProviderCapabilities = {
  providerAccountsV1: false,
  providerUsageV1: false,
}

/** L2 — capabilities + account list are cached for 30s so re-entering the
 *  Providers tab does not re-spawn the CLI on every visit. Mutations
 *  (setDefault/remove) and the connected event force a fresh fetch. */
const DISCOVERY_CACHE_TTL_MS = 30_000

type DiscoveryCache = {
  at: number
  capabilities: ProviderCapabilities
  accounts: ProviderAccountSummary[]
}

function accountKey(provider: ExternalProviderId, accountId: string): string {
  return `${provider}:${accountId}`
}

function mergeRows(
  accounts: ProviderAccountSummary[],
  previous: ProviderUsageRowState[],
): ProviderUsageRowState[] {
  const byKey = new Map(previous.map(row => [accountKey(row.account.provider, row.account.accountId), row]))
  return accounts.map(account => {
    const old = byKey.get(accountKey(account.provider, account.accountId))
    return old ? { ...old, account } : { account, status: 'idle' }
  })
}

type UsageTarget = Pick<ProviderAccountSummary, 'provider' | 'accountId'>

function markRowsLoading(
  previous: ProviderUsageRowState[],
  targets: UsageTarget[],
): ProviderUsageRowState[] {
  const keys = new Set(targets.map(target => accountKey(target.provider, target.accountId)))
  return previous.map(row => keys.has(accountKey(row.account.provider, row.account.accountId))
    ? { ...row, status: 'loading', errorCode: undefined }
    : row)
}

function applyUsageRows(
  previous: ProviderUsageRowState[],
  completed: ProviderUsageRowState[],
): ProviderUsageRowState[] {
  const byKey = new Map(completed.map(row => [accountKey(row.account.provider, row.account.accountId), row]))
  return previous.map(row => byKey.get(accountKey(row.account.provider, row.account.accountId)) ?? row)
}

export function useProviderAccounts({
  visible,
  bridge,
}: {
  visible: boolean
  bridge: ProviderAccountsBridge
}): ProviderAccountsController {
  const [capabilities, setCapabilities] = useState<ProviderCapabilities>(fallbackCapabilities)
  const [accounts, setAccounts] = useState<ProviderAccountSummary[]>([])
  const [rows, setRows] = useState<ProviderUsageRowState[]>([])
  const [accountsLoaded, setAccountsLoaded] = useState(false)
  const inFlight = useRef(new Map<string, Promise<ProviderUsageRowState | undefined>>())
  const previousVisible = useRef<boolean | undefined>(undefined)
  const mounted = useRef(true)
  const capabilitiesRef = useRef(capabilities)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const accountsRef = useRef(accounts)
  accountsRef.current = accounts
  const accountsLoadedRef = useRef(accountsLoaded)
  accountsLoadedRef.current = accountsLoaded
  const discoveryCacheRef = useRef<DiscoveryCache | undefined>(undefined)
  const discoveryGenerationRef = useRef(0)

  useEffect(() => () => { mounted.current = false }, [])

  const fetchAccountUsage = useCallback((provider: ExternalProviderId, accountId: string): Promise<ProviderUsageRowState | undefined> => {
    const key = accountKey(provider, accountId)
    const current = inFlight.current.get(key)
    if (current) return current

    const request = (async () => {
      let result: ProviderUsageResult | undefined
      const account = accountsRef.current.find(item => item.provider === provider && item.accountId === accountId)
      try {
        const results = await bridge.providerAccountsUsage(provider, accountId)
        result = results.find(item => item.provider === provider && item.accountId === accountId)
        if (result?.snapshot) {
          if (!mounted.current || !account) return undefined
          const next: ProviderUsageRowState = { account, status: 'fresh', snapshot: result.snapshot }
          return next
        } else {
          throw new Error(result?.errorCode ?? 'provider_usage_unavailable')
        }
      } catch (error) {
        if (!mounted.current) return undefined
        if (!account) return undefined
        const code = result?.errorCode ?? (error instanceof Error ? error.message : 'provider_usage_unavailable')
        const previous = rowsRef.current.find(row => row.account.provider === provider && row.account.accountId === accountId)
        const next: ProviderUsageRowState = {
          account,
          status: previous?.snapshot ? 'stale' : 'unavailable',
          snapshot: previous?.snapshot,
          errorCode: code,
        }
        return next
      } finally {
        inFlight.current.delete(key)
      }
    })()
    inFlight.current.set(key, request)
    return request
  }, [bridge])

  const refreshAccount = useCallback(async (provider: ExternalProviderId, accountId: string): Promise<ProviderUsageRowState | undefined> => {
    const target = { provider, accountId }
    setRows(previous => markRowsLoading(previous, [target]))
    const next = await fetchAccountUsage(provider, accountId)
    if (mounted.current && next) setRows(previous => applyUsageRows(previous, [next]))
    return next
  }, [fetchAccountUsage])

  const refreshBatch = useCallback(async (targets: UsageTarget[]): Promise<ProviderUsageRowState[]> => {
    if (targets.length === 0) return []
    setRows(previous => markRowsLoading(previous, targets))
    let cursor = 0
    const completed: ProviderUsageRowState[] = []
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]
        const row = await fetchAccountUsage(target.provider, target.accountId)
        if (row) completed.push(row)
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, () => worker()))
    if (mounted.current && completed.length > 0) {
      setRows(previous => applyUsageRows(previous, completed))
    }
    return completed
  }, [fetchAccountUsage])

  const refreshAll = useCallback(async () => {
    const targets = accounts.map(account => ({ provider: account.provider, accountId: account.accountId }))
    await refreshBatch(targets)
  }, [accounts, refreshBatch])

  const refreshProvider = useCallback(async (provider: ExternalProviderId): Promise<ProviderUsageRowState[]> => {
    const targets = accounts
      .filter(account => account.provider === provider)
      .map(account => ({ provider: account.provider, accountId: account.accountId }))
    const refreshed = await refreshBatch(targets)
    return refreshed.sort((left, right) => left.account.accountId.localeCompare(right.account.accountId))
  }, [accounts, refreshBatch])

  const snapshot = useCallback((): ProviderAccountsSnapshot => ({
    capabilities: capabilitiesRef.current,
    accounts: accountsRef.current,
    accountsLoaded: accountsLoadedRef.current,
  }), [])

  const reloadAccounts = useCallback(async (refreshUsage = visible, force = false): Promise<ProviderAccountsSnapshot> => {
    const generation = ++discoveryGenerationRef.current
    // L2 — within the TTL a tab re-entry must NOT re-spawn the CLI: serve the
    // cached capabilities + list, then refresh usage per account on demand.
    const cached = discoveryCacheRef.current
    if (!force && cached && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) {
      capabilitiesRef.current = cached.capabilities
      setCapabilities(cached.capabilities)
      if (cached.capabilities.providerAccountsV1) {
        accountsRef.current = cached.accounts
        accountsLoadedRef.current = true
        setAccounts(cached.accounts)
        setAccountsLoaded(true)
        setRows(previous => mergeRows(cached.accounts, previous))
      }
      if (refreshUsage && cached.capabilities.providerUsageV1 && cached.capabilities.providerAccountsV1) {
        await refreshBatch(cached.accounts)
      }
      return snapshot()
    }

    // L1 — capabilities and the account list are two INDEPENDENT CLI spawns:
    // fetch them in parallel instead of serially. A list failure with healthy
    // capabilities leaves the previous rows visible (retry next entry).
    const [capabilitiesResult, listResult] = await Promise.all([
      bridge.providerCapabilities().then(
        value => (value
          && typeof value === 'object'
          && typeof value.providerAccountsV1 === 'boolean'
          && typeof value.providerUsageV1 === 'boolean'
          ? value
          : undefined),
        () => undefined,
      ),
      bridge.providerAccountsList().then(
        value => (Array.isArray(value) ? value : undefined),
        () => undefined,
      ),
    ])
    if (!mounted.current || generation !== discoveryGenerationRef.current) return snapshot()

    if (!capabilitiesResult) {
      // A transient CLI/bootstrap failure is not evidence of a legacy CLI.
      // Keep an already-rendered account surface intact; on first discovery,
      // remain in the neutral loading state until the visible retry runs.
      if (!accountsLoadedRef.current) setAccountsLoaded(false)
      return snapshot()
    }

    if (!capabilitiesResult.providerAccountsV1) {
      capabilitiesRef.current = capabilitiesResult
      setCapabilities(capabilitiesResult)
      accountsRef.current = []
      // Background prefetch cannot choose the legacy surface. Confirm it once
      // more while Providers is visible, preventing a one-frame legacy flash
      // when startup briefly reaches the CLI before it is ready.
      accountsLoadedRef.current = visible
      setAccounts([])
      setRows([])
      setAccountsLoaded(visible)
      return snapshot()
    }
    capabilitiesRef.current = capabilitiesResult
    setCapabilities(capabilitiesResult)
    if (!listResult) {
      // Account discovery failed while capabilities succeeded: keep the old
      // rows so the user can retry rather than losing context.
      accountsLoadedRef.current = false
      setAccountsLoaded(false)
      return snapshot()
    }
    discoveryCacheRef.current = { at: Date.now(), capabilities: capabilitiesResult, accounts: listResult }
    accountsRef.current = listResult
    accountsLoadedRef.current = true
    setAccounts(listResult)
    setAccountsLoaded(true)
    setRows(previous => mergeRows(listResult, previous))
    // M2 — a reloaded accounts list means accounts may have been added,
    // removed, or reconnected: the cached model lists (keyed per
    // provider:account) can no longer be trusted. Drop them so the next
    // preflight fetches a fresh catalog instead of spawning stale entries.
    invalidateProviderModelsCache()
    if (refreshUsage && capabilitiesResult.providerUsageV1) {
      // Refresh from the response rather than waiting for state to commit.
      await refreshBatch(listResult)
    }
    return snapshot()
  }, [bridge, refreshBatch, snapshot, visible])

  /** L2 — invalidate the discovery cache after a mutation (setDefault/remove)
   *  so the next reload reflects the change instead of serving the snapshot. */
  const invalidateDiscoveryCache = useCallback(() => {
    discoveryCacheRef.current = undefined
  }, [])

  useEffect(() => {
    const firstRender = previousVisible.current === undefined
    const entered = visible && previousVisible.current === false
    previousVisible.current = visible
    if (firstRender || entered) void reloadAccounts(visible)
  }, [reloadAccounts, visible])

  const setDefault = useCallback(async (provider: ExternalProviderId, accountId: string) => {
    await bridge.providerAccountSetDefault(provider, accountId)
    invalidateDiscoveryCache()
    await reloadAccounts()
  }, [bridge, invalidateDiscoveryCache, reloadAccounts])

  const remove = useCallback(async (provider: ExternalProviderId, accountId: string) => {
    await bridge.providerAccountRemove(provider, accountId)
    invalidateDiscoveryCache()
    await reloadAccounts()
  }, [bridge, invalidateDiscoveryCache, reloadAccounts])

  return {
    capabilities,
    accounts,
    accountsLoaded,
    rows,
    refreshAll,
    refreshProvider,
    refreshAccount,
    setDefault,
    remove,
    invalidateDiscoveryCache,
    reloadAccounts,
    snapshot,
  }
}
