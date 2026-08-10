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
  reloadAccounts: (refreshUsage?: boolean) => Promise<ProviderAccountsSnapshot>
  snapshot: () => ProviderAccountsSnapshot
}

const fallbackCapabilities: ProviderCapabilities = {
  providerAccountsV1: false,
  providerUsageV1: false,
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

  useEffect(() => () => { mounted.current = false }, [])

  const refreshAccount = useCallback(async (provider: ExternalProviderId, accountId: string): Promise<ProviderUsageRowState | undefined> => {
    const key = accountKey(provider, accountId)
    const current = inFlight.current.get(key)
    if (current) return current

    setRows(previous => previous.map(row =>
      row.account.provider === provider && row.account.accountId === accountId
        ? { ...row, status: 'loading', errorCode: undefined }
        : row,
    ))

    const request = (async () => {
      let result: ProviderUsageResult | undefined
      const account = accountsRef.current.find(item => item.provider === provider && item.accountId === accountId)
      try {
        const results = await bridge.providerAccountsUsage(provider, accountId)
        result = results.find(item => item.provider === provider && item.accountId === accountId)
        if (result?.snapshot) {
          if (!account) return undefined
          const next: ProviderUsageRowState = { account, status: 'fresh', snapshot: result.snapshot }
          setRows(previous => previous.map(row =>
            row.account.provider === provider && row.account.accountId === accountId
              ? next
              : row,
          ))
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
        setRows(previous => previous.map(row => {
          if (row.account.provider !== provider || row.account.accountId !== accountId) return row
          return next
        }))
        return next
      } finally {
        inFlight.current.delete(key)
      }
    })()
    inFlight.current.set(key, request)
    return request
  }, [bridge])

  const refreshAll = useCallback(async () => {
    const targets = accounts.map(account => ({ provider: account.provider, accountId: account.accountId }))
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]
        await refreshAccount(target.provider, target.accountId)
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, targets.length)) }, () => worker()))
  }, [accounts, refreshAccount])

  const refreshProvider = useCallback(async (provider: ExternalProviderId): Promise<ProviderUsageRowState[]> => {
    const targets = accounts
      .filter(account => account.provider === provider)
      .map(account => ({ provider: account.provider, accountId: account.accountId }))
    let cursor = 0
    const refreshed: ProviderUsageRowState[] = []
    const worker = async () => {
      while (cursor < targets.length) {
        const target = targets[cursor++]
        const row = await refreshAccount(target.provider, target.accountId)
        if (row) refreshed.push(row)
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, Math.max(1, targets.length)) }, () => worker()))
    return refreshed.sort((left, right) => left.account.accountId.localeCompare(right.account.accountId))
  }, [accounts, refreshAccount])

  const snapshot = useCallback((): ProviderAccountsSnapshot => ({
    capabilities: capabilitiesRef.current,
    accounts: accountsRef.current,
    accountsLoaded: accountsLoadedRef.current,
  }), [])

  const reloadAccounts = useCallback(async (refreshUsage = visible): Promise<ProviderAccountsSnapshot> => {
    let nextCapabilities = fallbackCapabilities
    try {
      const reported = await bridge.providerCapabilities()
      if (reported && typeof reported === 'object') nextCapabilities = reported
    } catch {
      capabilitiesRef.current = fallbackCapabilities
      setCapabilities(fallbackCapabilities)
      setAccounts([])
      setRows([])
      accountsRef.current = []
      accountsLoadedRef.current = true
      setAccountsLoaded(true)
      return snapshot()
    }
    if (!mounted.current) return snapshot()
    capabilitiesRef.current = nextCapabilities
    setCapabilities(nextCapabilities)
    if (!nextCapabilities.providerAccountsV1) {
      accountsRef.current = []
      accountsLoadedRef.current = true
      setAccounts([])
      setRows([])
      setAccountsLoaded(true)
      return snapshot()
    }
    try {
      const nextAccounts = await bridge.providerAccountsList()
      if (!mounted.current) return snapshot()
      accountsRef.current = nextAccounts
      accountsLoadedRef.current = true
      setAccounts(nextAccounts)
      setAccountsLoaded(true)
      setRows(previous => mergeRows(nextAccounts, previous))
      // M2 — a reloaded accounts list means accounts may have been added,
      // removed, or reconnected: the cached model lists (keyed per
      // provider:account) can no longer be trusted. Drop them so the next
      // preflight fetches a fresh catalog instead of spawning stale entries.
      invalidateProviderModelsCache()
      if (refreshUsage && nextCapabilities.providerUsageV1) {
        // Refresh from the response rather than waiting for state to commit.
        let cursor = 0
        const worker = async () => {
          while (cursor < nextAccounts.length) {
            const account = nextAccounts[cursor++]
            await refreshAccount(account.provider, account.accountId)
          }
        }
        await Promise.all(Array.from({ length: Math.min(3, Math.max(1, nextAccounts.length)) }, () => worker()))
      }
      return snapshot()
    } catch {
      // Account discovery failure is local to this entry; leave the old rows
      // visible so the user can retry rather than losing context.
      return snapshot()
    }
  }, [bridge, refreshAccount, snapshot, visible])

  useEffect(() => {
    const firstRender = previousVisible.current === undefined
    const entered = visible && previousVisible.current === false
    previousVisible.current = visible
    if (firstRender || entered) void reloadAccounts(visible)
  }, [reloadAccounts, visible])

  const setDefault = useCallback(async (provider: ExternalProviderId, accountId: string) => {
    await bridge.providerAccountSetDefault(provider, accountId)
    await reloadAccounts()
  }, [bridge, reloadAccounts])

  const remove = useCallback(async (provider: ExternalProviderId, accountId: string) => {
    await bridge.providerAccountRemove(provider, accountId)
    await reloadAccounts()
  }, [bridge, reloadAccounts])

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
    reloadAccounts,
    snapshot,
  }
}
